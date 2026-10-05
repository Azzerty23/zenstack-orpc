import { OpenAPIGenerator } from '@orpc/openapi'
import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { os } from '@orpc/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryStorage } from '../src'
import {
  createZenStackOpenAPIRouter,
  defaultModelPath,
  ZenStackJsonSchemaConverter,
} from '../src/openapi-entry'
import { docs } from './fixtures/zenstack/orpc'
import { createTestDb, schema } from './setup'

const storage = createMemoryStorage()
const base = os.$context<{ db: any }>()
const router = createZenStackOpenAPIRouter(schema, {
  base,
  getDb: (ctx) => ctx.db,
  files: { storage },
  docs,
})
const handler = new OpenAPIHandler(router)

let setup: Awaited<ReturnType<typeof createTestDb>>
let alice: { id: string }

async function call(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method }
  if (body instanceof FormData) init.body = body
  else if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'content-type': 'application/json' }
  }
  const { response } = await handler.handle(new Request(`http://localhost/api${path}`, init), {
    prefix: '/api',
    context: { db: setup.authDb.$setAuth({ id: alice.id }) },
  })
  if (!response) throw new Error(`No route for ${method} ${path}`)
  const type = response.headers.get('content-type') ?? ''
  return { status: response.status, body: type.includes('json') ? await response.json() : response }
}

beforeEach(async () => {
  setup = await createTestDb()
  alice = await setup.db.user.create({ data: { email: 'alice@example.com', name: 'Alice' } })
})

