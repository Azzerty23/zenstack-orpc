import type { SchemaDef } from '@zenstackhq/orm/schema'
import { delegateTables } from '../schema-utils'

/**
 * What a live query watches: a whole model, or the records of a model whose key field (id or
 * foreign key) has a given value, e.g. `{ model: 'Message', field: 'conversationId', value: 'A' }`.
 */
export interface LiveTopic {
  model: string
  field?: string
  value?: TopicValue
}

export type TopicValue = string | number | boolean

/** Stable identifier of a topic, shared by the client and the server. */
export function topicKey(topic: LiveTopic): string {
  return topic.field === undefined
    ? topic.model
    : `${topic.model}.${topic.field}=${JSON.stringify(topic.value)}`
}

/** Normalizes a key value (`bigint` ids...) so it compares the same on both sides. */
export function topicValue(value: unknown): TopicValue | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'bigint') return value.toString()
  return undefined
}

/**
 * Key fields of a model, usable as topics: its id and its foreign keys (single-field only).
 * Each one tells which record must be readable to watch it: the record itself for the id, the
 * referenced (parent) record for a foreign key. Foreign keys inherited from a `@@delegate` base
 * are keys of the base model (they're stored in its table).
 */
export function getKeyFields(
  schema: SchemaDef,
  model: string,
): Record<string, { model: string; field: string }> {
  const modelDef = schema.models[model]
  const keys: Record<string, { model: string; field: string }> = {}
  if (!modelDef) return keys
  if (modelDef.idFields.length === 1) {
    keys[modelDef.idFields[0]] = { model, field: modelDef.idFields[0] }
  }
  for (const fieldDef of Object.values(modelDef.fields)) {
    if (fieldDef.originModel) continue
    const fks = fieldDef.relation?.fields
    const refs = fieldDef.relation?.references
    if (fks?.length === 1 && refs?.length === 1 && !keys[fks[0]]) {
      keys[fks[0]] = { model: fieldDef.type, field: refs[0] }
    }
  }
  return keys
}

function literal(expr: any): unknown {
  return expr?.kind === 'literal' ? expr.value : undefined
}

/** Whether `$changes` checks that changed records are readable (`@@live(checkVisibility)`). */
export function checksVisibility(schema: SchemaDef, model: string): boolean {
  const attr = schema.models[model]?.attributes?.find((a) => a.name === '@@live')
  const arg = attr?.args?.find((a) => a.name === 'checkVisibility')
  return literal(arg?.value) !== false
}

/** Equality constraints of a `where` on the given fields (`field: v`, `{ equals }`, `{ in }`, `AND`). */
function equalities(where: unknown, fields: Set<string>, result = new Map<string, TopicValue[]>()) {
  if (!where || typeof where !== 'object') return result
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'AND') {
      for (const item of Array.isArray(condition) ? condition : [condition]) {
        equalities(item, fields, result)
      }
      continue
    }
    if (!fields.has(key) || result.has(key)) continue
    const raw =
      condition && typeof condition === 'object'
        ? 'equals' in condition
          ? [(condition as any).equals]
          : Array.isArray((condition as any).in)
            ? (condition as any).in
            : undefined
        : [condition]
    const values = raw?.map(topicValue)
    if (values && values.length > 0 && values.every((value: unknown) => value !== undefined)) {
      result.set(key, values)
    }
  }
  return result
}

const MAX_DEPTH = 8

/**
 * Topics of a query: the narrowest key equality of its `where` (id first, then foreign keys),
 * or the whole model. Included relations are narrowed through the relation when the parent's
 * key is known (`conversation.findUnique({ where: { id }, include: { messages: true } })`
 * watches `Message.conversationId`).
 *
 * `@@delegate` models are written table by table (`Asset`, then `Video`): a query watches every
 * table it reads (its bases and its sub-models), each one through its own key fields.
 */
export function queryTopics(schema: SchemaDef, model: string, args: unknown): LiveTopic[] {
  const topics = new Map<string, LiveTopic>()
  const add = (topic: LiveTopic) => topics.set(topicKey(topic), topic)

  const visit = (
    model: string,
    args: any,
    inherited: [field: string, values: TopicValue[]] | undefined,
    depth: number,
  ) => {
    const modelDef = schema.models[model]
    if (!modelDef) return
    const tables = delegateTables(schema, model).map((table) => ({
      table,
      keyFields: getKeyFields(schema, table),
      idFields: schema.models[table]?.idFields ?? [],
    }))
    const keys = new Set(tables.flatMap(({ keyFields }) => Object.keys(keyFields)))
    const eqs = equalities(args?.where, keys)
    if (inherited && keys.has(inherited[0]) && !eqs.has(inherited[0])) {
      eqs.set(inherited[0], inherited[1])
    }
    for (const { table, keyFields, idFields } of tables) {
      const idField = idFields.length === 1 ? idFields[0] : undefined
      const field =
        idField && eqs.has(idField) ? idField : Object.keys(keyFields).find((key) => eqs.has(key))
      if (field) {
        for (const value of eqs.get(field) ?? []) add({ model: table, field, value })
      } else {
        add({ model: table })
      }
    }
    if (depth >= MAX_DEPTH) return

    const selection = args?.select ?? args?.include
    if (!selection || typeof selection !== 'object') return
    for (const [name, value] of Object.entries(selection)) {
      if (name === '_count') {
        const counted =
          value && typeof value === 'object' && (value as any).select
            ? Object.keys((value as any).select).filter((key) => (value as any).select[key])
            : value
              ? Object.keys(modelDef.fields).filter((key) => modelDef.fields[key].array)
              : []
        for (const relation of counted) visitRelation(model, relation, undefined, eqs, depth)
        continue
      }
      if (value) visitRelation(model, name, value === true ? undefined : value, eqs, depth)
    }
  }

  const visitRelation = (
    model: string,
    name: string,
    args: unknown,
    eqs: Map<string, TopicValue[]>,
    depth: number,
  ) => {
    const fieldDef = schema.models[model]?.fields[name]
    if (!fieldDef?.relation) return
    const child = fieldDef.type
    const fks = fieldDef.relation.fields
    const refs = fieldDef.relation.references
    // Foreign key on this side (`post.author`): the child is the referenced record.
    if (fks?.length === 1 && refs?.length === 1) {
      const values = eqs.get(fks[0])
      return visit(child, args, values ? [refs[0], values] : undefined, depth + 1)
    }
    // Foreign key on the child (`conversation.messages`): children of the known parent.
    const opposite = fieldDef.relation.opposite
      ? schema.models[child]?.fields[fieldDef.relation.opposite]?.relation
      : undefined
    if (opposite?.fields?.length === 1 && opposite.references?.length === 1) {
      const values = eqs.get(opposite.references[0])
      return visit(child, args, values ? [opposite.fields[0], values] : undefined, depth + 1)
    }
    visit(child, args, undefined, depth + 1)
  }

  visit(model, args, undefined, 0)
  return [...topics.values()]
}
