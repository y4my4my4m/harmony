// Journey: the Support window. Two tabs on every instance, "This instance" and "Harmony
// development". The instance's Stripe link carries the donor's profile id. The development tab is
// Har and Mony, the project's one-time and monthly Stripe Payment Links, which carry no profile id
// or email, and a link to the supporters page on mony.lol, which opens through the outside-link
// path ("Leaving Harmony" when the account asks for every outside link). It has no progress bar,
// no messages and no composer, and requests nothing of the backend. Settings opens the window on
// it. On a 375 px phone the window is a full-height sheet and neither tab scrolls sideways. In
// Paper, Skyglass and High contrast, light and dark, its text passes axe color-contrast and
// Paper draws its window strip.

import { test, expect, type Browser, type BrowserContext, type Page, type Request } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, openChannel, seedServer, signIn, type SeededServer, type SpecUser } from './harness'
import { startBackend, type Backend } from './backend'
import { DEVELOPMENT_LINK_URLS, DEVELOPMENT_SUPPORTERS_URL, enableFunding, openSupportFromChat, openSupportFromSettings } from './funding'
import { expectNoAxeViolations } from './a11y'

test.use({ serviceWorkers: 'block' })

const admin = adminClient()

let backend: Backend
let donor: SpecUser
let phone: SpecUser
let styled: SpecUser
let opener: SpecUser
let donorServer: SeededServer
let phoneServer: SeededServer

test.beforeAll(async () => {
  test.setTimeout(120_000)
  backend = await startBackend()
  donor = await createUser(admin, 'supwin')
  phone = await createUser(admin, 'supwinp')
  styled = await createUser(admin, 'supwins')
  opener = await createUser(admin, 'supwino')
  donorServer = await seedServer(admin, donor, `Support ${donor.username}`)
  phoneServer = await seedServer(admin, phone, `Support ${phone.username}`)
  await enableFunding(admin)
})

test.afterAll(async () => {
  await backend?.stop()
  for (const user of [donor, phone, styled, opener]) if (user) await deleteUser(admin, user)
})

/** Every request the page makes to the backend's funding routes. */
function fundingRequests(page: Page): string[] {
  const seen: string[] = []
  page.on('request', (request: Request) => {
    const url = new URL(request.url())
    if (/\/api\/federation\/funding\b/.test(url.pathname)) seen.push(`${request.method()} ${url.pathname}`)
  })
  return seen
}

async function routeMonyLol(context: BrowserContext) {
  await context.route(/^https:\/\/mony\.lol\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<title>supporters</title>supporters' }))
}

const leaving = (page: Page) => page.getByRole('alertdialog', { name: 'Leaving Harmony' })

async function expectDevelopmentTab(page: Page) {
  const panel = page.getByTestId('support-panel-project')
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'Help build Harmony' })).toBeVisible()
  const duo = panel.locator('img.support-project__mascot')
  await expect(duo).toBeVisible()
  expect(await duo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)

  const links = panel.getByTestId('support-links-project').getByRole('link')
  await expect(links).toHaveCount(2, { timeout: 15000 })
  expect(await links.evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).href))).toEqual(DEVELOPMENT_LINK_URLS)
  await expect(links.locator('.support-link__title')).toHaveText(['One-time', 'Monthly'])

  await expect(panel.getByTestId('support-project-footnote')).toContainText('Stripe')
  const supporters = panel.getByRole('link', { name: 'Supporters and their messages' })
  await expect(supporters).toHaveAttribute('href', DEVELOPMENT_SUPPORTERS_URL)

  await expect(panel.getByRole('progressbar')).toHaveCount(0)
  await expect(panel.getByTestId('support-progress')).toHaveCount(0)
  await expect(panel.locator('[data-testid^="supporter-wall"]')).toHaveCount(0)
  await expect(panel.getByTestId('supporter-message')).toHaveCount(0)
  await expect(panel.getByTestId('support-message')).toHaveCount(0)
  await expect(panel.getByRole('textbox')).toHaveCount(0)
}

test('two tabs: the instance links credit the donor; the development tab is two Stripe links and the supporters page', async ({ page, context }) => {
  test.setTimeout(150_000)
  const { data: profile } = await admin.from('profiles').select('auth_user_id').eq('id', donor.id).single()
  await admin.from('outside_link_settings').upsert({ user_id: profile!.auth_user_id, ask_every_link: true }, { onConflict: 'user_id' })
  await routeMonyLol(context)
  await backend.route(page)
  const funding = fundingRequests(page)
  await signIn(page, donor)
  await openSupportFromChat(page, donorServer)

  const tabs = page.getByRole('tablist').getByRole('tab')
  await expect(tabs).toHaveText(['This instance', 'Harmony development'], { timeout: 15000 })
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('support-reset')).toHaveText(/Resets [A-Z][a-z]{2} 1 \(UTC\)$/)

  await expectNoAxeViolations(page, { include: '.support-modal-overlay', label: 'Support window, this instance' })
  const instanceLink = page.getByTestId('support-links-instance').getByRole('link').first()
  const href = new URL((await instanceLink.getAttribute('href'))!)
  expect(href.searchParams.get('client_reference_id')).toBe(donor.id)

  await tabs.first().focus()
  await page.keyboard.press('ArrowRight')
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(tabs.nth(1)).toBeFocused()
  await expect(page.getByTestId('support-panel-instance')).toBeHidden()
  await expectDevelopmentTab(page)
  const panel = page.getByTestId('support-panel-project')
  for (const link of await panel.getByTestId('support-links-project').getByRole('link').all()) {
    const url = new URL((await link.getAttribute('href'))!)
    expect(url.protocol).toBe('https:')
    expect(url.searchParams.has('client_reference_id')).toBe(false)
    expect(url.searchParams.has('prefilled_email')).toBe(false)
  }
  await expectNoAxeViolations(page, { include: '.support-modal-overlay', label: 'Support window, Harmony development' })

  await test.step('the supporters link opens through "Leaving Harmony"', async () => {
    const pages = context.pages().length
    await panel.getByRole('link', { name: 'Supporters and their messages' }).click()
    await expect(leaving(page)).toBeVisible()
    await expect(leaving(page).getByTestId('outside-link-host')).toHaveText('mony.lol')
    expect(context.pages()).toHaveLength(pages)
    const popup = context.waitForEvent('page', { timeout: 15000 })
    await leaving(page).getByRole('button', { name: 'Open link' }).click()
    const opened = await popup
    await opened.waitForURL(/mony\.lol/, { timeout: 15000 })
    expect(opened.url()).toBe(DEVELOPMENT_SUPPORTERS_URL)
    await opened.close()
  })

  await page.waitForTimeout(1000)
  expect(funding).toEqual([])
  await tabs.nth(1).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('support-modal')).toBeHidden()
})

