import type { SchemaDef } from '@zenstackhq/orm/schema'
import { usesSearch } from './search'

/**
 * How `findMany.infiniteOptions` loads the next page:
 * - `cursor`: after the last record of the previous page (`cursor` on its id, `skip: 1`), stable
 *   when records are added or removed before it;
 * - `offset`: `skip` the records already loaded.
 */
export type PaginationMode = 'cursor' | 'offset'

/** Page parameter of `findMany.infiniteOptions`: the cursor of the next page, or its offset. */
export type ZenStackPageParam = Record<string, unknown> | number | null

type Args = Record<string, unknown> & { take?: unknown; skip?: unknown; orderBy?: unknown }

/** Unique `cursor` of a record: `{ id }`, or `{ a_b: { a, b } }` for compound ids. */
function recordCursor(schema: SchemaDef, model: string, record: unknown): Record<string, unknown> {
  const idFields = schema.models[model]?.idFields ?? []
  const values = Object.fromEntries(
    idFields.map((field) => [field, (record as Record<string, unknown> | null)?.[field]]),
  )
  if (idFields.length === 0 || Object.values(values).some((value) => value === undefined)) {
    throw new Error(
      `zenstack-orpc: ${model}.findMany.infiniteOptions pages by cursor: select the id fields (${idFields.join(', ')}), or use \`pagination: 'offset'\``,
    )
  }
  return idFields.length === 1 ? values : { [idFields.join('_')]: values }
}

/**
 * Turns `findMany` args (with a positive `take`) into infinite query options: one page per `take`
 * records, the next page starting after the last record loaded.
 *
 * Relevance ordering (`_fuzzyRelevance`, `_ftsRelevance`) can't be combined with a cursor: such
 * queries page by offset.
 */
export function paginate(
  schema: SchemaDef,
  model: string,
  args: Args,
  mode: PaginationMode | undefined,
) {
  const take = args.take
  if (typeof take !== 'number' || !Number.isInteger(take) || take <= 0) {
    throw new Error(
      `zenstack-orpc: ${model}.findMany.infiniteOptions needs a positive \`take\` (the page size)`,
    )
  }
  const resolved = mode ?? (usesSearch(args.orderBy) ? 'offset' : 'cursor')

  if (resolved === 'offset') {
    const skip = typeof args.skip === 'number' ? args.skip : 0
    return {
      input: (offset: ZenStackPageParam) =>
        offset ? { ...args, skip: skip + (offset as number) } : args,
      initialPageParam: 0 as ZenStackPageParam,
      getNextPageParam: (
        lastPage: unknown[],
        _allPages: unknown[],
        lastPageParam: ZenStackPageParam,
      ): ZenStackPageParam | undefined =>
        lastPage.length < take ? undefined : (lastPageParam as number) + lastPage.length,
    }
  }

  return {
    input: (cursor: ZenStackPageParam) => (cursor ? { ...args, cursor, skip: 1 } : args),
    initialPageParam: null as ZenStackPageParam,
    getNextPageParam: (lastPage: unknown[]): ZenStackPageParam | undefined =>
      lastPage.length < take ? undefined : recordCursor(schema, model, lastPage.at(-1)),
  }
}
