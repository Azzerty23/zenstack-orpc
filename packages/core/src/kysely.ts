/**
 * Helpers for ZenStack runtime plugins working on Kysely operation nodes (`onKyselyQuery`).
 * At that stage, tables and columns still carry model and field names.
 */

export type Row = Record<string, unknown>

/** Minimal shape of the Kysely operation nodes read or built here. */
export interface QueryNode {
  kind: string
  [key: string]: any
}

/** Model of an `UPDATE` / `DELETE` node. */
export function mutatedModel(node: QueryNode): string | undefined {
  const table = node.kind === 'DeleteQueryNode' ? node.from?.froms?.[0] : node.table
  return table?.kind === 'TableNode' ? table.table?.identifier?.name : undefined
}

/**
 * Identifies a `DELETE` across plugins: each plugin may rebuild the node (e.g. to extend its
 * `RETURNING` clause), but they keep its `from` node.
 */
export function deleteIdentity(node: QueryNode): object {
  return node.from ?? node
}

/** Columns selected by a `RETURNING` clause, or `'*'`. */
function returnedColumns(returning: QueryNode): Set<string> | '*' {
  const columns = new Set<string>()
  for (const { selection } of returning.selections as QueryNode[]) {
    if (selection.kind === 'SelectAllNode') return '*'
    if (selection.kind === 'ReferenceNode') {
      if (selection.column?.kind === 'SelectAllNode') return '*'
      if (selection.column?.kind === 'ColumnNode') columns.add(selection.column.column.name)
    }
  }
  return columns
}

function columnSelection(name: string): QueryNode {
  return Object.freeze({
    kind: 'SelectionNode',
    selection: Object.freeze({
      kind: 'ReferenceNode',
      column: Object.freeze({
        kind: 'ColumnNode',
        column: Object.freeze({ kind: 'IdentifierNode', name }),
      }),
    }),
  })
}

/**
 * Runs a node with `RETURNING` (which ZenStack already adds to its writes when the database
 * supports it) extended with `columns`, then removes the added columns from the result rows, so
 * ZenStack gets the result it expects. Returns `undefined` rows when the node has no `RETURNING`.
 */
export async function proceedReturning<R extends { rows: unknown[] }>(
  node: QueryNode,
  columns: string[],
  proceed: (node: any) => Promise<R>,
): Promise<{ result: R; rows: Row[] | undefined }> {
  if (!node.returning) return { result: await proceed(node), rows: undefined }
  const returned = returnedColumns(node.returning)
  const added = returned === '*' ? [] : columns.filter((column) => !returned.has(column))
  const extended =
    added.length === 0
      ? node
      : Object.freeze({
          ...node,
          returning: Object.freeze({
            ...node.returning,
            selections: Object.freeze([
              ...node.returning.selections,
              ...added.map(columnSelection),
            ]),
          }),
        })
  const result = await proceed(extended)
  const rows = result.rows as Row[]
  if (added.length === 0) return { result, rows }
  return {
    rows,
    result: {
      ...result,
      rows: rows.map((row) => {
        const copy = { ...row }
        for (const column of added) delete copy[column]
        return copy
      }),
    },
  }
}

/** Whether an `UPDATE` node writes one of `columns`. */
export function updatesColumns(node: QueryNode, columns: string[]): boolean {
  return ((node.updates ?? []) as QueryNode[]).some(
    (update) =>
      update.kind === 'ColumnUpdateNode' && columns.includes(update.column?.column?.name as string),
  )
}
