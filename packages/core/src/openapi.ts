import { openapi } from '@orpc/openapi'
import { os } from '@orpc/server'
import { createQuerySchemaFactory } from '@zenstackhq/orm'
import type { GetModels, SchemaDef } from '@zenstackhq/orm/schema'
import { z } from 'zod'
import { decodeBytesArgs, encodeBytes, hasBytesFields } from './bytes'
import { withORPCErrors, zenstackErrors } from './errors'
import { getFileFields } from './files/schema'
import { createFileProcedures, type FileHttpOptions } from './files/server'
import type { FileStorage } from './files/storage'
import { applyLimits, type QueryLimits } from './limits'
import { zenstackMeta } from './meta'
import {
  createModelSchemas,
  docSchema,
  type ModelDocs,
  modelDescription,
  operationOutput,
  preprocessedSchema,
  type SchemaRegistry,
  setRouterRegistry,
} from './openapi-docs'
import {
  CRUD_OPERATIONS,
  type CrudOperation,
  createSchemaCache,
  filterList,
  isQueryOperation,
  lowerCaseFirst,
  type ModelFilter,
  type QuerySchemaFactory,
  skipRevalidation,
} from './operations'
import { isView, modelMeta } from './schema-utils'
import type { InferCurrentContext } from './types/router'

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

interface RestRoute {
  method: Method
  path: `/${string}`
  status?: number
  /** Route addressing a single record by id (`/{id}`). */
  byId?: boolean
  summary: (model: string) => string
}

/** REST routes of each operation, relative to the model prefix (e.g. `/posts`). */
export const REST_ROUTES: Record<CrudOperation, RestRoute> = {
  findMany: { method: 'GET', path: '/', summary: (m) => `List ${m} records` },
  findFirst: { method: 'GET', path: '/first', summary: (m) => `Find the first matching ${m}` },
  exists: { method: 'GET', path: '/exists', summary: (m) => `Check if a matching ${m} exists` },
  count: { method: 'GET', path: '/count', summary: (m) => `Count ${m} records` },
  aggregate: { method: 'GET', path: '/aggregate', summary: (m) => `Aggregate ${m} records` },
  groupBy: { method: 'POST', path: '/group-by', summary: (m) => `Group ${m} records` },
  createMany: {
    method: 'POST',
    path: '/batch',
    status: 201,
    summary: (m) => `Create many ${m} records`,
  },
  createManyAndReturn: {
    method: 'POST',
    path: '/batch/return',
    status: 201,
    summary: (m) => `Create many ${m} records and return them`,
  },
  updateMany: { method: 'PATCH', path: '/batch', summary: (m) => `Update many ${m} records` },
  updateManyAndReturn: {
    method: 'PATCH',
    path: '/batch/return',
    summary: (m) => `Update many ${m} records and return them`,
  },
  deleteMany: { method: 'DELETE', path: '/batch', summary: (m) => `Delete many ${m} records` },
  upsert: { method: 'PUT', path: '/', summary: (m) => `Create or update a ${m}` },
  create: { method: 'POST', path: '/', status: 201, summary: (m) => `Create a ${m}` },
  findUnique: { method: 'GET', path: '/{id}', byId: true, summary: (m) => `Get a ${m} by id` },
  update: { method: 'PATCH', path: '/{id}', byId: true, summary: (m) => `Update a ${m} by id` },
  delete: { method: 'DELETE', path: '/{id}', byId: true, summary: (m) => `Delete a ${m} by id` },
}

/** Query arguments sent as JSON in GET requests: bracket notation can't express all filters, and JSON keeps numbers typed. */
const JSON_QUERY_ARGS = [
  'take',
  'skip',
  'where',
  'orderBy',
  'select',
  'include',
  'omit',
  'cursor',
  'distinct',
  'by',
  'having',
  '_count',
  '_avg',
  '_sum',
  '_min',
  '_max',
]

