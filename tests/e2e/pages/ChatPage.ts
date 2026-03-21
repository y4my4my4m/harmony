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
    await this.messageInput.pressSequentially(content, { delay: 20 })
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
    await messageLocator.scrollIntoViewIfNeeded()
    await messageLocator.hover()
    const editBtn = messageLocator.locator('[data-testid="msg-action-edit"]')
    await editBtn.waitFor({ state: 'visible', timeout: 5000 })
    await editBtn.click()

    const editInput = this.page.getByRole('textbox', { name: 'Edit message' })
    await editInput.waitFor({ state: 'visible', timeout: 5000 })
    await editInput.click()
    await this.page.keyboard.press('ControlOrMeta+A')
    await this.page.keyboard.press('Backspace')
    await editInput.pressSequentially(newContent, { delay: 20 })
    await this.page.keyboard.press('Enter')
  }

  async deleteMessage(messageLocator: Locator) {
    await messageLocator.scrollIntoViewIfNeeded()
    await messageLocator.hover()
    const deleteBtn = messageLocator.locator('[data-testid="msg-action-delete"]')
    await deleteBtn.waitFor({ state: 'visible', timeout: 5000 })
    await deleteBtn.click()

    const confirmBtn = this.page.locator('button:has-text("Delete"), button:has-text("Confirm")')
    if (await confirmBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
      await confirmBtn.first().click()
    }
  }

  async replyToMessage(messageLocator: Locator, replyContent: string) {
    await messageLocator.scrollIntoViewIfNeeded()
    await messageLocator.hover()
    const replyBtn = messageLocator.locator('[data-testid="msg-action-reply"]')
    await replyBtn.waitFor({ state: 'visible', timeout: 5000 })
    await replyBtn.click()

    await this.messageInput.click()
    await this.messageInput.pressSequentially(replyContent, { delay: 20 })
    await this.page.keyboard.press('Enter')
  }

  getReactions(messageLocator: Locator): Locator {
    return messageLocator.locator('[data-testid="message-reactions"]')
  }
}
