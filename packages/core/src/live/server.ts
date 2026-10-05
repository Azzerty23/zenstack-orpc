import { getEventMeta, withEventMeta } from '@orpc/server'
import type { SchemaDef } from '@zenstackhq/orm/schema'
import { z } from 'zod'
import { zenstackMeta } from '../meta'
import { lowerCaseFirst } from '../operations'
import {
  type ChangeBatch,
  type ChangeEvent,
  type ChangesPublisher,
  DEFAULT_CHANGES_CHANNEL,
} from './events'
import {
  checksVisibility,
  getKeyFields,
  type LiveTopic,
  type TopicValue,
  topicKey,
  topicValue,
} from './topics'

export interface LiveRouterOptions {
  /** The publisher the `zenstackLive` ORM plugin publishes to. */
  publisher: ChangesPublisher
  /** Publisher channel. Defaults to `zenstack:changes`. */
  channel?: string
  /** Events are grouped in batches during this window (ms). @default 50 */
  batchWindow?: number
  /** Maximum number of topics per subscription. @default 1000 */
  maxTopics?: number
}

/**
 * Groups items of an async iterable into batches: a batch is flushed `windowMs` after its first
 * item. The source is consumed through a single pending `next()` call, so no item is lost.
 */
export async function* batchAsyncIterable<T>(
  source: AsyncIterable<T>,
  windowMs: number,
): AsyncGenerator<T[]> {
  const iterator = source[Symbol.asyncIterator]()
  let pending: Promise<IteratorResult<T>> | undefined
  try {
    while (true) {
      pending ??= iterator.next()
      const first = await pending
      pending = undefined
      if (first.done) return
      const batch = [first.value]
      const deadline = Date.now() + windowMs
      while (true) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        pending ??= iterator.next()
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), remaining)
        })
        const result = await Promise.race([pending, timeout])
        clearTimeout(timer)
        if (result === 'timeout') break
        pending = undefined
        if (result.done) {
          yield batch
          return
        }
        batch.push(result.value)
      }
      yield batch
    }
  } finally {
    await iterator.return?.()
  }
}

/**
 * Keeps the topics the subscriber may watch, checked once per subscription with its own client:
 * the record itself for an id topic, the referenced (parent) record for a foreign key topic.
 * Topics on other fields are widened to their model.
 */
async function authorizeTopics(schema: SchemaDef, db: any, topics: LiveTopic[]) {
  const allowed = new Map<string, LiveTopic>()
  const checks = new Map<string, { model: string; field: string; topics: LiveTopic[] }>()
  for (const topic of topics) {
    const target = topic.field ? getKeyFields(schema, topic.model)[topic.field] : undefined
    if (!target || topic.value === undefined) {
      allowed.set(topic.model, { model: topic.model })
      continue
    }
    const key = `${target.model}.${target.field}`
    if (!checks.has(key)) checks.set(key, { ...target, topics: [] })
    checks.get(key)?.topics.push(topic)
  }
  await Promise.all(
    [...checks.values()].map(async ({ model, field, topics }) => {
      const delegate = db?.[lowerCaseFirst(model)]
      if (!delegate) return
      const values = [...new Set(topics.map((topic) => topic.value))]
      const rows: Record<string, unknown>[] = await delegate.findMany({
        where: { [field]: { in: values } },
        select: { [field]: true },
      })
      const visible = new Set(rows.map((row) => topicValue(row[field])))
      for (const topic of topics) {
        if (visible.has(topic.value)) allowed.set(topicKey(topic), topic)
      }
    }),
  )
  return [...allowed.values()]
}

/** Topics of `topics` matched by an event. Events without keys match every topic of their model. */
function matchedTopics(event: ChangeEvent, topics: LiveTopic[]): LiveTopic[] {
  return topics.filter((topic) => {
    if (topic.model !== event.model) return false
    if (topic.field === undefined || !event.keys) return true
    return event.keys[topic.field]?.includes(topic.value as TopicValue) ?? false
  })
}

/**
 * Drops creates/updates of records the subscriber can't read: one query per model and batch,
 * for the subscribers whose topics matched (topics narrow the audience first). Deletes are
 * forwarded as is: deleted records can't be checked anymore. Skipped for models with
 * `@@live(checkVisibility: false)`.
 */
