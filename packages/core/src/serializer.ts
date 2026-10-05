import type { RPCJsonSerializerHandler } from '@orpc/client'
import { fromBase64, toBase64 } from './bytes'

export interface ZenStackSerializerOptions {
  /**
   * `Decimal` class used to restore `Decimal` values (e.g. `decimal.js`).
   * Without it, decimals are deserialized as strings, which ZenStack accepts as input.
   */
  Decimal?: new (
    value: string,
  ) => unknown
}

function isDecimal(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const ctor = (value as any).constructor
  return (
    (typeof ctor?.isDecimal === 'function' && ctor.isDecimal(value)) ||
    Object.prototype.toString.call(value) === '[object Decimal]'
  )
}

/**
 * Serializer handlers for ZenStack types the RPC serializer doesn't support natively:
 * `Decimal` and `Bytes` (`Uint8Array`). Use them on both sides:
 *
 * ```ts
 * const serializer = new RPCSerializer({ handlers: zenstackSerializerHandlers({ Decimal }) })
 * new RPCHandler(router, { serializer })   // server
 * new RPCLink({ url, serializer })          // client
 * ```
 */
export function zenstackSerializerHandlers(
  options: ZenStackSerializerOptions = {},
): Record<string, RPCJsonSerializerHandler> {
  return {
    'zenstack.decimal': {
      condition: isDecimal,
      serialize: (value) => String(value),
      deserialize: (value) => {
        if (typeof value !== 'string') throw new TypeError('Invalid Decimal value')
        return options.Decimal ? new options.Decimal(value) : value
      },
      isTerminal: true,
    },
    'zenstack.bytes': {
      condition: (value) => value instanceof Uint8Array,
      serialize: (value: Uint8Array) => toBase64(value),
      deserialize: (value) => {
        if (typeof value !== 'string') throw new TypeError('Invalid Bytes value')
        return fromBase64(value)
      },
      isTerminal: true,
    },
  }
}
