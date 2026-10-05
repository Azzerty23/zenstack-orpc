import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { OpenAPIGenerator } from '@orpc/openapi'
import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { createRouterClient, os } from '@orpc/server'
import { MutationObserver, QueryClient, QueryObserver } from '@tanstack/query-core'
import { ZenStackClient } from '@zenstackhq/orm'
import { PolicyPlugin } from '@zenstackhq/plugin-policy'
import { PGliteDialect } from 'kysely-pglite-dialect'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createZenStackRouter, queryTopics } from '../src'
import { createZenStackOpenAPIRouter, ZenStackJsonSchemaConverter } from '../src/openapi-entry'
import { createZenStackQueryUtils } from '../src/tanstack-query'
import { usesSearch } from '../src/tanstack-query/search'
import { schema } from './fixtures/search/zenstack/schema'

const base = os.$context<{ db: any }>()
const router = createZenStackRouter(schema, { base, getDb: (ctx) => ctx.db })
const restRouter = createZenStackOpenAPIRouter(schema, { base, getDb: (ctx) => ctx.db })

let pg: PGlite
let db: any
let authorId: string

beforeAll(async () => {
  pg = new PGlite({ extensions: { pg_trgm } })
  await pg.exec('create extension if not exists pg_trgm')
  db = new ZenStackClient(schema, { dialect: new PGliteDialect(pg) })
  await db.$pushSchema()
})

beforeEach(async () => {
  await db.article.deleteMany()
  await db.author.deleteMany()
  const author = await db.author.create({ data: { name: 'Ada' } })
  authorId = author.id
  await db.article.createMany({
    data: [
      { title: 'Hello world', body: 'The cats are sleeping', authorId },
      { title: 'Help wanted', body: 'Dogs bark at night', authorId },
      { title: 'Gardening tips', body: 'Water the plants', authorId },
    ],
  })
})

const client = (options: { slowWrites?: boolean } = {}) =>
  createRouterClient(router, {
    context: { db: db.$use(new PolicyPlugin()) },
    // Slow writes down so optimistic data can be observed.
    interceptors: options.slowWrites
      ? [
          async ({ next }) => {
            await new Promise((resolve) => setTimeout(resolve, 50))
            return next()
          },
        ]
      : [],
  })

describe('fuzzy and full-text search', () => {
  it('runs fuzzy and full-text filters and relevance ordering over RPC', async () => {
    const fuzzy = await client().article.findMany({
      where: { title: { fuzzy: { search: 'helo wrld' } } },
      orderBy: { _fuzzyRelevance: { fields: ['title'], search: 'helo wrld', sort: 'desc' } },
    })
    expect(fuzzy.map((a: any) => a.title)[0]).toBe('Hello world')
    expect(fuzzy.map((a: any) => a.title)).not.toContain('Gardening tips')

    const fullText = await client().article.findMany({
      where: { body: { fts: { search: 'cat', config: 'english' } } },
      orderBy: {
        _ftsRelevance: { fields: ['body'], search: 'cat', config: 'english', sort: 'desc' },
      },
    })
    expect(fullText.map((a: any) => a.title)).toEqual(['Hello world'])

    // Fields without `@fuzzy` are rejected by validation.
    const error = await client()
      .article.findMany({ where: { body: { fuzzy: { search: 'x' } } } } as any)
      .catch((e: any) => e)
    expect(error.code).toBe('BAD_REQUEST')
  })

  it('searches through REST, and documents search filters', async () => {
    const handler = new OpenAPIHandler(restRouter)
    const where = JSON.stringify({ body: { fts: { search: 'dog', config: 'english' } } })
    const { response } = await handler.handle(
      new Request(`http://localhost/articles?where=${encodeURIComponent(where)}`),
      { context: { db: db.$use(new PolicyPlugin()) } },
    )
    if (!response) throw new Error('No route')
    expect(response.status).toBe(200)
    expect((await response.json()).map((a: any) => a.title)).toEqual(['Help wanted'])

    const spec: any = await new OpenAPIGenerator({
      converters: [new ZenStackJsonSchemaConverter(restRouter)],
    }).generate(restRouter)
    const json = JSON.stringify(spec.components.schemas)
    expect(json).toContain('"fuzzy"')
    expect(json).toContain('"_ftsRelevance"')
  })

  it('narrows live topics with the key filters next to a search', () => {
    const args = { where: { authorId: 'a', title: { fuzzy: { search: 'hello' } } } }
    expect(queryTopics(schema, 'Article', args)).toEqual([
      { model: 'Article', field: 'authorId', value: 'a' },
    ])
  })

  it("doesn't patch search results optimistically", async () => {
    expect(usesSearch({ where: { title: { fuzzy: { search: 'x' } } } })).toBe(true)
    expect(usesSearch({ include: { articles: { orderBy: { _ftsRelevance: {} } } } })).toBe(true)
    expect(usesSearch({ where: { title: { contains: 'x' } } })).toBe(false)

    const queryClient = new QueryClient()
    const orpc = createZenStackQueryUtils(client({ slowWrites: true }), {
      schema,
      path: '',
      optimistic: true,
    })
    const observe = (options: any) => {
      const observer = new QueryObserver<any, any, any, any, any>(queryClient, options)
      observer.subscribe(() => {})
      return observer
    }
    const all = observe(
      orpc.article.findMany.queryOptions({ input: { orderBy: { title: 'asc' } } }),
    )
    const search = observe(
      orpc.article.findMany.queryOptions({
        input: { where: { title: { fuzzy: { search: 'hello' } } } },
      }),
    )
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
      expect(check()).toBe(true)
    }
    await until(() => all.getCurrentResult().isSuccess && search.getCurrentResult().isSuccess)
    const searchUpdates = search.getCurrentQuery().state.dataUpdateCount

    const pending = new MutationObserver<any, any, any, any>(
      queryClient,
      orpc.article.create.mutationOptions(),
    ).mutate({ data: { title: 'Unrelated', body: 'nothing', authorId } })
    // Plain lists get the optimistic record; search results don't (it doesn't match).
    await until(() => all.getCurrentResult().data?.some((a: any) => a.$optimistic))
    expect(search.getCurrentResult().data?.some((a: any) => a.$optimistic)).toBe(false)
    await pending
    // Both are refreshed after the mutation.
    await until(() => search.getCurrentQuery().state.dataUpdateCount > searchUpdates)
    expect(search.getCurrentResult().data.map((a: any) => a.title)).toEqual(['Hello world'])
    queryClient.clear()
  })
})
