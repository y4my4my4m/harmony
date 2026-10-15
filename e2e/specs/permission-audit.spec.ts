// Journey: the server permissions outside message-content-permissions.spec.ts and
// voice-moderation.spec.ts, each refused without it and honoured with it, at the database
// and in the UI that offers it.
//
// - A member holding none of them is refused at every enforcement point; a moderator
//   holding them passes. ADMINISTRATOR holds them all. A stranger holds nothing through
//   @everyone, and a channel hidden from a holder grants nothing in it. A channel Deny of
//   SEND_MESSAGES refuses the member's message there.
// - CREATE_PRIVATE_THREADS alone starts no thread: Harmony threads are public.
// - The member sees no hidden channel, no Create thread or Pin action, and read-only
//   composers in #readonly and in the thread (SEND_MESSAGES_IN_THREADS); the moderator sees
//   both actions, pins, and writes in the thread.
// - A timed-out member adds and joins no reaction and starts no thread, at the database and
//   with the timeout notice in the UI; once the timeout is lifted they react again.
// - The role editor lists Administrator under Dangerous Permissions. A text channel's
//   overrides offer Manage Permissions, Manage Webhooks and Pin Messages; a voice
//   channel's leave out Manage Webhooks; neither offers Create Private Threads.

import { test, expect, type Page } from '@playwright/test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  addChannel,
  addMember,
  adminClient,
  channelRow,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()

// Bit positions in permission_bit_names().
const BIT = {
  ADMINISTRATOR: 0,
  VIEW_CHANNEL: 1,
  MANAGE_CHANNELS: 2,
  MANAGE_ROLES: 3,
  MANAGE_EMOJIS: 4,
  VIEW_AUDIT_LOG: 5,
  MANAGE_WEBHOOKS: 6,
  MANAGE_SERVER: 7,
  CREATE_INVITE: 8,
  KICK_MEMBERS: 9,
  BAN_MEMBERS: 10,
  TIMEOUT_MEMBERS: 11,
  SEND_MESSAGES: 12,
  SEND_MESSAGES_IN_THREADS: 13,
  CREATE_PUBLIC_THREADS: 14,
  CREATE_PRIVATE_THREADS: 15,
  EMBED_LINKS: 16,
  ATTACH_FILES: 17,
  ADD_REACTIONS: 18,
  MENTION_EVERYONE: 20,
  MANAGE_MESSAGES: 21,
  READ_MESSAGE_HISTORY: 22,
  PIN_MESSAGES: 23,
} as const
type Bit = keyof typeof BIT
const mask = (...names: Bit[]) => names.reduce((m, n) => m + 2 ** BIT[n], 0)

// @everyone: reading and plain messages only.
const EVERYONE = mask('VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY', 'EMBED_LINKS', 'ADD_REACTIONS')
const MODERATOR = mask(
  'MANAGE_CHANNELS', 'MANAGE_ROLES', 'MANAGE_EMOJIS', 'VIEW_AUDIT_LOG', 'MANAGE_WEBHOOKS',
  'MANAGE_SERVER', 'CREATE_INVITE', 'KICK_MEMBERS', 'BAN_MEMBERS', 'TIMEOUT_MEMBERS',
  'SEND_MESSAGES_IN_THREADS', 'CREATE_PUBLIC_THREADS', 'ATTACH_FILES', 'MENTION_EVERYONE',
  'MANAGE_MESSAGES', 'PIN_MESSAGES',
)

let owner: SpecUser
let member: SpecUser
let moderator: SpecUser
let privy: SpecUser
let boss: SpecUser
let stranger: SpecUser
let kickee: SpecUser
let banee: SpecUser
let timed: SpecUser
let server: SeededServer
let everyoneId: string
let hiddenId: string
let readonlyId: string
let voiceId: string
let threadId: string
let pinTargetId: string
let parentId: string
let hiddenMessageId: string

async function role(name: string, position: number, permissions: number, holders: SpecUser[]): Promise<void> {
  const { data, error } = await admin
    .from('server_roles')
    .insert({ server_id: server.id, name, position, permissions })
    .select('id')
    .single()
  if (error || !data) throw new Error(`role ${name}: ${error?.message}`)
  for (const holder of holders) {
    const { error: assignError } = await admin
      .from('user_roles')
      .insert({ user_id: holder.id, role_id: data.id, server_id: server.id })
    if (assignError) throw new Error(`assign ${name}: ${assignError.message}`)
  }
}

