import { createORPCClient } from '@orpc/client'
import type { RouterClient } from '@orpc/server'
import { os } from '@orpc/server'
import { describe, expectTypeOf, it } from 'vitest'
import { createZenStackRouter } from '../src'
import {
  createZenStackClient,
  txRef,
  typedClient,
  type WithClient,
  type WithZenStack,
} from '../src/client'
import { createZenStackQueryUtils, type WithQueryUtils } from '../src/tanstack-query'
import { fileFields } from './fixtures/zenstack/orpc'
import { type SchemaType, schema } from './fixtures/zenstack/schema'

const base = os.$context<{ db: any }>()
const zen = createZenStackRouter(schema, {
  base,
  getDb: (ctx) => ctx.db,
  live: { publisher: null as any },
  files: { storage: null as any },
})
const appRouter = base.router({ db: zen, health: base.handler(() => 'ok' as const) })
type AppRouterClient = RouterClient<typeof appRouter>

const raw = createORPCClient<AppRouterClient>(null as any)
const client = createZenStackClient(raw, { schema, path: 'db', files: fileFields })

describe('server router types', () => {
  it('nests and keeps default results', () => {
    expectTypeOf<Awaited<ReturnType<AppRouterClient['db']['post']['findMany']>>>().toEqualTypeOf<
      {
        id: string
        title: string
        content: string | null
        published: boolean
        views: number
        createdAt: Date
        updatedAt: Date
        authorId: string
        cover: string | null
        archive: string | null
      }[]
    >()
    expectTypeOf<
      Awaited<ReturnType<AppRouterClient['db']['todo']['count']>>
    >().toEqualTypeOf<number>()
    expectTypeOf<Awaited<ReturnType<AppRouterClient['health']>>>().toEqualTypeOf<'ok'>()
  })
})

describe('createZenStackClient', () => {
  it('infers results from select / include / omit', async () => {
    const withAuthor = await client.db.post.findMany({
      include: { author: { select: { name: true } } },
    })
    expectTypeOf(withAuthor[0].author).toEqualTypeOf<{ name: string | null }>()
    expectTypeOf(withAuthor[0].title).toEqualTypeOf<string>()

    const selected = await client.db.user.findUnique({
      where: { id: '1' },
      select: { email: true, posts: true },
    })
    expectTypeOf(selected).toEqualTypeOf<{ email: string; posts: SchemaPost[] } | null>()

    const omitted = await client.db.post.findFirst({ omit: { content: true } })
    expectTypeOf(omitted).not.toHaveProperty('content')

    const counted = await client.db.user.findMany({
      include: { _count: { select: { posts: true } } },
    })
    expectTypeOf(counted[0]._count).toEqualTypeOf<{ posts: number }>()

    const created = await client.db.post.create({ data: { title: 't' }, select: { id: true } })
    expectTypeOf(created).toEqualTypeOf<{ id: string }>()

    expectTypeOf(await client.db.todo.findMany()).toEqualTypeOf<
      { id: number; title: string; done: boolean; ownerId: string }[]
    >()
    expectTypeOf(await client.db.todo.exists()).toEqualTypeOf<boolean>()
    expectTypeOf(await client.db.todo.updateMany({ data: { done: true } })).toEqualTypeOf<{
      count: number
    }>()
  })

  it('rejects unknown keys', () => {
    // @ts-expect-error unknown select field
    client.db.post.findMany({ select: { nope: true } })
    // @ts-expect-error unknown nested include field
    client.db.user.findMany({ include: { posts: { select: { nope: true } } } })
    // @ts-expect-error unknown omit field
    client.db.post.findMany({ omit: { nope: true } })
    // @ts-expect-error unknown top-level arg
    client.db.post.findMany({ nope: 1 })
    // @ts-expect-error findUnique requires input
    client.db.post.findUnique()
  })

  it('types @file procedures and $transaction', async () => {
    expectTypeOf(await client.db.post.cover.get({ where: { id: '1' } })).toEqualTypeOf<File>()
    expectTypeOf(client.db.post.cover.upload).parameter(0).toHaveProperty('file')
    // @ts-expect-error Todo has no @file field
    client.db.todo.cover
    client.db.$transaction([{ model: 'Todo', op: 'create', args: { data: { title: 'x' } } }])
    // @ts-expect-error invalid args for the operation
    client.db.$transaction([{ model: 'Todo', op: 'create', args: { data: { nope: 1 } } }])
  })

  it('supports composable types', () => {
    type Zen = WithZenStack<SchemaType, 'db', typeof fileFields>
    const typed = typedClient<WithClient<Zen>>()(raw)
    expectTypeOf(typed.health).toEqualTypeOf(raw.health)
    expectTypeOf(typed.db.post.findMany).toEqualTypeOf(client.db.post.findMany)
  })
})

