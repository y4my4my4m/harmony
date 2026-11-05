// Journey: the emoji info card is compact and its parts read as they do elsewhere.
// - A reaction card names reactors as names render elsewhere: a :shortcode: in a display name
//   is its emoji, not the shortcode's text.
// - The server's other emoji are one row: as many as the card's width holds (7 on a desktop
//   card, 8 on a 375 px phone sheet), the row filled edge to edge.
// - An emoji of the server open in the view gets no server preview: the source line says it.
// - The copy actions are icon buttons named by their labels; the actions are one row.
// - A hover card whose source arrives after it opens stays open while the pointer rests on
//   the emoji. The card grew down over its emoji, moved off it, and the move read as the
//   pointer leaving the card.

import { test, expect, type Locator, type Page } from '@playwright/test'
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

const admin = adminClient()
let owner: SpecUser
let viewer: SpecUser
const reactors: SpecUser[] = []
let home: SeededServer
// The emoji under test belong to another server the viewer is in, so their card has a preview.
let source: SeededServer
const emoji: Array<{ id: string; name: string; url: string }> = []
let homeEmoji: { id: string; name: string; url: string }

test.beforeAll(async () => {
  test.setTimeout(120_000)
  owner = await createUser(admin, 'eicown')
  viewer = await createUser(admin, 'eicview')
  for (const tag of ['eicra', 'eicrb']) reactors.push(await createUser(admin, tag))
  home = await seedServer(admin, owner, `Compact ${owner.username.slice(-6)}`)
  source = await seedServer(admin, owner, `Source ${owner.username.slice(-6)}`)
  for (const user of [viewer, ...reactors]) {
    await addMember(admin, user, home.id)
    await addMember(admin, user, source.id)
  }
  for (let i = 0; i < 12; i++) {
    const name = `cmp${i}${owner.username.slice(-6)}`
    const url = `https://emoji.e2e.test/${name}.svg`
    const { data, error } = await admin.from('emojis')
      .insert({ name, url, server_id: source.id, scope: 'server', uploader: owner.id }).select('id').single()
    if (error || !data) throw new Error(`emoji ${name}: ${error?.message}`)
    emoji.push({ id: data.id, name, url })
  }
  {
    const name = `cmphome${owner.username.slice(-6)}`
    const url = `https://emoji.e2e.test/${name}.svg`
    const { data, error } = await admin.from('emojis')
      .insert({ name, url, server_id: home.id, scope: 'server', uploader: owner.id }).select('id').single()
    if (error || !data) throw new Error(`emoji ${name}: ${error?.message}`)
    homeEmoji = { id: data.id, name, url }
  }
  const { error: nameError } = await admin.from('profiles')
    .update({ display_name: `:fire: ${reactors[0].displayName}` }).eq('id', reactors[0].id)
  if (nameError) throw new Error(`display name: ${nameError.message}`)

  const part = (e: { id: string; name: string; url: string }) => ({ type: 'emoji', emoji: e })
  const start = Date.now() - 120_000
  const filler = Array.from({ length: 6 }, (_, i) => [{ type: 'text', text: `filler ${i}` }])
  const contents = [...filler, [{ type: 'text', text: 'reacted to ' }], [{ type: 'text', text: 'local emoji ' }, part(homeEmoji)],
    [{ type: 'text', text: 'emoji here ' }, part(emoji[0])]]
  const { data: rows, error } = await admin.from('messages').insert(contents.map((content, i) => ({
    channel_id: home.generalChannelId, user_id: owner.id, content, created_at: new Date(start + i * 1000).toISOString(),
  }))).select('id, content')
  if (error || !rows) throw new Error(`messages: ${error?.message}`)
  const reacted = rows.find((r) => JSON.stringify(r.content).includes('reacted to'))!.id
  const { error: reactionError } = await admin.from('reactions')
    .insert([...reactors, viewer].map((u) => ({ message_id: reacted, user_id: u.id, emoji_id: emoji[1].id })))
  if (reactionError) throw new Error(`reactions: ${reactionError.message}`)
})

test.afterAll(async () => {
  await admin.from('emojis').delete().in('id', [...emoji.map((e) => e.id), homeEmoji.id])
  for (const user of [viewer, ...reactors, owner]) await deleteUser(admin, user)
})

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#f5a623"/></svg>'

async function open(page: Page, delaySourceMs = 0): Promise<void> {
  await page.route('https://emoji.e2e.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: SVG }))
  if (delaySourceMs) {
    await page.route('**/rest/v1/rpc/get_emoji_source*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, delaySourceMs))
      await route.continue()
    })
  }
  await signIn(page, viewer)
  await openChannel(page, home.id, home.generalChannelId)
  await expect(row(page, 'emoji here')).toBeVisible({ timeout: 30000 })
}

