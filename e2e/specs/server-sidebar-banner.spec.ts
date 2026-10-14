// Journey: a server owner shows the server banner above the channel list. The switch sits
// under the banner upload in Server settings, unavailable while the server has no banner.
// Members then see the banner under the server name bar, at the 16:5 the banner is cropped
// to (112px at least); the bar is transparent over it and turns solid once the channel list
// scrolls the banner away.
//
// The stack has no storage: the banner is one of the dev server's own images.

import { test, expect, type Page } from '@playwright/test'
import {
  addChannel,
  addMember,
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let member: SpecUser
let server: SeededServer
let bare: SeededServer

test.beforeAll(async () => {
  owner = await createUser(admin, 'sbo')
  member = await createUser(admin, 'sbm')
  server = await seedServer(admin, owner, `Banner ${owner.username}`)
  bare = await seedServer(admin, owner, `Bare ${owner.username}`)
  await addMember(admin, member, server.id)
  const { error } = await admin.from('servers').update({ banner: '/default_server.webp' }).eq('id', server.id)
  if (error) throw new Error(`banner: ${error.message}`)
  // Enough channels for the list to scroll.
  for (let i = 0; i < 24; i++) await addChannel(admin, server, `room-${String(i).padStart(2, '0')}`)
})

test.afterAll(async () => {
  await deleteUser(admin, member)
  await deleteUser(admin, owner)
})

const toggle = (page: Page) => page.getByTestId('server-sidebar-banner-toggle')
const banner = (page: Page) => page.getByTestId('server-sidebar-banner')
const header = (page: Page) => page.locator('.channel-sidebar .server-header')

async function sidebarFlag(id: string): Promise<boolean> {
  const { data } = await admin.from('servers').select('sidebar_banner').eq('id', id).single()
  return data?.sidebar_banner === true
}

test('the owner shows the server banner above the channel list', async ({ page, browser }) => {
  test.setTimeout(180_000)

  await signIn(page, owner)

  await test.step('without a banner the switch is unavailable', async () => {
    await page.goto(`/server/${bare.id}?section=overview`)
    await expect(toggle(page)).toBeVisible({ timeout: 30000 })
    await expect(toggle(page)).toHaveAttribute('aria-disabled', 'true')
  })

  await test.step('the owner turns it on and saves', async () => {
    await page.goto(`/server/${server.id}?section=overview`)
    await expect(toggle(page)).toHaveAttribute('aria-checked', 'false', { timeout: 30000 })
    await expect(toggle(page)).not.toHaveAttribute('aria-disabled', 'true')
    await toggle(page).click()
    await expect(toggle(page)).toHaveAttribute('aria-checked', 'true')
    const saved = page.waitForResponse((r) => r.url().includes('/rpc/update_server') && r.request().method() === 'POST')
    await page.getByRole('button', { name: 'Save Changes' }).first().click()
    expect((await saved).ok()).toBe(true)
    await expect.poll(() => sidebarFlag(server.id)).toBe(true)
  })

  const memberContext = await browser.newContext()
  const memberPage = await memberContext.newPage()
  try {
    await test.step('a member sees the banner at 16:5 under a transparent name bar', async () => {
      await signIn(memberPage, member)
      await memberPage.goto(`/chat/${server.id}/${server.generalChannelId}`)
      await dismissAnnouncements(memberPage)
      await expect(banner(memberPage)).toBeVisible({ timeout: 30000 })
      await expect(banner(memberPage).locator('img')).toHaveAttribute('src', /default_server\.webp/)
      const box = (await banner(memberPage).boundingBox())!
      expect(box.height).toBeGreaterThanOrEqual(112)
      expect(box.width / box.height).toBeLessThanOrEqual(16 / 5 + 0.01)
      expect(box.width / box.height).toBeGreaterThan(2)
      // The name bar overlays the banner's top.
      const bar = (await header(memberPage).boundingBox())!
      expect(Math.abs(bar.y - box.y)).toBeLessThanOrEqual(1)
      await expect(header(memberPage)).toHaveClass(/over-banner/)
    })

    await test.step('scrolled down, the name bar stays and turns solid', async () => {
      await memberPage.locator('.chat-content').evaluate((el) => { el.scrollTop = 400 })
      await expect(header(memberPage)).not.toHaveClass(/over-banner/)
      await expect(header(memberPage)).toBeInViewport()
      await memberPage.locator('.chat-content').evaluate((el) => { el.scrollTop = 0 })
      await expect(header(memberPage)).toHaveClass(/over-banner/)
    })
  } finally {
    await memberContext.close()
  }

  await test.step('turned off, the channel list shows no banner', async () => {
    await page.goto(`/server/${server.id}?section=overview`)
    await expect(toggle(page)).toHaveAttribute('aria-checked', 'true', { timeout: 30000 })
    await toggle(page).click()
    await page.getByRole('button', { name: 'Save Changes' }).first().click()
    await expect.poll(() => sidebarFlag(server.id)).toBe(false)
    await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
    await expect(page.locator('.channel-sidebar .channel-item').first()).toBeVisible({ timeout: 30000 })
    await expect(banner(page)).toHaveCount(0)
  })
})
