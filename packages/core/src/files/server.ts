import { ORPCError } from '@orpc/server'
import type { SchemaDef } from '@zenstackhq/orm/schema'
import { z } from 'zod'
import { toORPCError, withORPCErrors } from '../errors'
import { zenstackMeta } from '../meta'
import { lowerCaseFirst } from '../operations'
import { type FileFieldConfig, isAcceptedType } from './schema'
import type { FileStorage } from './storage'

export const FILE_OPERATIONS = ['upload', 'get', 'remove', 'url', 'presign', 'confirm'] as const
export type FileOperation = (typeof FILE_OPERATIONS)[number]

/** Validates a file against the `@file(accept, maxSize)` options of its field. */
export function makeFileSchema(config: FileFieldConfig) {
  let schema = z.file()
  if (config.maxSize !== undefined) schema = schema.max(config.maxSize)
  return schema.refine((file) => isAcceptedType(file.type, config.accept), {
    message: `File type must be one of: ${config.accept?.join(', ')}`,
  })
}

/** How REST downloads (`GET /posts/{id}/cover`) are served. */
export interface FileHttpOptions {
  /** `Cache-Control` of downloads. @default 'private, no-cache' (revalidated with the ETag) */
  cacheControl?: string
  /**
   * Redirect downloads to a temporary storage URL (`storage.url`, e.g. S3 or a CDN) instead of
   * streaming the file through the server. @default false
   */
  redirect?: boolean
}

interface FileProceduresOptions {
  base: any
  getDb: (context: any) => any
  storage: FileStorage
  schema: SchemaDef
  model: string
  field: string
  config: FileFieldConfig
  /**
   * How the record is addressed: `{ where }` (RPC, any unique criteria) or `{ id }` (REST path param).
   */
  target: { where: z.ZodType } | { idField: string; id: z.ZodType }
  /** Output schemas per operation (documentation). */
  outputs?: Partial<Record<FileOperation, unknown>>
  /** Extra meta plugins (e.g. OpenAPI routing) per operation. */
  meta?: Partial<Record<FileOperation, unknown[]>>
  /** Converts the records returned by `upload` / `remove` (e.g. `Bytes` to base64 for REST). */
  encode?: (record: unknown) => unknown
  /**
   * Serve `get` over HTTP (REST): caching headers (`ETag`, `Cache-Control`, `304 Not Modified`),
   * byte ranges (`206 Partial Content`) and optional redirects to the storage.
   */
  http?: FileHttpOptions
  /** Lifetime of `url` and `presign` URLs (seconds). @default 900 */
  expiresIn?: number
  /** Only create `url` / `presign` / `confirm` when the storage supports them. */
  supportedOnly?: boolean
}

/** Strong ETag of a stored file: keys are never reused, so a key identifies its content. */
export function fileETag(key: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `"${(hash >>> 0).toString(36)}-${key.length.toString(36)}"`
}

/** Parses a single `Range: bytes=start-end` header (`undefined`: none or unsupported). */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | undefined {
  const match = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (match[1] === '' && match[2] === '')) return undefined
  let start: number
  let end: number
  if (match[1] === '') {
    // Suffix range: the last N bytes.
    start = Math.max(0, size - Number(match[2]))
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  }
  if (start > end || start >= size) return 'unsatisfiable'
  return { start, end }
}

class Rollback extends Error {}

/**
 * Builds the procedures of a `@file` field:
 * - `upload` (the file goes through the server), `get`, `remove`;
 * - `url` (temporary download URL), `presign` + `confirm` (direct upload to the storage), with
 *   storages supporting them (`storage.url`, `storage.presignUpload` and `storage.stat`).
 *
 * `String[] @file` fields hold several files: `upload` / `confirm` append one, and `get` /
 * `remove` / `url` take the `key` of the file.
 */
