// Journey: a server of 1,503 members, on a stack whose PostgREST answers at most 1000 rows.
//
// The viewer is a member of Big (1,503), Mid (602) and Small (4). In Big: 48 members are
// present (40 online, 5 away, 3 busy), one member is connected and invisible, one account
// posted and left. The member sidebar shows the instance's count and group counts, loads rows
// as they scroll into view and finds any member by search; every author keeps a name; @ finds
// a member the client has not loaded; starting on Small reads no other server's members. With
// the member directory functions answered as absent, the paged table reads fill the same list.
//
// The stack runs no realtime: presence is seeded in user_presence, and the invisible member's
// state is written by presence_heartbeat with its own session, as the client writes it.

import { test, expect, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import {
  adminClient,
  addChannel,
  addMember,
  composer,
  createUser,
  deleteUser,
  dismissAnnouncements,
  instanceDomain,
  loadApp,
  messageList,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

test.describe.configure({ mode: 'serial' })

const admin = adminClient()
const BULK = 1500
const MID = 600
const BIG_TOTAL = BULK + 3
// Bulk members who post, spread over the member order.
const SPREAD = Array.from({ length: 15 }, (_, k) => k * 100 + 50)
const tag = Date.now().toString(36)

let viewer: SpecUser
let owner: SpecUser
let ghost: SpecUser
let leaver: SpecUser
let erased: SpecUser
// The leaver's role colour while a member, rgb() as computed styles report it.
const ROLE_COLOR = '#e91e63'
const ROLE_RGB = 'rgb(233, 30, 99)'
// A picture served by the app itself, so it loads in any stack.
const LEAVER_AVATAR = '/icon_3d.webp'
let big: SeededServer
let mid: SeededServer
let small: SeededServer
let talk = ''
let bulk: Array<{ id: string; username: string; display_name: string }> = []

// Request counts and sizes per phase, written to MEMBERS_REPORT when set.
const report: Record<string, unknown> = {}

function env(...names: string[]): string {
  for (const name of names) if (process.env[name]) return process.env[name]!
  throw new Error(`none of ${names.join(', ')} is set - run: npm run e2e:up`)
}

async function insertChunked(table: string, rows: object[], size = 500): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await admin.from(table).insert(rows.slice(i, i + size))
    if (error) throw new Error(`${table} insert at ${i}: ${error.message}`)
  }
}

/** Presence rows as presence_publish leaves them. A device dated ahead outlives presence_sweep. */
async function seedPresence(members: Array<{ id: string }>, statusOf: (i: number) => number): Promise<void> {
  const now = new Date().toISOString()
  const ahead = new Date(Date.now() + 24 * 3600_000).toISOString()
  await insertChunked('presence_devices', members.map((p) => ({ profile_id: p.id, device_id: 'seed', is_mobile: false, last_seen_at: ahead })))
  await insertChunked('user_presence', members.map((p, i) => ({
    profile_id: p.id, status: statusOf(i), online: true, is_mobile: false, last_seen_at: now,
    published_status: statusOf(i), published_mobile: false, published_at: now,
  })))
}

