// Journey: the collapsible controls of Discover communities and the one search field of Other
// instances. The other instance is e2e/specs/directoryPeer.ts, read by this instance's federation
// backend (e2e/specs/backend.ts), as in remote-server-directory.spec.ts.
//
// - Both tabs open with their controls folded: the tabs, the "Search and filters" toggle and the
//   count stay on screen, the search field and chips are hidden. The toggle states aria-expanded
//   and opens on the search field.
// - A category and search text chosen, then folded: both stay on screen as chips beside the
//   count, and each chip clears its own filter.
// - Scrolling the list folds open controls; the active filters stay on screen and the tabs never
//   fold.
// - Other instances: text filters the merged list and offers no browse; a typed domain is offered
//   as "Browse <domain>", Enter browses it, the field empties, the instance is the active filter,
//   folded too, and its chip returns to the merged list. Escape empties a filled field and keeps
//   the dialog open; from an empty field it closes the dialog.
// - Folded, both tabs show more whole cards than the controls left room for: at 1280x1000, four
//   on This instance and nine on Other instances; at 375x812, two and three; nothing overflows.
// - With GET /directory/servers stubbed: past 60 rows, the merged list is read again in pages of
//   60 while an instance is pending and keeps every row; a failed Load more says so and the button
//   tries again; the last page moves focus from the button to the first row it added; typed text
//   narrows the rows at once, and the count waits for the answer.

import { test, expect, type Locator, type Page } from '@playwright/test'
import crypto from 'node:crypto'
import { adminClient, createUser, deleteUser, seedServer, signIn, type SeededServer, type SpecUser } from './harness'
import { startBackend, type Backend } from './backend'
import { startDirectoryPeer, type DirectoryPeer } from './directoryPeer'

test.use({ serviceWorkers: 'block' })
test.describe.configure({ mode: 'serial' })

const admin = adminClient()
let user: SpecUser
// No server: the phone opens Discover communities from the empty-state splash.
let phoneUser: SpecUser
let home: SeededServer
let backend: Backend
let peer: DirectoryPeer
const TAG = `Dc${crypto.randomUUID().slice(0, 6)}`
const MUSIC = 12
const GAMING = 2
const listed = { id: crypto.randomUUID(), name: `${TAG} Lighthouse Lounge`, summary: 'Keepers of the light', memberCount: 12 }
const larger = { id: crypto.randomUUID(), name: `${TAG} Harbour Hall`, summary: 'Ships and tides', memberCount: 30 }
// Known instances of other specs may be listed too: the merged list is asserted by this spec's servers.
const MERGED_STATS = /^\d+ servers? on \d+ instances?$/
const seededIds: string[] = []

test.beforeAll(async () => {
  test.setTimeout(120_000)
  user = await createUser(admin, 'dsc')
  phoneUser = await createUser(admin, 'dsp')
  home = await seedServer(admin, user, `Home ${user.username}`)
  const rows = Array.from({ length: MUSIC + GAMING }, (_, i) => ({
    name: `${TAG} ${i < MUSIC ? 'Synth' : 'Arcade'} ${String(i).padStart(2, '0')}`,
    description: `Seeded for the discovery controls journey (${TAG}).`,
    owner: user.id,
    public: true,
    category: i < MUSIC ? 'music' : 'gaming',
  }))
  const { data, error } = await admin.from('servers').insert(rows).select('id')
  if (error || !data) throw new Error(`public servers: ${error?.message}`)
  seededIds.push(...data.map((r) => r.id))
  peer = await startDirectoryPeer([listed, larger], { name: 'Peer Harbour' })
  await admin.from('federated_instances').delete().eq('domain', peer.domain)
  const { error: known } = await admin.from('federated_instances').insert({
    domain: peer.domain, software: 'harmony', last_seen_at: new Date().toISOString(),
  })
  if (known) throw new Error(`known instance: ${known.message}`)
  backend = await startBackend({ NODE_TLS_REJECT_UNAUTHORIZED: '0' })
})

