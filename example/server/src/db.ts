import { MemoryPublisher } from '@orpc/publisher/memory'
import { ZenStackClient } from '@zenstackhq/orm'
import { SqliteDialect } from '@zenstackhq/orm/dialects/sqlite'
import { PolicyPlugin } from '@zenstackhq/plugin-policy'
import SQLite from 'better-sqlite3'
import { type ZenStackChangeEvents, zenstackFiles, zenstackLive } from 'zenstack-orpc'
import { createFsStorage } from 'zenstack-orpc/node'
import { createS3Storage } from 'zenstack-orpc/s3'
import { schema } from '../zenstack/schema'

/**
 * Change notifications for live queries. `MemoryPublisher` works for a single server process;
 * use `RedisPublisher` / `UpstashPublisher` (or `DurablePublisher` on Cloudflare) to scale out.
 */
export const publisher = new MemoryPublisher<ZenStackChangeEvents>({ resume: { enabled: true } })

/**
 * Where `@file` fields (`Post.image`) are stored: an S3-compatible bucket (AWS S3, Cloudflare R2,
 * MinIO...) when `S3_BUCKET_URL` is set, the local disk otherwise. With a bucket, the browser
 * uploads images straight to it (`presign` / `confirm`) and downloads them from it (redirects to
 * signed URLs); the bucket's CORS rules must allow `PUT` and `GET` from the web origin.
 */
export const storage = process.env.S3_BUCKET_URL
  ? createS3Storage({
      bucketUrl: process.env.S3_BUCKET_URL,
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
      region: process.env.S3_REGION,
    })
  : createFsStorage({ dir: process.env.UPLOAD_DIR ?? 'uploads' })

/**
 * Raw client: no access policies (used by better-auth). Publishes every committed change, and
 * deletes stored files once their record is deleted or the field is replaced.
 */
export const db = new ZenStackClient(schema, {
  dialect: new SqliteDialect({ database: new SQLite(process.env.DATABASE_URL ?? 'dev.db') }),
})
  .$use(zenstackLive(schema, publisher))
  .$use(zenstackFiles(schema, storage))

/** Client enforcing access policies. Bind it to the current user with `$setAuth`. */
export const authDb = db.$use(new PolicyPlugin())

export type AuthDb = typeof authDb
