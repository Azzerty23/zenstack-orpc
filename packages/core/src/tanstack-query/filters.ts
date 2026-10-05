import type { FieldDef, SchemaDef } from '@zenstackhq/orm/schema'

/**
 * Evaluates `where` filters and `orderBy` in memory, the way the database would, so optimistic
 * records land in the right queries and at the right place. Three-valued: `undefined` means
 * "can't tell" (relation filters, JSON, collation-dependent comparisons...), and the query is then
 * refreshed after the mutation instead of being patched.
 */

type Match = boolean | undefined
type Row = Record<string, unknown>

const and = (a: Match, b: Match): Match =>
  a === false || b === false ? false : a === undefined || b === undefined ? undefined : true
const or = (a: Match, b: Match): Match =>
  a === true || b === true ? true : a === undefined || b === undefined ? undefined : false
const not = (a: Match): Match => (a === undefined ? undefined : !a)

const SCALAR_TYPES = new Set(['String', 'Int', 'Float', 'Boolean', 'DateTime', 'BigInt'])
const STRING_OPERATORS = ['contains', 'startsWith', 'endsWith'] as const
const COMPARISONS = ['lt', 'lte', 'gt', 'gte'] as const
const FILTER_KEYS = new Set([
  'equals',
  'not',
  'in',
  'notIn',
  'mode',
  ...COMPARISONS,
  ...STRING_OPERATORS,
])

function provider(schema: SchemaDef): string {
  return (schema.provider as { type?: string } | undefined)?.type ?? 'sqlite'
}

function isAscii(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII range check
  return /^[\x00-\x7f]*$/.test(value)
}

/** Comparable form of a scalar value (`undefined`: unknown or unsupported). */
function normalize(fieldDef: FieldDef, value: unknown): unknown {
  if (value === null) return null
  switch (fieldDef.type) {
    case 'DateTime': {
      const time =
        value instanceof Date
          ? value.getTime()
          : typeof value === 'string'
            ? Date.parse(value)
            : NaN
      return Number.isNaN(time) ? undefined : time
    }
    case 'BigInt':
      if (typeof value === 'bigint') return value
      if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value)
      if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
      return undefined
    case 'Int':
    case 'Float':
      return typeof value === 'number' ? value : undefined
    case 'Boolean':
      return typeof value === 'boolean' ? value : undefined
    default:
      // `String` and enums.
      return typeof value === 'string' ? value : undefined
  }
}

function isSupported(schema: SchemaDef, fieldDef: FieldDef | undefined): fieldDef is FieldDef {
  if (!fieldDef || fieldDef.relation || fieldDef.array) return false
  return SCALAR_TYPES.has(fieldDef.type) || !!schema.enums?.[fieldDef.type]
}

/** Whether string comparisons follow a known rule on this database. */
function stringRules(schema: SchemaDef, insensitive: boolean) {
  const db = provider(schema)
  // MySQL's default collations ignore case (and accents) for every comparison.
  if (db === 'mysql') return undefined
  return {
    // `mode: 'insensitive'` lowers both sides; SQLite's `LIKE` ignores ASCII case anyway.
    equalsInsensitive: insensitive,
    likeInsensitive: insensitive || db === 'sqlite',
  }
}

function lower(value: string): string | undefined {
  return isAscii(value) ? value.toLowerCase() : undefined
}

function equals(
  schema: SchemaDef,
  fieldDef: FieldDef,
  value: unknown,
  target: unknown,
  insensitive: boolean,
): Match {
  if (target === null || value === null) return value === target
  const a = normalize(fieldDef, value)
  const b = normalize(fieldDef, target)
  if (a === undefined || b === undefined) return undefined
  if (typeof a === 'string' && typeof b === 'string' && insensitive) {
    if (!stringRules(schema, true)) return undefined
    const [la, lb] = [lower(a), lower(b)]
    return la === undefined || lb === undefined ? undefined : la === lb
  }
  if (typeof a === 'string' && !stringRules(schema, false)) return undefined
  return a === b
}

