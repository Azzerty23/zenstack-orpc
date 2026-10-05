const SEARCH_KEYS = new Set(['fuzzy', 'fts', '_fuzzyRelevance', '_ftsRelevance'])

/** Whether query args use fuzzy or full-text search (filters or relevance ordering), at any depth. */
export function usesSearch(args: unknown): boolean {
  if (Array.isArray(args)) return args.some(usesSearch)
  if (!args || typeof args !== 'object' || args instanceof Date) return false
  return Object.entries(args).some(([key, value]) => SEARCH_KEYS.has(key) || usesSearch(value))
}
