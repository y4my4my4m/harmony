// Journey: the lock of an end-to-end encrypted channel stays beside the channel's name. It
// sat at the far end of the name's box, so a mention badge appearing at the row's end pushed
// it left.
//
// The server requires encryption in every channel, so each row carries the lock. The message
// raising the badge is ciphertext-shaped, as the encryption guard requires.

import { test, expect, type Page } from '@playwright/test'
import { addChannel, addMember, adminClient, createUser, deleteUser, dismissAnnouncements, seedServer, signIn, userClient, type SeededServer, type SpecUser } from './harness'

const admin = adminClient()
let author: SpecUser
let reader: SpecUser
let server: SeededServer
let lobbyId: string

test.beforeAll(async () => {
  author = await createUser(admin, 'crma')
  reader = await createUser(admin, 'crmb')
  server = await seedServer(admin, author, `Marks ${author.username}`)
  await addMember(admin, reader, server.id)
  lobbyId = await addChannel(admin, server, 'lobby')
  const { error } = await admin
    .from('server_encryption_settings')
    .upsert({ server_id: server.id, encryption_mode: 'required' }, { onConflict: 'server_id' })
  if (error) throw new Error(`encryption: ${error.message}`)
  const readerClient = await userClient(reader)
  const { error: levelError } = await readerClient.rpc('update_server_notification_settings', {
    p_server_id: server.id,
    p_changes: { level: 'all' },
  })
  if (levelError) throw new Error(`notification level: ${levelError.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, author)
  await deleteUser(admin, reader)
})

const row = (page: Page, id: string) => page.locator(`.channel-sidebar .channel-wrapper[data-channel-id="${id}"] .channel-item`)

/** Gap from the end of the name to the lock, px. */
const lockGap = (page: Page, id: string) => row(page, id).evaluate((el) => {
  const name = el.querySelector('.channel-name')!.getBoundingClientRect()
  const lock = el.querySelector('.channel-lock')!.getBoundingClientRect()
  return Math.round(lock.left - name.right)
})

test('a mention badge leaves the lock beside the channel name', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, reader)
  await page.goto(`/chat/${server.id}/${lobbyId}`)
  await dismissAnnouncements(page)
  await expect(row(page, server.generalChannelId).locator('.channel-lock')).toBeVisible({ timeout: 30000 })
  const before = await lockGap(page, server.generalChannelId)
  expect(before).toBeLessThanOrEqual(6)

  // Ciphertext-shaped: 48 base64 characters and a Megolm session; never decrypted here.
  const { error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: author.id,
    encrypted: true,
    content: [{ type: 'text', text: 'A'.repeat(48) }],
    encryption_metadata: { algorithm: 'megolm_v2_signed', session_id: 'e2e-session' },
  })
  if (error) throw new Error(`message: ${error.message}`)
  await page.reload()
  const badge = row(page, server.generalChannelId).locator('.notification-badge')
  await expect(badge).toHaveText('1', { timeout: 30000 })

  expect(await lockGap(page, server.generalChannelId)).toBe(before)
  expect(await lockGap(page, lobbyId)).toBe(before)
  const lockRight = await row(page, server.generalChannelId).locator('.channel-lock').evaluate((el) => el.getBoundingClientRect().right)
  const badgeLeft = await badge.evaluate((el) => el.getBoundingClientRect().left)
  expect(badgeLeft).toBeGreaterThan(lockRight)
})
