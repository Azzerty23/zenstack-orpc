import type { AnyNestedClient } from '@orpc/client'
import type { ProcedureUtilsOptions, RouterUtilsPlugin } from '@orpc/tanstack-query'
import type { QueryClient } from '@tanstack/query-core'
import {
  applyMutation,
  createOptimisticUpdater,
  getMutatedModels,
  getReadModels,
  type Logger,
  log,
} from '@zenstackhq/client-helpers'
import type { SchemaDef } from '@zenstackhq/orm/schema'
import { isMutationOperation, isQueryOperation, modelFromKey } from '../operations'
import { delegateBases, delegateDiscriminator, delegateSubModels } from '../schema-utils'
import type { TransactionOperation } from '../transaction'
import { recordTransaction } from '../transaction-callback'
import { getAllQueries, getZenStackQueries, invalidateMatching } from './cache'
import { reconcileOptimistic } from './filters'
import { relativePath } from './keys'
import { LIVE_META_KEY, LiveManager, type LiveQueryMeta } from './live'
import { type AuthProvider, completeOptimisticData, createCacheLookup } from './optimistic'
import { paginate } from './pagination'
import { usesSearch } from './search'

const FILE_WRITES = new Set(['upload', 'remove', 'confirm'])

export interface ZenStackQueryPluginOptions {
  /** The ZenStack schema. */
  schema: SchemaDef
  /** Path of the ZenStack router in the app router, e.g. `['db']`. */
  path: readonly string[]
  /** The oRPC client the utils are created from (used by live queries). */
  client: AnyNestedClient
  /**
   * Automatically invalidate queries affected by a mutation (nested writes, cascades and
   * relations included).
   * @default true
   */
  invalidate?: boolean
  /**
   * Optimistically patch cached queries before mutations run, and roll back on error.
   * @default false
   */
  optimistic?: boolean
  /**
   * Keep `liveOptions` queries up to date from the `$changes` stream.
   * @default true when the router exposes `$changes`
   */
  live?: boolean | { debounce?: number; resyncOnReconnect?: boolean; throttle?: number }
  /**
   * Current user, as seen by `auth()` in ZModel. Optimistic records get their
   * `@default(auth().…)` fields from it, and relations to the current user (e.g. `author`) are
   * filled from it when a query includes them.
   */
  auth?: AuthProvider
  /** Log cache operations (`true` logs to the console). */
  logging?: Logger
}

function at(client: any, path: readonly string[]): any {
  return path.reduce((node, key) => node?.[key], client)
}

/**
 * `RouterUtilsPlugin` adding ZenStack-aware behaviors to `createTanstackQueryUtils`:
 * automatic invalidation, optimistic updates and live queries.
 */
