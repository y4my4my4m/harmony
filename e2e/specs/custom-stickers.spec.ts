// Journey: custom stickers (20261031200001_custom_stickers.sql).
//
// A server owner uploads a sticker in Server settings › Stickers; a member without Manage
// Expressions sees no form and is refused by storage and create_sticker. The member sends the
// sticker with typed text from the GIF picker's Stickers tab: one message, the sticker drawn
// large with its description as alt text, its image fallback hidden.
//
// Refusals: an animation over 5 s and an SVG never leave the page; the stickers bucket refuses
// an SVG and a 600 KB file sent past the app; a page holding a stale cap is refused by
// enforce_sticker_limit and its object removed.
//
// Personal stickers are off by default (form absent, storage refuses); an admin sets the cap in
// Admin › Config and the member uploads and finds it in the picker. An admin adds an instance
// sticker in Admin › Stickers that members find by searching; members cannot add one.
//
// A member reports a sticker from a message; staff remove it from Admin › Reports, and the
// message shows the removed placeholder.
//
// instance_config is snapshotted before and restored after: the admin form saves every key.

import { randomUUID } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
  composer,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  openChannel,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'
import { expectNoAxeViolations } from './a11y'

test.describe.configure({ mode: 'serial' })

const admin = adminClient()
// A full page load boots the app again; on a cold dev server under load that takes most of a minute.
const BOOT_MS = 60_000
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

/** A 1×1 GIF with one frame per delay, in centiseconds. */
function gif(delays: number[]): Buffer {
  const frame = (cs: number) => [
    0x21, 0xf9, 0x04, 0x00, cs & 255, cs >> 8, 0x00, 0x00,
    0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00,
    0x02, 0x02, 0x44, 0x01, 0x00,
  ]
  return Buffer.from([
    ...Buffer.from('GIF89a'), 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255,
    ...delays.flatMap(frame), 0x3b,
  ])
}

let owner: SpecUser
let member: SpecUser
let staff: SpecUser
let server: SeededServer
let configSnapshot: Array<{ config_key: string; config_value: unknown; description: string | null }> = []

test.beforeAll(async () => {
  const { data, error } = await admin.from('instance_config').select('config_key, config_value, description')
  if (error || !data) throw new Error(`snapshot instance_config: ${error?.message}`)
  configSnapshot = data
  // Defaults of 20261031200001 (pgTAP 206 checks the seeded values); a run that ended early leaves others.
  await setCap('max_stickers_per_server', 15)
  await setCap('max_instance_stickers', 50)
  await setCap('max_personal_stickers_per_user', 0)
  owner = await createUser(admin, 'stko')
  member = await createUser(admin, 'stkm')
  staff = await createUser(admin, 'stka')
  const { error: promoteError } = await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  if (promoteError) throw new Error(`promote ${staff.username}: ${promoteError.message}`)
  server = await seedServer(admin, owner, `Stickers ${owner.username}`)
  await addMember(admin, member, server.id)
})

test.afterAll(async () => {
  const keys = new Set(configSnapshot.map((row) => row.config_key))
  const { data: now } = await admin.from('instance_config').select('config_key')
  const added = (now ?? []).map((row) => row.config_key).filter((key) => !keys.has(key))
  if (added.length) await admin.from('instance_config').delete().in('config_key', added)
  if (configSnapshot.length) await admin.from('instance_config').upsert(configSnapshot, { onConflict: 'config_key' })
  const users = [owner, member, staff].filter(Boolean)
  const { data: rows } = await admin.from('stickers').select('id, path').in('uploader', users.map((u) => u.id))
  if (rows?.length) {
    await admin.from('stickers').delete().in('id', rows.map((r) => r.id))
    await admin.storage.from('stickers').remove(rows.map((r) => r.path))
  }
  for (const user of users) await deleteUser(admin, user)
})

async function setCap(key: string, value: number) {
  const { error } = await admin.from('instance_config').update({ config_value: value }).eq('config_key', key)
  if (error) throw new Error(`${key}: ${error.message}`)
}

async function stubKlipy(page: Page) {
  await page.route('**/api/federation/gifs/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], page: 1, hasNext: false }) }),
  )
}

