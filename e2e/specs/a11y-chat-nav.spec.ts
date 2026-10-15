// Journey: chat navigation as a keyboard and screen-reader user meets it.
//
// Channel list rows name their type and state, one Tab stop with arrow keys,
// Space and Enter activate, channel switches are announced; context menus open
// from the keyboard and Move up/down reorders channels and categories with an
// announcement; the chat header and server menus follow the menu pattern; rail
// entries name mentions, unread and mute; DM rows are links and dismissing one
// is deliberate and undoable; the member list is a labelled list with named
// rows and a labelled search; Create channel offers a radio group; the thread
// panel is a modal dialog. axe runs on these screens with AXE_EXCLUSIONS.
//
// The stack runs no realtime: every state a page shows was written before it
// loaded.

import { test, expect, type Locator, type Page } from '@playwright/test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  openChannel,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'
import { expectNoAxeViolations } from './a11y'

const admin = adminClient()
let owner: SpecUser
let reader: SpecUser
let friend: SpecUser
let server: SeededServer
let mutedServer: SeededServer
let unreadServer: SeededServer
let ownerClient: SupabaseClient
let readerClient: SupabaseClient
const channel: Record<'random' | 'news' | 'quiet', string> = { random: '', news: '', quiet: '' }
let textCategory = ''
let threadId = ''
const conversation = { owner: '', friend: '' }

const THREAD = 'side talk'

async function insertChannel(name: string, order: number): Promise<string> {
  const { data, error } = await admin
    .from('channels')
    .insert({ server_id: server.id, name, type: 0, category: textCategory, order })
    .select('id')
    .single()
  if (error || !data) throw new Error(`channel ${name}: ${error?.message}`)
  return data.id
}

async function post(client: SupabaseClient, author: SpecUser, channelId: string, text: string): Promise<string> {
  const { data, error } = await client
    .from('messages')
    .insert({ channel_id: channelId, user_id: author.id, content: [{ type: 'text', text }] })
    .select('id')
    .single()
  if (error || !data) throw new Error(`post: ${error?.message}`)
  return data.id
}

async function directConversation(a: SpecUser, b: SpecUser, text: string): Promise<string> {
  const { data, error } = await admin
    .from('conversations')
    .insert({ type: 'direct', created_by: a.id })
    .select('id')
    .single()
  if (error || !data) throw new Error(`conversation: ${error?.message}`)
  await admin.from('conversation_participants').insert([
    { conversation_id: data.id, user_id: a.id },
    { conversation_id: data.id, user_id: b.id },
  ])
  await admin.from('messages').insert({ conversation_id: data.id, user_id: a.id, content: [{ type: 'text', text }] })
  return data.id
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  // Seeding runs again in each retry's fresh worker; on a loaded CI runner it outlasts the
  // default 30 s and fails every test of the file.
  test.setTimeout(120_000)
  owner = await createUser(admin, 'navo')
  reader = await createUser(admin, 'navr')
  friend = await createUser(admin, 'navf')
  server = await seedServer(admin, owner, `Nav Hub ${owner.username}`)
  await addMember(admin, reader, server.id)

  const { data: general } = await admin.from('channels').select('category').eq('id', server.generalChannelId).single()
  textCategory = general?.category ?? ''
  channel.random = await insertChannel('random', 1)
  channel.news = await insertChannel('news', 2)
  channel.quiet = await insertChannel('quiet', 3)

  ownerClient = await userClient(owner)
  readerClient = await userClient(reader)

  // Server at All messages: a message badges its channel. #news stays at
  // mentions only (unread, no badge); #quiet is muted.
  const settings = [
    readerClient.rpc('update_server_notification_settings', { p_server_id: server.id, p_changes: { level: 'all' } }),
    readerClient.rpc('update_channel_notification_override', { p_channel_id: channel.news, p_changes: { level: 'mentions' } }),
    readerClient.rpc('update_channel_notification_override', { p_channel_id: channel.quiet, p_changes: { muted: true } }),
  ]
  for (const { error } of await Promise.all(settings)) if (error) throw new Error(`settings: ${error.message}`)

  await post(ownerClient, owner, channel.random, 'news for random')
  await post(ownerClient, owner, channel.news, 'news for news')
  await post(ownerClient, owner, channel.quiet, 'news for quiet')
  const parent = await post(ownerClient, owner, server.generalChannelId, 'a topic worth a thread')
  const { data: created, error: threadError } = await ownerClient.rpc('create_thread', {
    p_message_id: parent,
    p_name: THREAD,
    p_auto_archive_duration: 1440,
  })
  if (threadError) throw new Error(`thread: ${threadError.message}`)
  threadId = created as string

  // Rail: one server muted by the reader, one with an unread message and no mention.
  mutedServer = await seedServer(admin, owner, `Muted ${owner.username}`)
  await addMember(admin, reader, mutedServer.id)
  const { error: muteError } = await readerClient.rpc('update_server_notification_settings', {
    p_server_id: mutedServer.id,
    p_changes: { muted: true },
  })
  if (muteError) throw new Error(`mute: ${muteError.message}`)
  unreadServer = await seedServer(admin, owner, `Unread ${owner.username}`)
  await addMember(admin, reader, unreadServer.id)
  await post(ownerClient, owner, unreadServer.generalChannelId, 'unread elsewhere')

  conversation.owner = await directConversation(owner, reader, 'hello from the owner')
  conversation.friend = await directConversation(friend, reader, 'hello from a friend')
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
  await deleteUser(admin, reader)
  await deleteUser(admin, friend)
})

