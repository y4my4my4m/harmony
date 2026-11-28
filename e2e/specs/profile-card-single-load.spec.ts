// Journey: a profile card reads the account's profiles row once per open, and each figure in it
// (Posts, Following, Followers, Messages, Voice time) goes from its placeholder straight to its
// value. A reopened card shows the figures it read before at once and reads the row once more,
// so a figure that changed meanwhile goes from its old value to its new one.
//
//   - the card's columns are read in one request per open, and no request naming the account
//     is sent twice;
//   - each figure shows the placeholder or its value, never a value then the placeholder again;
//   - the stats row keeps its items (Posts, Following, Followers) from the first frame;
//   - a reopened card shows no placeholder.

import { test, expect, type Locator, type Page, type Request } from '@playwright/test'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
const PLACEHOLDER = '–'
const FIGURES = {
  'profile-stat-posts': '7',
  'profile-stat-following': '3',
  'profile-stat-followers': '5',
  'profile-activity-messages': '42',
  'profile-activity-voice': '1h 35m',
} as const
type Figure = keyof typeof FIGURES
const STATS_ROW = 'Member since | Status | Posts | Following | Followers'
// The duplicate read this guards against landed within 30 ms of the first; the window holds any repeat.
const SETTLE_MS = 1500

let reader: SpecUser
let ada: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  reader = await createUser(admin, 'pcl')
  ada = await createUser(admin, 'pca')
  server = await seedServer(admin, ada, `Profile card ${ada.username}`)
  await addMember(admin, reader, server.id)
  const { error } = await admin.from('profiles')
    .update({ posts_count: 7, following_count: 3, followers_count: 5, message_count: 42, voice_minutes: 95 })
    .eq('id', ada.id)
  if (error) throw new Error(`counters: ${error.message}`)
})

test.afterAll(async () => {
  for (const user of [reader, ada]) if (user) await deleteUser(admin, user)
})

/**
 * Records, after every DOM change, each figure's text and the stats row's labels (key `row`).
 * Consecutive repeats are dropped; absence is recorded once the element has been seen.
 */
async function recordCard(page: Page): Promise<void> {
  await page.evaluate((ids) => {
    const w = window as unknown as { __card: Record<string, string[]>; __cardObserver?: MutationObserver }
    w.__cardObserver?.disconnect()
    w.__card = Object.fromEntries([...ids, 'row'].map(id => [id, []]))
    const push = (key: string, text: string | null) => {
      const seq = w.__card[key]
      const value = text ?? (seq.length ? 'absent' : null)
      if (value !== null && seq[seq.length - 1] !== value) seq.push(value)
    }
    const snap = () => {
      for (const id of ids) push(id, document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? null)
      const labels = Array.from(document.querySelectorAll('.profile-modal-content .user-stats .stat-label'))
      push('row', labels.length ? labels.map(l => l.textContent?.trim()).join(' | ') : null)
    }
    w.__cardObserver = new MutationObserver(snap)
    w.__cardObserver.observe(document.body, { subtree: true, childList: true, characterData: true })
  }, Object.keys(FIGURES))
}

const cardHistory = (page: Page) =>
  page.evaluate(() => (window as unknown as { __card: Record<string, string[]> }).__card)

/** Requests naming `profileId`, from now on. */
function watchRequests(page: Page, profileId: string): string[] {
  const urls: string[] = []
  page.on('request', (request: Request) => {
    const url = new URL(request.url())
    const path = decodeURIComponent(`${url.pathname}${url.search}`)
    if (path.includes(profileId)) urls.push(`${request.method()} ${path}`)
  })
  return urls
}

const CARD_COLUMN = /select=(\*|[^&]*\b(message_count|voice_minutes|posts_count|followers_count|following_count|created_at|manually_approves_followers)\b)/

/** Reads of the account's own profiles row that select a column the card shows. */
const cardRowReads = (urls: string[], profileId: string) =>
  urls.filter(u => u.includes('/rest/v1/profiles?') && u.includes(`id=eq.${profileId}`) && CARD_COLUMN.test(u))

const duplicates = (urls: string[]) => urls.filter((u, i) => urls.indexOf(u) !== i)

/** Opens Ada's card from the member list and waits until every figure shows `final`. */
async function openCard(page: Page, final: Record<Figure, string>): Promise<{ modal: Locator; urls: string[] }> {
  await recordCard(page)
  const urls = watchRequests(page, ada.id)
  await page.locator('.user-sidebar .user-item').filter({ hasText: ada.displayName }).first().click()
  const modal = page.locator('.profile-modal-content')
  await expect(modal).toBeVisible({ timeout: 15000 })
  for (const id of Object.keys(final) as Figure[]) {
    await expect(modal.getByTestId(id)).toHaveText(final[id], { timeout: 15000 })
  }
  await page.waitForTimeout(SETTLE_MS)
  return { modal, urls }
}

function expectOneRead(urls: string[]) {
  expect.soft(cardRowReads(urls, ada.id), urls.join('\n')).toHaveLength(1)
  expect.soft(duplicates(urls), urls.join('\n')).toEqual([])
}

test('the profile card reads the row once per open and shows each figure without going back', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, reader)
  await openChannel(page, server.id, server.generalChannelId)

  await test.step('first open: placeholder, then the value', async () => {
    const { modal, urls } = await openCard(page, FIGURES)
    expectOneRead(urls)
    const history = await cardHistory(page)
    for (const id of Object.keys(FIGURES) as Figure[]) {
      expect.soft([[FIGURES[id]], [PLACEHOLDER, FIGURES[id]]], `${id}: ${history[id].join(' → ')}`)
        .toContainEqual(history[id])
    }
    expect.soft(history.row, history.row.join(' → ')).toEqual([STATS_ROW])
    await modal.getByRole('button', { name: 'Close' }).click()
    await expect(modal).toBeHidden()
  })

  await test.step('reopen: the figures read before at once, then a changed one', async () => {
    const { error } = await admin.from('profiles').update({ message_count: 43 }).eq('id', ada.id)
    if (error) throw new Error(`message_count: ${error.message}`)
    const { urls } = await openCard(page, { ...FIGURES, 'profile-activity-messages': '43' })
    expectOneRead(urls)
    const history = await cardHistory(page)
    for (const id of Object.keys(FIGURES) as Figure[]) {
      const expected = id === 'profile-activity-messages' ? ['42', '43'] : [FIGURES[id]]
      expect.soft(history[id], `${id}: ${history[id].join(' → ')}`).toEqual(expected)
    }
    expect.soft(history.row, history.row.join(' → ')).toEqual([STATS_ROW])
  })
})