export function createFileProcedures(options: FileProceduresOptions) {
  const { base, getDb, storage, model, field, config, target } = options
  const key = lowerCaseFirst(model)
  const select = { [field]: true }
  const multiple = config.multiple ?? false
  // Previous files are only deleted with `@file(cleanup: true)`.
  const cleanup = config.cleanup ?? false
  const expiresIn = options.expiresIn ?? 900
  const encode = options.encode ?? ((record: unknown) => record)
  const targetShape = 'where' in target ? { where: target.where } : { id: target.id }
  const toWhere = (input: any) => ('where' in target ? input.where : { [target.idField]: input.id })
  // `String[]` fields: operations on one file take its key.
  const keyShape = multiple ? { key: z.string() } : {}
  const builder = (operation: FileOperation): any => {
    const withMeta = (options.meta?.[operation] ?? []).reduce<any>(
      (b: any, plugin) => b.meta(plugin),
      base.meta(zenstackMeta({ model, operation, field })),
    )
    const output = options.outputs?.[operation]
    return output ? withMeta.output(output) : withMeta
  }

  const notFound = (what = model) => new ORPCError('NOT_FOUND', { message: `${what} not found` })

  /** Current value of the field (policy-checked read). */
  const current = async (db: any, where: unknown): Promise<string | null | string[]> => {
    const record = await withORPCErrors<Record<string, unknown> | null>(() =>
      db[key].findUnique({ where, select }),
    )
    if (!record) throw notFound()
    return (record[field] as string | null | string[]) ?? (multiple ? [] : null)
  }

  /**
   * Key a write replaces, for `@file(cleanup: true)`. A field the user may write but not read
   * (field-level `@allow('read')`) reads as `null`: its key is then read without access policies,
   * so the replaced file is still deleted. It's never returned to the caller.
   */
  const replacedKey = async (db: any, where: unknown, readable: string | null | string[]) => {
    if (!cleanup || multiple || readable !== null || typeof db.$unuse !== 'function') {
      return readable
    }
    const record = await withORPCErrors<Record<string, unknown> | null>(() =>
      db.$unuse('policy')[key].findUnique({ where, select }),
    )
    const value = record?.[field]
    return typeof value === 'string' ? value : readable
  }

  /** The stored key an operation targets: the field's value, or one of its values. */
  const targetKey = (value: string | null | string[], input: { key?: string }) => {
    const stored = Array.isArray(value) ? value.find((k) => k === input.key) : value
    if (typeof stored !== 'string') throw notFound(`${model}.${field}`)
    return stored
  }

  /** Saves a stored key in the field (appended to `String[]` fields). */
  const save = (db: any, where: unknown, stored: string) =>
    withORPCErrors(() =>
      db[key].update({ where, data: { [field]: multiple ? { push: stored } : stored } }),
    )

  /** Saves a file uploaded to the storage, deleting it if the update is rejected. */
  const saveUploaded = async (
    db: any,
    where: unknown,
    stored: string,
    previous: string | null | string[],
  ) => {
    let updated: unknown
    try {
      updated = await save(db, where, stored)
    } catch (error) {
      await storage.delete(stored)
      throw error
    }
    if (cleanup && typeof previous === 'string' && previous !== stored) {
      await storage.delete(previous)
    }
    return encode(updated)
  }

  /**
   * Checks that the caller may update the record (before handing out an upload URL): a no-op
   * update, rolled back.
   */
  const checkUpdatable = async (db: any, where: unknown, value: string | null | string[]) => {
    try {
      await db.$transaction(async (tx: any) => {
        await tx[key].update({ where, data: { [field]: value }, select })
        throw new Rollback()
      })
    } catch (error) {
      if (!(error instanceof Rollback)) throw toORPCError(error)
    }
  }

  const unsupported = (feature: string) =>
    new ORPCError('NOT_IMPLEMENTED', {
      message: `The file storage of ${model}.${field} doesn't support ${feature}`,
    })

  const procedures: Record<string, unknown> = {}

  procedures.upload = builder('upload')
    .input(z.object({ ...targetShape, file: makeFileSchema(config) }))
    .handler(async ({ context, input }: any) => {
      const db = getDb(context)
      const where = toWhere(input)
      // Checked first, so nothing is stored for a missing record.
      const previous = await replacedKey(db, where, await current(db, where))
      const stored = await storage.put(input.file, { model, field })
      return saveUploaded(db, where, stored, previous)
    })

  /** Key of the file to download (policy-checked read). */
  const download = async (context: any, input: any) =>
    targetKey(await current(getDb(context), toWhere(input)), input)

  if (options.http) {
    const { cacheControl = 'private, no-cache', redirect = false } = options.http
    procedures.get = builder('get')
      .input(
        z.object({
          params: z.object(targetShape),
          query: z.object(keyShape),
          headers: z.object({
            range: z.string().optional(),
            'if-none-match': z.string().optional(),
          }),
        }),
      )
      .handler(async ({ context, input }: any) => {
        const stored = await download(context, { ...input.params, ...input.query })
        if (redirect && storage.url) {
          const url = await storage.url(stored, { expiresIn })
          return { status: 302, headers: { location: url, 'cache-control': 'no-store' } }
        }
        const etag = fileETag(stored)
        const headers: Record<string, string> = {
          etag,
          'cache-control': cacheControl,
          'accept-ranges': 'bytes',
        }
        const ifNoneMatch = input.headers['if-none-match'] as string | undefined
        if (ifNoneMatch?.split(',').some((tag) => tag.trim() === etag || tag.trim() === '*')) {
          return { status: 304, headers }
        }
        const file = await storage.get(stored)
        if (!file) throw notFound(`${model}.${field}`)
        // Unsupported or unsatisfiable ranges are ignored: the whole file is sent (RFC 9110).
        const range = parseRange(input.headers.range, file.size)
        if (range && range !== 'unsatisfiable') {
          const body = new File([file.slice(range.start, range.end + 1)], file.name, {
            type: file.type,
          })
          return {
            status: 206,
            headers: {
              ...headers,
              'content-range': `bytes ${range.start}-${range.end}/${file.size}`,
            },
            body,
          }
        }
        return { status: 200, headers, body: file }
      })
  } else {
    procedures.get = builder('get')
      .input(z.object({ ...targetShape, ...keyShape }))
      .handler(async ({ context, input }: any) => {
        const file = await storage.get(await download(context, input))
        if (!file) throw notFound(`${model}.${field}`)
        return file
      })
  }

  procedures.remove = builder('remove')
    // REST: `DELETE` reads compact inputs from the body, the key of a list field is a `?key=`.
    .input(
      options.http
        ? z.object({ params: z.object(targetShape), query: z.object(keyShape) })
        : z.object({ ...targetShape, ...keyShape }),
    )
    .handler(async ({ context, input: raw }: any) => {
      const input = options.http ? { ...raw.params, ...raw.query } : raw
      const db = getDb(context)
      const where = toWhere(input)
      const removed: { key?: string } = {}
      let updated: unknown
      if (multiple) {
        // Read-modify-write in a transaction, so concurrent uploads aren't lost.
        updated = await withORPCErrors(() =>
          db.$transaction(async (tx: any) => {
            const value = await current(tx, where)
            const stored = targetKey(value, input)
            removed.key = stored
            const rest = (value as string[]).filter((k) => k !== stored)
            return tx[key].update({ where, data: { [field]: { set: rest } } })
          }),
        )
      } else {
        const value = await replacedKey(db, where, await current(db, where))
        if (typeof value === 'string') removed.key = value
        updated = await withORPCErrors(() => db[key].update({ where, data: { [field]: null } }))
      }
      if (cleanup && removed.key) await storage.delete(removed.key)
      return encode(updated)
    })

  if (!options.supportedOnly || storage.url) {
    procedures.url = builder('url')
      .input(z.object({ ...targetShape, ...keyShape, fileName: z.string().max(255).optional() }))
      .handler(async ({ context, input }: any) => {
        if (!storage.url) throw unsupported('download URLs')
        const stored = await download(context, input)
        const url = await storage.url(stored, { expiresIn, fileName: input.fileName })
        return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) }
      })
  }

  if (!options.supportedOnly || (storage.presignUpload && storage.stat)) {
    const maxSize = config.maxSize
    procedures.presign = builder('presign')
      .input(
        z.object({
          ...targetShape,
          name: z.string().min(1).max(255),
          type: z.string().refine((type) => isAcceptedType(type, config.accept), {
            message: `File type must be one of: ${config.accept?.join(', ')}`,
          }),
          size:
            maxSize === undefined
              ? z.number().int().nonnegative()
              : z.number().int().nonnegative().max(maxSize),
        }),
      )
      .handler(async ({ context, input }: any) => {
        if (!storage.presignUpload || !storage.stat) throw unsupported('direct uploads')
        const db = getDb(context)
        const where = toWhere(input)
        await checkUpdatable(db, where, await current(db, where))
        const { name, type, size } = input
        return storage.presignUpload({ model, field, name, type, size }, { expiresIn })
      })

    procedures.confirm = builder('confirm')
      .input(z.object({ ...targetShape, key: z.string() }))
      .handler(async ({ context, input }: any) => {
        if (!storage.presignUpload || !storage.stat) throw unsupported('direct uploads')
        const stored: string = input.key
        // Keys of presigned uploads are `Model/field/<uuid>` (see `createFileKey`).
        if (!stored.includes(`${model}/${field}/`)) {
          throw new ORPCError('BAD_REQUEST', { message: `Not a ${model}.${field} upload` })
        }
        const db = getDb(context)
        const where = toWhere(input)
        const value = await current(db, where)
        if (Array.isArray(value) ? value.includes(stored) : value === stored) {
          throw new ORPCError('CONFLICT', { message: 'This file is already saved' })
        }
        const info = await storage.stat(stored)
        if (!info) {
          throw new ORPCError('BAD_REQUEST', { message: 'The file has not been uploaded' })
        }
        const tooLarge = config.maxSize !== undefined && info.size > config.maxSize
        if (tooLarge || !isAcceptedType(info.type, config.accept)) {
          await storage.delete(stored)
          throw new ORPCError('BAD_REQUEST', {
            message: tooLarge
              ? `File too large (max ${config.maxSize} bytes)`
              : `File type must be one of: ${config.accept?.join(', ')}`,
          })
        }
        return saveUploaded(db, where, stored, await replacedKey(db, where, value))
      })
  }

  return procedures as Record<FileOperation, any>
}
