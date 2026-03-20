import type { Page, Locator } from '@playwright/test'
import { dismissAnnouncements } from '../fixtures/auth.fixture'

export class SocialPage {
  readonly page: Page
  readonly timelineFeed: Locator
  readonly composeBtn: Locator
  readonly postItems: Locator

  constructor(page: Page) {
    this.page = page
    this.timelineFeed = page.locator('[data-testid="timeline-feed"]')
    this.composeBtn = page.locator('[data-testid="compose-btn"]')
    this.postItems = page.locator('[data-testid="post-item"]')
  }

  async navigateToHome() {
    await this.page.goto('/social/home')
    await dismissAnnouncements(this.page)
    await this.page.waitForLoadState('networkidle', { timeout: 15000 })
  }

  async navigateToLocal() {
    await this.page.goto('/social/local')
    await dismissAnnouncements(this.page)
    await this.page.waitForLoadState('networkidle', { timeout: 15000 })
  }

  async navigateToPublic() {
    await this.page.goto('/social/public')
    await dismissAnnouncements(this.page)
    await this.page.waitForLoadState('networkidle', { timeout: 15000 })
  }

  async navigateToMentions() {
    await this.page.goto('/social/mentions')
    await this.page.waitForLoadState('networkidle', { timeout: 15000 })
  }

  async navigateToBookmarks() {
    await this.page.goto('/social/bookmarks')
    await this.page.waitForLoadState('networkidle', { timeout: 15000 })
  }

  async navigateToHashtag(tag: string) {
    await this.page.goto(`/social/hashtag/${tag}`)
    await this.page.waitForLoadState('networkidle', { timeout: 15000 })
  }

  async navigateToProfile(handle: string) {
    await this.page.goto(`/social/profile/${handle}`)
    await this.page.waitForLoadState('networkidle', { timeout: 15000 })
  }

  async openComposer() {
    await this.composeBtn.click()
  }

  async composePost(content: string) {
    await this.openComposer()
    const composerInput = this.page.locator('[data-testid="compose-post"] .rich-text-editor')
    await composerInput.waitFor({ state: 'visible', timeout: 5000 })
    await composerInput.click()
    await composerInput.fill(content)
    await this.page.locator('[data-testid="compose-submit"]').click()
  }

  async waitForPost(content: string) {
    await this.postItems.filter({ hasText: content }).first().waitFor({
      state: 'visible',
      timeout: 15000,
    })
  }

  getPost(content: string): Locator {
    return this.postItems.filter({ hasText: content }).first()
  }

  async favoritePost(postLocator: Locator) {
    await postLocator.locator('[data-testid="post-favorite-btn"]').click()
  }

  async reblogPost(postLocator: Locator) {
    await postLocator.locator('[data-testid="post-reblog-btn"]').click()
    // If a dropdown appears, click the simple reblog option
    const reblogOption = this.page.locator('.reblog-option:has-text("Reblog")')
    if (await reblogOption.isVisible({ timeout: 2000 }).catch(() => false)) {
      await reblogOption.click()
    }
  }

  async bookmarkPost(postLocator: Locator) {
    await postLocator.locator('[data-testid="post-bookmark-btn"]').click()
  }

  async replyToPost(postLocator: Locator, content: string) {
    await postLocator.locator('[data-testid="post-reply-btn"]').click()
    const composerInput = this.page.locator('[data-testid="compose-post"] .rich-text-editor')
    await composerInput.waitFor({ state: 'visible', timeout: 5000 })
    await composerInput.click()
    await composerInput.fill(content)
    await this.page.locator('[data-testid="compose-submit"]').click()
  }

  isFavorited(postLocator: Locator): Locator {
    return postLocator.locator('[data-testid="post-favorite-btn"].active')
  }

  isReblogged(postLocator: Locator): Locator {
    return postLocator.locator('[data-testid="post-reblog-btn"].active')
  }

  isBookmarked(postLocator: Locator): Locator {
    return postLocator.locator('[data-testid="post-bookmark-btn"].active')
  }
}
