import { MemoryPublisher } from '@orpc/publisher/memory'
import { createRouterClient, getEventMeta, os } from '@orpc/server'
import { describe, expect, it } from 'vitest'
import {
  batchAsyncIterable,
  type ChangeBatch,
  createZenStackRouter,
  queryTopics,
  type ZenStackChangeEvents,
  zenstackLive,
} from '../src'
import { createTestDb, schema } from './setup'

const queries: string[] = []

async function setupLive() {
  const publisher = new MemoryPublisher<ZenStackChangeEvents>({ resume: { enabled: true } })
  const { db, authDb } = await createTestDb([zenstackLive(schema, publisher)], {
    onQuery: (sql) => queries.push(sql),
  })
  const router = createZenStackRouter(schema, {
    base: os.$context<{ db: any }>(),
    getDb: (ctx) => ctx.db,
    live: { publisher, batchWindow: 20 },
    files: { storage: { put: async () => '', get: async () => null, delete: async () => {} } },
  })
  return { publisher, db, authDb, router }
}

/** Starts reading the next batch right away (the stream subscribes on its first `next()`). */
function pending(iterator: AsyncIterator<ChangeBatch>, ms = 1000) {
  const result = next(iterator, ms)
  return () => result
}

/** Reads the next batch, failing after a timeout. */
async function next(
  iterator: AsyncIterator<ChangeBatch>,
  ms = 1000,
): Promise<ChangeBatch | 'timeout'> {
  return Promise.race([
    iterator.next().then((r) => r.value as ChangeBatch),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms)),
  ])
}

describe('batchAsyncIterable', () => {
  it('groups items within the window', async () => {
    async function* source() {
      yield 1
      yield 2
      await new Promise((r) => setTimeout(r, 50))
      yield 3
    }
    const batches: number[][] = []
    for await (const batch of batchAsyncIterable(source(), 20)) batches.push(batch)
    expect(batches).toEqual([[1, 2], [3]])
  })
})

