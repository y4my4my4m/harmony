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
    await this.serverSidebar.locator('.portal').click()
  }

  async goToDMs() {
    await this.serverSidebar.locator('.dm-button').click()
  }

  async goToMonyverse() {
    await this.serverSidebar.locator('.monyverse-button').click()
  }

  getServerItem(serverName: string): Locator {
    return this.serverSidebar.locator(`.server-item[alt="${serverName}"]`)
  }

  getChannelItem(channelId: string): Locator {
    return this.page.locator(`[data-channel-id="${channelId}"]`)
  }

  async createServerViaUI(serverName: string) {
    await this.openPortal()
    const createTab = this.page.locator('text=Create')
    if (await createTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await createTab.click()
    }
    const nameInput = this.page.locator('input[placeholder*="server name"], input[name="server-name"], #server-name')
    await nameInput.fill(serverName)
    await this.page.locator('[data-testid="create-server-btn"]').click()
  }
}
