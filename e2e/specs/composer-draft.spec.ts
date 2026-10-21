// Journey: the "New post" dialog keeps an unsent draft. Closing it by Escape, the close
// button or the backdrop and opening it again brings back the text, content warning,
// visibility, attachment and sensitive flag. Posting clears the draft, and so does closing
// the dialog emptied. A post moved back into the composer by "Delete and redraft" is kept
// the same way when that dialog closes.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'

const admin = adminClient()
// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
// Timeline views compile on a cold dev server's first visit.
const APP_LOAD_MS = 90_000

let writer: SpecUser

test.beforeAll(async () => {
  writer = await createUser(admin, 'cdr')
})

test.afterAll(async () => {
  await admin.from('posts').delete().eq('author_id', writer?.id ?? '')
  await deleteUser(admin, writer)
})

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Create a post' })
const editor = (page: Page) => dialog(page).locator('.rich-text-editor')
const text = async (page: Page) => (await editor(page).innerText()).replace(/\u00a0/g, ' ').trim()

async function openNewPost(page: Page) {
  await page.getByTestId('compose-btn').click()
  await expect(dialog(page)).toBeVisible({ timeout: 15000 })
  await expect(editor(page)).toBeFocused()
}

test('closing New post keeps the draft until it is posted or emptied', async ({ page }) => {
  test.setTimeout(240_000)
  const draft = `kept draft by ${writer.username}`

  await test.step('write a post with a warning, a visibility and an attachment', async () => {
    await signIn(page, writer)
    await page.goto('/social/home')
    await dismissAnnouncements(page)
    await expect(page.getByTestId('timeline-feed')).toBeVisible({ timeout: APP_LOAD_MS })

    await openNewPost(page)
    await page.keyboard.type(draft, { delay: 10 })
    await dialog(page).getByRole('button', { name: 'Content warning' }).click()
    await dialog(page).getByRole('textbox', { name: 'Content warning' }).fill('cw for the draft')
    await dialog(page).getByTestId('compose-visibility').click()
    await page.locator('[data-testid="compose-visibility-menu"] [data-visibility="unlisted"]').click()
    await dialog(page).locator('input[type="file"]').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PNG })
    await expect(dialog(page).locator('.remove-btn')).toHaveCount(1)
    await dialog(page).getByRole('button', { name: 'Mark media as sensitive' }).click()
  })

  for (const how of ['Escape', 'the close button', 'the backdrop'] as const) {
    await test.step(`closing by ${how} and opening again brings it all back`, async () => {
      if (how === 'Escape') await page.keyboard.press('Escape')
      else if (how === 'the close button') await dialog(page).getByRole('button', { name: 'Close' }).first().click()
      else await page.locator('.composer-overlay').click({ position: { x: 8, y: 8 } })
      await expect(dialog(page)).toBeHidden()

      await openNewPost(page)
      await expect.poll(() => text(page)).toBe(draft)
      await expect(dialog(page).getByRole('textbox', { name: 'Content warning' })).toHaveValue('cw for the draft')
      await expect(dialog(page).getByTestId('compose-visibility')).toHaveAccessibleName('Visibility: Unlisted')
      await expect(dialog(page).locator('.remove-btn')).toHaveCount(1)
      await expect(dialog(page).getByRole('button', { name: 'Mark media as sensitive' })).toHaveAttribute('aria-pressed', 'true')
    })
  }

  await test.step('posting clears the draft', async () => {
    // Text only: the attachment is not what this journey is about.
    await dialog(page).locator('.remove-btn').click()
    await dialog(page).getByRole('button', { name: 'Content warning' }).click()
    const written = page.waitForResponse(
      (r) => r.url().includes('/rest/v1/posts') && r.request().method() === 'POST',
      { timeout: 30000 },
    )
    await dialog(page).getByTestId('compose-submit').click()
    expect((await written).ok()).toBe(true)
    await expect(dialog(page)).toBeHidden({ timeout: 30000 })

    await openNewPost(page)
    await expect.poll(() => text(page)).toBe('')
    await expect(dialog(page).getByTestId('compose-visibility')).toHaveAccessibleName('Visibility: Public')
    await expect(dialog(page).getByRole('textbox', { name: 'Content warning' })).toHaveCount(0)
  })

  await test.step('closing the dialog emptied clears the draft', async () => {
    await page.keyboard.type('short lived', { delay: 10 })
    await page.keyboard.press('Escape')
    await openNewPost(page)
    await expect.poll(() => text(page)).toBe('short lived')
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Backspace')
    await expect.poll(() => text(page)).toBe('')
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toBeHidden()
    await openNewPost(page)
    await expect.poll(() => text(page)).toBe('')
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toBeHidden()
  })

  await test.step('a redrafted post is kept when its dialog closes', async () => {
    const posted = page.locator('[data-testid="post-item"]').filter({ hasText: draft }).first()
    await expect(posted).toBeVisible({ timeout: 30000 })
    await posted.getByRole('button', { name: 'More options' }).click()
    await page.getByRole('menu', { name: 'More options' }).getByRole('menuitem', { name: 'Delete and redraft' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete and redraft' }).click()
    await expect(dialog(page)).toBeVisible({ timeout: 30000 })
    await expect.poll(() => text(page)).toBe(draft)
    await expect(dialog(page).getByTestId('compose-visibility')).toHaveAccessibleName('Visibility: Unlisted')

    await page.keyboard.press('Escape')
    await expect(dialog(page)).toBeHidden()
    await openNewPost(page)
    await expect.poll(() => text(page)).toBe(draft)
    await expect(dialog(page).getByTestId('compose-visibility')).toHaveAccessibleName('Visibility: Unlisted')
  })
})
