import { createORPCClient, RPCSerializer } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { MemoryPublisher } from '@orpc/publisher/memory'
import { createRouterClient, os, type RouterClient } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import Decimal from 'decimal.js'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type ChangeBatch,
  createMemoryStorage,
  createZenStackRouter,
  queryTopics,
  type ZenStackChangeEvents,
  zenstackFiles,
  zenstackLive,
  zenstackSerializerHandlers,
} from '../src'
import { createZenStackClient } from '../src/client'
import { createTestDb, schema } from './setup'

const storage = createMemoryStorage()
const base = os.$context<{ db: any }>()
const router = createZenStackRouter(schema, { base, getDb: (ctx) => ctx.db, files: { storage } })

let setup: Awaited<ReturnType<typeof createTestDb>>
let alice: { id: string }
let bob: { id: string }

beforeEach(async () => {
  storage.files.clear()
  setup = await createTestDb([zenstackFiles(schema, storage)])
  alice = await setup.db.user.create({ data: { email: 'alice@example.com', name: 'Alice' } })
  bob = await setup.db.user.create({ data: { email: 'bob@example.com', name: 'Bob' } })
})

function clientFor(userId: string): RouterClient<typeof router> {
  return createRouterClient(router, { context: { db: setup.authDb.$setAuth({ id: userId }) } })
}

/** A typed client going through the real RPC protocol (with the ZenStack serializer). */
function rpcClientFor(userId: string) {
  const serializer = new RPCSerializer({ handlers: zenstackSerializerHandlers({ Decimal }) })
  const handler = new RPCHandler(router, { serializer })
  const link = new RPCLink({
    origin: 'http://localhost',
    url: '/rpc',
    serializer,
    fetch: async (url, init) => {
      const { response } = await handler.handle(new Request(url, init), {
        prefix: '/rpc',
        context: { db: setup.authDb.$setAuth({ id: userId }) },
      })
      return response ?? new Response('Not found', { status: 404 })
    },
  })
  return createZenStackClient(createORPCClient<RouterClient<typeof router>>(link), {
    schema,
    path: '',
  })
}

