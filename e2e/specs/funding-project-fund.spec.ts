// Journey: the Harmony project's development fund, kept apart from its own instance's funding.
// On the project's instance (E2E_PROJECT_INSTANCE, e2e/backend-server.ts) a signed Stripe
// checkout of the project's Payment Link and one of the instance's own link land in separate
// funds: the Support window has both tabs, each with its own total, and the project's links
// credit the signed-in donor. A message written in the Harmony development tab goes with the next
// project donation and waits in Admin > Funding > Harmony development fund, apart from the
// instance's queue; approved there, it is in the project fund's feed. The section has no link
// fields: with the fund as installed, checkouts of both of the project's Payment Links count
// toward it and the tab shows the project's links with no progress bar. A self-hosted instance
// reads the project fund from the project's instance (/funding/project-feed), never that
// instance's own feed, and shows the project's own links. At 375 px the tab and the admin section
// have no sideways scroll.

import { test, expect, type Browser, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, userClient, type SpecUser } from './harness'
import { startBackend, type Backend } from './backend'
import { expectNoAxeViolations } from './a11y'
import {
  enableFunding,
  installProjectFund,
  instanceRaised,
  openSupportFromSettings,
  postStripeCheckout,
  PROJECT_LINK_URLS,
  PROJECT_PLINK,
  PROJECT_PLINK_MONTHLY,
  resetProjectFund,
  startProjectFeed,
  type ProjectFeed,
} from './funding'

test.use({ serviceWorkers: 'block' })
// Both groups write the one project_funding row and its donations.
test.describe.configure({ mode: 'serial' })

const admin = adminClient()
// Unresolvable (RFC 6761 .invalid): a self-host's read of the project feed fails at once.
const UNREACHABLE_FEED = 'https://funding.e2e.invalid/api/federation/funding/project-feed'
// A run tag keeps the bodies unique across retries and other specs.
const TAG = Math.random().toString(36).slice(2, 6)
const FIRST = `For Harmony ${TAG}`
const SECOND = `Keep building ${TAG}`

const usd = (amount: number) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
}).format(amount)

async function routedPage(browser: Browser, backend: Backend, viewport?: { width: number; height: number }): Promise<Page> {
  const context = await browser.newContext({ serviceWorkers: 'block', ...(viewport ? { viewport, reducedMotion: 'reduce' as const } : {}) })
  const page = await context.newPage()
  await backend.route(page)
  return page
}

async function close(page: Page) {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await page.context().close()
}

async function openProjectTab(page: Page) {
  await openSupportFromSettings(page)
  await page.getByTestId('support-tab-project').click()
  const panel = page.getByTestId('support-panel-project')
  await expect(panel).toBeVisible({ timeout: 15000 })
  return panel
}

async function projectRows(user: SpecUser) {
  const { data, error } = await admin.from('instance_donation_history')
    .select('amount, fund, supporter_id').eq('user_id', user.id).order('amount')
  if (error) throw new Error(error.message)
  return (data ?? []).map((r) => ({ amount: Number(r.amount), fund: r.fund, supporter: r.supporter_id !== null }))
}