function matchesFilter(schema: SchemaDef, fieldDef: FieldDef, value: unknown, filter: Row): Match {
  if (Object.keys(filter).some((key) => !FILTER_KEYS.has(key))) return undefined
  const insensitive = filter.mode === 'insensitive'
  let result: Match = true
  for (const [key, operand] of Object.entries(filter)) {
    if (key === 'mode') continue
    let match: Match
    if (key === 'equals') {
      match = equals(schema, fieldDef, value, operand, insensitive)
    } else if (key === 'not') {
      if (operand === null) match = value !== null
      else if (value === null)
        match = false // `col <> x` excludes nulls
      else if (typeof operand === 'object' && !(operand instanceof Date)) {
        match = not(
          matchesFilter(schema, fieldDef, value, { mode: filter.mode, ...(operand as Row) }),
        )
      } else match = not(equals(schema, fieldDef, value, operand, insensitive))
    } else if (key === 'in' || key === 'notIn') {
      if (!Array.isArray(operand)) return undefined
      if (value === null) match = false
      else {
        match = operand.reduce<Match>(
          (found, item) => or(found, equals(schema, fieldDef, value, item, insensitive)),
          false,
        )
        if (key === 'notIn') match = not(match)
      }
    } else if ((COMPARISONS as readonly string[]).includes(key)) {
      if (value === null || operand === null) match = false
      else {
        const a = normalize(fieldDef, value)
        const b = normalize(fieldDef, operand)
        // String ordering depends on the collation.
        if (a === undefined || b === undefined || typeof a === 'string' || typeof a === 'boolean') {
          return undefined
        }
        const [x, y] = [a as number | bigint, b as number | bigint]
        match = key === 'lt' ? x < y : key === 'lte' ? x <= y : key === 'gt' ? x > y : x >= y
      }
    } else {
      // `contains`, `startsWith`, `endsWith`.
      if (value === null) match = false
      else {
        if (typeof value !== 'string' || typeof operand !== 'string') return undefined
        const rules = stringRules(schema, insensitive)
        if (!rules) return undefined
        let [haystack, needle]: (string | undefined)[] = [value, operand]
        if (rules.likeInsensitive) [haystack, needle] = [lower(value), lower(operand)]
        if (haystack === undefined || needle === undefined) return undefined
        match =
          key === 'contains'
            ? haystack.includes(needle)
            : key === 'startsWith'
              ? haystack.startsWith(needle)
              : haystack.endsWith(needle)
      }
    }
    result = and(result, match)
    if (result === false) return false
  }
  return result
}

/** Whether `record` matches `where` (`undefined`: can't tell in memory). */
export function matchesWhere(schema: SchemaDef, model: string, record: Row, where: unknown): Match {
  if (where === undefined || where === null) return true
  if (typeof where !== 'object') return undefined
  const all = (items: unknown): Match =>
    (Array.isArray(items) ? items : [items]).reduce<Match>(
      (acc, item) => and(acc, matchesWhere(schema, model, record, item)),
      true,
    )
  let result: Match = true
  for (const [key, condition] of Object.entries(where)) {
    let match: Match
    if (key === 'AND') match = all(condition)
    else if (key === 'OR') {
      match = Array.isArray(condition)
        ? condition.reduce<Match>(
            (acc, item) => or(acc, matchesWhere(schema, model, record, item)),
            false,
          )
        : undefined
    } else if (key === 'NOT') match = not(all(condition))
    else {
      const fieldDef = schema.models[model]?.fields[key]
      const value = record[key]
      if (!isSupported(schema, fieldDef) || value === undefined) return undefined
      // Unresolved update operators (`{ increment: 1 }`).
      if (value !== null && typeof value === 'object' && !(value instanceof Date)) return undefined
      match =
        condition !== null && typeof condition === 'object' && !(condition instanceof Date)
          ? matchesFilter(schema, fieldDef, value, condition as Row)
          : equals(schema, fieldDef, value, condition, false)
    }
    result = and(result, match)
    if (result === false) return false
  }
  return result
}

type Comparator = (a: Row, b: Row) => number | undefined

/**
 * Comparator of an `orderBy` on scalar fields (`undefined`: unsupported, e.g. relations,
 * `_count`, relevance). Strings are compared like the database's default collation would, as
 * far as it can be guessed (binary on SQLite, locale-aware on PostgreSQL).
 */
