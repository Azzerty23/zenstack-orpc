# zenstack-orpc

Generate a fully typed [oRPC v2](https://orpc.dev) router from a [ZenStack v3](https://zenstack.dev) schema:
CRUD procedures validated by ZenStack, RESTful/OpenAPI routes, live queries, `@file` fields, and
TanStack Query utils with automatic invalidation and optimistic updates. Access policies
(`@@allow` / `@@deny`) apply everywhere.

> Targets `@orpc/*@2.0.0-beta.42` (pinned: oRPC betas may break their API) and
> `@zenstackhq/*@^3.9`. Node 20+. Tested on SQLite and Postgres.

```bash
bun add zenstack-orpc @orpc/server@beta @orpc/client@beta @zenstackhq/orm zod
# optional, per feature
bun add @orpc/openapi@beta @orpc/zod@beta     # REST / OpenAPI
bun add @orpc/publisher@beta                   # live queries
bun add @orpc/node@beta                        # file uploads streamed to disk
bun add @orpc/tanstack-query@beta @tanstack/react-query
```

## Server

```ts
import { os, ORPCError } from '@orpc/server'
import { createZenStackRouter } from 'zenstack-orpc'
import { schema } from './zenstack/schema'

const base = os.$context<{ db: typeof authDb; user: User | null }>()
const authed = base.use(({ context, next }) => {
  if (!context.user) throw new ORPCError('UNAUTHORIZED')
  return next()
})

export const router = base.router({
  db: createZenStackRouter(schema, {
    base: authed,                       // context + middlewares of every procedure
    getDb: (ctx) => ctx.db,             // e.g. authDb.$setAuth(user): policies apply
    models: { exclude: ['Session', 'Account', 'Verification'] },
  }),
})
```

Every model gets `router.db.<model>.<operation>`, validated with ZenStack's own Zod schemas
(`createQuerySchemaFactory`, so `@email`, `@length`, `@@validate`... are enforced). Inputs are
validated once: the ORM's own validation is skipped (`$setInputValidation(false)`). It's kept when
the client restricts its inputs more than the router: pass the client's `slicing` /
`allowQueryTimeOmitOverride` to `queryOptions` too.

| Reads | Writes |
|---|---|
| `findMany`, `findUnique`, `findFirst`, `exists`, `count`, `aggregate`, `groupBy` | `create`, `createMany`, `createManyAndReturn`, `update`, `updateMany`, `updateManyAndReturn`, `upsert`, `delete`, `deleteMany` |

Plus `router.db.$transaction` (sequential, atomic). On the client, it takes a callback like
ZenStack's `$transaction`, except that it's **synchronous**: it records the operations, which run
on the server in one request. A call returns a placeholder typed as its result, to pass to later
operations or return; the promise resolves to what the callback returns, with actual values:

```ts
const { post, comment } = await client.db.$transaction((tx) => {
  const post = tx.post.create({ data: { title: 'Hello' } })
  const comment = tx.comment.create({ data: { postId: post.id, text: 'First!' } })
  return { post, comment }
})
```

Results aren't known while the callback runs: don't `await` operations, nor branch or compute on
placeholders (`if (post.published)`, `` `${post.title}` ``). Most misuses throw (`await`, string
conversion, spreading, iterating); a placeholder is always truthy, though. Logic depending on
results belongs in a procedure of yours, with ZenStack's interactive `$transaction`.

The callback needs a client wrapped by `createZenStackClient`, `typedClient` or
`createZenStackQueryUtils` (`orpc.db.$transaction.mutationOptions()`, then
`mutate((tx) => ...)`). It compiles to the wire format, also accepted directly: an array of
steps, where `txRef(step, ...path)` references the result of an earlier one:

```ts
import { txRef } from 'zenstack-orpc/client'

await client.db.$transaction([
  { model: 'Post', op: 'create', args: { data: { title: 'Hello' } } },
  { model: 'Comment', op: 'create', args: { data: { postId: txRef<string>(0, 'id'), text: 'First!' } } },
])
```

Steps without references are validated before anything runs. Steps with references are validated
once resolved, inside the transaction, so a failure there rolls everything back. A reference can
only point to an earlier step.

Options: `base`, `getDb`, `models` / `operations` (`{ include?, exclude? }`), `queryOptions`
(passed to `createQuerySchemaFactory`), `transaction`, `live`, `files`, `limits`.

**Limits.** So that one request can't load a whole table or run a huge transaction:

```ts
createZenStackRouter(schema, {
  getDb,
  limits: {
    maxTake: 100,             // max `take` of findMany and included to-many relations
    defaultTake: 20,          // applied when `take` is missing (defaults to maxTake)
    maxDepth: 10,             // max relation nesting in include / select (default 10)
    maxTransactionSteps: 100, // max operations of a $transaction (default 100)
  },
})
```

Requests over a limit get a `BAD_REQUEST`. `maxTake` is off by default: set it on any public API.
`createZenStackOpenAPIRouter` takes the same `limits`.

**Errors.** ZenStack errors become `ORPCError`s, like `@zenstackhq/server`:

| ORM reason | oRPC code |
|---|---|
| `not-found` | `NOT_FOUND` |
| `invalid-input` | `UNPROCESSABLE_CONTENT` |
| `rejected-by-policy` | `FORBIDDEN` |
| `db-query-error` | `BAD_REQUEST` |
| other | `INTERNAL_SERVER_ERROR` |

`error.data` holds `{ reason, model, rejectedByPolicyReason?, dbErrorCode? }`. Use
`toORPCError` / `withORPCErrors` in hand-written procedures. The REST router declares these
errors (`.errors(zenstackErrors)`): the OpenAPI document describes the `400` / `403` / `404` /
`422` responses of every route, and their bodies are `defined: true`. Declare `zenstackErrors`
on your own procedures for the same result. On the client, `isZenStackError`
narrows `error.data`:

```ts
import { isZenStackError } from 'zenstack-orpc/client'

if (isZenStackError(error, 'rejected-by-policy')) toast("You can't edit this post")
if (isZenStackError(error, 'db-query-error') && error.data.dbErrorCode === '23505') toast('Already taken')
```

**Metadata.** Every procedure carries `zenstackMeta({ model, operation })`, readable in
middlewares with `getZenStackMeta(procedure)`.

**Serialization.** `Date` and `BigInt` are native. For `Decimal` and `Bytes`:
`new RPCSerializer({ handlers: zenstackSerializerHandlers({ Decimal }) })` on both sides. In
REST, `Decimal`s are strings and `Bytes` are base64 strings, in both directions.

**ZenStack features.** They are all tested:

- **Polymorphic models (`@@delegate`).** Sub-models get their own procedures
  (`video.create`...). A base model's results are typed as a union of its sub-models, narrowed by
  the discriminator (`if (asset.kind === 'Video') asset.duration`). Files, cascades and live
  topics follow ZenStack's table-per-model layout: deleting a `Video` deletes its `Asset` row and
  the database cascade removes the `Video` row, files included. With TanStack Query, writes
  through the base model invalidate the sub-model queries, and optimistic updates apply across
  the hierarchy (a `video.update` patches `asset.findMany`).
- **Views (`view`).** Only read procedures are generated; `$transaction` refuses writes to them.
  Views aren't live: writes to their tables don't refresh them.
- **Typed JSON (`@json`), `Json`, `Decimal`, `Bytes`.** Typed and validated, including filters
  such as `where: { address: { is: { city: 'Paris' } } }`.
- **`@computed`** fields are returned and typed, and rejected in writes. **`@omit`** fields are
  left out of results and types, unless the query asks for them (`omit: { password: false }`).
- **Field-level policies** (`@allow('read' | 'update', ...)` on a field). Unreadable fields come
  back as `null`; writes to fields the user can't update are `FORBIDDEN`. `@file` fields follow
  them too: `get` / `url` answer `NOT_FOUND`, `upload` / `remove` / `presign` answer `FORBIDDEN`.
  **`post-update`** rules reject the update (and roll back its `$transaction`).
- **Search (PostgreSQL).** `@fuzzy` (`pg_trgm`) and `@fullText` fields accept the `fuzzy` / `fts`
  filters and `_fuzzyRelevance` / `_ftsRelevance` ordering, over RPC and REST. Search results
  aren't patched by optimistic updates (the database decides what matches): they're refreshed
  after the mutation.

## REST / OpenAPI

```ts
import { createZenStackOpenAPIRouter, ZenStackJsonSchemaConverter } from 'zenstack-orpc/openapi'

const restRouter = createZenStackOpenAPIRouter(schema, { base: authed, getDb: (ctx) => ctx.db })

let spec: Promise<OpenAPIDocument> | undefined // generate once
new OpenAPIHandler(restRouter, {
  plugins: [
    new OpenAPIReferenceHandlerPlugin({
      spec: () =>
        (spec ??= new OpenAPIGenerator({
          converters: [new ZenStackJsonSchemaConverter(restRouter)],
        }).generate(restRouter)),
    }),
  ],
})
```

Use `ZenStackJsonSchemaConverter` (requires `@orpc/zod`) rather than the plain
`ZodToJsonSchemaConverter`. ZenStack's input schemas are deeply recursive. This converter reuses
their names (`PostWhereInput`, `PostFindManyArgs`...) as shared components and documents responses
(`Post`, `User`...), so the spec stays small and readable. On the example schema it is about 260 KB
instead of 12 MB of inlined anonymous schemas. `SmartCoercionHandlerPlugin` isn't needed: GET
arguments are JSON.

Routes use oRPC v2 [`openapi()` routing](https://orpc.dev/docs/openapi/routing):

```
GET    /posts                  findMany      POST   /posts                 create (201)
GET    /posts/{id}             findUnique    PATCH  /posts/{id}            update
GET    /posts/first|count|exists|aggregate   DELETE /posts/{id}            delete
POST   /posts/group-by         groupBy       PUT    /posts                 upsert
POST|PATCH|DELETE /posts/batch               createMany / updateMany / deleteMany
POST|PATCH /posts/batch/return               createManyAndReturn / updateManyAndReturn
```

GET arguments are JSON query parameters: `GET /posts?where={"published":true}&take=10`.
Models with compound ids have no `/{id}` routes (use `where` through the RPC router, or
`GET /tags?where=...`). Views only get the read routes.

**Documentation from ZModel.** Descriptions come from the schema, like in ZenStack's own OpenAPI
spec:

```zmodel
/// Blog posts.
model Post {
  /// Markdown.
  content String?
  title   String  @meta('description', 'Shown in lists')
  ...
  @@meta('openapi:path', 'articles') // `/articles` instead of `/posts`
  @@meta('openapi:tags', ['Blog'])
}
```

`@@meta('description', ...)` / `@meta('description', ...)` win over `///` comments.

`///` comments aren't part of the runtime schema: the plugin generates them as `docs` in `orpc.ts`,
passed with `createZenStackOpenAPIRouter(schema, { docs, ... })`. Operations are described by the
model's description, then a summary of its access policies (field-level ones included). Paths are
plural kebab-case by default (`BlogPost` → `/blog-posts`, `PostStats` → `/post-stats`). The
`modelPath` and `tags` options take precedence over `@@meta`.

Generating the document takes a few seconds on large schemas: oRPC deduplicates components with
deep comparisons. Generate it once and cache it, as above.

## Live queries

The RPC router exposes a `$changes` stream; clients use `liveOptions` like `queryOptions`.

```ts
import { MemoryPublisher } from '@orpc/publisher/memory'
import { zenstackLive, type ZenStackChangeEvents } from 'zenstack-orpc'

const publisher = new MemoryPublisher<ZenStackChangeEvents>({ resume: { enabled: true } })
const db = new ZenStackClient(schema, { dialect }).$use(zenstackLive(schema, publisher))

createZenStackRouter(schema, { getDb, live: { publisher } })
```

```ts
useQuery(orpc.db.todo.findMany.liveOptions({ input: { where: { done: false } } }))
```

Live queries only receive the changes they can be affected by. Each query watches **topics**,
derived from its arguments by `queryTopics`:

| Query | Topics |
|---|---|
| `message.findMany({ where: { conversationId: 'A' } })` | `Message.conversationId="A"` |
| `todo.findUnique({ where: { id: 3 } })` | `Todo.id=3` |
| `conversation.findUnique({ where: { id: 'A' }, include: { messages: true } })` | `Conversation.id="A"`, `Message.conversationId="A"` |
| `post.findMany({ include: { author: true } })` | `Post`, `User` (no key equality: the whole model) |

A message sent in conversation B never reaches the subscribers of A: nothing is sent, nothing is
refetched. Filter live queries on an id or a foreign key, even when policies already narrow
them (`where: { ownerId: me }`), so their subscription is narrowed too.

How it works:

- `zenstackLive` is a ZenStack runtime plugin publishing `{ model, action, keys }` **after
  commit** for every write, including writes made outside oRPC. Rolled-back transactions publish
  nothing. `keys` holds the id and foreign key values of the changed records, before and after
  the write. They come from the `RETURNING` clause ZenStack already uses, so this adds no query
  (except for updates changing a foreign key, and deletes on MySQL).
- `$changes` receives the subscriber's topics. They are **authorized once**, with the
  subscriber's policies: the record for an id topic, the referenced parent for a foreign key
  topic (e.g. the conversation). Events are then matched in memory.
- Creates and updates are also checked against the subscriber's read policy (one query per model
  and batch, only for subscribers whose topics matched). Updates then carry the ids of the
  updated records the subscriber can read, so live infinite queries refetch only the pages holding
  them. Deletes can't be checked anymore: they
  are forwarded to the matching topics. For models anyone can read, the check only costs
  queries: turn it off in ZModel.

  ```zmodel
  model Post {
    ...
    @@allow('read', true)
    @@live(checkVisibility: false)
  }
  ```
- Subscribers only receive the keys of their own matched topics (plus the ids of the updated
  records they can read), and events carry **no data**:
  live queries refetch through their regular procedure, so users only see what their policies
  allow.
- Each client keeps **one** `$changes` connection for all its observed live queries. Changes are
  batched (50 ms). `lastEventId` resume is supported, and reconnections back off with jitter and
  resync live queries.
- Scale out with any `@orpc/publisher` adapter: Redis, Upstash, or `DurablePublisher` on
  Cloudflare. Every server process receives every event and matches it against its own
  subscribers (in memory, without queries).

To protect the database from bursts of writes, set a minimum delay between two refetches of a
live query. The first change refetches right away, and the changes arriving during the delay are
merged into one refetch at its end:

```ts
createZenStackQueryUtils(client, { schema, path: 'db', live: { throttle: 1000 } }) // every live query
orpc.db.post.findMany.liveOptions({ input, throttle: 5000 }) // one query
```

Whole-model topics refetch for every change of the model. A shared cache in front of the
database only absorbs them when the result is the same for everyone (public data, same
arguments, `@@live(checkVisibility: false)`), with concurrent identical requests coalesced.
Results filtered by policies differ per user: narrow those queries with a key instead.

Rows the database changes along with a deleted record (`onDelete: Cascade`, `SetNull`,
`SetDefault`) are published too: their keys are read before the delete, in its transaction (one
query per affected model). Raw SQL (`$executeRaw`) publishes no event.

`@@delegate` models are written table by table (`Asset`, then `Video`), so a query watches every
table it reads. `video.findUnique({ where: { id } })` watches `Video.id` and `Asset.id`. A
foreign key inherited from the base model (`ownerId`) only narrows the base table: the sub-model's
table is then watched as a whole.

**Server-side rendering.** Prefetch on the server with a server-side client, and hydrate in the
browser. `zenstackHydration` keeps `Date`, `BigInt`, `Decimal` and `Bytes` values through the
dehydrated JSON:

```ts
import { connectLive, createZenStackQueryUtils, zenstackHydration } from 'zenstack-orpc/tanstack-query'

// Server (one QueryClient per request)
const serverOrpc = createZenStackQueryUtils(createRouterClient(router, { context }), { schema, path: 'db' })
const queryClient = new QueryClient({ defaultOptions: zenstackHydration() })
await queryClient.prefetchQuery(serverOrpc.db.post.findMany.liveOptions({ input }))
const state = dehydrate(queryClient)

// Browser
const queryClient = new QueryClient({ defaultOptions: zenstackHydration() })
useEffect(() => connectLive(orpc, queryClient), [queryClient])
```

The query keys don't depend on the client, so hydrated queries are picked up by the browser's
`orpc`. Nothing opens a `$changes` stream on the server, since queries aren't observed there. A
hydrated live query doesn't fetch in the browser, and live updates normally start with a query's
first fetch. That is why the browser `QueryClient` must be connected with `connectLive`.

## `@file` fields

Declare files in ZModel. The plugin ships the `@file` attribute and generates `orpc.ts` (file
field types, and the `///` comments used by the OpenAPI spec).

```zmodel
plugin orpc {
  provider = 'zenstack-orpc/plugin-orpc'
}

model Post {
  id    String  @id @default(cuid())
  image String? @file(accept: ['image/*'], maxSize: 5242880)  // stores the storage key
}
```

```ts
import { createFsStorage } from 'zenstack-orpc/node'
import { TmpFileUploadHandlerPlugin } from '@orpc/node'

createZenStackRouter(schema, { getDb, files: { storage: createFsStorage({ dir: 'uploads' }) } })
new RPCHandler(router, {
  plugins: [new TmpFileUploadHandlerPlugin({ maxBodySize: { memory: 1e6, file: 1e7, stream: 1e7 } })],
})
```

Each `@file` field gets these procedures, all running with the user's policies:

- `post.image.upload({ where, file })` stores the file, updates the record, and rolls the upload
  back if the update is denied. With `@file(cleanup: true)`, it also deletes the previous file.
- `post.image.get({ where })` returns a `File`.
- `post.image.remove({ where })` clears the field (and deletes the file with `cleanup: true`).
- `post.image.url({ where })` returns `{ url, expiresAt }`, a temporary URL downloading the file
  straight from the storage. It needs a storage with signed URLs (S3, R2...).
- `post.image.presign({ where, name, type, size })` and `post.image.confirm({ where, key })` let
  the browser upload directly to the storage (see below).

`accept` and `maxSize` are validated per field. Global body limits and disk streaming come from
`TmpFileUploadHandlerPlugin`.

**Storages.** `createFsStorage` (`zenstack-orpc/node`) writes to a directory, and
`createMemoryStorage` is meant for tests. `createS3Storage` (`zenstack-orpc/s3`, requires
`aws4fetch`) works with AWS S3, Cloudflare R2, MinIO, B2 and Tigris, on Node, Bun, Deno and
Workers:

```ts
import { createS3Storage } from 'zenstack-orpc/s3'

const storage = createS3Storage({
  bucketUrl: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com/uploads`,
  accessKeyId: R2_ACCESS_KEY_ID,
  secretAccessKey: R2_SECRET_ACCESS_KEY,
  // region: 'eu-west-3' for AWS; publicUrl: 'https://cdn.example.com' for public files
})
createZenStackRouter(schema, { getDb, files: { storage, expiresIn: 900 } })
```

Any other storage implements `FileStorage`:
- `put`, `get` and `delete` are required;
- `stat`, `url` and `presignUpload` are optional and unlock `url` and `presign` / `confirm`.

**Direct uploads.** Large files shouldn't go through your server:

```ts
const upload = await client.db.post.image.presign({ where, name: file.name, type: file.type, size: file.size })
await fetch(upload.url, { method: upload.method, headers: upload.headers, body: file })
await client.db.post.image.confirm({ where, key: upload.key })
```

The flow has three steps:

1. **`presign`** checks `accept` and `maxSize`, and checks that the user may update the record
   (with a rolled-back no-op update). It then signs a URL bound to the file's type and size.
2. **The browser** sends the file to that URL.
3. **`confirm`** reads the stored object's size and type, deleting it if they don't match. It
   then saves the key, and cleans up the previous file with `cleanup: true`.

Uploads that are never confirmed stay in the bucket. Expire them with a lifecycle rule on the
upload prefix.

**REST.** The field gets these routes:
- `PUT /posts/{id}/image` (upload);
- `GET /posts/{id}/image`;
- `DELETE /posts/{id}/image`;
- `GET /posts/{id}/image/url`;
- `POST /posts/{id}/image/presign` and `POST /posts/{id}/image/confirm`, when the storage
  supports them.

Downloads are served with an `ETag` and answer `304 Not Modified` to `If-None-Match`. Keys are
never reused, so a new file always gets a new ETag. They also support `Range` requests
(`206 Partial Content`, for video seeking). Options:

```ts
createZenStackOpenAPIRouter(schema, {
  getDb,
  files: {
    storage,
    cacheControl: 'private, max-age=3600', // default 'private, no-cache' (revalidates the ETag)
    redirect: true, // 302 to a signed storage URL instead of streaming through the server
  },
})
```

**Several files per field.** On databases with lists (PostgreSQL), use `String[] @file`:

```zmodel
model Gallery {
  photos String[] @file(accept: ['image/*'], cleanup: true)
}
```

`upload` and `confirm` append a file. `get`, `remove` and `url` take the file's key:
`gallery.photos.remove({ where, key })`. In REST, upload is `POST /galleries/{id}/photos`, and
the other routes take `?key=`. Elsewhere, store files in a related model
(`model Photo { file String @file ... }`).

To delete stored files whatever the write path (oRPC, REST, scripts...), install `zenstackFiles`
on the base client. After commit, it deletes the files of deleted records and the files replaced
or cleared by an update. Rolled-back mutations keep their files.

```ts
import { zenstackFiles } from 'zenstack-orpc'

