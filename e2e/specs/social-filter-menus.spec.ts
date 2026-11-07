// Journey: Trending's time range and the Instances filters open the app's own menu, as the
// post visibility picker does, not the system's <select> list. The chip is a menu button
// named for what it picks and its value; the menu holds menuitemradio options with the
// current one checked. Keyboard: Enter opens on the checked option, arrows move, Enter
// picks and focus returns to the chip; ArrowUp opens on the last option; Escape closes
// without a change. A pick lands in the URL (?range=) as the native select's did.
//
// Trending's source chip opens a search field over a short list instead of every known
// instance: All instances, This instance, then at most 8 domains ranked by their posts on
// screen (ties by replies x3 + boosts x2 + favourites). Typing searches every known
// instance by domain. Seed: 12 remote domains whose 20 posts fill the first trending page
// (favourites in the thousands outrank any other spec's posts), and one known instance
// with no posts.

import crypto from 'node:crypto'
import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'
import { expectNoAxeViolations } from './a11y'

const admin = adminClient()
let user: SpecUser

const marker = Date.now().toString(36)
const sourceDomain = (letter: string) => `src${letter}-${marker}.e2e.test`
// [letter, favourites of each post]; posts per domain = entries.
const SOURCE_SEED: Array<[string, number[]]> = [
  ['a', [5000, 5000, 5000, 5000]],
  ['b', [5000, 5000, 5000]],
  ['c', [6000, 6000]],
  ['d', [5000, 5000]],
  ['e', [4000, 4000]],
  ['f', [9000]],
  ['g', [8000]],
  ['h', [7000]],
  ['i', [6000]],
  ['j', [5500]],
  ['k', [5200]],
  ['l', [5100]],
]
const QUIET = sourceDomain('m')
const remoteIds: string[] = []
const postText = (letter: string, n: number) => `trend ${letter}${n} ${marker}`
const sourceInUrl = (letter: string) => new RegExp(`[?&]source=${sourceDomain(letter).replace(/\./g, '\\.')}(&|$)`)

test.beforeAll(async () => {
  user = await createUser(admin, 'socsel')

  const domains = [...SOURCE_SEED.map(([letter]) => sourceDomain(letter)), QUIET]
  const now = Date.now()
  const { error: instanceError } = await admin.from('federated_instances').insert(
    domains.map((domain, i) => ({ domain, software: 'mastodon', last_seen_at: new Date(now - i * 1000).toISOString() })),
  )
  if (instanceError) throw new Error(`instances: ${instanceError.message}`)

  let age = 0
  for (const [letter, favourites] of SOURCE_SEED) {
    const domain = sourceDomain(letter)
    const id = crypto.randomUUID()
    const username = `poster${letter}${marker}`
    const { error: profileError } = await admin.from('profiles').insert({
      id,
      username,
      display_name: `Poster ${letter.toUpperCase()}`,
      domain,
      is_local: false,
      federated_id: `https://${domain}/users/${username}`,
      inbox_url: `https://${domain}/users/${username}/inbox`,
    })
    if (profileError) throw new Error(`profile ${domain}: ${profileError.message}`)
    remoteIds.push(id)

    for (const [n, count] of favourites.entries()) {
      age += 5
      const url = `https://${domain}/notes/${letter}${n}-${marker}`
      const { data, error } = await admin.from('posts').insert({
        author_id: id,
        visibility: 'public',
        is_local: false,
        ap_id: url,
        url,
        created_at: new Date(now - age * 1000).toISOString(),
        content: [{ type: 'text', text: postText(letter, n) }],
      }).select('id').single()
      if (error || !data) throw new Error(`post ${domain}: ${error?.message}`)
      const counts = await admin.from('posts').update({ favorites_count: count }).eq('id', data.id)
      if (counts.error) throw new Error(`counts ${domain}: ${counts.error.message}`)
    }
  }
})

test.afterAll(async () => {
  if (remoteIds.length) await admin.from('profiles').delete().in('id', remoteIds)
  await admin.from('federated_instances').delete().like('domain', `%-${marker}.e2e.test`)
  await deleteUser(admin, user)
})

