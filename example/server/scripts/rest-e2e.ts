// End-to-end check of the REST API with bearer authentication, as a non-browser client would use
// it. Run the server, then: `bun run e2e:rest` (SERVER=http://localhost:3000 by default).

const origin = process.env.SERVER ?? 'http://localhost:3000'
const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`FAILED: ${what}`)
  console.log('ok -', what)
}

async function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers)
  if (init.token) headers.set('authorization', `Bearer ${init.token}`)
  if (typeof init.body === 'string') headers.set('content-type', 'application/json')
  // better-auth checks the origin of cookie-less requests too.
  headers.set('origin', origin)
  const response = await fetch(`${origin}/api${path}`, { ...init, headers })
  const type = response.headers.get('content-type') ?? ''
  return { status: response.status, body: type.includes('json') ? await response.json() : null }
}

// Signs up (or in, when the account exists) and returns the session token.
const email = `rest-${Date.now()}@x.com`
const credentials = JSON.stringify({ email, password: 'password1234', name: 'REST client' })
await api('/auth/sign-up/email', { method: 'POST', body: credentials })
const signIn = await api('/auth/sign-in/email', { method: 'POST', body: credentials })
const token: string = signIn.body.token
check(signIn.status === 200 && !!token, 'signed in, got a session token')

check((await api('/posts')).status === 401, 'no token: 401 Unauthorized')
check((await api('/posts', { token: 'nope' })).status === 401, 'invalid token: 401 Unauthorized')

const session = await api('/auth/get-session', { token })
check(session.body?.user?.email === email, 'the token identifies the user (get-session)')

// Polymorphic posts: created through their sub-model, listed together from the base model.
const article = await api('/articles', {
  method: 'POST',
  token,
  body: JSON.stringify({ data: { title: 'Over REST', content: 'Hello' } }),
})
check(article.status === 201 && article.body.kind === 'Article', 'article created (201)')

const photo = await api('/photos', {
  method: 'POST',
  token,
  body: JSON.stringify({ data: { title: 'REST photo', caption: 'A pixel' } }),
})
check(photo.status === 201 && photo.body.kind === 'Photo', 'photo created (201)')

const form = new FormData()
const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
)
form.set('file', new File([png], 'pixel.png', { type: 'image/png' }))
const upload = await api(`/photos/${photo.body.id}/image`, { method: 'PUT', token, body: form })
check(upload.status === 200 && !!upload.body.image, 'photo image uploaded (multipart)')

const mine = await api(
  `/posts?where=${encodeURIComponent(JSON.stringify({ authorId: session.body.user.id }))}`,
  { token },
)
const kinds = (mine.body as { kind: string }[]).map((post) => post.kind).sort()
check(
  JSON.stringify(kinds) === '["Article","Photo"]',
  `GET /posts returns both sub-models (${kinds.join(', ')})`,
)

const image = await fetch(`${origin}/api/photos/${photo.body.id}/image`, {
  headers: { authorization: `Bearer ${token}` },
  redirect: 'manual',
})
check([200, 302].includes(image.status), `image downloaded (${image.status})`)

check(
  (await api(`/posts/${article.body.id}`, { method: 'DELETE', token })).status === 200,
  'article deleted through the base model',
)
check((await api(`/articles/${article.body.id}`, { token })).body === null, 'sub-model row gone')

const spec = await (await fetch(`${origin}/api/spec.json`)).json()
check(
  !!spec.components.securitySchemes.bearerAuth && spec.paths['/auth/sign-in/email'],
  'spec documents bearer auth and the sign-in endpoint',
)

export {}
