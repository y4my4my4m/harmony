// Journey: inline markdown spans the links, mentions and emoji inside it. A message is stored
// as parts (text, link, mention, ...); each text part rendered on its own, so
// `**bold https://x.com still bold**` and `**[a](url)**` showed their `**`, and a spoiler around a
// mention showed everything. The text parts render as one run now: both halves are bold, the
// link sits inside the bold, a spoiler covers the mention and reveals as one. Stored content
// is unchanged.
// - A spoiler around a link covers the link's image, GIF and preview card too: they render
//   outside the text and showed in the clear while the markers vanished. One click reveals all.
// - Two spoilers of one message reveal apart: their group ids restarted with each run.
// - A quote line holding a mention is one quote with the mention inside; it split into three.

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

async function seed(content: unknown[], metadata?: Record<string, unknown>): Promise<void> {
  const { error } = await admin.from('messages').insert({ channel_id: channel, user_id: user.id, content, ...(metadata ? { metadata } : {}) })
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

const IMAGE = 'https://media.example.test/runs/secret.png'
const GIF_PAGE = 'https://klipy.com/gifs/runs-secret'
const GIF = 'https://static.klipy.test/ii/runs/secret.gif'
const ARTICLE = 'https://news.example.test/runs/secret-article'
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#0ea5e9"/></svg>'

const embed = (url: string, over: Record<string, unknown>) => ({
  cacheKey: `generic:${url}`, url, normalizedUrl: url, provider: 'generic',
  fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), ...over,
})

test('a spoiler around a link covers its image, GIF and preview card until clicked', async ({ page }) => {
  await page.route(/https:\/\/(media\.example\.test|static\.klipy\.test)\//, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: SVG }))
  await seed([{ type: 'text', text: 'pic ||' }, { type: 'url', url: IMAGE, preview: true }, { type: 'text', text: '||' }])
  await seed(
    [{ type: 'text', text: 'gif ||' }, { type: 'url', url: GIF_PAGE, preview: true }, { type: 'text', text: '||' }],
    { embeds: { [GIF_PAGE]: embed(GIF_PAGE, { title: 'Secret', siteName: 'Klipy', image: GIF, mediaOnly: true }) } },
  )
  await seed(
    [{ type: 'text', text: 'card ||' }, { type: 'url', url: ARTICLE, preview: true }, { type: 'text', text: '||' }],
    { embeds: { [ARTICLE]: embed(ARTICLE, { title: 'The secret article', siteName: 'News', description: 'Spoils it all' }) } },
  )
  await open(page)

  await test.step('the image is covered; its cover reveals it', async () => {
    const r = row(page, 'pic')
    await expect(r).toBeVisible({ timeout: 30000 })
    await expect(r.locator('.unified-content')).not.toContainText('||')
    const frame = r.locator('.media-frame')
    await expect(frame).toHaveClass(/media-spoiler/)
    await expect(r.locator(`img[src="${IMAGE}"]`)).toHaveCSS('filter', /blur/)
    await r.locator('.media-spoiler-cover').click()
    await expect(frame).not.toHaveClass(/media-spoiler/)
    await expect(r.locator(`img[src="${IMAGE}"]`)).toHaveCSS('filter', 'none')
  })

  await test.step('the GIF is covered; a click on the spoiler bar reveals bar and GIF', async () => {
    const r = row(page, 'gif')
    const bar = r.locator('.md-mark.md-spoiler')
    await expect(bar).toBeVisible()
    await expect(r.locator('.media-frame')).toHaveClass(/media-spoiler/)
    await expect(r.locator(`img[src="${GIF}"]`)).toHaveCSS('filter', /blur/)
    await bar.click()
    await expect(bar).toHaveClass(/revealed/)
    await expect(r.locator('.media-frame')).not.toHaveClass(/media-spoiler/)
  })

  await test.step('the preview card is out until the spoiler is revealed', async () => {
    const r = row(page, 'card')
    const bar = r.locator('.md-mark.md-spoiler')
    await expect(bar).toBeVisible()
    await expect(r.locator('.provider-embed')).toHaveCount(0)
    await expect(r).not.toContainText('The secret article')
    await bar.click()
    await expect(r.locator('.provider-embed')).toBeVisible()
    await expect(r).toContainText('The secret article')
  })
})

test('two spoilers of one message reveal apart', async ({ page }) => {
  const mention = { type: 'mention', userId: user.id, username: user.username, domain: 'localhost', isLocal: true }
  await seed([
    { type: 'text', text: '||first ' }, mention, { type: 'text', text: ' one||' },
    { type: 'embed', url: 'https://example.test/block', previewId: 'none' },
    { type: 'text', text: '||second ' }, mention, { type: 'text', text: ' two||' },
  ])
  await open(page)
  const r = row(page, 'first')
  await expect(r).toBeVisible({ timeout: 30000 })
  await expect(r.locator('.md-spoiler')).toHaveCount(6)
  await r.locator('.text-content .md-spoiler').filter({ hasText: 'first' }).click()
  await expect(r.locator('.md-spoiler.revealed')).toHaveCount(3)
  await expect(r.locator('.text-content .md-spoiler').filter({ hasText: 'second' })).not.toHaveClass(/revealed/)
  await expect(r.locator('button.mention').nth(1)).toHaveCSS('visibility', 'hidden')
})

test('a quote line holding a mention is one quote with the mention inside', async ({ page }) => {
  await seed([
    { type: 'text', text: 'said\n> quoted ' },
    { type: 'mention', userId: user.id, username: user.username, domain: 'localhost', isLocal: true },
    { type: 'text', text: ' rest\nafter' },
  ])
  await open(page)
  const r = row(page, 'quoted')
  await expect(r).toBeVisible({ timeout: 30000 })
  const quote = r.locator('blockquote')
  await expect(quote).toHaveCount(1)
  await expect(quote.locator('button.mention')).toHaveCount(1)
  await expect(quote).toHaveText(/^quoted @.+ rest$/)
  await expect(quote).not.toContainText('said')
  await expect(quote).not.toContainText('after')
  // One line: the mention sits beside the quoted words.
  const words = (await quote.locator('.text-content').first().boundingBox())!
  const name = (await quote.locator('button.mention').boundingBox())!
  expect(Math.abs(name.y + name.height / 2 - (words.y + words.height / 2))).toBeLessThan(6)
  await expect(quote).toHaveCSS('border-left-style', 'solid')
})
