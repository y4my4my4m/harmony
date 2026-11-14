// Journey: text a person may want to copy selects; app chrome does not. The design-system reset
// makes every element unselectable and selection does not inherit, so each copyable region opts
// back in with its descendants (src/assets/design-system.css).
//
//   - Inline code and a code block in a message select like the text around them.
//   - Settings text selects; a control inside settings does not.

import { test, expect, type Page, type Locator } from '@playwright/test'
import { adminClient, createUser, deleteUser, messageList, openChannel, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

const admin = adminClient()
let user: SpecUser
let server: SeededServer
const INLINE = 'npmcitoken'
const BLOCK = 'blocklinetoken'

test.beforeAll(async () => {
  user = await createUser(admin, 'seltx')
  server = await seedServer(admin, user, `Select ${user.username}`)
  const { error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId, user_id: user.id,
    content: [{ type: 'text', text: `run \`${INLINE}\` first\n\`\`\`\n${BLOCK}\n\`\`\`` }],
  })
  if (error) throw new Error(`message: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

const selection = (page: Page) => page.evaluate(() => getSelection()?.toString().trim() ?? '')

/** The text a mouse drag across `target`, start to end, selects. */
async function selectsByDrag(page: Page, target: Locator): Promise<string> {
  await page.evaluate(() => getSelection()?.removeAllRanges())
  const box = (await target.boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + 1, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 1, y, { steps: 8 })
  await page.mouse.up()
  return selection(page)
}

test('inline code and a code block in a message select', async ({ page }) => {
  test.setTimeout(90_000)
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  const inline = messageList(page).locator('code.md-code', { hasText: INLINE })
  await expect(inline).toBeVisible({ timeout: 20000 })
  expect(await selectsByDrag(page, inline)).toBe(INLINE)
  const block = messageList(page).locator('pre.code-block', { hasText: BLOCK })
  await expect(block).toBeVisible()
  expect(await selectsByDrag(page, block.getByText(BLOCK))).toBe(BLOCK)
})

test('settings text selects and its controls do not', async ({ page }) => {
  test.setTimeout(90_000)
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await page.locator('[data-region="user"] [data-action="settings"]').click()
  const content = page.locator('.settings-content')
  await expect(content).toBeVisible({ timeout: 15000 })
  // Settings move focus to their first field once shown; a selection made before that collapses.
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName ?? 'BODY'), { timeout: 10000 }).not.toBe('BODY')
  const heading = content.locator('h1, h2, h3').first()
  await expect(heading).toBeVisible()
  expect(await selectsByDrag(page, heading)).toBe((await heading.innerText()).trim())
  const button = content.locator('button').first()
  await expect(button).toBeVisible()
  expect(await button.evaluate((el) => getComputedStyle(el).userSelect)).toBe('none')
})