test.afterAll(async () => {
  await backend?.stop()
  await admin.from('federated_instances').delete().eq('domain', peer?.domain ?? '')
  await peer?.stop()
  if (seededIds.length > 0) await admin.from('servers').delete().in('id', seededIds)
  await admin.from('servers').delete().eq('id', home?.id ?? '')
  await deleteUser(admin, user)
  await deleteUser(admin, phoneUser)
})

async function openDiscovery(page: Page, from: 'rail' | 'splash' = 'rail') {
  if (from === 'rail') await page.getByRole('button', { name: 'Harmony Portal' }).click()
  else await page.getByRole('button', { name: /Browse public servers/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Discover communities' })
  await expect(dialog).toBeVisible({ timeout: 15000 })
  return dialog
}

/** Cards wholly inside the visible part of the list `scroller`. */
async function wholeCards(dialog: Locator, card: string, scroller: string): Promise<number> {
  return dialog.evaluate((root, [c, s]) => {
    const box = root.querySelector(s)!.getBoundingClientRect()
    return [...root.querySelectorAll(c)].filter((el) => {
      const r = el.getBoundingClientRect()
      return r.height > 0 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1
    }).length
  }, [card, scroller] as const)
}

/** GET /directory/servers answered with `count` servers on as many instances. */
async function stubMergedList(page: Page, count: number) {
  await page.route('**/api/federation/directory/servers**', (route) => {
    const items = Array.from({ length: count }, (_, i) => {
      const domain = `stub${i}.e2e.test`
      return {
        id: `https://${domain}/servers/${i}`, name: `Stub Server ${i}`, summary: `A server on ${domain}.`, icon: null,
        memberCount: 50 - i, handle: `stub${i}@${domain}`, category: null, instance: { domain, name: null, icon: null },
      }
    })
    return route.fulfill({ json: { items, total: count, nextOffset: null, instances: count, pending: 0, failed: [], federationOff: false } })
  })
}

test('the controls fold, keep active filters on screen, and the field browses a typed domain', async ({ page }) => {
  test.setTimeout(180_000)
  await backend.route(page)
  await signIn(page, user)
  await page.goto(`/chat/${home.id}/${home.generalChannelId}`)
  const dialog = await openDiscovery(page)
  const tabs = dialog.getByRole('tablist', { name: 'Where to look' })
  const local = dialog.locator('#discovery-panel-local')
  const toggle = local.getByRole('button', { name: 'Search and filters' })
  const search = local.getByRole('textbox', { name: 'Search communities' })
  const cards = local.locator('.server-card')
  const chips = local.getByTestId('discovery-filter-chip')
  const stats = local.getByTestId('discovery-local-stats')

  await test.step('This instance opens folded: toggle, count and tabs on screen, the field hidden', async () => {
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(search).toBeHidden()
    await expect(stats).toHaveText(/^\d+ communities found$/)
    await expect(tabs).toBeVisible()
    await expect(chips).toHaveCount(0)
  })

  await test.step('the toggle opens on the search field; a category and text narrow the list', async () => {
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(search).toBeFocused()
    await page.keyboard.type(TAG)
    await expect(cards).toHaveCount(MUSIC + GAMING, { timeout: 15000 })
    await local.getByRole('group', { name: 'Categories' }).getByRole('button', { name: 'Music' }).click()
    await expect(cards).toHaveCount(MUSIC)
    await expect(stats).toHaveText(new RegExp(`^${MUSIC} of \\d+ communities$`))
  })

  await test.step('folded, both filters stay on screen as chips beside the count; a chip clears its own', async () => {
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(search).toBeHidden()
    await expect(chips).toHaveText(['Remove filter Music', `Remove filter “${TAG}”`])
    await expect(stats).toHaveText(new RegExp(`^${MUSIC} of \\d+ communities$`))
    await chips.filter({ hasText: 'Music' }).click()
    await expect(chips).toHaveText([`Remove filter “${TAG}”`])
    await expect(cards).toHaveCount(MUSIC + GAMING)
    await expect(chips.first()).toBeFocused()
  })

  await test.step('scrolling the list folds open controls; the filter and the tabs stay', async () => {
    await toggle.click()
    await expect(search).toBeFocused()
    await local.getByRole('group', { name: 'Categories' }).getByRole('button', { name: 'Music' }).click()
    await expect(cards).toHaveCount(MUSIC)
    // Focus on a chip in the panel, not the field: the controls fold.
    await local.locator('.public-servers-content').evaluate((el) => el.scrollBy(0, 600))
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toBeFocused()
    await expect(chips).toHaveText(['Remove filter Music', `Remove filter “${TAG}”`])
    await expect(tabs).toBeVisible()
  })

  const remote = dialog.getByTestId('remote-directory')
  const remoteToggle = remote.getByRole('button', { name: 'Search and filters' })
  const field = remote.getByRole('searchbox', { name: 'Search servers or browse an instance' })
  const remoteCards = remote.getByTestId('remote-directory-server')
  const remoteStats = remote.getByTestId('remote-directory-stats')
  const ours = remoteCards.filter({ hasText: TAG })
  const remoteChips = remote.getByTestId('discovery-filter-chip')
  const offer = remote.getByTestId('remote-directory-browse')

  await test.step('Other instances opens folded on the merged list', async () => {
    await tabs.getByRole('tab', { name: 'Other instances' }).click()
    await expect(remoteToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(field).toBeHidden()
    await expect(ours).toHaveCount(2, { timeout: 30000 })
    await expect(remoteStats).toHaveText(MERGED_STATS)
  })

  await test.step('text filters the merged list and offers no browse', async () => {
    await remoteToggle.click()
    await expect(field).toBeFocused()
    await field.fill(listed.name)
    await expect(remoteCards).toHaveCount(1, { timeout: 15000 })
    await expect(remoteCards.first()).toContainText(listed.name)
    await expect(offer).toHaveCount(0)
  })

  await test.step('a typed domain is offered; Enter browses it and it becomes the active filter', async () => {
    await field.fill(`https://${peer.domain}/`)
    await expect(offer).toHaveText(new RegExp(`Browse ${peer.domain.replace(/\./g, '\\.')}`))
    await field.press('Enter')
    await expect(remoteStats).toHaveText(`2 servers on ${peer.domain}`, { timeout: 30000 })
    await expect(remoteCards).toHaveCount(2)
    await expect(field).toHaveValue('')
    await expect(offer).toHaveCount(0)
    await expect(remote.getByTestId('remote-directory-peer').filter({ hasText: peer.domain })).toHaveAttribute('aria-pressed', 'true')
    await expect(remote.getByTestId('remote-directory-all')).toHaveAttribute('aria-pressed', 'false')
  })

  await test.step('folded, the instance stays on screen; its chip returns to the merged list', async () => {
    await remoteToggle.click()
    await expect(field).toBeHidden()
    await expect(remoteChips).toHaveText([`Remove filter ${peer.domain}`])
    await expect(remoteStats).toHaveText(`2 servers on ${peer.domain}`)
    await remoteChips.first().click()
    await expect(remoteStats).toHaveText(MERGED_STATS, { timeout: 15000 })
    await expect(ours).toHaveCount(2)
    await expect(remoteChips).toHaveCount(0)
    await expect(remoteToggle).toBeFocused()
    await expect(tabs).toBeVisible()
  })

  await test.step('Escape empties the filled field, and closes the dialog only from an empty one', async () => {
    await remoteToggle.click()
    await expect(field).toBeFocused()
    await page.keyboard.type('harbour')
    await page.keyboard.press('Escape')
    await expect(field).toHaveValue('')
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })
})

test('folded, both tabs show more whole cards at desktop size', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 1000 })
  await backend.route(page)
  await stubMergedList(page, 14)
  await signIn(page, user)
  await page.goto(`/chat/${home.id}/${home.generalChannelId}`)
  const dialog = await openDiscovery(page)
  await expect(dialog.locator('.public-servers-content .server-card').nth(4)).toBeVisible({ timeout: 15000 })
  const bar = await dialog.locator('#discovery-panel-local').getByTestId('discovery-controls').boundingBox()
  expect(bar!.height).toBeLessThanOrEqual(64)
  expect(await wholeCards(dialog, '.server-card', '.public-servers-content')).toBeGreaterThanOrEqual(4)

  await dialog.getByRole('tab', { name: 'Other instances' }).click()
  await expect(dialog.getByTestId('remote-directory-server')).toHaveCount(14, { timeout: 30000 })
  expect(await wholeCards(dialog, '[data-testid="remote-directory-server"]', '.remote-directory__results')).toBeGreaterThanOrEqual(9)
})

