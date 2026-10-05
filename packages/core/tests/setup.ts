import { PGlite } from '@electric-sql/pglite'
import { type ClientContract, ZenStackClient } from '@zenstackhq/orm'
import { SqliteDialect } from '@zenstackhq/orm/dialects/sqlite'
import { PolicyPlugin } from '@zenstackhq/plugin-policy'
import SQLite from 'better-sqlite3'
import { PGliteDialect } from 'kysely-pglite-dialect'
import { schema as sqliteSchema } from './fixtures/zenstack/schema'

/**
 * Database the tests run on: `sqlite` (default) or `postgres` (PGlite, an in-process Postgres).
 * `TEST_DB=postgres bun run test`.
 */
export const TEST_DB = process.env.TEST_DB === 'postgres' ? 'postgres' : 'sqlite'

/** The fixture schema, with the provider of the test database. */
export const schema: typeof sqliteSchema =
  TEST_DB === 'postgres'
    ? ({ ...sqliteSchema, provider: { type: 'postgresql' } } as any)
    : sqliteSchema

/** Postgres logs, written like SQLite's so tests can assert the same statements. */
function normalizePostgresSql(sql: string) {
  return sql
    .replace(/^start transaction.*$/, 'begin')
    .replace(/"public"\./g, '')
    .replace(/ as "(\w+)"/g, (match, alias, offset, all) =>
      all.slice(0, offset).endsWith(`"${alias}"`) ? '' : match,
    )
}

/** Implementations of the fixture's `@computed` fields. */
export const computedFields = {
  user: {
    postCount: (eb: any, { modelAlias }: { modelAlias: string }) =>
      eb
        .selectFrom('Post')
        .whereRef('Post.authorId', '=', `${modelAlias}.id`)
        .select(({ fn }: any) => fn.countAll().as('count')),
  },
}

/** `view PostStats` (`$pushSchema` creates tables only). */
const POST_STATS_VIEW = `create view "PostStats" as select "authorId", count(*) as "posts" from "Post" group by "authorId"`

/** Creates an empty database with the fixture schema. */
export async function createTestDb(
  plugins: any[] = [],
  options: { onQuery?: (sql: string) => void } = {},
) {
  let db: any =
    TEST_DB === 'postgres'
      ? new ZenStackClient(schema, {
          computedFields,
          dialect: new PGliteDialect(new PGlite()),
          log: (event) => {
            if (event.level === 'query') options.onQuery?.(normalizePostgresSql(event.query.sql))
          },
        })
      : new ZenStackClient(schema, {
          computedFields,
          dialect: new SqliteDialect({
            database: new SQLite(':memory:', {
              verbose: (sql) => options.onQuery?.(String(sql)),
            }),
          }),
        })
  await db.$pushSchema()
  await db.$executeRawUnsafe(POST_STATS_VIEW)
  for (const plugin of plugins) db = db.$use(plugin)
  const authDb = db.$use(new PolicyPlugin())
  return {
    db: db as ClientContract<typeof schema>,
    authDb: authDb as ClientContract<typeof schema>,
  }
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>['db']