test('the trending time range is a keyboard-operable menu', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, user)
  await page.goto('/social/trending')
  await dismissAnnouncements(page)

  const filters = page.getByRole('toolbar', { name: 'Filters' })
  await expect(filters).toBeVisible({ timeout: 30000 })
  const chip = filters.getByRole('button', { name: 'Time range, Last 24 hours' })
  const menu = page.getByRole('menu', { name: 'Time range' })

  await test.step('no native select; the chip is a menu button', async () => {
    await expect(filters.locator('select')).toHaveCount(0)
    await expect(chip).toBeVisible()
    await expect(chip).toHaveAttribute('aria-haspopup', 'menu')
    await expect(chip).toHaveAttribute('aria-expanded', 'false')
  })

  await test.step('Enter opens it on the checked option', async () => {
    await chip.focus()
    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    await expect(chip).toHaveAttribute('aria-expanded', 'true')
    await expect(menu.getByRole('menuitemradio')).toHaveText(['Last hour', 'Last 6 hours', 'Last 24 hours', 'Last week', 'Last month'])
    const checked = menu.getByRole('menuitemradio', { name: 'Last 24 hours' })
    await expect(checked).toHaveAttribute('aria-checked', 'true')
    await expect(checked).toBeFocused()
  })

  await test.step('ArrowDown and Enter pick the next one; focus returns to the chip', async () => {
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitemradio', { name: 'Last week' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(menu).toBeHidden()
    await expect(page).toHaveURL(/[?&]range=7d/)
    const picked = filters.getByRole('button', { name: 'Time range, Last week' })
    await expect(picked).toBeFocused()
  })

  await test.step('ArrowUp opens on the last option; Escape closes without a change', async () => {
    const picked = filters.getByRole('button', { name: 'Time range, Last week' })
    await page.keyboard.press('ArrowUp')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitemradio', { name: 'Last month' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(picked).toBeFocused()
    await expect(page).toHaveURL(/[?&]range=7d/)
  })

  await test.step('a click opens it and a click on an option picks it', async () => {
    await filters.getByRole('button', { name: 'Time range, Last week' }).click()
    await menu.getByRole('menuitemradio', { name: 'Last hour' }).click()
    await expect(menu).toBeHidden()
    await expect(page).toHaveURL(/[?&]range=1h/)
    await expect(filters.getByRole('button', { name: 'Time range, Last hour' })).toBeVisible()
  })

  await test.step('a click elsewhere closes it', async () => {
    await filters.getByRole('button', { name: 'Time range, Last hour' }).click()
    await expect(menu).toBeVisible()
    await page.mouse.click(5, 400)
    await expect(menu).toBeHidden()
  })
})

