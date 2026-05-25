import type { Page, Locator } from '@playwright/test'
import { dismissAnnouncements } from '../fixtures/auth.fixture'

export class NotificationsPage {
  readonly page: Page
  readonly bell: Locator
  readonly panel: Locator
  readonly notificationList: Locator
  readonly notificationItems: Locator
  readonly markAllReadBtn: Locator

  constructor(page: Page) {
    this.page = page
    this.bell = page.locator('[data-testid="notification-bell"]')
    this.panel = page.locator('[data-testid="notification-panel"]')
    this.notificationList = page.locator('[data-testid="notification-list"]')
    this.notificationItems = page.locator('[data-testid="notification-item"]')
    this.markAllReadBtn = page.locator('[data-testid="notification-mark-read"]')
  }

  async openPanel() {
    await this.bell.click()
    await this.panel.waitFor({ state: 'visible', timeout: 5000 })
  }

  async closePanel() {
    const closeBtn = this.panel.locator('.close-btn')
    await closeBtn.click()
    await this.panel.waitFor({ state: 'hidden', timeout: 5000 })
  }

  async markAllAsRead() {
    await this.markAllReadBtn.click()
  }

  async getUnreadCount(): Promise<number> {
    const badge = this.page.locator('.notification-badge .badge-text')
    if (!(await badge.isVisible({ timeout: 1000 }).catch(() => false))) {
      return 0
    }
    const text = await badge.textContent()
    if (!text) return 0
    if (text.includes('+')) return 100
    return parseInt(text, 10) || 0
  }

  getNotificationsByType(type: string): Locator {
    return this.notificationItems.filter({ has: this.page.locator(`.notification-item--${type}`) })
  }

  async waitForNotification(textContent: string) {
    await this.notificationItems.filter({ hasText: textContent }).first().waitFor({
      state: 'visible',
      timeout: 15000,
    })
  }

  async navigateToSettings() {
    await this.page.goto('/settings/notifications')
    await dismissAnnouncements(this.page)
    await this.page.waitForLoadState('networkidle', { timeout: 10000 })
  }
}