describe('field types', () => {
  it('round-trips typed JSON, Json, Decimal and Bytes over RPC', async () => {
    const client = rpcClientFor(alice.id)
    const updated = await client.user.update({
      where: { id: alice.id },
      data: {
        address: { street: '1 rue de la Paix', city: 'Paris' },
        settings: { theme: 'dark', tags: ['a', 1, null] },
        balance: new Decimal('12.34'),
        secret: new Uint8Array([1, 2, 255]),
      },
      omit: { secret: false },
    })
    expect(updated.address).toEqual({ street: '1 rue de la Paix', city: 'Paris' })
    expect(updated.settings).toEqual({ theme: 'dark', tags: ['a', 1, null] })
    expect(updated.balance).toBeInstanceOf(Decimal)
    expect(String(updated.balance)).toBe('12.34')
    expect(updated.secret).toEqual(new Uint8Array([1, 2, 255]))

    // Typed JSON filters.
    const inParis = await client.user.findMany({ where: { address: { is: { city: 'Paris' } } } })
    expect(inParis.map((user) => user.id)).toEqual([alice.id])

    // Invalid typed JSON is rejected by the input schema.
    await expect(
      client.user.update({ where: { id: alice.id }, data: { address: { city: 1 } as any } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('leaves out @omit fields unless asked for, and returns @computed fields', async () => {
    const client = clientFor(alice.id)
    await setup.db.user.update({ where: { id: alice.id }, data: { secret: new Uint8Array([7]) } })
    await setup.db.post.create({ data: { title: 'p', authorId: alice.id } })

    const user = await client.user.findUnique({ where: { id: alice.id } })
    expect(user).not.toHaveProperty('secret')
    expect(user?.postCount).toBe(1)
    const withSecret = await client.user.findUnique({
      where: { id: alice.id },
      omit: { secret: false },
    })
    expect((withSecret as any)?.secret).toEqual(new Uint8Array([7]))

    // Computed fields can't be written.
    await expect(
      client.user.update({ where: { id: alice.id }, data: { postCount: 3 } as any }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('@@delegate models', () => {
  it('creates, reads (as a union), updates and deletes polymorphic records', async () => {
    const client = clientFor(alice.id)
    const video = await client.video.create({ data: { duration: 30 } })
    expect(video).toMatchObject({ kind: 'Video', duration: 30, ownerId: alice.id })
    await client.image.create({ data: { format: 'png' } })

    const assets = await client.asset.findMany({ orderBy: { createdAt: 'asc' } })
    expect(assets.map((asset) => asset.kind).sort()).toEqual(['Image', 'Video'])
    const first = assets.find((asset) => asset.kind === 'Video')
    expect(first).toMatchObject({ duration: 30 })

    await client.video.update({ where: { id: video.id }, data: { duration: 31 } })
    // Policies of the base model apply.
    await expect(clientFor(bob.id).video.delete({ where: { id: video.id } })).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    )
    await client.video.delete({ where: { id: video.id } })
    expect(await setup.db.asset.count()).toBe(1)
  })

  it('deletes the files of sub-models, whichever model the record is deleted from', async () => {
    const client = clientFor(alice.id)
    const put = (name: string) =>
      storage.put(new File([name], name), { model: 'Asset', field: 'f' })
    const [preview, source, preview2, source2, newSource] = await Promise.all(
      ['p', 's', 'p2', 's2', 'n'].map(put),
    )
    const video = await client.video.create({ data: { duration: 1, preview, source } })
    // Updating a sub-model field (stored in the `Video` table) cleans the previous file.
    await client.video.update({ where: { id: video.id }, data: { source: newSource } })
    expect(storage.files.has(source)).toBe(false)

    await client.video.delete({ where: { id: video.id } })
    expect(storage.files.has(preview)).toBe(false)
    expect(storage.files.has(newSource)).toBe(false)

    // From the base model: the sub-model's row goes with it, files included.
    const other = await client.video.create({
      data: { duration: 2, preview: preview2, source: source2 },
    })
    await client.asset.delete({ where: { id: other.id } })
    expect([...storage.files.keys()]).toEqual([])
  })

  it('watches every table a query reads', () => {
    expect(queryTopics(schema, 'Video', { where: { id: 'v' } })).toEqual([
      { model: 'Video', field: 'id', value: 'v' },
      { model: 'Asset', field: 'id', value: 'v' },
    ])
    // `ownerId` is stored in the `Asset` table: `Video` rows are watched as a whole.
    expect(queryTopics(schema, 'Video', { where: { ownerId: 'u' } })).toEqual([
      { model: 'Video' },
      { model: 'Asset', field: 'ownerId', value: 'u' },
    ])
    expect(queryTopics(schema, 'Asset', { where: { ownerId: 'u' } })).toEqual([
      { model: 'Asset', field: 'ownerId', value: 'u' },
      { model: 'Video' },
      { model: 'Image' },
    ])
  })

  it('notifies live queries of changes to any of their tables', async () => {
    const publisher = new MemoryPublisher<ZenStackChangeEvents>({ resume: { enabled: true } })
    const live = await createTestDb([zenstackLive(schema, publisher)])
    const owner = await live.db.user.create({ data: { email: 'carol@example.com' } })
    const liveRouter = createZenStackRouter(schema, {
      base,
      getDb: (ctx) => ctx.db,
      live: { publisher, batchWindow: 10 },
      files: { storage },
    })
    const client = createRouterClient(liveRouter, {
      context: { db: live.authDb.$setAuth({ id: owner.id }) },
    })
    const video = await client.video.create({ data: { duration: 1 } })
    const stream = await client.$changes({
      topics: queryTopics(schema, 'Video', { where: { id: video.id } }) as any,
    })
    const iterator = stream[Symbol.asyncIterator]()
    const nextBatch = iterator.next()
    await new Promise((resolve) => setTimeout(resolve, 20))

    // Only the `Asset` table changes (`preview` is inherited).
    await client.video.update({ where: { id: video.id }, data: { preview: 'x' } })
    const batch = (await nextBatch).value as ChangeBatch
    expect(batch.changes).toEqual([
      {
        model: 'Asset',
        action: 'update',
        topics: [`Asset.id=${JSON.stringify(video.id)}`],
        ids: [video.id],
      },
    ])

    // Deleting from the base model notifies the sub-model's watchers too (database cascade).
    const deleted = iterator.next()
    await client.asset.delete({ where: { id: video.id } })
    expect(((await deleted).value as ChangeBatch).changes).toEqual(
      expect.arrayContaining([
        { model: 'Video', action: 'delete', topics: [`Video.id=${JSON.stringify(video.id)}`] },
      ]),
    )
    await iterator.return?.()
  })
})

describe('views', () => {
  it('exposes read operations only', async () => {
    expect(Object.keys(router.postStats).sort()).toEqual(
      ['aggregate', 'count', 'exists', 'findFirst', 'findMany', 'findUnique', 'groupBy'].sort(),
    )
    await setup.db.post.createMany({
      data: [
        { title: 'a', authorId: alice.id },
        { title: 'b', authorId: alice.id },
      ],
    })
    const stats = await clientFor(bob.id).postStats.findMany()
    expect(stats).toEqual([{ authorId: alice.id, posts: 2 }])

    await expect(
      clientFor(alice.id).$transaction([{ model: 'PostStats', op: 'deleteMany', args: {} }] as any),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