async function post(user: SpecUser, channelId: string, text: string, thread?: string): Promise<string> {
  const client = await userClient(user)
  const { data, error } = await client
    .from('messages')
    .insert({ channel_id: channelId, thread_id: thread ?? null, user_id: user.id, content: [{ type: 'text', text }] })
    .select('id')
    .single()
  if (error || !data) throw new Error(`post: ${error?.message}`)
  return data.id
}

async function setEveryone(permissions: number): Promise<void> {
  const { error } = await admin.from('server_roles').update({ permissions }).eq('id', everyoneId)
  if (error) throw new Error(`@everyone: ${error.message}`)
}

async function isPinned(messageId: string): Promise<boolean> {
  const { data } = await admin.from('messages').select('is_pinned').eq('id', messageId).single()
  return data?.is_pinned === true
}

async function mentionNotified(user: SpecUser, messageId: string): Promise<boolean> {
  const { data } = await admin
    .from('notifications')
    .select('id')
    .eq('user_id', user.id)
    .eq('type', 'mention')
    .eq('data->>message_id', messageId)
  return (data?.length ?? 0) > 0
}

test.beforeAll(async () => {
  owner = await createUser(admin, 'paown')
  member = await createUser(admin, 'pamem')
  moderator = await createUser(admin, 'pamod')
  privy = await createUser(admin, 'papriv')
  boss = await createUser(admin, 'paboss')
  stranger = await createUser(admin, 'pastr')
  kickee = await createUser(admin, 'pakick')
  timed = await createUser(admin, 'patime')
  banee = await createUser(admin, 'paban')
  server = await seedServer(admin, owner, `Audit ${owner.username}`)
  for (const user of [member, moderator, privy, boss, kickee, banee, timed]) await addMember(admin, user, server.id)

  const { data: everyone } = await admin
    .from('server_roles')
    .select('id')
    .eq('server_id', server.id)
    .eq('is_default', true)
    .single()
  everyoneId = everyone!.id
  await setEveryone(EVERYONE)
  await role('Moderators', 10, MODERATOR, [moderator])
  await role('Privy', 2, mask('CREATE_PRIVATE_THREADS'), [privy])
  await role('Bosses', 20, mask('ADMINISTRATOR'), [boss])
  await role('Threaders', 1, mask('CREATE_PUBLIC_THREADS'), [timed])

  hiddenId = await addChannel(admin, server, 'hidden')
  const { error: overrideError } = await admin.from('channel_permission_overrides').insert({
    channel_id: hiddenId, target_type: 'role', role_id: everyoneId,
    allow_permissions: 0, deny_permissions: 2 ** BIT.VIEW_CHANNEL,
  })
  if (overrideError) throw new Error(`override: ${overrideError.message}`)
  readonlyId = await addChannel(admin, server, 'readonly')
  const { error: readonlyError } = await admin.from('channel_permission_overrides').insert({
    channel_id: readonlyId, target_type: 'role', role_id: everyoneId,
    allow_permissions: 0, deny_permissions: 2 ** BIT.SEND_MESSAGES,
  })
  if (readonlyError) throw new Error(`override: ${readonlyError.message}`)
  const { data: voice } = await admin
    .from('channels')
    .select('id')
    .eq('server_id', server.id)
    .eq('type', 1)
    .limit(1)
    .single()
  voiceId = voice!.id

  pinTargetId = await post(owner, server.generalChannelId, 'Pin target')
  parentId = await post(owner, server.generalChannelId, 'Thread parent')
  hiddenMessageId = await post(owner, hiddenId, 'Hidden notice')
  const ownerClient = await userClient(owner)
  const { data: created, error: threadError } = await ownerClient.rpc('create_channel_thread', {
    p_channel_id: server.generalChannelId, p_name: 'Side talk',
  })
  if (threadError) throw new Error(`thread: ${threadError.message}`)
  threadId = created as string
  await post(owner, server.generalChannelId, 'Owner in the thread', threadId)
})

test.afterAll(async () => {
  for (const user of [owner, member, moderator, privy, boss, stranger, kickee, banee, timed]) await deleteUser(admin, user)
})

/** One enforcement point: the member is refused, the moderator passes. */
async function refusedThenGranted(
  name: string,
  call: (client: SupabaseClient, as: SpecUser) => PromiseLike<{ error: { code?: string; message: string } | null }>,
  refusal: { code?: string; message?: string },
  plain: SupabaseClient,
  holder: SupabaseClient,
) {
  await test.step(`${name}: refused without it, granted with it`, async () => {
    const refused = await call(plain, member)
    expect(refused.error, `${name} without the permission`).not.toBeNull()
    if (refusal.code) expect(refused.error?.code).toBe(refusal.code)
    if (refusal.message) expect(refused.error?.message).toBe(refusal.message)
    const granted = await call(holder, moderator)
    expect(granted.error, `${name} with the permission`).toBeNull()
  })
}