async function pick(page: Page, file: { name: string; mimeType: string; buffer: Buffer }, scope: string) {
  const library = page.getByTestId(`${scope}-sticker-library`)
  await library.getByTestId('sticker-upload-input').setInputFiles(file)
  return library
}

async function upload(page: Page, scope: string, file: { name: string; mimeType: string; buffer: Buffer }, name: string, description: string) {
  const library = await pick(page, file, scope)
  await library.getByTestId('sticker-name-input').fill(name)
  await library.getByTestId('sticker-description-input').fill(description)
  await library.getByTestId('sticker-upload-button').click()
  return library
}

async function openStickerTab(page: Page) {
  await page.locator('[data-testid="message-input"]').getByTestId('composer-gif').click()
  const picker = page.getByRole('dialog', { name: 'GIFs, stickers and emoji' })
  await expect(picker).toBeVisible({ timeout: 15000 })
  await picker.getByRole('tab', { name: 'Stickers' }).click()
  return picker
}

test('an owner uploads a server sticker; a member sends it with text and it renders large', async ({ page, browser }) => {
  test.setTimeout(240_000)

  await test.step('the owner uploads in Server settings › Stickers', async () => {
    await signIn(page, owner)
    await page.goto(`/server/${server.id}?section=stickers`)
    const section = page.getByTestId('server-stickers')
    await expect(section.getByTestId('sticker-count')).toHaveText('0 / 15', { timeout: BOOT_MS })
    const library = await pick(page, { name: 'cat_wave.png', mimeType: 'image/png', buffer: PNG }, 'server')
    await expect(library.getByTestId('sticker-name-input')).toHaveValue('cat wave')
    await library.getByTestId('sticker-name-input').fill('Cat wave')
    await library.getByTestId('sticker-description-input').fill('A cat waving')
    await library.getByTestId('sticker-upload-button').click()
    await expect(page.locator('.Vue-Toastification__toast--success').filter({ hasText: 'Sticker "Cat wave" added' })).toBeVisible({ timeout: 20000 })
    await expect(section.getByTestId('sticker-count')).toHaveText('1 / 15')
    await expect(section.getByTestId('sticker-row').filter({ hasText: 'Cat wave' })).toContainText('A cat waving')
    await expectNoAxeViolations(page, { include: '[data-testid="server-stickers"]', label: 'server settings stickers' })
  })

  const { data: rows } = await admin.from('stickers').select('scope, server_id, owner_id, name, description, path, url, mime_type, width, height, duration_ms').eq('server_id', server.id)
  expect(rows).toHaveLength(1)
  expect(rows![0]).toMatchObject({ scope: 'server', owner_id: null, name: 'Cat wave', description: 'A cat waving', mime_type: 'image/png', width: 1, height: 1, duration_ms: null })
  expect(rows![0].path).toMatch(new RegExp(`^server/${server.id}/[0-9a-f-]{36}\\.png$`))
  expect(rows![0].url).toMatch(new RegExp(`/storage/v1/object/public/stickers/${rows![0].path}$`))

  await test.step('a member without Manage Expressions has no form and is refused', async () => {
    const memberDb = await userClient(member)
    const refusedObject = await memberDb.storage.from('stickers').upload(`server/${server.id}/${randomUUID()}.png`, PNG, { contentType: 'image/png' })
    expect(refusedObject.error).toBeTruthy()
    const refusedRow = await memberDb.rpc('create_sticker', {
      p_scope: 'server', p_server_id: server.id, p_path: rows![0].path, p_url: rows![0].url,
      p_name: 'stolen', p_description: 'x', p_width: 1, p_height: 1,
    })
    expect(refusedRow.error?.code).toBe('42501')

    const context = await browser.newContext()
    try {
      const memberPage = await context.newPage()
      await signIn(memberPage, member)
      await memberPage.goto(`/server/${server.id}?section=stickers`)
      const section = memberPage.getByTestId('server-stickers')
      await expect(section.getByTestId('sticker-row')).toHaveCount(1, { timeout: BOOT_MS })
      await expect(section.getByTestId('sticker-upload-form')).toHaveCount(0)
      await expect(section.getByTestId('sticker-delete')).toHaveCount(0)
    } finally {
      await context.close()
    }
  })

  await test.step('the member sends it with typed text from the Stickers tab', async () => {
    const context = await browser.newContext()
    try {
      const memberPage = await context.newPage()
      await stubKlipy(memberPage)
      await signIn(memberPage, member)
      await openChannel(memberPage, server.id, server.generalChannelId)
      await dismissAnnouncements(memberPage)
      await composer(memberPage).click()
      await memberPage.keyboard.type('hello sticker')
      const picker = await openStickerTab(memberPage)
      const own = picker.getByTestId('custom-stickers-server')
      await expect(own.getByRole('heading', { name: server.name })).toBeVisible({ timeout: 15000 })
      await own.getByRole('button', { name: 'Send sticker Cat wave: A cat waving' }).click()
      await expect(picker).toBeHidden()

      const row = messageList(memberPage).locator('.message-item').filter({ hasText: 'hello sticker' })
      await expect(row).toBeVisible({ timeout: 20000 })
      const img = row.getByTestId('message-sticker').locator('img')
      await expect(img).toHaveAttribute('alt', 'Sticker Cat wave: A cat waving')
      await expect(img).toHaveJSProperty('complete', true)
      // The pending row is replaced by the stored one; the size is read once that settles.
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.getBoundingClientRect().width)).toBe(160)
      await expect(row.locator('.content-image')).toHaveCount(0)
      await expect(composer(memberPage)).toHaveText('')
      await expectNoAxeViolations(memberPage, { include: '[data-testid="message-sticker"]', label: 'sticker in a message' })
    } finally {
      await context.close()
    }
  })

  const { data: messages } = await admin.from('messages').select('content').eq('channel_id', server.generalChannelId).eq('user_id', member.id)
  expect(messages).toHaveLength(1)
  const content = messages![0].content as Array<Record<string, unknown>>
  expect(content.map((p) => p.type)).toEqual(['text', 'sticker', 'file'])
  expect(content[1]).toMatchObject({ name: 'Cat wave', description: 'A cat waving', url: rows![0].url })
  expect(content[2]).toMatchObject({ fileType: 'image', url: rows![0].url, altText: 'A cat waving', stickerId: content[1].id })
})

