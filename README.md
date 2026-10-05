# zenstack-orpc

Monorepo of [`@azzerty23/zenstack-orpc`](packages/core) — ZenStack v3 × oRPC v2 (beta) integration — and
its example app.

| Path | |
|---|---|
| `packages/core` | The library (router, REST/OpenAPI, live queries, `@file`, client & TanStack Query) |
| `example/server` | Example API: Hono (Node), better-auth, ZenStack policies, SQLite, REST with bearer auth |
| `example/web` | Example UI: Vite, React, TanStack Router & Query — live/optimistic todos, polymorphic posts (articles, photos), chat (live infinite query) |

```bash
bun install
bun run dev        # server on :3000, web on :5173 (proxied /rpc and /api)
bun run test       # library tests (runtime + types)
bun run typecheck
```

Open http://localhost:5173, create two accounts in two browsers: todos stay private, posts and
their images show up live for everyone. "Archive done" moves the completed todos to a new draft
article in one transaction (`$transaction((tx) => ...)`).

Posts are polymorphic (`@@delegate(kind)` in `example/server/zenstack/schema.zmodel`): a `Post`
is an `Article` (text) or a `Photo` (`@file` image, caption). They're created through their
sub-model (`article.create`, `photo.create`) and listed together with `post.findMany`, whose
results are a union narrowed by `kind`. Photos are displayed from the REST route
(`/api/photos/{id}/image`, revalidated with its ETag).

The chat is a live infinite query (`message.findMany.infiniteOptions({ input: { where: { roomId },
take: 10, ... }, live: true })`): new and deleted messages refetch the loaded pages, an edit only
the page holding it (each page shows when it last changed), and messages of other rooms refetch
nothing. `bun run --cwd example/web e2e:browser` checks all of it with two users.

## REST API & authentication

The REST API is served at http://localhost:3000/api, documented at
http://localhost:3000/api/reference (OpenAPI: `/api/spec.json`). The spec includes better-auth's
sign-up / sign-in / session endpoints (`Auth` tag) and declares two security schemes: a bearer
token (better-auth `bearer` plugin) and the session cookie. Every ZenStack route requires one of
them (`401` otherwise).

```bash
TOKEN=$(curl -s localhost:3000/api/auth/sign-in/email -H 'content-type: application/json' \
  -H 'origin: http://localhost:3000' \
  -d '{"email":"alice@x.com","password":"password1234"}' | jq -r .token)

curl localhost:3000/api/posts -H "authorization: Bearer $TOKEN"
curl localhost:3000/api/articles -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"data":{"title":"Hello","content":"From curl"}}'
```

In the reference, sign in with `POST /auth/sign-in/email`, then paste the returned `token` in
"Authentication" (bearer). `bun run --cwd example/server e2e:rest` checks this flow (tokens, 401s,
polymorphic posts, multipart upload) against a running server.

## Files

Images are stored in `example/server/uploads` by default. To store them in an S3-compatible bucket
(AWS S3, Cloudflare R2, MinIO...), set these variables in `example/server/.env`:

```bash
S3_BUCKET_URL=https://<account>.r2.cloudflarestorage.com/<bucket>   # path-style
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_REGION=auto
```

The browser then uploads images straight to the bucket (`presign` / `confirm`) and loads them
from signed URLs (the REST route redirects there). The bucket's CORS rules must allow `PUT` (with
the `Content-Type` header) and `GET` from the web origin.

Browser check of the example (two users, Chromium), with the server and web app running:

```bash
bunx playwright install chromium    # once
bun run --cwd example/web e2e:browser  # APP=http://localhost:5173 by default, HEADED=1 to watch
```

It works with both storages. To try direct uploads without a bucket, run `bun run --cwd example/web
fake-s3` (in-memory, doesn't check signatures) and start the server with
`S3_BUCKET_URL=http://localhost:9000/bucket S3_ACCESS_KEY_ID=id S3_SECRET_ACCESS_KEY=secret`.

The example server runs on Node (`tsx`) because `better-sqlite3` doesn't load in Bun.
