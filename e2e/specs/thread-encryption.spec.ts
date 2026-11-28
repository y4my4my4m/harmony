// Journey: thread replies in an encrypted channel read as plaintext for their sender and for
// other members, in the side panel and the full view, after sending, reloading, reopening and
// editing. A thread started from an encrypted message shows its starter readable in both views.
// The E2E stack has no realtime: live arrivals, live edits and key-arrival retries are covered
// by src/composables/__tests__/useThreadMessageDecryption.test.ts.

import { test, expect, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  sendMessage,
  signIn,
  userClient,
  type SpecUser
} from './harness'
import { setUpEncryption } from './encryption'

const admin = adminClient()
let owner: SpecUser
let reader: SpecUser
let threadId: string
let serverId: string
let channelId: string
const threadName = 'Encrypted replies'

test.beforeAll(async () => {
  owner = await createUser(admin, 'threadcrypto')
  const server = await seedServer(admin, owner, `Encrypted threads ${owner.username}`)
  serverId = server.id
  channelId = server.generalChannelId
  reader = await createUser(admin, 'threadreader')
  await addMember(admin, reader, serverId)
  const client = await userClient(owner)
  const { data, error } = await client.rpc('create_channel_thread', {
    p_channel_id: channelId,
    p_name: threadName
  })
  if (error || !data) throw new Error(`create thread: ${error?.message}`)
  threadId = data as string
  const policy = await admin
    .from('server_encryption_settings')
    .upsert({ server_id: serverId, encryption_mode: 'required' }, { onConflict: 'server_id' })
  if (policy.error) throw policy.error
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
  await deleteUser(admin, reader)
  await deleteUser(admin, starter)
  await deleteUser(admin, starterReader)
})

let starter: SpecUser
let starterReader: SpecUser

test('encrypted thread replies are readable after sending and reopening either view', async ({
  page,
  browser
}) => {
  test.setTimeout(150_000)
  await signIn(page, owner)
  await openChannel(page, serverId, channelId)
  await setUpEncryption(page, owner)
  const readerContext = await browser.newContext()
  try {
    const readerPage = await readerContext.newPage()
    await signIn(readerPage, reader)
    await openChannel(readerPage, serverId, channelId)
    await setUpEncryption(readerPage, reader)

    await page.locator('.chat-header .threads-btn').click()
    await page.locator('.threads-modal .thread-item').filter({ hasText: threadName }).click()
    const panel = page.locator('.thread-panel')
    await expect(panel.locator('.thread-info h3')).toHaveText(threadName)

    const secret = `readable encrypted reply ${owner.username}`
    const input = panel.locator('[data-testid="message-input"] [contenteditable="true"]').first()
    await input.fill(secret)
    await input.press('Enter')
    await expect
      .poll(async () => {
        const { data } = await admin
          .from('messages')
          .select('encrypted, content')
          .eq('thread_id', threadId)
          .eq('user_id', owner.id)
        return data?.filter((row) => row.encrypted && !JSON.stringify(row.content).includes(secret))
          .length
      })
      .toBe(1)
    await expect(panel.getByRole('article').filter({ hasText: secret })).toBeVisible({
      timeout: 15000
    })

    await panel.getByTestId('thread-open-full-view').click()
    await page.waitForURL(`**/chat/${serverId}/thread/${threadId}`)
    await page.reload()
    const fullView = page.locator('.thread-full-view')
    await expect(fullView.getByRole('article').filter({ hasText: secret })).toBeVisible({
      timeout: 30000
    })

    await openChannel(page, serverId, channelId)
    await page.locator('.chat-header .threads-btn').click()
    await page.locator('.threads-modal .thread-item').filter({ hasText: threadName }).click()
    await expect(panel.getByRole('article').filter({ hasText: secret })).toBeVisible({
      timeout: 15000
    })

    await readerPage.goto(`/chat/${serverId}/thread/${threadId}`)
    await expect(
      readerPage.locator('.thread-full-view').getByRole('article').filter({ hasText: secret })
    ).toBeVisible({ timeout: 30000 })
  } finally {
    await readerContext.close()
  }
})


/** The newest stored row of `userId` in the channel, outside threads or in `threadId`. */
async function storedRow(userId: string, channel: string, threadId?: string) {
  let query = admin
    .from('messages')
    .select('id, encrypted, content')
    .eq('channel_id', channel)
    .eq('user_id', userId)
  query = threadId ? query.eq('thread_id', threadId) : query.is('thread_id', null)
  const { data, error } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (error) throw error
  return data as { id: string; encrypted: boolean; content: Array<{ type: string; text?: string }> } | null
}

