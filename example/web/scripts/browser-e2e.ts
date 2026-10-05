// End-to-end check of the example in a real browser (Chromium), with two users. Run the server and
// the web app, then: `bun run e2e:browser` (APP=http://localhost:5173 by default; HEADED=1 to watch).
// Install the browser once with `bunx playwright install chromium`.
//
// Works with both storages: the local disk (uploads through the server) and a bucket (direct
// uploads). To try the bucket path locally, run `bun run fake-s3` and start the server with
// `S3_BUCKET_URL=http://localhost:9000/bucket S3_ACCESS_KEY_ID=id S3_SECRET_ACCESS_KEY=secret`.

import { chromium, type Page } from 'playwright'

const app = process.env.APP ?? 'http://localhost:5173'
const run = Date.now()
const log = (...args: unknown[]) =>
  console.log(`[${((Date.now() - run) / 1000).toFixed(1)}s]`, ...args)
const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`FAILED: ${what}`)
  log('ok -', what)
}

const browser = await chromium.launch({ headless: !process.env.HEADED })
const problems: string[] = []

async function signUp(name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage()
  page.on('pageerror', (error) => problems.push(`${name}: ${error.message}`))
  page.on('response', (response) => {
    const url = new URL(response.url())
    // Expected: the invalid todo below, and `presign` without a bucket (falls back to `upload`).
    const expected =
      (response.status() === 400 && url.pathname === '/rpc/db/todo/create') ||
      (response.status() === 501 && url.pathname === '/rpc/db/photo/image/presign')
    if (response.status() >= 400 && !expected)
      problems.push(`${name}: ${response.status()} ${response.request().method()} ${url}`)
  })
  await page.goto(app)
  await page.getByText('No account? Sign up').click()
  await page.getByPlaceholder('Name').fill(name)
  await page.getByPlaceholder('Email').fill(`${name.toLowerCase()}-${run}@example.com`)
  await page.getByPlaceholder('Password').fill('password1234')
  await page.getByRole('button', { name: 'Sign up' }).click()
  await page.getByRole('heading', { name: /Todos/ }).waitFor()
  return page
}