test('each permission is refused without it and honoured with it', async () => {
  test.setTimeout(120_000)
  const plain = await userClient(member)
  const holder = await userClient(moderator)
  const tag = owner.username.slice(-4)

  await refusedThenGranted('MANAGE_SERVER',
    (c) => c.rpc('update_server', { p_server_id: server.id, p_changes: { description: 'audited' } }),
    { code: '42501', message: 'Missing permission: MANAGE_SERVER' }, plain, holder)
  await refusedThenGranted('VIEW_AUDIT_LOG',
    (c) => c.rpc('get_server_audit_log', { p_server_id: server.id }),
    { code: '42501', message: 'VIEW_AUDIT_LOG required' }, plain, holder)
  await refusedThenGranted('MANAGE_EMOJIS',
    (c, as) => c.from('emojis').insert({
      name: `audit${as.username.slice(-4)}`, url: 'https://example.com/e.png',
      server_id: server.id, scope: 'server', uploader: as.id,
    }),
    { code: '42501' }, plain, holder)
  await refusedThenGranted('MANAGE_WEBHOOKS',
    (c) => c.rpc('create_channel_webhook', { p_channel_id: server.generalChannelId, p_name: 'Audit hook' }),
    { code: '42501', message: 'Permission denied: MANAGE_WEBHOOKS required' }, plain, holder)
  await refusedThenGranted('CREATE_INVITE',
    (c, as) => c.from('invites').insert({ code: `audit${as.username}`, server_id: server.id, created_by: as.id }),
    { code: '42501' }, plain, holder)
  await refusedThenGranted('MANAGE_ROLES',
    (c, as) => c.from('server_roles').insert({ server_id: server.id, name: `by ${as.username}`, position: 1, permissions: 0 }),
    { code: '42501' }, plain, holder)
  await refusedThenGranted('MANAGE_CHANNELS',
    (c, as) => c.from('channels').insert({ server_id: server.id, name: `made-by-${as.username.slice(0, 8)}`, type: 0 }),
    { code: '42501' }, plain, holder)
  await refusedThenGranted('KICK_MEMBERS',
    (c) => c.rpc('kick_server_member', { p_server_id: server.id, p_user_id: kickee.id }),
    { message: 'Missing KICK_MEMBERS permission' }, plain, holder)
  await refusedThenGranted('BAN_MEMBERS',
    (c) => c.rpc('ban_server_member', { p_server_id: server.id, p_user_id: banee.id }),
    { message: 'Missing BAN_MEMBERS permission' }, plain, holder)
  await refusedThenGranted('BAN_MEMBERS (ban list)',
    (c) => c.rpc('get_server_bans', { p_server_id: server.id }),
    { message: 'Missing BAN_MEMBERS permission' }, plain, holder)
  await refusedThenGranted('TIMEOUT_MEMBERS',
    (c) => c.rpc('set_server_member_timeout', { p_server_id: server.id, p_user_id: privy.id, p_seconds: 0 }),
    { code: '42501', message: 'Missing permission: TIMEOUT_MEMBERS' }, plain, holder)
  await refusedThenGranted('PIN_MESSAGES',
    (c) => c.rpc('pin_message', { p_message_id: pinTargetId }),
    { message: 'Permission denied: cannot pin messages' }, plain, holder)
  await refusedThenGranted('SEND_MESSAGES_IN_THREADS',
    (c, as) => c.from('messages').insert({
      channel_id: server.generalChannelId, thread_id: threadId, user_id: as.id,
      content: [{ type: 'text', text: `${as.username} in the thread` }],
    }),
    { code: '42501' }, plain, holder)
  await refusedThenGranted('CREATE_PUBLIC_THREADS',
    (c, as) => c.rpc('create_channel_thread', { p_channel_id: server.generalChannelId, p_name: `${as.username} ${tag}` }),
    { code: '42501', message: 'Unauthorized: CREATE_PUBLIC_THREADS required' }, plain, holder)

  await test.step('SEND_MESSAGES: a channel Deny refuses the member there', async () => {
    const refused = await plain.from('messages')
      .insert({ channel_id: readonlyId, user_id: member.id, content: [{ type: 'text', text: 'let me in' }] })
    expect(refused.error?.code).toBe('42501')
    const elsewhere = await plain.from('messages')
      .insert({ channel_id: server.generalChannelId, user_id: member.id, content: [{ type: 'text', text: 'hello' }] })
    expect(elsewhere.error).toBeNull()
  })

  await test.step('CREATE_PRIVATE_THREADS alone starts no thread', async () => {
    const client = await userClient(privy)
    const standalone = await client.rpc('create_channel_thread', { p_channel_id: server.generalChannelId, p_name: 'private?' })
    expect(standalone.error?.message).toBe('Unauthorized: CREATE_PUBLIC_THREADS required')
    const fromMessage = await client.rpc('create_thread', { p_message_id: parentId, p_name: 'private?' })
    expect(fromMessage.error?.message).toBe('Unauthorized: CREATE_PUBLIC_THREADS required')
  })

  await test.step('MENTION_EVERYONE: only the holder\'s @everyone notifies', async () => {
    const mention = (user: SpecUser) => [
      { type: 'role_mention', roleId: everyoneId },
      { type: 'text', text: ` from ${user.username}` },
    ]
    const { data: quiet } = await plain.from('messages')
      .insert({ channel_id: server.generalChannelId, user_id: member.id, content: mention(member) })
      .select('id').single()
    const { data: loud } = await holder.from('messages')
      .insert({ channel_id: server.generalChannelId, user_id: moderator.id, content: mention(moderator) })
      .select('id').single()
    await expect.poll(() => mentionNotified(owner, loud!.id), { timeout: 15000 }).toBe(true)
    expect(await mentionNotified(owner, quiet!.id)).toBe(false)
  })

  await test.step('ADMINISTRATOR holds every permission, in a hidden channel too', async () => {
    const client = await userClient(boss)
    expect((await client.rpc('get_server_audit_log', { p_server_id: server.id })).error).toBeNull()
    expect((await client.rpc('pin_message', { p_message_id: hiddenMessageId })).error).toBeNull()
    expect(await isPinned(hiddenMessageId)).toBe(true)
    expect((await client.rpc('unpin_message', { p_message_id: hiddenMessageId })).error).toBeNull()
  })

  await test.step('a channel hidden from a holder grants nothing in it', async () => {
    const pinned = await holder.rpc('pin_message', { p_message_id: hiddenMessageId })
    expect(pinned.error?.message).toBe('Permission denied: cannot pin messages')
    const suppressed = await holder.rpc('set_message_embeds_suppressed', { p_message_id: hiddenMessageId, p_suppressed: true })
    expect(suppressed.error?.code).toBe('42501')
    expect(await isPinned(hiddenMessageId)).toBe(false)
  })

  await test.step('a stranger holds nothing through @everyone', async () => {
    await setEveryone(EVERYONE | mask('VIEW_AUDIT_LOG', 'PIN_MESSAGES'))
    try {
      const client = await userClient(stranger)
      const log = await client.rpc('get_server_audit_log', { p_server_id: server.id })
      expect(log.error?.message).toBe('VIEW_AUDIT_LOG required')
      const pin = await client.rpc('unpin_message', { p_message_id: pinTargetId })
      expect(pin.error?.message).toBe('Permission denied: cannot unpin messages')
      expect(await isPinned(pinTargetId)).toBe(true)
    } finally {
      await setEveryone(EVERYONE)
    }
  })
})