export function orderComparator(
  schema: SchemaDef,
  model: string,
  orderBy: unknown,
): Comparator | undefined {
  const db = provider(schema)
  if (db === 'mysql') return undefined
  const entries: [field: string, sort: 'asc' | 'desc', nulls: 'first' | 'last'][] = []
  for (const item of Array.isArray(orderBy) ? orderBy : [orderBy]) {
    if (!item || typeof item !== 'object') return undefined
    for (const [field, spec] of Object.entries(item)) {
      const fieldDef = schema.models[model]?.fields[field]
      if (!isSupported(schema, fieldDef)) return undefined
      const sort = typeof spec === 'string' ? spec : (spec as { sort?: unknown })?.sort
      if (sort !== 'asc' && sort !== 'desc') return undefined
      const nullsIn = typeof spec === 'object' ? (spec as { nulls?: unknown }).nulls : undefined
      // PostgreSQL sorts nulls as the largest values, SQLite as the smallest.
      const nullsLarge = db === 'postgresql'
      const nulls =
        nullsIn === 'first' || nullsIn === 'last'
          ? nullsIn
          : (sort === 'asc') === nullsLarge
            ? 'last'
            : 'first'
      entries.push([field, sort, nulls])
    }
  }
  if (entries.length === 0) return undefined

  const enumRank = (fieldDef: FieldDef, value: string) => {
    const values = Object.values(schema.enums?.[fieldDef.type]?.values ?? {}) as string[]
    return values.indexOf(value)
  }

  return (a, b) => {
    for (const [field, sort, nulls] of entries) {
      const fieldDef = schema.models[model]?.fields[field] as FieldDef
      const [x, y] = [normalize(fieldDef, a[field]), normalize(fieldDef, b[field])]
      if (x === undefined || y === undefined) return undefined
      if (x === y) continue
      if (x === null || y === null) return (x === null) === (nulls === 'first') ? -1 : 1
      let diff: number
      if (typeof x === 'string' && typeof y === 'string') {
        // PostgreSQL (and MySQL) store enums natively, sorted by declaration order.
        const isEnum = !!schema.enums?.[fieldDef.type]
        if (isEnum && db === 'postgresql') diff = enumRank(fieldDef, x) - enumRank(fieldDef, y)
        else if (db === 'postgresql') diff = x.localeCompare(y)
        else diff = x < y ? -1 : 1
      } else diff = (x as number) < (y as number) ? -1 : (x as number) > (y as number) ? 1 : 0
      if (diff !== 0) return sort === 'asc' ? diff : -diff
    }
    return 0
  }
}

function isRecord(value: unknown): value is Row {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
}

