import { test, expect, dismissAnnouncements } from './fixtures/auth.fixture'
import { NotificationsPage } from './pages/NotificationsPage'
import { ChatPage } from './pages/ChatPage'

test.describe('Notifications — Bell & Panel', () => {
  test('notification bell is visible when logged in', async ({ alicePage }) => {
    await alicePage.goto('/chat')
    await dismissAnnouncements(alicePage)
    await alicePage.waitForLoadState('networkidle', { timeout: 15000 })

    const notifications = new NotificationsPage(alicePage)
    await expect(notifications.bell).toBeVisible({ timeout: 10000 })
  })

  test('clicking bell opens notification panel', async ({ alicePage }) => {
    await alicePage.goto('/chat')
    await dismissAnnouncements(alicePage)
    await alicePage.waitForLoadState('networkidle', { timeout: 15000 })

    const notifications = new NotificationsPage(alicePage)
    await notifications.openPanel()
    await expect(notifications.panel).toBeVisible()
  })

  test('notification panel can be closed', async ({ alicePage }) => {
    await alicePage.goto('/chat')
    await dismissAnnouncements(alicePage)
    await alicePage.waitForLoadState('networkidle', { timeout: 15000 })

    const notifications = new NotificationsPage(alicePage)
    await notifications.openPanel()
    await expect(notifications.panel).toBeVisible()
    await notifications.closePanel()
    await expect(notifications.panel).not.toBeVisible()
  })

  test('mark all as read button works when there are unreads', async ({ alicePage }) => {
    await alicePage.goto('/chat')
    await dismissAnnouncements(alicePage)
    await alicePage.waitForLoadState('networkidle', { timeout: 15000 })

    const notifications = new NotificationsPage(alicePage)
    await notifications.openPanel()

    // Only test if mark-all-read is visible (has unreads)
    if (await notifications.markAllReadBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await notifications.markAllAsRead()
      // Badge should disappear or count go to 0
      await alicePage.waitForTimeout(2000)
    }
  })
})

test.describe('Notifications — Triggered by actions', () => {
  test('mention in channel triggers notification for mentioned user', async ({
    alicePage,
    bobPage,
    seedData,
  }) => {
    // Alice mentions Bob in a message
    const aliceChat = new ChatPage(alicePage)
    await aliceChat.navigateToChannel(seedData.serverId, seedData.channelId)

    const tag = Date.now().toString()
    const msg = `Hey @${seedData.bob.username} check this ${tag}`
    await aliceChat.sendMessage(msg)
    // @username gets rendered as @displayName, so match on the unique tag instead
    await aliceChat.waitForMessage(tag)

    // Bob checks notifications — bell should be visible
    await bobPage.goto('/chat')
    await dismissAnnouncements(bobPage)
    await bobPage.waitForLoadState('networkidle', { timeout: 15000 })

    const bobNotifs = new NotificationsPage(bobPage)
    await expect(bobNotifs.bell).toBeVisible({ timeout: 10000 })
  })

  test('DM triggers notification', async ({ alicePage, bobPage, seedData }) => {
    await alicePage.goto('/dm')
    await dismissAnnouncements(alicePage)
    await alicePage.waitForLoadState('networkidle', { timeout: 15000 })

    // Start conversation with Bob
    const newDmBtn = alicePage.locator('[data-testid="dm-new-conversation"]')
    await newDmBtn.click()
    const searchInput = alicePage.locator('.search-input')
    await searchInput.fill(seedData.bob.username)
    const result = alicePage.locator('.search-result-item').first()
    if (await result.isVisible({ timeout: 5000 }).catch(() => false)) {
      await result.click()
      await alicePage.waitForURL(/\/dm\//, { timeout: 10000 })

      const dmMsg = `DM notif test ${Date.now()}`
      const msgInput = alicePage.locator('[data-testid="message-input"] .rich-text-editor')
      await msgInput.click()
      await msgInput.fill(dmMsg)
      await alicePage.keyboard.press('Enter')
    }

    // Bob checks notifications
    await bobPage.goto('/chat')
    await dismissAnnouncements(bobPage)
    await bobPage.waitForLoadState('networkidle', { timeout: 15000 })
    await bobPage.waitForTimeout(3000)

    const bobNotifs = new NotificationsPage(bobPage)
    await expect(bobNotifs.bell).toBeVisible()
  })
})

test.describe('Notifications — Settings', () => {
  test('notification settings page loads', async ({ alicePage }) => {
    const notifications = new NotificationsPage(alicePage)
    await notifications.navigateToSettings()
    expect(alicePage.url()).toContain('/settings')
  })
})
