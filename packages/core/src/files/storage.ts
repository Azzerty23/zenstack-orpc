/** Size and type of a stored file. */
export interface StoredFileInfo {
  size: number
  type: string
}

/** Where a client uploads a file directly (see {@link FileStorage.presignUpload}). */
export interface PresignedUpload {
  /** Storage key of the file, to pass to `confirm` once uploaded. */
  key: string
  /** URL to send the file to... */
  url: string
  /** ...with this method... */
  method: 'PUT'
  /** ...and these headers. */
  headers: Record<string, string>
}

/** Where `@file` fields are stored. The value saved in the database is the returned key. */
export interface FileStorage {
  /** Stores a file and returns its key. */
  put(file: File, info: { model: string; field: string }): Promise<string>
  /** Returns the stored file, or `null` if it doesn't exist. */
  get(key: string): Promise<File | null>
  /** Deletes a stored file. Must not throw if it doesn't exist. */
  delete(key: string): Promise<void>
  /** Size and type of a stored file, or `null` if it doesn't exist. Required by `confirm`. */
  stat?(key: string): Promise<StoredFileInfo | null>
  /**
   * A temporary URL downloading the file straight from the storage (S3, R2, a CDN...), served by
   * the `url` procedures (and by REST downloads with `files: { redirect: true }`).
   */
  url?(key: string, options: { expiresIn: number; fileName?: string }): Promise<string>
  /**
   * A temporary URL the client uploads a file to directly, without going through the server
   * (`presign` procedures). The key it returns is saved by `confirm` once the file is uploaded.
   */
  presignUpload?(
    info: { model: string; field: string; name: string; type: string; size: number },
    options: { expiresIn: number },
  ): Promise<PresignedUpload>
}

/** Key of a new file: `Model/field/<uuid><.ext>`. */
export function createFileKey(model: string, field: string, name: string): string {
  const ext = /\.[a-zA-Z0-9]{1,10}$/.exec(name)?.[0]?.toLowerCase() ?? ''
  return `${model}/${field}/${crypto.randomUUID()}${ext}`
}

/** In-memory storage, for tests and prototypes. */
export function createMemoryStorage(): FileStorage & { files: Map<string, File> } {
  const files = new Map<string, File>()
  return {
    files,
    async put(file, { model, field }) {
      const key = createFileKey(model, field, file.name)
      const bytes = await file.arrayBuffer()
      files.set(key, new File([bytes], file.name, { type: file.type }))
      return key
    },
    async get(key) {
      return files.get(key) ?? null
    },
    async delete(key) {
      files.delete(key)
    },
    async stat(key) {
      const file = files.get(key)
      return file ? { size: file.size, type: file.type } : null
    },
  }
}