/** JSON query styles for the complex arguments an operation actually accepts. */
function jsonQueryStyles(input: z.ZodType): Record<string, 'json'> {
  const object = input instanceof z.ZodOptional ? (input.unwrap() as z.ZodType) : input
  const keys = object instanceof z.ZodObject ? Object.keys(object.shape) : []
  return Object.fromEntries(
    keys.filter((key) => JSON_QUERY_ARGS.includes(key)).map((key) => [key, 'json']),
  )
}

function idSchema(schema: SchemaDef, model: string, idField: string): z.ZodType {
  const idType = schema.models[model].fields[idField].type
  return idType === 'Int' || idType === 'BigInt' ? z.coerce.number().int() : z.string()
}

function kebabCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/** `User` -> `users`, `Category` -> `categories`, `BlogPost` -> `blog-posts`. */
export function defaultModelPath(model: string): string {
  const name = kebabCase(model)
  if (/[^aeiou]y$/.test(name)) return `${name.slice(0, -1)}ies`
  // Already plural (`PostStats`, `News`), but not `Status`, `Class`, `Analysis`.
  if (/[^siu]s$/.test(name)) return name
  if (/(s|x|z|ch|sh)$/.test(name)) return `${name}es`
  return `${name}s`
}

function policyRule(attr: { name: string; args?: readonly { value: unknown }[] }): string {
  const operation = (attr.args?.[0]?.value as any)?.value
  return `${attr.name.endsWith('allow') ? 'allow' : 'deny'} \`${operation}\``
}

/** Summarizes `@@allow` / `@@deny` rules (and field-level `@allow` / `@deny`) of a model. */
function describePolicies(schema: SchemaDef, model: string): string | undefined {
  const isPolicy = (attr: { name: string }) =>
    attr.name === '@@allow' ||
    attr.name === '@@deny' ||
    attr.name === '@allow' ||
    attr.name === '@deny'
  const rules = (schema.models[model]?.attributes ?? []).filter(isPolicy).map(policyRule)
  const fieldRules = Object.entries(schema.models[model]?.fields ?? {}).flatMap(
    ([field, fieldDef]) => {
      const fieldPolicies = (fieldDef.attributes ?? []).filter(isPolicy).map(policyRule)
      return fieldPolicies.length > 0 ? [`\`${field}\` (${fieldPolicies.join(', ')})`] : []
    },
  )
  const lines = [
    rules.length > 0 ? `Access policies: ${rules.join(', ')}.` : undefined,
    fieldRules.length > 0 ? `Field policies: ${fieldRules.join(', ')}.` : undefined,
  ].filter(Boolean)
  return lines.length > 0 ? lines.join('\n\n') : undefined
}

/** `@@meta('openapi:path', 'articles')`: path segment of a model. */
function metaPath(schema: SchemaDef, model: string): string | undefined {
  const path = modelMeta(schema, model, 'openapi:path')
  return typeof path === 'string' && path !== '' ? path.replace(/^\/+/, '') : undefined
}

/** `@@meta('openapi:tags', ['Blog'])` (or a single tag): OpenAPI tags of a model. */
function metaTags(schema: SchemaDef, model: string): string[] | undefined {
  const tags = modelMeta(schema, model, 'openapi:tags')
  if (typeof tags === 'string') return [tags]
  return Array.isArray(tags) && tags.every((tag) => typeof tag === 'string') ? tags : undefined
}