/** Opens the editor of the full view's row holding `original`, replaces its text and saves. */
async function editReply(page: Page, original: string, text: string): Promise<void> {
  const row = page.locator('.thread-full-view').getByRole('article').filter({ hasText: original })
  await row.focus()
  await page.keyboard.press('Enter')
  const menu = page.getByRole('menu', { name: 'Message options' })
  await menu.getByRole('menuitem', { name: 'Edit message' }).focus()
  await page.keyboard.press('Enter')
  const editor = row.getByRole('textbox', { name: 'Edit message' })
  await expect(editor).toBeFocused()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

test('a thread started from an encrypted message shows its starter and an edited reply readable', async ({
  page,
  browser
}) => {
  test.setTimeout(180_000)
  starter = await createUser(admin, 'tstarter')
  starterReader = await createUser(admin, 'tsreader')
  const server = await seedServer(admin, starter, `Encrypted starters ${starter.username}`)
  await addMember(admin, starterReader, server.id)
  const policy = await admin
    .from('server_encryption_settings')
    .upsert({ server_id: server.id, encryption_mode: 'required' }, { onConflict: 'server_id' })
  if (policy.error) throw policy.error
  const channel = server.generalChannelId

  await signIn(page, starter)
  await openChannel(page, server.id, channel)
  await setUpEncryption(page, starter)
  const readerContext = await browser.newContext()
  try {
    const readerPage = await readerContext.newPage()
    await signIn(readerPage, starterReader)
    await openChannel(readerPage, server.id, channel)
    await setUpEncryption(readerPage, starterReader)

    const starterText = `encrypted starter ${starter.username}`
    await sendMessage(page, starterText)
    const parent = await storedRow(starter.id, channel)
    expect(parent?.encrypted).toBe(true)
    const parentCiphertext = parent!.content[0].text!
    expect(parentCiphertext).not.toContain(starterText)

    const client = await userClient(starter)
    const { data: created, error } = await client.rpc('create_thread', {
      p_message_id: parent!.id,
      p_name: 'From an encrypted starter',
      p_auto_archive_duration: 1440
    })
    if (error || !created) throw new Error(`create thread: ${error?.message}`)
    const threadId = created as string
    const fullView = page.locator('.thread-full-view')
    const reply = `encrypted reply ${starter.username}`
    const edited = `edited encrypted reply ${starter.username}`

    await test.step('the full view shows the starter readable', async () => {
      await page.goto(`/chat/${server.id}/thread/${threadId}`)
      const shown = fullView.getByTestId('thread-parent-message')
      await expect(shown).toContainText(starterText, { timeout: 30000 })
      await expect(shown).not.toContainText(parentCiphertext.slice(0, 24))
    })

    await test.step('a reply and its edit stay readable for the sender and are stored encrypted', async () => {
      const input = fullView.locator('[data-testid="message-input"] [contenteditable="true"]').first()
      await input.fill(reply)
      await input.press('Enter')
      const row = fullView.getByRole('article').filter({ hasText: reply })
      await expect(row).toBeVisible({ timeout: 15000 })
      await expect(row).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 15000 })
      const stored = await storedRow(starter.id, channel, threadId)
      expect(stored?.encrypted).toBe(true)
      expect(JSON.stringify(stored?.content)).not.toContain(reply)

      await editReply(page, reply, edited)
      const editedRow = fullView.getByRole('article').filter({ hasText: edited })
      await expect(editedRow).toBeVisible({ timeout: 15000 })
      await expect(editedRow.getByTestId('edit-pending')).toHaveCount(0, { timeout: 15000 })
      await expect
        .poll(async () => {
          const row = await storedRow(starter.id, channel, threadId)
          return row?.encrypted === true && row.content[0].text !== stored?.content[0].text &&
            !JSON.stringify(row.content).includes(edited)
        })
        .toBe(true)
    })

    await test.step('the side panel keeps the starter readable after its refresh', async () => {
      await openChannel(page, server.id, channel)
      const starterRow = page
        .locator('[data-testid="message-list"]')
        .getByRole('article')
        .filter({ hasText: starterText })
        .first()
      await expect(starterRow).toBeVisible({ timeout: 30000 })
      const refreshed = page.waitForResponse(
        (r) => r.url().includes('/rest/v1/threads') && r.url().includes(threadId)
      )
      await starterRow.locator('.thread-indicator').click()
      const panel = page.locator('.thread-panel')
      await refreshed
      await expect(panel.getByRole('article').filter({ hasText: edited })).toBeVisible({ timeout: 15000 })
      const shown = panel.getByTestId('thread-parent-message')
      await expect(shown).toContainText(starterText)
      await expect(shown).not.toContainText(parentCiphertext.slice(0, 24))
    })

    await test.step('another member reads the starter and the edited reply', async () => {
      await readerPage.goto(`/chat/${server.id}/thread/${threadId}`)
      const readerView = readerPage.locator('.thread-full-view')
      await expect(readerView.getByTestId('thread-parent-message')).toContainText(starterText, {
        timeout: 30000
      })
      await expect(readerView.getByRole('article').filter({ hasText: edited })).toBeVisible({
        timeout: 30000
      })
      await expect(readerView).not.toContainText(parentCiphertext.slice(0, 24))
    })
  } finally {
    await readerContext.close()
  }
})
