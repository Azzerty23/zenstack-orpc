import type { QueryClient } from '@tanstack/query-core'
import type { SchemaDef } from '@zenstackhq/orm/schema'
import { getZenStackQueries } from './cache'

/** The current user, as seen by `auth()` in ZModel (e.g. the better-auth session user). */
export type AuthUser = Record<string, unknown>

/** Returns the current user (sync or async). `null` / `undefined` when signed out. */
export type AuthProvider = () => AuthUser | null | undefined | Promise<AuthUser | null | undefined>

/** Thrown internally when an optimistic record can't be completed. */
class IncompleteError extends Error {}

type Args = Record<string, any> | undefined

interface CompletionContext {
  schema: SchemaDef
  auth: AuthUser | null | undefined
  /** Finds a record of `model` by id in the query cache. */
  lookup: (model: string, idField: string, id: unknown) => Record<string, unknown> | undefined
}

function isAuthDefault(expr: any): expr is { members: string[] } {
  return (
    expr?.kind === 'member' && expr.receiver?.kind === 'call' && expr.receiver.function === 'auth'
  )
}

function getPath(value: unknown, path: string[]): unknown {
  return path.reduce<any>((current, key) => (current == null ? undefined : current[key]), value)
}

/** Relations (and `_count`) requested by query args, with their nested args. */
function requestedRelations(schema: SchemaDef, model: string, args: Args) {
  const selection = args?.select ?? args?.include
  const relations: [field: string, nested: Args][] = []
  if (!selection || typeof selection !== 'object') return { relations, count: undefined as unknown }
  for (const [field, value] of Object.entries(selection)) {
    if (!value || field === '_count') continue
    if (schema.models[model]?.fields[field]?.relation) {
      relations.push([field, value === true ? undefined : (value as Args)])
    }
  }
  return { relations, count: selection._count }
}

function countValue(count: unknown, schema: SchemaDef, model: string): Record<string, number> {
  const fields =
    count && typeof count === 'object' && (count as any).select
      ? Object.keys((count as any).select).filter((key) => (count as any).select[key])
      : Object.entries(schema.models[model].fields)
          .filter(([, def]) => def.relation && def.array)
          .map(([name]) => name)
  return Object.fromEntries(fields.map((field) => [field, 0]))
}

/** Resolves a to-one relation of `record` from `auth` or the query cache. */
function resolveToOne(
  record: Record<string, unknown>,
  model: string,
  field: string,
  ctx: CompletionContext,
): Record<string, unknown> | null {
  const fieldDef = ctx.schema.models[model].fields[field]
  const relatedModel = fieldDef.type
  const fks = fieldDef.relation?.fields ?? []
  const refs = fieldDef.relation?.references ?? []
  if (fks.length !== 1 || refs.length !== 1) throw new IncompleteError()
  const fk = record[fks[0]]
  if (fk === null) return null
  if (fk === undefined) throw new IncompleteError()

  const auth = ctx.auth
  if (auth && relatedModel === (ctx.schema as any).authType && auth[refs[0]] === fk) return auth
  const cached = ctx.lookup(relatedModel, refs[0], fk)
  if (cached) return cached
  throw new IncompleteError()
}

/**
 * Makes `record` match the shape requested by `args`: requested relations are resolved
 * (from `auth` or the cache), to-many relations default to `[]` and `_count` to zeros.
 */
function shape(record: Record<string, unknown>, model: string, args: Args, ctx: CompletionContext) {
  const result: Record<string, unknown> = { ...record }
  const { relations, count } = requestedRelations(ctx.schema, model, args)

  for (const [field, nested] of relations) {
    const fieldDef = ctx.schema.models[model].fields[field]
    const value = result[field]
    if (value !== undefined) {
      result[field] = complete(value, fieldDef.type, nested, ctx)
    } else if (fieldDef.array) {
      result[field] = []
    } else {
      // Resolved records must also provide the relations requested below them.
      const resolved = resolveToOne(result, model, field, ctx)
      result[field] = resolved && shape(resolved, fieldDef.type, nested, ctx)
    }
  }
  if (count && result._count === undefined) result._count = countValue(count, ctx.schema, model)

  if (args?.select) {
    // Keep selected fields only (plus the optimistic marker).
    for (const key of Object.keys(result)) {
      if (key !== '$optimistic' && !args.select[key]) delete result[key]
    }
  }
  return result
}

/** Completes optimistic records found in query data. */
function complete(data: unknown, model: string, args: Args, ctx: CompletionContext): unknown {
  if (Array.isArray(data)) return data.map((item) => complete(item, model, args, ctx))
  if (!data || typeof data !== 'object' || data instanceof Date) return data
  const record = data as Record<string, unknown>
  if (record.$optimistic) {
    const filled: Record<string, unknown> = { ...record }
    for (const [field, fieldDef] of Object.entries(ctx.schema.models[model]?.fields ?? {})) {
      if (filled[field] !== undefined) continue
      const expr = (fieldDef as any).default
      if (isAuthDefault(expr)) {
        const value = getPath(ctx.auth, expr.members)
        if (value !== undefined) filled[field] = value
      }
    }
    return shape(filled, model, args, ctx)
  }
  // Non-optimistic record: optimistic records may be nested in its relations.
  const { relations } = requestedRelations(ctx.schema, model, args)
  let result = record
  for (const [field, nested] of relations) {
    if (record[field] === undefined) continue
    const completed = complete(
      record[field],
      ctx.schema.models[model].fields[field].type,
      nested,
      ctx,
    )
    if (completed !== record[field]) result = { ...result, [field]: completed }
  }
  return result
}

/** Indexes records of the cache by model so relations can be resolved without a request. */
export function createCacheLookup(
  queryClient: QueryClient,
  schema: SchemaDef,
  root: readonly string[],
) {
  return (model: string, idField: string, id: unknown) => {
    const visit = (data: unknown, dataModel: string): Record<string, unknown> | undefined => {
      if (Array.isArray(data)) {
        for (const item of data) {
          const found = visit(item, dataModel)
          if (found) return found
        }
        return undefined
      }
      if (!data || typeof data !== 'object') return undefined
      const record = data as Record<string, unknown>
      if (dataModel === model && record[idField] === id && !record.$optimistic) return record
      for (const [field, fieldDef] of Object.entries(schema.models[dataModel]?.fields ?? {})) {
        if (fieldDef.relation && record[field] !== undefined) {
          const found = visit(record[field], fieldDef.type)
          if (found) return found
        }
      }
      return undefined
    }
    for (const query of getZenStackQueries(queryClient, schema, root)) {
      const found = visit(query.query.state.data, query.model)
      if (found) return found
    }
    return undefined
  }
}

/**
 * Completes the optimistic records of a query's data so they match what the query requested.
 * Returns `undefined` when that's not possible (the query is then refreshed after the mutation
 * instead of being patched with incomplete data).
 */
export function completeOptimisticData(
  data: unknown,
  model: string,
  args: unknown,
  ctx: CompletionContext,
): unknown | undefined {
  try {
    return complete(data, model, args as Args, ctx)
  } catch (error) {
    if (error instanceof IncompleteError) return undefined
    throw error
  }
}