try {
  const alice = await signUp('Alice')
  const bob = await signUp('Bob')

  // --- Todos: optimistic writes, archive in a transaction, error messages ------------------------
  const input = alice.getByPlaceholder('What needs to be done?')
  for (const title of ['Buy milk', 'Write docs', 'Ship it']) {
    await input.fill(title)
    await input.press('Enter')
  }
  await alice.locator('li:not(.optimistic)', { hasText: 'Ship it' }).waitFor()
  for (const title of ['Buy milk', 'Write docs']) {
    const item = alice.locator('li', { hasText: title })
    await item.getByRole('checkbox').click()
    await item.locator('.done').waitFor()
  }
  await alice.getByText('(1 left)').waitFor()
  check(true, 'todos created and toggled')

  await alice.getByRole('button', { name: 'Archive done (2)' }).click()
  await alice.locator('li', { hasText: 'Buy milk' }).waitFor({ state: 'detached' })
  check((await alice.locator('section li').count()) === 1, 'archived todos left the list')

  await input.fill('x'.repeat(201))
  await input.press('Enter')
  const error = (await alice.locator('.error').textContent()) ?? ''
  check(error.startsWith('title:'), `validation error shown (${error})`)

  // --- Posts: the archive draft, image upload, live updates, ETag revalidation -----------------
  await alice.getByRole('link', { name: 'Posts' }).click()
  const draft = alice.locator('li', { hasText: 'Completed 2 todos' })
  await draft.waitFor()
  const draftText = (await draft.textContent()) ?? ''
  check(
    draftText.includes('draft') && draftText.includes('2 archived todos'),
    'the archive created a draft holding the 2 todos',
  )

  await bob.getByRole('link', { name: 'Posts' }).click()
  await bob.getByRole('heading', { name: 'Posts' }).waitFor()

  const uploads: string[] = []
  const images: number[] = []
  alice.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/rpc/db/photo/image/'))
      uploads.push(url.pathname.split('/').pop() ?? '')
    if (request.method() === 'PUT' && url.origin !== new URL(app).origin) uploads.push('PUT bucket')
  })
  alice.on('response', (response) => {
    if (new URL(response.url()).pathname.endsWith('/image')) images.push(response.status())
  })

  const png = await alice.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 120
    canvas.height = 60
    const context = canvas.getContext('2d') as CanvasRenderingContext2D
    context.fillStyle = '#2a7'
    context.fillRect(0, 0, 120, 60)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  await alice.getByLabel('Kind').selectOption('Photo')
  await alice.getByPlaceholder('Title').fill('Hello with an image')
  await alice.locator('input[type=file]').setInputFiles({
    name: 'hello.png',
    mimeType: 'image/png',
    buffer: Buffer.from(png, 'base64'),
  })
  await alice.getByRole('button', { name: 'Publish' }).click()
  const image = alice.locator('li', { hasText: 'Hello with an image' }).locator('img')
  await image.waitFor()
  await alice.waitForFunction(
    (element) =>
      (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0,
    await image.elementHandle(),
  )
  const direct = uploads.includes('PUT bucket')
  check(
    direct ? uploads.includes('confirm') : uploads.includes('upload'),
    `image uploaded ${direct ? 'straight to the bucket' : 'through the server'} and displayed (${uploads.join(' → ')})`,
  )

  const bobPost = bob.locator('li', { hasText: 'Hello with an image' })
  await bobPost.locator('img').waitFor({ timeout: 5000 })
  check(true, 'Bob sees the new photo live, with its image')
  check(
    (await bob.locator('li', { hasText: 'Completed 2 todos' }).count()) === 0,
    "Bob doesn't see Alice's draft",
  )

  await alice.reload()
  await alice.locator('li', { hasText: 'Hello with an image' }).locator('img').waitFor()
  await alice.waitForTimeout(500)
  check(
    direct ? images.every((status) => status === 302) : images.at(-1) === 304,
    `image ${direct ? 'redirected to signed URLs' : 'revalidated with its ETag'} (${images.join(', ')})`,
  )

  await alice
    .locator('li', { hasText: 'Hello with an image' })
    .getByRole('button', { name: 'Delete' })
    .click()
  await bobPost.waitFor({ state: 'detached', timeout: 5000 })
  check(true, 'the deletion reached Bob live')

  // --- Chat: live infinite query (pages refetched only when needed) ------------------------------
  const room = `room-${run}`
  await alice.getByRole('link', { name: 'Chat' }).click()
  await alice.getByPlaceholder('New room').fill(room)
  await alice.getByPlaceholder('New room').press('Enter')
  await alice.getByRole('button', { name: `#${room}` }).waitFor()
  const message = alice.getByPlaceholder('Message')
  for (let i = 1; i <= 12; i++) {
    await message.fill(`msg ${i}`)
    await message.press('Enter')
    await alice.locator('.message', { hasText: `msg ${i}` }).waitFor()
  }
  check(true, 'Alice sent 12 messages')

  const reads: string[] = []
  bob.on('request', (request) => {
    if (new URL(request.url()).pathname === '/rpc/db/message/findMany') reads.push(request.url())
  })
  const readsDuring = async (action: () => Promise<void>) => {
    await bob.waitForTimeout(300)
    const before = reads.length
    await action()
    await bob.waitForTimeout(500) // let late refetches land
    return reads.length - before
  }
  await bob.getByRole('link', { name: 'Chat' }).click()
  await bob.getByRole('button', { name: `#${room}` }).click()
  await bob.locator('.message', { hasText: 'msg 12' }).waitFor()
  check((await bob.locator('.message').count()) === 10, 'Bob sees the last page (10 messages)')
  await bob.getByRole('button', { name: 'Load older messages' }).click()
  await bob.locator('.page').nth(1).waitFor()
  check((await bob.locator('.message').count()) === 12, 'Bob loaded the older page')

  const editMessage = async (from: string, to: string) => {
    alice.once('dialog', (dialog) => dialog.accept(to))
    await alice
      .locator(`.message:has(.text:text-is("${from}"))`)
      .getByRole('button', { name: 'Edit' })
      .click()
    await bob.locator(`.message:has(.text:text-is("${to}"))`).waitFor({ timeout: 5000 })
  }
  let count = await readsDuring(() => editMessage('msg 12', 'msg 12 (fixed)'))
  check(count === 1, `an edit in the newest page refetches that page only (${count} request)`)
  await alice.getByRole('button', { name: 'Load older messages' }).click()
  await alice.locator('.page').nth(1).waitFor()
  count = await readsDuring(() => editMessage('msg 2', 'msg 2 (fixed)'))
  check(count === 1, `an edit in an older page refetches that page only (${count} request)`)

  count = await readsDuring(async () => {
    await alice
      .locator('.message', { hasText: 'msg 11' })
      .getByRole('button', { name: 'Delete' })
      .click()
    await bob.locator('.message', { hasText: 'msg 11' }).waitFor({ state: 'detached' })
  })
  check(count === 2, `a deletion refetches the loaded pages (${count} requests)`)

  count = await readsDuring(async () => {
    await alice.getByPlaceholder('New room').fill(`${room}-other`)
    await alice.getByPlaceholder('New room').press('Enter')
    await alice.getByRole('button', { name: `#${room}-other` }).waitFor()
    await message.fill('elsewhere')
    await message.press('Enter')
    await alice.locator('.message', { hasText: 'elsewhere' }).waitFor()
  })
  check(count === 0, `messages of another room don't refetch Bob's room (${count} requests)`)

  check(
    problems.length === 0,
    `no unexpected browser errors ${problems.length ? `\n${problems.join('\n')}` : ''}`,
  )
} finally {
  await browser.close()
}