test('refusals: long animation, SVG, oversized files and a stale cap', async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page, owner)
  await page.goto(`/server/${server.id}?section=stickers`)
  const section = page.getByTestId('server-stickers')
  await expect(section.getByTestId('sticker-count')).toHaveText('1 / 15', { timeout: BOOT_MS })
  const error = section.getByTestId('sticker-upload-error')

  await test.step('the page refuses an animation over 5 s and an SVG', async () => {
    await upload(page, 'server', { name: 'long.gif', mimeType: 'image/gif', buffer: gif([300, 300]) }, 'long', 'A long animation')
    await expect(error).toHaveText('That animation runs 6.0 s; the limit is 5 s.', { timeout: 15000 })
    await upload(page, 'server', { name: 'vector.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') }, 'vector', 'A vector')
    await expect(error).toHaveText('A sticker is a PNG, APNG, WebP or GIF image.', { timeout: 15000 })
    const { data } = await admin.storage.from('stickers').list(`server/${server.id}`)
    expect(data).toHaveLength(1)
  })

  await test.step('the bucket refuses an SVG and a 600 KB file sent past the app', async () => {
    const ownerDb = await userClient(owner)
    const svg = await ownerDb.storage.from('stickers').upload(`server/${server.id}/${randomUUID()}.png`, Buffer.from('<svg/>'), { contentType: 'image/svg+xml' })
    expect(svg.error).toBeTruthy()
    const big = await ownerDb.storage.from('stickers').upload(`server/${server.id}/${randomUUID()}.png`, Buffer.alloc(600 * 1024, 1), { contentType: 'image/png' })
    expect(big.error).toBeTruthy()
  })

  await test.step('a page holding a stale cap is refused by the database', async () => {
    await setCap('max_stickers_per_server', 1)
    await upload(page, 'server', { name: 'second.png', mimeType: 'image/png', buffer: PNG }, 'Second', 'Another sticker')
    await expect(error).toHaveText('Sticker limit reached (1).', { timeout: 20000 })
    expect((await admin.from('stickers').select('id').eq('server_id', server.id)).data).toHaveLength(1)
    await expect.poll(async () => (await admin.storage.from('stickers').list(`server/${server.id}`)).data?.length).toBe(1)
    await page.reload()
    await expect(section.getByTestId('sticker-cap-reached')).toHaveText('Sticker limit reached (1).', { timeout: BOOT_MS })
    await setCap('max_stickers_per_server', 15)
  })
})