export class ZenStackQueryPlugin<T extends AnyNestedClient = AnyNestedClient>
  implements RouterUtilsPlugin<T>
{
  readonly name = 'zenstack'
  private readonly options: ZenStackQueryPluginOptions
  private readonly logger: Logger | undefined
  private readonly managers = new WeakMap<QueryClient, LiveManager>()

  constructor(options: ZenStackQueryPluginOptions) {
    this.options = options
    this.logger = options.logging
  }

  initProcedureOptions(
    path: string[],
    options: ProcedureUtilsOptions<any, any, any, any>,
  ): ProcedureUtilsOptions<any, any, any, any> {
    const rel = relativePath(path, this.options.path)
    if (!rel) return options

    if (rel.length === 1 && rel[0] === '$transaction') {
      return this.withMutationInterceptor(options, async (interceptorOptions) => {
        const { input, next, fnContext } = interceptorOptions
        // A callback is recorded here, so that its steps are known for invalidation.
        const recorded =
          typeof input === 'function'
            ? recordTransaction(input as (tx: any) => unknown, this.options.schema)
            : undefined
        const steps: TransactionOperation[] = recorded?.steps ?? (input as any[]) ?? []
        if (recorded && steps.length === 0) return recorded.resolve([])
        try {
          const results = await next({ ...interceptorOptions, input: steps })
          return recorded ? recorded.resolve(results as unknown[]) : results
        } finally {
          await Promise.all(
            steps
              .filter((step) => isMutationOperation(step.op))
              .map((step) => this.invalidate(fnContext.client, step.model, step.op, step.args)),
          )
        }
      })
    }

    // `@file` writes (`post.image.upload`) update their record.
    if (rel.length === 3 && FILE_WRITES.has(rel[2])) {
      const model = modelFromKey(this.options.schema, rel[0])
      if (!model) return options
      return this.withMutationInterceptor(options, async ({ input, next, fnContext }) => {
        try {
          return await next()
        } finally {
          const where = (input as any)?.where ?? {}
          await this.invalidate(fnContext.client, model, 'update', { where, data: {} })
        }
      })
    }

    if (rel.length !== 2) return options
    const model = modelFromKey(this.options.schema, rel[0])
    const operation = rel[1]
    if (!model) return options

    if (isMutationOperation(operation)) {
      return this.withMutationInterceptor(options, async ({ input, next, fnContext }) => {
        const queryClient = fnContext.client
        const snapshot = this.options.optimistic ? this.snapshot(queryClient) : undefined
        if (snapshot) await this.applyOptimistic(queryClient, model, operation, input)
        try {
          return await next()
        } catch (error) {
          if (snapshot) for (const [key, data] of snapshot) queryClient.setQueryData(key, data)
          throw error
        } finally {
          await this.invalidate(queryClient, model, operation, input)
        }
      })
    }

    if (isQueryOperation(operation)) {
      const procedure = at(this.options.client, path)
      const userLiveOptions = options.liveOptions
      const userInfiniteOptions = options.infiniteOptions
      const userInfiniteKey = options.infiniteKey
      const live = this.options.live !== false
      const paginated = (optionsIn: any) => {
        const { pagination, ...rest } = optionsIn
        return operation === 'findMany' && rest.input && typeof rest.input === 'object'
          ? { ...rest, ...paginate(this.options.schema, model, rest.input, pagination) }
          : rest
      }
      return {
        ...options,
        infiniteKey: (optionsIn: any) =>
          paginated(
            typeof userInfiniteKey === 'function'
              ? userInfiniteKey(optionsIn)
              : { ...userInfiniteKey, ...optionsIn },
          ),
        // `findMany` args with a `take` page automatically; `live` keeps the pages up to date.
        infiniteOptions: (optionsIn: any) => {
          const resolved =
            typeof userInfiniteOptions === 'function'
              ? userInfiniteOptions(optionsIn)
              : { ...userInfiniteOptions, ...optionsIn }
          const { live: liveIn, ...rest } = resolved
          const result = paginated(rest)
          if (!liveIn || !live) return result
          const liveMeta: LiveQueryMeta =
            typeof liveIn === 'object' && liveIn.throttle !== undefined
              ? { throttle: liveIn.throttle }
              : {}
          return {
            staleTime: Number.POSITIVE_INFINITY,
            ...result,
            meta: { ...result.meta, [LIVE_META_KEY]: liveMeta },
          }
        },
        infiniteInterceptors: [
          ...(options.infiniteInterceptors ?? []),
          ({ next, fnContext }: any) => {
            if (live && fnContext.meta?.[LIVE_META_KEY]) this.liveManager(fnContext.client)
            return next()
          },
        ],
        // Live queries are regular queries (not oRPC's streamed `liveOptions`), refreshed when the
        // `$changes` stream reports a change. With `live: false`, they're plain queries.
        liveOptions: (optionsIn: any) => {
          const { throttle, ...rest } = optionsIn ?? {}
          const resolved =
            typeof userLiveOptions === 'function'
              ? userLiveOptions(rest)
              : { ...userLiveOptions, ...rest }
          const liveMeta: LiveQueryMeta = throttle === undefined ? {} : { throttle }
          return {
            ...(live ? { staleTime: Number.POSITIVE_INFINITY } : {}),
            ...resolved,
            meta: live ? { ...resolved.meta, [LIVE_META_KEY]: liveMeta } : resolved.meta,
            queryFn:
              resolved.queryFn ??
              ((fnContext: any) => {
                if (live) this.liveManager(fnContext.client)
                return procedure(resolved.input, {
                  signal: fnContext.signal,
                  context: resolved.context,
                })
              }),
          }
        },
      }
    }

    return options
  }

  /**
   * Patches cached queries before a mutation. Optimistic records are completed to match each
   * query (`auth()` defaults, included relations); queries that can't be completed are skipped
   * and simply refreshed after the mutation.
   */
  private async applyOptimistic(
    queryClient: QueryClient,
    model: string,
    operation: string,
    input: unknown,
  ) {
    const { schema, path } = this.options
    const ctx = {
      schema,
      auth: await this.options.auth?.(),
      lookup: createCacheLookup(queryClient, schema, path),
    }
    await createOptimisticUpdater(
      model,
      operation,
      schema,
      {
        optimisticDataProvider: async ({
          queryModel,
          queryOperation,
          queryArgs,
          currentData,
          mutationArgs,
        }) => {
          // Whether a record matches a fuzzy / full-text search (and where it ranks) is only
          // known by the database: search results are refreshed after the mutation instead.
          if (usesSearch(queryArgs)) return { kind: 'Skip' }
          const mutated =
            (await applyMutation(
              queryModel,
              queryOperation,
              currentData,
              model,
              operation as any,
              mutationArgs,
              schema,
              this.logger,
            )) ??
            (await applyDelegateMutation(
              schema,
              queryModel,
              queryOperation,
              currentData,
              model,
              operation,
              mutationArgs,
              this.logger,
            ))
          if (mutated === undefined) return { kind: 'Skip' }
          const completed = completeOptimisticData(mutated, queryModel, queryArgs, ctx)
          if (completed === undefined) return { kind: 'Skip' }
          // Optimistic records must match the query's `where`, at the place of its `orderBy`.
          const reconciled = reconcileOptimistic(
            schema,
            queryModel,
            queryOperation,
            queryArgs,
            currentData,
            completed,
            mutated,
          )
          return reconciled === undefined ? { kind: 'Skip' } : { kind: 'Update', data: reconciled }
        },
      },
      () => getAllQueries(queryClient, schema, path),
      this.logger,
    )(input)
  }

  private withMutationInterceptor(
    options: ProcedureUtilsOptions<any, any, any, any>,
    interceptor: NonNullable<
      ProcedureUtilsOptions<any, any, any, any>['mutationInterceptors']
    >[number],
  ): ProcedureUtilsOptions<any, any, any, any> {
    return {
      ...options,
      mutationInterceptors: [...(options.mutationInterceptors ?? []), interceptor],
    }
  }

  private snapshot(queryClient: QueryClient): [readonly unknown[], unknown][] {
    return getZenStackQueries(queryClient, this.options.schema, this.options.path).map(
      ({ queryKey, query }) => [queryKey, query.state.data],
    )
  }

  private async invalidate(
    queryClient: QueryClient,
    model: string,
    operation: string,
    args: unknown,
  ) {
    if (this.options.invalidate === false) return
    const { schema } = this.options
    const mutated = withDelegateSubModels(
      schema,
      await getMutatedModels(model, operation as any, args, schema),
    )
    await invalidateMatching(queryClient, schema, this.options.path, (query) => {
      const hit =
        mutated.has(query.model) ||
        (!!query.args &&
          getReadModels(query.model, schema, query.args).some((read) => mutated.has(read)))
      if (hit && this.logger) {
        log(
          this.logger,
          `Marking "${query.model}" query for invalidation due to mutation "${operation}", query args: ${JSON.stringify(query.args)}`,
        )
      }
      return hit
    })
  }

  /** Stops the live updates of a `QueryClient` (see `connectLive`). */
  disposeLive(queryClient: QueryClient) {
    this.managers.get(queryClient)?.dispose()
    this.managers.delete(queryClient)
  }

  /** The live manager of a `QueryClient`, created on first use. */
  liveManager(queryClient: QueryClient): LiveManager | undefined {
    let manager = this.managers.get(queryClient)
    if (manager) return manager
    const changes = at(this.options.client, [...this.options.path, '$changes'])
    if (typeof changes !== 'function') return undefined
    const config = typeof this.options.live === 'object' ? this.options.live : {}
    manager = new LiveManager(queryClient, {
      schema: this.options.schema,
      root: this.options.path,
      changes,
      ...config,
    })
    this.managers.set(queryClient, manager)
    return manager
  }
}

