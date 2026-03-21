import type { Page, Locator } from '@playwright/test'
import { dismissAnnouncements } from '../fixtures/auth.fixture'

export class DMPage {
  readonly page: Page
  readonly sidebar: Locator
  readonly newConversationBtn: Locator
  readonly conversationItems: Locator
  readonly messageInput: Locator
  readonly messageList: Locator

  constructor(page: Page) {
    this.page = page
    this.sidebar = page.locator('[data-testid="dm-sidebar"]')
    this.newConversationBtn = page.locator('[data-testid="dm-new-conversation"]')
    this.conversationItems = page.locator('[data-testid="dm-conversation-item"]')
    this.messageInput = page.locator('[data-testid="message-input"] .rich-text-editor')
    this.messageList = page.locator('[data-testid="message-list"]')
  }

  async navigate() {
    await this.page.goto('/dm')
    await dismissAnnouncements(this.page)
    await this.sidebar.waitFor({ state: 'visible', timeout: 15000 })
  }

  async navigateToConversation(conversationId: string) {
    await this.page.goto(`/dm/${conversationId}`)
    await dismissAnnouncements(this.page)
    await this.messageList.waitFor({ state: 'visible', timeout: 15000 })
  }

  async startNewConversation(username: string) {
    await this.newConversationBtn.click()
    const searchInput = this.page.locator('.search-input')
    await searchInput.fill(username)
    await this.page.locator('.search-result-item').first().click()
  }

  async sendMessage(content: string) {
    await this.messageInput.click()
    await this.messageInput.pressSequentially(content, { delay: 20 })
    await this.page.keyboard.press('Enter')
  }

  async waitForMessage(content: string) {
    await this.messageList.locator(`text=${content}`).waitFor({
      state: 'visible',
      timeout: 10000,
    })
  }

  async selectConversation(index: number) {
    await this.conversationItems.nth(index).click()
  }

  getConversationByName(name: string): Locator {
    return this.conversationItems.filter({ hasText: name })
  }
}
