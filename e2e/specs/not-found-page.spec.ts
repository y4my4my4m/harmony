// Journey: an address that matches no route. Signed out it lands on /404-public with Sign in as
// the way forward, signed in on /404 with the app home; either way the heading, the art and the
// actions sit inside the first viewport on a desktop and on a phone, nothing scrolls sideways,
// and the address that matched nothing is shown. Go back appears after an in-app navigation.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
let member: SpecUser

test.beforeAll(async () => {
  member = await createUser(admin, 'notfound')
})

test.afterAll(async () => {
  await deleteUser(admin, member)
})

const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 390, height: 844 },
} as const

const MISSING = '/no/such/page-here'

/** Bounding box of `testId` lies fully inside the viewport without scrolling. */
async function expectInFirstViewport(page: Page, testId: string) {
  const box = await page.getByTestId(testId).boundingBox()
  const viewport = page.viewportSize()!
  expect(box, testId).not.toBeNull()
  expect(box!.y, `${testId} top`).toBeGreaterThanOrEqual(0)
  expect(box!.x, `${testId} left`).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height, `${testId} bottom`).toBeLessThanOrEqual(viewport.height)
  expect(box!.x + box!.width, `${testId} right`).toBeLessThanOrEqual(viewport.width)
}

async function expectPage(page: Page, primary: { name: string; href: string }) {
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible({ timeout: 30000 })
  const action = page.getByTestId('not-found-primary')
  await expect(action).toHaveText(primary.name)
  await expect(action).toHaveAttribute('href', primary.href)
  await expect(page.getByTestId('not-found-path')).toContainText(MISSING)

  const img = page.getByTestId('not-found-img')
  await expect(img).toHaveAttribute('src', /^\/backgrounds\/404\/[^/]+\.(webp|avif|png|jpe?g)$/)
  await expect(img).toHaveAttribute('alt', '')
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 15000 }).toBeGreaterThan(0)
  await expect(img).toHaveClass(/is-loaded/)

  for (const id of ['not-found-art', 'not-found-primary', 'not-found-path']) await expectInFirstViewport(page, id)
  const heading = await page.getByRole('heading', { level: 1 }).boundingBox()
  expect(heading!.y + heading!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
}

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  test.describe(`${name} ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport })

    test('signed out: Sign in leads on, everything above the fold', async ({ page }) => {
      await page.goto(MISSING)
      await expect(page).toHaveURL(/\/404-public$/)
      await expectPage(page, { name: 'Sign in', href: '/login' })
      await expect(page.getByTestId('not-found-back')).toHaveCount(0)

      await page.getByTestId('not-found-primary').click()
      await expect(page).toHaveURL(/\/login$/)
    })

    test('signed in: Go home leads on, everything above the fold', async ({ page }) => {
      await signIn(page, member)
      await page.goto(MISSING)
      await expect(page).toHaveURL(/\/404$/)
      await expectPage(page, { name: 'Go home', href: '/chat' })

      await page.getByTestId('not-found-primary').click()
      await expect(page).toHaveURL(/\/chat/)
    })
  })
}

test('Go back returns to the page an in-app link left', async ({ page }) => {
  await signIn(page, member)
  const from = new URL(page.url()).pathname
  await page.evaluate((to) => {
    const app = (document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $router: { push: (to: string) => Promise<unknown> } } } }
    }).__vue_app__
    return app.config.globalProperties.$router.push(to)
  }, MISSING)
  await expect(page).toHaveURL(/\/404$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible()

  await page.getByTestId('not-found-back').click()
  await expect(page).toHaveURL((url) => url.pathname === from)
})