test.describe('on the project instance', () => {
  let backend: Backend
  let staff: SpecUser
  let donor: SpecUser

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    backend = await startBackend({ E2E_PROJECT_INSTANCE: 'true', E2E_PROJECT_FEED_URL: UNREACHABLE_FEED })
    staff = await createUser(admin, 'pfunda')
    donor = await createUser(admin, 'pfundd')
    await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
    await enableFunding(admin)
    await resetProjectFund(admin)
  })

  test.afterAll(async () => {
    await resetProjectFund(admin, { enabled: false }).catch(() => {})
    await backend?.stop()
    await deleteUser(admin, staff)
    await deleteUser(admin, donor)
  })

  test('a checkout into each fund: two tabs, two totals, the project link credits the donor', async ({ browser }) => {
    test.setTimeout(150_000)
    // The donor's message for the project, written before paying.
    const client = await userClient(donor)
    const written = await client.rpc('set_supporter_message', { p_body: FIRST, p_anonymous: false, p_fund: 'project' })
    expect(written.error).toBeNull()

    const project = await postStripeCheckout(backend.url, donor.id, 1700, PROJECT_PLINK)
    expect(await project.json()).toMatchObject({ status: 'recorded', fund: 'project' })
    const own = await postStripeCheckout(backend.url, donor.id, 300)
    expect(await own.json()).toMatchObject({ status: 'recorded', fund: 'instance' })

    // The project donation has no instance supporter row; the message went with it.
    expect(await projectRows(donor)).toEqual([
      { amount: 3, fund: 'instance', supporter: true },
      { amount: 17, fund: 'project', supporter: false },
    ])
    const { data: message } = await admin.from('instance_supporter_messages')
      .select('fund, review, donation:instance_donation_history(amount)').eq('body', FIRST).single()
    expect(message).toMatchObject({ fund: 'project', review: 'pending', donation: { amount: 17 } })

    const page = await routedPage(browser, backend)
    await signIn(page, donor)
    const before = await instanceRaised(admin)
    await openSupportFromSettings(page)
    await expect(page.getByRole('tablist').getByRole('tab')).toHaveText(['This instance', 'Harmony development'], { timeout: 15000 })
    const shown = await page.getByTestId('support-panel-instance').getByTestId('support-raised').textContent()
    const after = await instanceRaised(admin)
    // Other journeys may pay the instance meanwhile; the project's 17 is never in its total.
    expect([usd(before), usd(after)]).toContain(shown)

    const panel = await openProjectTab(page)
    await expect(panel.getByTestId('support-raised')).toHaveText('$17')
    await expect(panel.getByTestId('support-progress')).toContainText('1 supporter')
    const link = panel.getByTestId('support-links-project').getByRole('link').first()
    expect(new URL((await link.getAttribute('href'))!).searchParams.get('client_reference_id')).toBe(donor.id)
    await expect(panel.getByTestId('support-project-footnote')).toContainText("Harmony's development fund, kept apart from")
    // The donor's own message, awaiting approval, and no other.
    const wall = panel.getByTestId('supporter-wall-project')
    await expect(wall.getByTestId('supporter-message-own').getByTestId('supporter-message-body')).toHaveText([FIRST])
    await expect(page.getByTestId('support-panel-instance')).not.toContainText(FIRST)
    await expectNoAxeViolations(page, { include: '.support-modal-overlay', label: 'Support window, the project instance\'s project fund' })
    await close(page)
  })

  test('a message from the Harmony development tab waits in the fund\'s own queue; approved, it is in the fund\'s feed', async ({ browser }) => {
    test.setTimeout(180_000)
    const page = await routedPage(browser, backend)
    await signIn(page, donor)
    const panel = await openProjectTab(page)
    await panel.getByTestId('support-message-toggle').click()
    await panel.getByTestId('support-message-input').fill(SECOND)
    await panel.getByTestId('support-message-save').click()
    await expect(panel.getByTestId('support-message-status')).toBeVisible({ timeout: 15000 })
    await close(page)
    await expect.poll(async () => {
      const { data } = await admin.from('instance_supporter_messages').select('fund, donation_id').eq('body', SECOND).maybeSingle()
      return data
    }, { timeout: 15000 }).toEqual({ fund: 'project', donation_id: null })

    expect(await (await postStripeCheckout(backend.url, donor.id, 500, PROJECT_PLINK)).json()).toMatchObject({ fund: 'project' })

    const staffPage = await routedPage(browser, backend)
    await signIn(staffPage, staff)
    await staffPage.goto('/admin?tab=funding')
    const section = staffPage.getByTestId('admin-project-fund')
    await expect(section).toBeVisible({ timeout: 30000 })
    const queue = section.getByTestId('admin-project-message')
    await expect(queue.filter({ hasText: SECOND })).toHaveCount(1, { timeout: 15000 })
    await expect(queue.filter({ hasText: FIRST })).toHaveCount(1)
    // The instance's queue does not list the project's messages.
    await expect(staffPage.getByTestId('admin-supporter-messages').getByText(SECOND)).toHaveCount(0)

    await queue.filter({ hasText: SECOND }).getByTestId('admin-supporter-message-approve').click()
    await expect.poll(async () => {
      const { data } = await admin.from('instance_supporter_messages').select('review').eq('body', SECOND).single()
      return data?.review
    }, { timeout: 15000 }).toBe('approved')

    // The fund's settings: a new goal, saved from the section.
    await section.getByTestId('admin-project-fund-goal').fill('2500')
    await section.getByTestId('admin-project-fund-save').click()
    await expect.poll(async () => {
      const { data } = await admin.from('project_funding').select('goal_amount').single()
      return Number(data?.goal_amount)
    }, { timeout: 15000 }).toBe(2500)
    await close(staffPage)

    // The feed other instances read: the approved message and the goal, the pending one absent,
    // once its minute of cache has passed.
    await expect.poll(async () => {
      const feed = await (await fetch(`${backend.url}/funding/project-feed`)).json()
      return { goal: feed.goal?.amount, raised: feed.goal?.raised, bodies: feed.messages.map((m: { body: string }) => m.body) }
    }, { timeout: 90_000, intervals: [5000] }).toEqual({ goal: 2500, raised: 22, bodies: [SECOND] })
    const ownFeed = await (await fetch(`${backend.url}/funding/public`)).json()
    expect(JSON.stringify(ownFeed)).not.toContain(TAG)
  })

  test('at 375 px the Harmony development tab and the admin section have no sideways scroll', async ({ browser }) => {
    test.setTimeout(120_000)
    const page = await routedPage(browser, backend, { width: 375, height: 812 })
    await signIn(page, donor)
    const panel = await openProjectTab(page)
    await expect(panel.getByTestId('support-message')).toBeVisible()
    const overflow = await page.evaluate(() => {
      const content = document.querySelector('.support-modal-overlay .modal-content') as HTMLElement
      return { page: document.documentElement.scrollWidth, content: content.scrollWidth - content.clientWidth }
    })
    expect(overflow.page).toBeLessThanOrEqual(375)
    expect(overflow.content).toBe(0)
    await close(page)

    const staffPage = await routedPage(browser, backend, { width: 375, height: 812 })
    await signIn(staffPage, staff)
    await staffPage.goto('/admin?tab=funding')
    const section = staffPage.getByTestId('admin-project-fund')
    await expect(section).toBeVisible({ timeout: 30000 })
    await section.scrollIntoViewIfNeeded()
    const sectionOverflow = await section.evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(sectionOverflow).toBeLessThanOrEqual(0)
    expect(await staffPage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
    await close(staffPage)
  })

  test('as installed: both Payment Links count toward the fund, the tab shows the project\'s links, the section has no link fields', async ({ browser }) => {
    test.setTimeout(150_000)
    await installProjectFund(admin)
    expect(await (await postStripeCheckout(backend.url, donor.id, 400, PROJECT_PLINK)).json())
      .toMatchObject({ status: 'recorded', fund: 'project' })
    expect(await (await postStripeCheckout(backend.url, donor.id, 100, PROJECT_PLINK_MONTHLY)).json())
      .toMatchObject({ status: 'recorded', fund: 'project' })
    expect(await (await postStripeCheckout(backend.url, donor.id, 200, 'plink_e2e_elsewhere')).json())
      .toMatchObject({ status: 'recorded', fund: 'instance' })
    // The backend holds the fund's feed a minute (routes/funding.ts FEED_CACHE_MS).
    await expect.poll(async () => {
      const feed = await (await fetch(`${backend.url}/funding/project-feed`)).json()
      return { enabled: feed.enabled, goal: feed.goal, supporters: feed.supporters }
    }, { timeout: 90_000, intervals: [5000] }).toEqual({ enabled: true, goal: null, supporters: 1 })

    const page = await routedPage(browser, backend)
    await signIn(page, donor)
    const panel = await openProjectTab(page)
    const links = panel.getByTestId('support-links-project').getByRole('link')
    await expect(links).toHaveCount(PROJECT_LINK_URLS.length)
    const hrefs = (await links.evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).href))).map((h) => new URL(h))
    expect(hrefs.map((u) => u.origin + u.pathname)).toEqual(PROJECT_LINK_URLS)
    expect(hrefs[0].searchParams.get('client_reference_id')).toBe(donor.id)
    await expect(panel.getByTestId('support-progress')).toHaveCount(0)
    await expect(panel.getByTestId('support-message')).toBeVisible()
    await close(page)

    const staffPage = await routedPage(browser, backend)
    await signIn(staffPage, staff)
    await staffPage.goto('/admin?tab=funding')
    const section = staffPage.getByTestId('admin-project-fund')
    await expect(section).toBeVisible({ timeout: 30000 })
    await expect(section.getByTestId('admin-project-fund-enabled')).toBeChecked()
    await expect(section.getByTestId('admin-project-fund-goal')).toHaveValue('')
    await expect(section.getByTestId('admin-project-fund-messages')).toBeChecked()
    await expect(section.getByLabel('Ko-fi verification token')).toBeAttached()
    await expect(section.getByTestId('admin-project-fund-links')).toHaveCount(0)
    await expect(section.getByTestId('admin-project-fund-link-url')).toHaveCount(0)
    await expect(section.getByTestId('admin-project-fund-plinks')).toHaveCount(0)
    expect(await section.locator('input[type="url"], input[placeholder^="https"], input[placeholder^="plink"]').count()).toBe(0)
    await expect(section).not.toContainText('Payment Link')
    await expect(staffPage.getByTestId('admin-project-messages')).toHaveCount(0)
    await close(staffPage)
  })
})

