import { type RPCJsonSerialization, RPCJsonSerializer } from '@orpc/client'
import { type ZenStackSerializerOptions, zenstackSerializerHandlers } from '../serializer'

/**
 * `QueryClient` default options to dehydrate queries on the server and hydrate them in the
 * browser (SSR, server components) without losing `Date`, `BigInt`, `Decimal` and `Bytes`
 * values: the dehydrated state stays plain JSON.
 *
 * @example
 * ```ts
 * const queryClient = new QueryClient({ defaultOptions: { ...zenstackHydration({ Decimal }) } })
 * ```
 */
export function zenstackHydration(options: ZenStackSerializerOptions = {}) {
  const serializer = new RPCJsonSerializer({ handlers: zenstackSerializerHandlers(options) })
  return {
    dehydrate: {
      serializeData: (data: unknown): RPCJsonSerialization => serializer.serialize(data),
    },
    hydrate: {
      deserializeData: (data: unknown): any => serializer.deserialize(data as RPCJsonSerialization),
    },
  }
}