const sidebar = (page: Page) => page.locator('nav[aria-label="Channels"]')
const announcer = (page: Page) => page.getByTestId('live-announcer-polite')

/** "name, part, part" with the space the sr-only state text leaves before its comma. */
const named = (name: string, ...parts: string[]) => {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${esc(name)}\\s?${parts.map((p) => `, ${esc(p)}`).join('')}$`)
}

const channelLink = (page: Page, name: string) => sidebar(page).getByRole('link', { name: new RegExp(`^${name}\\s?,`) })

async function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el) return ''
    return (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim()
  })
}

async function expectFocused(locator: Locator) {
  await expect(locator).toBeFocused({ timeout: 5000 })
}

/** Waits out entry transitions: axe reads colours mid-fade otherwise. */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), null, { timeout: 5000 })
}

async function rowOrder(page: Page): Promise<string[]> {
  return sidebar(page).locator('.channel-item .channel-name').allTextContents()
}

test('channel list: names say type and state; one Tab stop, arrows, Space and Enter', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, reader)
  await openChannel(page, server.id, server.generalChannelId)
  const nav = sidebar(page)

  await test.step('rows name their type and state', async () => {
    await expect(channelLink(page, 'general')).toHaveAccessibleName(named('general', 'text channel'), { timeout: 20000 })
    await expect(channelLink(page, 'general')).toHaveAttribute('aria-current', 'page')
    await expect(channelLink(page, 'random')).toHaveAccessibleName(named('random', 'text channel', 'unread', '1 mention'))
    await expect(channelLink(page, 'news')).toHaveAccessibleName(named('news', 'text channel', 'unread'))
    await expect(channelLink(page, 'quiet')).toHaveAccessibleName(named('quiet', 'text channel', 'muted'))
    const voice = nav.getByRole('button', { name: named('voice chat', 'voice channel') })
    await expect(voice).toBeVisible()
    await expect(voice).toHaveAccessibleDescription('Joins the voice call')
    // "Open chat" sits beside the voice row, not inside it.
    const openChat = nav.getByRole('button', { name: 'Open chat in voice chat' })
    await expect(openChat).toHaveCount(1)
    expect(await openChat.evaluate((el) => !!el.parentElement?.closest('button, a, [role="button"]'))).toBe(false)
    await expect(nav.getByRole('list', { name: 'Threads in general' }).getByRole('link', { name: named(THREAD, 'thread') })).toBeVisible()
    await expect(nav.getByRole('heading', { name: 'Text Channels' }).getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  })

  await test.step('the list is one Tab stop, on the current channel', async () => {
    expect(await nav.locator('[data-roving-item][tabindex="0"]').count()).toBe(1)
    await expect(nav.locator('[data-roving-item][tabindex="0"]')).toHaveAttribute('aria-current', 'page')
    await nav.getByRole('button', { name: /^Nav Hub/ }).focus()
    await page.keyboard.press('Tab')
    await expectFocused(channelLink(page, 'general'))
  })

  await test.step('arrows, Home and End move between rows', async () => {
    await page.keyboard.press('ArrowDown')
    await expectFocused(nav.getByRole('link', { name: named(THREAD, 'thread') }))
    await page.keyboard.press('ArrowDown')
    await expectFocused(channelLink(page, 'random'))
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await expectFocused(channelLink(page, 'general'))
    await page.keyboard.press('Home')
    await expectFocused(nav.getByRole('button', { name: 'Text Channels' }))
    await page.keyboard.press('End')
    await expectFocused(nav.getByRole('button', { name: 'Open chat in voice chat' }))
    expect(await nav.locator('[data-roving-item][tabindex="0"]').count()).toBe(1)
  })

  await test.step('Enter collapses and expands a category', async () => {
    await page.keyboard.press('Home')
    const header = nav.getByRole('button', { name: 'Text Channels' })
    await page.keyboard.press('Enter')
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    await settled(page)
    await expectNoAxeViolations(page, { include: 'nav[aria-label="Channels"]', label: 'collapsed category' })
    await page.keyboard.press('Space')
    await expect(header).toHaveAttribute('aria-expanded', 'true')
  })

  await test.step('Space opens a channel; the switch is announced and focus is not lost', async () => {
    await channelLink(page, 'random').focus()
    await page.keyboard.press('Space')
    await page.waitForURL(new RegExp(`/chat/${server.id}/${channel.random}$`), { timeout: 15000 })
    await expect(announcer(page)).toHaveText(`#random – ${server.name}`, { timeout: 5000 })
    // The composer takes focus on a desktop channel switch; the announcement does not move it.
    const composer = page.locator('[data-testid="message-input"] .rich-text-editor')
    await expect(composer).toBeFocused()
    await expect(channelLink(page, 'random')).toHaveAttribute('aria-current', 'page')
    // Focus the app moved draws no ring; focus Tab moved does.
    await expect(composer).toHaveCSS('outline-style', 'none')
    await page.keyboard.press('Shift+Tab')
    await expect(composer).not.toBeFocused()
    await page.keyboard.press('Tab')
    await expect(composer).toBeFocused()
    await expect(composer).toHaveCSS('outline-style', 'solid')
  })

  await test.step('Enter opens a channel', async () => {
    await channelLink(page, 'news').focus()
    await page.keyboard.press('Enter')
    await page.waitForURL(new RegExp(`/chat/${server.id}/${channel.news}$`), { timeout: 15000 })
    await expect(announcer(page)).toHaveText(`#news – ${server.name}`, { timeout: 5000 })
  })

  await test.step('Enter on a thread opens it as the current page', async () => {
    const thread = nav.getByRole('link', { name: named(THREAD, 'thread') })
    await thread.focus()
    await page.keyboard.press('Enter')
    await page.waitForURL(new RegExp(`/chat/${server.id}/thread/${threadId}$`), { timeout: 15000 })
    await expect(thread).toHaveAttribute('aria-current', 'page')
  })

  await openChannel(page, server.id, server.generalChannelId)
  await page.waitForTimeout(1000)
  await expectNoAxeViolations(page, { include: 'nav[aria-label="Channels"]', label: 'channel list' })
  await expectNoAxeViolations(page, { label: 'chat with channel list' })
})