describe('live', () => {
  it('streams committed changes, including writes made outside oRPC', async () => {
    const { db, authDb, router } = await setupLive()
    const alice = await db.user.create({ data: { email: 'alice@example.com' } })
    const client = createRouterClient(router, {
      context: { db: authDb.$setAuth({ id: alice.id }) },
    })

    const controller = new AbortController()
    const iterator = await client.$changes(
      { topics: [{ model: 'Todo' }] },
      { signal: controller.signal },
    )
    const batch = pending(iterator)
    await new Promise((r) => setTimeout(r, 10))

    // Direct ORM write: not through oRPC.
    await db.todo.create({ data: { title: 'direct', ownerId: alice.id } })
    // Not subscribed.
    await db.post.create({ data: { title: 'ignored', authorId: alice.id } })

    expect(await batch()).toEqual({
      changes: [{ model: 'Todo', action: 'create', topics: ['Todo'] }],
    })
    controller.abort()
  })

  it('publishes nothing when a transaction is rolled back', async () => {
    const { db, authDb, router } = await setupLive()
    const alice = await db.user.create({ data: { email: 'alice@example.com' } })
    const client = createRouterClient(router, {
      context: { db: authDb.$setAuth({ id: alice.id }) },
    })
    const controller = new AbortController()
    const iterator = await client.$changes(
      { topics: [{ model: 'Todo' }] },
      { signal: controller.signal },
    )
    const batch = pending(iterator, 200)
    await new Promise((r) => setTimeout(r, 10))

    await db
      .$transaction(async (tx: any) => {
        await tx.todo.create({ data: { title: 'rolled back', ownerId: alice.id } })
        throw new Error('rollback')
      })
      .catch(() => {})

    expect(await batch()).toBe('timeout')
    controller.abort()
  })

  it('resumes from lastEventId', async () => {
    const { db, authDb, router } = await setupLive()
    const alice = await db.user.create({ data: { email: 'alice@example.com' } })
    const client = createRouterClient(router, {
      context: { db: authDb.$setAuth({ id: alice.id }) },
    })

    const first = new AbortController()
    const iterator = await client.$changes(
      { topics: [{ model: 'Todo' }] },
      { signal: first.signal },
    )
    const firstBatch = pending(iterator)
    await new Promise((r) => setTimeout(r, 10))
    await db.todo.create({ data: { title: 'one', ownerId: alice.id } })
    const lastEventId = getEventMeta(await firstBatch())?.id
    expect(lastEventId).toBeTypeOf('string')
    first.abort()

    // Missed while disconnected.
    await db.todo.create({ data: { title: 'two', ownerId: alice.id } })

    const second = new AbortController()
    const resumed = await client.$changes(
      { topics: [{ model: 'Todo' }] },
      { signal: second.signal, lastEventId },
    )
    expect(await next(resumed)).toEqual({
      changes: [{ model: 'Todo', action: 'create', topics: ['Todo'] }],
    })
    second.abort()
  })

  it('only notifies the subscribers of a conversation', async () => {
    // A post is a conversation, its attachments are the messages.
    const { db, authDb, router } = await setupLive()
    const alice = await db.user.create({ data: { email: 'alice@example.com' } })
    const bob = await db.user.create({ data: { email: 'bob@example.com' } })
    const bobPost = await db.post.create({ data: { title: 'bob', authorId: bob.id } })
    const alicePost = await db.post.create({ data: { title: 'alice', authorId: alice.id } })
    const asBob = createRouterClient(router, { context: { db: authDb.$setAuth({ id: bob.id }) } })
    const controller = new AbortController()
    const iterator = await asBob.$changes(
      { topics: [{ model: 'Attachment', field: 'postId', value: bobPost.id }] },
      { signal: controller.signal },
    )
    const batch = pending(iterator)
    await new Promise((r) => setTimeout(r, 10))

    // Another conversation: never sent to Bob.
    await db.attachment.create({ data: { postId: alicePost.id } })
    await db.attachment.create({ data: { postId: bobPost.id } })
    const topic = `Attachment.postId=${JSON.stringify(bobPost.id)}`
    expect(await batch()).toEqual({
      changes: [{ model: 'Attachment', action: 'create', topics: [topic] }],
    })
    controller.abort()
  })

  it('only accepts topics whose record the subscriber can read', async () => {
    const { db, authDb, router } = await setupLive()
    const alice = await db.user.create({ data: { email: 'alice@example.com' } })
    const bob = await db.user.create({ data: { email: 'bob@example.com' } })
    // Unpublished: only Alice can read it.
    const draft = await db.post.create({ data: { title: 'draft', authorId: alice.id } })
    const asBob = createRouterClient(router, { context: { db: authDb.$setAuth({ id: bob.id }) } })
    const iterator = await asBob.$changes({
      topics: [
        { model: 'Post', field: 'id', value: draft.id },
        { model: 'Attachment', field: 'postId', value: draft.id },
      ],
    })
    // Nothing left to watch: the stream ends.
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
  })

  it('checks that matched records are readable', async () => {
    const { db, authDb, router } = await setupLive()
    const alice = await db.user.create({ data: { email: 'alice@example.com' } })
    const bob = await db.user.create({ data: { email: 'bob@example.com' } })
    const asBob = createRouterClient(router, { context: { db: authDb.$setAuth({ id: bob.id }) } })
    const controller = new AbortController()
    // Users are public, so the topic is accepted, but Alice's todos are private.
    const iterator = await asBob.$changes(
      { topics: [{ model: 'Todo', field: 'ownerId', value: alice.id }, { model: 'Todo' }] },
      { signal: controller.signal },
    )
    const batch = pending(iterator)
    await new Promise((r) => setTimeout(r, 10))

    await db.todo.create({ data: { title: 'alice', ownerId: alice.id } })
    await new Promise((r) => setTimeout(r, 40))
    await db.todo.create({ data: { title: 'bob', ownerId: bob.id } })
    expect(await batch()).toEqual({
      changes: [{ model: 'Todo', action: 'create', topics: ['Todo'] }],
    })
    controller.abort()
  })

  it('only tells the ids of the updated records the subscriber can read', async () => {
    const { db, authDb, router } = await setupLive()
    const alice = await db.user.create({ data: { email: 'alice@example.com' } })
    const bob = await db.user.create({ data: { email: 'bob@example.com' } })
    const visible = await db.post.create({
      data: { title: 'public', published: true, authorId: alice.id },
    })
    await db.post.create({ data: { title: 'draft', authorId: alice.id } })
    const asBob = createRouterClient(router, { context: { db: authDb.$setAuth({ id: bob.id }) } })
    const controller = new AbortController()
    const iterator = await asBob.$changes(
      { topics: [{ model: 'Post' }] },
      { signal: controller.signal },
    )
    const batch = pending(iterator)
    await new Promise((r) => setTimeout(r, 10))

    await db.post.updateMany({ where: { authorId: alice.id }, data: { views: 1 } })
    expect(await batch()).toEqual({
      changes: [{ model: 'Post', action: 'update', topics: ['Post'], ids: [visible.id] }],
    })
    controller.abort()
  })

  it('skips the read check for @@live(checkVisibility: false) models', async () => {
    const { db, authDb, router } = await setupLive()
    const alice = await db.user.create({ data: { email: 'alice@example.com' } })
    const bob = await db.user.create({ data: { email: 'bob@example.com' } })
    const asBob = createRouterClient(router, { context: { db: authDb.$setAuth({ id: bob.id }) } })
    const controller = new AbortController()
    const iterator = await asBob.$changes(
      { topics: [{ model: 'Profile' }, { model: 'Todo' }] },
      { signal: controller.signal },
    )
    const batch = pending(iterator)
    await new Promise((r) => setTimeout(r, 10))

    queries.length = 0
    await db.profile.create({ data: { bio: 'hi', userId: alice.id } })
    expect(await batch()).toEqual({
      changes: [{ model: 'Profile', action: 'create', topics: ['Profile'] }],
    })
    // Only the write: no `select` checking that Bob can read the profile.
    expect(queries.filter((sql) => /^select/.test(sql))).toEqual([])

    // `Todo` keeps the check.
    queries.length = 0
    const todo = pending(iterator, 200)
    await db.todo.create({ data: { title: 'secret', ownerId: alice.id } })
    expect(await todo()).toBe('timeout')
    expect(queries.filter((sql) => /^select "Todo"\."id"/.test(sql))).toHaveLength(1)
    controller.abort()
  })

  it('publishes the rows changed by database cascades', async () => {
    const { db, authDb, router } = await setupLive()
    const alice = await db.user.create({ data: { email: 'alice@example.com' } })
    const post = await db.post.create({ data: { title: 'p', authorId: alice.id } })
    await db.attachment.create({ data: { postId: post.id } })
    await db.todo.create({ data: { title: 't', ownerId: alice.id } })
    const asAlice = createRouterClient(router, {
      context: { db: authDb.$setAuth({ id: alice.id }) },
    })
    const controller = new AbortController()
    const topics = [
      { model: 'Todo' as const, field: 'ownerId', value: alice.id },
      { model: 'Attachment' as const, field: 'postId', value: post.id },
    ]
    const iterator = await asAlice.$changes({ topics }, { signal: controller.signal })
    const batch = pending(iterator)
    await new Promise((r) => setTimeout(r, 10))

    // User -> Todo, and User -> Post -> Attachment: deleted by the database.
    await db.user.delete({ where: { id: alice.id } })
    expect(await batch()).toEqual({
      changes: expect.arrayContaining([
        {
          model: 'Todo',
          action: 'delete',
          topics: [`Todo.ownerId=${JSON.stringify(alice.id)}`],
        },
        {
          model: 'Attachment',
          action: 'delete',
          topics: [`Attachment.postId=${JSON.stringify(post.id)}`],
        },
      ]),
    })
    controller.abort()
  })

  it('reports publishing errors without failing the write', async () => {
    const errors: unknown[] = []
    const publisher: any = {
      publish: async () => {
        throw new Error('redis down')
      },
    }
    const { db } = await createTestDb([
      zenstackLive(schema, publisher, { onError: (error) => errors.push(error) }),
    ])
    await db.user.create({ data: { email: 'alice@example.com' } })
    expect(await db.user.count()).toBe(1)
    expect(errors).toEqual([new Error('redis down')])
  })

  it('notifies the previous and the new parent, and deleted records', async () => {
    const { db, authDb, router } = await setupLive()
    const alice = await db.user.create({ data: { email: 'alice@example.com' } })
    const [a, b] = await Promise.all(
      ['a', 'b'].map((title) => db.post.create({ data: { title, authorId: alice.id } })),
    )
    const attachment = await db.attachment.create({ data: { postId: a.id } })
    const asAlice = createRouterClient(router, {
      context: { db: authDb.$setAuth({ id: alice.id }) },
    })
    const controller = new AbortController()
    const topics: { model: 'Attachment'; field: string; value: string }[] = [
      { model: 'Attachment', field: 'postId', value: a.id },
      { model: 'Attachment', field: 'postId', value: b.id },
      { model: 'Attachment', field: 'id', value: attachment.id },
    ]
    const iterator = await asAlice.$changes({ topics }, { signal: controller.signal })
    const keys = topics.map((t) => `${t.model}.${t.field}=${JSON.stringify(t.value)}`)
    const moved = pending(iterator)
    await new Promise((r) => setTimeout(r, 10))

    await db.attachment.update({ where: { id: attachment.id }, data: { postId: b.id } })
    expect(await moved()).toEqual({
      // Updates carry the ids of the (readable) records: live infinite queries refetch their pages.
      changes: [{ model: 'Attachment', action: 'update', topics: keys, ids: [attachment.id] }],
    })

    // Deleted keys come from `DELETE ... RETURNING`.
    await db.attachment.delete({ where: { id: attachment.id } })
    expect(await next(iterator)).toEqual({
      changes: [{ model: 'Attachment', action: 'delete', topics: [keys[1], keys[2]] }],
    })
    controller.abort()
  })
})

