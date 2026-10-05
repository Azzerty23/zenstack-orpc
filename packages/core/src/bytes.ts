import type { SchemaDef } from '@zenstackhq/orm/schema'

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Whether a schema has `Bytes` fields (REST requests and responses then need converting). */
export function hasBytesFields(schema: SchemaDef): boolean {
  return Object.values(schema.models).some((model) =>
    Object.values(model.fields).some((field) => field.type === 'Bytes'),
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Base64 strings (and filters / lists of them) of a `Bytes` field, decoded. */
function decodeBytesValue(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return fromBase64(value)
    } catch {
      return value // invalid base64: left for validation to reject
    }
  }
  if (Array.isArray(value)) return value.map(decodeBytesValue)
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeBytesValue(v)]))
  }
  return value
}

/**
 * Decodes the base64 strings JSON clients send for `Bytes` fields in ZenStack args (`data`,
 * `where`, nested writes...): keys that are fields of the current model are converted (`Bytes`)
 * or followed (relations), other keys (`data`, `where`, `create`, `AND`...) keep the model.
 */
export function decodeBytesArgs(
  schema: SchemaDef,
  model: string,
  value: unknown,
  depth = 0,
): unknown {
  if (depth > 32) return value
  if (Array.isArray(value))
    return value.map((item) => decodeBytesArgs(schema, model, item, depth + 1))
  if (!isPlainObject(value)) return value
  const fields = schema.models[model]?.fields ?? {}
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const fieldDef = fields[key]
    result[key] = !fieldDef
      ? decodeBytesArgs(schema, model, item, depth + 1)
      : fieldDef.type === 'Bytes'
        ? decodeBytesValue(item)
        : fieldDef.relation
          ? decodeBytesArgs(schema, fieldDef.type, item, depth + 1)
          : item
  }
  return result
}

/** Encodes `Uint8Array`s (`Bytes` fields) of a result as base64 strings, for JSON responses. */
export function encodeBytes(value: unknown): unknown {
  if (value instanceof Uint8Array) return toBase64(value)
  if (Array.isArray(value)) return value.map(encodeBytes)
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeBytes(v)]))
  }
  return value
}
