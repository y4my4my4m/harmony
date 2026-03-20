import type { Page, Locator } from '@playwright/test'
import { dismissAnnouncements } from '../fixtures/auth.fixture'

export class ChatPage {
  readonly page: Page
  readonly messageList: Locator
  readonly messageInput: Locator
  readonly sendButton: Locator

  constructor(page: Page) {
    this.page = page
    this.messageList = page.locator('[data-testid="message-list"]')
    this.messageInput = page.locator('[data-testid="message-input"] .rich-text-editor')
    this.sendButton = page.locator('[data-testid="message-send-btn"]')
  }

  async navigateToChannel(serverId: string, channelId: string) {
    await this.page.goto(`/chat/${serverId}/${channelId}`)
    await dismissAnnouncements(this.page)
    await this.messageList.waitFor({ state: 'visible', timeout: 15000 })
  }

  async sendMessage(content: string) {
    await this.messageInput.click()
    await this.messageInput.fill(content)
    await this.page.keyboard.press('Enter')
  }

  async waitForMessage(content: string) {
    await this.page.locator(`[data-testid="message-list"]`).locator(`text=${content}`).waitFor({
      state: 'visible',
      timeout: 10000,
    })
  }

  getMessageByContent(content: string): Locator {
    return this.messageList.locator(`.message-item`).filter({ hasText: content })
  }

  getMessageById(messageId: string): Locator {
    return this.page.locator(`[data-message-id="${messageId}"]`)
  }

  async openContextMenu(messageLocator: Locator) {
    await messageLocator.hover()
    await messageLocator.click({ button: 'right' })
  }

  async editMessage(messageLocator: Locator, newContent: string) {
    await this.openContextMenu(messageLocator)
    await this.page.locator('text=Edit').click()
    await this.page.keyboard.selectAll()
    await this.page.keyboard.type(newContent)
    await this.page.keyboard.press('Enter')
  }

  async deleteMessage(messageLocator: Locator) {
    await this.openContextMenu(messageLocator)
    await this.page.locator('text=Delete').click()
    // Confirm deletion if there's a confirmation dialog
    const confirmBtn = this.page.locator('button:has-text("Delete"), button:has-text("Confirm")')
    if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await confirmBtn.click()
    }
  }

  async replyToMessage(messageLocator: Locator, replyContent: string) {
    await this.openContextMenu(messageLocator)
    await this.page.locator('text=Reply').click()
    await this.messageInput.click()
    await this.messageInput.fill(replyContent)
    await this.page.keyboard.press('Enter')
  }

  getReactions(messageLocator: Locator): Locator {
    return messageLocator.locator('[data-testid="message-reactions"]')
  }
}