test('at phone width the folded controls fit and more cards show', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 375, height: 812 })
  await backend.route(page)
  await stubMergedList(page, 6)
  await signIn(page, phoneUser)
  const dialog = await openDiscovery(page, 'splash')
  const local = dialog.locator('#discovery-panel-local')
  await expect(local.locator('.server-card').nth(2)).toBeVisible({ timeout: 15000 })
  const bar = await local.getByTestId('discovery-controls').boundingBox()
  expect(bar!.height).toBeLessThanOrEqual(56)
  expect(await wholeCards(dialog, '.server-card', '.public-servers-content')).toBeGreaterThanOrEqual(2)

  const toggle = local.getByRole('button', { name: 'Search and filters' })
  await toggle.click()
  await local.getByRole('group', { name: 'Categories' }).getByRole('button', { name: 'Music' }).click()
  await toggle.click()
  const chip = local.getByTestId('discovery-filter-chip')
  await expect(chip).toHaveText('Remove filter Music')
  const chipBox = await chip.boundingBox()
  expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(375)

  await dialog.getByRole('tab', { name: 'Other instances' }).click()
  await expect(dialog.getByTestId('remote-directory-server')).toHaveCount(6, { timeout: 30000 })
  expect(await wholeCards(dialog, '[data-testid="remote-directory-server"]', '.remote-directory__results')).toBeGreaterThanOrEqual(3)
  const overflow = await page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  const remoteToggle = dialog.getByTestId('remote-directory').getByRole('button', { name: 'Search and filters' })
  await remoteToggle.click()
  const size = await dialog.getByTestId('remote-directory-search').evaluate((el) => getComputedStyle(el).fontSize)
  expect(size).toBe('16px')
})