const storage = createFsStorage({ dir: 'uploads' })
const db = new ZenStackClient(schema, { dialect }).$use(zenstackFiles(schema, storage))
```

It adds no query to ordinary writes. Deleted keys come from the `RETURNING` clause of ZenStack's
`DELETE` (MySQL, which lacks `RETURNING`, reads them first). Previous keys are read only for
updates that write a `@file` field.

Database cascades (`onDelete: Cascade`) are handled too. Before deleting a record whose cascade
reaches models with `@file` fields, their keys are read in the same transaction, one query per
such model (`select "cover" from "Post" where "authorId" in (select "id" from "User" where …)`).
Deletes whose cascades don't reach any file pay nothing.

Cleanup is opt-in: zenstack-orpc never deletes a stored file unless the field asks for it with
`@file(cleanup: true)`. When a user may write a field but not read it (field-level
`@allow('read', ...)`), `upload` / `remove` still delete the file they replace: its key is read
without access policies, and never returned. It then applies in every case: replaced, cleared, record deleted directly
or by a cascade. The plugin and the `upload` / `remove` procedures read the same attribute:

```zmodel
model Post {
  cover   String? @file(accept: ['image/*'], cleanup: true)  // deleted with the post, replaced or cleared
  archive String? @file                                      // never deleted by zenstack-orpc
}
```

For massive cascades (deleting a tenant and thousands of files), leave `cleanup` off and delete
the tenant's storage prefix (or use a bucket lifecycle rule). Otherwise every key is read inside
the deleting transaction.

## Client

oRPC v2 clients aren't generic, so results are typed by a thin overlay (an identity function at
runtime). `select` / `include` / `omit` are inferred, and unknown keys are rejected.

```ts
import { createZenStackClient } from 'zenstack-orpc/client'
import { createZenStackQueryUtils } from 'zenstack-orpc/tanstack-query'
import { schema } from './zenstack/schema'
import { fileFields } from './zenstack/orpc'