test('context menus open from the keyboard; Move up/down reorders with an announcement', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const nav = sidebar(page)
  const random = channelLink(page, 'random')
  await expect(random).toBeVisible({ timeout: 20000 })

  await test.step('Shift+F10 opens the channel menu with focus on its first item; Escape returns focus', async () => {
    await random.focus()
    await page.keyboard.press('Shift+F10')
    const menu = page.getByRole('menu', { name: 'random' })
    await expect(menu).toBeVisible()
    await expectFocused(menu.getByRole('menuitem').first())
    await page.keyboard.press('ArrowDown')
    await expectFocused(menu.getByRole('menuitem', { name: 'Copy channel ID' }))
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expectFocused(random)
  })

  await test.step('the ContextMenu key opens it too; Move up moves #random above #general', async () => {
    expect(await rowOrder(page)).toEqual(['general', 'random', 'news', 'quiet', 'voice chat'])
    await page.keyboard.press('ContextMenu')
    const menu = page.getByRole('menu', { name: 'random' })
    await expect(menu).toBeVisible()
    await page.keyboard.press('m')
    await expectFocused(menu.getByRole('menuitem', { name: /^Move up/ }))
    await page.keyboard.press('Enter')
    await expect(menu).toBeHidden()
    await expect.poll(() => rowOrder(page)).toEqual(['random', 'general', 'news', 'quiet', 'voice chat'])
    await expect(announcer(page)).toHaveText('random moved to position 1 of 4', { timeout: 5000 })
    await expectFocused(random)
    await expect.poll(async () => {
      const { data } = await admin.from('channels').select('id, order').in('id', [channel.random, server.generalChannelId])
      const order = Object.fromEntries((data ?? []).map((c) => [c.id, c.order]))
      return order[channel.random] < order[server.generalChannelId]
    }, { timeout: 15000 }).toBe(true)
  })

  await test.step('the first channel cannot move up', async () => {
    await page.keyboard.press('Shift+F10')
    const menu = page.getByRole('menu', { name: 'random' })
    await expect(menu.getByRole('menuitem', { name: /^Move up/ })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expectFocused(random)
  })

  await test.step('Alt+ArrowDown moves it back', async () => {
    await page.keyboard.press('Alt+ArrowDown')
    await expect.poll(() => rowOrder(page)).toEqual(['general', 'random', 'news', 'quiet', 'voice chat'])
    await expect(announcer(page)).toHaveText('random moved to position 2 of 4', { timeout: 5000 })
    await expectFocused(random)
  })

  await test.step('categories reorder from their menu', async () => {
    const voiceHeader = nav.getByRole('button', { name: 'Voice Channels' })
    await voiceHeader.focus()
    await page.keyboard.press('Shift+F10')
    const menu = page.getByRole('menu', { name: 'Voice Channels' })
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: /^Move up/ }).focus()
    await page.keyboard.press('Enter')
    await expect(announcer(page)).toHaveText('Voice Channels moved to position 1 of 2', { timeout: 5000 })
    await expect.poll(() => nav.getByRole('heading').allTextContents()).toEqual(['Voice Channels', 'Text Channels'])
    await expectFocused(nav.getByRole('button', { name: 'Voice Channels' }))
    await page.keyboard.press('Alt+ArrowDown')
    await expect.poll(() => nav.getByRole('heading').allTextContents()).toEqual(['Text Channels', 'Voice Channels'])
    await expectFocused(nav.getByRole('button', { name: 'Voice Channels' }))
  })

  await test.step('a thread row opens its menu from the keyboard', async () => {
    const thread = nav.getByRole('link', { name: named(THREAD, 'thread') })
    await thread.focus()
    await page.keyboard.press('Shift+F10')
    const menu = page.getByRole('menu', { name: THREAD })
    await expect(menu).toBeVisible()
    await expectFocused(menu.getByRole('menuitem', { name: 'Leave thread' }))
    await page.keyboard.press('Tab')
    await expect(menu).toBeHidden()
    await expectFocused(thread)
  })

  await test.step('the chat header menu: arrows, a radio group, Escape back to its button', async () => {
    const more = page.locator('.chat-header').getByRole('button', { name: 'More options' })
    await more.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name: 'More options' })
    await expect(menu).toBeVisible()
    await expectFocused(menu.getByRole('menuitem').first())
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    await expect(menu.getByRole('group', { name: 'Notification level' }).getByRole('menuitemradio')).toHaveCount(4)
    await expect(menu.getByRole('menuitemradio', { checked: true })).toHaveCount(1)
    await page.keyboard.press('End')
    await expectFocused(menu.getByRole('menuitem').last())
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expectFocused(more)
    await page.keyboard.press('ArrowUp')
    await expect(menu).toBeVisible()
    await expectFocused(menu.getByRole('menuitem').last())
    await page.keyboard.press('Escape')
  })

  await test.step('the server menu: ArrowDown opens on its first item', async () => {
    const serverButton = nav.getByRole('button', { name: new RegExp(`^${server.name}`) })
    await serverButton.focus()
    await page.keyboard.press('ArrowDown')
    const menu = page.getByRole('menu', { name: server.name })
    await expect(menu).toBeVisible()
    await expectFocused(menu.getByRole('menuitem').first())
    await page.keyboard.press('ArrowUp')
    await expectFocused(menu.getByRole('menuitem').last())
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expectFocused(serverButton)
  })
})