/** `count` servers named `<prefix> 000`.., most members first, on one instance. */
function mergedEntries(prefix: string, count: number, from = 0) {
  const domain = `${prefix.toLowerCase()}.e2e.test`
  return Array.from({ length: count }, (_, i) => ({
    id: `https://${domain}/servers/${from + i}`, name: `${prefix} ${String(from + i).padStart(3, '0')}`, summary: '',
    icon: null, memberCount: 1000 - (from + i), handle: null, category: null, instance: { domain, name: null, icon: null },
  }))
}

async function openMergedList(page: Page) {
  await signIn(page, user)
  await page.goto(`/chat/${home.id}/${home.generalChannelId}`)
  const dialog = await openDiscovery(page)
  await dialog.getByRole('tab', { name: 'Other instances' }).click()
  return dialog
}

test('past 60 rows, the merged list is read again in pages and keeps every row', async ({ page }) => {
  test.setTimeout(120_000)
  const early = mergedEntries('Paged', 75)
  const late = { ...mergedEntries('Late', 1)[0], name: 'Late Arrival', memberCount: 5000 }
  const ranked = [late, ...early]
  let arrived = false
  const asked: string[] = []
  await backend.route(page)
  await page.route('**/api/federation/directory/servers**', (route) => {
    const params = new URL(route.request().url()).searchParams
    const offset = Number(params.get('offset') ?? 0)
    const limit = Number(params.get('limit') ?? 30)
    asked.push(`offset=${offset} limit=${limit}`)
    const list = arrived ? ranked : early
    const items = list.slice(offset, offset + limit)
    const json = {
      items, total: list.length, nextOffset: offset + limit < list.length ? offset + limit : null,
      instances: arrived ? 2 : 1, pending: arrived ? 0 : 1, failed: [], federationOff: false,
    }
    // The late instance answers once the last page is served.
    if (!arrived && offset + items.length >= early.length) arrived = true
    return route.fulfill({ json })
  })
  const dialog = await openMergedList(page)
  const cards = dialog.getByTestId('remote-directory-server')
  const more = dialog.getByRole('button', { name: 'Load more' })

  await expect(cards).toHaveCount(30, { timeout: 30000 })
  await more.click()
  await expect(cards).toHaveCount(60)
  await more.click()
  await expect(cards).toHaveCount(75)
  await expect(cards.first()).toContainText(late.name, { timeout: 15000 })
  await expect(cards).toHaveCount(75)
  await expect(cards.last()).toContainText('Paged 073')
  await expect(more).toBeVisible()
  expect(asked).toContain('offset=0 limit=60')
  expect(asked).toContain('offset=60 limit=15')
})

