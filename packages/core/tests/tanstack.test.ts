import { MemoryPublisher } from '@orpc/publisher/memory'
import { createRouterClient, os } from '@orpc/server'
import {
  dehydrate,
  hydrate,
  InfiniteQueryObserver,
  MutationObserver,
  QueryClient,
  QueryObserver,
} from '@tanstack/query-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createMemoryStorage,
  createZenStackRouter,
  type ZenStackChangeEvents,
  zenstackLive,
} from '../src'
import { connectLive, createZenStackQueryUtils, zenstackHydration } from '../src/tanstack-query'
import { fileFields } from './fixtures/zenstack/orpc'
import { createTestDb, schema } from './setup'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('Timed out')
    await wait(10)
  }
}

let ctx: Awaited<ReturnType<typeof setup>>
let queryClient: QueryClient
const unsubscribers: (() => void)[] = []

async function setup(options: { optimistic?: boolean; withAuth?: boolean; live?: false } = {}) {
  const publisher = new MemoryPublisher<ZenStackChangeEvents>({ resume: { enabled: true } })
  const { db, authDb } = await createTestDb([zenstackLive(schema, publisher)])
  const alice = await db.user.create({ data: { email: 'alice@example.com', name: 'Alice' } })
  const base = os.$context<{ db: any }>()
  const router = base.router({
    db: createZenStackRouter(schema, {
      base,
      getDb: (c) => c.db,
      live: { publisher, batchWindow: 10 },
      files: { storage: createMemoryStorage() },
    }),
  })
  // Slow down mutations a bit so optimistic data can be observed.
  const calls = { changes: 0, findMany: 0 }
  const client = createRouterClient(router, {
    context: { db: authDb.$setAuth({ id: alice.id }) },
    interceptors: [
      async ({ next, path }) => {
        if (path.at(-1) === '$changes') calls.changes++
        if (path.at(-1) === 'findMany') calls.findMany++
        if (path.at(-1) !== '$changes' && /create|update|delete/.test(path.at(-1) ?? ''))
          await wait(30)
        return next()
      },
    ],
  })
  const { withAuth, ...utilsOptions } = options
  const orpc = createZenStackQueryUtils(client, {
    schema,
    path: 'db',
    files: fileFields,
    live: options.live ?? { debounce: 10 },
    // The current user, as seen by `auth()` (e.g. the better-auth session user).
    auth: withAuth ? () => alice : undefined,
    ...utilsOptions,
  })
  return { db, alice, client, orpc, calls }
}

function observe(options: any): QueryObserver<any, any, any, any, any> {
  const observer = new QueryObserver<any, any, any, any, any>(queryClient, options)
  unsubscribers.push(observer.subscribe(() => {}))
  return observer
}

function mutate(options: any, variables: unknown): Promise<any> {
  return new MutationObserver<any, any, any, any>(queryClient, options).mutate(variables)
}

beforeEach(() => {
  queryClient = new QueryClient()
})
afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
  queryClient.clear()
})

