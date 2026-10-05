import { createZenStackClient } from '@azzerty23/zenstack-orpc/client'
import { createZenStackQueryUtils } from '@azzerty23/zenstack-orpc/tanstack-query'
import { fileFields } from '@example/server/orpc-meta'
import type { AppRouter } from '@example/server/router'
import { schema } from '@example/server/schema'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { RouterClient } from '@orpc/server'
import { QueryClient } from '@tanstack/react-query'
import { getCurrentUser } from './auth'

export const queryClient = new QueryClient()

const link = new RPCLink({
  origin: window.location.origin,
  url: '/rpc',
  fetch: (url, init) => fetch(url, { ...init, credentials: 'include' }),
})

const rpc: RouterClient<AppRouter> = createORPCClient(link)

/** Direct calls, with results inferred from select / include / omit. */
export const client = createZenStackClient(rpc, {
  schema,
  path: 'db',
  files: fileFields,
})

/**
 * TanStack Query utils: inferred results, automatic invalidation, optimistic updates and live
 * queries (`liveOptions`).
 */
export const orpc = createZenStackQueryUtils(rpc, {
  schema,
  path: 'db',
  files: fileFields,
  optimistic: true,
  live: true,
  // Fills `@default(auth().id)` fields and relations to the current user (e.g. a new post's
  // `author`) in optimistic records.
  auth: getCurrentUser,
})
