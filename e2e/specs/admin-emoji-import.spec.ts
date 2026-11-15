// Journey: an instance admin imports custom emojis of other instances
// (20261111200001_emoji_import, AdminEmojiLibrary, AdminEmojiImportDialog, routes/adminEmojis.ts).
//
// Admin › Emojis › Import lists remote emojis, filtered by source instance and by name. Four
// emojis of one instance go in at once: one keeps its name, one whose name an instance emoji
// holds is renamed (the held name typed back is refused), one is skipped, and one whose file is
// no image is reported with its reason. The imports are instance emojis stored in this
// instance's bucket with the licence, the origin instance and the remote url kept; the emoji
// that held the name is untouched. Another instance's emoji of the same held name imports under
// the free name offered. A member then finds an imported emoji in the emoji picker and sends it.
//
// The remote media host is emojiRemoteHost.ts; the backend is e2e/backend-server.ts.

import crypto from 'node:crypto'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { startBackend, type Backend } from './backend'
import { REMOTE_PNG, startRemoteHost, type RemoteHost } from './emojiRemoteHost'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

test.use({ serviceWorkers: 'block' })

const INSTANCE_FOLDER = '00000000-0000-0000-0000-000000000000'
const HELD_URL = 'https://emoji.e2e.test/held.png'
const STORED = new RegExp(`/storage/v1/object/public/emojis/${INSTANCE_FOLDER}/[0-9a-f-]{36}\\.png$`)

const admin = adminClient()
const tag = crypto.randomUUID().slice(0, 8)
const FIRST = `mk-${tag}.e2e.test`
const SECOND = `other-${tag}.e2e.test`
const blob = `blob${tag}`
const party = `party${tag}`
const fiesta = `fiesta${tag}`
const skipped = `skipme${tag}`
const broken = `notimg${tag}`
const license = `CC BY 4.0, Artist ${tag}`

let staff: SpecUser
let member: SpecUser
let server: SeededServer
let backend: Backend
let remote: RemoteHost
let heldId: string
const cache: Record<string, string> = {}

test.beforeAll(async () => {
  staff = await createUser(admin, 'eimadm')
  member = await createUser(admin, 'eimmem')
  const { error: adminError } = await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  if (adminError) throw new Error(`admin: ${adminError.message}`)
  server = await seedServer(admin, member, `Imports ${member.username.slice(-6)}`)

  const { data: held, error: heldError } = await admin.from('emojis')
    .insert({ name: party, url: HELD_URL, scope: 'instance' })
    .select('id').single()
  if (heldError || !held) throw new Error(`held emoji: ${heldError?.message}`)
  heldId = held.id

  remote = await startRemoteHost('emoji-import')
  const rows = [
    { key: 'blob', shortcode: blob, origin_domain: FIRST, url: `${remote.origin}/emoji/${blob}.png`, license, usage_count: 999999 },
    { key: 'party', shortcode: party, origin_domain: FIRST, url: `${remote.origin}/emoji/${party}.png`, license: null, usage_count: 999998 },
    { key: 'skipped', shortcode: skipped, origin_domain: FIRST, url: `${remote.origin}/emoji/${skipped}.png`, license: null, usage_count: 999997 },
    { key: 'broken', shortcode: broken, origin_domain: FIRST, url: `${remote.origin}/not-an-image`, license: null, usage_count: 999996 },
    { key: 'partySecond', shortcode: party, origin_domain: SECOND, url: `${remote.origin}/second/${party}.png`, license: null, usage_count: 999995 },
  ]
  for (const { key, ...row } of rows) {
    const { data, error } = await admin.from('remote_emojis_cache')
      .insert({ ...row, full_code: `:${row.shortcode}@${row.origin_domain}:` })
      .select('id').single()
    if (error || !data) throw new Error(`remote cache ${key}: ${error?.message}`)
    cache[key] = data.id
  }

  backend = await startBackend()
})