describe('createZenStackQueryUtils', () => {
  it('builds oRPC query keys with ZenStack args', async () => {
    ctx = await setup()
    const options = ctx.orpc.db.post.findMany.queryOptions({
      input: { where: { published: true } },
    })
    expect(options.queryKey).toEqual([
      ['db', 'post', 'findMany'],
      { type: 'query', input: { where: { published: true } } },
    ])
    expect(await queryClient.fetchQuery(options)).toEqual([])
  })

  it('invalidates queries of mutated and related models', async () => {
    ctx = await setup()
    const users = observe(
      ctx.orpc.db.user.findMany.queryOptions({ input: { include: { posts: true } } }),
    )
    const todos = observe(ctx.orpc.db.todo.findMany.queryOptions())
    await until(() => users.getCurrentResult().isSuccess && todos.getCurrentResult().isSuccess)
    const todosFetches = todos.getCurrentQuery().state.dataUpdateCount

    await mutate(ctx.orpc.db.post.create.mutationOptions(), { data: { title: 'Hello' } })
    // `user.findMany` includes posts: it's refetched.
    await until(() => users.getCurrentResult().data?.[0].posts.length === 1)
    // `todo.findMany` doesn't read posts: untouched.
    expect(todos.getCurrentQuery().state.dataUpdateCount).toBe(todosFetches)
  })

  it('invalidates after @file writes', async () => {
    ctx = await setup()
    const post = await ctx.db.post.create({ data: { title: 'p', authorId: ctx.alice.id } })
    const posts = observe(ctx.orpc.db.post.findMany.queryOptions())
    await until(() => posts.getCurrentResult().data?.length === 1)
    const where = { id: post.id }
    await mutate(ctx.orpc.db.post.cover.upload.mutationOptions(), {
      where,
      file: new File(['x'], 'a.png', { type: 'image/png' }),
    })
    await until(() => !!posts.getCurrentResult().data?.[0].cover)
    await mutate(ctx.orpc.db.post.cover.remove.mutationOptions(), { where })
    await until(() => posts.getCurrentResult().data?.[0].cover === null)
  })

  it('invalidates after $transaction mutations', async () => {
    ctx = await setup()
    const count = observe(ctx.orpc.db.todo.count.queryOptions())
    await until(() => count.getCurrentResult().data === 0)
    await mutate(ctx.orpc.db.$transaction.mutationOptions(), [
      { model: 'Todo', op: 'create', args: { data: { title: 'a' } } },
    ])
    await until(() => count.getCurrentResult().data === 1)
  })

  it('records $transaction callbacks and invalidates their steps', async () => {
    ctx = await setup()
    const count = observe(ctx.orpc.db.todo.count.queryOptions())
    await until(() => count.getCurrentResult().data === 0)
    const title = await mutate(ctx.orpc.db.$transaction.mutationOptions(), (tx: any) => {
      const todo = tx.todo.create({ data: { title: 'a' } })
      return tx.todo.update({ where: { id: todo.id }, data: { title: 'b' } }).title
    })
    expect(title).toBe('b')
    await until(() => count.getCurrentResult().data === 1)
    // `call` takes callbacks too.
    expect(await ctx.orpc.db.$transaction.call((tx) => tx.todo.count())).toBe(1)
  })

  it('applies optimistic updates and rolls back on error', async () => {
    ctx = await setup({ optimistic: true })
    const todos = observe(ctx.orpc.db.todo.findMany.queryOptions())
    await until(() => todos.getCurrentResult().isSuccess)

    const pending = mutate(ctx.orpc.db.todo.create.mutationOptions(), {
      data: { title: 'optimistic' },
    })
    await until(() => todos.getCurrentResult().data?.length === 1)
    expect(todos.getCurrentResult().data?.[0]).toMatchObject({
      title: 'optimistic',
      $optimistic: true,
    })
    await pending
    await until(() => todos.getCurrentResult().data?.[0]?.$optimistic === undefined)
    const [created] = todos.getCurrentResult().data ?? []

    // Failing update: optimistic data is rolled back.
    const failing = mutate(ctx.orpc.db.todo.update.mutationOptions(), {
      where: { id: created.id },
      data: { title: 'x'.repeat(10), ownerId: 'someone-else' },
    }).catch((e) => e)
    await until(() => todos.getCurrentResult().data?.[0]?.title === 'x'.repeat(10))
    expect((await failing).code).toBeDefined()
    await until(() => todos.getCurrentResult().data?.[0]?.title === 'optimistic')
  })

  it("applies optimistic records to the queries they match, where they're sorted", async () => {
    ctx = await setup({ optimistic: true, withAuth: true })
    for (const title of ['a', 'c', 'e']) {
      await ctx.db.todo.create({ data: { title, ownerId: ctx.alice.id } })
    }
    const titles = (observer: QueryObserver<any, any, any, any, any>) =>
      observer.getCurrentResult().data?.map((todo: any) => todo.title)
    const open = observe(
      ctx.orpc.db.todo.findMany.queryOptions({
        input: { where: { done: false }, orderBy: { title: 'asc' } },
      }),
    )
    const top2 = observe(
      ctx.orpc.db.todo.findMany.queryOptions({ input: { orderBy: { title: 'asc' }, take: 2 } }),
    )
    const done = observe(
      ctx.orpc.db.todo.findMany.queryOptions({ input: { where: { done: true } } }),
    )
    const page2 = observe(
      ctx.orpc.db.todo.findMany.queryOptions({ input: { orderBy: { title: 'asc' }, skip: 2 } }),
    )
    const byOwner = observe(
      ctx.orpc.db.todo.findMany.queryOptions({
        input: { where: { owner: { is: { id: ctx.alice.id } } } },
      }),
    )
    const all = [open, top2, done, page2, byOwner]
    await until(() => all.every((observer) => observer.getCurrentResult().isSuccess))

    const creating = mutate(ctx.orpc.db.todo.create.mutationOptions(), { data: { title: 'b' } })
    // `done` defaults to false: inserted in order, and the first page is cut back to `take`.
    await until(() => titles(open)?.join() === 'a,b,c,e')
    expect(titles(top2)).toEqual(['a', 'b'])
    // Not matching, a later page, or a filter it can't evaluate: left to the refetch.
    expect(titles(done)).toEqual([])
    expect(titles(page2)).toEqual(['e'])
    expect(byOwner.getCurrentResult().data.some((todo: any) => todo.$optimistic)).toBe(false)
    await creating
    await until(() => titles(page2)?.join() === 'c,e')

    // An update making a record leave a filtered list removes it right away.
    const [a] = open.getCurrentResult().data
    const updating = mutate(ctx.orpc.db.todo.update.mutationOptions(), {
      where: { id: a.id },
      data: { done: true },
    })
    await until(() => titles(open)?.join() === 'b,c,e')
    await updating
    await until(() => titles(done)?.join() === 'a')
  })

  it('completes optimistic records with auth() defaults and included relations', async () => {
    ctx = await setup({ optimistic: true, withAuth: true })
    const posts = observe(
      ctx.orpc.db.post.findMany.queryOptions({
        input: { include: { author: { select: { name: true } } } },
      }),
    )
    await until(() => posts.getCurrentResult().isSuccess)

    const pending = mutate(ctx.orpc.db.post.create.mutationOptions(), {
      data: { title: 'Optimistic' },
    })
    await until(() => posts.getCurrentResult().data?.length === 1)
    expect(posts.getCurrentResult().data?.[0]).toMatchObject({
      title: 'Optimistic',
      authorId: ctx.alice.id, // @default(auth().id)
      author: { name: 'Alice' }, // resolved from auth
      $optimistic: true,
    })
    await pending
    await until(() => posts.getCurrentResult().data?.[0]?.$optimistic === undefined)
  })

  it('skips optimistic updates that would produce incomplete data', async () => {
    ctx = await setup({ optimistic: true })
    const posts = observe(
      ctx.orpc.db.post.findMany.queryOptions({ input: { include: { author: true } } }),
    )
    const todos = observe(ctx.orpc.db.todo.findMany.queryOptions())
    await until(() => posts.getCurrentResult().isSuccess && todos.getCurrentResult().isSuccess)

    // Without `auth`, the post's author is unknown: that query isn't patched...
    const pending = mutate(ctx.orpc.db.post.create.mutationOptions(), {
      data: { title: 'No author yet' },
    })
    await wait(10)
    expect(posts.getCurrentResult().data).toEqual([])
    // ...and gets the server data after the mutation.
    await pending
    await until(() => posts.getCurrentResult().data?.[0]?.author?.name === 'Alice')
  })

  it('prefetches on the server and hydrates in the browser', async () => {
    ctx = await setup()
    await ctx.db.post.create({ data: { title: 'SSR', authorId: ctx.alice.id } })
    const hydration = zenstackHydration()
    const options = ctx.orpc.db.post.findMany.liveOptions({ input: { include: { author: true } } })

    // Server: a QueryClient per request, prefetching through the server-side client.
    const serverClient = new QueryClient({ defaultOptions: hydration })
    await serverClient.prefetchQuery(options)
    const state = JSON.parse(JSON.stringify(dehydrate(serverClient)))
    await wait(100)
    // Nothing observes queries on the server: no `$changes` stream is opened.
    expect(ctx.calls.changes).toBe(0)

    // Browser: hydrated data keeps its types, and isn't fetched again.
    hydrate(queryClient, state, { defaultOptions: hydration.hydrate })
    const posts = queryClient.getQueryData(options.queryKey) as any[]
    expect(posts[0].createdAt).toBeInstanceOf(Date)
    expect(posts[0].author.email).toBe('alice@example.com')
    const observer = observe({ ...options, staleTime: 60_000 })
    expect(observer.getCurrentResult().data).toBe(posts)
    expect(observer.getCurrentResult().isFetching).toBe(false)
    // Hydrated queries don't fetch: connecting the browser's QueryClient makes them live.
    const disconnect = connectLive(ctx.orpc, queryClient)
    await until(() => ctx.calls.changes === 1)
    await ctx.db.post.create({ data: { title: 'live', authorId: ctx.alice.id } })
    await until(() => observer.getCurrentResult().data?.length === 2)
    disconnect()
  })

  it('refreshes live queries from the $changes stream', async () => {
    ctx = await setup()
    const live = observe(
      ctx.orpc.db.todo.findMany.liveOptions({ input: { orderBy: { id: 'asc' } } }),
    )
    // `select` on a relation: read models must only contain models.
    const posts = observe(
      ctx.orpc.db.post.findMany.liveOptions({
        input: { include: { author: { select: { name: true } } } },
      }),
    )
    await until(() => live.getCurrentResult().isSuccess && posts.getCurrentResult().isSuccess)
    expect(live.getCurrentQuery().meta).toMatchObject({ zenstackLive: {} })
    const postFetches = posts.getCurrentQuery().state.dataUpdateCount
    await wait(100) // let the live manager subscribe

    // A write made outside oRPC (another server, a job...).
    await ctx.db.todo.create({ data: { title: 'from elsewhere', ownerId: ctx.alice.id } })
    await until(() => live.getCurrentResult().data?.length === 1)
    expect(posts.getCurrentQuery().state.dataUpdateCount).toBe(postFetches)
  })

  it('only refreshes the live queries whose topics changed', async () => {
    ctx = await setup()
    const [p1, p2] = await Promise.all(
      ['one', 'two'].map((title) =>
        ctx.db.post.create({ data: { title, authorId: ctx.alice.id } }),
      ),
    )
    const first = observe(
      ctx.orpc.db.post.findUnique.liveOptions({ input: { where: { id: p1.id } } }),
    )
    const second = observe(
      ctx.orpc.db.post.findUnique.liveOptions({ input: { where: { id: p2.id } } }),
    )
    await until(() => first.getCurrentResult().isSuccess && second.getCurrentResult().isSuccess)
    await wait(100) // let the live manager subscribe
    const secondFetches = second.getCurrentQuery().state.dataUpdateCount

    await ctx.db.post.update({ where: { id: p1.id }, data: { title: 'changed' } })
    await until(() => first.getCurrentResult().data?.title === 'changed')
    await wait(50)
    expect(second.getCurrentQuery().state.dataUpdateCount).toBe(secondFetches)
  })

  it('throttles live refetches', async () => {
    ctx = await setup()
    const todos = observe(
      ctx.orpc.db.todo.findMany.liveOptions({
        input: { where: { ownerId: ctx.alice.id } },
        throttle: 300,
      }),
    )
    await until(() => todos.getCurrentResult().isSuccess)
    expect(todos.getCurrentQuery().meta).toMatchObject({ zenstackLive: { throttle: 300 } })
    await wait(100) // let the live manager subscribe
    const fetches = () => todos.getCurrentQuery().state.dataUpdateCount
    const start = fetches()

    // The first change refetches right away...
    await ctx.db.todo.create({ data: { title: '1', ownerId: ctx.alice.id } })
    await until(() => todos.getCurrentResult().data?.length === 1)
    expect(fetches()).toBe(start + 1)

    // ...the next ones, during the window, are merged into one refetch at its end.
    for (const title of ['2', '3', '4']) {
      await ctx.db.todo.create({ data: { title, ownerId: ctx.alice.id } })
      await wait(40)
    }
    expect(todos.getCurrentResult().data).toHaveLength(1)
    await until(() => todos.getCurrentResult().data?.length === 4)
    expect(fetches()).toBe(start + 2)
  })

  it('pages findMany infinite queries from `take`', async () => {
    ctx = await setup()
    for (const title of ['a', 'b', 'c', 'd', 'e']) {
      await ctx.db.todo.create({ data: { title, ownerId: ctx.alice.id } })
    }
    const options = ctx.orpc.db.todo.findMany.infiniteOptions({
      input: { orderBy: { id: 'asc' }, take: 2 },
    })
    // The key holds the args of the first page.
    expect(options.queryKey).toEqual([
      ['db', 'todo', 'findMany'],
      { type: 'infinite', input: { orderBy: { id: 'asc' }, take: 2 } },
    ])
    const observer = new InfiniteQueryObserver<any, any, any, any, any>(queryClient, options as any)
    unsubscribers.push(observer.subscribe(() => {}))
    await until(() => observer.getCurrentResult().isSuccess)
    await observer.fetchNextPage()
    await observer.fetchNextPage()
    const pages = observer.getCurrentResult().data.pages
    expect(pages.map((page: any[]) => page.map((todo) => todo.title))).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e'],
    ])
    expect(observer.getCurrentResult().hasNextPage).toBe(false)

    // By offset.
    const byOffset = await queryClient.fetchInfiniteQuery(
      ctx.orpc.db.todo.findMany.infiniteOptions({
        input: { orderBy: { id: 'desc' }, take: 3 },
        pagination: 'offset',
      }) as any,
    )
    expect(byOffset.pageParams).toEqual([0])
    expect(
      (
        ctx.orpc.db.todo.findMany.infiniteOptions({
          input: { take: 3 },
          pagination: 'offset',
        }) as any
      ).getNextPageParam([1, 2, 3], [], 3),
    ).toBe(6)

    // Pages are cut after the id: it must be selected.
    const noId = ctx.orpc.db.todo.findMany.infiniteOptions({
      input: { select: { title: true }, take: 1 },
    }) as any
    expect(() => noId.getNextPageParam([{ title: 'a' }], [], null)).toThrow(/select the id fields/)
    expect(() => ctx.orpc.db.todo.findMany.infiniteOptions({ input: { take: 0 } } as any)).toThrow(
      /positive `take`/,
    )
  })

  it('keeps live infinite queries up to date', async () => {
    ctx = await setup()
    for (const title of ['a', 'b', 'c']) {
      await ctx.db.todo.create({ data: { title, ownerId: ctx.alice.id } })
    }
    const observer = new InfiniteQueryObserver<any, any, any, any, any>(
      queryClient,
      ctx.orpc.db.todo.findMany.infiniteOptions({
        input: { orderBy: { id: 'asc' }, take: 2 },
        live: true,
      }) as any,
    )
    unsubscribers.push(observer.subscribe(() => {}))
    await until(() => observer.getCurrentResult().isSuccess)
    await observer.fetchNextPage()
    expect(observer.getCurrentQuery().meta).toMatchObject({ zenstackLive: {} })
    await wait(100) // let the live manager subscribe

    // A write made outside oRPC: every loaded page is refetched.
    await ctx.db.todo.create({ data: { title: 'd', ownerId: ctx.alice.id } })
    await until(() => observer.getCurrentResult().data?.pages[1]?.length === 2)
    expect(
      observer.getCurrentResult().data.pages.map((page: any[]) => page.map((todo) => todo.title)),
    ).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
    expect(observer.getCurrentResult().hasNextPage).toBe(true)
  })

  it('refetches only the pages holding the records an update changed', async () => {
    ctx = await setup()
    const todos = []
    for (const title of ['a', 'b', 'c', 'd', 'e', 'f']) {
      todos.push(await ctx.db.todo.create({ data: { title, ownerId: ctx.alice.id } }))
    }
    const observer = new InfiniteQueryObserver<any, any, any, any, any>(
      queryClient,
      ctx.orpc.db.todo.findMany.infiniteOptions({
        input: { orderBy: { title: 'asc' }, take: 2 },
        live: true,
      }) as any,
    )
    unsubscribers.push(observer.subscribe(() => {}))
    const titles = () =>
      observer
        .getCurrentResult()
        .data?.pages.map((page: any[]) => page.map((t) => t.title).join(''))
    await until(() => observer.getCurrentResult().isSuccess)
    await observer.fetchNextPage()
    await observer.fetchNextPage()
    expect(titles()).toEqual(['ab', 'cd', 'ef'])
    await wait(100) // let the live manager subscribe

    // Updating `c` refetches its page only.
    let reads = ctx.calls.findMany
    await ctx.db.todo.update({ where: { id: todos[2].id }, data: { done: true } })
    await until(() => observer.getCurrentResult().data.pages[1][0].done === true)
    await wait(50)
    expect(ctx.calls.findMany - reads).toBe(1)
    expect(titles()).toEqual(['ab', 'cd', 'ef'])

    // An update moving a record to another page refetches everything.
    reads = ctx.calls.findMany
    await ctx.db.todo.update({ where: { id: todos[0].id }, data: { title: 'z' } })
    await until(() => titles()?.join() === 'bc,de,fz')
    expect(ctx.calls.findMany - reads).toBe(1 + 3)

    // So does a create.
    reads = ctx.calls.findMany
    await ctx.db.todo.create({ data: { title: 'a', ownerId: ctx.alice.id } })
    await until(() => titles()?.join() === 'ab,cd,ef')
    expect(ctx.calls.findMany - reads).toBe(3)
  })

  it('serves liveOptions as plain queries with live: false', async () => {
    ctx = await setup({ live: false })
    await ctx.db.todo.create({ data: { title: 'existing', ownerId: ctx.alice.id } })
    const todos = observe(ctx.orpc.db.todo.findMany.liveOptions())
    await until(() => todos.getCurrentResult().data?.length === 1)
    expect(todos.getCurrentQuery().meta?.zenstackLive).toBeUndefined()
    // Still refreshed by its own mutations.
    await mutate(ctx.orpc.db.todo.create.mutationOptions(), { data: { title: 'new' } })
    await until(() => todos.getCurrentResult().data?.length === 2)
  })
})