test.beforeAll(async () => {
  test.setTimeout(600_000)
  owner = await createUser(admin, 'lsown')
  viewer = await createUser(admin, 'lsview')
  ghost = await createUser(admin, 'lsghost')
  leaver = await createUser(admin, 'lsleft')
  erased = await createUser(admin, 'lserase')
  const domain = await instanceDomain(admin)
  const avatar = await admin.from('profiles').update({ avatar_url: LEAVER_AVATAR }).eq('id', leaver.id)
  if (avatar.error) throw new Error(`leaver avatar: ${avatar.error.message}`)

  big = await seedServer(admin, owner, `Big ${tag}`)
  mid = await seedServer(admin, owner, `Mid ${tag}`)
  small = await seedServer(admin, owner, `Small ${tag}`)
  talk = await addChannel(admin, big, 'talk')

  const profileRows = Array.from({ length: BULK }, (_, i) => {
    const n = String(i).padStart(4, '0')
    return { username: `bm${tag}${n}`, display_name: `Bulk ${tag} ${n}`, is_local: true, domain }
  })
  for (let i = 0; i < profileRows.length; i += 500) {
    const { data, error } = await admin.from('profiles').insert(profileRows.slice(i, i + 500)).select('id, username, display_name')
    if (error || !data) throw new Error(`profiles insert at ${i}: ${error?.message}`)
    bulk.push(...data)
  }
  bulk = bulk.sort((a, b) => a.username.localeCompare(b.username))
  // One offline member whose name starts with an accented letter: it sorts among the a's.
  bulk[1499].display_name = `Ärmel ${tag}`
  const renamed = await admin.from('profiles').update({ display_name: bulk[1499].display_name }).eq('id', bulk[1499].id)
  if (renamed.error) throw new Error(`rename: ${renamed.error.message}`)

  await insertChunked('user_servers', bulk.map((p) => ({ user_id: p.id, server_id: big.id, status: 'accepted' })))
  for (const u of [viewer, ghost, leaver, erased]) await addMember(admin, u, big.id)
  await insertChunked('user_servers', bulk.slice(0, MID).map((p) => ({ user_id: p.id, server_id: mid.id, status: 'accepted' })))
  await addMember(admin, viewer, mid.id)
  await insertChunked('user_servers', bulk.slice(700, 702).map((p) => ({ user_id: p.id, server_id: small.id, status: 'accepted' })))
  await addMember(admin, viewer, small.id)

  // Bulk 0-39 online, 40-44 away, 45-47 busy.
  await seedPresence(bulk.slice(0, 48), (i) => (i < 40 ? 1 : i < 45 ? 2 : 3))

  const ghostClient = createClient(env('E2E_SUPABASE_URL', 'TEST_SUPABASE_URL'), env('E2E_SUPABASE_ANON_KEY', 'TEST_SUPABASE_ANON_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })
  const signedIn = await ghostClient.auth.signInWithPassword({ email: ghost.email, password: ghost.password })
  if (signedIn.error) throw new Error(`ghost sign-in: ${signedIn.error.message}`)
  const beat = await ghostClient.rpc('presence_heartbeat', { p_device_id: 'e2e-ghost', p_status: 4, p_is_mobile: false })
  if (beat.error) throw new Error(`ghost heartbeat: ${beat.error.message}`)
  await admin.from('presence_devices').update({ last_seen_at: new Date(Date.now() + 24 * 3600_000).toISOString() }).eq('profile_id', ghost.id)

  const base = Date.now() - 20 * 60_000
  const say = (userId: string, text: string, i: number) => ({
    channel_id: talk, user_id: userId, content: [{ type: 'text', text }], created_at: new Date(base + i * 30_000).toISOString(),
  })
  const { error: msgError } = await admin.from('messages').insert([
    say(owner.id, `owner-marker-${tag}`, 0),
    say(ghost.id, `ghost-marker-${tag}`, 1),
    say(bulk[1400].id, `offline-marker-${tag}`, 2),
    say(bulk[5].id, `online-marker-${tag}`, 3),
    say(leaver.id, `leaver-marker-${tag}`, 4),
    say(erased.id, `erased-marker-${tag}`, 5),
    ...SPREAD.map((n, k) => say(bulk[n].id, `spread${n}-marker-${tag}`, 6 + k)),
  ])
  if (msgError) throw new Error(`messages: ${msgError.message}`)

  // The leaver held a coloured role, then left: leaving drops its roles on the server.
  const { data: role, error: roleError } = await admin.from('server_roles')
    .insert({ server_id: big.id, name: `Pink ${tag}`, color: ROLE_COLOR, position: 3 }).select('id').single()
  if (roleError || !role) throw new Error(`role: ${roleError?.message}`)
  const assigned = await admin.from('user_roles').insert({ user_id: leaver.id, role_id: role.id, server_id: big.id })
  if (assigned.error) throw new Error(`assign role: ${assigned.error.message}`)
  const left = await admin.from('user_servers').delete().eq('user_id', leaver.id).eq('server_id', big.id)
  if (left.error) throw new Error(`leaver leave: ${left.error.message}`)

  // The erased account deletes itself, as Settings does.
  const erasedClient = createClient(env('E2E_SUPABASE_URL', 'TEST_SUPABASE_URL'), env('E2E_SUPABASE_ANON_KEY', 'TEST_SUPABASE_ANON_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })
  const erasedIn = await erasedClient.auth.signInWithPassword({ email: erased.email, password: erased.password })
  if (erasedIn.error) throw new Error(`erased sign-in: ${erasedIn.error.message}`)
  const deleted = await erasedClient.rpc('delete_my_account', { p_password: erased.password })
  if (deleted.error) throw new Error(`delete_my_account: ${deleted.error.message}`)
})

test.afterAll(async () => {
  if (process.env.MEMBERS_REPORT) fs.writeFileSync(process.env.MEMBERS_REPORT, JSON.stringify(report, null, 2))
  for (const s of [big, mid, small]) if (s) await admin.from('servers').delete().eq('id', s.id)
  for (let i = 0; i < bulk.length; i += 200) {
    await admin.from('profiles').delete().in('id', bulk.slice(i, i + 200).map((p) => p.id))
  }
  for (const u of [viewer, owner, ghost, leaver, erased]) await deleteUser(admin, u)
})

interface Rec { what: string; filter: string; status: number; rows: number | null; bytes: number; online?: number }

/** Member, profile and presence requests of a page, from `reset()` on. */
function record(page: Page): { recs: Rec[]; reset: () => void } {
  const recs: Rec[] = []
  page.on('response', async (response) => {
    const url = response.url()
    const m = url.match(/\/rest\/v1\/(user_servers|user_roles|profiles|rpc\/get_presence|rpc\/get_server_member_list|rpc\/search_server_members|rpc\/get_server_member_roles)(\?|$)/)
    if (!m) return
    const request = response.request()
    if (request.method() === 'OPTIONS' || request.method() === 'HEAD') return
    let rows: number | null = null
    let bytes = 0
    let online: number | undefined
    try {
      const body = await response.body()
      bytes = body.length
      const parsed = JSON.parse(body.toString())
      rows = Array.isArray(parsed) ? parsed.length : Array.isArray(parsed?.members) ? parsed.members.length : null
      // A member list answer: how many it counts online.
      if (Array.isArray(parsed?.groups)) online = parsed.groups.find((g: { key: string }) => g.key === 'online')?.count ?? 0
    } catch { /* empty body */ }
    const q = new URL(url).searchParams
    let filter = ''
    if (m[1] === 'user_servers' || m[1] === 'user_roles') {
      filter = `select=${(q.get('select') ?? '').slice(0, 24)} server_id=${(q.get('server_id') ?? '').slice(0, 3)} user_id=${(q.get('user_id') ?? '').slice(0, 3)}`
    } else if (m[1] === 'profiles') {
      const id = q.get('id') ?? ''
      filter = `ids=${id.startsWith('in.') ? id.split(',').length : id ? 1 : 0}`
    } else {
      filter = (request.postData() ?? '').replace(/"p_user_ids":\[[^\]]*\]/, (ids) => `"p_user_ids":${ids.split(',').length}`).slice(0, 120)
    }
    recs.push({ what: `${request.method()} ${m[1]}`, filter, status: response.status(), rows, bytes, online })
  })
  return { recs, reset: () => { recs.length = 0 } }
}

/** Waits until no recorded request has finished for `quietMs`. */
async function settle(page: Page, recs: Rec[], quietMs = 3000, maxMs = 120_000): Promise<void> {
  const start = Date.now()
  let last = recs.length
  let lastChange = Date.now()
  while (Date.now() - start < maxMs) {
    await page.waitForTimeout(250)
    if (recs.length !== last) { last = recs.length; lastChange = Date.now() }
    else if (Date.now() - lastChange >= quietMs) return
  }
}

function summarize(recs: Rec[]) {
  const groups: Record<string, { requests: number; rows: number; bytes: number }> = {}
  for (const r of recs) {
    const g = (groups[r.what] ??= { requests: 0, rows: 0, bytes: 0 })
    g.requests++
    g.rows += r.rows ?? 0
    g.bytes += r.bytes
  }
  return groups
}

const sidebar = (page: Page) => page.locator('.user-sidebar')
const memberCount = (page: Page) => sidebar(page).locator('[data-testid="member-count"]')
const header = (page: Page, title: string) =>
  sidebar(page).locator('.group-header .group-title-text').filter({ hasText: new RegExp(`^${title} - \\d+$`, 'i') })
const memberRow = (page: Page, name: string) => sidebar(page).locator('.user-item').filter({ hasText: name })
const suggestions = (page: Page) => page.locator('#auto-suggest-listbox .suggest-item')
const authorOf = (page: Page, marker: string) =>
  messageList(page).locator('.message-item').filter({ hasText: `${marker}-marker-${tag}` }).first().locator('.username-text').first()

/** Scrolls the message list until the row of `marker` is rendered: the list draws the rows in view. */
async function showMessage(page: Page, marker: string): Promise<void> {
  const row = messageList(page).locator('.message-item').filter({ hasText: `${marker}-marker-${tag}` }).first()
  await expect(async () => {
    if (await row.count() === 0) await messageList(page).evaluate((el) => { el.scrollTop = 0 })
    await expect(row).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 30000, intervals: [250, 500, 1000] })
  await row.scrollIntoViewIfNeeded()
}

async function scrollMembers(page: Page, fraction: number): Promise<void> {
  await sidebar(page).locator('.user-groups').evaluate((el, f) => { el.scrollTop = (el.scrollHeight - el.clientHeight) * f }, fraction)
}

async function openBig(page: Page): Promise<void> {
  await loadApp(page, `/chat/${big.id}/${talk}`, messageList(page))
  await dismissAnnouncements(page)
  // The newest seeded message: the list opens at its end.
  await expect(messageList(page).locator('.message-item').filter({ hasText: `spread${SPREAD[SPREAD.length - 1]}-marker-${tag}` }))
    .toBeVisible({ timeout: 30000 })
}

test('the member list of a large server: count, groups, rows by range, search', async ({ page }) => {
  test.setTimeout(300_000)

  const { data: stats } = await admin.from('server_member_stats').select('member_count').eq('server_id', big.id).single()
  expect(stats?.member_count, 'the stored count follows joins and the departure').toBe(BIG_TOTAL)

  await signIn(page, viewer)
  const { recs, reset } = record(page)
  reset()
  await openBig(page)

  await expect(memberCount(page)).toHaveText(/^1,?503 members$/i, { timeout: 30000 })
  // 40 online members and the viewer; away and busy follow.
  await expect(header(page, 'online')).toHaveText(/ - 41$/, { timeout: 30000 })
  await settle(page, recs)
  report.bigColdStart = summarize(recs)
  // The first answer already counts the viewer online: no wait for its presence to be published.
  expect(recs.find((r) => r.what.includes('get_server_member_list'))?.online, 'the viewer is online in the first answer').toBe(41)

  // No read of the whole membership, of any table.
  expect(recs.filter((r) => r.what === 'GET user_servers' && r.filter.includes('select=user_id')), 'no member id list is read').toEqual([])
  // A read naming one user is that user's own roles.
  expect(recs.filter((r) => r.what === 'GET user_roles' && r.filter.endsWith('user_id=')), 'no assignment list is read').toEqual([])
  expect(recs.every((r) => r.status < 400), JSON.stringify(recs.filter((r) => r.status >= 400))).toBe(true)
  const profileRows = recs.filter((r) => r.what === 'GET profiles').reduce((n, r) => n + (r.rows ?? 0), 0)
  expect(profileRows, 'profiles are read for authors, not for the membership').toBeLessThan(100)

  // The offline header follows the 49 present members and their three headers.
  await sidebar(page).locator('.user-groups').evaluate((el) => { el.scrollTop = 49 * 44 + 3 * 30 - 120 })
  await expect(header(page, 'offline')).toHaveText(new RegExp(` - ${BIG_TOTAL - 49}$`), { timeout: 30000 })
  await expect(header(page, 'busy')).toHaveText(/ - 3$/)
  // Names are ordered as a browser orders them: Ärmel leads the offline group, before every Bulk.
  await expect.poll(() => sidebar(page).evaluate((root) => {
    const offline = [...root.querySelectorAll('.group-header')].find(h => /^offline/i.test(h.textContent?.trim() ?? ''))
    const index = Number(offline?.closest('[data-index]')?.getAttribute('data-index'))
    return root.querySelector(`[data-index="${index + 1}"] .user-name`)?.textContent?.trim() ?? null
  }), { timeout: 15000 }).toBe(bulk[1499].display_name)

  // The end of the list: rows there load when they scroll into view.
  await scrollMembers(page, 1)
  await expect(memberRow(page, owner.displayName)).toBeVisible({ timeout: 30000 })
  await expect(memberRow(page, ghost.displayName), 'the invisible member is listed offline').toHaveClass(/offline-user/)
  await expect(sidebar(page).locator('[data-testid="member-placeholder"]')).toHaveCount(0, { timeout: 30000 })

  // The middle: offline members sort by name, so position follows the bulk number.
  await scrollMembers(page, 0.5)
  await expect(sidebar(page).locator('.user-item').filter({ hasText: new RegExp(`Bulk ${tag} 07\\d\\d`) }).first()).toBeVisible({ timeout: 30000 })
  await expect(sidebar(page).locator('[data-testid="member-placeholder"]')).toHaveCount(0, { timeout: 30000 })
  await settle(page, recs)
  report.bigAfterScroll = summarize(recs)

  // Search is answered by the instance: a member far from every loaded row is found.
  await scrollMembers(page, 0)
  await sidebar(page).locator('[data-testid="member-search"]').fill(bulk[1234].username)
  await expect(memberRow(page, bulk[1234].display_name)).toBeVisible({ timeout: 30000 })
  await expect(sidebar(page).locator('.user-item')).toHaveCount(1)
  await expect(memberCount(page), 'the count stays the server\'s').toHaveText(/1,?503 members/i)
  await sidebar(page).locator('[data-testid="member-search"]').fill('')
  await expect(header(page, 'online')).toHaveText(/ - 41$/, { timeout: 30000 })
})

test('every author keeps a name: invisible, offline, far in the list, departed, deleted', async ({ page }) => {
  test.setTimeout(300_000)
  await signIn(page, viewer)
  const { recs } = record(page)
  await openBig(page)
  await expect(memberCount(page)).toHaveText(/1,?503 members/i, { timeout: 30000 })

  // Member pages from both ends of the list pass through the profile cache first.
  await scrollMembers(page, 1)
  await expect(memberRow(page, owner.displayName)).toBeVisible({ timeout: 30000 })
  await scrollMembers(page, 0.5)
  await expect(sidebar(page).locator('[data-testid="member-placeholder"]')).toHaveCount(0, { timeout: 30000 })
  await scrollMembers(page, 0)
  await settle(page, recs)

  const named: Array<[string, string, string?]> = [
    ['owner', owner.displayName],
    ['ghost', ghost.displayName, 'the invisible member'],
    ['offline', bulk[1400].display_name],
    ['online', bulk[5].display_name],
    ['leaver', leaver.displayName, 'the account that left'],
    ...SPREAD.map((n): [string, string, string] => [`spread${n}`, bulk[n].display_name, `bulk ${n}`]),
  ]
  for (const [marker, name, what] of named) {
    await showMessage(page, marker)
    await expect(authorOf(page, marker), what).toHaveText(name)
  }

  // The account that left keeps its own picture, and no colour of a role it no longer holds.
  await showMessage(page, 'leaver')
  const leaverRow = messageList(page).locator('.message-item').filter({ hasText: `leaver-marker-${tag}` }).first()
  await expect(leaverRow.locator('.message-avatar img').first()).toHaveAttribute('src', LEAVER_AVATAR)
  const leaverColor = await leaverRow.locator('.username').first().evaluate((el) => getComputedStyle(el).color)
  expect(leaverColor, 'no role colour').not.toBe(ROLE_RGB)
  // Bulk 1400 holds the default role alone. The owner's role is coloured.
  await showMessage(page, 'offline')
  const plainColor = await authorOf(page, 'offline').evaluate((el) => getComputedStyle(el.closest('.username')!).color)
  expect(leaverColor, 'the colour of a member without a coloured role').toBe(plainColor)

  // A deleted account reads "Deleted User", with the default picture.
  await showMessage(page, 'erased')
  const erasedRow = messageList(page).locator('.message-item').filter({ hasText: `erased-marker-${tag}` }).first()
  await expect(authorOf(page, 'erased')).toHaveText('Deleted User')
  await expect(erasedRow.locator('.message-avatar img').first()).toHaveAttribute('src', /default_avatar/)
})

test('@ finds a member the client has not loaded, and the pick is a real mention', async ({ page }) => {
  test.setTimeout(300_000)
  await signIn(page, viewer)
  const { recs, reset } = record(page)
  await openBig(page)
  await expect(memberCount(page)).toHaveText(/1,?503 members/i, { timeout: 30000 })
  await settle(page, recs)

  // Offline, 1,300 rows from the head of the list: in no loaded page.
  const target = bulk[1300]
  const cached = await page.evaluate(async (id) => {
    const { userDataService } = await import('/src/services/userDataService.ts' as string)
    return !!userDataService.getUser(id)
  }, target.id)
  expect(cached, 'the member is not in the client cache').toBe(false)

  reset()
  await composer(page).click()
  await page.keyboard.insertText('@')
  await page.waitForTimeout(600)
  expect(recs.filter((r) => r.what.includes('search_server_members')), 'a bare @ asks nothing').toEqual([])

  await page.keyboard.insertText(target.username.slice(0, -1))
  await expect(suggestions(page).filter({ hasText: target.display_name })).toBeVisible({ timeout: 15000 })
  // The invisible member is found like any other.
  for (let i = 0; i < target.username.length - 1; i++) await page.keyboard.press('Backspace')
  await page.keyboard.insertText(ghost.username)
  await expect(suggestions(page).filter({ hasText: ghost.displayName })).toBeVisible({ timeout: 15000 })
  for (let i = 0; i < ghost.username.length; i++) await page.keyboard.press('Backspace')
  await page.keyboard.insertText(target.username)
  await expect(suggestions(page).filter({ hasText: target.display_name })).toBeVisible({ timeout: 15000 })
  await page.keyboard.press('Enter')
  await expect(composer(page)).toContainText(`@${target.username}`)
  await page.keyboard.press('Enter')

  await expect.poll(async () => {
    const { data } = await admin.from('messages').select('content').eq('channel_id', talk).eq('user_id', viewer.id).order('created_at', { ascending: false }).limit(1)
    return (data?.[0]?.content as Array<{ type: string; userId?: string }> | undefined)?.find((p) => p.type === 'mention')?.userId
  }, { timeout: 30000 }).toBe(target.id)
  report.mentionSearch = summarize(recs)
})

test('message search suggests an author the client has not loaded', async ({ page }) => {
  test.setTimeout(300_000)
  await signIn(page, viewer)
  await openBig(page)
  await expect(memberCount(page)).toHaveText(/1,?503 members/i, { timeout: 30000 })

  // Offline, 1,200 rows from the head of the list.
  const target = bulk[1200]
  await page.locator('.search-btn').click()
  const input = page.locator('.search-query-input')
  await expect(input).toBeVisible({ timeout: 10000 })
  await input.fill(`from:${target.username.slice(0, -1)}`)
  await expect(page.locator('.search-option-hint').filter({ hasText: `@${target.username}` })).toHaveCount(1, { timeout: 15000 })
})

test('starting on a small server reads no other server\'s members', async ({ page }) => {
  test.setTimeout(300_000)
  await signIn(page, viewer)
  const { recs, reset } = record(page)
  reset()
  await loadApp(page, `/chat/${small.id}/${small.generalChannelId}`, messageList(page))
  await dismissAnnouncements(page)
  await expect(memberCount(page)).toHaveText(/^4 members$/i, { timeout: 30000 })
  await settle(page, recs)
  report.smallColdStart = summarize(recs)

  expect(recs.filter((r) => r.what === 'GET user_servers' && r.filter.includes('select=user_id')), 'no member id list is read').toEqual([])
  const lists = recs.filter((r) => r.what.includes('get_server_member_list'))
  expect(lists.every((r) => r.filter.includes(small.id)), 'only the open server\'s list is read').toBe(true)
  const profileRows = recs.filter((r) => r.what === 'GET profiles').reduce((n, r) => n + (r.rows ?? 0), 0)
  expect(profileRows).toBeLessThan(20)

  // The other servers answer in full when opened.
  const rail = page.locator('#app-server-rail')
  await rail.locator(`[aria-label*="Mid ${tag}"]`).first().click()
  await page.waitForURL(new RegExp(mid.id), { timeout: 30000 })
  await expect(memberCount(page)).toHaveText(/^602 members$/i, { timeout: 30000 })
  await sidebar(page).locator('[data-testid="member-search"]').fill(viewer.username)
  await expect(memberRow(page, viewer.displayName), 'the viewer is in the list').toBeVisible({ timeout: 30000 })
  await sidebar(page).locator('[data-testid="member-search"]').fill('')

  await rail.locator(`[aria-label*="Big ${tag}"]`).first().click()
  await page.waitForURL(new RegExp(big.id), { timeout: 30000 })
  await expect(memberCount(page)).toHaveText(/1,?503 members/i, { timeout: 30000 })
  await expect(header(page, 'online')).toHaveText(/ - 41$/, { timeout: 30000 })
})

test('an invisible viewer is listed offline, as others see it, in a server of any size', async ({ page }) => {
  test.setTimeout(300_000)
  const setStatus = async (label: string) => {
    await page.locator('.user-status-container').click()
    await page.locator('.status-option').filter({ hasText: label }).click()
  }
  const ownRow = () => memberRow(page, viewer.displayName)

  await signIn(page, viewer)
  await loadApp(page, `/chat/${small.id}/${small.generalChannelId}`, messageList(page))
  await dismissAnnouncements(page)
  await expect(memberCount(page)).toHaveText(/^4 members$/i, { timeout: 30000 })
  await expect(header(page, 'online')).toHaveText(/ - 1$/)
  await expect(ownRow()).not.toHaveClass(/offline-user/)

  // A server held whole: the list follows the status at once.
  await setStatus('Invisible')
  await expect(ownRow()).toHaveClass(/offline-user/)
  await expect(header(page, 'online')).toHaveCount(0)
  await expect(header(page, 'offline')).toHaveText(/ - 4$/)

  // A large server, ordered by the instance: the same.
  await page.locator('#app-server-rail').locator(`[aria-label*="Big ${tag}"]`).first().click()
  await page.waitForURL(new RegExp(big.id), { timeout: 30000 })
  await expect(memberCount(page)).toHaveText(/1,?503 members/i, { timeout: 30000 })
  await expect(header(page, 'online')).toHaveText(/ - 40$/)
  await sidebar(page).locator('[data-testid="member-search"]').fill(viewer.username)
  await expect(ownRow()).toHaveClass(/offline-user/, { timeout: 15000 })
  await sidebar(page).locator('[data-testid="member-search"]').fill('')
  await expect(header(page, 'online')).toHaveText(/ - 40$/, { timeout: 15000 })

  // Back online: the viewer is in the online group again within the default wait, with no
  // broadcast and no timer.
  await setStatus('Online')
  await expect(header(page, 'online')).toHaveText(/ - 41$/)
  await sidebar(page).locator('[data-testid="member-search"]').fill(viewer.username)
  await expect(ownRow()).not.toHaveClass(/offline-user/, { timeout: 15000 })
})

test('Discord members of a bridge join the list in their presence groups, whole or windowed', async ({ page }) => {
  test.setTimeout(300_000)
  // The bot gateway's answer for a bridged channel, as a bridge's member sync leaves it.
  const discord = [
    { id: '9101', username: `dcon${tag}`, displayName: `Discord On ${tag}`, presenceStatus: 'online' },
    { id: '9102', username: `dcaway${tag}`, displayName: `Discord Away ${tag}`, presenceStatus: 'away' },
    { id: '9103', username: `dcoff${tag}`, displayName: `Discord Off ${tag}`, presenceStatus: 'offline' },
  ].map((u) => ({ ...u, avatarUrl: '/default_avatar.webp', source: 'discord', harmonyRoleIds: [], customStatus: null }))
  await page.route(/\/bot-gateway\/bridged-users\/(?!server\/)[^/?]+/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ has_bridge: true, users: discord }) }))
  const bridgedRow = (name: string) => sidebar(page).locator('.user-item.bridged-discord-user').filter({ hasText: name })

  await signIn(page, viewer)
  // A server held whole.
  await loadApp(page, `/chat/${small.id}/${small.generalChannelId}`, messageList(page))
  await dismissAnnouncements(page)
  await expect(memberCount(page)).toHaveText(/^7 members$/i, { timeout: 30000 })
  await expect(header(page, 'online')).toHaveText(/ - 2$/)
  await expect(header(page, 'away')).toHaveText(/ - 1$/)
  await expect(header(page, 'offline')).toHaveText(/ - 4$/)
  await expect(bridgedRow(`Discord On ${tag}`)).not.toHaveClass(/offline-user/)
  await expect(bridgedRow(`Discord Off ${tag}`)).toHaveClass(/offline-user/)

  // A windowed server: the same rows, after the server's members of each group.
  await openBig(page)
  await expect(memberCount(page)).toHaveText(/^1,?506 members$/i, { timeout: 30000 })
  await expect(header(page, 'online')).toHaveText(/ - 42$/)
  // The end of the online group: the Discord member after the 41 members, then the away header.
  await sidebar(page).locator('.user-groups').evaluate((el) => { el.scrollTop = 41 * 44 + 30 - 120 })
  await expect(bridgedRow(`Discord On ${tag}`)).toBeVisible({ timeout: 15000 })
  await expect(header(page, 'away')).toHaveText(/ - 6$/)
  await scrollMembers(page, 1)
  await expect(bridgedRow(`Discord Off ${tag}`)).toBeVisible({ timeout: 30000 })
  await expect(bridgedRow(`Discord Off ${tag}`)).toHaveClass(/offline-user/)
})

