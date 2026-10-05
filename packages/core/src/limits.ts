import { ORPCError } from '@orpc/server'
import type { SchemaDef } from '@zenstackhq/orm/schema'

/** Bounds on what a client can ask for, so one request can't load a whole table. */
export interface QueryLimits {
  /**
   * Maximum `take` of `findMany` and of included to-many relations. Larger values are rejected
   * (`BAD_REQUEST`), and reads without `take` get `defaultTake`. @default unlimited
   */
  maxTake?: number
  /** `take` applied to `findMany` and to-many relations without one. @default maxTake */
  defaultTake?: number
  /** Maximum nesting of relations in `include` / `select`. @default 10 */
  maxDepth?: number
  /** Maximum number of operations of a `$transaction`. @default 100 */
  maxTransactionSteps?: number
}

export const DEFAULT_LIMITS = { maxDepth: 10, maxTransactionSteps: 100 } as const

type Args = Record<string, any>

function reject(message: string): never {
  throw new ORPCError('BAD_REQUEST', { message })
}

/** Applies `take` limits to a to-many read (`findMany` args or an included relation's args). */
function limitTake(args: Args | undefined, limits: QueryLimits, path: string): Args | undefined {
  const { maxTake } = limits
  const defaultTake = limits.defaultTake ?? maxTake
  const take = args?.take
  if (typeof take === 'number' && maxTake !== undefined && Math.abs(take) > maxTake) {
    reject(`${path}: take must not exceed ${maxTake}`)
  }
  if (take === undefined && defaultTake !== undefined) return { ...args, take: defaultTake }
  return args
}

/** Applies limits to the relations selected by `args` (recursively). */
function limitSelection(
  schema: SchemaDef,
  model: string,
  args: Args | undefined,
  limits: QueryLimits,
  depth: number,
  path: string,
): Args | undefined {
  if (!args || typeof args !== 'object') return args
  let result = args
  for (const key of ['include', 'select'] as const) {
    const selection = args[key]
    if (!selection || typeof selection !== 'object') continue
    let limited: Args | undefined
    for (const [field, value] of Object.entries(selection as Args)) {
      const fieldDef = schema.models[model]?.fields[field]
      if (!value || !fieldDef?.relation) continue
      const fieldPath = `${path}.${field}`
      const maxDepth = limits.maxDepth ?? DEFAULT_LIMITS.maxDepth
      if (depth + 1 > maxDepth)
        reject(`${fieldPath}: relations can't be nested more than ${maxDepth} levels`)
      let nested: Args | undefined = value === true ? undefined : value
      if (fieldDef.array) nested = limitTake(nested, limits, fieldPath)
      nested = limitSelection(schema, fieldDef.type, nested, limits, depth + 1, fieldPath)
      const next = nested ?? true
      if (next !== value) {
        limited = { ...(limited ?? selection), [field]: next }
      }
    }
    if (limited) result = { ...result, [key]: limited }
  }
  return result
}

/**
 * Applies {@link QueryLimits} to the args of an operation: returns the args to run (with default
 * `take`s), or throws `BAD_REQUEST`.
 */
export function applyLimits(
  schema: SchemaDef,
  model: string,
  operation: string,
  args: unknown,
  limits: QueryLimits,
): unknown {
  const path = `${model}.${operation}`
  let result = args as Args | undefined
  if (operation === 'findMany') result = limitTake(result, limits, path)
  return limitSelection(schema, model, result, limits, 0, path)
}

export function checkTransactionSteps(count: number, limits: QueryLimits) {
  const max = limits.maxTransactionSteps ?? DEFAULT_LIMITS.maxTransactionSteps
  if (count > max) reject(`$transaction: at most ${max} operations`)
}
