import { createORPCClient } from '@orpc/client'
import type { RouterClient } from '@orpc/server'
import { os } from '@orpc/server'
import { describe, expectTypeOf, it } from 'vitest'
import { createZenStackRouter } from '../src'
import { createZenStackClient } from '../src/client'
import { createZenStackQueryUtils } from '../src/tanstack-query'
import { schema } from './fixtures/large/zenstack/schema'

// 40 chained models (M0 -> M1 -> ... -> M39) with a many-to-many `tags` relation each: router,
// client and query utils types must stay within TypeScript's instantiation limits.
const base = os.$context<{ db: any }>()
const router = base.router({ db: createZenStackRouter(schema, { base, getDb: (ctx) => ctx.db }) })
const raw = createORPCClient<RouterClient<typeof router>>(null as any)
const client = createZenStackClient(raw, { schema, path: 'db' })
const orpc = createZenStackQueryUtils(raw, { schema, path: 'db' })

describe('large schema', () => {
  it('infers deeply nested includes', async () => {
    const rows = await client.db.m0.findMany({
      include: {
        tags: true,
        children: {
          include: {
            children: {
              include: {
                children: {
                  include: { children: { select: { f0: true, tags: { select: { name: true } } } } },
                },
              },
            },
          },
        },
      },
    })
    const leaf = rows[0].children[0].children[0].children[0].children[0]
    expectTypeOf(leaf).toEqualTypeOf<{ f0: string; tags: { name: string }[] }>()
    expectTypeOf(rows[0].tags[0].name).toEqualTypeOf<string>()
  })

  it('types every model of the router', async () => {
    const last = await client.db.m39.findFirst({
      include: { parent: { include: { parent: true } } },
    })
    expectTypeOf(last?.parent.parent.f1).toEqualTypeOf<number | undefined>()

    const options = orpc.db.m20.findMany.queryOptions({
      input: { where: { f2: true }, select: { id: true, children: { select: { id: true } } } },
    })
    type Row = Awaited<ReturnType<NonNullable<typeof options.queryFn> & {}>>[number]
    expectTypeOf<Row['id']>().toEqualTypeOf<string>()
    expectTypeOf<Row['children']>().toEqualTypeOf<{ id: string }[]>()
    expectTypeOf<Row>().not.toHaveProperty('f0')
  })
})
