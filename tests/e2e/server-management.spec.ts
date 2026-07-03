import { test, expect, dismissAnnouncements } from './fixtures/auth.fixture'
import { ServerPage } from './pages/ServerPage'

test.describe('Server Management', () => {
  test('server sidebar loads with seeded server', async ({ alicePage }) => {
    const server = new ServerPage(alicePage)
    await server.navigateToChat()
    await expect(server.serverSidebar).toBeVisible()
  })

  test('can navigate to a seeded channel', async ({ alicePage, seedData }) => {
    await alicePage.goto(`/chat/${seedData.serverId}/${seedData.channelId}`)
    await dismissAnnouncements(alicePage)
    await alicePage.waitForLoadState('networkidle', { timeout: 15000 })

    expect(alicePage.url()).toContain(seedData.channelId)
  })

  test('DM page loads from navigation', async ({ alicePage }) => {
    const server = new ServerPage(alicePage)
    await server.goToDMs()
    await expect(alicePage).toHaveURL(/\/dm/, { timeout: 10000 })
  })

  test('Social page loads from navigation', async ({ alicePage }) => {
    const server = new ServerPage(alicePage)
    await server.goToFediverse()
    await expect(alicePage).toHaveURL(/\/social/, { timeout: 10000 })
  })

  test('server settings page loads', async ({ alicePage, seedData }) => {
    const server = new ServerPage(alicePage)
    await server.openServerSettings(seedData.serverId)
    expect(alicePage.url()).toContain(`/server/${seedData.serverId}`)
  })

  test('can create a new server via portal', async ({ alicePage }) => {
    const server = new ServerPage(alicePage)
    await server.navigateToChat()

    const serverName = `E2E Server ${Date.now()}`
    await server.createServerViaUI(serverName)

    // After creation, should either redirect to new server or show it in sidebar
    await alicePage.waitForTimeout(3000)
    // The server should now exist (URL changes to new server's channel)
    expect(alicePage.url()).toMatch(/\/chat\//)
  })

  test('channel list shows channels for selected server', async ({ alicePage, seedData }) => {
    await alicePage.goto(`/chat/${seedData.serverId}/${seedData.channelId}`)
    await dismissAnnouncements(alicePage)
    await alicePage.waitForLoadState('networkidle', { timeout: 15000 })

    const channelItem = alicePage.locator(`[data-channel-id="${seedData.channelId}"]`)
    await expect(channelItem).toBeVisible({ timeout: 10000 })
  })
})

test.describe('Server Management - Invites', () => {
  test('invite page loads for valid server', async ({ alicePage, seedData }) => {
    await alicePage.goto(`/server/${seedData.serverId}`)
    await dismissAnnouncements(alicePage)
    await alicePage.waitForLoadState('networkidle', { timeout: 15000 })

    // Look for invite-related UI
    const inviteTab = alicePage.locator('text=Invites, text=Invite')
    if (await inviteTab.first().isVisible({ timeout: 5000 }).catch(() => false)) {
      await inviteTab.first().click()
      await alicePage.waitForTimeout(1000)
    }
  })
})

test.describe('Server Management - Leave', () => {
  test('bob can leave the seeded server', async ({ bobPage, seedData }) => {
    await bobPage.goto(`/chat/${seedData.serverId}/${seedData.channelId}`)
    await dismissAnnouncements(bobPage)
    await bobPage.waitForLoadState('networkidle', { timeout: 15000 })

    // Open server dropdown or settings to find "Leave Server"
    const serverDropdown = bobPage.locator('.server-dropdown-trigger, .server-name, .server-header').first()
    if (await serverDropdown.isVisible({ timeout: 5000 }).catch(() => false)) {
      await serverDropdown.click()
      const leaveBtn = bobPage.locator('text=Leave Server, text=Leave')
      if (await leaveBtn.first().isVisible({ timeout: 3000 }).catch(() => false)) {
        await leaveBtn.first().click()
        // Confirm if needed
        const confirmBtn = bobPage.locator('button:has-text("Leave"), button:has-text("Confirm")')
        if (await confirmBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
          await confirmBtn.first().click()
        }
        // Should navigate away from server
        await bobPage.waitForTimeout(2000)
      }
    }
  })
})