test('personal stickers are off by default; an admin allows them and the member uses one', async ({ page, browser }) => {
  test.setTimeout(240_000)
  await stubKlipy(page)
  await signIn(page, member)

  await test.step('off: no form, and storage refuses the folder', async () => {
    await page.goto('/settings/stickers')
    const section = page.getByTestId('user-stickers')
    await expect(section.getByTestId('sticker-uploads-off')).toHaveText(
      'Personal stickers are turned off on this instance. An admin can allow them.', { timeout: BOOT_MS })
    await expect(section.getByTestId('sticker-upload-form')).toHaveCount(0)
    const refused = await (await userClient(member)).storage.from('stickers').upload(`user/${member.id}/${randomUUID()}.png`, PNG, { contentType: 'image/png' })
    expect(refused.error).toBeTruthy()
  })

  await test.step('the admin saves Personal stickers per user = 1', async () => {
    const context = await browser.newContext()
    try {
      const adminPage = await context.newPage()
      await signIn(adminPage, staff)
      await adminPage.goto('/admin?tab=config')
      await adminPage.locator('.config-tab-btn', { hasText: 'Federation' }).click()
      const field = adminPage.getByLabel('Personal stickers per user')
      await expect(field).toHaveValue('0', { timeout: BOOT_MS })
      await expect(adminPage.locator('#max-personal-stickers-hint')).toContainText('turns personal stickers off')
      await field.fill('1')
      await adminPage.locator('.config-section').getByRole('button', { name: 'Save changes' }).click()
      await expect(adminPage.locator('.Vue-Toastification__toast--success').filter({ hasText: 'Configuration saved' })).toBeVisible({ timeout: 20000 })
    } finally {
      await context.close()
    }
    await expect.poll(async () => Number((await admin.rpc('sticker_limit', { p_scope: 'user' })).data)).toBe(1)
  })

  await test.step('the member uploads one and finds it in the picker', async () => {
    await page.reload()
    const section = page.getByTestId('user-stickers')
    await expect(section.getByTestId('sticker-count')).toHaveText('0 / 1', { timeout: BOOT_MS })
    await upload(page, 'user', { name: 'me.png', mimeType: 'image/png', buffer: PNG }, 'Me waving', 'Me, waving hello')
    await expect(section.getByTestId('sticker-count')).toHaveText('1 / 1', { timeout: 20000 })
    await expect(section.getByTestId('sticker-cap-reached')).toBeVisible()
    const { data } = await admin.from('stickers').select('scope, owner_id, path').eq('owner_id', member.id)
    expect(data).toEqual([{ scope: 'user', owner_id: member.id, path: expect.stringMatching(new RegExp(`^user/${member.id}/`)) }])

    await openChannel(page, server.id, server.generalChannelId)
    await dismissAnnouncements(page)
    const picker = await openStickerTab(page)
    await expect(picker.getByTestId('custom-stickers-user').getByRole('button', { name: 'Send sticker Me waving: Me, waving hello' })).toBeVisible({ timeout: 15000 })
  })
})