export interface ZenStackOpenAPIRouterOptions<S extends SchemaDef, TBase = typeof os> {
  /** Builder every procedure is created from. @default os */
  base?: TBase
  /** Returns the ZenStack client of the request (see `createZenStackRouter`). */
  getDb: (context: InferCurrentContext<TBase>) => unknown
  models?: ModelFilter<GetModels<S>>
  operations?: ModelFilter<CrudOperation>
  queryOptions?: Record<string, unknown>
  /**
   * Path segment of a model. Also set in ZModel with `@@meta('openapi:path', 'articles')`.
   * @default plural kebab-case (`BlogPost` -> `blog-posts`)
   */
  modelPath?: (model: GetModels<S>) => string
  /**
   * OpenAPI tags of a model. Also set in ZModel with `@@meta('openapi:tags', ['Blog'])`.
   * @default [model]
   */
  tags?: (model: GetModels<S>) => string[]
  /**
   * `docs` from the `orpc.ts` file generated by the zenstack-orpc ZenStack plugin: the `///`
   * comments of models and fields, used as descriptions (`@@meta('description', ...)` and
   * `@meta('description', ...)` take precedence).
   */
  docs?: ModelDocs
  /**
   * Storage of `@file` fields, and how downloads are served (`ETag` / `Cache-Control` headers,
   * byte ranges, redirects to the storage).
   */
  files?: { storage: FileStorage; expiresIn?: number } & FileHttpOptions
  /** Bounds on what clients can ask for (see `createZenStackRouter`). */
  limits?: QueryLimits
}

/**
 * Generates a RESTful router (serve it with `OpenAPIHandler`), using oRPC's `openapi()` routing:
 * `GET /posts`, `GET /posts/{id}`, `POST /posts`, `PATCH /posts/{id}`, `DELETE /posts/{id}`...
 *
 * Complex GET arguments (`where`, `include`...) are JSON-encoded query parameters:
 * `GET /posts?where={"published":true}&take=10`.
 */
