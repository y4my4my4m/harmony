// Journey: a donor's message, end to end. The donor writes it in the Support window and opens
// the Stripe link, whose page carries their profile id; a signed checkout.session.completed for
// that profile credits the donation and attaches the message. Back on the page the window thanks
// them and shows the message waiting for approval. Other members and the sign-in page see
// nothing until an admin approves it in the funding admin; then both show it.
// Messages are text: markup, a javascript: URL, a mention and a shortcode show as typed, with no
// element made from them, no dialog and no page error; a bidi override and a Zalgo run are
// refused by the window and by the database. An admin hides a message and it leaves both places;
// turning off "Show approved messages on the sign-in page" empties the strip there.
// A checkout of a Harmony development Payment Link is answered and ignored: no donation, no
// pending donation, and the donor's message stays unattached.

import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, seedServer, signIn, userClient, type SeededServer, type SpecUser } from './harness'
import { startBackend, type Backend } from './backend'
import { DEVELOPMENT_PLINKS, enableFunding, openSupportFromChat, openSupportFromSettings, postStripeCheckout } from './funding'
import { expectNoAxeViolations } from './a11y'

test.use({ serviceWorkers: 'block' })

const admin = adminClient()

// A run tag keeps each body unique across retries; every body stays within 50 characters.
const TAG = Math.random().toString(36).slice(2, 6)
const IMG = `<img src=x onerror="window.__xss=1"> ${TAG}`
const OTHERS = [
  `<script>window.__xss=2</script> ${TAG}`,
  `javascript:window.__xss=3 ${TAG}`,
  `@everyone thanks @admin ${TAG}`,
  `:blob: :heart: thanks ${TAG}`,
]
const BIDI = 'gift \u202eexe.txt'
const ZALGO = 'Z\u0351\u0353\u036b\u0354\u0355 hi'

let backend: Backend
let donor: SpecUser
let viewer: SpecUser
let staff: SpecUser
let donorServer: SeededServer

test.beforeAll(async () => {
  test.setTimeout(120_000)
  backend = await startBackend()
  donor = await createUser(admin, 'donor')
  viewer = await createUser(admin, 'donorv')
  staff = await createUser(admin, 'donora')
  await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  donorServer = await seedServer(admin, donor, `Donor ${donor.username}`)
  await enableFunding(admin, { messagesPublic: true })
})

test.afterAll(async () => {
  await backend?.stop()
  for (const user of [donor, viewer, staff]) await deleteUser(admin, user)
})

interface Watched { page: Page; context: BrowserContext; problems: string[] }

/** A page that records dialogs (dismissed) and uncaught errors, routed to the backend. */
async function watchedPage(browser: Browser): Promise<Watched> {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  const problems: string[] = []
  page.on('dialog', (dialog) => { problems.push(`dialog: ${dialog.message()}`); void dialog.dismiss() })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  await backend.route(page)
  return { page, context, problems }
}

/** No element anywhere carries an event-handler attribute, and none of the payloads ran. */
async function expectNothingInjected(page: Page) {
  const state = await page.evaluate(() => ({
    handlers: document.querySelectorAll('[onerror], [onload], [onclick]').length,
    scripts: [...document.querySelectorAll('script')].filter((s) => s.textContent?.includes('__xss')).length,
    xss: (window as unknown as { __xss?: number }).__xss ?? null,
  }))
  expect(state).toEqual({ handlers: 0, scripts: 0, xss: null })
}

async function attachViaWebhook(body: string) {
  const client = await userClient(donor)
  const { error } = await client.rpc('set_supporter_message', { p_body: body, p_anonymous: false })
  if (error) throw new Error(`set_supporter_message: ${error.message}`)
  const res = await postStripeCheckout(backend.url, donor.id)
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ success: true, status: 'recorded' })
}

async function messageIdOf(body: string): Promise<string> {
  const { data, error } = await admin.from('instance_supporter_messages').select('id').eq('body', body).single()
  if (error || !data) throw new Error(`message ${body}: ${error?.message}`)
  return data.id
}

async function landingBodies(browser: Browser): Promise<{ bodies: string[]; names: string[]; problems: string[]; page: Page; context: BrowserContext }> {
  const w = await watchedPage(browser)
  await w.page.goto('/login')
  await expect(w.page.getByTestId('auth-email')).toBeVisible({ timeout: 30000 })
  await w.page.waitForTimeout(1500)
  const bodies: string[] = []
  const names: string[] = []
  const strip = w.page.getByTestId('supporter-strip')
  if (await strip.isVisible()) {
    for (let i = 0; i < 8; i++) {
      const body = w.page.getByTestId('supporter-strip-body')
      await expect(body).toBeVisible()
      expect(await body.evaluate((el) => el.children.length)).toBe(0)
      const text = (await body.textContent()) ?? ''
      if (bodies.includes(text)) break
      bodies.push(text)
      names.push((await w.page.getByTestId('supporter-strip-name').textContent()) ?? '')
      const next = w.page.getByTestId('supporter-strip-next')
      if (!(await next.isVisible())) break
      await next.click()
      await expect(w.page.getByTestId('supporter-strip-body')).not.toHaveText(text, { timeout: 5000 })
    }
  }
  return { bodies, names, problems: w.problems, page: w.page, context: w.context }
}

