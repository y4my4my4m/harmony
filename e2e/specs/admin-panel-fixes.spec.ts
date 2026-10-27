// Journey: Admin panel fixes (20261031400001_admin_panel_fixes.sql).
//
// Copy user ID (Users) and Copy server ID (Servers) put the row's UUID on the clipboard, the
// second by keyboard. Drive's storage list renders a custom emoji in a display name, pages 50
// accounts at a time against 105 seeded holders (order, total, page 2, last page, search with
// paging). An admin uploads an instance emoji from the Emojis tab and a regular user finds it
// in the composer's picker. The Emojis tab at 375 px keeps its filters on one row, pads its
// cards and has no horizontal scroll, in light and dark.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  instanceDomain,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'
import { expectNoAxeViolations } from './a11y'

const admin = adminClient()
const IMAGE_URL = `${process.env.BASE_URL || 'http://localhost:5173'}/default_server.webp`
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
const HOLDERS = 105
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

// One worker runs the file in order; beforeAll seeds once.
test.describe.configure({ mode: 'default' })

let staff: SpecUser
let member: SpecUser
let named: SpecUser
let server: SeededServer
let nameEmojiId: string
const nameEmoji = `dn${tag}`
const pagePrefix = `pg${tag}`
const holderIds: string[] = []
const createdEmojiIds: string[] = []

const holderName = (n: number) => `${pagePrefix}_${String(n).padStart(3, '0')}`

test.beforeAll(async () => {
  staff = await createUser(admin, 'apfadm')
  const { error } = await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  if (error) throw new Error(`promote admin: ${error.message}`)
  member = await createUser(admin, 'apfmem')
  server = await seedServer(admin, member, `Admin Fix Hub ${tag}`)

  const { data: emoji, error: emojiError } = await admin
    .from('emojis')
    .insert({ name: nameEmoji, url: IMAGE_URL, server_id: null, domain: null, scope: 'instance' })
    .select('id')
    .single()
  if (emojiError || !emoji) throw new Error(`seed emoji: ${emojiError?.message}`)
  nameEmojiId = emoji.id

  named = await createUser(admin, 'apfnam')
  await admin.from('profiles').update({ display_name: `Drive :${nameEmoji}: Person` }).eq('id', named.id)
  // Far above every other holder, so it leads the first page with or without a search.
  const { error: fileError } = await admin.from('drive_files').insert({
    owner_id: named.id, bucket: 'user_media', path: `${named.id}/big.bin`, name: 'big.bin', size_bytes: 9e14,
  })
  if (fileError) throw new Error(`seed drive file: ${fileError.message}`)

  const domain = await instanceDomain(admin)
  const profiles = Array.from({ length: HOLDERS }, (_, i) => ({
    id: crypto.randomUUID(),
    username: holderName(i + 1),
    display_name: `Holder ${i + 1}`,
    is_local: true,
    domain,
  }))
  const { error: profileError } = await admin.from('profiles').insert(profiles)
  if (profileError) throw new Error(`seed holders: ${profileError.message}`)
  holderIds.push(...profiles.map((p) => p.id))
  // Used bytes fall with the index: holder 1 is the largest.
  const { error: filesError } = await admin.from('drive_files').insert(
    profiles.map((p, i) => ({
      owner_id: p.id, bucket: 'user_media', path: `${p.id}/f.bin`, name: 'f.bin', size_bytes: (HOLDERS - i) * 1024,
    })),
  )
  if (filesError) throw new Error(`seed holder files: ${filesError.message}`)
})

test.afterAll(async () => {
  const owners = [named?.id, ...holderIds].filter(Boolean) as string[]
  if (owners.length) await admin.from('drive_files').delete().in('owner_id', owners)
  if (holderIds.length) await admin.from('profiles').delete().in('id', holderIds)
  const emojis = [nameEmojiId, ...createdEmojiIds].filter(Boolean)
  if (emojis.length) await admin.from('emojis').delete().in('id', emojis)
  await deleteUser(admin, named)
  await deleteUser(admin, member)
  await deleteUser(admin, staff)
})

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText())

async function openAdminTab(page: Page, tab: string) {
  await page.goto(`/admin?tab=${tab}`)
  await expect(page.locator('.admin-panel')).toBeVisible({ timeout: 20000 })
}

