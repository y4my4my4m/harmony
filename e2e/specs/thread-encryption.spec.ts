import { test, expect } from '@playwright/test'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
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
})

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