test('a presence broadcast moves a member the client had not loaded', async ({ page }) => {
  test.setTimeout(300_000)
  await signIn(page, viewer)
  const { recs, reset } = record(page)
  await loadApp(page, `/chat/${mid.id}/${mid.generalChannelId}`, messageList(page))
  await dismissAnnouncements(page)
  await expect(memberCount(page)).toHaveText(/^602 members$/i, { timeout: 30000 })
  await expect(header(page, 'online')).toHaveText(/ - 41$/, { timeout: 30000 })
  await settle(page, recs)

  // An offline member, 300 rows down, comes online: the database publishes it, and the
  // broadcast the stack has no Realtime to carry is handed to the page's channel.
  const comer = bulk[300]
  await seedPresence([comer], () => 1)
  reset()
  const delivered = await page.evaluate(async ({ serverId, userId }) => {
    const { supabase } = await import('/src/supabase.ts' as string)
    const channel = supabase.getChannels().find((c: { topic: string }) => c.topic.endsWith(`server-presence:${serverId}`))
    if (!channel) return false
    channel._trigger('broadcast', {
      type: 'broadcast',
      event: 'presence_event',
      payload: { type: 'presence:update', user_id: userId, online: true, status: 1, is_mobile: false },
    })
    return true
  }, { serverId: mid.id, userId: comer.id })
  expect(delivered, 'the page holds the server-presence channel').toBe(true)

  await expect(header(page, 'online')).toHaveText(/ - 42$/, { timeout: 30000 })
  // Its row is the 41st of the online group, by name after bulk 0039.
  await sidebar(page).locator('.user-groups').evaluate((el) => { el.scrollTop = 34 * 44 })
  await expect(memberRow(page, comer.display_name)).toBeVisible({ timeout: 15000 })
  await expect(memberRow(page, comer.display_name)).not.toHaveClass(/offline-user/)
  await settle(page, recs)
  const lists = recs.filter((r) => r.what.includes('get_server_member_list'))
  expect(lists.length, 'one re-read of the pages in view, not one per event').toBeLessThanOrEqual(2)
  report.presenceEvent = summarize(recs)
})