describe('@@delegate models', () => {
  it('invalidates base and sibling queries on sub-model writes', async () => {
    ctx = await setup()
    const assets = observe(ctx.orpc.db.asset.findMany.queryOptions())
    const videos = observe(ctx.orpc.db.video.findMany.queryOptions())
    const users = observe(
      ctx.orpc.db.user.findMany.queryOptions({ input: { include: { assets: true } } }),
    )
    const todos = observe(ctx.orpc.db.todo.findMany.queryOptions())
    await until(() => [assets, videos, users, todos].every((o) => o.getCurrentResult().isSuccess))
    const todosFetches = todos.getCurrentQuery().state.dataUpdateCount

    // Writing a sub-model refreshes the base model and relations to it.
    const video = await mutate(ctx.orpc.db.video.create.mutationOptions(), {
      data: { duration: 3 },
    })
    await until(() => assets.getCurrentResult().data?.length === 1)
    await until(() => videos.getCurrentResult().data?.length === 1)
    await until(() => users.getCurrentResult().data?.[0].assets.length === 1)
    expect(assets.getCurrentResult().data?.[0]).toMatchObject({ kind: 'Video', duration: 3 })

    // Writing through the base model refreshes the sub-models.
    await mutate(ctx.orpc.db.asset.delete.mutationOptions(), { where: { id: video.id } })
    await until(() => videos.getCurrentResult().data?.length === 0)
    await until(() => assets.getCurrentResult().data?.length === 0)
    expect(todos.getCurrentQuery().state.dataUpdateCount).toBe(todosFetches)
  })

  it('applies optimistic updates to delegate queries', async () => {
    ctx = await setup({ optimistic: true, withAuth: true })
    const video = await ctx.db.video.create({ data: { duration: 1, ownerId: ctx.alice.id } })
    const videos = observe(ctx.orpc.db.video.findMany.queryOptions())
    const assets = observe(ctx.orpc.db.asset.findMany.queryOptions())
    const images = observe(ctx.orpc.db.image.findMany.queryOptions())
    await until(() => [videos, assets, images].every((o) => o.getCurrentResult().isSuccess))
    const imageFetches = images.getCurrentQuery().state.dataUpdateCount

    const pending = mutate(ctx.orpc.db.video.update.mutationOptions(), {
      where: { id: video.id },
      data: { duration: 42 },
    })
    await until(() => videos.getCurrentResult().data?.[0]?.duration === 42)
    expect(videos.getCurrentResult().data?.[0].$optimistic).toBe(true)
    // Base model queries are patched too.
    expect(assets.getCurrentResult().data?.[0]).toMatchObject({ duration: 42, $optimistic: true })
    await pending
    await until(() => videos.getCurrentResult().data?.[0]?.$optimistic === undefined)
    await until(() => assets.getCurrentResult().data?.[0]?.duration === 42)
    // Sibling sub-models aren't refreshed.
    expect(images.getCurrentQuery().state.dataUpdateCount).toBe(imageFetches)

    // Failing write: rolled back.
    const failing = mutate(ctx.orpc.db.video.update.mutationOptions(), {
      where: { id: video.id },
      data: { duration: 7, ownerId: 'someone-else' },
    }).catch((e) => e)
    await until(() => videos.getCurrentResult().data?.[0]?.duration === 7)
    expect((await failing).code).toBeDefined()
    await until(() => videos.getCurrentResult().data?.[0]?.duration === 42)

    // Created sub-model records show up in base model queries, with their discriminator.
    const created = mutate(ctx.orpc.db.image.create.mutationOptions(), { data: { format: 'png' } })
    await until(() => assets.getCurrentResult().data?.length === 2)
    // Without `orderBy`, new records are added last (insertion order).
    expect(assets.getCurrentResult().data?.[1]).toMatchObject({
      kind: 'Image',
      format: 'png',
      ownerId: ctx.alice.id,
      $optimistic: true,
    })
    expect(videos.getCurrentResult().data).toHaveLength(1)
    const image = await created
    await until(() => assets.getCurrentResult().data?.every((a: any) => !a.$optimistic) ?? false)

    // Base model writes patch sub-model queries.
    await until(() => images.getCurrentResult().data?.length === 1)
    let settled = false
    const deleting = mutate(ctx.orpc.db.asset.delete.mutationOptions(), {
      where: { id: image.id },
    }).finally(() => {
      settled = true
    })
    await until(() => images.getCurrentResult().data?.length === 0)
    expect(settled).toBe(false)
    expect(assets.getCurrentResult().data).toHaveLength(1)
    await deleting
  })
})
