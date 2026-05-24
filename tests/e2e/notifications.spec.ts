import { test, expect, dismissAnnouncements } from './fixtures/auth.fixture'
import { NotificationsPage } from './pages/NotificationsPage'
import { ChatPage } from './pages/ChatPage'
import { DMPage } from './pages/DMPage'
import type { Page } from '@playwright/test'

/**
 * Wait for the notification system to be mounted and realtime connected.
 * The toast container is rendered by NotificationToast.vue once the store is ready.
 */
async function waitForNotificationSystem(page: Page) {
  await page.locator('[data-testid="notification-toasts"]').waitFor({
    state: 'attached',
    timeout: 15000,
  })
}

test.describe('Notifications - Bell & Panel', () => {
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

    if (await notifications.markAllReadBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await notifications.markAllAsRead()
      await alicePage.waitForTimeout(2000)
    }
  })
})

test.describe('Notifications - Toast appears on mention', () => {
  test('mention in channel shows toast on recipient page', async ({
    alicePage,
    bobPage,
    seedData,
  }) => {
    await bobPage.goto('/social/home')
    await dismissAnnouncements(bobPage)
    await bobPage.waitForLoadState('networkidle', { timeout: 15000 })
    await waitForNotificationSystem(bobPage)

    const aliceChat = new ChatPage(alicePage)
    await aliceChat.navigateToChannel(seedData.serverId, seedData.channelId)

    const tag = `mention-toast-${Date.now()}`
    await aliceChat.sendMessage(`Hey @${seedData.bob.username} ${tag}`)
    await aliceChat.waitForMessage(tag)

    const toast = bobPage.locator('[data-testid="notification-toast-mention"]')
    await expect(toast.first()).toBeVisible({ timeout: 20000 })
  })

  test('mention toast content includes sender info', async ({
    alicePage,
    bobPage,
    seedData,
  }) => {
    await bobPage.goto('/social/home')
    await dismissAnnouncements(bobPage)
    await bobPage.waitForLoadState('networkidle', { timeout: 15000 })
    await waitForNotificationSystem(bobPage)

    const aliceChat = new ChatPage(alicePage)
    await aliceChat.navigateToChannel(seedData.serverId, seedData.channelId)

    const tag = `sender-info-${Date.now()}`
    await aliceChat.sendMessage(`Hello @${seedData.bob.username} ${tag}`)
    await aliceChat.waitForMessage(tag)

    const toast = bobPage.locator('[data-testid="notification-toast-mention"]').first()
    await expect(toast).toBeVisible({ timeout: 20000 })
    await expect(toast).toContainText(seedData.alice.displayName, { timeout: 5000 })
  })

  test('mention notification appears in bell panel', async ({
    alicePage,
    bobPage,
    seedData,
  }) => {
    await bobPage.goto('/social/home')
    await dismissAnnouncements(bobPage)
    await bobPage.waitForLoadState('networkidle', { timeout: 15000 })
    await waitForNotificationSystem(bobPage)

    const aliceChat = new ChatPage(alicePage)
    await aliceChat.navigateToChannel(seedData.serverId, seedData.channelId)

    const tag = `panel-${Date.now()}`
    await aliceChat.sendMessage(`Panel test @${seedData.bob.username} ${tag}`)
    await aliceChat.waitForMessage(tag)

    // Wait for the notification to arrive via realtime
    await bobPage.waitForTimeout(5000)

    const bobNotifs = new NotificationsPage(bobPage)
    await bobNotifs.openPanel()
    await expect(bobNotifs.panel).toBeVisible()

    const mentionItem = bobNotifs.notificationItems
      .filter({ has: bobPage.locator('.notification-item--mention') })
      .first()
    await expect(mentionItem).toBeVisible({ timeout: 15000 })
  })
})

test.describe('Notifications - Toast appears on DM', () => {
  test('DM message shows toast on recipient page', async ({
    alicePage,
    bobPage,
    seedData,
  }) => {
    await bobPage.goto('/chat')
    await dismissAnnouncements(bobPage)
    await bobPage.waitForLoadState('networkidle', { timeout: 15000 })
    await waitForNotificationSystem(bobPage)

    const aliceDM = new DMPage(alicePage)
    await aliceDM.navigate()
    await aliceDM.startNewConversation(seedData.bob.username)
    await alicePage.waitForURL(/\/dm\//, { timeout: 10000 })

    const dmMsg = `DM toast ${Date.now()}`
    await aliceDM.sendMessage(dmMsg)

    const dmToast = bobPage.locator(
      '[data-testid="notification-toast-dm"], [data-testid="notification-toast-chat_message"]',
    )
    await expect(dmToast.first()).toBeVisible({ timeout: 20000 })
  })
})

test.describe('Notifications - Toast suppressed when viewing same context', () => {
  test('mention does NOT show toast if recipient is in the same channel', async ({
    alicePage,
    bobPage,
    seedData,
  }) => {
    const bobChat = new ChatPage(bobPage)
    await bobChat.navigateToChannel(seedData.serverId, seedData.channelId)

    const aliceChat = new ChatPage(alicePage)
    await aliceChat.navigateToChannel(seedData.serverId, seedData.channelId)

    const tag = `suppressed-${Date.now()}`
    await aliceChat.sendMessage(`Suppressed @${seedData.bob.username} ${tag}`)
    await aliceChat.waitForMessage(tag)

    await bobChat.waitForMessage(tag)
    await bobPage.waitForTimeout(3000)

    const toast = bobPage.locator('[data-testid="notification-toast-mention"]')
    await expect(toast).not.toBeVisible()
  })
})

test.describe('Notifications - Toast auto-dismiss', () => {
  test('toast disappears after ~4 seconds', async ({
    alicePage,
    bobPage,
    seedData,
  }) => {
    await bobPage.goto('/social/home')
    await dismissAnnouncements(bobPage)
    await bobPage.waitForLoadState('networkidle', { timeout: 15000 })
    await waitForNotificationSystem(bobPage)

    const aliceChat = new ChatPage(alicePage)
    await aliceChat.navigateToChannel(seedData.serverId, seedData.channelId)

    const tag = `autodismiss-${Date.now()}`
    await aliceChat.sendMessage(`Auto-dismiss @${seedData.bob.username} ${tag}`)
    await aliceChat.waitForMessage(tag)

    const toast = bobPage.locator('[data-testid="notification-toast-mention"]').first()
    await expect(toast).toBeVisible({ timeout: 20000 })

    // Default duration is 4000ms + CSS transition time
    await expect(toast).not.toBeVisible({ timeout: 8000 })
  })
})

test.describe('Notifications - Settings', () => {
  test('notification settings page loads', async ({ alicePage }) => {
    const notifications = new NotificationsPage(alicePage)
    await notifications.navigateToSettings()
    expect(alicePage.url()).toContain('/settings')
  })
})