test('server rail names mentions, unread and mute', async ({ page }) => {
  test.setTimeout(120_000)
  // The first journey read #random; a new message badges it again.
  await post(ownerClient, owner, channel.random, 'more news for random')
  await signIn(page, reader)
  await openChannel(page, server.id, server.generalChannelId)
  const rail = page.getByRole('navigation', { name: 'Servers' })
  const entry = (id: string) => rail.locator(`[data-rail-kind="server"][data-rail-id="${id}"]`)
  await expect(entry(server.id)).toHaveAccessibleName(`${server.name}, 1 mention`, { timeout: 20000 })
  await expect(entry(mutedServer.id)).toHaveAccessibleName(`${mutedServer.name}, muted`)
  await expect(entry(unreadServer.id)).toHaveAccessibleName(`${unreadServer.name}, unread`)
  await expect(entry(server.id)).toHaveAttribute('aria-current', 'page')
  // The rail keeps its own keyboard model: Enter on an entry switches servers.
  await entry(unreadServer.id).focus()
  await page.keyboard.press('Enter')
  await page.waitForURL(new RegExp(`/chat/${unreadServer.id}`), { timeout: 15000 })
  await expectNoAxeViolations(page, { include: 'nav[aria-label="Servers"]', label: 'server rail' })
})

