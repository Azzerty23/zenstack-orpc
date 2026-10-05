import type { SchemaDef } from '@zenstackhq/orm/schema'
import type { ZodType } from 'zod'

/** Read operations exposed for every model. */
export const QUERY_OPERATIONS = [
  'findMany',
  'findUnique',
  'findFirst',
  'exists',
  'count',
  'aggregate',
  'groupBy',
] as const

/** Write operations exposed for every model. */
export const MUTATION_OPERATIONS = [
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
] as const

export const CRUD_OPERATIONS = [...QUERY_OPERATIONS, ...MUTATION_OPERATIONS] as const

export type QueryOperation = (typeof QUERY_OPERATIONS)[number]
export type MutationOperation = (typeof MUTATION_OPERATIONS)[number]
export type CrudOperation = (typeof CRUD_OPERATIONS)[number]

export function isQueryOperation(op: string): op is QueryOperation {
  return (QUERY_OPERATIONS as readonly string[]).includes(op)
}

export function isMutationOperation(op: string): op is MutationOperation {
  return (MUTATION_OPERATIONS as readonly string[]).includes(op)
}

/** Minimal structural view of ZenStack's `ZodSchemaFactory`. */
export interface QuerySchemaFactory {
  makeFindManySchema(model: string): ZodType
  makeFindUniqueSchema(model: string): ZodType
  makeFindFirstSchema(model: string): ZodType
  makeExistsSchema(model: string): ZodType
  makeCountSchema(model: string): ZodType
  makeAggregateSchema(model: string): ZodType
  makeGroupBySchema(model: string): ZodType
  makeCreateSchema(model: string): ZodType
  makeCreateManySchema(model: string): ZodType
  makeCreateManyAndReturnSchema(model: string): ZodType
  makeUpdateSchema(model: string): ZodType
  makeUpdateManySchema(model: string): ZodType
  makeUpdateManyAndReturnSchema(model: string): ZodType
  makeUpsertSchema(model: string): ZodType
  makeDeleteSchema(model: string): ZodType
  makeDeleteManySchema(model: string): ZodType
}

/** Builds the ZenStack input schema of an operation (it applies ZModel validation attributes). */
export function makeOperationSchema(
  factory: QuerySchemaFactory,
  model: string,
  op: CrudOperation,
): ZodType {
  const method = `make${op.charAt(0).toUpperCase()}${op.slice(1)}Schema` as keyof QuerySchemaFactory
  return factory[method](model)
}

/** Creates a per-factory cache so schemas are built lazily, at most once per model/operation. */
export function createSchemaCache(factory: QuerySchemaFactory) {
  const cache = new Map<string, ZodType>()
  return (model: string, op: CrudOperation): ZodType => {
    const key = `${model}:${op}`
    let schema = cache.get(key)
    if (!schema) {
      schema = makeOperationSchema(factory, model, op)
      cache.set(key, schema)
    }
    return schema
  }
}

/** Client options that change what ZenStack's input validation accepts. */
const VALIDATION_OPTIONS = ['slicing', 'allowQueryTimeOmitOverride'] as const

/**
 * The ZenStack client of a request, without ZenStack's own input validation: procedure inputs
 * are already validated by the same schemas (`createQuerySchemaFactory`), so the ORM would
 * validate them twice. Kept when the client restricts its inputs more than the router does
 * (`slicing` or `allowQueryTimeOmitOverride` options not passed to the router's `queryOptions`).
 */
export function skipRevalidation(db: any, queryOptions: Record<string, unknown> | undefined): any {
  if (typeof db?.$setInputValidation !== 'function') return db
  const clientOptions = db.$options ?? {}
  if (clientOptions.validateInput === false) return db
  const covered = VALIDATION_OPTIONS.every(
    (option) =>
      clientOptions[option] === undefined || clientOptions[option] === queryOptions?.[option],
  )
  return covered ? db.$setInputValidation(false) : db
}

export function lowerCaseFirst<T extends string>(value: T): Uncapitalize<T> {
  return (value.charAt(0).toLowerCase() + value.slice(1)) as Uncapitalize<T>
}

/** Returns the model name matching a router key (`user` -> `User`). */
export function modelFromKey(schema: SchemaDef, key: string): string | undefined {
  return Object.keys(schema.models).find((model) => lowerCaseFirst(model) === key)
}

export interface ModelFilter<Model extends string = string> {
  include?: readonly Model[]
  exclude?: readonly Model[]
}

export function filterList<T extends string>(all: readonly T[], filter?: ModelFilter<T>): T[] {
  return all.filter(
    (item) =>
      (!filter?.include || filter.include.includes(item)) && !filter?.exclude?.includes(item),
  )
}
