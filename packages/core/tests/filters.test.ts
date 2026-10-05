import { describe, expect, it } from 'vitest'
import { matchesWhere, orderComparator, reconcileOptimistic } from '../src/tanstack-query/filters'
import { schema as sqlite } from './fixtures/zenstack/schema'

const postgres = { ...sqlite, provider: { type: 'postgresql' } } as unknown as typeof sqlite
const post = { id: 'p1', title: 'Hello World', views: 10, published: false, content: null }
const createdAt = new Date('2026-01-02T00:00:00Z')

describe('matchesWhere', () => {
  const match = (where: unknown, record: Record<string, unknown> = post, schema = sqlite) =>
    matchesWhere(schema, 'Post', record, where)

  it('evaluates scalar filters', () => {
    expect(match({ published: false })).toBe(true)
    expect(match({ published: true })).toBe(false)
    expect(match({ views: { gt: 5, lte: 10 } })).toBe(true)
    expect(match({ views: { in: [1, 2] } })).toBe(false)
    expect(match({ views: { notIn: [1, 2] } })).toBe(true)
    expect(match({ content: null })).toBe(true)
    expect(match({ content: { not: null } })).toBe(false)
    // `col <> x` and comparisons exclude nulls, like in SQL.
    expect(match({ content: { not: 'x' } })).toBe(false)
    expect(match({ createdAt: { gte: '2026-01-01T00:00:00Z' } }, { ...post, createdAt })).toBe(true)
    expect(match({ OR: [{ views: 1 }, { published: false }], NOT: { title: 'x' } })).toBe(true)
    expect(match({ AND: [{ views: 10 }, { published: true }] })).toBe(false)
  })

  it('follows the case rules of the database', () => {
    // SQLite's `LIKE` ignores ASCII case, PostgreSQL's doesn't.
    expect(match({ title: { contains: 'hello' } })).toBe(true)
    expect(match({ title: { contains: 'hello' } }, post, postgres)).toBe(false)
    expect(match({ title: { contains: 'hello', mode: 'insensitive' } }, post, postgres)).toBe(true)
    expect(match({ title: { startsWith: 'Hello' }, views: 10 }, post, postgres)).toBe(true)
    expect(match({ title: { equals: 'hello world', mode: 'insensitive' } })).toBe(true)
    expect(match({ title: 'hello world' })).toBe(false)
  })

  it("can't tell for what it can't evaluate in memory", () => {
    expect(match({ author: { is: { name: 'Alice' } } })).toBeUndefined()
    expect(match({ title: { lt: 'B' } })).toBeUndefined() // collation
    expect(match({ title: { fuzzy: { search: 'x' } } })).toBeUndefined()
    expect(match({ updatedAt: { gt: createdAt } })).toBeUndefined() // missing field
    expect(match({ views: 1 }, { ...post, views: { increment: 1 } })).toBeUndefined()
    // ...unless the rest decides.
    expect(match({ published: true, author: { is: { name: 'Alice' } } })).toBe(false)
    expect(match({ OR: [{ published: false }, { author: { is: {} } }] })).toBe(true)
    // MySQL collations ignore case for every string comparison.
    const mysql = { ...sqlite, provider: { type: 'mysql' } } as unknown as typeof sqlite
    expect(match({ title: 'Hello World' }, post, mysql)).toBeUndefined()
  })
})

describe('orderComparator', () => {
  const sort = (orderBy: unknown, records: Record<string, unknown>[], schema = sqlite) => {
    const compare = orderComparator(schema, 'Post', orderBy)
    if (!compare) return undefined
    return [...records].sort((a, b) => compare(a, b) ?? 0).map((record) => record.id)
  }
  const records = [
    { id: 'a', views: 2, content: null, title: 'b' },
    { id: 'b', views: 1, content: 'x', title: 'a' },
    { id: 'c', views: 2, content: 'y', title: 'c' },
  ]

  it('sorts by scalar fields, with the null ordering of the database', () => {
    expect(sort({ views: 'desc' }, records)).toEqual(['a', 'c', 'b'])
    expect(sort([{ views: 'asc' }, { title: 'desc' }], records)).toEqual(['b', 'c', 'a'])
    // Nulls: smallest on SQLite, largest on PostgreSQL, or as requested.
    expect(sort({ content: 'asc' }, records)).toEqual(['a', 'b', 'c'])
    expect(sort({ content: 'asc' }, records, postgres)).toEqual(['b', 'c', 'a'])
    expect(sort({ content: { sort: 'asc', nulls: 'last' } }, records)).toEqual(['b', 'c', 'a'])
  })

  it("doesn't sort by relations, counts or relevance", () => {
    expect(orderComparator(sqlite, 'Post', { author: { name: 'asc' } })).toBeUndefined()
    expect(orderComparator(sqlite, 'User', { posts: { _count: 'asc' } })).toBeUndefined()
    expect(orderComparator(sqlite, 'Post', { _fuzzyRelevance: {} })).toBeUndefined()
  })
})

describe('reconcileOptimistic', () => {
  it('treats the unset optional fields of a created record as null', () => {
    const created = { id: 'new', title: 'x', published: false, $optimistic: true }
    const reconcile = (where: unknown) =>
      reconcileOptimistic(sqlite, 'Post', 'findMany', { where }, [], [created], [created])
    expect(reconcile({ content: null })).toEqual([created])
    expect(reconcile({ content: { not: null } })).toEqual([])
    // Fields with a default aren't guessed.
    expect(reconcile({ views: 0 })).toBeUndefined()
  })
})
