import type { Page, Locator } from '@playwright/test'
import { dismissAnnouncements } from '../fixtures/auth.fixture'

export class ServerPage {
  readonly page: Page
  readonly serverSidebar: Locator
  readonly channelList: Locator

  constructor(page: Page) {
    this.page = page
    this.serverSidebar = page.locator('[data-testid="server-sidebar"]')
    this.channelList = page.locator('.channel-sidebar')
  }

  async navigateToChat() {
    await this.page.goto('/chat')
    await dismissAnnouncements(this.page)
    await this.serverSidebar.waitFor({ state: 'visible', timeout: 15000 })
  }

  async selectServer(serverId: string) {
    await this.serverSidebar.locator(`[data-server-id="${serverId}"]`).click()
  }

  async selectChannel(channelId: string) {
    await this.page.locator(`[data-channel-id="${channelId}"]`).click()
  }

  async openServerSettings(serverId: string) {
    await this.page.goto(`/server/${serverId}`)
    await this.page.waitForLoadState('networkidle', { timeout: 10000 })
  }

  async openPortal() {
    await this.page.locator('img[alt="Harmony Portal"]').click()
  }

  async goToDMs() {
    await this.page.goto('/dm')
    await dismissAnnouncements(this.page)
  }

  async goToFediverse() {
    await this.page.goto('/social/home')
    await dismissAnnouncements(this.page)
  }

  getServerItem(serverName: string): Locator {
    return this.serverSidebar.locator(`img[alt="${serverName}"]`)
  }

  getChannelItem(channelId: string): Locator {
    return this.page.locator(`[data-channel-id="${channelId}"]`)
  }

  async createServerViaUI(serverName: string) {
    await this.openPortal()
    await this.page.waitForTimeout(1000)

    // The PublicServers panel has a "Create Your Own Server" button at the bottom
    const createBtn = this.page.locator('.create-server-btn').first()
    await createBtn.scrollIntoViewIfNeeded()
    await createBtn.waitFor({ state: 'visible', timeout: 5000 })
    await createBtn.click()

    // Fill the server name in the CreateServer modal
    const nameInput = this.page.locator('[data-testid="create-server-name-input"]')
    await nameInput.waitFor({ state: 'visible', timeout: 5000 })
    await nameInput.fill(serverName)

    await this.page.locator('[data-testid="create-server-btn"]').click()
  }
}