test('a checkout of a Harmony development link records nothing here', async () => {
  const dev = await createUser(admin, 'donordev')
  try {
    const client = await userClient(dev)
    const { error } = await client.rpc('set_supporter_message', { p_body: `for Harmony ${TAG}`, p_anonymous: false })
    if (error) throw new Error(`set_supporter_message: ${error.message}`)
    for (const link of DEVELOPMENT_PLINKS) {
      const res = await postStripeCheckout(backend.url, dev.id, 700, link)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ success: true, status: 'ignored', reason: expect.stringContaining('Harmony development fund') })
    }
    const { data: donations } = await admin.from('instance_donation_history').select('id').eq('user_id', dev.id)
    expect(donations).toEqual([])
    const { data: pending } = await admin.from('instance_pending_donations').select('id').eq('raw_payload->>client_reference_id', dev.id)
    expect(pending).toEqual([])
    const { data: messages } = await admin.from('instance_supporter_messages').select('donation_id').eq('user_id', dev.id)
    expect(messages).toEqual([{ donation_id: null }])
  } finally {
    await deleteUser(admin, dev)
  }
})

test('a donor message: written, credited by the webhook, approved, shown as text', async ({ browser }) => {
  test.setTimeout(300_000)

  await test.step('the donor writes the message; bidi and Zalgo are refused', async () => {
    const { page, context, problems } = await watchedPage(browser)
    await context.route('https://buy.stripe.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>Stripe</title>paid' }))
    await signIn(page, donor)
    await openSupportFromChat(page, donorServer)
    await page.getByTestId('support-message-toggle').click()
    const input = page.getByTestId('support-message-input')

    await input.fill(BIDI)
    await expect(page.getByTestId('support-message-error')).toHaveText("Text direction marks can't be used.")
    await input.fill(ZALGO)
    await expect(page.getByTestId('support-message-error')).toHaveText('Too many accents on one character.')

    await input.fill(IMG)
    await expect(page.getByTestId('support-message-error')).toHaveCount(0)
    const saved = page.waitForResponse((r) => r.url().endsWith('/rpc/set_supporter_message') && r.status() === 200)
    const popupOpened = page.waitForEvent('popup')
    await page.getByTestId('support-links-instance').getByRole('link').first().click()
    const popup = await popupOpened
    await saved
    expect(new URL(popup.url()).searchParams.get('client_reference_id')).toBe(donor.id)

    const credited = await postStripeCheckout(backend.url, donor.id)
    expect(await credited.json()).toMatchObject({ success: true, status: 'recorded' })
    await popup.close()

    // Back on the page: the donation shows, and with it the thanks and the attached message.
    await page.bringToFront()
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await expect(page.getByTestId('support-thanks')).toBeVisible({ timeout: 30000 })
    const own = page.getByTestId('supporter-message-own')
    await expect(own).toHaveCount(1)
    await expect(own.getByTestId('supporter-message-body')).toHaveText(IMG)
    await expect(own).toContainText('Waiting for approval')
    await expectNothingInjected(page)
    expect(problems).toEqual([])
    await context.close()
  })

  await test.step('the database refuses bidi and Zalgo past the window', async () => {
    const client = await userClient(donor)
    for (const body of [BIDI, ZALGO, 'x'.repeat(51), 'two\nlines']) {
      const { error } = await client.rpc('set_supporter_message', { p_body: body, p_anonymous: false })
      expect(error?.code, body).toBe('22023')
    }
  })

  await test.step('four more messages, each with its own donation', async () => {
    for (const body of OTHERS) await attachViaWebhook(body)
  })

  await test.step('nothing shows to others before approval', async () => {
    const { page, context } = await watchedPage(browser)
    await signIn(page, viewer)
    await openSupportFromSettings(page)
    await expect(page.getByTestId('supporter-wall-instance')).toBeVisible()
    for (const body of [IMG, ...OTHERS]) {
      await expect(page.getByTestId('supporter-message-body').filter({ hasText: body })).toHaveCount(0)
    }
    await context.close()
    const landing = await landingBodies(browser)
    expect(landing.bodies.filter((b) => [IMG, ...OTHERS].includes(b))).toEqual([])
    await landing.context.close()
  })

  await test.step('an admin approves them in the funding admin', async () => {
    const { page, context } = await watchedPage(browser)
    await signIn(page, staff)
    await page.goto('/admin?tab=funding')
    const queue = page.getByTestId('admin-supporter-messages')
    await expect(queue).toBeVisible({ timeout: 30000 })
    await expect(queue.getByTestId('admin-supporter-messages-awaiting')).toBeVisible()
    // Each queue row is a laid-out card: its meta items are spaced apart, not run together.
    const first = queue.getByTestId('admin-supporter-message').first()
    expect(await first.evaluate((el) => getComputedStyle(el).display)).toBe('flex')
    expect(await first.locator('.admin-message__meta').evaluate((el) => getComputedStyle(el).columnGap)).not.toBe('normal')
    for (const body of [IMG, ...OTHERS]) {
      const row = queue.getByTestId('admin-supporter-message').filter({ has: page.getByTestId('admin-supporter-message-body').getByText(body, { exact: true }) })
      await expect(row).toHaveAttribute('data-review', 'pending')
      await row.getByTestId('admin-supporter-message-approve').click()
      await expect(row).toHaveAttribute('data-review', 'approved')
    }
    await context.close()
  })

  await test.step('members and the sign-in page show them as typed', async () => {
    const { page, context, problems } = await watchedPage(browser)
    await signIn(page, viewer)
    await openSupportFromSettings(page)
    const wall = page.getByTestId('supporter-wall-instance')
    if (await wall.getByTestId('supporter-wall-more').isVisible()) await wall.getByTestId('supporter-wall-more').click()
    for (const body of [IMG, ...OTHERS]) {
      const shown = wall.getByTestId('supporter-message-body').filter({ hasText: body })
      await expect(shown).toHaveCount(1)
      await expect(shown).toHaveText(body)
      expect(await shown.evaluate((el) => el.children.length)).toBe(0)
    }
    const named = wall.getByTestId('supporter-message').filter({ has: page.getByTestId('supporter-message-body').getByText(IMG, { exact: true }) })
    await expect(named.getByTestId('supporter-message-name')).toHaveText(donor.displayName)
    // A body is clipped to two lines, a name to one: no glyph run reaches outside its row.
    const clip = await named.getByTestId('supporter-message-body').evaluate((el) => {
      const cs = getComputedStyle(el)
      return { overflow: cs.overflow, clamp: cs.webkitLineClamp, contain: cs.contain }
    })
    expect(clip).toEqual({ overflow: 'hidden', clamp: '2', contain: 'paint' })
    expect(await named.getByTestId('supporter-message-name').evaluate((el) => {
      const cs = getComputedStyle(el)
      return [cs.whiteSpace, cs.overflow, cs.textOverflow]
    })).toEqual(['nowrap', 'hidden', 'ellipsis'])
    await expectNothingInjected(page)
    expect(problems).toEqual([])
    await context.close()

    const landing = await landingBodies(browser)
    expect([...landing.bodies].sort()).toEqual(expect.arrayContaining([IMG, ...OTHERS].sort()))
    expect(landing.names[landing.bodies.indexOf(IMG)]).toBe(donor.displayName)
    expect(await landing.page.getByTestId('supporter-strip-body').evaluate((el) => {
      const cs = getComputedStyle(el)
      return [cs.overflow, cs.textOverflow, getComputedStyle(el.parentElement!).whiteSpace]
    })).toEqual(['hidden', 'ellipsis', 'nowrap'])
    await expectNothingInjected(landing.page)
    await expectNoAxeViolations(landing.page, { include: '[data-testid="supporter-strip"]', label: 'sign-in supporter strip' })
    expect(landing.problems).toEqual([])
    await landing.context.close()
  })

  await test.step('an admin hides one; it leaves the window and the sign-in page', async () => {
    const { page, context } = await watchedPage(browser)
    await signIn(page, staff)
    await openSupportFromSettings(page)
    const wall = page.getByTestId('supporter-wall-instance')
    if (await wall.getByTestId('supporter-wall-more').isVisible()) await wall.getByTestId('supporter-wall-more').click()
    const row = wall.getByTestId('supporter-message').filter({ has: page.getByTestId('supporter-message-body').getByText(IMG, { exact: true }) })
    await row.getByTestId('supporter-message-hide').click()
    await expect(row).toHaveCount(0)
    await context.close()
    const { data } = await admin.from('instance_supporter_messages').select('review').eq('id', await messageIdOf(IMG)).single()
    expect(data?.review).toBe('hidden')

    const landing = await landingBodies(browser)
    expect(landing.bodies).not.toContain(IMG)
    expect(landing.bodies.length).toBeGreaterThan(0)
    await landing.context.close()
  })

  await test.step('the sign-in strip has an off switch', async () => {
    const { page, context } = await watchedPage(browser)
    await signIn(page, staff)
    await page.goto('/admin?tab=funding')
    const toggle = page.getByTestId('admin-supporter-messages-public')
    await expect(toggle).toBeChecked({ timeout: 30000 })
    // The checkbox is drawn as a slider; its label takes the click.
    await page.locator('label.toggle-label', { has: toggle }).click()
    await expect(toggle).not.toBeChecked()
    await page.locator('.funding-module .save-btn').click()
    await expect(page.locator('.funding-module .save-btn')).toBeDisabled({ timeout: 15000 })
    await context.close()

    const landing = await landingBodies(browser)
    await expect(landing.page.getByTestId('supporter-strip')).toHaveCount(0)
    expect(landing.bodies).toEqual([])
    await landing.context.close()
  })
})
