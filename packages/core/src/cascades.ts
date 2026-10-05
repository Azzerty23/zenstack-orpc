import type { SchemaDef } from '@zenstackhq/orm/schema'
import type { QueryNode, Row } from './kysely'

/** A relation the database updates when a parent row is deleted (`onDelete`). */
export interface CascadeRelation {
  /** Model whose rows are changed by the database along with the parent. */
  child: string
  /** `delete` for `onDelete: Cascade`, `update` for `SetNull` / `SetDefault`. */
  action: 'delete' | 'update'
  /** Foreign key fields of `child`... */
  fks: string[]
  /** ...and the parent fields they reference. */
  refs: string[]
}

/**
 * Relations changed by the database when a row of each model is deleted. A `@@delegate` base
 * model's rows cascade to its sub-models' tables (ZenStack deletes a `Video` by deleting its
 * `Asset` row).
 */
export function cascadeRelations(schema: SchemaDef): Record<string, CascadeRelation[]> {
  const cascades: Record<string, CascadeRelation[]> = {}
  for (const [child, modelDef] of Object.entries(schema.models)) {
    const base = modelDef.baseModel
    if (base && schema.models[base]) {
      cascades[base] ??= []
      cascades[base].push({
        child,
        action: 'delete',
        fks: [...modelDef.idFields],
        refs: [...schema.models[base].idFields],
      })
    }
    for (const fieldDef of Object.values(modelDef.fields)) {
      const relation = fieldDef.relation
      const onDelete = relation?.onDelete
      // Inherited relations are stored (and cascade) in the base model's table.
      if (!relation?.fields?.length || fieldDef.originModel) continue
      const action =
        onDelete === 'Cascade'
          ? 'delete'
          : onDelete === 'SetNull' || onDelete === 'SetDefault'
            ? 'update'
            : undefined
      if (!action) continue
      cascades[fieldDef.type] ??= []
      cascades[fieldDef.type].push({
        child,
        action,
        fks: [...relation.fields],
        refs: [...(relation.references ?? [])],
      })
    }
  }
  return cascades
}

const MAX_CASCADE_DEPTH = 32

export interface CascadedRows {
  model: string
  action: 'delete' | 'update'
  rows: Row[]
}

/**
 * Reads, before a `DELETE`, the rows the database will change along with it (`onDelete`
 * cascades), for the models `columns` asks columns of. One query per such model, in the delete's
 * transaction, each filtering its rows with a subquery over its parents:
 * `select "cover" from "Post" where "authorId" in (select "id" from "User" where …)`.
 */
export function createCascadeReader(
  schema: SchemaDef,
  columns: (model: string) => string[] | undefined,
  options: { actions?: CascadeRelation['action'][] } = {},
) {
  const actions = new Set(options.actions ?? ['delete', 'update'])
  const all = cascadeRelations(schema)
  const wanted = (model: string) => (columns(model)?.length ?? 0) > 0
  // Only deleted children cascade further.
  const reaches = (model: string, seen = new Set<string>()): boolean => {
    if (seen.has(model)) return false
    seen.add(model)
    return (all[model] ?? []).some(
      (relation) =>
        actions.has(relation.action) &&
        (wanted(relation.child) || (relation.action === 'delete' && reaches(relation.child, seen))),
    )
  }
  const graph: Record<string, CascadeRelation[]> = Object.fromEntries(
    Object.keys(schema.models).map((model) => [
      model,
      (all[model] ?? []).filter(
        (relation) =>
          actions.has(relation.action) &&
          (wanted(relation.child) || (relation.action === 'delete' && reaches(relation.child))),
      ),
    ]),
  )

  async function visit(
    qb: any,
    proceed: (query: any) => Promise<{ rows: unknown[] }>,
    model: string,
    parents: (refs: string[]) => unknown,
    result: CascadedRows[],
    depth: number,
  ) {
    if (depth >= MAX_CASCADE_DEPTH) return
    for (const { child, action, fks, refs } of graph[model] ?? []) {
      const filter = (eb: any) =>
        eb(fks.length === 1 ? eb.ref(fks[0]) : eb.refTuple(...fks), 'in', parents(refs))
      const fields = columns(child)
      if (fields?.length) {
        const query = qb.selectFrom(child).select(fields).where(filter)
        const rows = (await proceed(query.toOperationNode())).rows as Row[]
        if (rows.length > 0) result.push({ model: child, action, rows })
      }
      if (action !== 'delete') continue
      const children = (columns: string[]) => qb.selectFrom(child).select(columns).where(filter)
      await visit(qb, proceed, child, children, result, depth + 1)
    }
  }

  return {
    /** Whether deleting a row of `model` changes rows of wanted models. */
    hasCascades: (model: string) => (graph[model]?.length ?? 0) > 0,

    /** Reads the rows changed along with the `DELETE` `node` of `model`. */
    async read(
      client: unknown,
      proceed: (query: any) => Promise<{ rows: unknown[] }>,
      model: string,
      node: QueryNode,
    ): Promise<CascadedRows[]> {
      const qb = (client as any).$qb
      // The delete's condition, as a Kysely expression.
      const where = { expressionType: undefined, toOperationNode: () => node.where?.where }
      const parents = (columns: string[]) => {
        const select = qb.selectFrom(model).select(columns)
        return node.where ? select.where(() => where) : select
      }
      const result: CascadedRows[] = []
      await visit(qb, proceed, model, parents, result, 0)
      return result
    },
  }
}