test('User settings opens the window on the development tab', async ({ page }) => {
  test.setTimeout(120_000)
  await backend.route(page)
  const funding = fundingRequests(page)
  await signIn(page, opener)
  await page.goto('/settings/account')
  await dismissAnnouncements(page)
  await page.getByTestId('settings-support-project').click({ timeout: 30000 })
  await expect(page.getByTestId('support-modal')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('support-tab-project')).toHaveAttribute('aria-selected', 'true')
  await expectDevelopmentTab(page)
  await page.waitForTimeout(1000)
  expect(funding).toEqual([])
})

test('a full-height sheet on a 375 px phone; neither tab scrolls sideways', async ({ browser }) => {
  test.setTimeout(120_000)
  // Reduced motion: the sheet is measured without BaseModal's opening slide.
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, serviceWorkers: 'block', reducedMotion: 'reduce' })
  const page = await context.newPage()
  await backend.route(page)
  await signIn(page, phone)
  // On a phone the support heart is the last entry of the server rail, in the channel drawer.
  await openChannel(page, phoneServer.id, phoneServer.generalChannelId)
  await page.getByRole('button', { name: 'Navigation menu' }).click()
  await page.locator('.funding-button').click()
  await expect(page.getByTestId('support-raised')).toBeVisible({ timeout: 15000 })
  const sheet = page.locator('.support-modal-overlay > .modal-container')
  await expect(page.getByRole('tablist')).toBeVisible({ timeout: 15000 })
  const box = (await sheet.boundingBox())!
  expect(Math.round(box.x)).toBe(0)
  expect(Math.round(box.y)).toBe(0)
  expect(Math.round(box.width)).toBe(375)
  expect(Math.round(box.height)).toBe(812)
  const overflow = () => page.evaluate(() => {
    const content = document.querySelector('.support-modal-overlay .modal-content') as HTMLElement
    const clipped = [...content.querySelectorAll<HTMLElement>('.support-panel:not([style*="display: none"]) *')]
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5)
      .map((el) => el.className || el.tagName)
    return { page: document.documentElement.scrollWidth, content: content.scrollWidth - content.clientWidth, clipped }
  })
  expect(await overflow()).toEqual({ page: 375, content: 0, clipped: [] })
  // Both tab labels fit without an ellipsis.
  for (const label of await page.locator('.support-tab__label').all()) {
    expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  }
  await page.getByTestId('support-tab-project').click()
  await expectDevelopmentTab(page)
  expect(await overflow()).toEqual({ page: 375, content: 0, clipped: [] })
  await context.close()
})

const LOOKS = [
  { skin: 'paper', theme: 'light', highContrast: false },
  { skin: 'paper', theme: 'dark', highContrast: false },
  { skin: 'skyglass', theme: 'light', highContrast: false },
  { skin: 'skyglass', theme: 'dark', highContrast: false },
  { skin: null, theme: 'light', highContrast: true },
  { skin: null, theme: 'dark', highContrast: true },
] as const

for (const look of LOOKS) {
  const name = `${look.skin ?? 'High contrast'} ${look.theme}`
  test(`${name}: both tabs read`, async ({ browser }) => {
    test.setTimeout(120_000)
    await admin.from('profiles').update({
      appearance_settings: { theme: look.theme, activeSkinId: look.skin, highContrast: look.highContrast },
    }).eq('id', styled.id)
    const page = await newPage(browser)
    await backend.route(page)
    await signIn(page, styled)
    await expect(page.locator('html')).toHaveAttribute('data-theme-type', look.theme, { timeout: 15000 })
    if (look.skin) await expect(page.locator('html')).toHaveAttribute('data-skin', look.skin, { timeout: 15000 })
    if (look.highContrast) await expect(page.locator('html')).toHaveAttribute('data-high-contrast', 'true')
    await openSupportFromSettings(page)
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(600)
    if (look.skin === 'paper') {
      const strip = await page.locator('.support-modal-overlay > .modal-container').evaluate((el) => getComputedStyle(el, '::before').height)
      expect(strip).toBe('32px')
    }
    await expectNoAxeViolations(page, { include: '.support-modal-overlay', rules: ['color-contrast'], label: `${name} instance` })
    await page.getByTestId('support-tab-project').click()
    await expect(page.getByTestId('support-links-project')).toBeVisible({ timeout: 15000 })
    await page.waitForTimeout(400)
    await expectNoAxeViolations(page, { include: '.support-modal-overlay', rules: ['color-contrast'], label: `${name} project` })
    await page.context().close()
  })
}

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  return context.newPage()
}
