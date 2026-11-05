// Journey: the call's side chat stays usable while the main window shows another chat.
//
// The call view's Chat opens the voice channel's chat without moving the main window. With the
// call view minimized, the open chat docks beside the main window's chat, under the dock's Chat
// toggle; it follows the main window to other channels and to direct messages, and gives way
// when the main window shows the voice channel itself. Popped out, the call window's chat keeps
// the voice channel while the main window moves. A direct message call's chat works the same
// beside another conversation.
//
// The stack has no LiveKit and no realtime: the voice store is set as a joined call leaves it,
// and the chat stores are handed the realtime insert a member's message would deliver.

import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  addChannel,
  addMember,
  adminClient,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'
import { expectNoAxeViolations } from './a11y'

test.use({ serviceWorkers: 'block' })

const admin = adminClient()
let owner: SpecUser
let member: SpecUser
let server: SeededServer
let loungeId: string
let otherId: string
let callConversation: string
let otherConversation: string

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

test.beforeAll(async () => {
  owner = await createUser(admin, 'ccbo')
  member = await createUser(admin, 'ccbm')
  server = await seedServer(admin, owner, `Call chat beside ${owner.username}`)
  await addMember(admin, member, server.id)
  const { data: general } = await admin.from('channels').select('category').eq('id', server.generalChannelId).single()
  const { data, error } = await admin
    .from('channels')
    .insert({ server_id: server.id, name: 'lounge', type: 1, category: general?.category ?? null })
    .select('id')
    .single()
  if (error || !data) throw new Error(`lounge: ${error?.message}`)
  loungeId = data.id
  otherId = await addChannel(admin, server, 'other-chat')
  const { error: seedError } = await admin.from('messages').insert([
    { channel_id: loungeId, user_id: member.id, content: [{ type: 'text', text: 'Lounge hello' }], created_at: ago(60_000) },
    { channel_id: server.generalChannelId, user_id: member.id, content: [{ type: 'text', text: 'General hello' }], created_at: ago(60_000) },
    { channel_id: otherId, user_id: member.id, content: [{ type: 'text', text: 'Other hello' }], created_at: ago(60_000) },
  ])
  if (seedError) throw new Error(`seed messages: ${seedError.message}`)

  const conversation = async (text: string) => {
    const { data: dm, error: dmError } = await admin.from('conversations').insert({ type: 'direct', created_by: owner.id }).select('id').single()
    if (dmError || !dm) throw new Error(`conversation: ${dmError?.message}`)
    await admin.from('conversation_participants').insert([
      { conversation_id: dm.id, user_id: owner.id },
      { conversation_id: dm.id, user_id: member.id },
    ])
    const { error: msgError } = await admin.from('messages').insert({ conversation_id: dm.id, user_id: member.id, content: [{ type: 'text', text }], created_at: ago(60_000) })
    if (msgError) throw new Error(`dm message: ${msgError.message}`)
    return dm.id as string
  }
  callConversation = await conversation('Call DM hello')
  otherConversation = await conversation('Other DM hello')
})

test.afterAll(async () => {
  for (const id of [callConversation, otherConversation]) {
    if (id) await admin.from('conversations').delete().eq('id', id)
  }
  if (server) await admin.from('servers').delete().eq('id', server.id)
  await deleteUser(admin, member)
  await deleteUser(admin, owner)
})

type StoreHandle = { $patch: (fn: (state: Record<string, any>) => void) => void; [key: string]: any }

/** The voice store as a joined call leaves it: the lounge, or a direct message call in `conversation`. */
async function enterVoice(page: Page, opts: { selfId: string; others: string[]; conversation?: string }) {
  await page.evaluate((o) => {
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, StoreHandle> } } } }
    }
    const voice = root.__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel')
    if (!voice) throw new Error('voice store not created')
    const state = (userId: string) => ({
      userId, isAudioEnabled: true, isVideoEnabled: false, isScreenSharing: false,
      isMuted: false, isDeafened: false, isSpeaking: false, audioLevel: 0,
    })
    voice.$patch((s) => {
      s.isConnected = true
      s.currentServerId = o.conversation ? 'dm' : o.serverId
      s.currentChannelId = o.conversation ? `dm-${o.conversation}` : o.channelId
      s.currentChannelName = o.conversation ? 'Call' : 'lounge'
      s.dmOtherUserId = o.conversation ? o.others[0] : null
      s.localState = state(o.selfId)
      s.allUsers = o.others.map(state)
    })
  }, { serverId: server.id, channelId: loungeId, conversation: undefined as string | undefined, ...opts })
}

