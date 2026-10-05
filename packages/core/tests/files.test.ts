import { mkdirSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { TmpFileUploadHandlerPlugin } from '@orpc/node'
import { os, type RouterClient } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createMemoryStorage,
  createZenStackRouter,
  getFileFields,
  isAcceptedType,
  zenstackFiles,
} from '../src'
import { createFsStorage } from '../src/node'
import { createTestDb, schema } from './setup'

let dir: string
let setup: Awaited<ReturnType<typeof createTestDb>>
let alice: { id: string }
let bob: { id: string }

function createClient(storageDir: string, userId: string) {
  mkdirSync(path.join(storageDir, '.tmp'), { recursive: true })
  const router = createZenStackRouter(schema, {
    base: os.$context<{ db: any }>(),
    getDb: (ctx) => ctx.db,
    files: { storage: createFsStorage({ dir: storageDir }) },
  })
  const handler = new RPCHandler(router, {
    plugins: [
      new TmpFileUploadHandlerPlugin({
        tmpDir: path.join(storageDir, '.tmp'),
        maxBodySize: { memory: 1024 * 1024, file: 2 * 1024 * 1024, stream: 1024 * 1024 },
      }),
    ],
  })
  const link = new RPCLink({
    origin: 'http://localhost',
    url: '/rpc',
    fetch: async (url, init) => {
      // Buffer the body: an in-process request whose body is cut short by the server would
      // otherwise surface an undici stream error.
      const original = new Request(url, init)
      const body = ['GET', 'HEAD'].includes(original.method)
        ? undefined
        : await original.arrayBuffer()
      const request = new Request(url, { method: original.method, headers: original.headers, body })
      const { response } = await handler.handle(request, {
        prefix: '/rpc',
        context: { db: setup.authDb.$setAuth({ id: userId }) },
      })
      return response ?? new Response('Not found', { status: 404 })
    },
  })
  return createORPCClient<RouterClient<typeof router>>(link)
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'zenstack-orpc-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})
beforeEach(async () => {
  setup = await createTestDb()
  alice = await setup.db.user.create({ data: { email: 'alice@example.com' } })
  bob = await setup.db.user.create({ data: { email: 'bob@example.com' } })
})

describe('@file fields', () => {
  it('reads @file attributes from the schema', () => {
    expect(getFileFields(schema)).toEqual({
      User: { avatar: { accept: ['image/*'], maxSize: 1048576, cleanup: true } },
      Post: {
        cover: { accept: ['image/png', 'image/jpeg'], maxSize: 1048576, cleanup: true },
        archive: {},
      },
      Attachment: { file: { cleanup: true }, thumbnail: { cleanup: false } },
      // Inherited from the `@@delegate` base: `video.preview.upload(...)` works too.
      Asset: { preview: { cleanup: true } },
      Video: { preview: { cleanup: true }, source: { accept: ['video/*'], cleanup: true } },
      Image: { preview: { cleanup: true } },
    })
    expect(isAcceptedType('image/webp', ['image/*'])).toBe(true)
    expect(isAcceptedType('application/pdf', ['image/*'])).toBe(false)
  })

  it('throws at startup when a @file field has no storage', () => {
    expect(() => createZenStackRouter(schema, { getDb: () => null })).toThrow(/@file field/)
  })

  it('uploads, downloads and removes files with access policies', async () => {
    const storageDir = path.join(dir, 'uploads-1')
    const asAlice = createClient(storageDir, alice.id) as any
    const asBob = createClient(storageDir, bob.id) as any

    const updated = await asAlice.user.avatar.upload({
      where: { id: alice.id },
      file: new File(['avatar'], 'me.png', { type: 'image/png' }),
    })
    expect(updated.avatar).toMatch(/^User\/avatar\/.+\.png$/)
    expect(await readdir(path.join(storageDir, 'User/avatar'))).toHaveLength(1)

    const file: File = await asBob.user.avatar.get({ where: { id: alice.id } })
    expect(file).toBeInstanceOf(Blob)
    expect(await file.text()).toBe('avatar')

    // Replacing deletes the previous file.
    await asAlice.user.avatar.upload({
      where: { id: alice.id },
      file: new File(['avatar 2'], 'me.png', { type: 'image/png' }),
    })
    expect(await readdir(path.join(storageDir, 'User/avatar'))).toHaveLength(1)

    // Bob can't change Alice's avatar, and the stored file is rolled back.
    const forbidden = await asBob.user.avatar
      .upload({ where: { id: alice.id }, file: new File(['x'], 'x.png', { type: 'image/png' }) })
      .catch((e: any) => e)
    expect(['FORBIDDEN', 'NOT_FOUND']).toContain(forbidden.code)
    expect(await readdir(path.join(storageDir, 'User/avatar'))).toHaveLength(1)

    const removed = await asAlice.user.avatar.remove({ where: { id: alice.id } })
    expect(removed.avatar).toBeNull()
    expect(await readdir(path.join(storageDir, 'User/avatar'))).toHaveLength(0)

    const missing = await asAlice.user.avatar.get({ where: { id: alice.id } }).catch((e: any) => e)
    expect(missing.code).toBe('NOT_FOUND')
  })

  it('validates @file(accept, maxSize)', async () => {
    const asAlice = createClient(path.join(dir, 'uploads-2'), alice.id) as any
    const pdf = await asAlice.user.avatar
      .upload({
        where: { id: alice.id },
        file: new File(['%PDF'], 'doc.pdf', { type: 'application/pdf' }),
      })
      .catch((e: any) => e)
    expect(pdf.code).toBe('BAD_REQUEST')

    const tooBig = await asAlice.user.avatar
      .upload({
        where: { id: alice.id },
        file: new File([new Uint8Array(1048577)], 'big.png', { type: 'image/png' }),
      })
      .catch((e: any) => e)
    expect(tooBig.code).toBe('BAD_REQUEST')
  })

  it('rejects bodies above the TmpFileUploadHandlerPlugin limit', async () => {
    const asAlice = createClient(path.join(dir, 'uploads-3'), alice.id) as any
    const post = await asAlice.post.create({ data: { title: 'p' } })
    const error = await asAlice.post.cover
      .upload({
        where: { id: post.id },
        file: new File([new Uint8Array(3 * 1024 * 1024)], 'huge.png', { type: 'image/png' }),
      })
      .catch((e: any) => e)
    expect(error.code).toBe('PAYLOAD_TOO_LARGE')
  })

  describe('zenstackFiles', () => {
    const queries: string[] = []
    async function setupWithPlugin() {
      const storage = createMemoryStorage()
      const { db, authDb } = await createTestDb([zenstackFiles(schema, storage)], {
        onQuery: (sql) => queries.push(sql),
      })
      const user = await db.user.create({ data: { email: 'carol@example.com' } })
      const store = (name: string) =>
        storage.put(new File([name], `${name}.png`, { type: 'image/png' }), {
          model: 'Post',
          field: 'cover',
        })
      return { storage, db, authDb, user, store }
    }

    it('deletes the files of deleted records', async () => {
      const { storage, db, user, store } = await setupWithPlugin()
      const [a, b, c] = await Promise.all([store('a'), store('b'), store('c')])
      const post = await db.post.create({ data: { title: 'a', cover: a, authorId: user.id } })
      await db.post.createMany({
        data: [
          { title: 'b', cover: b, authorId: user.id },
          { title: 'c', cover: c, authorId: user.id },
        ],
      })

      queries.length = 0
      await db.post.delete({ where: { id: post.id } })
      expect([...storage.files.keys()]).toEqual([b, c])
      // Keys come from `DELETE ... RETURNING`; the only read is for cascaded attachments.
      expect(queries.filter((sql) => !/^(begin|commit)/.test(sql))).toEqual([
        expect.stringMatching(
          /^select "file" from "Attachment" where "postId" in \(select "id" from "Post"/,
        ),
        expect.stringMatching(/^delete from "Post" .* returning .*"cover"/),
      ])
      await db.post.deleteMany({ where: { title: { in: ['b', 'c'] } } })
      expect(storage.files.size).toBe(0)
    })

    it('deletes the files of rows deleted by database cascades', async () => {
      const { storage, db, user, store } = await setupWithPlugin()
      const other = await db.user.create({ data: { email: 'frank@example.com' } })
      const [avatar, cover, file, kept] = await Promise.all(
        ['avatar', 'cover', 'file', 'kept'].map(store),
      )
      await db.user.update({ where: { id: user.id }, data: { avatar } })
      // User -> Post (cover) -> Attachment (file), all `onDelete: Cascade`.
      await db.post.create({
        data: {
          title: 'p',
          cover,
          authorId: user.id,
          attachments: { create: [{ file }, {}] },
        },
      })
      await db.post.create({ data: { title: 'q', cover: kept, authorId: other.id } })

      queries.length = 0
      await db.user.delete({ where: { id: user.id } })
      // One read per cascaded model with files, in the delete's transaction (after ZenStack's
      // own read of the deleted user).
      expect(queries).toEqual([
        'begin',
        expect.stringMatching(/^select "User"\."id"/),
        expect.stringMatching(
          /^select "cover" from "Post" where "authorId" in \(select "id" from "User"/,
        ),
        expect.stringMatching(
          /^select "file" from "Attachment" where "postId" in \(select "id" from "Post" where "authorId" in \(select "id" from "User"/,
        ),
        expect.stringMatching(
          /^select "preview" from "Asset" where "ownerId" in \(select "id" from "User"/,
        ),
        // `@@delegate`: `Video` rows are deleted with their `Asset` row.
        expect.stringMatching(
          /^select "source" from "Video" where "id" in \(select "id" from "Asset" where "ownerId" in \(select "id" from "User"/,
        ),
        expect.stringMatching(/^delete from "User" .* returning .*"avatar"/),
        'commit',
      ])
      expect(await db.attachment.count()).toBe(0)
      expect([...storage.files.keys()]).toEqual([kept])

      // Models whose cascades don't reach files: no read.
      const todoOwner = await db.user.create({ data: { email: 'gina@example.com' } })
      await db.todo.create({ data: { title: 't', ownerId: todoOwner.id } })
      const todo = await db.todo.findFirstOrThrow()
      queries.length = 0
      await db.todo.delete({ where: { id: todo.id } })
      expect(queries.filter((sql) => /^select/.test(sql))).toEqual([])
    })

    it('keeps files without @file(cleanup: true)', async () => {
      const { storage, db, user, store } = await setupWithPlugin()
      const [archive, archive2, file, thumbnail, own] = await Promise.all(
        ['archive', 'archive2', 'file', 'thumbnail', 'own'].map(store),
      )
      const post = await db.post.create({
        data: {
          title: 'p',
          archive,
          authorId: user.id,
          attachments: { create: [{ file, thumbnail }] },
        },
      })
      // Default (`archive`): replacing the field keeps the previous file, and nothing is read.
      queries.length = 0
      await db.post.update({ where: { id: post.id }, data: { archive: archive2 } })
      expect(queries.filter((sql) => /^select \* from "Post"/.test(sql))).toEqual([])

      // Deleted directly, an attachment keeps its thumbnail...
      const other = await db.attachment.create({ data: { postId: post.id, thumbnail: own } })
      await db.attachment.delete({ where: { id: other.id } })
      expect(storage.files.has(own)).toBe(true)

      // ...and so does a cascade, which only reads the fields to clean up.
      queries.length = 0
      await db.user.delete({ where: { id: user.id } })
      expect(queries.filter((sql) => /^select/.test(sql))).toEqual([
        expect.stringMatching(/^select "User"\."id"/),
        expect.stringMatching(/^select "cover" from "Post"/),
        expect.stringMatching(/^select "file" from "Attachment"/),
        expect.stringMatching(/^select "preview" from "Asset"/),
        expect.stringMatching(/^select "source" from "Video"/),
      ])
      expect([...storage.files.keys()].sort()).toEqual([archive, archive2, thumbnail, own].sort())
    })

    it('deletes replaced or cleared files on update, and keeps them on rollback', async () => {
      const { storage, db, authDb, user, store } = await setupWithPlugin()
      const [a, b] = await Promise.all([store('a'), store('b')])
      const post = await db.post.create({ data: { title: 'p', cover: a, authorId: user.id } })

      // Unrelated field: the file stays, and the previous keys aren't read.
      queries.length = 0
      await db.post.update({ where: { id: post.id }, data: { title: 'q' } })
      expect(storage.files.has(a)).toBe(true)
      expect(queries.filter((sql) => /^select \* from "Post"/.test(sql))).toEqual([])

      // Writing the field: the previous key is read once.
      queries.length = 0
      await db.post.update({ where: { id: post.id }, data: { cover: b } })
      expect([...storage.files.keys()]).toEqual([b])
      expect(queries.filter((sql) => /^select \* from "Post"/.test(sql))).toHaveLength(1)

      // Rejected by policy: nothing is deleted.
      const other = await db.user.create({ data: { email: 'dave@example.com' } })
      await expect(
        authDb.$setAuth({ id: other.id }).post.delete({ where: { id: post.id } }),
      ).rejects.toThrow()
      // Rolled back: nothing is deleted.
      await expect(
        db.$transaction(async (tx) => {
          await tx.post.update({ where: { id: post.id }, data: { cover: null } })
          throw new Error('rollback')
        }),
      ).rejects.toThrow('rollback')
      expect(storage.files.has(b)).toBe(true)

      await db.post.update({ where: { id: post.id }, data: { cover: null } })
      expect(storage.files.size).toBe(0)
    })
  })
})