/** Creates the ZenStack `RouterUtilsPlugin` (see {@link ZenStackQueryPlugin}). */
export function zenstackQueryPlugin<T extends AnyNestedClient = AnyNestedClient>(
  options: ZenStackQueryPluginOptions,
): ZenStackQueryPlugin<T> {
  return new ZenStackQueryPlugin<T>(options)
}

/**
 * Adds the sub-models of the `@@delegate` models written directly: writing `Asset` (e.g.
 * `asset.delete`) changes `Video` rows. ZenStack's helpers only add the bases of written
 * sub-models; a base present only because one of its sub-models was written isn't expanded, so
 * writing a `Video` doesn't refresh `Image` queries.
 */
function withDelegateSubModels(schema: SchemaDef, models: string[]): Set<string> {
  const result = new Set(models)
  for (const model of models) {
    const subModels = delegateSubModels(schema, model)
    if (subModels.some((sub) => result.has(sub))) continue
    for (const sub of subModels) result.add(sub)
  }
  return result
}

/**
 * Optimistic updates across a `@@delegate` hierarchy, which ZenStack's helpers only apply to
 * queries of the mutated model:
 * - a sub-model write (`video.update`) patches base model queries (`asset.findMany`), and a
 *   created sub-model record is added to them with its discriminator;
 * - a base model write (`asset.update`, `asset.delete`) patches sub-model queries.
 *
 * Records of a hierarchy share their ids (one base table), so matching by id only reaches the
 * mutated record.
 */
async function applyDelegateMutation(
  schema: SchemaDef,
  queryModel: string,
  queryOperation: string,
  data: unknown,
  model: string,
  operation: string,
  args: unknown,
  logger: Logger | undefined,
): Promise<unknown> {
  const subModelWrite = delegateBases(schema, model).includes(queryModel)
  if (!subModelWrite && !delegateBases(schema, queryModel).includes(model)) return undefined
  const mutated = await applyMutation(
    model,
    queryOperation,
    data,
    model,
    operation as any,
    args,
    schema,
    logger,
  )
  const discriminator = subModelWrite && delegateDiscriminator(schema, queryModel)
  if (!discriminator || !Array.isArray(mutated)) return mutated
  return mutated.map((row) =>
    row?.$optimistic && row[discriminator] === undefined ? { ...row, [discriminator]: model } : row,
  )
}
