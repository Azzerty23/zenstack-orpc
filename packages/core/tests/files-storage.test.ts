import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { createRouterClient, os } from '@orpc/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryStorage, createZenStackRouter, type FileStorage } from '../src'
import { createZenStackOpenAPIRouter } from '../src/openapi-entry'
import { createS3Storage } from '../src/s3'
import { createTestDb, schema } from './setup'

/** A tiny S3-compatible server: objects in memory, signed requests only. */
function createFakeS3() {
  const objects = new Map<string, { body: Uint8Array; type: string }>()
  const requests: Request[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    requests.push(request)
    const url = new URL(request.url)
    const signed =
      request.headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256 ') ||
      url.searchParams.has('X-Amz-Signature')
    if (!signed) return new Response('Unsigned', { status: 403 })
    const key = decodeURIComponent(url.pathname.replace(/^\/bucket\//, ''))
    // Presigned uploads: signed headers must match.
    const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders')?.split(';') ?? []
    if (signedHeaders.includes('content-type') && !request.headers.get('content-type')) {
      return new Response('Missing signed header', { status: 403 })
    }
    const object = objects.get(key)
    switch (request.method) {
      case 'PUT': {
        const body = new Uint8Array(await request.arrayBuffer())
        objects.set(key, { body, type: request.headers.get('content-type') ?? '' })
        return new Response(null, { status: 200 })
      }
      case 'GET':
      case 'HEAD':
        if (!object) return new Response('NoSuchKey', { status: 404 })
        return new Response(request.method === 'GET' ? (object.body as BodyInit) : null, {
          headers: { 'content-type': object.type, 'content-length': String(object.body.length) },
        })
      case 'DELETE':
        objects.delete(key)
        return new Response(null, { status: 204 })
    }
    return new Response('Unsupported', { status: 405 })
  }
  return { objects, requests, fetch: fetch as typeof globalThis.fetch }
}

let setup: Awaited<ReturnType<typeof createTestDb>>
let alice: { id: string }
let bob: { id: string }

beforeEach(async () => {
  setup = await createTestDb()
  alice = await setup.db.user.create({ data: { email: 'alice@example.com', name: 'Alice' } })
  bob = await setup.db.user.create({ data: { email: 'bob@example.com', name: 'Bob' } })
})

function rpc(storage: FileStorage, userId: string) {
  const router = createZenStackRouter(schema, {
    base: os.$context<{ db: any }>(),
    getDb: (ctx) => ctx.db,
    files: { storage, expiresIn: 60 },
  })
  // File procedures are typed on the client (`createZenStackClient` with `fileFields`).
  return createRouterClient(router, {
    context: { db: setup.authDb.$setAuth({ id: userId }) },
  }) as any
}

describe('createS3Storage', () => {
  it('stores, reads and deletes objects with signed requests', async () => {
    const s3 = createFakeS3()
    const storage = createS3Storage({
      bucketUrl: 'https://s3.test/bucket',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
      prefix: 'uploads/',
      fetch: s3.fetch,
    })
    const key = await storage.put(new File(['hello'], 'hi.txt', { type: 'text/plain' }), {
      model: 'Post',
      field: 'archive',
    })
    expect(key).toMatch(/^Post\/archive\/[\w-]+\.txt$/)
    expect([...s3.objects.keys()]).toEqual([`uploads/${key}`])
    expect(await storage.stat?.(key)).toEqual({ size: 5, type: 'text/plain' })
    const file = await storage.get(key)
    expect(await file?.text()).toBe('hello')

    const url = new URL((await storage.url?.(key, { expiresIn: 60, fileName: 'été.txt' })) ?? '')
    expect(url.pathname).toBe(`/bucket/uploads/${key}`)
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60')
    expect(url.searchParams.get('response-content-disposition')).toContain('%C3%A9t%C3%A9.txt')
    expect(url.searchParams.has('X-Amz-Signature')).toBe(true)

    await storage.delete(key)
    expect(await storage.get(key)).toBeNull()
    expect(await storage.stat?.(key)).toBeNull()
  })
})

describe('direct uploads (presign / confirm) and download URLs', () => {
  it('uploads straight to the storage, then saves the key', async () => {
    const s3 = createFakeS3()
    const storage = createS3Storage({
      bucketUrl: 'https://s3.test/bucket',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
      fetch: s3.fetch,
    })
    const client = rpc(storage, alice.id)

    const upload = await client.user.avatar.presign({
      where: { id: alice.id },
      name: 'me.png',
      type: 'image/png',
      size: 3,
    })
    expect(upload.method).toBe('PUT')
    const signedHeaders = new URL(upload.url).searchParams.get('X-Amz-SignedHeaders')
    expect(signedHeaders?.split(';')).toEqual(['content-length', 'content-type', 'host'])
    // The browser sends the file itself.
    await s3.fetch(upload.url, {
      method: upload.method,
      headers: upload.headers,
      body: new Uint8Array([1, 2, 3]),
    })
    const saved = await client.user.avatar.confirm({ where: { id: alice.id }, key: upload.key })
    expect(saved.avatar).toBe(upload.key)

    const { url, expiresAt } = await client.user.avatar.url({ where: { id: alice.id } })
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('60')
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now())
    // Anyone who can read the record can get a download URL.
    await expect(
      rpc(storage, bob.id).user.avatar.url({ where: { id: alice.id } }),
    ).resolves.toMatchObject({ url: expect.any(String) })

    // Replacing the file deletes the previous one (`@file(cleanup: true)`).
    const next = await client.user.avatar.presign({
      where: { id: alice.id },
      name: 'me2.png',
      type: 'image/png',
      size: 1,
    })
    await s3.fetch(next.url, { method: 'PUT', headers: next.headers, body: new Uint8Array([9]) })
    await client.user.avatar.confirm({ where: { id: alice.id }, key: next.key })
    expect([...s3.objects.keys()]).toEqual([next.key])
  })

  it('checks permissions, types and sizes', async () => {
    const s3 = createFakeS3()
    const storage = createS3Storage({
      bucketUrl: 'https://s3.test/bucket',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
      fetch: s3.fetch,
    })
    const client = rpc(storage, alice.id)
    const where = { where: { id: alice.id } }

    // Only users who may update the record get an upload URL.
    const denied = await rpc(storage, bob.id)
      .user.avatar.presign({ ...where, name: 'x.png', type: 'image/png', size: 1 })
      .catch((e: any) => e)
    expect(['FORBIDDEN', 'NOT_FOUND']).toContain(denied.code)
    expect(s3.requests).toEqual([])

    // `@file(accept: ['image/*'], maxSize: 1048576)`, checked before signing...
    await expect(
      client.user.avatar.presign({ ...where, name: 'x.pdf', type: 'application/pdf', size: 1 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      client.user.avatar.presign({ ...where, name: 'x.png', type: 'image/png', size: 2 ** 21 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    // ...and on the uploaded object (deleted when it doesn't match).
    s3.objects.set('User/avatar/forged.pdf', { body: new Uint8Array([1]), type: 'application/pdf' })
    await expect(
      client.user.avatar.confirm({ ...where, key: 'User/avatar/forged.pdf' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(s3.objects.has('User/avatar/forged.pdf')).toBe(false)

    // Keys of other fields, and missing objects, are rejected.
    await expect(
      client.user.avatar.confirm({ ...where, key: 'Post/cover/x.png' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      client.user.avatar.confirm({ ...where, key: 'User/avatar/missing.png' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('reports storages without signed URLs', async () => {
    const client = rpc(createMemoryStorage(), alice.id)
    await expect(client.user.avatar.url({ where: { id: alice.id } })).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    })
  })
})

describe('REST downloads', () => {
  async function serve(
    storage: FileStorage,
    files: { redirect?: boolean; cacheControl?: string } = {},
  ) {
    const router = createZenStackOpenAPIRouter(schema, {
      base: os.$context<{ db: any }>(),
      getDb: (ctx: any) => ctx.db,
      files: { storage, ...files },
    })
    const handler = new OpenAPIHandler(router)
    return async (path: string, headers: Record<string, string> = {}) => {
      const { response } = await handler.handle(
        new Request(`http://localhost/api${path}`, { headers }),
        { prefix: '/api', context: { db: setup.authDb.$setAuth({ id: alice.id }) } },
      )
      if (!response) throw new Error(`No route for ${path}`)
      return response
    }
  }

  it('serves files with ETags, ranges and redirects', async () => {
    const storage = createMemoryStorage()
    const key = await storage.put(new File(['0123456789'], 'a.png', { type: 'image/png' }), {
      model: 'User',
      field: 'avatar',
    })
    await setup.db.user.update({ where: { id: alice.id }, data: { avatar: key } })
    const get = await serve(storage, { cacheControl: 'private, max-age=60' })

    const full = await get(`/users/${alice.id}/avatar`)
    expect(full.status).toBe(200)
    expect(await full.text()).toBe('0123456789')
    const etag = full.headers.get('etag') ?? ''
    expect(etag).toMatch(/^"[\w-]+"$/)
    expect(full.headers.get('cache-control')).toBe('private, max-age=60')
    expect(full.headers.get('accept-ranges')).toBe('bytes')

    const cached = await get(`/users/${alice.id}/avatar`, { 'if-none-match': etag })
    expect(cached.status).toBe(304)
    expect(await cached.text()).toBe('')

    const partial = await get(`/users/${alice.id}/avatar`, { range: 'bytes=2-4' })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe('bytes 2-4/10')
    expect(await partial.text()).toBe('234')
    const suffix = await get(`/users/${alice.id}/avatar`, { range: 'bytes=-3' })
    expect(await suffix.text()).toBe('789')
    // Unsatisfiable ranges are ignored.
    const ignored = await get(`/users/${alice.id}/avatar`, { range: 'bytes=50-' })
    expect(ignored.status).toBe(200)

    // A new file gets a new key, hence a new ETag.
    const next = await storage.put(new File(['x'], 'b.png', { type: 'image/png' }), {
      model: 'User',
      field: 'avatar',
    })
    await setup.db.user.update({ where: { id: alice.id }, data: { avatar: next } })
    expect((await get(`/users/${alice.id}/avatar`, { 'if-none-match': etag })).status).toBe(200)

    // No `/url` route without `storage.url`.
    await expect(get(`/users/${alice.id}/avatar/url`)).rejects.toThrow(/No route/)
  })

  it('redirects downloads to the storage', async () => {
    const s3 = createFakeS3()
    const storage = createS3Storage({
      bucketUrl: 'https://s3.test/bucket',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
      fetch: s3.fetch,
    })
    const key = await storage.put(new File(['x'], 'a.png', { type: 'image/png' }), {
      model: 'User',
      field: 'avatar',
    })
    await setup.db.user.update({ where: { id: alice.id }, data: { avatar: key } })
    const get = await serve(storage, { redirect: true })
    const response = await get(`/users/${alice.id}/avatar`)
    expect(response.status).toBe(302)
    expect(
      new URL(response.headers.get('location') ?? '').searchParams.has('X-Amz-Signature'),
    ).toBe(true)
    const url = await (await get(`/users/${alice.id}/avatar/url`)).json()
    expect(url.url).toContain('X-Amz-Signature')
  })
})
