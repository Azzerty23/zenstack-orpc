import type { SchemaDef } from '@zenstackhq/orm/schema'
import { CRUD_OPERATIONS, type CrudOperation, modelFromKey } from './operations'
import type { TransactionOperation } from './transaction'
import { resolveRef, type TransactionRef } from './transaction-ref'

/**
 * Records the operations of a `$transaction` callback into steps. Calls return placeholders
 * (proxies) standing for their future results: reading a field of one gives a placeholder for
 * that field, which becomes a `{ $ref: [step, ...path] }` reference when used in the args of a
 * later step, and the actual value when returned by the callback.
 */
export interface RecordedTransaction {
  steps: TransactionOperation[]
  /** Replaces the placeholders returned by the callback with the results of the steps. */
  resolve(results: unknown[]): unknown
}

type Path = TransactionRef['$ref']

interface Placeholder {
  recording: object
  ref: Path
}

const PLACEHOLDERS = new WeakMap<object, Placeholder>()
const INSPECT = Symbol.for('nodejs.util.inspect.custom')
const MAX_DEPTH = 64

function fail(message: string): never {
  throw new Error(`$transaction callback: ${message}`)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function describe(ref: Path) {
  return `step ${ref[0]}${ref
    .slice(1)
    .map((segment) => (typeof segment === 'number' ? `[${segment}]` : `.${segment}`))
    .join('')}`
}

function placeholder(recording: object, ref: Path): any {
  const misuse = (what: string) =>
    fail(
      `${describe(ref)} isn't known until the transaction runs on the server: it can only be ` +
        `passed to a later operation or returned (${what})`,
    )
  const proxy = new Proxy(Object.create(null), {
    get(_, key) {
      if (key === INSPECT) return () => `[${describe(ref)}]`
      if (key === Symbol.toPrimitive) misuse('used as a primitive')
      if (key === Symbol.iterator || key === Symbol.asyncIterator) misuse('iterated')
      if (typeof key === 'symbol') return undefined
      if (key === 'then') {
        fail("don't await operations: the callback only records them and must be synchronous")
      }
      if (key === 'toJSON' || key === 'toString' || key === 'valueOf') misuse(`${key}()`)
      return placeholder(recording, [...ref, /^(0|[1-9]\d*)$/.test(key) ? Number(key) : key])
    },
    has: () => misuse('`in` operator'),
    ownKeys: () => misuse('enumerated'),
    set: () => misuse('assigned'),
    defineProperty: () => misuse('assigned'),
    deleteProperty: () => misuse('deleted'),
  })
  PLACEHOLDERS.set(proxy, { recording, ref })
  return proxy
}

/** Replaces placeholders with `{ $ref }` references in a step's args. */
function toRefs(recording: object, value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return value
  if (value && (typeof value === 'object' || typeof value === 'function')) {
    const found = PLACEHOLDERS.get(value)
    if (found) {
      if (found.recording !== recording) {
        fail(`${describe(found.ref)} comes from another transaction`)
      }
      return { $ref: found.ref } satisfies TransactionRef
    }
  }
  if (Array.isArray(value)) return value.map((item) => toRefs(recording, item, depth + 1))
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toRefs(recording, item, depth + 1)]),
    )
  }
  return value
}

/** Replaces placeholders with the results they stand for in the callback's return value. */
function fromRefs(recording: object, value: unknown, results: unknown[], depth = 0): unknown {
  if (depth > MAX_DEPTH) return value
  if (value && typeof value === 'object') {
    const found = PLACEHOLDERS.get(value)
    if (found) {
      if (found.recording !== recording) {
        fail(`${describe(found.ref)} comes from another transaction`)
      }
      return resolveRef({ $ref: found.ref }, results)
    }
  }
  if (Array.isArray(value))
    return value.map((item) => fromRefs(recording, item, results, depth + 1))
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        fromRefs(recording, item, results, depth + 1),
      ]),
    )
  }
  return value
}

function isThenable(value: unknown) {
  return (
    !!value &&
    (typeof value === 'object' || typeof value === 'function') &&
    !PLACEHOLDERS.has(value) &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/**
 * Runs a `$transaction` callback to record its operations. Model keys (`tx.post`) map to models
 * with the schema when given, else by capitalizing them (`post` -> `Post`).
 */
export function recordTransaction(
  callback: (tx: any) => unknown,
  schema?: SchemaDef,
): RecordedTransaction {
  const recording = {}
  const steps: TransactionOperation[] = []
  let open = true

  const tx = new Proxy(Object.create(null), {
    get(_, key) {
      if (typeof key === 'symbol') return undefined
      const model = schema ? modelFromKey(schema, key) : key.charAt(0).toUpperCase() + key.slice(1)
      if (!model) fail(`unknown model "${key}"`)
      return new Proxy(Object.create(null), {
        get(_, op) {
          if (typeof op === 'symbol') return undefined
          if (!(CRUD_OPERATIONS as readonly string[]).includes(op)) {
            fail(`unknown operation "${key}.${op}"`)
          }
          return (args?: unknown) => {
            if (!open) fail(`${key}.${op}() called after the callback returned`)
            steps.push({
              model,
              op: op as CrudOperation,
              ...(args === undefined ? {} : { args: toRefs(recording, args) }),
            })
            return placeholder(recording, [steps.length - 1])
          }
        },
      })
    },
  })

  let returned: unknown
  try {
    returned = callback(tx)
  } finally {
    open = false
  }
  if (isThenable(returned)) {
    // An `await` in the callback rejects it: report that instead of an unhandled rejection.
    ;(returned as Promise<unknown>).then(undefined, () => {})
    fail("don't await operations: the callback only records them and must be synchronous")
  }
  return { steps, resolve: (results) => fromRefs(recording, returned, results) }
}

/** Runs a `$transaction` input: an array of steps, or a callback recorded into steps. */
export async function runTransaction(
  input: unknown,
  send: (steps: unknown) => Promise<unknown>,
  schema?: SchemaDef,
): Promise<unknown> {
  if (typeof input !== 'function') return send(input)
  const recorded = recordTransaction(input as (tx: any) => unknown, schema)
  const results = recorded.steps.length > 0 ? ((await send(recorded.steps)) as unknown[]) : []
  return recorded.resolve(results)
}

/**
 * Wraps an oRPC client so that its `$transaction` procedures (at any depth) also accept a
 * callback. Everything else is forwarded untouched.
 */
export function withTransactionCallbacks<T>(client: T, schema?: SchemaDef): T {
  const wrapped = new WeakMap<object, unknown>()
  const wrap = (node: unknown): unknown => {
    if (!node || (typeof node !== 'object' && typeof node !== 'function')) return node
    if (!wrapped.has(node)) {
      wrapped.set(
        node,
        new Proxy(node, {
          get(target, key) {
            const value = Reflect.get(target, key)
            const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
            // Proxy invariant: frozen properties must be returned as is.
            if (typeof key === 'symbol' || (descriptor && !descriptor.configurable)) return value
            if (key === '$transaction' && typeof value === 'function') {
              return (input: unknown, ...rest: unknown[]) =>
                runTransaction(input, (steps) => value(steps, ...rest), schema)
            }
            return wrap(value)
          },
        }),
      )
    }
    return wrapped.get(node)
  }
  return wrap(client) as T
}
