// Journey: no setting of a self-hosted instance puts Harmony's development fund in its hands. A
// backend whose environment carries PROJECT_INSTANCE=true and PROJECT_FUNDING_URL at a feed of
// its own, which lists the instance's own payment links, is a self-hosted instance like any
// other: Admin > Funding has "Show Harmony's supporter messages" and no development fund
// section, /funding/project-feed answers 404, and the Harmony development tab shows the feed's
// progress with the Harmony project's own payment links, none of the feed's.

import { test, expect, type Browser, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'
import { startBackend, type Backend } from './backend'
import { enableFunding, PROJECT_LINK_URLS, startProjectFeed, type ProjectFeed } from './funding'

test.use({ serviceWorkers: 'block' })
test.describe.configure({ mode: 'serial' })

const admin = adminClient()
// A run tag keeps the links unique across retries.
const TAG = Math.random().toString(36).slice(2, 6)
const POCKET = `pocket${TAG}`

function ownFeed() {
  const now = new Date()
  return {
    version: 1,
    instance: 'har.mony.lol',
    enabled: true,
    goal: {
      amount: 2000,
      currency: 'USD',
      period: 'monthly',
      raised: 640,
      periodEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
      description: 'Harmony development',
    },
    supporters: 21,
    links: [
      { platform: 'stripe', url: `https://buy.stripe.com/${POCKET}`, label: 'One-time' },
      { platform: 'stripe', url: `https://donate.stripe.com/${POCKET}`, label: 'Monthly' },
      { platform: 'ko-fi', url: `https://ko-fi.com/${POCKET}`, label: 'Ko-fi' },
    ],
    messages: [],
  }
}

async function routedPage(browser: Browser, backend: Backend): Promise<Page> {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  await backend.route(page)
  return page
}

async function close(page: Page) {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await page.context().close()
}

test.describe('a self-hosted instance set up as the project', () => {
  let feed: ProjectFeed
  let backend: Backend
  let staff: SpecUser
  let member: SpecUser

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    feed = await startProjectFeed(ownFeed())
    backend = await startBackend({
      PROJECT_INSTANCE: 'true',
      PROJECT_FUNDING_URL: feed.url,
      E2E_PROJECT_FEED_URL: feed.url,
    })
    staff = await createUser(admin, 'pflocka')
    member = await createUser(admin, 'pflockm')
    await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
    await enableFunding(admin)
  })

  test.afterAll(async () => {
    await backend?.stop()
    await feed?.stop()
    await deleteUser(admin, staff)
    await deleteUser(admin, member)
  })

  test('Admin > Funding has the messages switch and no development fund section', async ({ browser }) => {
    test.setTimeout(120_000)
    const page = await routedPage(browser, backend)
    await signIn(page, staff)
    await page.goto('/admin?tab=funding')
    await expect(page.getByTestId('admin-supporter-messages')).toBeVisible({ timeout: 30000 })
    await expect(page.getByTestId('admin-project-messages')).toBeAttached({ timeout: 15000 })
    await expect(page.getByTestId('admin-project-fund')).toHaveCount(0)
    await expect(page.locator('.funding-module')).not.toContainText('Harmony development fund')
    await close(page)

    expect((await fetch(`${backend.url}/funding/project-feed`)).status).toBe(404)
    const project = await (await fetch(`${backend.url}/funding/project`)).json()
    expect(project.projectInstance).toBe(false)
    expect(project.funding.links.map((l: { url: string }) => l.url)).toEqual(PROJECT_LINK_URLS)
    expect(JSON.stringify(project)).not.toContain(POCKET)
  })

  test('the Harmony development tab links to the project\'s own payment pages, not the feed\'s', async ({ browser }) => {
    test.setTimeout(120_000)
    const page = await routedPage(browser, backend)
    await signIn(page, member)
    await page.goto('/settings/account')
    await dismissAnnouncements(page)
    await page.getByTestId('settings-support-project').click({ timeout: 30000 })
    const panel = page.getByTestId('support-panel-project')
    await expect(panel).toBeVisible({ timeout: 15000 })
    await expect(panel.getByTestId('support-raised')).toHaveText('$640', { timeout: 15000 })
    const links = panel.getByTestId('support-links-project').getByRole('link')
    await expect(links).toHaveCount(PROJECT_LINK_URLS.length)
    const hrefs = await links.evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).href))
    expect(hrefs).toEqual(PROJECT_LINK_URLS)
    await expect(panel).not.toContainText(POCKET)
    expect(await panel.innerHTML()).not.toContain(POCKET)
    await expect(panel.getByTestId('support-project-footnote')).toContainText("You pay on har.mony.lol's own pages")
    expect(feed.reads).toBeGreaterThan(0)
    await close(page)
  })
})
