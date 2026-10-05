import { createZenStackRouter } from '@azzerty23/zenstack-orpc'
import { createZenStackOpenAPIRouter } from '@azzerty23/zenstack-orpc/openapi'
import { ORPCError, os } from '@orpc/server'
import { docs } from '../zenstack/orpc'
import { schema } from '../zenstack/schema'
import type { AuthDb } from './db'
import { publisher, storage } from './db'

export interface Context {
  /** ZenStack client bound to the current user (access policies apply). */
  db: AuthDb
  user: { id: string; name: string; email: string } | null
}

const base = os.$context<Context>()

/** Every generated procedure requires a signed-in user. */
const authed = base.use(({ context, next }) => {
  if (!context.user) throw new ORPCError('UNAUTHORIZED')
  return next({ context: { user: context.user } })
})

const zenstack = {
  base: authed,
  getDb: (context: Context) => context.db,
  models: { exclude: ['Session', 'Account', 'Verification'] },
  files: { storage },
} as const

/** RPC router, served by `RPCHandler` and consumed by the typed client. */
export const router = base.router({
  db: createZenStackRouter(schema, { ...zenstack, live: { publisher } }),
  me: base.handler(({ context }) => context.user),
})

/**
 * RESTful router, served by `OpenAPIHandler` (`/api/todos`, `/api/posts/{id}`...). Images are
 * served at `/api/posts/{id}/image` with ETags (`304 Not Modified` on revalidation) and range
 * requests, or redirected to a signed URL of the bucket.
 */
export const restRouter = createZenStackOpenAPIRouter(schema, {
  ...zenstack,
  files: { storage, redirect: !!storage.url },
  // `///` comments of the ZModel, as OpenAPI descriptions.
  docs,
})

export type AppRouter = typeof router