test('an admin adds an instance sticker that members find by search; members cannot add one', async ({ page, browser }) => {
  test.setTimeout(240_000)

  await test.step('the admin uploads in Admin › Stickers', async () => {
    const context = await browser.newContext()
    try {
      const adminPage = await context.newPage()
      await signIn(adminPage, staff)
      await adminPage.goto('/admin?tab=stickers')
      const section = adminPage.getByTestId('instance-stickers')
      await expect(section.getByTestId('sticker-count')).toBeVisible({ timeout: BOOT_MS })
      await upload(adminPage, 'instance', { name: 'party.png', mimeType: 'image/png', buffer: PNG }, 'Party', 'Confetti falling')
      await expect(section.getByTestId('sticker-row').filter({ hasText: 'Party' })).toBeVisible({ timeout: 20000 })
    } finally {
      await context.close()
    }
  })

  const memberDb = await userClient(member)
  const refused = await memberDb.rpc('create_sticker', {
    p_scope: 'instance', p_server_id: null, p_path: `instance/${randomUUID()}.png`, p_url: 'https://x.test/a.png',
    p_name: 'mine', p_description: 'x', p_width: 1, p_height: 1,
  })
  expect(refused.error?.code).toBe('42501')

  await stubKlipy(page)
  await signIn(page, member)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
  const picker = await openStickerTab(page)
  await expect(picker.getByTestId('custom-stickers-instance').getByRole('button', { name: /^Send sticker Party/ })).toBeVisible({ timeout: 15000 })
  await picker.getByRole('textbox').first().fill('confetti')
  await expect(picker.getByTestId('sticker-pick')).toHaveCount(1)
  await expect(picker.getByTestId('custom-stickers-server')).toHaveCount(0)
})

test('a member reports a sticker; staff remove it and the message shows a placeholder', async ({ page, browser }) => {
  test.setTimeout(240_000)
  const { data: sticker } = await admin.from('stickers').select('id, name, path').eq('server_id', server.id).single()
  expect(sticker?.name).toBe('Cat wave')

  await test.step('the member reports it from the message menu', async () => {
    await signIn(page, member)
    await openChannel(page, server.id, server.generalChannelId)
    await dismissAnnouncements(page)
    const row = messageList(page).locator('.message-item').filter({ has: page.getByTestId('message-sticker') }).first()
    await expect(row).toBeVisible({ timeout: 30000 })
    await row.hover()
    await row.getByTestId('msg-action-more').click()
    await page.getByRole('menu').getByRole('menuitem', { name: 'Report sticker' }).click()
    const dialog = page.getByRole('dialog', { name: 'Report' })
    await expect(dialog.getByTestId('report-sticker-proof')).toContainText('Cat wave')
    await dialog.getByText('Inappropriate/NSFW content').click()
    await dialog.getByRole('button', { name: 'Submit report' }).click()
    await expect(dialog.getByText('Report submitted')).toBeVisible({ timeout: 15000 })
  })
  const { data: report } = await admin.from('reports').select('report_type, reported_sticker_id, content_snapshot').eq('reporter_id', member.id).single()
  expect(report).toMatchObject({ report_type: 'sticker', reported_sticker_id: sticker!.id })

  await test.step('staff remove it from Admin › Reports', async () => {
    const context = await browser.newContext()
    try {
      const adminPage = await context.newPage()
      await signIn(adminPage, staff)
      await adminPage.goto('/admin?tab=reports')
      const item = adminPage.locator('.report-item').filter({ has: adminPage.locator('.report-type-badge.sticker') }).first()
      await item.click()
      const proof = item.getByTestId('report-sticker')
      await expect(proof).toContainText('Cat wave', { timeout: BOOT_MS })
      await proof.getByTestId('report-remove-sticker').click()
      const confirm = adminPage.getByRole('alertdialog')
      await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
      await expect(proof.getByTestId('report-sticker-removed')).toBeVisible({ timeout: 15000 })
    } finally {
      await context.close()
    }
  })
  expect((await admin.from('stickers').select('id').eq('id', sticker!.id)).data).toHaveLength(0)
  await expect.poll(async () => (await admin.storage.from('stickers').list(`server/${server.id}`)).data?.length ?? 0).toBe(0)

  await page.reload()
  const gone = messageList(page).getByTestId('message-sticker-gone').first()
  await expect(gone).toContainText('Sticker removed', { timeout: BOOT_MS })
  await expect(gone).toHaveAttribute('aria-label', 'Sticker Cat wave, no longer available: A cat waving')
})
