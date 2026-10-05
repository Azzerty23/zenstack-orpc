import { os, type } from '@orpc/server'
import { createQuerySchemaFactory } from '@zenstackhq/orm'
import type { GetModels, SchemaDef } from '@zenstackhq/orm/schema'
import { withORPCErrors } from './errors'
import { getFileFields } from './files/schema'
import { createFileProcedures } from './files/server'
import type { FileStorage } from './files/storage'
import { applyLimits, type QueryLimits } from './limits'
import { createChangesProcedure, type LiveRouterOptions } from './live/server'
import { zenstackMeta } from './meta'
import {
  CRUD_OPERATIONS,
  type CrudOperation,
  createSchemaCache,
  filterList,
  isQueryOperation,
  lowerCaseFirst,
  type ModelFilter,
  type QuerySchemaFactory,
  skipRevalidation,
} from './operations'
import { isView } from './schema-utils'
import { createTransactionProcedure } from './transaction'
import type { InferCurrentContext, InferInitialContext, ZenStackRouter } from './types/router'

export interface ZenStackRouterOptions<S extends SchemaDef, TBase = typeof os> {
  /**
   * Builder every procedure is created from (context, middlewares...).
   * @default os
   */
  base?: TBase
  /**
   * Returns the ZenStack client of the request, typically already bound to the current user
   * (`authDb.$setAuth(user)`) so access policies apply.
   */
  getDb: (context: InferCurrentContext<TBase>) => unknown
  /** Models to expose. */
  models?: ModelFilter<GetModels<S>>
  /** CRUD operations to expose. */
  operations?: ModelFilter<CrudOperation>
  /** Options passed to ZenStack's `createQuerySchemaFactory` (e.g. `omit`, `slicing`). */
  queryOptions?: Record<string, unknown>
  /**
   * Expose a `$transaction` procedure running operations sequentially in one transaction.
   * @default true
   */
  transaction?: boolean
  /** Expose the `$changes` stream used by live queries. */
  live?: LiveRouterOptions
  /**
   * Storage of `@file` fields. Required when the schema has `@file` fields. `expiresIn`: lifetime
   * of the URLs of `url` and `presign` (seconds, default 900).
   */
  files?: { storage: FileStorage; expiresIn?: number }
  /**
   * Bounds on what clients can ask for (`take`, relation nesting, `$transaction` size).
   * @default { maxDepth: 10, maxTransactionSteps: 100 }
   */
  limits?: QueryLimits
}

/**
 * Generates an oRPC router exposing ZenStack CRUD operations for every model:
 * `router.<model>.<operation>` (e.g. `user.findMany`), validated with ZenStack's own Zod schemas.
 *
 * @example
 * ```ts
 * const base = os.$context<{ db: typeof authDb }>()
 * export const router = base.router({
 *   db: createZenStackRouter(schema, { base, getDb: (ctx) => ctx.db }),
 * })
 * ```
 */
export function createZenStackRouter<
  const S extends SchemaDef,
  TBase = typeof os,
  const Options extends ZenStackRouterOptions<S, TBase> = ZenStackRouterOptions<S, TBase>,
>(
  schema: S,
  options: Options & ZenStackRouterOptions<S, TBase>,
): ZenStackRouter<S, InferInitialContext<TBase>, InferCurrentContext<TBase>, Options> {
  const base: any = options.base ?? os
  const getDb = options.getDb as (context: any) => any
  const factory = createQuerySchemaFactory(
    schema,
    options.queryOptions as any,
  ) as unknown as QuerySchemaFactory & {
    makeWhereSchema(model: string, unique: boolean): any
  }
  const schemaFor = createSchemaCache(factory)
  const models = filterList(Object.keys(schema.models) as GetModels<S>[], options.models)
  const operations = filterList(CRUD_OPERATIONS, options.operations)
  const fileFields = getFileFields(schema)
  const limits = options.limits ?? {}

  const router: Record<string, any> = {}

  for (const model of models) {
    const key = lowerCaseFirst(model)
    const procedures: Record<string, unknown> = {}

    for (const op of operations) {
      // Views are read-only.
      if (isView(schema, model) && !isQueryOperation(op)) continue
      procedures[op] = base
        .meta(zenstackMeta({ model, operation: op }))
        .input(schemaFor(model, op))
        .output(type<unknown>())
        .handler(({ context, input }: any) => {
          const args = applyLimits(schema, model, op, input, limits)
          return withORPCErrors(() =>
            skipRevalidation(getDb(context), options.queryOptions)[key][op](args),
          )
        })
    }

    for (const [field, config] of Object.entries(fileFields[model] ?? {})) {
      if (!options.files) {
        throw new Error(
          `zenstack-orpc: ${model}.${field} is a @file field, pass \`files: { storage }\` to createZenStackRouter`,
        )
      }
      if (field in procedures) {
        throw new Error(
          `zenstack-orpc: @file field ${model}.${field} conflicts with an operation name`,
        )
      }
      procedures[field] = createFileProcedures({
        base,
        getDb,
        storage: options.files.storage,
        expiresIn: options.files.expiresIn,
        schema,
        model,
        field,
        config,
        target: { where: factory.makeWhereSchema(model, true) },
      })
    }

    router[key] = procedures
  }

  if (options.transaction !== false) {
    router.$transaction = createTransactionProcedure(models, base, getDb, schemaFor, {
      schema,
      limits,
      queryOptions: options.queryOptions,
    })
  }

  if (options.live) {
    router.$changes = createChangesProcedure(schema, base, getDb, options.live)
  }

  return router as any
}
