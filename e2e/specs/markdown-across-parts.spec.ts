// Journey: inline markdown spans the links, mentions and emoji inside it. A message is stored
// as parts (text, link, mention, ...); each text part rendered on its own, so
// `**bold https://x.com still bold**` and `**[a](url)**` showed their `**`, and a spoiler around a
// mention showed everything. The text parts render as one run now: both halves are bold, the
// link sits inside the bold, a spoiler covers the mention and reveals as one. Stored content
// is unchanged.

import { test, expect, type Page } from '@playwright/test'
import {
  addChannel,
  adminClient,
  composer,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let user: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  user = await createUser(admin, 'mdrun')
  server = await seedServer(admin, user, `Runs ${user.username.slice(-6)}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

let channel = ''
test.beforeEach(async ({ page: _page }, info) => {
  channel = await addChannel(admin, server, `m${info.testId.slice(0, 6)}${info.repeatEachIndex}${info.retry}`)
})

async function seed(content: unknown[]): Promise<void> {
  const { error } = await admin.from('messages').insert({ channel_id: channel, user_id: user.id, content })
  if (error) throw new Error(`message: ${error.message}`)
}

async function open(page: Page) {
  await signIn(page, user)
  await openChannel(page, server.id, channel)
  await dismissAnnouncements(page)
}

const row = (page: Page, text: string) => messageList(page).locator('.message-item').filter({ hasText: text })
const weight = (page: Page, selector: string, text: string) =>
  row(page, text).locator(selector).first().evaluate((el) => Number(getComputedStyle(el).fontWeight))

test('bold spans a link and a masked link; no markers show', async ({ page }) => {
  await seed([
    { type: 'text', text: '**bold ' },
    { type: 'url', url: 'https://example.com/a', preview: false },
    { type: 'text', text: ' still bold**' },
  ])
  await seed([
    { type: 'text', text: 'see **' },
    { type: 'url', url: 'https://example.com/b', preview: false, label: 'masked label' },
    { type: 'text', text: '** here' },
  ])
  await open(page)

  await test.step('a bare link inside **…**', async () => {
    const r = row(page, 'still bold')
    await expect(r).toBeVisible({ timeout: 30000 })
    await expect(r.locator('.unified-content')).not.toContainText('**')
    await expect(r.locator('.text-content .md-bold')).toHaveText(['bold ', ' still bold'])
    await expect(r.locator('strong.md-mark.md-bold > a.url-link')).toHaveText('https://example.com/a')
    expect(await weight(page, 'a.url-link', 'still bold')).toBeGreaterThanOrEqual(700)
  })

  await test.step('a masked link inside **…**', async () => {
    const r = row(page, 'masked label')
    await expect(r.locator('.unified-content')).toHaveText('see masked label here')
    await expect(r.locator('strong.md-mark.md-bold > a.url-link')).toHaveText('masked label')
    await expect(r.locator('a.url-link')).toHaveAttribute('href', 'https://example.com/b')
  })

  await test.step('stored content keeps its parts', async () => {
    const { data } = await admin.from('messages').select('content').eq('channel_id', channel)
    const texts = (data ?? []).flatMap((m) => (m.content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === 'text').map((p) => p.text))
    expect(texts).toContain('**bold ')
    expect(texts).toContain(' still bold**')
  })
})

test('a spoiler around a mention covers it and reveals as one', async ({ page }) => {
  await seed([
    { type: 'text', text: '||secret ' },
    { type: 'mention', userId: user.id, username: user.username, domain: 'localhost', isLocal: true },
    { type: 'text', text: ' more||' },
  ])
  await open(page)
  const r = row(page, 'secret')
  await expect(r).toBeVisible({ timeout: 30000 })
  await expect(r.locator('.unified-content')).not.toContainText('||')

  const mention = r.locator('button.mention')
  await test.step('every piece is covered, the mention too', async () => {
    await expect(r.locator('.md-spoiler')).toHaveCount(3)
    await expect(r.locator('.md-spoiler.revealed')).toHaveCount(0)
    await expect(mention).toHaveCSS('visibility', 'hidden')
  })

  await test.step('one click reveals all pieces', async () => {
    await r.locator('.text-content .md-spoiler').first().click()
    await expect(r.locator('.md-spoiler.revealed')).toHaveCount(3)
    await expect(mention).toHaveCSS('visibility', 'visible')
  })
})

test('a message typed in the composer renders its bold link', async ({ page }) => {
  await open(page)
  await composer(page).click()
  await composer(page).pressSequentially('**typed https://example.com/c across**', { delay: 10 })
  await page.keyboard.press('Enter')
  const posted = row(page, 'across')
  await expect(posted).toBeVisible({ timeout: 30000 })
  await expect(posted).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
  await expect(posted.locator('.unified-content')).not.toContainText('**')
  await expect(posted.locator('strong.md-mark.md-bold > a.url-link')).toHaveText('https://example.com/c')
  await expect(posted.locator('.text-content .md-bold')).toHaveText(['typed ', ' across'])
})