const rpc: RouterClient<AppRouter> = createORPCClient(link)

export const client = createZenStackClient(rpc, { schema, path: 'db', files: fileFields })
const posts = await client.db.post.findMany({ include: { author: { select: { name: true } } } })
//    ^? { id: string; title: string; ...; author: { name: string } }[]

export const orpc = createZenStackQueryUtils(rpc, {
  schema,
  path: 'db',
  files: fileFields,
  optimistic: true, // default false
})
useQuery(orpc.db.post.findMany.queryOptions({ input: { include: { author: true } } }))
useMutation(orpc.db.post.update.mutationOptions())
```

`createZenStackQueryUtils` wraps `createTanstackQueryUtils` (same options) and installs the
`zenstackQueryPlugin` `RouterUtilsPlugin`, which hooks into every ZenStack mutation:

- **Invalidation** (on by default): queries whose result may change are invalidated, including
  relations read through `include`, nested writes and cascades. This uses
  `@zenstackhq/client-helpers`, the same logic as ZenStack's own hooks.
- **Optimistic updates** (`optimistic: true`): the cache is patched before the mutation, items are
  flagged `$optimistic`, and the cache is restored on error. Optimistic records are completed to
  match each query:
  - `@default(auth().…)` fields are filled from the `auth` option;
  - relations requested with `include` / `select` are resolved from `auth` (e.g. a new post's
    `author`) or from records already in the cache;
  - to-many relations default to `[]` and `_count` to zeros.

  A query whose records can't be completed is left untouched and refreshed after the mutation, so
  components never receive partial data.

  Optimistic records also follow each list query's arguments, evaluated in memory like the
  database would:
  - a created record only shows up in the lists whose `where` it matches, at the place their
    `orderBy` gives it (last without `orderBy`, like insertion order), and the list is cut back to
    its `take`;
  - an update making a record leave a filtered list removes it right away;
  - what can't be evaluated in memory (relation filters, JSON, search, string comparisons
    depending on the collation, MySQL strings, later pages with `skip` / `cursor`, `distinct`) leaves
    the query untouched: it's refreshed after the mutation. String sorting approximates the
    database collation (binary on SQLite, locale-aware on PostgreSQL) until that refresh.

  ```ts
  createZenStackQueryUtils(rpc, { schema, path: 'db', optimistic: true, auth: () => currentUser })
  ```
- **Live queries**: `liveOptions` (see above).
- **Infinite queries**: `findMany.infiniteOptions` pages from `take`, and `live: true` keeps the
  loaded pages up to date:

  ```ts
  useInfiniteQuery(
    orpc.db.message.findMany.infiniteOptions({
      input: { where: { conversationId }, orderBy: { createdAt: 'desc' }, take: 20 },
      live: true, // or { throttle: 1000 }
      maxPages: 10, // bounds what a change refetches
    }),
  )
  ```

  The next page starts after the last record loaded (`cursor` on its id, so the id must be
  selected). With `pagination: 'offset'` (the default with relevance ordering, which can't be
  combined with a cursor), it skips the records loaded. oRPC's own form
  (`input: (pageParam) => args`, `initialPageParam`, `getNextPageParam`) works for every read
  operation, with `live` too. Infinite queries are invalidated after mutations, but not patched
  optimistically.

  A live infinite query refetches only the pages holding the records an update changed (an edit,
  a reaction...). Creates and deletes shift the pages, so they refetch every loaded page; so does
  an update moving a record to another page or out of the list (detected when the refetched page's
  bounds changed).

Composable types, as in zenstack-trpc, are exported too:

```ts
type Zen = WithZenStack<SchemaType, 'db', FileFields>
const client = typedClient<WithClient<Zen>>()(rpc)
const orpc = typedClient<WithQueryUtils<Zen>>()(
  createTanstackQueryUtils(rpc, { plugins: [zenstackQueryPlugin({ schema, path: ['db'], client: rpc })] }),
)
```

## Limits

What zenstack-orpc doesn't do, by design or because of ZenStack or oRPC.

**Versions and databases**

- **oRPC beta.** The peer dependencies are pinned to `2.0.0-beta.42`; each oRPC beta may need a
  new release of this library.
- **MySQL** isn't tested. It has no `RETURNING`, so the live and files plugins read rows before
  deletes there (one extra query). Optimistic updates don't evaluate string filters on MySQL (its
  collations ignore case).
- **`String[] @file`**, `@fuzzy` and `@fullText` need PostgreSQL.

**Live queries**

- **Events carry no data**: a change refetches the affected queries through their regular
  procedures. That's what keeps policies exact, at the cost of one refetch per change and query.
  Use `throttle` on busy queries.
- **Deletes** can't be checked against policies (the record is gone): they are forwarded to every
  subscriber of the matching topics (as a signal, never data).
- **Topic authorization** happens once per subscription. A user who loses access keeps receiving
  signals (never data) until the stream reconnects.
- **Topics** come from id and foreign key equalities of `where`. Other filters watch the whole
  model; compound ids and compound foreign keys too.
- **Raw SQL** (`$executeRaw`, `$queryRaw`) publishes no event (and deletes no file).
- **Views** aren't live: writes to their tables don't notify them.
- **Fan-out** happens in each server process: every process receives every event (through the
  publisher) and matches it against its subscribers in memory. Policies aren't compiled to SQL to
  target subscribers.
- **Infinite queries** refetch every loaded page on creates and deletes (bound it with `maxPages`).

**REST / OpenAPI**

- **GET arguments are JSON** (`?where={"published":true}`), not one query parameter per field:
  ZenStack's filters (nested, `OR`, `null`...) don't fit bracket notation.
- **Compound ids** have no `/{id}` routes: use `where`.
- **No nested routes** (`/posts/{id}/comments`) and no JSON:API format: use `include` /
  `where`, or `@zenstackhq/server`'s REST handler for JSON:API.
- **Generating the document takes seconds** on large schemas (oRPC deduplicates components with
  deep comparisons): generate it once and cache it.

**TanStack Query**

- **Optimistic updates** only patch what can be evaluated in memory (see above), never infinite
  queries, and never search results. Everything else is refreshed after the mutation.
- **Typed results come from an overlay**: oRPC v2 clients aren't generic, so `createZenStackClient`
  / `createZenStackQueryUtils` type them (an identity at runtime). The router's own types use
  default results.

**Files**

- **Database cascades** are read before the delete, one query per affected model, in the
  deleting transaction: deleting a record with huge cascades (a tenant...) reads all their keys.
  Leave `cleanup` off there, and delete the storage prefix instead.
- **Direct uploads** bind a `confirm` to the key returned by `presign`, an unguessable UUID, not
  to the user who asked for it. Keep keys private, and expire unconfirmed uploads with a bucket
  lifecycle rule.

**ZenStack**

- **Custom procedures** (`procedure` in ZModel) aren't exposed: write oRPC procedures instead.
- **`///` comments** aren't part of ZenStack's runtime schema: pass the generated `docs` to the
  REST router to use them.

## Notes

- The generated router's own types use default results, which keeps type-checking fast on large
  schemas. Inferred results live in the client overlay. A 40-model chained schema is part of the
  type tests.
- `@zenstackhq/client-helpers` (cache invalidation and optimistic updates) is bundled into
  `zenstack-orpc/tanstack-query` without its bare `import "@zenstackhq/orm"`, so browser bundles
  don't get the ORM.

## Development

```bash
bun run test            # SQLite
bun run test:postgres   # Postgres (PGlite, in-process)
bun run generate        # regenerate test fixtures after changing tests/fixtures/**/*.zmodel
```
