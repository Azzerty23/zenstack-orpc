import { mkdirSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { TmpFileUploadHandlerPlugin } from '@orpc/node'
import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { OpenAPIReferenceHandlerPlugin } from '@orpc/openapi/plugins'
import { onError } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import { CORSPlugin } from '@orpc/server/plugins'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { auth } from './auth'
import { authDb, db } from './db'
import { generateSpec } from './openapi'
import { type Context, restRouter, router } from './router'

const port = Number(process.env.PORT ?? 3000)
const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5173'
const tmpDir = process.env.UPLOAD_TMP_DIR ?? 'uploads/.tmp'
mkdirSync(tmpDir, { recursive: true })

// Dev convenience: create tables from the ZModel (use migrations in production).
await db.$pushSchema().catch(() => {})

const fileHeaders = ['Content-Disposition', 'Standard-Server']
const plugins = [
  new CORSPlugin({
    origin: (origin) => origin,
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization', ...fileHeaders],
    exposeHeaders: fileHeaders,
  }),
  // Uploads are streamed to temporary files; global body limits live here.
  new TmpFileUploadHandlerPlugin({
    tmpDir,
    maxBodySize: { memory: 1024 * 1024, file: 10 * 1024 * 1024, stream: 10 * 1024 * 1024 },
  }),
]
const logError = (error: unknown) => console.error(error)

const rpcHandler = new RPCHandler(router, { plugins, interceptors: [onError(logError)] })

// Generated once, on first use.
let spec: ReturnType<typeof generateSpec> | undefined
const getSpec = () => (spec ??= generateSpec())

const openAPIHandler = new OpenAPIHandler(restRouter, {
  interceptors: [onError(logError)],
  plugins: [
    ...plugins,
    new OpenAPIReferenceHandlerPlugin({
      docsPath: '/reference',
      specPath: '/spec.json',
      docsTitle: 'zenstack-orpc example',
      spec: getSpec,
      // "Authorize" in the reference: paste the `token` returned by `POST /auth/sign-in/email`.
      providerConfig: { authentication: { preferredSecurityScheme: 'bearerAuth' } },
    }),
  ],
})

/** Resolves the session once per request. */
async function createContext(headers: Headers): Promise<Context> {
  const session = await auth.api.getSession({ headers })
  const user = session
    ? { id: session.user.id, name: session.user.name, email: session.user.email }
    : null
  return { user, db: user ? authDb.$setAuth({ id: user.id }) : authDb }
}

const app = new Hono()

app.use(
  '/api/auth/*',
  // `set-auth-token`: the session token, for bearer authentication (better-auth `bearer` plugin).
  cors({ origin: webOrigin, credentials: true, exposeHeaders: ['set-auth-token'] }),
)
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))

app.use('/rpc/*', async (c, next) => {
  const { matched, response } = await rpcHandler.handle(c.req.raw, {
    prefix: '/rpc',
    context: () => createContext(c.req.raw.headers),
  })
  if (matched) return c.newResponse(response.body, response)
  await next()
})

app.use('/api/*', async (c, next) => {
  const { matched, response } = await openAPIHandler.handle(c.req.raw, {
    prefix: '/api',
    context: () => createContext(c.req.raw.headers),
  })
  if (matched) return c.newResponse(response.body, response)
  await next()
})

serve({ fetch: app.fetch, port }, () => {
  // Warm the OpenAPI spec so the first visit of the reference is instant.
  void getSpec()
  console.log(`Server: http://localhost:${port}`)
  console.log(`  RPC:           /rpc`)
  console.log(`  REST:          /api   (reference: /api/reference)`)
  console.log(`  better-auth:   /api/auth`)
})
