import type { RuntimePlugin } from '@zenstackhq/orm'
import type { SchemaDef } from '@zenstackhq/orm/schema'
import { type CascadedRows, createCascadeReader } from '../cascades'
import {
  deleteIdentity,
  mutatedModel,
  proceedReturning,
  type QueryNode,
  type Row,
  updatesColumns,
} from '../kysely'
import { type ChangeEvent, type ChangesPublisher, DEFAULT_CHANGES_CHANNEL } from './events'
import { getKeyFields, type TopicValue, topicValue } from './topics'

export interface ZenStackLiveOptions {
  /** Publisher channel. Defaults to `zenstack:changes`. */
  channel?: string
  /**
   * Called when an event can't be published (e.g. Redis is down). The write itself has already
   * committed: live queries miss the change until they resync (on reconnection). Defaults to
   * logging the error.
   */
  onError?: (error: unknown, event: ChangeEvent) => void
}

function collectKeys(rows: Row[], fields: string[]): Record<string, TopicValue[]> {
  const keys: Record<string, TopicValue[]> = {}
  for (const field of fields) {
    const values = new Set<TopicValue>()
    for (const row of rows) {
      const value = topicValue(row[field])
      if (value !== undefined) values.add(value)
    }
    keys[field] = [...values]
  }
  return keys
}

/**
 * ZenStack runtime plugin publishing a {@link ChangeEvent} after every committed mutation,
 * including writes that don't go through oRPC. Install it on the base client:
 *
 * ```ts
 * const db = new ZenStackClient(schema, { dialect }).$use(zenstackLive(schema, publisher))
 * ```
 *
 * Events carry the key values (id, foreign keys) of the changed records, so the `$changes`
 * procedure only notifies the subscribers watching them. Reading them adds no query: they come
 * from the `RETURNING` clause ZenStack already uses. Records are read before the write only for
 * updates changing a foreign key (to notify the previous parent too), and for deletes on
 * databases without `RETURNING` (MySQL).
 *
 * Rows the database deletes or updates along with a deleted record (`onDelete: Cascade`,
 * `SetNull`, `SetDefault`) are published too: their keys are read before the delete, in its
 * transaction (one query per affected model).
 */
export function zenstackLive<Schema extends SchemaDef>(
  schema: Schema,
  publisher: ChangesPublisher,
  options: ZenStackLiveOptions = {},
): RuntimePlugin<Schema, {}, {}, {}> {
  const channel = options.channel ?? DEFAULT_CHANGES_CHANNEL
  const keyFields: Record<string, string[]> = Object.fromEntries(
    Object.keys(schema.models).map((model) => [model, Object.keys(getKeyFields(schema, model))]),
  )
  const onError =
    options.onError ??
    ((error: unknown, event: ChangeEvent) =>
      console.error(`zenstack-orpc: failed to publish a ${event.model} change`, error))
  const publish = async (event: ChangeEvent) => {
    try {
      await publisher.publish(channel, event)
    } catch (error) {
      onError(error, event)
    }
  }
  /** Rows returned by `DELETE ... RETURNING`. */
  const deletedRows = new WeakMap<object, Row[]>()
  /** Rows changed by database cascades, read before the `DELETE`. */
  const cascadedRows = new WeakMap<object, CascadedRows[]>()
  const cascades = createCascadeReader(schema, (model) => keyFields[model])

  return {
    id: 'zenstack-orpc-live',

    // Deleted rows can't be read afterwards: take their keys from the `DELETE`'s `RETURNING`,
    // and read the rows cascades will change beforehand.
    async onKyselyQuery({ client, query, proceed }) {
      const node = query as unknown as QueryNode
      const model = node.kind === 'DeleteQueryNode' ? mutatedModel(node) : undefined
      if (!model || !keyFields[model]?.length) return proceed(query)
      if (cascades.hasCascades(model)) {
        cascadedRows.set(deleteIdentity(node), await cascades.read(client, proceed, model, node))
      }
      const { result, rows } = await proceedReturning(node, keyFields[model], proceed)
      if (rows) deletedRows.set(deleteIdentity(node), rows)
      return result
    },

    onEntityMutation: {
      async beforeEntityMutation(args) {
        const node = args.queryNode as unknown as QueryNode
        const fields = keyFields[args.model] ?? []
        if (
          (args.action === 'delete' && !node.returning) ||
          (args.action === 'update' && updatesColumns(node, fields))
        ) {
          await args.loadBeforeMutationEntities()
        }
      },
      async afterEntityMutation(args) {
        const fields = keyFields[args.model] ?? []
        let rows: Row[] | undefined
        if (args.action === 'delete') {
          rows =
            deletedRows.get(deleteIdentity(args.queryNode as unknown as QueryNode)) ??
            args.beforeMutationEntities
        } else {
          // Free: ZenStack already returns the written rows to its hooks.
          const after = await args.loadAfterMutationEntities()
          rows = after && [...(args.beforeMutationEntities ?? []), ...after]
        }
        const event: ChangeEvent = { model: args.model, action: args.action }
        if (rows) event.keys = collectKeys(rows, fields)
        await publish(event)
        if (args.action !== 'delete') return
        const identity = deleteIdentity(args.queryNode as unknown as QueryNode)
        for (const cascaded of cascadedRows.get(identity) ?? []) {
          await publish({
            model: cascaded.model,
            action: cascaded.action,
            keys: collectKeys(cascaded.rows, keyFields[cascaded.model] ?? []),
          })
        }
      },
      runAfterMutationWithinTransaction: false,
    },
  }
}
