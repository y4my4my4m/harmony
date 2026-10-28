// Journeys: "Leaving Harmony" before outside links (1.9.2).
// - A masked link ([label](url)) asks first: the dialog shows the whole address with the real
//   host, Cancel stays in the app and returns focus to the link, Open opens the address. The
//   same holds in a DM, in a post, for a post's preview card and for a message embed's Open.
// - "Trust <host>" opens that host without asking from then on, after a reload too, until the
//   host is removed under Settings > Privacy & safety.
// - A plain link opens at once; "Ask before opening any outside link" makes it ask.
// - A link to this instance never asks, masked or with that setting on.
// - Enter on a focused link asks, Escape cancels; middle and Ctrl+click ask too.
// - On a phone the dialog fits the screen and its buttons stack.
//
// Outside hosts are *.e2e.test, answered by a route on the browser context so the opened page
// loads at once.

import { test, expect, devices, type BrowserContext, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
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
const DOCS = 'https://outside.e2e.test/docs?ref=1'
const PLAIN = 'https://plain.e2e.test/page'
const CARD = 'https://card.e2e.test/article'

let owner: SpecUser
let truster: SpecUser
let asker: SpecUser
let typist: SpecUser
let phone: SpecUser
let server: SeededServer
let dmId = ''
let postId = ''

const masked = (label: string, url: string) => ({ type: 'url', url, preview: false, label })
const plain = (url: string) => ({ type: 'url', url, preview: false })

async function say(content: unknown[], metadata?: Record<string, unknown>, conversationId?: string) {
  const { error } = await admin.from('messages').insert({
    ...(conversationId ? { conversation_id: conversationId } : { channel_id: server.generalChannelId }),
    user_id: owner.id,
    content,
    ...(metadata ? { metadata } : {}),
  })
  if (error) throw new Error(`message: ${error.message}`)
}

async function authId(user: SpecUser): Promise<string> {
  const { data } = await admin.from('profiles').select('auth_user_id').eq('id', user.id).single()
  return data!.auth_user_id as string
}

test.beforeAll(async () => {
  owner = await createUser(admin, 'olw')
  truster = await createUser(admin, 'olwt')
  asker = await createUser(admin, 'olwa')
  typist = await createUser(admin, 'olwk')
  phone = await createUser(admin, 'olwp')
  server = await seedServer(admin, owner, `Outside ${owner.username}`)
  for (const member of [truster, asker, typist, phone]) await addMember(admin, member, server.id)

  await say([{ type: 'text', text: 'read ' }, masked('the docs', DOCS)])
  await say([{ type: 'text', text: 'plain ' }, plain(PLAIN)])
  const card = {
    cacheKey: `generic:${CARD}`, url: CARD, normalizedUrl: CARD, provider: 'generic',
    title: 'Card article', siteName: 'card.e2e.test',
    fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  }
  await say([{ type: 'text', text: 'carded ' }, { type: 'url', url: CARD, preview: true, label: 'an article' }],
    { embeds: { [CARD]: card } })

  const { data: conversation, error } = await admin.from('conversations')
    .insert({ type: 'direct', created_by: owner.id }).select('id').single()
  if (error || !conversation) throw new Error(`conversation: ${error?.message}`)
  dmId = conversation.id
  await admin.from('conversation_participants').insert([
    { conversation_id: dmId, user_id: owner.id },
    { conversation_id: dmId, user_id: typist.id },
  ])
  await say([{ type: 'text', text: 'in a dm ' }, masked('a dm link', DOCS)], undefined, dmId)

  const { data: post, error: postError } = await admin.from('posts').insert({
    author_id: owner.id, visibility: 'public', is_local: true,
    content: [{ type: 'text', text: `post ${owner.username} ` }, { type: 'url', url: CARD, preview: true, label: 'my article' }],
    metadata: { embeds: { [CARD]: { url: CARD, title: 'Card article', siteName: 'card.e2e.test' } } },
  }).select('id').single()
  if (postError || !post) throw new Error(`post: ${postError?.message}`)
  postId = post.id
})

test.afterAll(async () => {
  await admin.from('posts').delete().eq('author_id', owner.id)
  for (const user of [owner, truster, asker, typist, phone]) await deleteUser(admin, user)
})

async function routeOutside(context: BrowserContext) {
  await context.route(/^https:\/\/[a-z]+\.e2e\.test\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<title>outside</title>outside' }))
}

const dialog = (page: Page) => page.getByRole('alertdialog', { name: 'Leaving Harmony' })
const row = (page: Page, text: string) => messageList(page).locator('.message-item').filter({ hasText: text }).last()
const docsLink = (page: Page) => row(page, 'read').getByRole('link', { name: 'the docs' })

/** The page `act` opens in a new tab. */
async function opens(context: BrowserContext, act: () => Promise<void>): Promise<string> {
  const next = context.waitForEvent('page', { timeout: 15000 })
  await act()
  const popup = await next
  await popup.waitForURL(/e2e\.test/, { timeout: 15000 })
  const url = popup.url()
  await popup.close()
  return url
}

/** Nothing opens within a second of `act`. */
async function opensNothing(context: BrowserContext, act: () => Promise<void>) {
  const before = context.pages().length
  await act()
  await new Promise((resolve) => setTimeout(resolve, 1000))
  expect(context.pages()).toHaveLength(before)
}

test('a masked link asks first with its real host; Cancel stays, Open opens it', async ({ page, context }) => {
  test.setTimeout(150_000)
  await routeOutside(context)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  await test.step('the dialog shows the whole address with the host apart', async () => {
    await opensNothing(context, () => docsLink(page).click())
    await expect(dialog(page)).toBeVisible()
    await expect(dialog(page).getByTestId('outside-link-url')).toHaveText(DOCS)
    await expect(dialog(page).getByTestId('outside-link-host')).toHaveText('outside.e2e.test')
    await expect(dialog(page)).toHaveAccessibleDescription(/outside\.e2e\.test\/docs\?ref=1/)
  })

  await test.step('Cancel keeps the app and returns focus to the link', async () => {
    const at = page.url()
    await opensNothing(context, () => dialog(page).getByRole('button', { name: 'Cancel' }).click())
    await expect(dialog(page)).toBeHidden()
    expect(page.url()).toBe(at)
    await expect(docsLink(page)).toBeFocused()
  })

  await test.step('Open opens the address in a new tab', async () => {
    await docsLink(page).click()
    expect(await opens(context, () => dialog(page).getByRole('button', { name: 'Open link' }).click())).toBe(DOCS)
    await expect(dialog(page)).toBeHidden()
  })

  await test.step('a masked link\'s preview Open asks too', async () => {
    const embed = row(page, 'carded').locator('.provider-embed')
    await opensNothing(context, () => embed.getByRole('button', { name: 'Open' }).click())
    await expect(dialog(page).getByTestId('outside-link-host')).toHaveText('card.e2e.test')
    await page.keyboard.press('Escape')
    await expect(embed.getByRole('button', { name: 'Open' })).toBeFocused()
  })

  await test.step('in a DM', async () => {
    await page.goto(`/dm/${dmId}`)
    await dismissAnnouncements(page)
    await opensNothing(context, () => row(page, 'in a dm').getByRole('link', { name: 'a dm link' }).click())
    await expect(dialog(page).getByTestId('outside-link-host')).toHaveText('outside.e2e.test')
    await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  })

  await test.step('in a post, its link and its preview card', async () => {
    await page.goto(`/posts/${postId}`)
    await dismissAnnouncements(page)
    const article = page.locator('article').filter({ hasText: `post ${owner.username}` }).first()
    await opensNothing(context, () => article.getByRole('link', { name: 'my article' }).click())
    await expect(dialog(page).getByTestId('outside-link-host')).toHaveText('card.e2e.test')
    await dialog(page).getByRole('button', { name: 'Cancel' }).click()
    await opensNothing(context, () => article.locator('a.post-link-preview').click())
    await expect(dialog(page).getByTestId('outside-link-host')).toHaveText('card.e2e.test')
    expect(await opens(context, () => dialog(page).getByRole('button', { name: 'Open link' }).click())).toBe(CARD)
  })
})

test('a trusted host opens without asking, after a reload too, until it is removed', async ({ page, context }) => {
  test.setTimeout(150_000)
  const id = await authId(truster)
  await admin.from('trusted_link_hosts').delete().eq('user_id', id)
  await routeOutside(context)
  await signIn(page, truster)
  await openChannel(page, server.id, server.generalChannelId)

  await test.step('Open with "Trust" ticked opens the link and stores the host', async () => {
    await docsLink(page).click()
    await dialog(page).getByRole('checkbox', { name: 'Trust outside.e2e.test from now on' }).check()
    expect(await opens(context, () => dialog(page).getByRole('button', { name: 'Open link' }).click())).toBe(DOCS)
    await expect.poll(async () => {
      const { data } = await admin.from('trusted_link_hosts').select('host').eq('user_id', id)
      return (data ?? []).map((r) => r.host)
    }, { timeout: 15000 }).toEqual(['outside.e2e.test'])
  })

  await test.step('the next click opens at once', async () => {
    expect(await opens(context, () => docsLink(page).click())).toBe(DOCS)
    await expect(dialog(page)).toBeHidden()
  })

  await test.step('and after a reload', async () => {
    await page.reload()
    await dismissAnnouncements(page)
    expect(await opens(context, () => docsLink(page).click())).toBe(DOCS)
    await expect(dialog(page)).toBeHidden()
  })

  await test.step('Settings lists the host; removing it brings the dialog back', async () => {
    await page.goto('/settings/privacy')
    await dismissAnnouncements(page)
    const list = page.getByTestId('trusted-sites')
    await expect(list).toContainText('outside.e2e.test', { timeout: 30000 })
    await list.getByRole('button', { name: 'Remove outside.e2e.test from trusted sites' }).click()
    await expect(page.getByTestId('trusted-sites-empty')).toBeVisible()
    await expect.poll(async () => {
      const { count } = await admin.from('trusted_link_hosts').select('host', { count: 'exact', head: true }).eq('user_id', id)
      return count
    }, { timeout: 15000 }).toBe(0)
    await openChannel(page, server.id, server.generalChannelId)
    await opensNothing(context, () => docsLink(page).click())
    await expect(dialog(page)).toBeVisible()
  })
})

test('a plain link opens at once; with "Ask before opening any outside link" it asks, never for this instance', async ({ page, context }) => {
  test.setTimeout(150_000)
  const id = await authId(asker)
  await admin.from('outside_link_settings').delete().eq('user_id', id)
  await routeOutside(context)
  await signIn(page, asker)
  await openChannel(page, server.id, server.generalChannelId)
  const plainLink = () => row(page, 'plain').getByRole('link', { name: PLAIN })

  await test.step('by default a plain link opens without the dialog', async () => {
    expect(await opens(context, () => plainLink().click())).toBe(PLAIN)
    await expect(dialog(page)).toBeHidden()
  })

  await test.step('the setting turns the dialog on for it, and is stored', async () => {
    await page.goto('/settings/privacy')
    await dismissAnnouncements(page)
    const toggle = page.getByRole('switch', { name: 'Ask before opening any outside link' })
    await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 30000 })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect.poll(async () => {
      const { data } = await admin.from('outside_link_settings').select('ask_every_link').eq('user_id', id).maybeSingle()
      return data?.ask_every_link ?? null
    }, { timeout: 15000 }).toBe(true)
    await openChannel(page, server.id, server.generalChannelId)
    await opensNothing(context, () => plainLink().click())
    await expect(dialog(page)).toBeVisible()
    await expect(dialog(page).getByTestId('outside-link-host')).toHaveText('plain.e2e.test')
    await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  })

  await test.step('a link to this instance never asks, masked or not', async () => {
    const origin = new URL(page.url()).origin
    const tag = Date.now().toString(36)
    const { data: other } = await admin.from('channels')
      .insert({ server_id: server.id, name: `own-${tag}`, type: 0 }).select('id').single()
    await say([{ type: 'text', text: `own ${tag} ` }, masked('our other channel', `${origin}/chat/${server.id}/${other!.id}`)])
    await openChannel(page, server.id, server.generalChannelId)
    await opensNothing(context, () => row(page, `own ${tag}`).getByRole('link', { name: 'our other channel' }).click())
    await expect(dialog(page)).toBeHidden()
    await expect(page).toHaveURL(new RegExp(`/chat/${server.id}/${other!.id}$`))
  })
})