test('the instance status filter is the same menu', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, user)
  await page.goto('/social/instances')
  await dismissAnnouncements(page)
  const chip = page.getByRole('button', { name: 'Status, All statuses' })
  await expect(chip).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.explore-controls select')).toHaveCount(0)
  await chip.focus()
  await page.keyboard.press('Enter')
  const menu = page.getByRole('menu', { name: 'Status' })
  await expect(menu.getByRole('menuitemradio', { name: 'All statuses' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Status, Online' })).toBeFocused()
  await expect(page.getByRole('button', { name: 'Software, All software' })).toBeVisible()
})

test('the trending source chip suggests the busiest instances and searches the rest', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, user)
  await page.goto('/social/trending')
  await dismissAnnouncements(page)

  const filters = page.getByRole('toolbar', { name: 'Filters' })
  const chip = filters.getByRole('button', { name: 'Source, All instances' })
  const popover = page.getByTestId('trending-source-popover')
  const field = popover.getByRole('combobox', { name: 'Search instances' })
  const listbox = popover.getByRole('listbox', { name: 'Source' })
  const values = () => listbox.getByRole('option').evaluateAll(els => els.map(el => el.getAttribute('data-value')))
  const posts = page.locator('[data-testid="post-item"]')

  await test.step('the seeded posts lead the list', async () => {
    await expect(chip).toBeVisible({ timeout: 90000 })
    await expect(posts.first()).toContainText(postText('f', 0), { timeout: 30000 })
    await expect(page.locator('#trending-panel-posts').getByRole('feed')).toHaveAttribute('aria-busy', 'false')
  })

  await test.step('Enter opens a search field over ten options, busiest instances first', async () => {
    await chip.focus()
    await page.keyboard.press('Enter')
    await expect(popover).toBeVisible()
    await expect(chip).toHaveAttribute('aria-expanded', 'true')
    await expect(field).toBeFocused()
    await expect(field).toHaveAttribute('placeholder', 'Search instances...')
    // 4, 3 and 2 posts; c before d before e on engagement; then single posts f > g > h.
    await expect.poll(values).toEqual(['', 'local', ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(sourceDomain)])
    await expect(listbox.getByRole('group', { name: 'Active in these results' })).toBeVisible()
    await expect(listbox.getByRole('option').nth(2)).toContainText('4 posts')
    await expectNoAxeViolations(page, { include: '[data-testid="trending-source-popover"]', label: 'source popover' })
    const active = await field.getAttribute('aria-activedescendant')
    await expect(listbox.getByRole('option').first()).toHaveAttribute('id', active!)
    await page.keyboard.press('ArrowDown')
    const next = await field.getAttribute('aria-activedescendant')
    await expect(listbox.getByRole('option').nth(1)).toHaveAttribute('id', next!)
  })

  await test.step('typing finds instances that are not in the list', async () => {
    await field.fill(`srcm-${marker}`)
    await expect.poll(values).toEqual([QUIET])
    await field.fill(`SRCL-${marker}`)
    await expect.poll(values).toEqual([sourceDomain('l')])
    await field.fill(`nothing-${marker}`)
    await expect(popover.getByRole('status')).toHaveText('No instances found')
    await expect(listbox.getByRole('option')).toHaveCount(0)
  })

  await test.step('Enter picks the match, filters the posts and returns focus to the chip', async () => {
    await field.fill(`srcl-${marker}`)
    await expect.poll(values).toEqual([sourceDomain('l')])
    await page.keyboard.press('Enter')
    await expect(popover).toBeHidden()
    await expect(page).toHaveURL(sourceInUrl('l'))
    const picked = filters.getByRole('button', { name: `Source, ${sourceDomain('l')}` })
    await expect(picked).toBeFocused()
    await expect(posts.filter({ hasText: postText('l', 0) })).toBeVisible({ timeout: 30000 })
    await expect(posts).toHaveCount(1)
  })

  await test.step('the picked instance is pinned; Escape closes without a change', async () => {
    const picked = filters.getByRole('button', { name: `Source, ${sourceDomain('l')}` })
    await page.keyboard.press('Enter')
    await expect(popover).toBeVisible()
    await expect.poll(values).toEqual(['', 'local', sourceDomain('l'), ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(sourceDomain)])
    await expect(listbox.getByRole('option', { selected: true })).toHaveAttribute('data-value', sourceDomain('l'))
    await field.fill('srca')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Escape')
    await expect(popover).toBeHidden()
    await expect(picked).toBeFocused()
    await expect(page).toHaveURL(sourceInUrl('l'))
    await expect(posts).toHaveCount(1)
  })

  await test.step('a click on an option picks it; a click elsewhere closes', async () => {
    await filters.getByRole('button', { name: `Source, ${sourceDomain('l')}` }).click()
    await listbox.getByRole('option', { name: 'All instances' }).click()
    await expect(popover).toBeHidden()
    await expect(page).not.toHaveURL(/[?&]source=/)
    await expect(posts.first()).toContainText(postText('f', 0), { timeout: 30000 })
    await chip.click()
    await expect(popover).toBeVisible()
    await page.mouse.click(5, 400)
    await expect(popover).toBeHidden()
  })

  await test.step('at phone width the popover fits the screen', async () => {
    await page.setViewportSize({ width: 360, height: 740 })
    const narrowChip = page.getByRole('toolbar', { name: 'Filters' }).getByRole('button', { name: 'Source, All instances' })
    await expect(narrowChip).toBeVisible({ timeout: 30000 })
    await narrowChip.click()
    await expect(popover).toBeVisible()
    const box = (await popover.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(360)
    expect(box.y + box.height).toBeLessThanOrEqual(740)
    await page.keyboard.press('Escape')
    await expect(popover).toBeHidden()
  })
})