test('an instance without the member directory still lists every member', async ({ page }) => {
  test.setTimeout(300_000)
  // As an instance before 20261113100001 answers: no such function.
  await page.route(/\/rest\/v1\/rpc\/(get_server_member_list|search_server_members|get_server_member_roles|get_server_role_member_counts)/, (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function in the schema cache', details: null, hint: null }),
    }))

  await signIn(page, viewer)
  const { recs, reset } = record(page)
  reset()
  await openBig(page)

  // Member ids come from the table, in pages past the 1000-row cap.
  await expect(memberCount(page)).toHaveText(/^1,?503 members$/i, { timeout: 60000 })
  // The recorder reads each body after its response: polled.
  await expect.poll(() => recs.filter((r) => r.what === 'GET user_servers' && r.filter.includes('select=user_id')).map((r) => r.rows))
    .toEqual([1000, 503])
  // 40 online members, bulk 300 from the test before, and the viewer.
  await expect(header(page, 'online')).toHaveText(/ - 42$/, { timeout: 30000 })
  await showMessage(page, 'ghost')
  await expect(authorOf(page, 'ghost')).toHaveText(ghost.displayName)
  await showMessage(page, 'leaver')
  await expect(authorOf(page, 'leaver'), 'the account that left').toHaveText(leaver.displayName)

  // Profiles follow in the background; the last of them is in the list at the end.
  await settle(page, recs, 3000, 180_000)
  report.legacyColdStart = summarize(recs)
  await scrollMembers(page, 1)
  await expect(memberRow(page, owner.displayName)).toBeVisible({ timeout: 60000 })
  await showMessage(page, 'leaver')
  await expect(authorOf(page, 'leaver'), 'kept beside 1,503 cached members').toHaveText(leaver.displayName)
})

