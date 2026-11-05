// Journey: "Show Harmony's supporter messages" in Admin > Funding. On a self-hosted instance the
// Harmony development tab shows the project's links, progress and supporter messages, read by this
// instance's backend from the project's feed. An admin turns the messages off: the tab keeps the
// links and progress in one column, and /funding/project carries no message, so none reaches the
// page. Turned back on, they show again. On the project's own instance the switch is absent.
// At 375 px the one-column tab has no sideways scroll.

import { test, expect, type Browser, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'
import { startBackend, type Backend } from './backend'
import { enableFunding, startProjectFeed, type ProjectFeed } from './funding'

test.use({ serviceWorkers: 'block' })

const admin = adminClient()
const UNREACHABLE_FEED = 'https://funding.e2e.invalid/api/federation/funding/project-feed'
// A run tag keeps the bodies unique across retries and other specs.
const TAG = Math.random().toString(36).slice(2, 6)
const BODIES = [`Thanks for Harmony ${TAG}`, `Keep building ${TAG}`]
const NAME = `Ada ${TAG}`

function projectFeed() {
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
      description: 'Servers and development',
    },
    supporters: 21,
    links: [
      { platform: 'stripe', url: 'https://buy.stripe.com/test_e2e_project', label: 'One-time' },
      { platform: 'ko-fi', url: 'https://ko-fi.com/e2e-project', label: '' },
    ],
    messages: [
      { id: '0b6f8a1e-0000-4000-8000-0000000000a1', body: BODIES[0], name: NAME, at: new Date(now.getTime() - 3_600_000).toISOString() },
      { id: '0b6f8a1e-0000-4000-8000-0000000000a2', body: BODIES[1], name: null, at: new Date(now.getTime() - 7_200_000).toISOString() },
    ],
  }
}

async function setShown(value: boolean) {
  const { error } = await admin.from('instance_funding').update({ show_project_messages: value }).not('id', 'is', null)
  if (error) throw new Error(`instance_funding: ${error.message}`)
}

interface ProjectPage { page: Page; bodies: string[] }

/** A page routed to `backend` that keeps the body of every /funding/project response. */
async function projectPage(browser: Browser, backend: Backend, viewport?: { width: number; height: number }): Promise<ProjectPage> {
  const context = await browser.newContext({ serviceWorkers: 'block', ...(viewport ? { viewport, reducedMotion: 'reduce' as const } : {}) })
  const page = await context.newPage()
  await backend.route(page)
  const bodies: string[] = []
  page.on('response', (response) => {
    if (response.url().includes('/api/federation/funding/project')) void response.text().then((t) => bodies.push(t), () => {})
  })
  return { page, bodies }
}

/** Closes the page's context; a backend request still in flight is dropped, not failed. */
async function close(page: Page) {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await page.context().close()
}

/**
 * User settings > My account > Support Harmony's development: the window on the project tab.
 * `inApp` navigates through the app's router, keeping the page and its stores.
 */
async function openProjectTab(page: Page, options: { inApp?: boolean } = {}) {
  if (options.inApp) {
    await page.evaluate(() => {
      const app = (document.querySelector('#app') as unknown as {
        __vue_app__: { config: { globalProperties: { $router: { push(path: string): Promise<unknown> } } } }
      }).__vue_app__
      return app.config.globalProperties.$router.push('/settings/account')
    })
  } else {
    await page.goto('/settings/account')
    await dismissAnnouncements(page)
  }
  await page.getByTestId('settings-support-project').click({ timeout: 30000 })
  const panel = page.getByTestId('support-panel-project')
  await expect(panel).toBeVisible({ timeout: 15000 })
  await expect(panel.getByTestId('support-links-project')).toBeVisible({ timeout: 15000 })
  return panel
}

/** Admin > Funding with the project switch drawn; returns it. */
async function openFundingAdmin(page: Page) {
  await page.goto('/admin?tab=funding')
  await expect(page.getByTestId('admin-supporter-messages')).toBeVisible({ timeout: 30000 })
  return page.getByTestId('admin-project-messages')
}