describe('createZenStackOpenAPIRouter', () => {
  it('pluralizes model paths', () => {
    expect(defaultModelPath('Post')).toBe('posts')
    expect(defaultModelPath('Category')).toBe('categories')
    expect(defaultModelPath('BlogPost')).toBe('blog-posts')
    expect(defaultModelPath('Address')).toBe('addresses')
    expect(defaultModelPath('Status')).toBe('statuses')
    expect(defaultModelPath('PostStats')).toBe('post-stats')
  })

  it('serves RESTful CRUD routes', async () => {
    const created = await call('POST', '/posts', { data: { title: 'Hello' } })
    expect(created.status).toBe(201)
    const id = created.body.id

    const listed = await call(
      'GET',
      `/posts?where=${encodeURIComponent(JSON.stringify({ title: { startsWith: 'He' } }))}&take=5`,
    )
    expect(listed.status).toBe(200)
    expect(listed.body).toHaveLength(1)

    const found = await call(
      'GET',
      `/posts/${id}?include=${encodeURIComponent(JSON.stringify({ author: true }))}`,
    )
    expect(found.body).toMatchObject({ id, author: { name: 'Alice' } })

    const updated = await call('PATCH', `/posts/${id}`, { data: { published: true } })
    expect(updated.body.published).toBe(true)

    expect((await call('GET', '/posts/count')).body).toBe(1)
    expect(
      (await call('GET', `/posts/exists?where=${encodeURIComponent(JSON.stringify({ id }))}`)).body,
    ).toBe(true)

    const deleted = await call('DELETE', `/posts/${id}`)
    expect(deleted.status).toBe(200)
    expect((await call('GET', `/posts/${id}`)).body).toBeNull()
  })

  it('coerces numeric ids and maps errors to HTTP statuses', async () => {
    const todo = await call('POST', '/todos', { data: { title: 'Todo' } })
    expect((await call('GET', `/todos/${todo.body.id}`)).body).toMatchObject({ title: 'Todo' })
    const missing = await call('PATCH', '/todos/999', { data: { done: true } })
    expect(missing.status).toBe(404)
    // A declared error: its body matches the documented `NotFound` schema.
    expect(missing.body).toMatchObject({
      defined: true,
      code: 'NOT_FOUND',
      data: { reason: 'not-found', model: 'Todo' },
    })
    expect((await call('POST', '/users', { data: { email: 'invalid' } })).status).toBe(400)
  })

  it('uploads and downloads @file fields', async () => {
    const post = await call('POST', '/posts', { data: { title: 'With cover' } })
    const form = new FormData()
    form.set('file', new File(['png-bytes'], 'cover.png', { type: 'image/png' }))
    const uploaded = await call('PUT', `/posts/${post.body.id}/cover`, form)
    expect(uploaded.status).toBe(200)
    expect(uploaded.body.cover).toMatch(/^Post\/cover\//)

    const downloaded = await call('GET', `/posts/${post.body.id}/cover`)
    expect(downloaded.status).toBe(200)
    expect(await (downloaded.body as Response).text()).toBe('png-bytes')

    const wrongType = new FormData()
    wrongType.set('file', new File(['%PDF'], 'doc.pdf', { type: 'application/pdf' }))
    expect((await call('PUT', `/posts/${post.body.id}/cover`, wrongType)).status).toBe(400)

    const removed = await call('DELETE', `/posts/${post.body.id}/cover`)
    expect(removed.body.cover).toBeNull()
    expect(storage.files.size).toBe(0)
  })

  it('serves typed JSON, Decimal, Bytes, views and @@delegate models', async () => {
    const updated = await call('PATCH', `/users/${alice.id}`, {
      data: {
        address: { street: '1 rue de la Paix', city: 'Paris' },
        balance: '12.34',
        secret: 'AQL/',
      },
      omit: { secret: false },
    })
    expect(updated.status).toBe(200)
    expect(updated.body).toMatchObject({
      address: { street: '1 rue de la Paix', city: 'Paris' },
      balance: '12.34',
      secret: 'AQL/',
      postCount: 0,
    })

    const video = await call('POST', '/videos', { data: { duration: 3 } })
    expect(video.body).toMatchObject({ kind: 'Video', duration: 3 })
    const assets = await call('GET', '/assets')
    expect(assets.body).toEqual([expect.objectContaining({ kind: 'Video', duration: 3 })])

    expect((await call('GET', '/post-stats')).status).toBe(200)
    await expect(call('POST', '/post-stats', { data: {} })).rejects.toThrow(/No route/)
  })

  it('generates a compact OpenAPI document with named components', async () => {
    const generator = new OpenAPIGenerator({
      converters: [new ZenStackJsonSchemaConverter(router)],
    })
    const started = Date.now()
    const spec: any = await generator.generate(router, {
      base: { info: { title: 'Test', version: '1.0.0' } },
    })
    const elapsed = Date.now() - started
    const json = JSON.stringify(spec)

    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        '/posts',
        '/posts/{id}',
        '/posts/count',
        '/posts/batch',
        '/posts/{id}/cover',
      ]),
    )
    // Compound-id models don't get `/{id}` routes.
    expect(Object.keys(spec.paths)).not.toContain('/labels/{id}')

    // ZenStack schema names are reused, nothing is anonymous.
    const components = Object.keys(spec.components.schemas)
    expect(components).toEqual(
      expect.arrayContaining([
        'Post',
        'User',
        'PostWhereInput',
        'PostFindManyArgs',
        'PostFindUniqueByIdArgs',
      ]),
    )
    expect(components.filter((name) => name.startsWith('__'))).toEqual([])
    // Unnamed schemas from cycles are inlined (to-many `orderBy` of `Post.attachments`).
    const postOrderBy = spec.components.schemas.PostOrderByWithRelationInput
    expect(postOrderBy.properties.attachments.properties.post).toEqual({
      $ref: '#/components/schemas/PostOrderByWithRelationInput',
    })
    expect(json.length).toBeLessThan(800_000)
    // Loose bound (CPU-bound, runs alongside other tests): the size above is the main guard.
    // Mostly spent in oRPC's component deduplication, which grows with the number of components.
    // Skipped on CI, whose runners are too slow and uneven for a timing bound.
    if (!process.env.CI) expect(elapsed).toBeLessThan(20_000)

    // Query parameters reference named schemas.
    const list = spec.paths['/posts'].get
    const where = list.parameters.find((p: any) => p.name === 'where')
    expect(JSON.stringify(where)).toContain('#/components/schemas/PostWhereInput')
    expect(list.tags).toEqual(['Post'])
    expect(list.description).toContain('allow')

    // Error responses are documented, with shared components.
    const byId = spec.paths['/posts/{id}'].patch
    expect(Object.keys(byId.responses)).toEqual(
      expect.arrayContaining(['400', '403', '404', '422']),
    )
    expect(byId.responses['403'].content['application/json'].schema.oneOf[0]).toEqual({
      $ref: '#/components/schemas/Forbidden',
    })
    expect(spec.components.schemas.Forbidden.properties.data.properties.reason).toMatchObject({
      const: 'rejected-by-policy',
    })

    // Responses are documented.
    expect(JSON.stringify(list.responses['200'])).toContain('#/components/schemas/Post')
    const post = spec.components.schemas.Post
    expect(post.properties.title).toEqual({ type: 'string' })
    expect(post.properties.author.$ref ?? JSON.stringify(post.properties.author)).toContain('User')
  }, 60_000)

  it('documents models and fields from ZModel (`@@meta`, `@meta`, `///` comments)', async () => {
    const spec: any = await new OpenAPIGenerator({
      converters: [new ZenStackJsonSchemaConverter(router)],
    }).generate(router)
    const { schemas } = spec.components

    // `@@meta('description')` and `@meta('description')` win over `///` comments.
    expect(schemas.Todo.description).toBe('A task of its owner.')
    expect(schemas.Todo.properties.title.description).toBe('What to do')
    // `///` comments (`docs` generated in `orpc.ts`).
    expect(schemas.Attachment.description).toBe(
      "Deleted with its post (and its post's author), files included.",
    )
    expect(schemas.Post.properties.archive.description).toBe(
      'Kept in storage when the post is deleted or the field changes.',
    )
    // The type's own description is kept.
    expect(schemas.User.properties.secret.description).toBe('Bytes, base64-encoded')

    // Operations get the model description, then its policies.
    const list = spec.paths['/todos'].get
    expect(list.description).toBe('A task of its owner.\n\nAccess policies: allow `all`.')
    // `@@meta('openapi:tags')` and `@@meta('openapi:path')`.
    expect(list.tags).toEqual(['Tasks'])
    expect(Object.keys(spec.paths)).toContain('/labels')
    expect(Object.keys(spec.paths)).not.toContain('/tags')
    expect((await call('GET', '/labels')).status).toBe(200)
  })

  it('prefers router options to `@@meta`', async () => {
    const custom = createZenStackOpenAPIRouter(schema, {
      base,
      getDb: (ctx) => ctx.db,
      models: { include: ['Tag', 'Todo'] },
      modelPath: (model) => (model === 'Tag' ? 'my-tags' : 'my-todos'),
      tags: () => ['Custom'],
    })
    const spec: any = await new OpenAPIGenerator({
      converters: [new ZenStackJsonSchemaConverter(custom)],
    }).generate(custom)
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/my-tags', '/my-todos']))
    expect(spec.paths['/my-todos'].get.tags).toEqual(['Custom'])
  })
})
