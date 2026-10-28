// Journey: an emoji in a message, or a reaction pill, opens a card with the emoji, its
// :name: and where it comes from. A default emoji says so; this server's emoji says so; an
// emoji of a public server the viewer is not in shows that server and Join; an emoji of a
// private server shows one generic line, and the server's name reaches neither the page nor
// any response. A reaction card names who reacted, "and N others", and opens the full list.
// Click and keyboard open a dialog; Escape returns focus to the emoji. A phone opens a sheet.

import { test, expect, type Page, type Response } from '@playwright/test'
import {
  adminClient,
  addMember,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

const admin = adminClient()
let owner: SpecUser
let viewer: SpecUser
const reactors: SpecUser[] = []
let home: SeededServer
let secret: SeededServer
let plaza: SeededServer
let suffix: string
const emoji: Record<'home' | 'secret' | 'plaza' | 'plazaOther', { id: string; name: string }> = {} as never

async function insertEmoji(serverId: string, name: string): Promise<{ id: string; name: string }> {
  const { data, error } = await admin.from('emojis')
    .insert({ name, url: `https://emoji.e2e.test/${name}.png`, server_id: serverId, scope: 'server', uploader: owner.id })
    .select('id').single()
  if (error || !data) throw new Error(`emoji ${name}: ${error?.message}`)
  return { id: data.id, name }
}

test.beforeAll(async () => {
  test.setTimeout(120_000)
  owner = await createUser(admin, 'eiown')
  viewer = await createUser(admin, 'eiview')
  for (const tag of ['eira', 'eirb', 'eirc']) reactors.push(await createUser(admin, tag))
  suffix = owner.username.slice(-6)

  home = await seedServer(admin, owner, `Home ${suffix}`)
  secret = await seedServer(admin, owner, `Secret Lair ${suffix}`)
  plaza = await seedServer(admin, owner, `Plaza ${suffix}`)
  const { error: publicError } = await admin.from('servers').update({ public: true }).eq('id', plaza.id)
  if (publicError) throw new Error(`public: ${publicError.message}`)
  for (const user of [viewer, ...reactors]) await addMember(admin, user, home.id)

  emoji.home = await insertEmoji(home.id, `homecat${suffix}`)
  emoji.secret = await insertEmoji(secret.id, `secretcat${suffix}`)
  emoji.plaza = await insertEmoji(plaza.id, `plazacat${suffix}`)
  emoji.plazaOther = await insertEmoji(plaza.id, `plazadog${suffix}`)

  // Emoji parts as the composer stores them (useComposerActions: parseContentToMessageParts).
  const part = (e: { id: string; name: string }) =>
    ({ type: 'emoji', emoji: { id: e.id, name: e.name, url: `https://emoji.e2e.test/${e.name}.png` } })
  const contents = [
    [{ type: 'text', text: 'sweep 🧹 now' }],
    [{ type: 'text', text: 'home emoji ' }, part(emoji.home)],
    [{ type: 'text', text: 'secret emoji ' }, part(emoji.secret)],
    [{ type: 'text', text: 'plaza emoji ' }, part(emoji.plaza)],
  ]
  const start = Date.now() - 60_000
  const { data: rows, error } = await admin.from('messages').insert(contents.map((content, i) => ({
    channel_id: home.generalChannelId,
    user_id: owner.id,
    content,
    created_at: new Date(start + i * 1000).toISOString(),
  }))).select('id, content')
  if (error || !rows) throw new Error(`messages: ${error?.message}`)
  const sweep = rows.find((r) => JSON.stringify(r.content).includes('sweep'))!.id
  const { error: reactionError } = await admin.from('reactions').insert(
    [owner, viewer, ...reactors].map((u) => ({ message_id: sweep, user_id: u.id, custom_emoji_content: '🧹' })),
  )
  if (reactionError) throw new Error(`reactions: ${reactionError.message}`)
})

test.afterAll(async () => {
  await admin.from('emojis').delete().in('id', Object.values(emoji).map((e) => e.id))
  for (const user of [viewer, ...reactors, owner]) await deleteUser(admin, user)
})

const row = (page: Page, text: string) =>
  page.locator('[data-testid="message-list"] .message-item').filter({ hasText: text })
const card = (page: Page) => page.getByTestId('emoji-info')
const sourceLine = (page: Page) => page.getByTestId('emoji-info-source')

async function open(page: Page): Promise<void> {
  await page.route('https://emoji.e2e.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await signIn(page, viewer)
  await openChannel(page, home.id, home.generalChannelId)
  await expect(row(page, 'plaza emoji')).toBeVisible({ timeout: 30000 })
}

test('a default emoji: hover shows its card, a click pins it, Escape returns focus', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page)
  const broom = row(page, 'sweep').locator('.content-display [data-emoji-info]')
  await expect(broom).toHaveCount(1)
  await expect(broom).toHaveAttribute('role', 'button')

  await broom.hover()
  await expect(card(page)).toHaveAttribute('data-mode', 'hover')
  await expect(page.getByTestId('emoji-info-name')).toHaveText(':broom:')
  await expect(sourceLine(page)).toHaveText('A default emoji. Use it anywhere.')
  await page.mouse.move(0, 0)
  await expect(card(page)).toBeHidden()

  await broom.click()
  const dialog = page.getByRole('dialog', { name: ':broom:' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('data-mode', 'pinned')
  await expect(dialog).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(broom).toBeFocused()
})

test("this server's emoji says it is from this server", async ({ page }) => {
  test.setTimeout(120_000)
  await open(page)
  await row(page, 'home emoji').locator('[data-emoji-info]').click()
  await expect(page.getByTestId('emoji-info-name')).toHaveText(`:${emoji.home.name}:`)
  await expect(sourceLine(page)).toHaveText('From this server.')
  await expect(page.getByTestId('emoji-info-join')).toHaveCount(0)
})

test("a private server's emoji shows one generic line; its name is in no page or response", async ({ page }) => {
  test.setTimeout(120_000)
  const bodies: string[] = []
  const reads: Promise<void>[] = []
  page.on('response', (response: Response) => {
    reads.push(response.text().then((body) => { bodies.push(body) }, () => {}))
  })
  await open(page)

  const lookup = page.waitForResponse((r) => r.url().includes('/rpc/get_emoji_source'))
  await row(page, 'secret emoji').locator('[data-emoji-info]').click()
  const answer = await lookup
  expect(await answer.json()).toEqual({ kind: 'unavailable' })
  await expect(page.getByTestId('emoji-info-name')).toHaveText(`:${emoji.secret.name}:`)
  await expect(sourceLine(page)).toHaveText('From a server that is private or no longer available.')
  await expect(page.getByTestId('emoji-info-server')).toHaveCount(0)
  await expect(page.getByTestId('emoji-info-join')).toHaveCount(0)

  await Promise.all(reads)
  expect(await page.content()).not.toContain(secret.name)
  expect(bodies.length).toBeGreaterThan(10)
  expect(bodies.filter((body) => body.includes(secret.name))).toEqual([])
})

test("a public server's emoji shows the server, its other emoji and Join", async ({ page }) => {
  test.setTimeout(120_000)
  await open(page)
  await row(page, 'plaza emoji').locator('[data-emoji-info]').click()
  await expect(page.getByTestId('emoji-info-server-name')).toHaveText(plaza.name)
  await expect(sourceLine(page)).toHaveText(`From ${plaza.name}, a public server. Join it to use this emoji anywhere.`)
  await expect(page.getByTestId('emoji-info-more').getByRole('img', { name: `:${emoji.plazaOther.name}:` })).toBeVisible()

  await page.getByTestId('emoji-info-join').click()
  await expect(sourceLine(page)).toHaveText(`From ${plaza.name}, one of your servers.`, { timeout: 15000 })
  await expect(page.getByTestId('emoji-info-join')).toHaveCount(0)
  const { data } = await admin.from('user_servers').select('status').eq('server_id', plaza.id).eq('user_id', viewer.id).single()
  expect(data?.status).toBe('accepted')
})

test('a reaction card names who reacted and opens the full list; the keyboard opens and closes it', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page)
  const pill = row(page, 'sweep').locator('.message-reactions .reaction').first()
  await expect(pill).toBeVisible({ timeout: 15000 })

  await pill.hover()
  await expect(card(page)).toHaveAttribute('data-mode', 'hover')
  await expect(page.getByTestId('emoji-info-reactors')).toHaveText(/^Reacted by .+, .+, .+ and 2 others$/, { timeout: 15000 })
  await page.mouse.move(0, 0)
  await expect(card(page)).toBeHidden()

  await pill.focus()
  await page.keyboard.press('Shift+F10')
  const dialog = page.getByRole('dialog', { name: ':broom:' })
  await expect(dialog).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(dialog.getByTestId('emoji-info-copy')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(pill).toBeFocused()

  await page.keyboard.press('ContextMenu')
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('emoji-info-all-reactions').click()
  const list = page.getByRole('dialog', { name: 'Reactions' })
  await expect(list).toBeVisible()
  await expect(list.getByTestId('reactions-modal-user')).toHaveCount(5)
  await page.keyboard.press('Escape')
  await expect(list).toBeHidden()
  await expect(pill).toBeFocused()
})

test('an emoji reached by Tab opens with Enter and closes with Escape back on it', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page)
  const home = row(page, 'home emoji')
  await home.focus()
  const target = home.locator('[data-emoji-info]')
  for (let i = 0; i < 6 && !(await target.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab')
  }
  await expect(target).toBeFocused()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: `:${emoji.home.name}:` })
  await expect(dialog).toBeFocused()
  await expect(dialog).toHaveAccessibleDescription('From this server.')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(target).toBeFocused()
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('a tap opens the card as a sheet', async ({ page }) => {
    test.setTimeout(120_000)
    await open(page)
    await row(page, 'home emoji').locator('[data-emoji-info]').tap()
    const sheet = page.getByRole('dialog', { name: `:${emoji.home.name}:` })
    await expect(sheet).toHaveAttribute('data-mode', 'sheet')
    await expect(sheet).toHaveAttribute('aria-modal', 'true')
    await page.getByTestId('emoji-info-close').tap()
    await expect(sheet).toBeHidden()
  })
})
