import { createWriteStream, openAsBlob } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createFileKey, type FileStorage } from './files/storage'

export interface FsStorageOptions {
  /** Directory where files are stored. */
  dir: string
}

/**
 * Stores `@file` fields on the local file system.
 *
 * Files uploaded through `TmpFileUploadHandlerPlugin` (`@orpc/node`) are already on disk: they're
 * moved with `rename()`, without being read in memory. Other files are streamed to disk.
 */
export function createFsStorage(options: FsStorageOptions): FileStorage {
  const root = path.resolve(options.dir)
  const resolveKey = (key: string) => {
    const target = path.resolve(root, key)
    if (!target.startsWith(root + path.sep)) throw new Error(`Invalid file key: ${key}`)
    return target
  }

  return {
    async put(file, { model, field }) {
      const key = createFileKey(model, field, file.name)
      const target = resolveKey(key)
      await mkdir(path.dirname(target), { recursive: true })
      const tmpPath = (file as File & { path?: unknown }).path
      if (typeof tmpPath === 'string') {
        try {
          await rename(tmpPath, target)
          return key
        } catch {
          // Different device, fall back to streaming.
        }
      }
      await pipeline(Readable.fromWeb(file.stream() as any), createWriteStream(target))
      return key
    },
    async get(key) {
      const target = resolveKey(key)
      try {
        await stat(target)
      } catch {
        return null
      }
      const blob = await openAsBlob(target)
      return new File([blob], path.basename(target), { type: blob.type })
    },
    async delete(key) {
      await rm(resolveKey(key), { force: true })
    },
    async stat(key) {
      try {
        const info = await stat(resolveKey(key))
        return info.isFile() ? { size: info.size, type: '' } : null
      } catch {
        return null
      }
    },
  }
}
