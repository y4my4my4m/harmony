// Journey: a member keeps files in Drive. Uploads land in My Drive with their names; a
// folder takes a file by Move and opens from the list; search finds a file by part of its
// name; Move to trash and Restore round-trip through the Trash view. General access set to
// Anyone with the link opens the file's /d/<token> for a reader with no account, who sees the
// name and the image itself through the backend's link route.
//
// The link page fetches its bytes from /api/federation/drive/link/<token>, a 302 to a signed
// storage URL; the backend from ./backend.ts answers it.

import { test, expect, type Page } from '@playwright/test'
import { startBackend, type Backend } from './backend'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
const IMAGE = 'sunset.png'
const NOTES = 'trip-notes-2026.txt'
const FOLDER = 'Holidays'

const admin = adminClient()
let user: SpecUser
let backend: Backend

test.beforeAll(async () => {
  // Starts the federation backend under tsx: past 30 s on a loaded CI runner.
  test.setTimeout(120_000)
  user = await createUser(admin, 'drive')
  backend = await startBackend()
})

test.afterAll(async () => {
  await backend?.stop()
  await deleteUser(admin, user)
})

const files = (page: Page) => page.getByTestId('drive-items').getByTestId('drive-file')
const file = (page: Page, name: string) => files(page).filter({ hasText: name })

test('upload, file away, search, trash and share a link', async ({ page, browser }) => {
  test.setTimeout(180_000)
  await signIn(page, user)

  await test.step('the rail opens an empty Drive', async () => {
    await page.getByTestId('rail-drive').click()
    await expect(page).toHaveURL(/\/drive/)
    await dismissAnnouncements(page)
    await expect(page.getByTestId('drive-empty')).toBeVisible({ timeout: 30000 })
    await page.getByTestId('drive-layout-list').click()
  })

  await test.step('uploaded files appear under their names and count toward usage', async () => {
    await page.getByTestId('drive-file-input').setInputFiles([
      { name: IMAGE, mimeType: 'image/png', buffer: PNG },
      { name: NOTES, mimeType: 'text/plain', buffer: Buffer.from('ferry at 9, bring snacks\n') },
    ])
    await expect(file(page, IMAGE)).toBeVisible({ timeout: 30000 })
    await expect(file(page, NOTES)).toBeVisible()
    await expect(page.getByTestId('drive-usage')).not.toContainText(/^0 B/)
  })

  await test.step('a new folder takes a file by Move and opens from the list', async () => {
    await page.getByTestId('drive-new-folder').click()
    await page.getByTestId('drive-name-input').fill(FOLDER)
    await page.keyboard.press('Enter')
    const folder = page.getByTestId('drive-folder').filter({ hasText: FOLDER })
    await expect(folder).toBeVisible()

    await file(page, IMAGE).click({ button: 'right' })
    // A menu panel: every item is a full-width row, stacked.
    const items = page.getByTestId('drive-file-menu').getByRole('menuitem')
    const boxes = await items.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as DOMRect))
    expect(boxes.length).toBeGreaterThan(4)
    boxes.slice(1).forEach((box, i) => {
      expect(box.y).toBeGreaterThanOrEqual(boxes[i].y + boxes[i].height - 1)
      expect(Math.abs(box.x - boxes[0].x)).toBeLessThan(2)
      expect(Math.abs(box.width - boxes[0].width)).toBeLessThan(2)
    })
    await page.getByTestId('drive-file-menu').getByRole('menuitem', { name: 'Move', exact: true }).click()
    const dialog = page.getByTestId('drive-move-dialog')
    await dialog.getByTestId('drive-move-folder').filter({ hasText: FOLDER }).click()
    await page.getByRole('button', { name: 'Move here' }).click()
    await expect(file(page, IMAGE)).toHaveCount(0)

    await folder.dblclick()
    await expect(page.getByRole('heading', { level: 1, name: FOLDER })).toBeVisible()
    await expect(file(page, IMAGE)).toBeVisible()
  })

  await test.step('search finds a file by part of its name, in any folder', async () => {
    await page.getByTestId('drive-search').fill('notes')
    await expect(file(page, NOTES)).toBeVisible({ timeout: 15000 })
    await expect(files(page)).toHaveCount(1)
    await page.getByTestId('drive-search').fill('')
  })

  await test.step('Move to trash and Restore round-trip through Trash', async () => {
    await page.getByTestId('drive-nav-root').click()
    await file(page, NOTES).click()
    await expect(page.getByTestId('drive-details-name')).toContainText(NOTES)
    await page.getByTestId('drive-details-delete').click()
    await expect(file(page, NOTES)).toHaveCount(0)

    await page.getByTestId('drive-nav-trash').click()
    await expect(file(page, NOTES)).toBeVisible()
    await file(page, NOTES).click({ button: 'right' })
    await page.getByTestId('drive-file-menu').getByRole('menuitem', { name: 'Restore', exact: true }).click()
    await expect(file(page, NOTES)).toHaveCount(0)

    await page.getByTestId('drive-nav-root').click()
    await expect(file(page, NOTES)).toBeVisible()
  })

  let link = ''
  await test.step('Anyone with the link opens the /d/ address to everyone', async () => {
    await page.getByTestId('drive-folder').filter({ hasText: FOLDER }).dblclick()
    await file(page, IMAGE).click()
    await page.getByTestId('drive-share-open').click()
    const dialog = page.getByTestId('drive-share-dialog')
    await expect(dialog.getByTestId('drive-link-url')).toHaveValue(/\/d\/[A-Za-z0-9_-]+$/)
    link = await dialog.getByTestId('drive-link-url').inputValue()
    await dialog.getByTestId('drive-link-access').selectOption('anyone')
    await expect(dialog.getByTestId('drive-link-show-owner')).toBeVisible()
    await expect(dialog.getByTestId('drive-link-url')).toHaveValue(link)
  })

  await test.step('a reader with no account sees the file behind the link', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    try {
      const reader = await context.newPage()
      await backend.route(reader)
      await reader.goto(new URL(link).pathname)
      await expect(reader.getByTestId('drive-link-name')).toHaveText(IMAGE, { timeout: 30000 })
      const image = reader.getByRole('img', { name: IMAGE })
      await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), { timeout: 15000 }).toBe(1)
      await expect(reader.getByTestId('drive-link-download')).toHaveAttribute('href', /\/api\/federation\/drive\/link\/[^/]+\?download=1$/)
    } finally {
      await context.close()
    }
  })
})
