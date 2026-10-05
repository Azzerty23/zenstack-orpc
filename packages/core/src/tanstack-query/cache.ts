import type { QueryClient } from '@tanstack/query-core'
import type { InvalidationPredicate, QueryInfo } from '@zenstackhq/client-helpers'
import type { SchemaDef } from '@zenstackhq/orm/schema'
import { isQueryOperation, modelFromKey } from '../operations'
import { parseOperationKey, relativePath } from './keys'

export interface ZenStackQuery {
  model: string
  operation: string
  args: unknown
  type: string | undefined
  queryKey: readonly unknown[]
}

/** Lists cached queries of ZenStack read procedures under `root`. */
export function getZenStackQueries(
  queryClient: QueryClient,
  schema: SchemaDef,
  root: readonly string[],
): (ZenStackQuery & {
  query: ReturnType<ReturnType<QueryClient['getQueryCache']>['getAll']>[number]
})[] {
  const result = []
  for (const query of queryClient.getQueryCache().getAll()) {
    const parsed = parseOperationKey(query.queryKey)
    if (!parsed || parsed.type === 'mutation') continue
    const rel = relativePath(parsed.path, root)
    if (rel?.length !== 2 || !isQueryOperation(rel[1])) continue
    const model = modelFromKey(schema, rel[0])
    if (!model) continue
    result.push({
      model,
      operation: rel[1],
      args: parsed.input,
      type: parsed.type,
      queryKey: query.queryKey,
      query,
    })
  }
  return result
}

/** Cache entries in the shape expected by `@zenstackhq/client-helpers`. */
export function getAllQueries(
  queryClient: QueryClient,
  schema: SchemaDef,
  root: readonly string[],
): QueryInfo[] {
  return getZenStackQueries(queryClient, schema, root).map(
    ({ model, operation, args, type, query }) => ({
      model,
      operation,
      args,
      data: query.state.data,
      // Infinite and streamed queries can't be patched optimistically.
      optimisticUpdate: type === 'query' || type === 'live',
      updateData: (data: unknown, cancelOnTheFlyQueries: boolean) => {
        queryClient.setQueryData(query.queryKey, data)
        if (cancelOnTheFlyQueries) {
          void queryClient.cancelQueries({ queryKey: query.queryKey, exact: true }, {
            revert: false,
            silent: true,
          } as any)
        }
      },
    }),
  )
}

/** Invalidates the ZenStack queries matching a `@zenstackhq/client-helpers` predicate. */
export function invalidateMatching(
  queryClient: QueryClient,
  schema: SchemaDef,
  root: readonly string[],
  predicate: InvalidationPredicate,
): Promise<void> {
  const keys = getZenStackQueries(queryClient, schema, root)
    .filter(({ model, args }) => predicate({ model, args }))
    .map(({ queryKey }) => queryKey)
  return Promise.all(
    keys.map((queryKey) => queryClient.invalidateQueries({ queryKey, exact: true })),
  ).then(() => undefined)
}