describe('createZenStackQueryUtils', () => {
  const orpc = createZenStackQueryUtils(raw, { schema, path: 'db', files: fileFields })

  it('infers query data from input', () => {
    const options = orpc.db.post.findMany.queryOptions({ input: { include: { author: true } } })
    type Data = Awaited<ReturnType<typeof options.queryFn>>
    expectTypeOf<Data[number]['author']['email']>().toEqualTypeOf<string>()

    const live = orpc.db.todo.findMany.liveOptions({ input: { select: { title: true } } })
    expectTypeOf<Awaited<ReturnType<typeof live.queryFn>>>().toEqualTypeOf<
      { title: string; $optimistic?: boolean }[]
    >()

    const noInput = orpc.db.todo.count.queryOptions()
    expectTypeOf<Awaited<ReturnType<typeof noInput.queryFn>>>().toEqualTypeOf<number>()

    // @ts-expect-error unknown select field
    orpc.db.post.findMany.queryOptions({ input: { select: { nope: true } } })
  })

  it('types infinite queries and mutations', () => {
    const infinite = orpc.db.post.findMany.infiniteOptions({
      input: (cursor: string | undefined) => ({
        take: 10,
        cursor: cursor ? { id: cursor } : undefined,
        select: { id: true },
      }),
      initialPageParam: undefined,
      getNextPageParam: (last) => last.at(-1)?.id,
    })
    expectTypeOf(infinite.queryKey).not.toBeAny()

    // `findMany` pages from its `take`, live or not.
    const paged = orpc.db.post.findMany.infiniteOptions({
      input: { take: 10, select: { id: true, title: true } },
      live: { throttle: 1000 },
      select: (data) => data.pages.flat(),
    })
    expectTypeOf(paged.select).returns.toEqualTypeOf<{ id: string; title: string }[]>()
    orpc.db.post.findMany.infiniteOptions({ input: { take: 10 }, pagination: 'offset', live: true })
    // @ts-expect-error `take` (the page size) is required
    orpc.db.post.findMany.infiniteOptions({ input: { where: { published: true } } })
    // @ts-expect-error only `findMany` pages automatically
    orpc.db.post.findFirst.infiniteOptions({ input: { take: 10 } })

    const mutation = orpc.db.post.create.mutationOptions<{
      data: { title: string }
      select: { id: true }
    }>({
      onSuccess: (data) => {
        expectTypeOf(data).toEqualTypeOf<{ id: string }>()
      },
    })
    expectTypeOf(mutation.mutationFn).not.toBeAny()
    expectTypeOf(orpc.db.post.key).toBeFunction()
    expectTypeOf(orpc.health.queryOptions).toBeFunction()
  })

  it('supports composable types', () => {
    type Zen = WithZenStack<SchemaType, 'db', typeof fileFields>
    const typed = typedClient<WithQueryUtils<Zen>>()(
      createZenStackQueryUtils(raw, { schema, path: 'db' }),
    )
    expectTypeOf(typed.db.post.findMany.queryOptions).toEqualTypeOf(
      orpc.db.post.findMany.queryOptions,
    )
  })
})

type SchemaPost = Awaited<ReturnType<AppRouterClient['db']['post']['findMany']>>[number]

