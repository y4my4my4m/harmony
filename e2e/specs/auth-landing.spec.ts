// Journey: the signed-out landing. The art is a real image served from
// public/backgrounds/login and stays the same between Log in and Register; the
// card names the instance being signed in to; the mascot ducks behind the card
// while a hidden password is typed and peeks while it is shown; on a phone the
// art becomes a banner above the form. The password reset page shares the shell.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
let member: SpecUser

test.beforeAll(async () => {
  member = await createUser(admin, 'landing')
})

test.afterAll(async () => {
  await deleteUser(admin, member)
})

async function artLoaded(page: Page): Promise<string> {
  const img = page.getByTestId('auth-art-img')
  await expect(img).toHaveAttribute('src', /^\/backgrounds\/login\/[^/]+\.(webp|avif|png|jpe?g)$/, { timeout: 30000 })
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 15000 }).toBeGreaterThan(0)
  await expect(page.getByTestId('auth-art')).toHaveClass(/is-loaded/)
  return (await img.getAttribute('src'))!
}

test('login art is an image, kept for Register, and the card names the instance', async ({ page, baseURL }) => {
  await page.goto('/login')
  await expect(page.getByTestId('auth-email')).toBeVisible({ timeout: 30000 })

  const src = await artLoaded(page)
  const response = await page.request.get(src)
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toMatch(/^image\//)

  await expect(page.getByTestId('auth-instance')).toContainText(new URL(baseURL!).host)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'Welcome back' })).toBeVisible()

  await page.getByTestId('auth-switch-mode').click()
  await expect(page).toHaveURL(/\/register$/)
  await expect(page.getByRole('heading', { level: 2, name: 'Create an account' })).toBeVisible()
  expect(await artLoaded(page)).toBe(src)
})

async function expectPose(page: Page, pose: string) {
  const mascot = page.getByTestId('auth-mascot')
  await expect(mascot).toHaveAttribute('data-pose', pose)
  await expect(mascot.locator('img.is-shown')).toHaveAttribute('src', `/mascot/${pose}.webp`)
}

test('the mascot hides from a hidden password, peeks at a shown one, is sorry after a rejected sign-in', async ({ page }) => {
  await page.goto('/login')
  const mascot = page.getByTestId('auth-mascot')
  const password = page.getByTestId('auth-password')
  await expect(password).toBeVisible({ timeout: 30000 })

  await expectPose(page, 'idle')
  await expect(mascot).toHaveAttribute('aria-hidden', 'true')
  const poses = mascot.locator('img')
  await expect(poses).toHaveCount(4)
  for (const img of await poses.all()) {
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 15000 }).toBeGreaterThan(0)
  }

  await password.focus()
  await expectPose(page, 'hide')

  await password.fill('correct horse')
  await page.getByTestId('auth-password-toggle').click()
  await expect(password).toHaveAttribute('type', 'text')
  await expectPose(page, 'peek')

  await page.getByTestId('auth-password-toggle').click()
  await password.focus()
  await expectPose(page, 'hide')

  await page.getByTestId('auth-email').focus()
  await expectPose(page, 'idle')

  await page.getByTestId('auth-email').fill(member.email)
  const answered = page.waitForResponse((r) => r.url().includes('/auth/v1/token'))
  await page.getByTestId('auth-submit').click()
  await answered
  await expect(page.getByTestId('auth-form-error')).not.toBeEmpty()
  await expectPose(page, 'oops')

  await page.getByTestId('auth-email').pressSequentially('x')
  await expectPose(page, 'idle')
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the art is a banner above the form, the mascot on the sheet edge', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByTestId('auth-email')).toBeVisible({ timeout: 30000 })
    await artLoaded(page)

    const art = (await page.getByTestId('auth-art').boundingBox())!
    const card = (await page.getByTestId('auth-form').locator('xpath=ancestor::div[contains(@class,"auth-card")]').boundingBox())!
    const mascot = (await page.getByTestId('auth-mascot').boundingBox())!

    expect(art.width).toBeGreaterThan(300)
    expect(art.height).toBeGreaterThanOrEqual(200)
    expect(card.y).toBeGreaterThan(art.y)
    expect(card.y).toBeLessThan(art.y + art.height)
    // The mascot box ends at the card's padding edge, inside its 1px top border.
    expect(Math.abs(mascot.y + mascot.height - card.y)).toBeLessThanOrEqual(2)
  })
})

test('the password reset page has the same art, instance and mascot', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  const { data, error } = await admin.auth.admin.generateLink({
    type: 'recovery',
    email: member.email,
    options: { redirectTo: `${baseURL}/reset-password` },
  })
  if (error || !data?.properties?.action_link) throw new Error(`recovery link: ${error?.message}`)
  // The stack's GoTrue reports its external URL without the gateway's /auth/v1 prefix.
  const link = new URL(data.properties.action_link)
  link.pathname = '/auth/v1/verify'
  await page.goto(link.toString())
  await expect(page.getByRole('heading', { level: 2, name: 'Reset your password' })).toBeVisible({ timeout: 30000 })

  await artLoaded(page)
  await expect(page.getByTestId('auth-instance')).toContainText(new URL(baseURL!).host)

  const fresh = page.getByLabel('New password', { exact: true })
  const confirm = page.getByLabel('Confirm new password', { exact: true })
  await expectPose(page, 'idle')
  await fresh.focus()
  await expectPose(page, 'hide')
  await confirm.focus()
  await expectPose(page, 'hide')
  await fresh.fill('new-password-12345')
  await page.getByRole('button', { name: 'Show new password' }).click()
  await expectPose(page, 'peek')
  await page.getByRole('button', { name: 'Show new password' }).click()
  await confirm.fill('different-password')
  await page.keyboard.press('Enter')
  await expect(confirm).toHaveAttribute('aria-invalid', 'true')
  await page.getByRole('heading', { level: 2, name: 'Reset your password' }).click()
  await expectPose(page, 'oops')
})

test('an invalid reset link gets the sorry mascot', async ({ page }) => {
  await page.goto('/reset-password')
  await expect(page.getByRole('heading', { level: 2, name: 'Invalid or expired link' })).toBeVisible({ timeout: 30000 })
  await expectPose(page, 'oops')
})

test.describe('short window', () => {
  test.use({ viewport: { width: 1280, height: 600 } })

  test('the footer sits under the card and links the service status page', async ({ page }) => {
    await page.goto('/register')
    await expect(page.getByTestId('auth-email')).toBeVisible({ timeout: 30000 })
    const card = (await page.getByTestId('auth-form').locator('xpath=ancestor::div[contains(@class,"auth-card")]').boundingBox())!
    const footer = (await page.locator('.auth-footer').boundingBox())!
    expect(footer.y).toBeGreaterThanOrEqual(card.y + card.height)
    // VITE_STATUS_URL from e2e/stack.env.
    await expect(page.getByTestId('auth-status-link')).toHaveAttribute('href', 'https://status.example.test')
    await expect(page.getByTestId('auth-status-link')).toHaveText('Service status')
  })
})

test('Settings links the service status page', async ({ page }) => {
  await signIn(page, member)
  await page.goto('/settings/appearance')
  await expect(page.getByTestId('settings-status-link')).toHaveAttribute('href', 'https://status.example.test', { timeout: 30000 })
})