test('Copy user ID and Copy server ID put the UUIDs on the clipboard', async ({ page, context, baseURL }) => {
  test.setTimeout(120_000)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL })
  await signIn(page, staff)

  await openAdminTab(page, 'users')
  const users = page.locator('.users-module')
  await users.getByPlaceholder('Search users…').fill(member.username)
  const userRow = users.locator('.user-item').filter({ hasText: member.username })
  await expect(userRow).toHaveCount(1, { timeout: 15000 })
  await userRow.getByRole('button', { name: /^Copy user ID/ }).click()
  await expect(page.getByText('User ID copied').first()).toBeVisible()
  expect(await clipboard(page)).toBe(member.id)
  await expectNoAxeViolations(page, { include: '.user-item .copy-id-btn', label: 'admin copy user ID' })

  await openAdminTab(page, 'servers')
  const hosted = page.getByTestId('hosted-servers')
  await hosted.getByTestId('hosted-servers-search').fill(server.name)
  const serverRow = hosted.getByTestId('hosted-server-row').filter({ hasText: server.name })
  await expect(serverRow).toHaveCount(1, { timeout: 15000 })
  const copyServer = serverRow.getByRole('button', { name: `Copy server ID: ${server.name}` })
  await copyServer.focus()
  await expect(copyServer).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByText('Server ID copied').first()).toBeVisible()
  expect(await clipboard(page)).toBe(server.id)

  await serverRow.getByTestId('hosted-server-open').click()
  const detail = page.getByTestId('hosted-server-detail')
  await detail.getByRole('button', { name: `Copy server ID: ${server.name}` }).click()
  expect(await clipboard(page)).toBe(server.id)
  await expectNoAxeViolations(page, { include: '.detail-id', label: 'admin server detail id' })
})

test('Drive renders a custom emoji in an account name', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, staff)
  await openAdminTab(page, 'drive')
  const row = page.getByTestId('drive-admin').locator('tr').filter({ hasText: `@${named.username}` })
  await expect(row).toBeVisible({ timeout: 20000 })
  await expect(row.locator(`img[alt=":${nameEmoji}:"]`)).toBeVisible({ timeout: 15000 })
  await expect(row).toContainText('Drive')
  await expect(row).toContainText('Person')
  await expect(row).not.toContainText(`:${nameEmoji}:`)
})

test('Drive pages 50 accounts at a time with an exact total', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, staff)
  await openAdminTab(page, 'drive')
  const usage = page.getByTestId('drive-admin-usage')
  const rows = usage.getByTestId('drive-admin-usage-row')
  const range = usage.getByTestId('drive-admin-range')
  const firstHandle = rows.first().locator('.drive-admin__handle')
  const lastHandle = rows.last().locator('.drive-admin__handle')

  await usage.getByTestId('drive-admin-search').fill(`@${pagePrefix}`)
  await expect(range).toHaveText(`1–50 of ${HOLDERS}`, { timeout: 15000 })
  await expect(rows).toHaveCount(50)
  await expect(firstHandle).toHaveText(`@${holderName(1)}`)
  await expect(lastHandle).toHaveText(`@${holderName(50)}`)
  await expect(usage.getByTestId('drive-admin-prev')).toBeDisabled()

  await usage.getByTestId('drive-admin-next').click()
  await expect(range).toHaveText(`51–100 of ${HOLDERS}`)
  await expect(rows).toHaveCount(50)
  await expect(firstHandle).toHaveText(`@${holderName(51)}`)
  await expect(lastHandle).toHaveText(`@${holderName(100)}`)

  await usage.getByTestId('drive-admin-next').click()
  await expect(range).toHaveText(`101–105 of ${HOLDERS}`)
  await expect(rows).toHaveCount(5)
  await expect(firstHandle).toHaveText(`@${holderName(101)}`)
  await expect(lastHandle).toHaveText(`@${holderName(105)}`)
  await expect(usage.getByTestId('drive-admin-next')).toBeDisabled()

  await usage.getByTestId('drive-admin-prev').click()
  await expect(range).toHaveText(`51–100 of ${HOLDERS}`)

  // A narrower search restarts from its first page: _100 to _105.
  await usage.getByTestId('drive-admin-search').fill(`${pagePrefix}_10`)
  await expect(rows).toHaveCount(6, { timeout: 15000 })
  await expect(firstHandle).toHaveText(`@${holderName(100)}`)
  await expect(range).toHaveCount(0)
  await expectNoAxeViolations(page, { include: '[data-testid="drive-admin-usage"]', label: 'admin drive usage' })
})