test.afterAll(async () => {
  await backend?.stop()
  await remote?.stop()
  const { data: rows } = await admin.from('emojis').select('id, url').in('name', [blob, party, fiesta, `${party}_1`, skipped, broken])
  const objects = (rows ?? [])
    .map((row) => (row.url as string).split('/storage/v1/object/public/emojis/')[1])
    .filter(Boolean)
  await admin.from('emojis').delete().in('id', (rows ?? []).map((r) => r.id))
  await admin.from('remote_emojis_cache').delete().in('id', Object.values(cache))
  if (objects.length) await admin.storage.from('emojis').remove(objects)
  await deleteUser(admin, member)
  await deleteUser(admin, staff)
})

const rowOf = (library: Locator, id: string) => library.locator(`[data-testid="admin-emoji-row"][data-emoji-id="${id}"]`)
const itemOf = (dialog: Locator, id: string) => dialog.locator(`[data-testid="admin-emoji-import-item"][data-emoji-id="${id}"]`)

async function openAdminEmojis(page: Page): Promise<Locator> {
  await page.route('https://emoji.e2e.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: REMOTE_PNG }))
  await signIn(page, staff)
  await backend.route(page)
  await page.goto('/admin?tab=emojis')
  const library = page.getByTestId('admin-emoji-library')
  await expect(library).toBeVisible({ timeout: 30000 })
  return library
}

test('an admin imports emojis of other instances, renaming or skipping held names, and members use them', async ({ page, browser }) => {
  test.setTimeout(300_000)
  const library = await openAdminEmojis(page)
  const source = library.getByTestId('admin-emoji-source')
  const search = library.getByTestId('admin-emoji-search')
  const rows = library.getByTestId('admin-emoji-row')

  await test.step('Import lists remote emojis by source instance and name', async () => {
    await library.getByTestId('admin-emoji-import-open').click()
    await expect(library.getByTestId('admin-emoji-import-hint')).toContainText('adds it to the instance emojis')
    await expect(library.getByTestId('admin-emoji-kind-not_imported')).toHaveAttribute('aria-pressed', 'true')
    await expect(source.locator('option', { hasText: `${FIRST} (4)` })).toHaveCount(1, { timeout: 30000 })
    await expect(source.locator('option', { hasText: `${SECOND} (1)` })).toHaveCount(1)

    await source.selectOption(FIRST)
    await expect(rows).toHaveCount(4, { timeout: 30000 })
    await expect(rowOf(library, cache.partySecond)).toHaveCount(0)
    await expect(rowOf(library, cache.party).getByTestId('admin-emoji-name-taken')).toHaveText('name in use')
    await expect(rowOf(library, cache.blob).getByTestId('admin-emoji-name-taken')).toHaveCount(0)
    await expect(rowOf(library, cache.blob).getByTestId('admin-emoji-license')).toHaveText(`Licence: ${license}`)

    await search.fill(blob.toUpperCase())
    await expect(rows).toHaveCount(1, { timeout: 30000 })
    await expect(rowOf(library, cache.blob)).toContainText(`from ${FIRST}`)
    await search.fill('')
    await expect(rows).toHaveCount(4, { timeout: 30000 })
  })

  await test.step('four at once: one as it is, one renamed, one skipped, one refused', async () => {
    await library.getByTestId('admin-emoji-select').click()
    await library.getByTestId('admin-emoji-select-page').click()
    await expect(library.locator('.bulk-count')).toHaveText('4 selected')
    await library.getByTestId('admin-emoji-bulk-import').click()

    const dialog = page.getByRole('dialog', { name: 'Import 4 emojis' })
    await expect(dialog.getByTestId('admin-emoji-import-clashes')).toContainText('1 name is already used by an instance emoji')
    const items = dialog.getByTestId('admin-emoji-import-item')
    await expect(items).toHaveCount(4)
    await expect(items.first()).toHaveAttribute('data-emoji-id', cache.party)

    const partyItem = itemOf(dialog, cache.party)
    const partyName = partyItem.getByTestId('admin-emoji-import-name')
    const confirm = dialog.getByTestId('admin-emoji-import-confirm')
    await expect(partyName).toHaveValue(`${party}_1`)
    await expect(itemOf(dialog, cache.blob).getByTestId('admin-emoji-import-name')).toHaveValue(blob)

    await partyName.fill(party)
    await expect(partyItem.getByTestId('admin-emoji-import-problem')).toHaveText('An instance emoji already uses this name.')
    await expect(confirm).toBeDisabled()
    await partyName.fill(blob)
    await expect(partyItem.getByTestId('admin-emoji-import-problem')).toHaveText('Another emoji in this import uses this name.')
    await expect(confirm).toBeDisabled()
    await partyName.fill(fiesta)
    await expect(partyItem.getByTestId('admin-emoji-import-problem')).toHaveCount(0)

    await itemOf(dialog, cache.skipped).getByTestId('admin-emoji-import-skip').check()
    await expect(confirm).toHaveText('Import 3 emojis')
    await confirm.click()

    await expect(dialog.getByTestId('admin-emoji-import-summary'))
      .toHaveText('2 emojis imported · 1 skipped · 1 failed', { timeout: 60000 })
    await expect(itemOf(dialog, cache.blob).getByTestId('admin-emoji-import-status')).toHaveText(`Imported as :${blob}:`)
    await expect(partyItem.getByTestId('admin-emoji-import-status')).toHaveText(`Imported as :${fiesta}:`)
    await expect(itemOf(dialog, cache.skipped).getByTestId('admin-emoji-import-status')).toHaveText('Skipped')
    await expect(itemOf(dialog, cache.broken).getByTestId('admin-emoji-import-status'))
      .toHaveText('The remote image is not a PNG, GIF, WebP or JPEG.')
    await dialog.getByTestId('admin-emoji-import-close').click()
    await expect(dialog).toHaveCount(0)

    // The skipped and the refused emoji stay available; the instance's count follows.
    await expect(rows).toHaveCount(2, { timeout: 30000 })
    await expect(rowOf(library, cache.skipped)).toBeVisible()
    await expect(rowOf(library, cache.broken)).toBeVisible()
    await expect(source.locator('option', { hasText: `${FIRST} (2)` })).toHaveCount(1, { timeout: 30000 })
  })

  let blobRow: { id: string; url: string }
  await test.step('the imports are instance emojis hosted here, with licence and origin; the held emoji is untouched', async () => {
    const { data: imported } = await admin.from('emojis')
      .select('id, name, url, scope, domain, license, source_domain, imported_from, deleted_at')
      .in('name', [blob, fiesta])
    const byName = new Map((imported ?? []).map((row) => [row.name as string, row]))
    expect(byName.get(blob)).toMatchObject({
      scope: 'instance', domain: null, deleted_at: null, license, source_domain: FIRST,
      imported_from: `${remote.origin}/emoji/${blob}.png`,
    })
    expect(byName.get(fiesta)).toMatchObject({
      scope: 'instance', domain: null, license: null, source_domain: FIRST,
      imported_from: `${remote.origin}/emoji/${party}.png`,
    })
    for (const name of [blob, fiesta]) expect(byName.get(name)!.url).toMatch(STORED)
    blobRow = { id: byName.get(blob)!.id, url: byName.get(blob)!.url }
    const file = blobRow.url.split(`/${INSTANCE_FOLDER}/`)[1]
    const { data: listed } = await admin.storage.from('emojis').list(INSTANCE_FOLDER, { search: file })
    expect(listed?.map((o) => o.name)).toEqual([file])

    const { data: named } = await admin.from('emojis').select('id, url, deleted_at').eq('name', party)
    expect(named).toEqual([{ id: heldId, url: HELD_URL, deleted_at: null }])
    const { data: left } = await admin.from('remote_emojis_cache').select('id, imported_as').in('id', Object.values(cache))
    const importedAs = new Map((left ?? []).map((row) => [row.id as string, row.imported_as]))
    expect(importedAs.get(cache.blob)).toBe(blobRow.id)
    expect(importedAs.get(cache.party)).toBe(byName.get(fiesta)!.id)
    expect(importedAs.get(cache.skipped)).toBeNull()
    expect(importedAs.get(cache.broken)).toBeNull()
  })

  await test.step('one emoji of another instance, its name held: the free name offered is used', async () => {
    await source.selectOption(SECOND)
    const row = rowOf(library, cache.partySecond)
    await expect(row).toBeVisible({ timeout: 30000 })
    await expect(rows).toHaveCount(1)
    await expect(row.getByTestId('admin-emoji-name-taken')).toBeVisible()
    await row.getByRole('button', { name: `Import :${party}:` }).click()

    const dialog = page.getByRole('dialog', { name: 'Import 1 emoji' })
    await expect(itemOf(dialog, cache.partySecond).getByTestId('admin-emoji-import-name')).toHaveValue(`${party}_1`)
    await dialog.getByTestId('admin-emoji-import-confirm').click()
    await expect(dialog.getByTestId('admin-emoji-import-summary')).toHaveText('1 emoji imported', { timeout: 60000 })
    await dialog.getByTestId('admin-emoji-import-close').click()
    await expect(row).toHaveCount(0, { timeout: 30000 })
    // The instance has nothing left to import and leaves the filter.
    await expect(source).toHaveValue('', { timeout: 30000 })
    await expect(source.locator('option', { hasText: SECOND })).toHaveCount(0)

    const { data: second } = await admin.from('emojis').select('source_domain, scope, url').eq('name', `${party}_1`).single()
    expect(second).toMatchObject({ source_domain: SECOND, scope: 'instance' })
    expect(second!.url).toMatch(STORED)
  })

  await test.step('the import is listed as imported, from its instance', async () => {
    await library.getByTestId('admin-emoji-kind-imported').click()
    await search.fill(blob)
    const row = rowOf(library, blobRow.id)
    await expect(row).toBeVisible({ timeout: 30000 })
    await expect(row).toContainText(`from ${FIRST}`)
    await expect(row.getByTestId('admin-emoji-license')).toHaveText(`Licence: ${license}`)
    await expect(row.locator('.badge.hotlinked')).toHaveCount(0)
  })

  await test.step('a member finds the imported emoji in the picker and sends it', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    try {
      const memberPage = await context.newPage()
      await signIn(memberPage, member)
      await openChannel(memberPage, server.id, server.generalChannelId)
      await dismissAnnouncements(memberPage)
      const editor = memberPage.locator('[data-region="composer"]').locator('[contenteditable="true"]').first()
      await expect(editor).toBeVisible({ timeout: 30000 })
      await editor.click()
      // Typed by name first, in a session that has opened no picker.
      await memberPage.keyboard.type(`:${blob}`)
      await expect(memberPage.locator('[role="option"]').filter({ hasText: blob })).toHaveCount(1, { timeout: 15000 })
      await memberPage.keyboard.press('Escape')
      await memberPage.keyboard.press('ControlOrMeta+A')
      await memberPage.keyboard.press('Backspace')

      await memberPage.locator('[data-region="composer"]').getByRole('button', { name: /emoji/i }).last().click()
      const picker = memberPage.locator('.media-picker-popup').first()
      await expect(picker).toBeVisible({ timeout: 15000 })
      await picker.locator('.search-input').fill(blob)
      const file = blobRow.url.split(`/${INSTANCE_FOLDER}/`)[1]
      const item = picker.locator('.emoji-item').filter({ has: memberPage.locator(`img[src*="${file}"]`) })
      await expect(item).toHaveCount(1, { timeout: 15000 })
      await item.click()
      await expect(editor.locator('.editor-emoji img')).toHaveAttribute('src', new RegExp(file.replace(/\./g, '\\.')))

      const marker = `imported ${tag}`
      await memberPage.keyboard.type(` ${marker}`)
      await memberPage.keyboard.press('Enter')
      const message = memberPage.locator('[data-testid="message-list"] .message-item').filter({ hasText: marker }).last()
      await expect(message).toBeVisible({ timeout: 30000 })
      await expect(message).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
      await expect.poll(
        () => message.locator(`img[alt=":${blob}:"]`).evaluate((el) => (el as HTMLImageElement).naturalWidth),
        { timeout: 30000 },
      ).toBeGreaterThan(0)

      const id = await message.getAttribute('data-message-id')
      const { data: stored } = await admin.from('messages').select('content').eq('id', id!).single()
      const part = (stored!.content as Array<{ type: string; emoji?: { id?: string; url?: string } }>).find((p) => p.type === 'emoji')
      expect(part?.emoji).toMatchObject({ id: blobRow.id, url: blobRow.url })
    } finally {
      await context.close()
    }
  })
})
