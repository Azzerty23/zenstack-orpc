// End-to-end check of live queries over HTTP/SSE. Run the server, sign up alice@x.com and bob@x.com
// (password: password1234), then: `bun run e2e:live` (SERVER=http://localhost:3000 by default).

import { fileFields } from '@example/server/orpc-meta'
import type { AppRouter } from '@example/server/router'
import { schema } from '@example/server/schema'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { RouterClient } from '@orpc/server'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { createZenStackQueryUtils } from 'zenstack-orpc/tanstack-query'

const origin = process.env.SERVER ?? 'http://localhost:3000'

async function signIn(email: string) {
  const res = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ email, password: 'password1234' }),
  })
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
}

function utilsFor(cookie: string) {
  const link = new RPCLink({ origin, url: '/rpc', headers: { cookie } })
  const rpc: RouterClient<AppRouter> = createORPCClient(link)
  return { rpc, orpc: createZenStackQueryUtils(rpc, { schema, path: 'db', files: fileFields }) }
}

const alice = utilsFor(await signIn('alice@x.com'))
const bob = utilsFor(await signIn('bob@x.com'))

const queryClient = new QueryClient()
const observer = new QueryObserver(
  queryClient,
  bob.orpc.db.post.findMany.liveOptions({
    input: { include: { author: { select: { name: true } } } },
  }),
)
const seen: number[] = []
observer.subscribe((result) => {
  if (result.data) seen.push(result.data.length)
})

await new Promise((r) => setTimeout(r, 800))
const before = observer.getCurrentResult().data?.length ?? 0
const start = Date.now()
await alice.rpc.db.article.create({ data: { title: `Live ${Date.now()}` } })
while ((observer.getCurrentResult().data?.length ?? 0) === before) {
  if (Date.now() - start > 5000) throw new Error('Bob never saw the new post')
  await new Promise((r) => setTimeout(r, 20))
}
console.log(
  `Bob saw Alice's post after ${Date.now() - start} ms (${before} -> ${observer.getCurrentResult().data?.length})`,
)
console.log('author inferred & fetched:', observer.getCurrentResult().data?.at(-1)?.author)

// Private data: Alice's todos never trigger anything visible for Bob.
const todos = new QueryObserver(queryClient, bob.orpc.db.todo.findMany.liveOptions())
todos.subscribe(() => {})
await new Promise((r) => setTimeout(r, 300))
await alice.rpc.db.todo.create({ data: { title: 'secret' } })
await new Promise((r) => setTimeout(r, 500))
console.log("Bob's todos after Alice's write:", todos.getCurrentResult().data)
process.exit(0)