function idKey(schema: SchemaDef, model: string, record: Row): string | undefined {
  const ids = schema.models[model]?.idFields ?? []
  const values = ids.map((field) => record[field])
  return ids.length > 0 && values.every((value) => value !== undefined)
    ? JSON.stringify(values, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
    : undefined
}

/**
 * A created record's optional scalar fields that weren't set and have no default: `NULL` in the
 * database.
 */
function withNullDefaults(schema: SchemaDef, model: string, record: Row): Row {
  const result = { ...record }
  for (const [field, fieldDef] of Object.entries(schema.models[model]?.fields ?? {})) {
    if (result[field] !== undefined || !fieldDef.optional || fieldDef.relation) continue
    if (fieldDef.default !== undefined || fieldDef.updatedAt || fieldDef.computed) continue
    result[field] = null
  }
  return result
}

/**
 * Applies a list query's `where`, `orderBy`, `take`, `skip`, `cursor` and `distinct` to its
 * optimistic records. Returns `undefined` when that can't be done in memory.
 *
 * - optimistic records that don't match `where` are removed (an update can make a record leave a
 *   filtered list);
 * - new records are inserted where `orderBy` puts them (at the end without `orderBy`), and the
 *   list is cut back to `take`;
 * - pages that don't start at the beginning (`skip`, `cursor`) aren't patched with new records.
 *
 * `raw` is the same data before completion (`completeOptimisticData`), whose records may hold
 * fields that `select` removed.
 */
function reconcileList(
  schema: SchemaDef,
  model: string,
  args: Row | undefined,
  previous: unknown,
  data: unknown[],
  raw: unknown,
): unknown[] | undefined {
  const rawList = Array.isArray(raw) ? raw : []
  const previousIds = new Set(
    (Array.isArray(previous) ? previous : [])
      .filter(isRecord)
      .map((record) => idKey(schema, model, record)),
  )
  // `full`: the record with the fields `select` removed, to evaluate `where` and `orderBy`.
  const kept: { record: unknown; full: Row; isNew: boolean }[] = []
  for (const [index, record] of data.entries()) {
    if (!isRecord(record) || !record.$optimistic) {
      kept.push({ record, full: isRecord(record) ? record : {}, isNew: false })
      continue
    }
    let full = { ...(isRecord(rawList[index]) ? rawList[index] : {}), ...record }
    const key = idKey(schema, model, full)
    const isNew = key === undefined || !previousIds.has(key)
    if (isNew) full = withNullDefaults(schema, model, full)
    const match = matchesWhere(schema, model, full, args?.where)
    if (match === undefined) return undefined
    if (!match) continue
    kept.push({ record, full, isNew })
  }

  const added = kept.filter((item) => item.isNew)
  if (added.length === 0) return kept.map((item) => item.record)
  if (args?.distinct || args?.skip || args?.cursor) return undefined
  const take = args?.take
  if (take !== undefined && (typeof take !== 'number' || take < 0)) return undefined

  const list = kept.filter((item) => !item.isNew)
  if (args?.orderBy !== undefined) {
    const compare = orderComparator(schema, model, args.orderBy)
    if (!compare) return undefined
    for (const item of added) {
      let position = list.length
      for (let i = 0; i < list.length; i++) {
        const diff = compare(item.full, list[i].full)
        if (diff === undefined) return undefined
        if (diff < 0) {
          position = i
          break
        }
      }
      list.splice(position, 0, item)
    }
  } else {
    // Without `orderBy`, databases return rows in insertion order in practice.
    list.push(...added)
  }
  const result = typeof take === 'number' ? list.slice(0, take) : list
  return result.map((item) => item.record)
}

/**
 * Makes optimistic query data respect the query's arguments (see {@link reconcileList}),
 * relations included. `undefined`: the query can't be patched.
 */
export function reconcileOptimistic(
  schema: SchemaDef,
  model: string,
  operation: string,
  args: unknown,
  previous: unknown,
  data: unknown,
  raw: unknown,
): unknown | undefined {
  const queryArgs = isRecord(args) ? args : undefined
  if (operation === 'findMany') {
    if (!Array.isArray(data)) return data
    const list = reconcileList(schema, model, queryArgs, previous, data, raw)
    if (!list) return undefined
    return reconcileRelationsOfList(schema, model, queryArgs, list, previous)
  }
  if (!isRecord(data)) return data
  // `findFirst` / `findUnique`: an optimistic record that stops matching can't be replaced.
  if (data.$optimistic && operation === 'findFirst') {
    const full = { ...(isRecord(raw) ? raw : {}), ...data }
    if (matchesWhere(schema, model, full, queryArgs?.where) !== true) return undefined
  }
  return reconcileRelations(schema, model, queryArgs, data, previous)
}

function reconcileRelationsOfList(
  schema: SchemaDef,
  model: string,
  args: Row | undefined,
  list: unknown[],
  previous: unknown,
): unknown[] | undefined {
  const previousById = new Map(
    (Array.isArray(previous) ? previous : [])
      .filter(isRecord)
      .map((record) => [idKey(schema, model, record), record]),
  )
  const result: unknown[] = []
  for (const record of list) {
    if (!isRecord(record)) {
      result.push(record)
      continue
    }
    const reconciled = reconcileRelations(
      schema,
      model,
      args,
      record,
      previousById.get(idKey(schema, model, record)),
    )
    if (reconciled === undefined) return undefined
    result.push(reconciled)
  }
  return result
}

/** Reconciles the to-many relations a record was loaded with (`include` / `select`). */
function reconcileRelations(
  schema: SchemaDef,
  model: string,
  args: Row | undefined,
  record: Row,
  previous: unknown,
): Row | undefined {
  const selection = (args?.select ?? args?.include) as Row | undefined
  if (!isRecord(selection)) return record
  let result = record
  for (const [field, nested] of Object.entries(selection)) {
    const fieldDef = schema.models[model]?.fields[field]
    if (!fieldDef?.relation || !nested) continue
    const value = record[field]
    const nestedArgs = isRecord(nested) ? nested : undefined
    const before = isRecord(previous) ? previous[field] : undefined
    const reconciled = fieldDef.array
      ? reconcileOptimistic(schema, fieldDef.type, 'findMany', nestedArgs, before, value, value)
      : reconcileOptimistic(schema, fieldDef.type, 'findUnique', nestedArgs, before, value, value)
    if (reconciled === undefined) return undefined
    if (reconciled !== value) result = { ...result, [field]: reconciled }
  }
  return result
}
