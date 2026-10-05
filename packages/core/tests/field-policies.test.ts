import { OpenAPIGenerator } from '@orpc/openapi'
import { createRouterClient, os } from '@orpc/server'
import { ZenStackClient } from '@zenstackhq/orm'
import { SqliteDialect } from '@zenstackhq/orm/dialects/sqlite'
import { PolicyPlugin } from '@zenstackhq/plugin-policy'
import SQLite from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryStorage, createZenStackRouter } from '../src'
import { isZenStackError } from '../src/client'
import { createZenStackOpenAPIRouter, ZenStackJsonSchemaConverter } from '../src/openapi-entry'
import { schema } from './fixtures/policies/zenstack/schema'

const storage = createMemoryStorage()
// Direct uploads: `presign` only checks access before signing.
const presignStorage = {
  ...storage,
  presignUpload: async () => ({
    key: 'Employee/contract/new',
    url: 'http://s3',
    method: 'PUT' as const,
    headers: {},
  }),
}
const router = createZenStackRouter(schema, {
  base: os.$context<{ db: any }>(),
  getDb: (ctx) => ctx.db,
  files: { storage: presignStorage },
})

let db: any
let authDb: any
let employeeId: string

const users = {
  alice: { id: 'alice', role: 'USER' }, // the employee
  bob: { id: 'bob', role: 'USER' },
  hr: { id: 'hr', role: 'HR' },
}

function clientFor(user: keyof typeof users) {
  return createRouterClient(router, { context: { db: authDb.$setAuth(users[user]) } })
}

/** `Employee.contract` procedures (typed by `createZenStackClient`, not by the router). */
function contractOf(user: keyof typeof users): any {
  return (clientFor(user) as any).employee.contract
}

const pdf = (name: string) => new File([name], `${name}.pdf`, { type: 'application/pdf' })

beforeEach(async () => {
  storage.files.clear()
  db = new ZenStackClient(schema, {
    dialect: new SqliteDialect({ database: new SQLite(':memory:') }),
  })
  await db.$pushSchema()
  authDb = db.$use(new PolicyPlugin())
  for (const user of Object.values(users)) await db.user.create({ data: user })
  const employee = await db.employee.create({
    data: { name: 'Alice', salary: 5000, userId: 'alice' },
  })
  employeeId = employee.id
})

describe('field-level policies', () => {
  it('reads fields hidden by their read policy as null', async () => {
    const where = { id: employeeId }
    expect(await clientFor('alice').employee.findUnique({ where })).toMatchObject({ salary: 5000 })
    expect(await clientFor('hr').employee.findUnique({ where })).toMatchObject({ salary: 5000 })
    expect(await clientFor('bob').employee.findUnique({ where })).toMatchObject({
      name: 'Alice',
      salary: null,
    })
  })

  it('rejects writes to fields their update policy denies', async () => {
    const where = { id: employeeId }
    const error = await clientFor('alice')
      .employee.update({ where, data: { salary: 9000 } })
      .catch((e: any) => e)
    expect(error.code).toBe('FORBIDDEN')
    expect(isZenStackError(error, 'rejected-by-policy')).toBe(true)

    // Other fields of the same record can be written.
    await clientFor('alice').employee.update({ where, data: { name: 'Alice B.' } })
    await clientFor('hr').employee.update({ where, data: { salary: 6000 } })
    expect(await db.employee.findUnique({ where })).toMatchObject({
      name: 'Alice B.',
      salary: 6000,
    })
  })

  it('rejects updates breaking a post-update rule, and rolls back their transaction', async () => {
    const where = { id: employeeId }
    await clientFor('hr').employee.update({ where, data: { status: 'validated' } })

    const error = await clientFor('hr')
      .employee.update({ where, data: { status: 'draft' } })
      .catch((e: any) => e)
    expect(error.code).toBe('FORBIDDEN')
    expect(isZenStackError(error, 'rejected-by-policy')).toBe(true)

    const inTransaction = await clientFor('hr')
      .$transaction([
        { model: 'Employee', op: 'update', args: { where, data: { name: 'Renamed' } } },
        { model: 'Employee', op: 'update', args: { where, data: { status: 'draft' } } },
      ])
      .catch((e: any) => e)
    expect(inTransaction.code).toBe('FORBIDDEN')
    expect(await db.employee.findUnique({ where })).toMatchObject({
      name: 'Alice',
      status: 'validated',
    })
  })

  it('applies field policies to @file fields', async () => {
    const where = { id: employeeId }
    const uploaded = await contractOf('hr').upload({ where, file: pdf('signed') })
    const key = uploaded.contract as string

    // Readable by the employee, hidden from others.
    expect(await (await contractOf('alice').get({ where })).text()).toBe('signed')
    const hidden = await contractOf('bob')
      .get({ where })
      .catch((e: any) => e)
    expect(hidden.code).toBe('NOT_FOUND')

    // Only HR may replace it: the rejected upload is deleted from the storage.
    const rejected = await contractOf('alice')
      .upload({ where, file: pdf('forged') })
      .catch((e: any) => e)
    expect(rejected.code).toBe('FORBIDDEN')
    expect([...storage.files.keys()]).toEqual([key])
    const removal = await contractOf('alice')
      .remove({ where })
      .catch((e: any) => e)
    expect(removal.code).toBe('FORBIDDEN')

    // `presign` checks the field's update policy before signing.
    const presign = { where, name: 'c.pdf', type: 'application/pdf', size: 10 }
    expect(
      (
        await contractOf('alice')
          .presign(presign)
          .catch((e: any) => e)
      ).code,
    ).toBe('FORBIDDEN')
    expect(await contractOf('hr').presign(presign)).toMatchObject({
      key: 'Employee/contract/new',
    })
  })

  it("deletes the replaced file of a field its writer can't read", async () => {
    const where = { id: employeeId }
    const review = (user: keyof typeof users) => (clientFor(user) as any).employee.review
    const first = await review('alice').upload({ where, file: pdf('first') })
    expect(first.review).toBeNull() // written, but not readable by Alice
    const [firstKey] = [...storage.files.keys()]

    await review('alice').upload({ where, file: pdf('second') })
    const keys = [...storage.files.keys()]
    expect(keys).toHaveLength(1)
    expect(keys).not.toContain(firstKey)
    expect(await (await review('hr').get({ where })).text()).toBe('second')

    await review('alice').remove({ where })
    expect(storage.files.size).toBe(0)
  })

  it('documents field policies in OpenAPI', async () => {
    const rest = createZenStackOpenAPIRouter(schema, {
      getDb: (ctx: any) => ctx.db,
      files: { storage },
    })
    const spec: any = await new OpenAPIGenerator({
      converters: [new ZenStackJsonSchemaConverter(rest)],
    }).generate(rest)
    expect(spec.paths['/employees'].get.description).toBe(
      'Access policies: allow `read`, allow `create,update`, deny `post-update`.\n\n' +
        'Field policies: `salary` (allow `read`, allow `update`), `contract` (allow `read`, allow `update`), `review` (allow `read`).',
    )
  })
})
