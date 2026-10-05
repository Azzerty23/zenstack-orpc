import { PGlite } from '@electric-sql/pglite'
import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { createRouterClient, os } from '@orpc/server'
import { ZenStackClient } from '@zenstackhq/orm'
import { PolicyPlugin } from '@zenstackhq/plugin-policy'
import { PGliteDialect } from 'kysely-pglite-dialect'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryStorage, createZenStackRouter, getFileFields, zenstackFiles } from '../src'
import { createZenStackOpenAPIRouter } from '../src/openapi-entry'
import { fileFields } from './fixtures/lists/zenstack/orpc'
import { schema } from './fixtures/lists/zenstack/schema'

const storage = createMemoryStorage()
let db: any
let client: any

beforeEach(async () => {
  storage.files.clear()
  const base = new ZenStackClient(schema, { dialect: new PGliteDialect(new PGlite()) })
  await base.$pushSchema()
  db = base.$use(zenstackFiles(schema, storage)).$use(new PolicyPlugin())
  const router = createZenStackRouter(schema, {
    base: os.$context<{ db: any }>(),
    getDb: (ctx) => ctx.db,
    files: { storage },
  })
  client = createRouterClient(router, { context: { db } })
})

const photo = (name: string) => new File([name], `${name}.png`, { type: 'image/png' })

describe('String[] @file', () => {
  it('is declared as a multiple file field', () => {
    expect(fileFields.Gallery.photos.multiple).toBe(true)
    expect(getFileFields(schema).Gallery.photos).toEqual({
      accept: ['image/*'],
      cleanup: true,
      multiple: true,
    })
  })

  it('appends, downloads and removes files by key', async () => {
    const gallery = await db.gallery.create({ data: { title: 'Holidays' } })
    const where = { id: gallery.id }
    await client.gallery.photos.upload({ where, file: photo('one') })
    const updated = await client.gallery.photos.upload({ where, file: photo('two') })
    expect(updated.photos).toHaveLength(2)
    const [one, two] = updated.photos

    expect(await (await client.gallery.photos.get({ where, key: two })).text()).toBe('two')
    await expect(
      client.gallery.photos.get({ where, key: 'Gallery/photos/nope' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const removed = await client.gallery.photos.remove({ where, key: one })
    expect(removed.photos).toEqual([two])
    expect([...storage.files.keys()]).toEqual([two])

    // Types are checked per file.
    await expect(
      client.gallery.photos.upload({
        where,
        file: new File(['%PDF'], 'a.pdf', { type: 'application/pdf' }),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('deletes unreferenced files on writes and deletes (zenstackFiles)', async () => {
    const gallery = await db.gallery.create({ data: { title: 'Holidays' } })
    const where = { id: gallery.id }
    for (const name of ['a', 'b', 'c'])
      await client.gallery.photos.upload({ where, file: photo(name) })
    const { photos } = await db.gallery.findUnique({ where })

    // Writing the list directly: dropped files are deleted.
    await client.gallery.update({ where, data: { photos: { set: [photos[0], photos[1]] } } })
    expect([...storage.files.keys()].sort()).toEqual([photos[0], photos[1]].sort())

    await client.gallery.delete({ where })
    expect([...storage.files.keys()]).toEqual([])
  })
})

describe('String[] @file over REST', () => {
  it('appends with POST, downloads and removes with ?key=', async () => {
    const router = createZenStackOpenAPIRouter(schema, {
      base: os.$context<{ db: any }>(),
      getDb: (ctx: any) => ctx.db,
      files: { storage },
    })
    const handler = new OpenAPIHandler(router)
    const request = async (method: string, path: string, body?: BodyInit) => {
      const { response } = await handler.handle(
        new Request(`http://localhost/api${path}`, { method, body }),
        { prefix: '/api', context: { db } },
      )
      if (!response) throw new Error(`No route for ${method} ${path}`)
      return response
    }
    const upload = (id: string, name: string) => {
      const form = new FormData()
      form.set('file', photo(name))
      return request('POST', `/galleries/${id}/photos`, form)
    }

    const { id } = await db.gallery.create({ data: { title: 'Holidays' } })
    expect((await upload(id, 'one')).status).toBe(200)
    const appended = await upload(id, 'two')
    const { photos } = await appended.json()
    expect(photos).toHaveLength(2)
    const [one, two] = photos as string[]

    const download = await request('GET', `/galleries/${id}/photos?key=${encodeURIComponent(two)}`)
    expect(download.status).toBe(200)
    expect(await download.text()).toBe('two')
    expect(download.headers.get('etag')).toMatch(/^"/)
    const missing = await request('GET', `/galleries/${id}/photos?key=Gallery/photos/nope`)
    expect(missing.status).toBe(404)
    // The key is required on list fields.
    expect((await request('GET', `/galleries/${id}/photos`)).status).toBe(400)

    const removed = await request(
      'DELETE',
      `/galleries/${id}/photos?key=${encodeURIComponent(one)}`,
    )
    expect(removed.status).toBe(200)
    expect((await removed.json()).photos).toEqual([two])
    expect([...storage.files.keys()]).toEqual([two])

    // PUT (replace) isn't a route of list fields.
    await expect(request('PUT', `/galleries/${id}/photos`, new FormData())).rejects.toThrow(
      /No route/,
    )
  })
})
