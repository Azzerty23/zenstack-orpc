import type { SchemaDef } from '@zenstackhq/orm/schema'

/** Options of a `@file(accept, maxSize, cleanup)` field. */
export interface FileFieldConfig {
  accept?: readonly string[]
  maxSize?: number
  /**
   * Delete the stored file once it's no longer referenced (record deleted, field replaced or
   * cleared). Defaults to `false`.
   */
  cleanup?: boolean
  /** `String[] @file`: the field holds several files (upload appends, remove takes a key). */
  multiple?: boolean
}

/** `{ Model: { field: FileFieldConfig } }`, as generated in `orpc.ts` by the zenstack-orpc CLI plugin. */
export type FileFieldsDef = {
  readonly [model: string]: { readonly [field: string]: FileFieldConfig }
}

function literalValue(expr: any): unknown {
  if (!expr) return undefined
  if (expr.kind === 'literal') return expr.value
  if (expr.kind === 'array') return (expr.items as any[]).map(literalValue)
  return undefined
}

/** Reads the `@file` fields from the attributes emitted in `schema.ts`. */
export function getFileFields(schema: SchemaDef): Record<string, Record<string, FileFieldConfig>> {
  const result: Record<string, Record<string, FileFieldConfig>> = {}
  for (const [model, modelDef] of Object.entries(schema.models)) {
    for (const [field, fieldDef] of Object.entries(modelDef.fields)) {
      const attr = fieldDef.attributes?.find((a) => a.name === '@file')
      if (!attr) continue
      const config: FileFieldConfig = {}
      for (const arg of attr.args ?? []) {
        const value = literalValue(arg.value)
        if (arg.name === 'accept' && Array.isArray(value)) config.accept = value as string[]
        if (arg.name === 'maxSize' && value !== undefined) config.maxSize = Number(value)
        if (arg.name === 'cleanup' && typeof value === 'boolean') config.cleanup = value
      }
      if (fieldDef.array) config.multiple = true
      result[model] ??= {}
      result[model][field] = config
    }
  }
  return result
}

/** Checks a MIME type against `accept` patterns (`image/*`, `application/pdf`...). */
export function isAcceptedType(type: string, accept: readonly string[] | undefined): boolean {
  if (!accept || accept.length === 0) return true
  const mime = type.split(';')[0].trim().toLowerCase()
  return accept.some((pattern) => {
    const p = pattern.trim().toLowerCase()
    if (p === '*' || p === '*/*') return true
    if (p.endsWith('/*')) return mime.startsWith(p.slice(0, -1))
    return mime === p
  })
}