test('DM list: a row is a link, Enter opens it; dismiss is a separate button and undoable', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, reader)
  await page.goto('/dm')
  await dismissAnnouncements(page)
  const list = page.getByRole('list', { name: 'Conversations' })
  // Name, then state (", 1 unread message") when there is any, then ". " and the preview.
  const ownerLink = list.getByRole('link', { name: new RegExp(`^${owner.displayName}\\s?[,.]`) })
  const friendLink = list.getByRole('link', { name: new RegExp(`^${friend.displayName}\\s?[,.]`) })
  await expect(ownerLink).toBeVisible({ timeout: 30000 })
  await expect(friendLink).toBeVisible()
  await expect(ownerLink).toHaveAccessibleName(new RegExp(`^${owner.displayName}\\s?, 1 unread message\\. hello from the owner$`))

  await test.step('the row is the first Tab stop in it, and Enter opens the conversation', async () => {
    await page.getByRole('button', { name: 'Create group chat' }).focus()
    await page.keyboard.press('Tab')
    const first = page.locator('[data-testid="dm-conversation-item"]').first().getByRole('link')
    await expectFocused(first)
    await page.keyboard.press('Enter')
    await page.waitForURL(/\/dm\/[0-9a-f-]{36}$/, { timeout: 15000 })
    await expect(list.getByRole('link')).toHaveCount(2)
    await expect(first).toHaveAttribute('aria-current', 'page')
  })

  const dismissOwner = list.getByRole('button', { name: `Dismiss conversation with ${owner.displayName}` })

  await test.step('dismiss follows its row and shows while the row has focus', async () => {
    await ownerLink.focus()
    await page.keyboard.press('Tab')
    await expectFocused(dismissOwner)
    await expect.poll(() => dismissOwner.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
  })

  await test.step('dismissing leaves an Undo that takes focus; Enter on it restores the row', async () => {
    // The dismiss request is held back so the Undo's request is sent while it is in flight:
    // the server must still end up with the conversation shown.
    const rpc = '**/rest/v1/rpc/set_conversation_hidden'
    await page.route(rpc, async (route) => {
      if (route.request().postDataJSON()?.p_hidden === true) await new Promise((r) => setTimeout(r, 1500))
      await route.continue()
    })
    await page.keyboard.press('Enter')
    await expect(ownerLink).toHaveCount(0)
    const undo = list.getByRole('button', { name: 'Undo' })
    await expectFocused(undo)
    await expect(undo).toHaveAccessibleDescription(`Conversation with ${owner.displayName} dismissed`)
    await page.keyboard.press('Enter')
    await expectFocused(ownerLink)
    await expect(announcer(page)).toHaveText(`Conversation with ${owner.displayName} restored`, { timeout: 5000 })
    await expect.poll(async () => {
      const { data } = await admin
        .from('conversation_participants')
        .select('hidden_at')
        .eq('conversation_id', conversation.owner)
        .eq('user_id', reader.id)
        .single()
      return data?.hidden_at ?? null
    }, { timeout: 15000 }).toBeNull()
    await page.waitForTimeout(2000)
    const { data: settled } = await admin
      .from('conversation_participants')
      .select('hidden_at')
      .eq('conversation_id', conversation.owner)
      .eq('user_id', reader.id)
      .single()
    expect(settled?.hidden_at ?? null).toBeNull()
    await page.unroute(rpc)
  })

  await test.step('a dismissal left alone persists', async () => {
    await friendLink.focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    await expect(friendLink).toHaveCount(0)
    await expect.poll(async () => {
      const { data } = await admin
        .from('conversation_participants')
        .select('hidden_at')
        .eq('conversation_id', conversation.friend)
        .eq('user_id', reader.id)
        .single()
      return data?.hidden_at ?? null
    }, { timeout: 15000 }).not.toBeNull()
    // From /dm itself: an open conversation's route lists it again.
    await page.goto('/dm')
    await dismissAnnouncements(page)
    await expect(ownerLink).toBeVisible({ timeout: 30000 })
    await expect(friendLink).toHaveCount(0)
  })

  await expectNoAxeViolations(page, { include: '[data-testid="dm-sidebar"]', label: 'DM list' })
})

