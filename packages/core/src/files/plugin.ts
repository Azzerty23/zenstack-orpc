import type { RuntimePlugin } from '@zenstackhq/orm'
import type { SchemaDef } from '@zenstackhq/orm/schema'
import { createCascadeReader } from '../cascades'
import {
  deleteIdentity,
  mutatedModel,
  proceedReturning,
  type QueryNode,
  type Row,
  updatesColumns,
} from '../kysely'
import { isOwnField } from '../schema-utils'
import { getFileFields } from './schema'
import type { FileStorage } from './storage'

export interface ZenStackFilesOptions {
  /** Called when a stored file can't be deleted (the mutation itself has already committed). */
  onError?: (error: unknown, key: string) => void
}

function fileKeys(rows: Row[] | undefined, fields: string[]) {
  const keys = new Set<string>()
  for (const row of rows ?? []) {
    for (const field of fields) {
      const value = row[field]
      if (typeof value === 'string') keys.add(value)
      // `String[] @file`
      if (Array.isArray(value))
        for (const item of value) if (typeof item === 'string') keys.add(item)
    }
  }
  return keys
}

/**
 * ZenStack runtime plugin deleting the stored files of `@file` fields once they're no longer
 * referenced: when their record is deleted, or when the field is set to another value or `null`.
 * It applies to `@file(cleanup: true)` fields.
 * Like `zenstackLive`, it covers every write (oRPC, REST, scripts...) and runs after commit, so
 * rolled-back mutations keep their files. Install it on the base client:
 *
 * ```ts
 * const db = new ZenStackClient(schema, { dialect }).$use(zenstackFiles(schema, storage))
 * ```
 *
 * It adds no query to regular writes: deleted keys come from the `RETURNING` clause of the
 * `DELETE` (a read before the delete is only needed on databases without `RETURNING`, i.e.
 * MySQL), and previous keys are only read for updates that write a `@file` field.
 *
 * Rows removed by a database cascade (`onDelete: Cascade`) are handled too: before deleting a
 * record whose cascade reaches models with `@file` fields, their keys are read in the same
 * transaction (one query per such model).
 *
 * Only `@file(cleanup: true)` fields are handled (as in the `upload` / `remove` procedures): files
 * are never deleted unless requested. For massive cascades (e.g. a tenant with all its files),
 * prefer leaving `cleanup` off and deleting the tenant's storage prefix: keys are read in the
 * deleting transaction.
 */
export function zenstackFiles<Schema extends SchemaDef>(
  schema: Schema,
  storage: FileStorage,
  options: ZenStackFilesOptions = {},
): RuntimePlugin<Schema, {}, {}, {}> {
  // Fields whose files are deleted once no longer referenced: `@file(cleanup: true)` only, by
  // table (fields inherited from a `@@delegate` base are handled with the base model's rows).
  const fileFields: Record<string, string[]> = {}
  for (const [model, fields] of Object.entries(getFileFields(schema))) {
    for (const [field, config] of Object.entries(fields)) {
      if (!config.cleanup || !isOwnField(schema, model, field)) continue
      fileFields[model] ??= []
      fileFields[model].push(field)
    }
  }
  const onError =
    options.onError ??
    ((error: unknown, key: string) => console.error(`Failed to delete file "${key}"`, error))
  // Rows deleted by database cascades: their file keys are read before the delete.
  const cascades = createCascadeReader(schema, (model) => fileFields[model], {
    actions: ['delete'],
  })
  /** Keys of the files of deleted rows (`DELETE ... RETURNING` and cascades), by query node. */
  const deletedKeys = new WeakMap<object, Set<string>>()

  const deleteFiles = (keys: Iterable<string>) =>
    Promise.all([...keys].map((key) => storage.delete(key).catch((error) => onError(error, key))))

  return {
    id: 'zenstack-orpc-files',

    async onKyselyQuery({ client, query, proceed }) {
      const node = query as unknown as QueryNode
      const model = node.kind === 'DeleteQueryNode' ? mutatedModel(node) : undefined
      if (!model) return proceed(query)
      const fields = fileFields[model]
      const cascaded = cascades.hasCascades(model)
      if (!cascaded && (!fields || !node.returning)) return proceed(query)

      const keys = new Set<string>()
      if (cascaded) {
        // Rows deleted by the database along with this one: read their keys first.
        for (const { model: child, rows } of await cascades.read(client, proceed, model, node)) {
          for (const key of fileKeys(rows, fileFields[child] ?? [])) keys.add(key)
        }
      }

      // Keys of the deleted rows themselves: piggyback on the `RETURNING` clause ZenStack adds.
      const { result, rows } = await proceedReturning(node, fields ?? [], proceed)
      for (const key of fileKeys(rows, fields ?? [])) keys.add(key)
      // Read by `afterEntityMutation`.
      deletedKeys.set(deleteIdentity(node), keys)
      return result
    },

    onEntityMutation: {
      async beforeEntityMutation(args) {
        const fields = fileFields[args.model]
        if (!fields) return
        const node = args.queryNode as unknown as QueryNode
        if (
          (args.action === 'delete' && !node.returning) ||
          (args.action === 'update' && updatesColumns(node, fields))
        ) {
          // Previous keys, read in the mutation's transaction.
          await args.loadBeforeMutationEntities()
        }
      },
      async afterEntityMutation(args) {
        const fields = fileFields[args.model]
        if (args.action === 'delete') {
          // `RETURNING` and cascades, or (without `RETURNING`) keys read before the delete.
          const keys =
            deletedKeys.get(deleteIdentity(args.queryNode as unknown as QueryNode)) ??
            new Set<string>()
          for (const key of fileKeys(args.beforeMutationEntities, fields ?? [])) keys.add(key)
          await deleteFiles(keys)
        } else if (fields && args.action === 'update' && args.beforeMutationEntities) {
          const unreferenced = fileKeys(args.beforeMutationEntities, fields)
          // Free: ZenStack already returns updated rows to its hooks.
          for (const key of fileKeys(await args.loadAfterMutationEntities(), fields)) {
            unreferenced.delete(key)
          }
          await deleteFiles(unreferenced)
        }
      },
      runAfterMutationWithinTransaction: false,
    },
  }
}
