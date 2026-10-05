import { AwsClient } from 'aws4fetch'
import { createFileKey, type FileStorage } from './files/storage'

export interface S3StorageOptions {
  /**
   * URL of the bucket (path-style), e.g. `https://s3.eu-west-3.amazonaws.com/my-bucket`,
   * `https://<account>.r2.cloudflarestorage.com/my-bucket` or `http://localhost:9000/my-bucket`.
   */
  bucketUrl: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  /** Region of the bucket. @default 'auto' (Cloudflare R2) */
  region?: string
  /** Prefix of the stored keys (e.g. `uploads/`). */
  prefix?: string
  /**
   * Public URL of the bucket (CDN, R2 custom domain): `url()` then returns `<publicUrl>/<key>`
   * instead of a signed URL. Only for public files.
   */
  publicUrl?: string
  /** `fetch` implementation. @default globalThis.fetch */
  fetch?: typeof fetch
}

/**
 * Stores `@file` fields in an S3-compatible bucket (AWS S3, Cloudflare R2, MinIO, Backblaze B2,
 * Tigris...), with signed URLs for downloads (`url`) and direct uploads (`presign`). Requests
 * are signed with `aws4fetch`, so it runs on Node, Bun, Deno and Cloudflare Workers.
 *
 * Files fetched with `get` (RPC `get`, REST downloads without `redirect`) are buffered in memory:
 * prefer `url` (or `files: { redirect: true }` in the REST router) for large files.
 *
 * @example
 * ```ts
 * const storage = createS3Storage({
 *   bucketUrl: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/uploads`,
 *   accessKeyId: process.env.R2_ACCESS_KEY_ID!,
 *   secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
 * })
 * ```
 */
export function createS3Storage(options: S3StorageOptions): FileStorage {
  const aws = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    sessionToken: options.sessionToken,
    service: 's3',
    region: options.region ?? 'auto',
  })
  const doFetch = options.fetch ?? fetch
  const bucketUrl = options.bucketUrl.replace(/\/+$/, '')
  const prefix = options.prefix ?? ''
  const path = (key: string) =>
    `${prefix}${key}`
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')
  const objectUrl = (key: string) => `${bucketUrl}/${path(key)}`

  const send = async (key: string, init: RequestInit & { aws?: object } = {}) => {
    const request = await aws.sign(objectUrl(key), init)
    return doFetch(request)
  }
  const fail = async (action: string, key: string, response: Response) => {
    const text = await response.text().catch(() => '')
    return new Error(`S3 ${action} "${key}" failed: ${response.status} ${text.slice(0, 200)}`)
  }
  const signedUrl = async (key: string, method: string, expiresIn: number, extra = {}) => {
    const url = new URL(objectUrl(key))
    url.searchParams.set('X-Amz-Expires', String(Math.max(1, Math.min(expiresIn, 604_800))))
    for (const [name, value] of Object.entries(extra)) url.searchParams.set(name, String(value))
    return aws.sign(url.toString(), { method, aws: { signQuery: true } })
  }

  return {
    async put(file, { model, field }) {
      const key = createFileKey(model, field, file.name)
      const response = await send(key, {
        method: 'PUT',
        body: file,
        headers: { 'content-type': file.type || 'application/octet-stream' },
      })
      if (!response.ok) throw await fail('upload', key, response)
      return key
    },

    async get(key) {
      const response = await send(key)
      if (response.status === 404) return null
      if (!response.ok) throw await fail('download', key, response)
      const blob = await response.blob()
      const name = key.split('/').pop() ?? key
      return new File([blob], name, {
        type: response.headers.get('content-type') ?? blob.type,
      })
    },

    async delete(key) {
      const response = await send(key, { method: 'DELETE' })
      if (!response.ok && response.status !== 404) throw await fail('delete', key, response)
    },

    async stat(key) {
      const response = await send(key, { method: 'HEAD' })
      if (response.status === 404) return null
      if (!response.ok) throw await fail('stat', key, response)
      return {
        size: Number(response.headers.get('content-length') ?? 0),
        type: response.headers.get('content-type') ?? '',
      }
    },

    async url(key, { expiresIn, fileName }) {
      if (options.publicUrl) return `${options.publicUrl.replace(/\/+$/, '')}/${path(key)}`
      const disposition = fileName
        ? {
            'response-content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          }
        : {}
      return (await signedUrl(key, 'GET', expiresIn, disposition)).url
    },

    async presignUpload({ model, field, name, type, size }, { expiresIn }) {
      const key = createFileKey(model, field, name)
      const headers = { 'content-type': type, 'content-length': String(size) }
      const url = new URL(objectUrl(key))
      url.searchParams.set('X-Amz-Expires', String(Math.max(1, Math.min(expiresIn, 604_800))))
      // Type and size are signed: the storage rejects any other file.
      const request = await aws.sign(url.toString(), {
        method: 'PUT',
        headers,
        aws: { signQuery: true, allHeaders: true },
      })
      // `content-length` is set by the client from the body.
      return { key, url: request.url, method: 'PUT', headers: { 'content-type': type } }
    },
  }
}