test('keyboard: Enter asks, Escape cancels to the link; middle and Ctrl+click ask', async ({ page, context }) => {
  test.setTimeout(150_000)
  await routeOutside(context)
  await signIn(page, typist)
  await openChannel(page, server.id, server.generalChannelId)

  await test.step('Enter on the focused link opens the dialog with Cancel focused', async () => {
    await docsLink(page).focus()
    await opensNothing(context, () => page.keyboard.press('Enter'))
    await expect(dialog(page)).toBeVisible()
    await expect(dialog(page).getByRole('button', { name: 'Cancel' })).toBeFocused()
  })

  await test.step('Escape closes it, opens nothing, and focus is back on the link', async () => {
    await opensNothing(context, () => page.keyboard.press('Escape'))
    await expect(dialog(page)).toBeHidden()
    await expect(docsLink(page)).toBeFocused()
  })

  await test.step('Tab reaches Open, which opens the link', async () => {
    await page.keyboard.press('Enter')
    await expect(dialog(page).getByRole('button', { name: 'Cancel' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(dialog(page).getByRole('button', { name: 'Open link' })).toBeFocused()
    expect(await opens(context, () => page.keyboard.press('Enter'))).toBe(DOCS)
  })

  await test.step('a middle click and a Ctrl+click ask instead of opening a tab', async () => {
    await opensNothing(context, () => docsLink(page).click({ button: 'middle' }))
    await expect(dialog(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await opensNothing(context, () => docsLink(page).click({ modifiers: ['ControlOrMeta'] }))
    await expect(dialog(page)).toBeVisible()
    await page.keyboard.press('Escape')
  })
})

test.describe('phone', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })

  test('the dialog fits a phone screen and its buttons stack', async ({ page, context }) => {
    test.setTimeout(150_000)
    await routeOutside(context)
    await signIn(page, phone)
    await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
    await dismissAnnouncements(page)
    await docsLink(page).tap()
    await expect(dialog(page)).toBeVisible()
    const width = page.viewportSize()!.width
    const box = (await dialog(page).boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1)
    const open = (await dialog(page).getByRole('button', { name: 'Open link' }).boundingBox())!
    const cancel = (await dialog(page).getByRole('button', { name: 'Cancel' }).boundingBox())!
    expect(open.y).toBeLessThan(cancel.y)
    expect(open.width).toBeGreaterThan(box.width * 0.8)
    expect(open.height).toBeGreaterThanOrEqual(44)
    await dialog(page).getByRole('button', { name: 'Cancel' }).tap()
    await expect(dialog(page)).toBeHidden()
    await docsLink(page).tap()
    expect(await opens(context, () => dialog(page).getByRole('button', { name: 'Open link' }).tap())).toBe(DOCS)
  })
})