const rowOf = (page: Page, text: string) => messageList(page).getByRole('article').filter({ hasText: text })
const messageMenu = (page: Page) => page.getByRole('menu', { name: 'Message options' })

/** Resolves once the viewer's permissions in `channelId` have been answered. */
function channelPermissionsLoaded(page: Page, channelId: string) {
  return page.waitForResponse(
    (response) => response.url().includes('/rest/v1/rpc/get_user_permissions')
      && (response.request().postData() ?? '').includes(channelId),
    { timeout: 120000 },
  )
}

test('without thread and pin permissions the member gets neither action and a read-only thread', async ({ page }) => {
  test.setTimeout(150_000)
  const loaded = channelPermissionsLoaded(page, server.generalChannelId)
  await signIn(page, member)
  await openChannel(page, server.id, server.generalChannelId)
  await loaded

  await test.step('the hidden channel is not listed', async () => {
    await expect(channelRow(page, 'readonly')).toBeVisible({ timeout: 15000 })
    await expect(channelRow(page, 'hidden')).toHaveCount(0)
  })

  await test.step('no Create thread on the message, nor Pin in its menu', async () => {
    const row = rowOf(page, 'Thread parent')
    await expect(row).toBeVisible({ timeout: 30000 })
    await row.hover()
    await expect(row.getByRole('button', { name: 'Reply', exact: true })).toBeVisible()
    await expect(row.getByRole('button', { name: 'Create thread', exact: true })).toHaveCount(0)
    await row.click({ button: 'right' })
    await expect(messageMenu(page).getByRole('menuitem', { name: 'Reply' })).toBeVisible()
    await expect(messageMenu(page).getByRole('menuitem', { name: 'Create thread' })).toHaveCount(0)
    await expect(messageMenu(page).getByRole('menuitem', { name: 'Pin message' })).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  await test.step('the #readonly composer is read-only', async () => {
    const readonlyLoaded = channelPermissionsLoaded(page, readonlyId)
    await openChannel(page, server.id, readonlyId)
    await readonlyLoaded
    await expect(page.getByText('You do not have permission to send messages in this channel.')).toBeVisible({ timeout: 15000 })
  })

  await test.step('the thread composer is read-only without SEND_MESSAGES_IN_THREADS', async () => {
    await page.goto(`/chat/${server.id}/thread/${threadId}`)
    await expect(page.getByText('Owner in the thread')).toBeVisible({ timeout: 30000 })
    await expect(page.getByText('You do not have permission to send messages in this thread.')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('[data-testid="message-input"] .rich-text-editor')).toHaveCount(0)
  })
})

test('the moderator starts threads, pins, and writes in a thread', async ({ page }) => {
  test.setTimeout(150_000)
  await admin.from('messages').update({ is_pinned: false, pinned_at: null, pinned_by: null }).eq('id', parentId)
  const loaded = channelPermissionsLoaded(page, server.generalChannelId)
  await signIn(page, moderator)
  await openChannel(page, server.id, server.generalChannelId)
  await loaded

  await test.step('Create thread on the message and Pin in its menu', async () => {
    const row = rowOf(page, 'Thread parent')
    await expect(row).toBeVisible({ timeout: 30000 })
    await row.hover()
    await expect(row.getByRole('button', { name: 'Create thread', exact: true })).toBeVisible({ timeout: 15000 })
    await row.click({ button: 'right' })
    await expect(messageMenu(page).getByRole('menuitem', { name: 'Create thread' })).toBeVisible()
    await messageMenu(page).getByRole('menuitem', { name: 'Pin message' }).click()
    await expect.poll(() => isPinned(parentId), { timeout: 15000 }).toBe(true)
  })

  await test.step('the thread composer accepts a reply', async () => {
    await page.goto(`/chat/${server.id}/thread/${threadId}`)
    await expect(page.getByText('Owner in the thread')).toBeVisible({ timeout: 30000 })
    const editor = page.locator('[data-testid="message-input"] .rich-text-editor')
    await expect(editor).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('You do not have permission to send messages in this thread.')).toHaveCount(0)
  })
})

test('a timed-out member reacts to nothing and starts no thread', async ({ page }) => {
  test.setTimeout(150_000)
  const holder = await userClient(moderator)
  const setTimeoutFor = async (seconds: number) => {
    const { error } = await holder.rpc('set_server_member_timeout', {
      p_server_id: server.id, p_user_id: timed.id, p_seconds: seconds, p_reason: null,
    })
    expect(error).toBeNull()
  }
  const ownerClient = await userClient(owner)
  await ownerClient.from('reactions').insert({ message_id: pinTargetId, user_id: owner.id, custom_emoji_content: '🐝' })
  const client = await userClient(timed)
  const react = (emoji: string) =>
    client.from('reactions').insert({ message_id: pinTargetId, user_id: timed.id, custom_emoji_content: emoji })

  await setTimeoutFor(600)
  try {
    await test.step('the database refuses reactions and threads', async () => {
      const timedOut = /^MEMBER_TIMED_OUT:\d+$/
      expect((await react('🐝')).error?.message).toMatch(timedOut)
      expect((await react('🐢')).error?.message).toMatch(timedOut)
      const standalone = await client.rpc('create_channel_thread', { p_channel_id: server.generalChannelId, p_name: 'while out' })
      expect(standalone.error?.message).toMatch(timedOut)
      const fromMessage = await client.rpc('create_thread', { p_message_id: parentId, p_name: 'while out' })
      expect(fromMessage.error?.message).toMatch(timedOut)
    })

    await signIn(page, timed)
    await openChannel(page, server.id, server.generalChannelId)
    const notice = /You are timed out in this server until .* and cannot send messages, react or start threads\./

    await test.step('a reaction from the menu shows the timeout notice', async () => {
      const row = rowOf(page, 'Pin target')
      await expect(row).toBeVisible({ timeout: 30000 })
      await row.click({ button: 'right' })
      const quick = messageMenu(page).locator('.quick-reaction-btn:not(.more-btn)').first()
      await expect(quick).toBeVisible()
      await quick.click()
      await expect(page.getByText(notice).first()).toBeVisible({ timeout: 15000 })
      const { data } = await admin.from('reactions').select('user_id').eq('message_id', pinTargetId).eq('user_id', timed.id)
      expect(data).toEqual([])
    })

    await test.step('New thread in the threads list shows the timeout notice', async () => {
      await page.locator('.chat-header .threads-btn').click()
      const modal = page.locator('.threads-modal')
      await expect(modal).toBeVisible({ timeout: 15000 })
      await modal.locator('.new-thread-btn').click()
      await modal.locator('#new-thread-name').fill('while out')
      await modal.locator('.new-thread-submit').click()
      await expect(modal.locator('.new-thread-error')).toHaveText(notice, { timeout: 15000 })
    })
  } finally {
    await setTimeoutFor(0)
  }

  await test.step('once the timeout is lifted they react again', async () => {
    expect((await react('🐝')).error).toBeNull()
  })
})

test('the role editor and channel overrides list the permissions they govern', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, owner)

  await test.step('Administrator sits under Dangerous Permissions', async () => {
    await page.goto(`/server/${server.id}?section=roles`)
    const everyonePill = page.locator('.role-rail .role-pill').filter({ has: page.locator('.role-badge.default') })
    await expect(everyonePill).toBeVisible({ timeout: 30000 })
    await everyonePill.click()
    await page.locator('.editor-tabs .tab-btn').filter({ hasText: 'Permissions' }).click()
    const dangerous = page.locator('.perm-group').filter({ has: page.getByRole('heading', { name: 'Dangerous Permissions' }) })
    await expect(dangerous).toBeVisible({ timeout: 15000 })
    await expect(dangerous.locator('.perm-row-label')).toHaveText(['Administrator'])
    const privateThreads = page.locator('.perm-row').filter({ has: page.locator('.perm-row-label', { hasText: 'Create Private Threads' }) })
    await expect(privateThreads.locator('.perm-row-desc')).toHaveText(/Grants nothing/)
  })

  const openOverrides = async (name: string) => {
    await openChannel(page, server.id, server.generalChannelId)
    // The row holds the channel's threads too; the name is the channel's own target.
    await channelRow(page, name).locator('.channel-name').getByText(name, { exact: true }).first().click({ button: 'right' })
    await page.locator('.context-menu .context-menu-item').filter({ hasText: 'Edit channel' }).click()
    const dialog = page.getByRole('dialog', { name: 'Edit channel' })
    await expect(dialog).toBeVisible({ timeout: 15000 })
    await dialog.getByRole('tab', { name: 'Permissions' }).click()
    await expect(dialog.getByRole('radiogroup', { name: 'View Channel' })).toBeVisible({ timeout: 15000 })
    return dialog
  }

  await test.step('a text channel offers Manage Permissions, Manage Webhooks and Pin Messages', async () => {
    const dialog = await openOverrides('general')
    for (const name of ['Manage Permissions', 'Manage Webhooks', 'Pin Messages']) {
      await expect(dialog.getByRole('radiogroup', { name, exact: true })).toBeVisible()
    }
    await expect(dialog.getByRole('radiogroup', { name: 'Create Private Threads' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden({ timeout: 15000 })
  })

  await test.step('a voice channel leaves out Manage Webhooks', async () => {
    const { data: voice } = await admin.from('channels').select('name').eq('id', voiceId).single()
    const dialog = await openOverrides(voice!.name)
    await expect(dialog.getByRole('radiogroup', { name: 'Manage Permissions', exact: true })).toBeVisible()
    await expect(dialog.getByRole('radiogroup', { name: 'Connect', exact: true })).toBeVisible()
    await expect(dialog.getByRole('radiogroup', { name: 'Manage Webhooks' })).toHaveCount(0)
    await expect(dialog.getByRole('radiogroup', { name: 'Create Private Threads' })).toHaveCount(0)
  })
})
