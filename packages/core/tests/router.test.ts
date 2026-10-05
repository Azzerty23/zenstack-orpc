import { createRouterClient, ORPCError, os, type RouterClient } from '@orpc/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { createZenStackRouter, getZenStackMeta, txRef } from '../src'
import { createZenStackClient, isZenStackError } from '../src/client'
import { skipRevalidation } from '../src/operations'
import { createTestDb, schema } from './setup'

type Ctx = { db: any }
const base = os.$context<Ctx>()
const router = createZenStackRouter(schema, {
  base,
  getDb: (ctx) => ctx.db,
  files: { storage: { put: async () => '', get: async () => null, delete: async () => {} } },
})

let setup: Awaited<ReturnType<typeof createTestDb>>
let alice: { id: string }
let bob: { id: string }

function clientFor(userId?: string): RouterClient<typeof router> {
  const db = userId ? setup.authDb.$setAuth({ id: userId }) : setup.authDb
  return createRouterClient(router, { context: { db } })
}

beforeEach(async () => {
  setup = await createTestDb()
  alice = await setup.db.user.create({ data: { email: 'alice@example.com', name: 'Alice' } })
  bob = await setup.db.user.create({ data: { email: 'bob@example.com', name: 'Bob' } })
})

describe('createZenStackRouter', () => {
  it('exposes every CRUD operation for every model', () => {
    expect(Object.keys(router)).toEqual(
      expect.arrayContaining(['user', 'profile', 'post', 'todo', 'tag', '$transaction']),
    )
    expect(Object.keys(router.post)).toEqual(
      expect.arrayContaining([
        'findMany',
        'findUnique',
        'findFirst',
        'exists',
        'count',
        'aggregate',
        'groupBy',
        'create',
        'createMany',
        'createManyAndReturn',
        'update',
        'updateMany',
        'updateManyAndReturn',
        'upsert',
        'delete',
        'deleteMany',
        'cover',
      ]),
    )
  })

  it('attaches zenstack meta to procedures', () => {
    expect(getZenStackMeta(router.post.findMany)).toEqual({ model: 'Post', operation: 'findMany' })
    expect(getZenStackMeta(router.$transaction)).toEqual({ operation: '$transaction' })
  })

  it('runs CRUD operations with access policies', async () => {
    const asAlice = clientFor(alice.id)
    const post = await asAlice.post.create({ data: { title: 'Hello', published: false } })
    expect(post).toMatchObject({ title: 'Hello', authorId: alice.id })

    const withAuthor = await asAlice.post.findUnique({
      where: { id: post.id },
      include: { author: { select: { name: true } } },
    })
    expect(withAuthor).toMatchObject({ id: post.id, author: { name: 'Alice' } })

    // Bob can't read an unpublished post of Alice.
    const asBob = clientFor(bob.id)
    expect(await asBob.post.findMany()).toEqual([])
    expect(await asBob.post.count()).toBe(0)
    expect(await asBob.post.exists({ where: { id: post.id } })).toBe(false)

    await asAlice.post.update({ where: { id: post.id }, data: { published: true } })
    expect(await asBob.post.count()).toBe(1)

    const many = await asAlice.post.createManyAndReturn({
      data: [{ title: 'A' }, { title: 'B' }],
      select: { title: true },
    })
    expect(many).toEqual([{ title: 'A' }, { title: 'B' }])
    expect(
      await asAlice.post.updateMany({ where: { title: { in: ['A', 'B'] } }, data: { views: 3 } }),
    ).toEqual({
      count: 2,
    })
    expect(await asAlice.post.aggregate({ _sum: { views: true } })).toEqual({ _sum: { views: 6 } })
    expect(
      await asAlice.post.groupBy({
        by: ['published'],
        _count: true,
        orderBy: { published: 'asc' },
      }),
    ).toEqual([
      { published: false, _count: 2 },
      { published: true, _count: 1 },
    ])
    expect(await asAlice.post.deleteMany({ where: { views: 3 } })).toEqual({ count: 2 })
    await asAlice.post.delete({ where: { id: post.id } })
    expect(await asAlice.post.findMany()).toEqual([])
  })

  it('supports compound ids and optional inputs', async () => {
    const client = clientFor(alice.id)
    await client.tag.create({ data: { name: 'ts', scope: 'lang' } })
    const tag = await client.tag.update({
      where: { name_scope: { name: 'ts', scope: 'lang' } },
      data: { label: 'TypeScript' },
    })
    expect(tag.label).toBe('TypeScript')
    expect(await client.tag.findMany()).toHaveLength(1)
  })

  it('validates inputs with ZenStack schemas (ZModel validation attributes included)', async () => {
    const client = clientFor()
    const error = await client.user.create({ data: { email: 'not-an-email' } }).catch((e) => e)
    expect(error).toBeInstanceOf(ORPCError)
    expect(error.code).toBe('BAD_REQUEST')

    const unknownField = await client.user.findMany({ where: { nope: 1 } } as any).catch((e) => e)
    expect(unknownField.code).toBe('BAD_REQUEST')
  })

  it("doesn't let the ORM validate inputs a second time", async () => {
    const db = setup.authDb.$setAuth({ id: alice.id }) as any
    expect(skipRevalidation(db, undefined).$options.validateInput).toBe(false)

    // A client restricting its inputs more than the router keeps validating them.
    const slicing = { models: { todo: { fields: { title: { excludedFilterKinds: ['Like'] } } } } }
    const sliced = db.$setOptions({ ...db.$options, slicing })
    expect(skipRevalidation(sliced, undefined)).toBe(sliced)
    const where = { title: { contains: 'a' } }
    const viaClient = await createRouterClient(router, { context: { db: sliced } })
      .todo.findMany({ where })
      .catch((e) => e)
    expect(viaClient).toBeInstanceOf(ORPCError)
    expect(viaClient.code).toBe('UNPROCESSABLE_CONTENT')

    // Unless the router validates with the same options.
    expect(skipRevalidation(sliced, { slicing }).$options.validateInput).toBe(false)
    const slicedRouter = createZenStackRouter(schema, {
      base,
      getDb: (ctx) => ctx.db,
      queryOptions: { slicing },
      models: { include: ['Todo'] },
    })
    const viaRouter = await createRouterClient(slicedRouter, { context: { db: sliced } })
      .todo.findMany({ where })
      .catch((e) => e)
    expect(viaRouter.code).toBe('BAD_REQUEST')
  })

  it('maps ORM errors to oRPC errors', async () => {
    const asBob = clientFor(bob.id)
    const notFound = await asBob.todo
      .update({ where: { id: 999 }, data: { done: true } })
      .catch((e) => e)
    expect(notFound).toBeInstanceOf(ORPCError)
    expect(notFound.code).toBe('NOT_FOUND')
    expect(notFound.data).toMatchObject({ reason: 'not-found', model: 'Todo' })

    const forbidden = await asBob.user
      .update({ where: { id: alice.id }, data: { name: 'x' } })
      .catch((e) => e)
    expect(forbidden.code).toBe('NOT_FOUND')

    const forbiddenCreate = await asBob.post
      .create({ data: { title: 'x', author: { connect: { id: alice.id } } } })
      .catch((e) => e)
    expect(forbiddenCreate.code).toBe('FORBIDDEN')
    expect(forbiddenCreate.data).toMatchObject({ reason: 'rejected-by-policy', model: 'Post' })

    const duplicate = await clientFor(bob.id)
      .user.create({ data: { email: 'bob@example.com' } })
      .catch((e) => e)
    expect(['BAD_REQUEST', 'FORBIDDEN']).toContain(duplicate.code)
  })

  it('runs sequential transactions atomically', async () => {
    const client = clientFor(alice.id)
    const results = await client.$transaction([
      { model: 'Todo', op: 'create', args: { data: { title: 'one' } } },
      { model: 'Todo', op: 'create', args: { data: { title: 'two' } } },
      { model: 'Todo', op: 'count' },
    ])
    expect(results[2]).toBe(2)

    const failed = await client
      .$transaction([
        { model: 'Todo', op: 'create', args: { data: { title: 'three' } } },
        { model: 'Todo', op: 'update', args: { where: { id: 999 }, data: { done: true } } },
      ])
      .catch((e) => e)
    expect(failed.code).toBe('NOT_FOUND')
    expect(await client.todo.count()).toBe(2)

    const invalid = await client
      .$transaction([{ model: 'User', op: 'create', args: { data: { email: 'nope' } } }])
      .catch((e) => e)
    expect(invalid.code).toBe('BAD_REQUEST')
  })

  it('references the results of earlier transaction steps', async () => {
    const client = clientFor(alice.id)
    const [post, attachment] = (await client.$transaction([
      { model: 'Post', op: 'create', args: { data: { title: 'Hello' } } },
      { model: 'Attachment', op: 'create', args: { data: { postId: txRef(0, 'id') } } },
      {
        model: 'Post',
        op: 'update',
        args: {
          where: { id: txRef(0, 'id') },
          data: { title: txRef(0, 'title') },
          include: { attachments: true },
        },
      },
    ])) as any[]
    expect(attachment.postId).toBe(post.id)

    // Unresolved references and references to later steps are rejected, and roll back.
    const unresolved = await client
      .$transaction([
        { model: 'Todo', op: 'create', args: { data: { title: 't' } } },
        { model: 'Todo', op: 'update', args: { where: { id: txRef(0, 'nope') }, data: {} } },
      ])
      .catch((e) => e)
    expect(unresolved).toMatchObject({ code: 'BAD_REQUEST', message: /doesn't resolve/ })
    expect(await client.todo.count()).toBe(0)
    const forward = await client
      .$transaction([
        { model: 'Todo', op: 'create', args: { data: { title: txRef(1, 'title') } } },
        { model: 'Todo', op: 'create', args: { data: { title: 't' } } },
      ])
      .catch((e) => e)
    expect(forward).toMatchObject({ code: 'BAD_REQUEST', message: /earlier operations/ })
    // Resolved values are validated like any input.
    const invalid = await client
      .$transaction([
        { model: 'Todo', op: 'create', args: { data: { title: 't' } } },
        { model: 'Post', op: 'create', args: { data: { title: txRef(0, 'id') } } },
      ])
      .catch((e) => e)
    expect(invalid.code).toBe('BAD_REQUEST')
    // Prototype keys never resolve.
    const proto = await client
      .$transaction([
        { model: 'Todo', op: 'create', args: { data: { title: 't' } } },
        { model: 'Todo', op: 'create', args: { data: { title: txRef(0, '__proto__') } } },
      ])
      .catch((e) => e)
    expect(proto.code).toBe('BAD_REQUEST')
  })

  it('records transaction callbacks into steps', async () => {
    const client = createZenStackClient(clientFor(alice.id), { schema, path: '' })
    const { post, attachment, count } = await client.$transaction((tx) => {
      const post = tx.post.create({ data: { title: 'Hello' } })
      const attachment = tx.attachment.create({ data: { postId: post.id } })
      tx.post.update({ where: { id: post.id }, data: { content: post.title } })
      return { post, attachment, count: tx.post.count() }
    })
    expect(attachment.postId).toBe(post.id)
    expect(count).toBe(1)
    expect(await client.post.findUnique({ where: { id: post.id } })).toMatchObject({
      content: 'Hello',
    })
    // Array results and plain values.
    const [titles, nothing] = await client.$transaction((tx) => {
      const posts = tx.post.findMany()
      return [[posts[0].title], undefined] as const
    })
    expect(titles).toEqual(['Hello'])
    expect(nothing).toBeUndefined()
    // Without operations, nothing is sent.
    expect(await client.$transaction(() => 42)).toBe(42)
    // The array form still works.
    expect(await client.$transaction([{ model: 'Post', op: 'count' }])).toEqual([1])

    // A failing step rolls everything back.
    const failed = await client
      .$transaction((tx) => {
        tx.todo.create({ data: { title: 'one' } })
        tx.todo.update({ where: { id: 999 }, data: { done: true } })
      })
      .catch((e) => e)
    expect(failed.code).toBe('NOT_FOUND')
    expect(await client.todo.count()).toBe(0)
  })

  it('rejects misused transaction placeholders', async () => {
    const client = createZenStackClient(clientFor(alice.id), { schema, path: '' })
    const misuse = (callback: (tx: any) => unknown) =>
      client.$transaction(callback as any).catch((e: Error) => e.message)

    expect(
      await misuse(async (tx) => {
        await tx.todo.create({ data: { title: 't' } })
      }),
    ).toMatch(/don't await/)
    expect(await misuse((tx) => `${tx.post.create({ data: { title: 't' } }).title}`)).toMatch(
      /step 0\.title isn't known until the transaction runs/,
    )
    expect(await misuse((tx) => ({ ...tx.post.create({ data: { title: 't' } }) }))).toMatch(
      /enumerated/,
    )
    expect(await misuse((tx) => tx.nope.create({}))).toMatch(/unknown model "nope"/)
    expect(await misuse((tx) => tx.post.nope({}))).toMatch(/unknown operation "post.nope"/)
    let leaked: any
    await client.$transaction((tx) => {
      leaked = tx.post.findMany()
    })
    expect(await misuse((tx) => tx.post.create({ data: { title: leaked[0].title } }))).toMatch(
      /another transaction/,
    )
    expect(await client.todo.count()).toBe(0)
  })

  it('translates ORM errors into typed errors', async () => {
    const error = await clientFor(bob.id)
      .post.update({ where: { id: 'missing' }, data: { title: 'x' } })
      .catch((e) => e)
    expect(isZenStackError(error)).toBe(true)
    expect(isZenStackError(error, 'not-found')).toBe(true)
    expect(isZenStackError(error, 'rejected-by-policy')).toBe(false)
    expect(isZenStackError(new Error('x'))).toBe(false)
    if (isZenStackError(error)) expect(error.data.model).toBe('Post')
  })

  it('filters models and operations', () => {
    const filtered = createZenStackRouter(schema, {
      getDb: () => null,
      models: { include: ['Post', 'Todo'] },
      operations: { exclude: ['deleteMany'] },
      transaction: false,
      files: { storage: { put: async () => '', get: async () => null, delete: async () => {} } },
    })
    expect(Object.keys(filtered).sort()).toEqual(['post', 'todo'])
    expect('deleteMany' in filtered.post).toBe(false)
    expect('$transaction' in filtered).toBe(false)
  })

  it('applies query limits', async () => {
    const limited = createZenStackRouter(schema, {
      base,
      getDb: (ctx) => ctx.db,
      limits: { maxTake: 2, maxDepth: 2, maxTransactionSteps: 2 },
      files: { storage: { put: async () => '', get: async () => null, delete: async () => {} } },
    })
    const client = createRouterClient(limited, {
      context: { db: setup.authDb.$setAuth({ id: alice.id }) },
    })
    for (const title of ['a', 'b', 'c']) {
      await setup.db.post.create({ data: { title, authorId: alice.id, published: true } })
    }

    // Default `take` (= maxTake), on findMany and on included to-many relations.
    expect(await client.post.findMany()).toHaveLength(2)
    const [user]: any[] = await client.user.findMany({
      where: { id: alice.id },
      include: { posts: true },
    })
    expect(user.posts).toHaveLength(2)

    const tooMany = await client.post.findMany({ take: 3 }).catch((e) => e)
    expect(tooMany.code).toBe('BAD_REQUEST')
    expect(tooMany.message).toBe('Post.findMany: take must not exceed 2')
    const nestedTooMany = await client.user
      .findMany({ select: { posts: { take: -5 } } })
      .catch((e) => e)
    expect(nestedTooMany.message).toBe('User.findMany.posts: take must not exceed 2')

    const tooDeep = await client.user
      .findMany({ include: { posts: { include: { author: { include: { posts: true } } } } } })
      .catch((e) => e)
    expect(tooDeep.message).toBe(
      "User.findMany.posts.author.posts: relations can't be nested more than 2 levels",
    )

    const step = { model: 'Todo' as const, op: 'count' as const }
    expect(await client.$transaction([step, step])).toEqual([0, 0])
    const tooLong = await client.$transaction([step, step, step]).catch((e) => e)
    expect(tooLong.message).toBe('$transaction: at most 2 operations')
  })
})
