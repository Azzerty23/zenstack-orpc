import type { QueryKey } from '@tanstack/query-core'

export interface ParsedOperationKey {
  path: string[]
  type?: string
  input?: unknown
}

/** Parses an oRPC TanStack Query key: `[path, options]` or `[prefix, path, options]`. */
export function parseOperationKey(key: QueryKey): ParsedOperationKey | undefined {
  const [first, second, third] = key as unknown[]
  const path = typeof first === 'string' ? second : first
  const options = (typeof first === 'string' ? third : second) as
    | { type?: string; input?: unknown }
    | undefined
  if (!Array.isArray(path) || !path.every((segment) => typeof segment === 'string'))
    return undefined
  return { path, type: options?.type, input: options?.input }
}

/** Returns `[modelKey, operation]` when `path` is a ZenStack procedure under `root`. */
export function relativePath(
  path: readonly string[],
  root: readonly string[],
): string[] | undefined {
  if (path.length <= root.length) return undefined
  for (let i = 0; i < root.length; i++) if (path[i] !== root[i]) return undefined
  return path.slice(root.length)
}