const row = (page: Page, text: string) =>
  page.locator('[data-testid="message-list"] .message-item').filter({ hasText: text })
const card = (page: Page) => page.getByTestId('emoji-info')

/** Tops of the preview's items, rounded; one value is one row. */
const rowTops = (more: Locator) =>
  more.locator('li').evaluateAll((items) => [...new Set(items.map((li) => Math.round(li.getBoundingClientRect().top)))])

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('a reaction card draws emoji in reactor names; the preview is one row of 7', async ({ page }) => {
    test.setTimeout(120_000)
    await open(page)
    const pill = row(page, 'reacted to').locator('.message-reactions .reaction').first()
    await expect(pill).toBeVisible({ timeout: 15000 })
    await pill.hover()
    await expect(card(page)).toHaveAttribute('data-mode', 'hover')

    const reactorsLine = page.getByTestId('emoji-info-reactors')
    await expect(reactorsLine).toContainText(reactors[0].displayName, { timeout: 15000 })
    await expect(reactorsLine).not.toContainText(':fire:')
    await expect.poll(() => reactorsLine.locator('img.display-name-emoji').count(), { timeout: 15000 }).toBeGreaterThan(0)

    const more = page.getByTestId('emoji-info-more')
    await expect(more.locator('li')).toHaveCount(7)
    expect(await rowTops(more)).toHaveLength(1)
    await expect(card(page)).toHaveCSS('width', '280px')
  })

  test('a pinned card: one row of actions, the copy actions named icon buttons', async ({ page }) => {
    test.setTimeout(120_000)
    await open(page)
    await row(page, 'emoji here').locator('[data-emoji-info]').click()
    const dialog = page.getByRole('dialog', { name: `:${emoji[0].name}:` })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('emoji-info-more').locator('li')).toHaveCount(7)
    const copy = dialog.getByRole('button', { name: 'Copy', exact: true })
    const link = dialog.getByRole('button', { name: 'Copy image link' })
    await expect(copy).toHaveText('')
    await expect(link).toHaveText('')
    const [a, b] = [await copy.boundingBox(), await link.boundingBox()]
    expect(Math.round(a!.y)).toBe(Math.round(b!.y))
    expect((await dialog.boundingBox())!.height).toBeLessThan(220)
  })

  test('an emoji of the server in view has no server preview', async ({ page }) => {
    test.setTimeout(120_000)
    await open(page)
    await row(page, 'local emoji').locator('[data-emoji-info]').click()
    const dialog = page.getByRole('dialog', { name: `:${homeEmoji.name}:` })
    await expect(dialog).toHaveAccessibleDescription('From this server.', { timeout: 15000 })
    await expect(dialog.getByTestId('emoji-info-server')).toHaveCount(0)
    await expect(dialog.getByTestId('emoji-info-copy')).toBeVisible()
  })

  test('a hover card whose source arrives late stays open on its emoji', async ({ page }) => {
    test.setTimeout(120_000)
    await open(page, 800)
    const target = row(page, 'emoji here').locator('[data-emoji-info]')
    const box = (await target.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 })
    await expect(card(page)).toHaveAttribute('data-mode', 'hover')
    await expect(page.getByTestId('emoji-info-more')).toBeVisible({ timeout: 10000 })
    await page.waitForTimeout(1000)
    await expect(card(page)).toBeVisible()
    await expect(page.getByTestId('emoji-info-more').locator('li')).toHaveCount(7)
    await page.mouse.move(0, 0)
    await expect(card(page)).toBeHidden()
  })
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true })

  test('the sheet preview is one row filled edge to edge', async ({ page }) => {
    test.setTimeout(120_000)
    await open(page)
    await row(page, 'emoji here').locator('[data-emoji-info]').tap()
    const sheet = page.getByRole('dialog', { name: `:${emoji[0].name}:` })
    await expect(sheet).toHaveAttribute('data-mode', 'sheet')
    const more = sheet.getByTestId('emoji-info-more')
    await expect(more.locator('li')).toHaveCount(8)
    expect(await rowTops(more)).toHaveLength(1)
    const edges = await more.evaluate((ul) => {
      const box = ul.getBoundingClientRect()
      const items = ul.querySelectorAll('li')
      return {
        left: items[0].getBoundingClientRect().left - box.left,
        right: box.right - items[items.length - 1].getBoundingClientRect().right,
      }
    })
    expect(edges.left).toBeLessThan(6)
    expect(edges.right).toBeLessThan(6)
  })
})