describe('queryTopics', () => {
  const topics = (model: string, args?: unknown) =>
    queryTopics(schema, model, args).map((t) =>
      t.field ? `${t.model}.${t.field}=${t.value}` : t.model,
    )

  it('narrows queries to their id or foreign key equalities', () => {
    expect(topics('Todo')).toEqual(['Todo'])
    expect(topics('Todo', { where: { done: false } })).toEqual(['Todo'])
    expect(topics('Todo', { where: { ownerId: 'u1', done: false } })).toEqual(['Todo.ownerId=u1'])
    expect(topics('Todo', { where: { id: 3, ownerId: 'u1' } })).toEqual(['Todo.id=3'])
    expect(topics('Todo', { where: { ownerId: { in: ['a', 'b'] } } })).toEqual([
      'Todo.ownerId=a',
      'Todo.ownerId=b',
    ])
    expect(topics('Todo', { where: { AND: [{ ownerId: { equals: 'u' } }] } })).toEqual([
      'Todo.ownerId=u',
    ])
  })

  it('narrows included relations through the known keys', () => {
    expect(
      topics('Post', { where: { id: 'p' }, include: { attachments: true, author: true } }),
    ).toEqual(['Post.id=p', 'Attachment.postId=p', 'User'])
    expect(topics('Post', { where: { authorId: 'u' }, include: { author: true } })).toEqual([
      'Post.authorId=u',
      'User.id=u',
    ])
    expect(topics('Post', { where: { id: 'p' }, select: { _count: true } })).toEqual([
      'Post.id=p',
      'Attachment.postId=p',
    ])
  })
})
