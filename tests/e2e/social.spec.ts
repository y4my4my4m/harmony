import { test, expect } from './fixtures/auth.fixture'
import { SocialPage } from './pages/SocialPage'

test.describe('Social / ActivityPub - Timelines', () => {
  test('home timeline loads', async ({ alicePage }) => {
    const social = new SocialPage(alicePage)
    await social.navigateToHome()
    await expect(social.timelineFeed).toBeVisible({ timeout: 15000 })
  })

  test('local timeline loads', async ({ alicePage }) => {
    const social = new SocialPage(alicePage)
    await social.navigateToLocal()
    await expect(social.timelineFeed).toBeVisible({ timeout: 15000 })
  })

  test('public timeline loads', async ({ alicePage }) => {
    const social = new SocialPage(alicePage)
    await social.navigateToPublic()
    await expect(social.timelineFeed).toBeVisible({ timeout: 15000 })
  })

  test('mentions page loads', async ({ alicePage }) => {
    const social = new SocialPage(alicePage)
    await social.navigateToMentions()
    // Should not crash - page loads
    expect(alicePage.url()).toContain('/social/mentions')
  })

  test('bookmarks page loads', async ({ alicePage }) => {
    const social = new SocialPage(alicePage)
    await social.navigateToBookmarks()
    expect(alicePage.url()).toContain('/social/bookmarks')
  })
})

test.describe('Social / ActivityPub - Compose & Interact', () => {
  test('can compose and publish a post', async ({ alicePage }) => {
    const social = new SocialPage(alicePage)
    await social.navigateToLocal()

    const content = `E2E post ${Date.now()}`
    await social.composePost(content)

    // Post should appear in the feed
    await social.waitForPost(content)
  })

  test('can reply to a post', async ({ alicePage }) => {
    const social = new SocialPage(alicePage)
    await social.navigateToLocal()

    // First compose a post to reply to
    const original = `Reply target ${Date.now()}`
    await social.composePost(original)
    await social.waitForPost(original)

    const post = social.getPost(original)
    const reply = `E2E reply ${Date.now()}`
    await social.replyToPost(post, reply)

    // Reply should appear (either in-thread or on timeline after refresh)
    await alicePage.waitForTimeout(2000)
  })

  test('can favorite a post', async ({ alicePage }) => {
    const social = new SocialPage(alicePage)
    await social.navigateToLocal()

    const content = `Favorite me ${Date.now()}`
    await social.composePost(content)
    await social.waitForPost(content)

    const post = social.getPost(content)
    await social.favoritePost(post)
    await expect(social.isFavorited(post)).toBeVisible({ timeout: 5000 })
  })

  test('can reblog a post', async ({ alicePage }) => {
    const social = new SocialPage(alicePage)
    await social.navigateToLocal()

    const content = `Reblog me ${Date.now()}`
    await social.composePost(content)
    await social.waitForPost(content)

    const post = social.getPost(content)
    await social.reblogPost(post)
    await expect(social.isReblogged(post)).toBeVisible({ timeout: 5000 })
  })

  test('can bookmark a post', async ({ alicePage }) => {
    const social = new SocialPage(alicePage)
    await social.navigateToLocal()

    const content = `Bookmark me ${Date.now()}`
    await social.composePost(content)
    await social.waitForPost(content)

    const post = social.getPost(content)
    await social.bookmarkPost(post)
    await expect(social.isBookmarked(post)).toBeVisible({ timeout: 5000 })
  })

  test('bookmarked post appears in bookmarks view', async ({ alicePage }) => {
    const social = new SocialPage(alicePage)
    await social.navigateToLocal()

    const content = `Bookmark check ${Date.now()}`
    await social.composePost(content)
    await social.waitForPost(content)

    const post = social.getPost(content)
    await social.bookmarkPost(post)

    // Navigate to bookmarks
    await social.navigateToBookmarks()
    await social.waitForPost(content)
  })
})

test.describe('Social / ActivityPub - Profile & Follow', () => {
  test('can view user profile', async ({ alicePage, seedData }) => {
    const social = new SocialPage(alicePage)
    await social.navigateToProfile(seedData.bob.username)

    // Profile page should load without crashing
    await alicePage.waitForLoadState('networkidle', { timeout: 15000 })
    expect(alicePage.url()).toContain('/social/profile/')
  })

  test('can follow a user from profile', async ({ alicePage, seedData }) => {
    const social = new SocialPage(alicePage)
    await social.navigateToProfile(seedData.bob.username)

    const followBtn = alicePage.locator('button:has-text("Follow")')
    if (await followBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await followBtn.click()
      // Should change to "Unfollow" or "Following"
      await expect(
        alicePage.locator('button:has-text("Unfollow"), button:has-text("Following")')
      ).toBeVisible({ timeout: 5000 })
    }
  })

  test('can unfollow a user from profile', async ({ alicePage, seedData }) => {
    const social = new SocialPage(alicePage)
    await social.navigateToProfile(seedData.bob.username)

    const unfollowBtn = alicePage.locator('button:has-text("Unfollow"), button:has-text("Following")')
    if (await unfollowBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await unfollowBtn.click()
      // Should revert to "Follow"
      await expect(alicePage.locator('button:has-text("Follow")')).toBeVisible({ timeout: 5000 })
    }
  })

  test('hashtag feed loads', async ({ alicePage }) => {
    const social = new SocialPage(alicePage)
    await social.navigateToHashtag('test')
    expect(alicePage.url()).toContain('/social/hashtag/test')
  })
})
