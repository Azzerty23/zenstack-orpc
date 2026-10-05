import type { AttributeApplication, SchemaDef } from '@zenstackhq/orm/schema'

/**
 * Whether a field is stored in its model's own table: fields inherited from a `@@delegate` base
 * model (`originModel`) live in the base model's table.
 */
export function isOwnField(schema: SchemaDef, model: string, field: string): boolean {
  const fieldDef = schema.models[model]?.fields[field]
  return !!fieldDef && !fieldDef.originModel
}

/** `@@delegate` bases of a model, closest first. */
export function delegateBases(schema: SchemaDef, model: string): string[] {
  const bases: string[] = []
  for (let base = schema.models[model]?.baseModel; base; base = schema.models[base]?.baseModel) {
    if (bases.includes(base)) break
    bases.push(base)
  }
  return bases
}

/** Sub-models of a `@@delegate` model, recursively. */
export function delegateSubModels(schema: SchemaDef, model: string, seen = new Set<string>()) {
  const result: string[] = []
  for (const sub of schema.models[model]?.subModels ?? []) {
    if (seen.has(sub)) continue
    seen.add(sub)
    result.push(sub, ...delegateSubModels(schema, sub, seen))
  }
  return result
}

/**
 * Tables a query on `model` reads: its own, its `@@delegate` bases' (inherited fields) and its
 * sub-models' (a base model's results include their fields).
 */
export function delegateTables(schema: SchemaDef, model: string): string[] {
  return [model, ...delegateBases(schema, model), ...delegateSubModels(schema, model)]
}

/** Whether a model is a database view (read-only). */
export function isView(schema: SchemaDef, model: string): boolean {
  return !!schema.models[model]?.isView
}

/** Discriminator field of a `@@delegate` base model (`@@delegate(kind)` → `'kind'`). */
export function delegateDiscriminator(schema: SchemaDef, model: string): string | undefined {
  const attribute = schema.models[model]?.attributes?.find((a) => a.name === '@@delegate')
  const value = attribute?.args?.[0]?.value as { kind?: string; field?: string } | undefined
  return value?.kind === 'field' ? value.field : undefined
}

/** Value of a literal (or array of literals) attribute argument. */
function literalValue(expr: any): unknown {
  if (expr?.kind === 'literal') return expr.value
  if (expr?.kind === 'array') return (expr.items ?? []).map(literalValue)
  return undefined
}

/** Value of a `@@meta(name, value)` / `@meta(name, value)` attribute. */
function metaValue(attributes: readonly AttributeApplication[] | undefined, name: string): unknown {
  for (const attr of attributes ?? []) {
    if (attr.name !== '@@meta' && attr.name !== '@meta') continue
    const [nameArg, valueArg] = attr.args ?? []
    if (literalValue(nameArg?.value) === name) return literalValue(valueArg?.value)
  }
  return undefined
}

/** `@@meta(name, value)` of a model (e.g. `@@meta('description', 'Blog posts')`). */
export function modelMeta(schema: SchemaDef, model: string, name: string): unknown {
  return metaValue(schema.models[model]?.attributes, name)
}

/** `@meta(name, value)` of a field (e.g. `@meta('description', 'Markdown body')`). */
export function fieldMeta(schema: SchemaDef, model: string, field: string, name: string): unknown {
  return metaValue(schema.models[model]?.fields[field]?.attributes, name)
}