test('more than 1000 members present at once', async ({ page }) => {
  test.setTimeout(300_000)
  // Bulk 48-1199 come online: 1,192 online members and the viewer, 5 away, 3 busy.
  // Bulk 300 came online in the test before this one.
  await seedPresence(bulk.slice(48, 1200).filter((p) => p.id !== bulk[300].id), () => 1)

  await signIn(page, viewer)
  const { recs, reset } = record(page)
  reset()
  await openBig(page)
  await expect(header(page, 'online')).toHaveText(/ - 1193$/, { timeout: 30000 })
  await expect(memberCount(page)).toHaveText(/1,?503 members/i)
  await expect(sidebar(page).locator('.user-item').first()).toBeVisible()
  await settle(page, recs)
  report.crowdColdStart = summarize(recs)
  const profileRows = recs.filter((r) => r.what === 'GET profiles').reduce((n, r) => n + (r.rows ?? 0), 0)
  expect(profileRows, 'present members are not read one profile batch at a time').toBeLessThan(100)

  // Deep in the online group, then the offline group after it.
  await scrollMembers(page, 0.5)
  await expect(sidebar(page).locator('.user-item').filter({ hasText: new RegExp(`Bulk ${tag} 0[5-9]\\d\\d`) }).first()).toBeVisible({ timeout: 30000 })
  await scrollMembers(page, 1)
  await expect(memberRow(page, owner.displayName)).toBeVisible({ timeout: 30000 })
  await expect(memberRow(page, bulk[1498].display_name), 'an offline member past the 1,201 present ones').toHaveClass(/offline-user/)
})
