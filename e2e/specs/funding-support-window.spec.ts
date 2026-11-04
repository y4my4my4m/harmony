// Journey: the Support window. On a self-hosted instance it has two tabs, "This instance" and
// "Harmony development": the instance's Stripe link carries the donor's profile id; the
// project's links come from this instance's backend (the project's feed is unreachable here, so
// its built-in links, said so) and carry none. Arrow keys move between the tabs. On the
// project's own instance the window is one view. On a 375 px phone it is a full-height sheet with
// no sideways scroll. In Paper, Skyglass and High contrast, light and dark, its text passes axe
// color-contrast and Paper draws its window strip.

import { test, expect, type Browser, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, openChannel, seedServer, signIn, type SeededServer, type SpecUser } from './harness'
import { startBackend, type Backend } from './backend'
import { enableFunding, openSupportFromChat, openSupportFromSettings } from './funding'
import { expectNoAxeViolations } from './a11y'

test.use({ serviceWorkers: 'block' })

const admin = adminClient()
// Unresolvable (RFC 6761 .invalid): the backend's read of the project feed fails at once.
const UNREACHABLE_FEED = 'https://funding.e2e.invalid/api/federation/funding/public'

test.describe('on a self-hosted instance', () => {
  let backend: Backend
  let donor: SpecUser
  let phone: SpecUser
  let styled: SpecUser
  let donorServer: SeededServer
  let phoneServer: SeededServer

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    backend = await startBackend({ PROJECT_FUNDING_URL: UNREACHABLE_FEED, PROJECT_INSTANCE: 'auto' })
    donor = await createUser(admin, 'supwin')
    phone = await createUser(admin, 'supwinp')
    styled = await createUser(admin, 'supwins')
    donorServer = await seedServer(admin, donor, `Support ${donor.username}`)
    phoneServer = await seedServer(admin, phone, `Support ${phone.username}`)
    await enableFunding(admin)
  })

  test.afterAll(async () => {
    await backend?.stop()
    await deleteUser(admin, donor)
    await deleteUser(admin, phone)
    await deleteUser(admin, styled)
  })

  test('two tabs: the instance links credit the donor, the project links do not', async ({ page }) => {
    test.setTimeout(120_000)
    await backend.route(page)
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
    const panel = page.getByTestId('support-panel-project')
    await expect(panel).toBeVisible()
    await expect(page.getByTestId('support-panel-instance')).toBeHidden()
    await expect(panel.getByTestId('support-project-fallback')).toBeVisible({ timeout: 15000 })
    const projectLinks = panel.getByTestId('support-links-project').getByRole('link')
    await expect(projectLinks.first()).toBeVisible()
    for (const link of await projectLinks.all()) {
      const url = new URL((await link.getAttribute('href'))!)
      expect(url.protocol).toBe('https:')
      expect(url.searchParams.has('client_reference_id')).toBe(false)
      expect(url.searchParams.has('prefilled_email')).toBe(false)
    }

    await expectNoAxeViolations(page, { include: '.support-modal-overlay', label: 'Support window, Harmony development' })
    await page.keyboard.press('ArrowLeft')
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('support-modal')).toBeHidden()
  })

  test('a full-height sheet on a 375 px phone', async ({ browser }) => {
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
    const overflow = await page.evaluate(() => {
      const content = document.querySelector('.support-modal-overlay .modal-content') as HTMLElement
      return { page: document.documentElement.scrollWidth, content: content.scrollWidth - content.clientWidth }
    })
    expect(overflow.page).toBeLessThanOrEqual(375)
    expect(overflow.content).toBe(0)
    // Both tab labels fit without an ellipsis.
    for (const label of await page.locator('.support-tab__label').all()) {
      expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    }
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
})

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  return context.newPage()
}

test.describe('on the project instance', () => {
  let backend: Backend
  let member: SpecUser

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    backend = await startBackend({ PROJECT_FUNDING_URL: UNREACHABLE_FEED, PROJECT_INSTANCE: 'true' })
    member = await createUser(admin, 'supproj')
    await enableFunding(admin)
  })

  test.afterAll(async () => {
    await backend?.stop()
    await deleteUser(admin, member)
  })

  test('one view, no tabs', async ({ page }) => {
    test.setTimeout(120_000)
    await backend.route(page)
    await signIn(page, member)
    await openSupportFromSettings(page)
    await expect(page.getByTestId('support-project-instance')).toBeVisible({ timeout: 15000 })
    await expect(page.getByRole('dialog')).toHaveAccessibleName('Support Harmony')
    await expect(page.getByRole('tablist')).toHaveCount(0)
    await expect(page.getByTestId('support-panel-project')).toHaveCount(0)
    const link = page.getByTestId('support-links-instance').getByRole('link').first()
    expect(new URL((await link.getAttribute('href'))!).searchParams.get('client_reference_id')).toBe(member.id)
  })
})