describe('ZenStack features', () => {
  it('types typed JSON, Decimal, Bytes, @omit and @computed fields', async () => {
    const user = await client.db.user.findUnique({ where: { id: 'u' } })
    type User = NonNullable<typeof user>
    type Address = NonNullable<User['address']>
    expectTypeOf<Address['city']>().toEqualTypeOf<string>()
    expectTypeOf<Address['zip']>().toEqualTypeOf<string | null | undefined>()
    expectTypeOf<User['address']>().toBeNullable()
    expectTypeOf<User['postCount']>().toEqualTypeOf<number>()
    expectTypeOf<User['balance']>().toEqualTypeOf<import('decimal.js').default>()
    // `@omit`: left out unless asked for.
    expectTypeOf<User>().not.toHaveProperty('secret')
    const withSecret = await client.db.user.findUnique({
      where: { id: 'u' },
      omit: { secret: false, email: true },
    })
    type WithSecret = NonNullable<typeof withSecret>
    expectTypeOf<WithSecret['secret']>().toEqualTypeOf<Uint8Array | null>()
    expectTypeOf<WithSecret>().not.toHaveProperty('email')
  })

  it('types @@delegate results as a union of the sub-models', async () => {
    const assets = await client.db.asset.findMany()
    const asset = assets[0]
    expectTypeOf(asset.kind).toEqualTypeOf<'Video' | 'Image'>()
    if (asset.kind === 'Video') expectTypeOf(asset.duration).toEqualTypeOf<number>()
    if (asset.kind === 'Image') expectTypeOf(asset.format).toEqualTypeOf<string>()
    const video = await client.db.video.create({ data: { duration: 1 } })
    expectTypeOf(video.preview).toEqualTypeOf<string | null>()
    expectTypeOf(video.kind).toEqualTypeOf<string>()
    expectTypeOf<Awaited<ReturnType<AppRouterClient['db']['asset']['findFirst']>>>().toEqualTypeOf<
      typeof asset | null
    >()
  })

  it('exposes read operations only for views', () => {
    expectTypeOf(client.db.postStats).toHaveProperty('findMany')
    expectTypeOf(client.db.postStats).not.toHaveProperty('create')
    expectTypeOf(zen.postStats).not.toHaveProperty('deleteMany')
  })
})

describe('files and transactions', () => {
  it('types file procedures', async () => {
    const { url, expiresAt } = await client.db.user.avatar.url({ where: { id: 'u' } })
    expectTypeOf(url).toEqualTypeOf<string>()
    expectTypeOf(expiresAt).toEqualTypeOf<Date>()
    const upload = await client.db.user.avatar.presign({
      where: { id: 'u' },
      name: 'a.png',
      type: 'image/png',
      size: 1,
    })
    expectTypeOf(upload.headers).toEqualTypeOf<Record<string, string>>()
    const saved = await client.db.user.avatar.confirm({ where: { id: 'u' }, key: upload.key })
    expectTypeOf(saved.avatar).toEqualTypeOf<string | null>()
    // Single-file fields don't take a key.
    // @ts-expect-error
    await client.db.user.avatar.get({ where: { id: 'u' }, key: 'k' })
  })

  it('types transaction callbacks', async () => {
    const result = await client.db.$transaction((tx) => {
      const post = tx.post.create({ data: { title: 'x' }, include: { author: true } })
      expectTypeOf(post.id).toEqualTypeOf<string>()
      tx.attachment.create({ data: { postId: post.id } })
      // @ts-expect-error unknown field
      tx.todo.create({ data: { nope: 1 } })
      // @ts-expect-error views are read-only
      tx.postStats.create
      return { post, count: tx.todo.count() }
    })
    expectTypeOf(result.post.author.email).toEqualTypeOf<string>()
    expectTypeOf(result.count).toEqualTypeOf<number>()
    expectTypeOf(await client.db.$transaction(() => {})).toEqualTypeOf<void>()
    expectTypeOf(await client.db.$transaction([{ model: 'Todo', op: 'count' }])).toEqualTypeOf<
      unknown[]
    >()
    // @ts-expect-error the callback must be synchronous
    await client.db.$transaction(async (tx) => tx.todo.count())

    const utils = createZenStackQueryUtils(raw, { schema, path: 'db' })
    utils.db.$transaction.mutationOptions().mutationFn?.((tx) => {
      tx.todo.create({ data: { title: 'x' } })
    }, {} as any)
    expectTypeOf(await utils.db.$transaction.call((tx) => tx.todo.count())).toEqualTypeOf<number>()
  })

  it('accepts txRef in transaction steps', async () => {
    await client.db.$transaction([
      { model: 'Post', op: 'create', args: { data: { title: 'Hello' } } },
      { model: 'Attachment', op: 'create', args: { data: { postId: txRef<string>(0, 'id') } } },
    ])
  })
})
