// Journey: funding costs one request per app load and nothing more until something can have
// changed. A cold load into a channel reads the funding summary once and supporter badges in one
// batch; opening channels, switching servers, opening Settings and five idle minutes read no
// funding; opening the Support window reads the summary once, with no auth user lookup.
// Before 1.9.3 a load read instance_funding and then get_funding_current_total, a 60 s timer
// repeated both while signed in, Settings read three more and the window six.

import { test, expect, type Page } from '@playwright/test'
import {
  addChannel,
  addMember,
  adminClient,
  channelRow,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'
import { enableFunding, FUNDING_REQUEST, logRequests } from './funding'

const admin = adminClient()
let me: SpecUser
let author: SpecUser
let first: SeededServer
let second: SeededServer
let side = ''

test.beforeAll(async () => {
  me = await createUser(admin, 'fundreq')
  author = await createUser(admin, 'fundreqa')
  first = await seedServer(admin, me, `Fund A ${me.username}`)
  second = await seedServer(admin, me, `Fund B ${me.username}`)
  side = await addChannel(admin, first, 'side')
  await addMember(admin, author, first.id)
  const base = Date.now() - 60_000
  const { error } = await admin.from('messages').insert([me, author, me, author].map((u, i) => ({
    channel_id: first.generalChannelId,
    user_id: u.id,
    content: [{ type: 'text', text: `funding load ${i}` }],
    created_at: new Date(base + i * 1000).toISOString(),
  })))
  if (error) throw new Error(`messages: ${error.message}`)
  await admin.from('messages').insert({ channel_id: side, user_id: author.id, content: [{ type: 'text', text: 'side channel line' }] })
  await enableFunding(admin)
})

test.afterAll(async () => {
  await deleteUser(admin, author)
  await deleteUser(admin, me)
})

const railEntry = (page: Page, serverId: string) =>
  page.getByRole('navigation', { name: 'Servers' }).locator(`[data-rail-kind="server"][data-rail-id="${serverId}"]`)

test('funding is read once per load, not per view or per minute', async ({ page }) => {
  test.setTimeout(180_000)
  // Timers run on a clock the test advances: five idle minutes pass in seconds.
  await page.clock.install()
  const funding = logRequests(page, FUNDING_REQUEST)
  const badges = logRequests(page, /\/rpc\/get_supporter_badges$/)
  const authUser = logRequests(page, /\/auth\/v1\/user$/)
  await signIn(page, me)

  await test.step('cold load into a channel: one summary read, one badge batch', async () => {
    funding.take()
    badges.take()
    await page.goto(`/chat/${first.id}/${first.generalChannelId}`)
    await dismissAnnouncements(page)
    await expect(messageList(page).getByText('funding load 3')).toBeVisible({ timeout: 30000 })
    await expect(page.locator('.funding-indicator')).toBeVisible({ timeout: 15000 })
    await page.waitForTimeout(3000)
    expect(funding.take()).toEqual(['POST /rest/v1/rpc/get_funding_summary'])
    expect(badges.take().length).toBeLessThanOrEqual(1)
  })

  await test.step('opening a channel and switching servers read no funding', async () => {
    await channelRow(page, 'side').click()
    await expect(messageList(page).getByText('side channel line')).toBeVisible({ timeout: 30000 })
    await channelRow(page, 'general').click()
    await expect(messageList(page).getByText('funding load 3')).toBeVisible({ timeout: 30000 })
    await railEntry(page, second.id).click()
    await page.waitForURL(new RegExp(second.id), { timeout: 20000 })
    await railEntry(page, first.id).click()
    await page.waitForURL(new RegExp(first.id), { timeout: 20000 })
    await page.waitForTimeout(2000)
    expect(funding.take()).toEqual([])
  })

  await test.step('Settings reads no funding', async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
    await page.waitForURL(/\/settings/, { timeout: 20000 })
    await expect(page.getByTestId('settings-support')).toBeVisible({ timeout: 15000 })
    await page.waitForTimeout(2000)
    expect(funding.take()).toEqual([])
    await page.keyboard.press('Escape')
    await page.waitForURL((url) => !url.pathname.startsWith('/settings'), { timeout: 20000 })
    await page.waitForTimeout(1000)
    funding.take()
  })

  await test.step('five idle minutes read no funding', async () => {
    for (let minute = 0; minute < 5; minute++) {
      await page.clock.runFor(60_000)
      await page.waitForTimeout(500)
    }
    expect(funding.take()).toEqual([])
  })

  await test.step('opening the Support window reads the summary once', async () => {
    authUser.take()
    await page.locator('.funding-indicator').first().click()
    await expect(page.getByTestId('support-modal')).toBeVisible()
    await expect(page.getByTestId('support-raised')).toBeVisible()
    await page.waitForTimeout(2000)
    expect(funding.take()).toEqual(['POST /rest/v1/rpc/get_funding_summary'])
    expect(authUser.take()).toEqual([])
  })
})
