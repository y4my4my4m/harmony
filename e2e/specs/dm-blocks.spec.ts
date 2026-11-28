// Journey: a block in a direct conversation, both ways, and the unblock (20261111500001_dm_blocks.sql,
// 20261123500001_blocks_hidden_from_blocked.sql, 20261123500002_dm_block_guards_edits.sql).
//
// The blocker presses Block while its page still shows no block (the row was written behind it):
// the block stays. The blocker's composer turns into an Unblock prompt and the blocked account's
// earlier message collapses. The blocked account's send is refused once, with a toast and its draft
// back, and nothing is stored. It reads no block naming it, and its edit of the earlier message is
// refused as its send was. Its call, placed from another voice call, is refused before the switch
// and leaves it in that call (20261123500007_check_dm_call.sql). After Unblock both write again.
//
// The e2e stack runs no realtime service: each page reads the other's writes on load.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  composer,
  createUser,
  deleteUser,
  dismissAnnouncements,
  loadApp,
  messageList,
  sendMessage,
  signIn,
  userClient,
  type SpecUser,
} from './harness'

const admin = adminClient()
let blocker: SpecUser
let blocked: SpecUser
let conversationId = ''

const blockRows = async () =>
  (await admin.from('user_blocks').select('id').eq('blocker_id', blocker.id).eq('blocked_user_id', blocked.id)).data ?? []
const storedTexts = async () =>
  ((await admin.from('messages').select('content').eq('conversation_id', conversationId)).data ?? [])
    .map((m: { content: Array<{ text?: string }> }) => m.content?.[0]?.text)

async function openConversation(page: Page) {
  await loadApp(page, `/dm/${conversationId}`, messageList(page))
  await dismissAnnouncements(page)
  await expect(messageList(page)).toBeVisible({ timeout: 30000 })
}

test.beforeAll(async () => {
  blocker = await createUser(admin, 'dmblk')
  blocked = await createUser(admin, 'dmbld')
  const { data: conversation, error } = await admin.from('conversations')
    .insert({ type: 'direct', created_by: blocker.id }).select('id').single()
  if (error || !conversation) throw new Error(`conversation: ${error?.message}`)
  conversationId = conversation.id
  await admin.from('conversation_participants').insert([
    { conversation_id: conversationId, user_id: blocker.id, role: 'member' },
    { conversation_id: conversationId, user_id: blocked.id, role: 'member' },
  ])
  const { error: messageError } = await admin.from('messages').insert({
    conversation_id: conversationId, user_id: blocked.id, content: [{ type: 'text', text: 'before the block' }],
  })
  if (messageError) throw new Error(`message: ${messageError.message}`)
})

test.afterAll(async () => {
  if (conversationId) await admin.from('conversations').delete().eq('id', conversationId)
  await deleteUser(admin, blocker)
  await deleteUser(admin, blocked)
})