/** The realtime insert of `text` by `userId` in the lounge, handed to the chat store. */
async function receiveLoungeMessage(page: Page, userId: string, text: string) {
  await page.evaluate(({ channelId, userId, text }) => {
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, StoreHandle> } } } }
    }
    root.__vue_app__.config.globalProperties.$pinia._s.get('chat')!.addMessageToCache({
      id: crypto.randomUUID(),
      channel_id: channelId,
      user_id: userId,
      content: [{ type: 'text', text }],
      created_at: new Date(),
    })
  }, { channelId: loungeId, userId, text })
}

const dock = (page: Page) => page.getByRole('region', { name: 'Voice connection' })
const rows = (list: Locator) => list.locator('[data-testid="message-list"] .message-item')

async function openCallView(page: Page, name: string) {
  await dock(page).getByRole('button', { name: 'Open call view' }).click()
  const view = page.getByRole('dialog', { name })
  await expect(view).toBeVisible({ timeout: 15000 })
  return view
}

async function sendFrom(list: Locator, page: Page, text: string) {
  const editor = list.locator('[data-testid="message-input"] .rich-text-editor')
  await editor.click()
  await editor.pressSequentially(text, { delay: 10 })
  await page.keyboard.press('Enter')
  const posted = rows(list).filter({ hasText: text }).last()
  await expect(posted).toBeVisible({ timeout: 30000 })
  await expect(posted).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
}

test("a voice channel's chat beside other channels and conversations", async ({ page }) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await enterVoice(page, { selfId: owner.id, others: [member.id] })

  const mainList = page.locator('main.main-content-area')
  const docked = page.getByTestId('docked-call-chat')
  const dockChat = page.getByTestId('dock-chat-toggle')

  await test.step('Chat in the call view shows the lounge while the main window stays on #general', async () => {
    const view = await openCallView(page, 'lounge')
    await view.getByTestId('call-chat-toggle').click()
    const panel = view.getByTestId('call-side-chat')
    await expect(rows(panel).filter({ hasText: 'Lounge hello' })).toBeVisible({ timeout: 30000 })
    await expect(page).toHaveURL(new RegExp(`/chat/${server.id}/${server.generalChannelId}$`))
    await expect(panel.getByTestId('call-chat-own-list')).toBeVisible()
    await sendFrom(panel, page, 'From the call view')
  })

  await test.step('minimized, the chat docks beside #general under the dock toggle', async () => {
    await page.getByRole('dialog', { name: 'lounge' }).getByRole('button', { name: 'Minimize call view' }).click()
    await expect(page.getByTestId('voice-overlay')).toHaveCount(0)
    await expect(docked).toBeVisible()
    await expect(docked).toHaveAccessibleName('lounge chat')
    await expect(rows(docked).filter({ hasText: 'From the call view' })).toBeVisible({ timeout: 30000 })
    await expect(rows(mainList).filter({ hasText: 'General hello' })).toBeVisible({ timeout: 30000 })
    await expect(rows(mainList).filter({ hasText: 'Lounge hello' })).toHaveCount(0)
    await expect(dockChat).toHaveAttribute('aria-expanded', 'true')
    // Beside the main window's list, not over it, and narrower than it.
    const chatBox = (await docked.boundingBox())!
    const mainBox = (await page.locator('main.main-content-area').boundingBox())!
    expect(mainBox.x + mainBox.width).toBeLessThanOrEqual(chatBox.x + 1)
    expect(mainBox.width).toBeGreaterThan(chatBox.width)
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'))
    await expectNoAxeViolations(page, { include: '[data-testid="docked-call-chat"]', label: 'docked call chat' })
  })

  await test.step('it follows the main window to another channel; sends and receives there', async () => {
    await page.getByRole('link', { name: /^other-chat/ }).click()
    await expect(page).toHaveURL(new RegExp(`/chat/${server.id}/${otherId}$`))
    await expect(rows(mainList).filter({ hasText: 'Other hello' })).toBeVisible({ timeout: 30000 })
    await expect(rows(docked).filter({ hasText: 'Lounge hello' })).toBeVisible()
    await sendFrom(docked, page, 'From beside other-chat')
    const { data } = await admin.from('messages').select('id').eq('channel_id', loungeId).eq('user_id', owner.id)
    expect(data).toHaveLength(2)
    await receiveLoungeMessage(page, member.id, 'Still watching?')
    await expect(rows(docked).filter({ hasText: 'Still watching?' })).toBeVisible()
    await expect(rows(mainList).filter({ hasText: 'Still watching?' })).toHaveCount(0)
  })

  await test.step('the dock toggle closes and reopens it; focus returns to the toggle', async () => {
    await dockChat.click()
    await expect(docked).toHaveCount(0)
    await expect(dockChat).toHaveAttribute('aria-expanded', 'false')
    await dockChat.click()
    await expect(docked).toBeVisible()
    await docked.getByRole('button', { name: 'Close chat' }).click()
    await expect(docked).toHaveCount(0)
    await expect(dockChat).toBeFocused()
    await dockChat.click()
    await expect(docked).toBeVisible()
  })

  await test.step('it follows the main window to a direct message', async () => {
    await page.goto(`/dm/${otherConversation}`)
    await expect(page.locator('main [data-testid="message-list"] .message-item').filter({ hasText: 'Other DM hello' })).toBeVisible({ timeout: 30000 })
    await enterVoice(page, { selfId: owner.id, others: [member.id] })
    await expect(docked).toBeVisible({ timeout: 15000 })
    await expect(rows(docked).filter({ hasText: 'From beside other-chat' })).toBeVisible({ timeout: 30000 })
  })

  await test.step("it gives way when the main window shows the lounge's chat", async () => {
    await openChannel(page, server.id, loungeId)
    await enterVoice(page, { selfId: owner.id, others: [member.id] })
    await expect(page.getByTestId('dock-mute')).toBeVisible({ timeout: 15000 })
    await expect(rows(mainList).filter({ hasText: 'From beside other-chat' })).toBeVisible({ timeout: 30000 })
    await expect(docked).toHaveCount(0)
    await expect(dockChat).toHaveCount(0)
  })

  await test.step('a narrower window or a phone has no room beside the chat', async () => {
    await openChannel(page, server.id, otherId)
    await enterVoice(page, { selfId: owner.id, others: [member.id] })
    await expect(docked).toBeVisible({ timeout: 15000 })
    for (const width of [1100, 375]) {
      await page.setViewportSize({ width, height: 812 })
      await expect(docked).toHaveCount(0)
      await expect(dockChat).toHaveCount(0)
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(docked).toBeVisible()
  })
})