test('a failed Load more says so and tries again; the last page leaves focus on its first row; typing narrows at once', async ({ page }) => {
  test.setTimeout(120_000)
  const all = mergedEntries('Paged', 45)
  let failNext = true
  await backend.route(page)
  await page.route('**/api/federation/directory/servers**', async (route) => {
    const params = new URL(route.request().url()).searchParams
    const offset = Number(params.get('offset') ?? 0)
    const limit = Number(params.get('limit') ?? 30)
    const q = (params.get('q') ?? '').toLowerCase()
    if (offset === 30 && failNext) {
      failNext = false
      return route.fulfill({ status: 503, json: { error: 'unavailable' } })
    }
    // Answers for typed text arrive late, so the rows shown before them are narrowed on the page.
    if (q) await new Promise((resolve) => setTimeout(resolve, 1500))
    const list = all.filter((s) => s.name.toLowerCase().includes(q))
    const items = list.slice(offset, offset + limit)
    return route.fulfill({ json: {
      items, total: list.length, nextOffset: offset + limit < list.length ? offset + limit : null,
      instances: 1, pending: 0, failed: [], federationOff: false,
    } })
  })
  const dialog = await openMergedList(page)
  const cards = dialog.getByTestId('remote-directory-server')
  const more = dialog.getByRole('button', { name: 'Load more' })
  const failed = dialog.getByTestId('remote-directory-more-failed')
  const stats = dialog.getByTestId('remote-directory-stats')

  await test.step('a failed Load more says so; the button stays, focused, and tries again', async () => {
    await expect(cards).toHaveCount(30, { timeout: 30000 })
    await more.focus()
    await page.keyboard.press('Enter')
    await expect(failed).toHaveText("Couldn't load more servers. Try again.")
    await expect(cards).toHaveCount(30)
    await expect(more).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(cards).toHaveCount(45)
    await expect(failed).toHaveCount(0)
  })

  await test.step('the last page takes the button away and focus lands on the first row it added', async () => {
    await expect(more).toHaveCount(0)
    await expect(cards.nth(30)).toBeFocused()
  })

  await test.step('typed text narrows the rows at once; the count waits for the answer', async () => {
    await dialog.getByTestId('remote-directory').getByRole('button', { name: 'Search and filters' }).click()
    await dialog.getByTestId('remote-directory-search').fill('paged 01')
    await expect(cards).toHaveCount(10, { timeout: 1000 })
    await expect(stats).toHaveText('')
    await expect(stats).toHaveText('10 servers match', { timeout: 15000 })
    await expect(cards).toHaveCount(10)
  })
})