test('member list: labelled search with a named clear button; rows name presence; headers expand', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, reader)
  await openChannel(page, server.id, server.generalChannelId)
  const members = page.getByRole('complementary', { name: 'Members' })
  const list = members.getByRole('list', { name: 'Member list' })
  await expect(list).toBeVisible({ timeout: 20000 })

  await test.step('rows name the member and their presence; avatars are decorative', async () => {
    await expect(list.getByRole('button', { name: new RegExp(`^${reader.displayName}\\s?, Online\\.`) })).toBeVisible({ timeout: 20000 })
    await expect(list.getByRole('button', { name: new RegExp(`^${owner.displayName}\\s?, Offline\\.`) })).toBeVisible()
    expect(await list.getByRole('img').count()).toBe(0)
  })

  await test.step('group headers are buttons with aria-expanded', async () => {
    const offline = list.getByRole('button', { name: 'Offline, 1 member' })
    await expect(offline).toHaveAttribute('aria-expanded', 'true')
    await offline.focus()
    await page.keyboard.press('Enter')
    await expect(offline).toHaveAttribute('aria-expanded', 'false')
    await expect(list.getByRole('button', { name: new RegExp(`^${owner.displayName}`) })).toHaveCount(0)
    await page.keyboard.press('Enter')
    await expect(offline).toHaveAttribute('aria-expanded', 'true')
  })

  await test.step('one Tab stop; arrows move between headers and members', async () => {
    expect(await list.locator('[data-member-item][tabindex="0"]').count()).toBe(1)
    await list.getByRole('button', { name: 'Online, 1 member' }).focus()
    await page.keyboard.press('ArrowDown')
    expect(await focusedName(page)).toMatch(new RegExp(`^${reader.displayName}`))
    await page.keyboard.press('End')
    await expect.poll(() => focusedName(page)).toMatch(new RegExp(`^${owner.displayName}`))
  })

  await test.step('the search is labelled, the result count is announced, Clear search is named', async () => {
    const search = members.getByRole('textbox', { name: 'Search members' })
    await search.fill(owner.username)
    await expect(announcer(page)).toHaveText('1 member found', { timeout: 5000 })
    const clear = members.getByRole('button', { name: 'Clear search' })
    await clear.click()
    await expect(search).toHaveValue('')
    await expectFocused(search)
  })

  await expectNoAxeViolations(page, { include: 'aside[aria-label="Members"]', label: 'member list' })
})