async function visibleChanges(
  schema: SchemaDef,
  db: any,
  changes: { event: ChangeEvent; topics: LiveTopic[] }[],
  checked: Set<string>,
) {
  const toCheck = new Map<string, Set<TopicValue>>()
  for (const { event } of changes) {
    const idField = schema.models[event.model]?.idFields
    const ids = idField?.length === 1 ? event.keys?.[idField[0]] : undefined
    if (event.action === 'delete' || !ids || !checked.has(event.model)) continue
    if (!toCheck.has(event.model)) toCheck.set(event.model, new Set())
    for (const id of ids) toCheck.get(event.model)?.add(id)
  }
  const visible = new Map<string, Set<unknown>>()
  await Promise.all(
    [...toCheck].map(async ([model, ids]) => {
      const idField = schema.models[model].idFields[0]
      const rows: Record<string, unknown>[] =
        (await db?.[lowerCaseFirst(model)]?.findMany({
          where: { [idField]: { in: [...ids] } },
          select: { [idField]: true },
        })) ?? []
      visible.set(model, new Set(rows.map((row) => topicValue(row[idField]))))
    }),
  )
  return changes
    .filter(({ event }) => {
      const ids = visible.get(event.model)
      if (!ids || event.action === 'delete') return true
      const idField = schema.models[event.model].idFields[0]
      return event.keys?.[idField]?.some((id) => ids.has(id)) ?? true
    })
    .map((change) => ({ ...change, ids: updatedIds(schema, change.event, visible, checked) }))
}

/**
 * Ids of an update the subscriber may learn: the readable ones (just checked), or all of them for
 * models anyone can read (`@@live(checkVisibility: false)`).
 */
function updatedIds(
  schema: SchemaDef,
  event: ChangeEvent,
  visible: Map<string, Set<unknown>>,
  checked: Set<string>,
): TopicValue[] | undefined {
  const idFields = schema.models[event.model]?.idFields
  if (event.action !== 'update' || idFields?.length !== 1) return undefined
  const ids = event.keys?.[idFields[0]]
  if (!ids) return undefined
  if (!checked.has(event.model)) return ids
  const readable = visible.get(event.model)
  return readable ? ids.filter((id) => readable.has(id)) : undefined
}

const topicSchema = z.object({
  model: z.string(),
  field: z.string().optional(),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
})

/**
 * Builds the `$changes` procedure: a stream of the changes matching the subscriber's topics.
 * Topics are authorized once, when subscribing; events are then matched in memory.
 */
export function createChangesProcedure(
  schema: SchemaDef,
  base: any,
  getDb: (context: any) => any,
  options: LiveRouterOptions,
) {
  const channel = options.channel ?? DEFAULT_CHANGES_CHANNEL
  const batchWindow = options.batchWindow ?? 50
  const models = new Set(Object.keys(schema.models))
  const checked = new Set([...models].filter((model) => checksVisibility(schema, model)))

  return base
    .meta(zenstackMeta({ operation: '$changes' }))
    .input(
      z.object({
        topics: z
          .array(topicSchema)
          .max(options.maxTopics ?? 1000)
          .refine((topics) => topics.every((topic) => models.has(topic.model)), 'Unknown model'),
      }),
    )
    .handler(async function* ({
      context,
      input,
      signal,
      lastEventId,
    }: any): AsyncGenerator<ChangeBatch> {
      const db = getDb(context)
      const topics = await authorizeTopics(schema, db, input.topics)
      if (topics.length === 0) return
      const events = options.publisher.subscribe(channel, { signal, lastEventId })

      for await (const batch of batchAsyncIterable(events, batchWindow)) {
        // Resume ids are attached by the publisher to each event: forward the last one.
        const id = getEventMeta(batch[batch.length - 1])?.id
        let changes = batch
          .map((event) => ({ event, topics: matchedTopics(event, topics) }))
          .filter((change) => change.topics.length > 0)
        if (changes.length > 0) {
          changes = await visibleChanges(schema, db, changes, checked)
        }
        if (changes.length === 0) continue
        const payload: ChangeBatch = {
          changes: changes.map((change) => {
            const { event, topics } = change
            const { ids } = change as { ids?: TopicValue[] }
            return {
              model: event.model,
              action: event.action,
              topics: topics.map(topicKey),
              ...(ids ? { ids } : {}),
            }
          }),
        }
        yield id ? withEventMeta(payload, { id }) : payload
      }
    })
}