test("popped out, the call window's chat keeps the lounge while the main window moves", async ({ page }) => {
  test.setTimeout(180_000)
  await page.addInitScript(() => {
    delete (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await enterVoice(page, { selfId: owner.id, others: [member.id] })
  const view = await openCallView(page, 'lounge')
  const opened = page.waitForEvent('popup')
  await view.getByRole('button', { name: 'Pop out call' }).click()
  const popup = await opened
  await expect(popup.getByRole('dialog', { name: 'lounge' })).toBeVisible({ timeout: 15000 })

  await popup.getByTestId('call-chat-toggle').click()
  const panel = popup.getByTestId('call-side-chat')
  await expect(rows(panel).filter({ hasText: 'Lounge hello' })).toBeVisible({ timeout: 30000 })
  // Popped out, the chat lives in the call window: nothing docks in the main one.
  await expect(page.getByTestId('docked-call-chat')).toHaveCount(0)

  await page.getByRole('link', { name: /^other-chat/ }).click()
  await expect(page).toHaveURL(new RegExp(`/chat/${server.id}/${otherId}$`))
  await expect(rows(page.locator('main.main-content-area')).filter({ hasText: 'Other hello' })).toBeVisible({ timeout: 30000 })
  await expect(rows(panel).filter({ hasText: 'Lounge hello' })).toBeVisible()
  await sendFrom(panel, popup, 'Typed in the pop-out beside other-chat')
  const { data } = await admin.from('messages').select('id').eq('channel_id', loungeId).eq('content->0->>text', 'Typed in the pop-out beside other-chat')
  expect(data).toHaveLength(1)

  const closed = popup.waitForEvent('close')
  await popup.getByRole('button', { name: 'Return call to the app' }).click()
  await closed
  await expect(page.getByRole('dialog', { name: 'lounge' }).getByTestId('call-side-chat')).toBeVisible({ timeout: 15000 })
})

test("a direct message call's chat beside another conversation", async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page, owner)
  await page.goto(`/dm/${otherConversation}`)
  const mainList = page.locator('main.main-content-area')
  await expect(rows(mainList).filter({ hasText: 'Other DM hello' })).toBeVisible({ timeout: 30000 })
  await enterVoice(page, { selfId: owner.id, others: [member.id], conversation: callConversation })

  const dockChat = page.getByTestId('dock-chat-toggle')
  await expect(dockChat).toBeVisible({ timeout: 15000 })
  await dockChat.click()
  const docked = page.getByTestId('docked-call-chat')
  await expect(rows(docked).filter({ hasText: 'Call DM hello' })).toBeVisible({ timeout: 30000 })
  await expect(rows(mainList).filter({ hasText: 'Call DM hello' })).toHaveCount(0)
  await sendFrom(docked, page, 'Beside the other conversation')
  const { data } = await admin.from('messages').select('id').eq('conversation_id', callConversation).eq('user_id', owner.id)
  expect(data).toHaveLength(1)
  await expect(rows(mainList).filter({ hasText: 'Beside the other conversation' })).toHaveCount(0)
})