test('Create channel: the channel type is a native radio group', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const header = sidebar(page).getByRole('button', { name: 'Text Channels' })
  await header.focus()
  await page.keyboard.press('Shift+F10')
  await page.getByRole('menu', { name: 'Text Channels' }).getByRole('menuitem', { name: 'Create channel' }).focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Create channel' })
  await expect(dialog).toBeVisible({ timeout: 10000 })
  const group = dialog.getByRole('group', { name: 'Channel type' })
  const text = group.getByRole('radio', { name: 'Text' })
  const voice = group.getByRole('radio', { name: 'Voice' })
  await expect(text).toBeChecked()
  await expect(voice).not.toBeChecked()
  await expect(voice).toHaveAccessibleDescription(/./)
  await text.focus()
  await page.keyboard.press('ArrowDown')
  await expect(voice).toBeChecked()
  await expect(voice).toBeFocused()
  await settled(page)
  await expectNoAxeViolations(page, { include: '[role="dialog"]', label: 'create channel' })
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('thread panel: a modal dialog; focus moves in, Escape closes and returns to View Thread', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, reader)
  await openChannel(page, server.id, server.generalChannelId)
  // The panel reads the reader's membership after it opens. Held until the options menu
  // holds focus, the answer must not replace the item focus sits on.
  let releaseMembership!: () => void
  const membershipHeld = new Promise<void>((resolve) => { releaseMembership = resolve })
  await page.route('**/rest/v1/thread_members*', async (route) => {
    await membershipHeld
    await route.continue()
  })
  const view = page.locator('[data-testid="message-list"]').getByRole('button', { name: /View Thread/ })
  await expect(view).toBeVisible({ timeout: 30000 })
  await view.focus()
  await page.keyboard.press('Enter')
  const panel = page.getByRole('dialog', { name: THREAD })
  await expect(panel).toBeVisible({ timeout: 15000 })
  await expect(panel).toHaveAttribute('aria-modal', 'true')
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true)
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true)
  }

  await test.step('the options menu follows the menu pattern inside the panel', async () => {
    const options = panel.getByRole('button', { name: 'Thread options' })
    await options.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name: 'Thread options' })
    await expect(menu).toBeVisible()
    await expectFocused(menu.getByRole('menuitem').first())
    const membership = page.waitForResponse((r) => r.url().includes('/rest/v1/thread_members'))
    releaseMembership()
    await membership
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect(menu.getByRole('menuitem', { name: /Join thread/ })).toBeVisible()
    await expectFocused(menu.getByRole('menuitem').first())
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(panel).toBeVisible()
    await expectFocused(options)
  })

  await settled(page)
  await expectNoAxeViolations(page, { include: '[role="dialog"]', label: 'thread panel' })
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await expectFocused(view)
})

test('pinned messages and all threads open as dialogs and return focus', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, reader)
  await openChannel(page, server.id, server.generalChannelId)
  const header = page.locator('.chat-header')

  const pinned = header.getByRole('button', { name: 'Pinned messages' })
  await pinned.focus()
  await page.keyboard.press('Enter')
  const pins = page.getByRole('dialog', { name: 'Pinned messages' })
  await expect(pins).toBeVisible({ timeout: 10000 })
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(pins).toBeHidden()
  await expectFocused(pinned)

  const threads = header.getByRole('button', { name: 'View all threads' })
  await threads.focus()
  await page.keyboard.press('Enter')
  const all = page.getByRole('dialog', { name: 'Threads' })
  await expect(all).toBeVisible({ timeout: 10000 })
  await expect(all.getByRole('textbox', { name: 'Search for thread name' })).toBeFocused()
  await settled(page)
  await expectNoAxeViolations(page, { include: '[role="dialog"]', label: 'all threads' })
  await page.keyboard.press('Escape')
  await expect(all).toBeHidden()
  await expectFocused(threads)
})
