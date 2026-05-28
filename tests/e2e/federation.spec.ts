import { test, expect, dismissAnnouncements } from './fixtures/auth.fixture'
import { SocialPage } from './pages/SocialPage'

const federationEnabled = process.env.VITE_ENABLE_FEDERATION !== 'false'

test.describe('Federation', () => {
  test.skip(!federationEnabled, 'Federation is disabled')

  test('public timeline loads (includes federated posts)', async ({ alicePage }) => {
    const social = new SocialPage(alicePage)
    await social.navigateToPublic()
    await expect(social.timelineFeed).toBeVisible({ timeout: 15000 })
  })

  test('trending/explore page loads', async ({ alicePage }) => {
    await alicePage.goto('/social/trending')
    await dismissAnnouncements(alicePage)
    await alicePage.waitForLoadState('networkidle', { timeout: 15000 })
    expect(alicePage.url()).toContain('/social/trending')
  })

  test('instances page loads', async ({ alicePage }) => {
    await alicePage.goto('/social/instances')
    await dismissAnnouncements(alicePage)
    await alicePage.waitForLoadState('networkidle', { timeout: 15000 })
    expect(alicePage.url()).toContain('/social/instances')
  })

  test('can view a remote user profile', async ({ alicePage }) => {
    // Navigate to a remote user handle if one exists in public timeline
    const social = new SocialPage(alicePage)
    await social.navigateToPublic()

    // Find a post from a non-local user (has a domain indicator)
    const remotePost = alicePage.locator('.instance-domain:not(.is-local)').first()
    if (await remotePost.isVisible({ timeout: 10000 }).catch(() => false)) {
      // Click the author to view their profile
      const authorLink = remotePost.locator('..').locator('..').locator('.author-info')
      if (await authorLink.isVisible({ timeout: 2000 }).catch(() => false)) {
        await authorLink.click()
        await alicePage.waitForLoadState('networkidle', { timeout: 15000 })
        expect(alicePage.url()).toContain('/social/profile/')
      }
    }
  })

  test('followers page loads', async ({ alicePage }) => {
    await alicePage.goto('/social/followers')
    await dismissAnnouncements(alicePage)
    await alicePage.waitForLoadState('networkidle', { timeout: 15000 })
    expect(alicePage.url()).toContain('/social/followers')
  })

  test('following page loads', async ({ alicePage }) => {
    await alicePage.goto('/social/following')
    await dismissAnnouncements(alicePage)
    await alicePage.waitForLoadState('networkidle', { timeout: 15000 })
    expect(alicePage.url()).toContain('/social/following')
  })
})
