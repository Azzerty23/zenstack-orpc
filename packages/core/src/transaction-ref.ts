/** Reference to (a field of) the result of an earlier step of a `$transaction`. */
export interface TransactionRef {
  $ref: [step: number, ...path: (string | number)[]]
}

/**
 * References the result of an earlier `$transaction` step (by index), or one of its fields, in
 * the args of a later step. Typed as `T` so it fits where the value goes.
 *
 * @example
 * ```ts
 * client.db.$transaction([
 *   { model: 'Post', op: 'create', args: { data: { title: 'Hello' } } },
 *   { model: 'Comment', op: 'create', args: { data: { postId: txRef<string>(0, 'id'), text: 'First!' } } },
 * ])
 * ```
 */
export function txRef<T = any>(step: number, ...path: (string | number)[]): T {
  return { $ref: [step, ...path] } satisfies TransactionRef as T
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Whether a value is a `{ $ref: [step, ...path] }` reference. */
export function isTransactionRef(value: unknown): value is TransactionRef {
  if (!isPlainObject(value)) return false
  const keys = Object.keys(value)
  const ref = value.$ref
  return (
    keys.length === 1 &&
    keys[0] === '$ref' &&
    Array.isArray(ref) &&
    Number.isInteger(ref[0]) &&
    ref.slice(1).every((segment) => typeof segment === 'string' || typeof segment === 'number')
  )
}

/** References found in a step's args. */
export function collectRefs(value: unknown, result: TransactionRef[] = [], depth = 0) {
  if (depth > 64) return result
  if (isTransactionRef(value)) result.push(value)
  else if (Array.isArray(value)) for (const item of value) collectRefs(item, result, depth + 1)
  else if (isPlainObject(value)) {
    for (const item of Object.values(value)) collectRefs(item, result, depth + 1)
  }
  return result
}

/** Resolves a reference against the results of the steps run so far. */
export function resolveRef(ref: TransactionRef, results: unknown[]): unknown {
  const [step, ...path] = ref.$ref
  let value: unknown = results[step]
  for (const segment of path) {
    if (
      value === null ||
      typeof value !== 'object' ||
      FORBIDDEN_KEYS.has(String(segment)) ||
      !Object.hasOwn(value, segment)
    ) {
      return undefined
    }
    value = (value as Record<string | number, unknown>)[segment]
  }
  return value
}

/** Replaces the references of a step's args with the values they point to. */
export function resolveRefs(
  value: unknown,
  resolve: (ref: TransactionRef) => unknown,
  depth = 0,
): unknown {
  if (depth > 64) return value
  if (isTransactionRef(value)) return resolve(value)
  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, resolve, depth + 1))
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveRefs(item, resolve, depth + 1)]),
    )
  }
  return value
}