async function flip(page: Page, checked: boolean) {
  const toggle = page.getByTestId('admin-project-messages')
  await expect(toggle).toBeChecked({ checked: !checked, timeout: 15000 })
  // The checkbox is drawn as a slider; its label takes the click.
  await page.locator('label.toggle-label', { has: toggle }).click()
  await expect(toggle).toBeChecked({ checked })
  await page.locator('.funding-module .save-btn').click()
  await expect(page.locator('.funding-module .save-btn')).toBeDisabled({ timeout: 15000 })
  await expect.poll(async () => {
    const { data } = await admin.from('instance_funding').select('show_project_messages').limit(1).single()
    return data?.show_project_messages
  }, { timeout: 15000 }).toBe(checked)
}

test.describe('on a self-hosted instance', () => {
  // The switch is one instance-wide row: these run in order.
  test.describe.configure({ mode: 'serial' })

  let feed: ProjectFeed
  let backend: Backend
  let staff: SpecUser
  let member: SpecUser

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    feed = await startProjectFeed(projectFeed())
    backend = await startBackend({ PROJECT_FUNDING_URL: feed.url, PROJECT_INSTANCE: 'auto' })
    staff = await createUser(admin, 'projmsga')
    member = await createUser(admin, 'projmsgm')
    await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
    await enableFunding(admin)
    await setShown(true)
  })

  test.afterAll(async () => {
    await setShown(true).catch(() => {})
    await backend?.stop()
    await feed?.stop()
    await deleteUser(admin, staff)
    await deleteUser(admin, member)
  })

  test('on by default: the Harmony development tab shows the project\'s messages', async ({ browser }) => {
    test.setTimeout(120_000)
    const { page } = await projectPage(browser, backend)
    await signIn(page, member)
    const panel = await openProjectTab(page)
    const wall = panel.getByTestId('supporter-wall-project')
    await expect(wall).toBeVisible({ timeout: 15000 })
    await expect(wall.getByTestId('supporter-message-body')).toHaveText(BODIES)
    await expect(wall.getByTestId('supporter-message-name')).toHaveText([NAME, 'Anonymous'])
    await expect(panel.getByTestId('support-raised')).toHaveText('$640')
    await expect(panel.getByTestId('support-project-fallback')).toHaveCount(0)
    expect(await panel.locator('.support-grid').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(2)
    expect(feed.reads).toBeGreaterThan(0)
    await close(page)
  })

  test('an admin turns them off: links and progress stay, no message reaches the page', async ({ browser }) => {
    test.setTimeout(150_000)
    const staffPage = await projectPage(browser, backend)
    await signIn(staffPage.page, staff)
    const toggle = await openFundingAdmin(staffPage.page)
    await expect(toggle).toBeChecked({ timeout: 15000 })
    await expect(staffPage.page.getByTestId('admin-project-messages-hint')).toHaveText(
      "On the Harmony development tab of the Support window. The Harmony project approves these messages, not this instance's admins.",
    )
    await flip(staffPage.page, false)

    // The admin's own window, in the page whose store read the feed with messages before the change.
    const own = await openProjectTab(staffPage.page, { inApp: true })
    await expect(own.getByTestId('support-links-project').getByRole('link')).toHaveCount(2)
    await expect(own.getByTestId('supporter-wall-project')).toHaveCount(0)
    await expect(own).not.toContainText(BODIES[0])
    await close(staffPage.page)

    const { page, bodies } = await projectPage(browser, backend)
    await signIn(page, member)
    const panel = await openProjectTab(page)
    await expect(panel.getByTestId('support-links-project').getByRole('link')).toHaveCount(2)
    await expect(panel.getByTestId('support-raised')).toHaveText('$640')
    await expect(panel.getByTestId('supporter-wall-project')).toHaveCount(0)
    await expect(panel).not.toContainText(BODIES[0])
    await expect.poll(() => bodies.length, { timeout: 15000 }).toBeGreaterThan(0)
    for (const body of bodies) {
      const parsed = JSON.parse(body)
      expect(parsed.funding.messages).toEqual([])
      expect(parsed.funding.links).toHaveLength(2)
      expect(body).not.toContain(TAG)
    }
    // One column, centred in the window.
    const layout = await panel.locator('.support-grid').evaluate((el) => {
      const box = el.getBoundingClientRect()
      const parent = (el.parentElement as HTMLElement).getBoundingClientRect()
      return {
        tracks: getComputedStyle(el).gridTemplateColumns.split(' ').length,
        left: Math.round(box.left - parent.left),
        right: Math.round(parent.right - box.right),
      }
    })
    expect(layout.tracks).toBe(1)
    expect(Math.abs(layout.left - layout.right)).toBeLessThanOrEqual(1)
    await close(page)
  })

  test('off, at 375 px: one column with no sideways scroll', async ({ browser }) => {
    test.setTimeout(120_000)
    const { page } = await projectPage(browser, backend, { width: 375, height: 812 })
    await signIn(page, member)
    const panel = await openProjectTab(page)
    await expect(panel.getByTestId('supporter-wall-project')).toHaveCount(0)
    const overflow = await page.evaluate(() => {
      const content = document.querySelector('.support-modal-overlay .modal-content') as HTMLElement
      const grid = document.querySelector('[data-testid="support-panel-project"] .support-grid') as HTMLElement
      return {
        page: document.documentElement.scrollWidth,
        content: content.scrollWidth - content.clientWidth,
        grid: Math.round(grid.getBoundingClientRect().width),
        inner: Math.round(content.clientWidth - parseFloat(getComputedStyle(content).paddingLeft) - parseFloat(getComputedStyle(content).paddingRight)),
      }
    })
    expect(overflow.page).toBeLessThanOrEqual(375)
    expect(overflow.content).toBe(0)
    expect(overflow.grid).toBe(overflow.inner)
    await close(page)
  })

  test('turned back on, the messages show again', async ({ browser }) => {
    test.setTimeout(120_000)
    const staffPage = await projectPage(browser, backend)
    await signIn(staffPage.page, staff)
    await openFundingAdmin(staffPage.page)
    await flip(staffPage.page, true)
    await close(staffPage.page)

    const { page } = await projectPage(browser, backend)
    await signIn(page, member)
    const panel = await openProjectTab(page)
    await expect(panel.getByTestId('supporter-wall-project').getByTestId('supporter-message-body')).toHaveText(BODIES, { timeout: 15000 })
    await close(page)
  })
})

test.describe('on the project instance', () => {
  let backend: Backend
  let staff: SpecUser

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    backend = await startBackend({ PROJECT_FUNDING_URL: UNREACHABLE_FEED, PROJECT_INSTANCE: 'true' })
    staff = await createUser(admin, 'projmsgp')
    await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
    await enableFunding(admin)
  })

  test.afterAll(async () => {
    await backend?.stop()
    await deleteUser(admin, staff)
  })

  test('the switch is absent: there is no Harmony development tab to apply it to', async ({ browser }) => {
    test.setTimeout(120_000)
    const { page, bodies } = await projectPage(browser, backend)
    await signIn(page, staff)
    await openFundingAdmin(page)
    // The instance's own message switches are there; the checkbox is drawn as its label's slider.
    await expect(page.locator('label.toggle-label', { has: page.getByTestId('admin-supporter-messages-enabled') })).toBeVisible()
    await expect.poll(() => bodies.length, { timeout: 15000 }).toBeGreaterThan(0)
    expect(JSON.parse(bodies[0])).toMatchObject({ projectInstance: true, source: 'local' })
    await expect(page.getByTestId('admin-project-messages')).toHaveCount(0)
    await close(page)
  })
})