test('an admin uploads an instance emoji and a regular user finds it in the picker', async ({ page, browser }) => {
  test.setTimeout(180_000)
  const name = `ie${tag}`
  await signIn(page, staff)
  await openAdminTab(page, 'emojis')
  const library = page.getByTestId('instance-emoji-library')
  await expect(library.getByTestId('emoji-count')).toBeVisible({ timeout: 20000 })
  await library.getByTestId('emoji-upload-input').setInputFiles({ name: `${name}.png`, mimeType: 'image/png', buffer: PNG })
  const tile = library.locator('.emoji-item').filter({ hasText: `:${name}:` })
  await expect(tile).toBeVisible({ timeout: 30000 })

  const { data: rows } = await admin.from('emojis').select('id, scope, domain, server_id, url').eq('name', name)
  expect(rows).toHaveLength(1)
  createdEmojiIds.push(rows![0].id)
  expect(rows![0]).toMatchObject({ scope: 'instance', domain: null, server_id: null })
  expect(rows![0].url).toContain('/emojis/00000000-0000-0000-0000-000000000000/')
  await expectNoAxeViolations(page, { include: '[data-testid="instance-emoji-library"]', label: 'admin instance emojis' })

  const context = await browser.newContext()
  const userPage = await context.newPage()
  await signIn(userPage, member)
  await openChannel(userPage, server.id, server.generalChannelId)
  const trigger = userPage.locator('[data-testid="message-input"] button[aria-label="Emoji picker"]:visible').first()
  await trigger.click()
  const picker = userPage.locator('.emoji-picker-content')
  await expect(picker).toBeVisible({ timeout: 15000 })
  // Custom emoji are buttons named ":name:"; picker groups start collapsed, search lists matches.
  await picker.getByPlaceholder('Shortcode or keyword').fill(name)
  await expect(picker.locator(`button[aria-label=":${name}:"]`).first()).toBeVisible({ timeout: 15000 })
  await context.close()
})

for (const colorScheme of ['light', 'dark'] as const) {
  test(`the Emojis tab fits a phone (${colorScheme})`, async ({ browser }) => {
    test.setTimeout(120_000)
    const context = await browser.newContext({ colorScheme, viewport: { width: 375, height: 812 } })
    const page = await context.newPage()
    await signIn(page, staff)
    await openAdminTab(page, 'emojis')
    const browse = page.locator('.instance-emoji-admin')
    await expect(browse.locator('.emoji-row').first()).toBeVisible({ timeout: 20000 })

    const layout = await page.evaluate(() => {
      const box = (el: Element | null) => el?.getBoundingClientRect() ?? null
      const browseEl = document.querySelector('.instance-emoji-admin')!
      const selects = [...browseEl.querySelectorAll('.emoji-filters select')].map((s) => box(s)!)
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        selectTops: selects.map((r) => Math.round(r.top)),
        selectRight: Math.max(...selects.map((r) => r.right)),
        hintInset: box(browseEl.querySelector('.module-hint'))!.left - box(browseEl)!.left,
        columns: getComputedStyle(browseEl.querySelector('.emoji-list')!).gridTemplateColumns.split(' ').length,
        tileRight: Math.max(...[...browseEl.querySelectorAll('.emoji-row')].map((r) => box(r)!.right)),
      }
    })
    expect(layout.overflow).toBe(0)
    expect(layout.selectTops[0]).toBe(layout.selectTops[1])
    expect(layout.selectRight).toBeLessThanOrEqual(375)
    expect(layout.hintInset).toBeGreaterThanOrEqual(12)
    expect(layout.columns).toBe(1)
    expect(layout.tileRight).toBeLessThanOrEqual(375)
    const library = page.getByTestId('instance-emoji-library')
    await expect(library.getByTestId('emoji-upload-area')).toBeVisible({ timeout: 15000 })
    await expectNoAxeViolations(page, { include: '.instance-emoji-admin', label: `admin emoji browser (${colorScheme})` })
    await expectNoAxeViolations(page, { include: '[data-testid="instance-emoji-library"]', label: `admin instance emojis (${colorScheme})` })
    await context.close()
  })
}