test('a block stops a direct conversation both ways until the unblock', async ({ browser }) => {
  test.setTimeout(240_000)

  const blockerContext = await browser.newContext()
  const blockerPage = await blockerContext.newPage()
  const blockedContext = await browser.newContext()
  const blockedPage = await blockedContext.newPage()

  await test.step('Block on a page that has not seen the block keeps it', async () => {
    await signIn(blockerPage, blocker)
    await blockerPage.goto(`/social/profile/${blocked.username}`)
    await dismissAnnouncements(blockerPage)
    await expect(blockerPage.locator('.name-handle-section .user-handle')).toContainText(blocked.username, { timeout: 30000 })

    const { error } = await admin.from('user_blocks').insert({ blocker_id: blocker.id, blocked_user_id: blocked.id })
    expect(error).toBeNull()

    await blockerPage.locator('[data-testid="profile-more-btn"]').click()
    const blockItem = blockerPage.getByRole('menuitem', { name: 'Block', exact: true })
    await expect(blockItem).toBeVisible()
    await blockItem.click()
    // The menu closes once the write has returned.
    await expect(blockItem).toBeHidden({ timeout: 15000 })

    await blockerPage.locator('[data-testid="profile-more-btn"]').click()
    await expect(blockerPage.getByRole('menuitem', { name: 'Unblock', exact: true })).toBeVisible({ timeout: 15000 })
    await blockerPage.keyboard.press('Escape')
    expect(await blockRows()).toHaveLength(1)
  })

  await test.step('the blocker\'s composer is an Unblock prompt and the earlier message collapses', async () => {
    await openConversation(blockerPage)
    const prompt = blockerPage.locator('[data-testid="dm-blocked-peer-prompt"]')
    await expect(prompt).toBeVisible({ timeout: 30000 })
    await expect(prompt).toContainText(blocked.displayName)
    await expect(blockerPage.locator('[data-testid="message-input"]')).toHaveCount(0)
    await expect(messageList(blockerPage).locator('.blocked-message-group')).toHaveCount(1)
    await expect(messageList(blockerPage).getByText('before the block')).toHaveCount(0)
  })

  await test.step('the blocked account\'s send is refused once, with its draft back', async () => {
    await signIn(blockedPage, blocked)
    await openConversation(blockedPage)
    await composer(blockedPage).click()
    await composer(blockedPage).pressSequentially('while blocked', { delay: 10 })
    await blockedPage.keyboard.press('Enter')

    await expect(blockedPage.locator('.Vue-Toastification__toast--error').filter({ hasText: 'could not be delivered' }))
      .toBeVisible({ timeout: 30000 })
    await expect(composer(blockedPage)).toContainText('while blocked', { timeout: 15000 })
    await expect(messageList(blockedPage).locator('.message-item').filter({ hasText: 'while blocked' })).toHaveCount(0)
    await expect(blockedPage.locator('[data-testid="dm-conversation-item"]')).toContainText('before the block')
    // A retried send would land after the toast: the auto-retries wait 2 s and 4 s.
    await blockedPage.waitForTimeout(7000)
    expect(await storedTexts()).toEqual(['before the block'])
  })

  await test.step('the blocked account reads no block and cannot ask who blocks it', async () => {
    const client = await userClient(blocked)
    const rows = await client.from('user_blocks').select('blocker_id, blocked_user_id')
    expect(rows.error).toBeNull()
    expect(rows.data).toEqual([])
    expect((await client.rpc('is_blocked_by', { target_user_id: blocker.id })).error?.code).toBe('PGRST202')
    expect((await client.rpc('current_user_block_peer_ids')).error?.code).toBe('PGRST202')
  })

  await test.step('the blocked account\'s edit of its earlier message is refused, its text kept', async () => {
    const refusals = blockedPage.locator('.Vue-Toastification__toast--error').filter({ hasText: 'could not be delivered' })
    await expect(refusals).toHaveCount(0, { timeout: 30000 })
    const row = messageList(blockedPage).getByRole('article').filter({ hasText: 'before the block' })
    await row.focus()
    await blockedPage.keyboard.press('e')
    const editor = row.getByRole('textbox', { name: 'Edit message' })
    await expect(editor).toBeFocused()
    await blockedPage.keyboard.press('ControlOrMeta+End')
    await blockedPage.keyboard.type(' edited while blocked')
    await blockedPage.keyboard.press('Enter')

    await expect(refusals.first()).toBeVisible({ timeout: 30000 })
    // The editor reopens with the attempted text; Escape leaves the row as stored.
    await blockedPage.keyboard.press('Escape')
    await expect(editor).toHaveCount(0)
    await expect(row).not.toContainText('edited while blocked')
    expect(await storedTexts()).toEqual(['before the block'])
  })

  await test.step('the blocked account\'s call from another voice call is refused before the switch', async () => {
    // The stack has no voice server: the store is set as a joined call leaves it (activities.spec.ts).
    const setVoice = (connected: boolean) => blockedPage.evaluate((on) => {
      type Store = { $patch: (fn: (state: Record<string, any>) => void) => void }
      const root = document.querySelector('#app') as unknown as {
        __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, Store> } } } }
      }
      root.__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel')!.$patch((state) => {
        state.isConnected = on
        state.currentChannelId = on ? 'lounge-elsewhere' : null
        state.currentChannelName = on ? 'lounge' : null
      })
    }, connected)
    const voiceChannel = () => blockedPage.evaluate(() => {
      const root = document.querySelector('#app') as any
      const voice = root.__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel')
      return voice.isConnected ? voice.currentChannelId : null
    })
    await setVoice(true)
    await blockedPage.locator('[data-testid="dm-call"]').click()

    await expect(blockedPage.locator('.Vue-Toastification__toast--error').filter({ hasText: 'Your call could not be placed.' }))
      .toBeVisible({ timeout: 30000 })
    await expect(blockedPage.getByText('Switch calls?')).toHaveCount(0)
    expect(await voiceChannel()).toBe('lounge-elsewhere')
    const notices = await admin.from('messages').select('id').eq('conversation_id', conversationId).eq('is_system', true)
    expect(notices.data ?? []).toEqual([])
    await setVoice(false)
  })

  await test.step('Unblock in the prompt brings the composer back', async () => {
    await blockerPage.locator('[data-testid="dm-blocked-peer-unblock"]').click()
    await expect(blockerPage.locator('[data-testid="message-input"]')).toBeVisible({ timeout: 15000 })
    await expect(blockerPage.locator('[data-testid="dm-blocked-peer-prompt"]')).toHaveCount(0)
    await expect(messageList(blockerPage).getByText('before the block')).toBeVisible()
    expect(await blockRows()).toHaveLength(0)
  })

  await test.step('both write again', async () => {
    await composer(blockedPage).click()
    await blockedPage.keyboard.press('ControlOrMeta+a')
    await blockedPage.keyboard.press('Backspace')
    await sendMessage(blockedPage, 'after the unblock')
    await sendMessage(blockerPage, 'welcome back')

    await openConversation(blockerPage)
    await expect(messageList(blockerPage).getByText('after the unblock')).toBeVisible({ timeout: 30000 })
    expect((await storedTexts()).sort()).toEqual(['after the unblock', 'before the block', 'welcome back'])
  })

  await blockerContext.close()
  await blockedContext.close()
})