export function createZenStackOpenAPIRouter<const S extends SchemaDef, TBase = typeof os>(
  schema: S,
  options: ZenStackOpenAPIRouterOptions<S, TBase>,
): Record<string, Record<string, any>> {
  const builder: any = options.base ?? os
  // Declared errors document the error responses of every route.
  const base: any = typeof builder.errors === 'function' ? builder.errors(zenstackErrors) : builder
  const getDb = options.getDb as (context: any) => any
  const factory = createQuerySchemaFactory(
    schema,
    options.queryOptions as any,
  ) as unknown as QuerySchemaFactory & {
    makeWhereSchema(model: string, unique: boolean): z.ZodType
  }
  const schemaFor = createSchemaCache(factory)
  // ZenStack names its schemas in this registry (`PostWhereInput`...): the OpenAPI converter
  // reuses these names (see `ZenStackJsonSchemaConverter`).
  const registry: SchemaRegistry = (factory as any).schemaRegistry ?? z.registry<{ id?: string }>()
  const modelSchemas = createModelSchemas(schema, registry, options.docs)
  const models = filterList(Object.keys(schema.models) as GetModels<S>[], options.models)
  const operations = filterList(CRUD_OPERATIONS, options.operations)
  const fileFields = getFileFields(schema)
  const limits = options.limits ?? {}
  const bytes = hasBytesFields(schema)

  const router: Record<string, Record<string, any>> = {}

  for (const model of models) {
    const key = lowerCaseFirst(model)
    const idFields = schema.models[model].idFields
    const idField = idFields.length === 1 ? idFields[0] : undefined
    const prefix =
      `/${options.modelPath?.(model) ?? metaPath(schema, model) ?? defaultModelPath(model)}` as const
    const tags = options.tags?.(model) ?? metaTags(schema, model) ?? [model]
    const description =
      [modelDescription(schema, model, options.docs), describePolicies(schema, model)]
        .filter(Boolean)
        .join('\n\n') || undefined
    const procedures: Record<string, any> = {}

    for (const op of operations) {
      // Views are read-only.
      if (isView(schema, model) && !isQueryOperation(op)) continue
      const route = REST_ROUTES[op]
      let input: z.ZodType = schemaFor(model, op)
      let toArgs = (value: any) => value

      if (route.byId) {
        // Compound ids can't be addressed by `/{id}`: use `where` through the RPC router instead.
        if (!idField) continue
        const shape = (input as z.ZodObject<any>).shape
        input = z.strictObject({
          ...shape,
          id: idSchema(schema, model, idField),
          where: shape.where.optional(),
        })
        try {
          registry.add(input, { id: `${model}${op.charAt(0).toUpperCase()}${op.slice(1)}ByIdArgs` })
        } catch {}
        toArgs = ({ id, where, ...rest }: any) => ({ ...rest, where: { ...where, [idField]: id } })
      }

      procedures[op] = base
        .meta(zenstackMeta({ model, operation: op }))
        .meta(
          openapi({
            method: route.method,
            path: `${prefix}${route.path === '/' ? '' : route.path}` as `/${string}`,
            successStatus: route.status,
            summary: route.summary(model),
            description,
            tags,
            operationId: `${key}.${op}`,
            queryStyles:
              route.method === 'GET' || route.method === 'DELETE'
                ? jsonQueryStyles(input)
                : undefined,
          }),
        )
        .input(
          // JSON has no binary type: `Bytes` are sent and returned as base64 strings.
          bytes
            ? preprocessedSchema(input, (value) => decodeBytesArgs(schema, model, value))
            : input,
        )
        .output(docSchema(operationOutput(modelSchemas.get(model) as z.ZodType, op)))
        .handler(async ({ context, input }: any) => {
          const result = await withORPCErrors(() =>
            skipRevalidation(getDb(context), options.queryOptions)[key][op](
              applyLimits(schema, model, op, toArgs(input), limits),
            ),
          )
          return bytes ? encodeBytes(result) : result
        })
    }

    for (const [field, config] of Object.entries(fileFields[model] ?? {})) {
      if (!options.files || !idField) continue
      const path = `${prefix}/{id}/${kebabCase(field)}` as `/${string}`
      const route = (method: Method, summary: string, operation: string, extra: object = {}) => [
        openapi({
          method,
          path,
          summary,
          tags,
          operationId: `${key}.${field}.${operation}`,
          ...extra,
        }),
      ]
      const { storage, expiresIn, cacheControl, redirect } = options.files
      const record = docSchema(modelSchemas.get(model) as z.ZodType)
      procedures[field] = createFileProcedures({
        base,
        getDb,
        storage,
        schema,
        model,
        field,
        config,
        target: { idField, id: idSchema(schema, model, idField) },
        encode: bytes ? encodeBytes : undefined,
        http: { cacheControl, redirect },
        expiresIn,
        supportedOnly: true,
        outputs: {
          upload: record,
          get: docSchema(
            z.object({
              headers: z.object({ etag: z.string(), 'cache-control': z.string() }).partial(),
              body: z.file(),
            }),
          ),
          remove: record,
          url: docSchema(z.object({ url: z.url(), expiresAt: z.date() })),
          presign: docSchema(
            z.object({
              key: z.string(),
              url: z.url(),
              method: z.literal('PUT'),
              headers: z.record(z.string(), z.string()),
            }),
          ),
          confirm: record,
        },
        meta: {
          // `String[] @file`: uploads append a file, other operations take its `?key=`.
          upload: route(config.multiple ? 'POST' : 'PUT', `Upload ${model}.${field}`, 'upload', {
            requestBodyHint: 'form-data',
          }),
          get: route('GET', `Download ${model}.${field}`, 'get', {
            inputStructure: 'detailed',
            outputStructure: 'detailed',
            responseBodyHint: 'file',
          }),
          remove: route('DELETE', `Remove ${model}.${field}`, 'remove', {
            inputStructure: 'detailed',
          }),
          url: [
            openapi({
              method: 'GET',
              path: `${path}/url` as `/${string}`,
              summary: `Temporary download URL of ${model}.${field}`,
              tags,
              operationId: `${key}.${field}.url`,
            }),
          ],
          presign: [
            openapi({
              method: 'POST',
              path: `${path}/presign` as `/${string}`,
              summary: `Temporary URL to upload ${model}.${field} directly to the storage`,
              tags,
              operationId: `${key}.${field}.presign`,
            }),
          ],
          confirm: [
            openapi({
              method: 'POST',
              path: `${path}/confirm` as `/${string}`,
              summary: `Save a file uploaded to a presigned URL in ${model}.${field}`,
              tags,
              operationId: `${key}.${field}.confirm`,
            }),
          ],
        },
      })
    }

    router[key] = procedures
  }

  setRouterRegistry(router, registry)
  return router
}