test.describe('a self-hosted instance', () => {
  let project: Backend
  let peer: ProjectFeed
  let self: Backend
  let donor: SpecUser
  let member: SpecUser

  test.beforeAll(async () => {
    test.setTimeout(150_000)
    // The project's instance, reached through a public address as har.mony.lol would be.
    project = await startBackend({ E2E_PROJECT_INSTANCE: 'true', E2E_PROJECT_FEED_URL: UNREACHABLE_FEED })
    peer = await startProjectFeed(null, { proxyTo: project.url })
    self = await startBackend({ E2E_PROJECT_FEED_URL: peer.url })
    donor = await createUser(admin, 'pfunds')
    member = await createUser(admin, 'pfundm')
    await enableFunding(admin)
    await resetProjectFund(admin, { goal: 1500 })
    expect(await (await postStripeCheckout(project.url, donor.id, 900, PROJECT_PLINK)).json()).toMatchObject({ fund: 'project' })
  })

  test.afterAll(async () => {
    await resetProjectFund(admin, { enabled: false }).catch(() => {})
    await self?.stop()
    await peer?.stop()
    await project?.stop()
    await deleteUser(admin, donor)
    await deleteUser(admin, member)
  })

  test('its Harmony development tab is the project fund, read from the project\'s instance', async ({ browser }) => {
    test.setTimeout(120_000)
    const page = await routedPage(browser, self)
    await signIn(page, member)
    const panel = await openProjectTab(page)
    await expect(panel.getByTestId('support-raised')).toHaveText('$9', { timeout: 15000 })
    await expect(panel.getByTestId('support-progress')).toContainText('$1,500')
    const links = panel.getByTestId('support-links-project').getByRole('link')
    await expect(links).toHaveCount(PROJECT_LINK_URLS.length)
    expect(await links.evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).href))).toEqual(PROJECT_LINK_URLS)
    await expect(panel.getByTestId('support-project-fallback')).toHaveCount(0)
    await expect(panel.getByTestId('support-project-footnote')).toContainText('You pay on')

    // This instance's own tab keeps its own links, which credit the member.
    await page.getByTestId('support-tab-instance').click()
    const instanceLink = page.getByTestId('support-links-instance').getByRole('link').first()
    expect(new URL((await instanceLink.getAttribute('href'))!).searchParams.get('client_reference_id')).toBe(member.id)

    expect(peer.reads).toBeGreaterThan(0)
    expect(peer.publicReads).toBe(0)
    await close(page)
  })
})
