// Journey: an encrypted channel whose stored messages differ from what their sender sent, and a
// send whose session key reaches not every member.
//
// - The server refuses the session key share, and its retry: the message is sent and its sender
//   is told some members may not read it.
// - A row whose signature does not verify shows as forged, apart from the intact message beside it.
// - One ciphertext stored under a second message id: the later row carries the Repeated badge.
//
// Ava owns the server and sends; Ben, a member with encryption set up, reads after a reload. The
// stack runs no realtime.

import { test, expect, type Browser } from '@playwright/test'
import { addMember, adminClient, dismissAnnouncements, messageList, openChannel, seedServer, sendMessage, signIn } from './harness'
import { setUpEncryption } from './encryption'
import { Cast, item } from './encryptedHistory'

const admin = adminClient()
const cast = new Cast(admin)

test.afterAll(async () => {
  await cast.cleanup()
})

async function encryptedChannel(browser: Browser, tag: string) {
  const ava = await cast.actor(`${tag}ava`)
  const ben = await cast.actor(`${tag}ben`)
  const server = await seedServer(admin, ava, `Integrity ${ava.username}`)
  await addMember(admin, ben, server.id)
  const { error } = await admin
    .from('server_encryption_settings')
    .upsert({ server_id: server.id, encryption_mode: 'required' }, { onConflict: 'server_id' })
  if (error) throw new Error(`encryption floor: ${error.message}`)

  const benPage = await (await cast.profile(browser)).newPage()
  await test.step('Ben sets up encryption in the channel', async () => {
    await signIn(benPage, ben)
    await openChannel(benPage, server.id, server.generalChannelId)
    await setUpEncryption(benPage, ben)
  })

  const avaPage = await (await cast.profile(browser)).newPage()
  await test.step('Ava sets up encryption in the channel', async () => {
    await signIn(avaPage, ava)
    await openChannel(avaPage, server.id, server.generalChannelId)
    await setUpEncryption(avaPage, ava)
  })
  return { server, ava, ben, avaPage, benPage }
}

async function storedRow(id: string) {
  const { data, error } = await admin.from('messages').select('*').eq('id', id).single()
  if (error) throw new Error(`stored row: ${error.message}`)
  return data
}

test('a session key the server will not store: the message is sent and its sender told', async ({ browser }) => {
  test.setTimeout(240_000)
  const { ava, avaPage } = await encryptedChannel(browser, 'ks')
  const text = `key not shared ${ava.username}`
  let refused = 0

  await test.step('the server refuses every share; Ava sends', async () => {
    await avaPage.route('**/rest/v1/megolm_session_shares**', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      refused++
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'XX000', message: 'share refused', details: null, hint: null }),
      })
    })
    const posted = await sendMessage(avaPage, text)
    const row = await storedRow((await posted.getAttribute('data-message-id'))!)
    expect(row.encrypted).toBe(true)
  })

  await test.step('Ava is told one member may not read it; the share was tried twice', async () => {
    const toast = avaPage.getByTestId('notification-toasts').locator('.notification-toast')
      .filter({ hasText: 'Some members may not be able to read your message' })
    await expect(toast).toBeVisible({ timeout: 15000 })
    await expect(toast).toContainText('did not reach 1 member.')
    expect(refused).toBe(2)
    await expect(item(avaPage, text)).toHaveCount(1)
  })
})

test('a stored message whose signature does not verify shows as forged', async ({ browser }) => {
  test.setTimeout(240_000)
  const { ava, avaPage, benPage } = await encryptedChannel(browser, 'fg')
  const intact = `intact ${ava.username}`
  const altered = `altered ${ava.username}`
  let alteredId = ''

  await test.step('Ava sends two messages; the server alters the signature of the second', async () => {
    await sendMessage(avaPage, intact)
    alteredId = (await (await sendMessage(avaPage, altered)).getAttribute('data-message-id'))!
    const row = await storedRow(alteredId)
    const signature: string = row.encryption_metadata.signature
    const forged = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1)
    const { error } = await admin
      .from('messages')
      .update({ encryption_metadata: { ...row.encryption_metadata, signature: forged } })
      .eq('id', alteredId)
    if (error) throw new Error(`alter: ${error.message}`)
  })

  await test.step('Ben reads the intact message and sees the altered one as forged', async () => {
    await benPage.reload()
    await dismissAnnouncements(benPage)
    await expect(item(benPage, intact)).toHaveCount(1, { timeout: 30000 })
    const row = messageList(benPage).locator(`[data-message-id="${alteredId}"]`)
    const notice = row.getByTestId('message-forged')
    await expect(notice).toBeVisible({ timeout: 30000 })
    await expect(notice).toHaveText('Message hidden: its signature does not match its sender')
    await expect(row.locator('.encrypted-click-target')).toHaveCount(0)
    await expect(item(benPage, altered)).toHaveCount(0)
  })
})

test('one ciphertext stored under a second message id: the later row is marked repeated', async ({ browser }) => {
  test.setTimeout(240_000)
  const { ava, avaPage, benPage } = await encryptedChannel(browser, 'rp')
  const text = `yes, go ahead ${ava.username}`
  let originalId = ''
  let copyId = ''

  await test.step('Ava sends; the server stores the same ciphertext again under a new id', async () => {
    originalId = (await (await sendMessage(avaPage, text)).getAttribute('data-message-id'))!
    const row = await storedRow(originalId)
    const { data, error } = await admin
      .from('messages')
      .insert({
        user_id: row.user_id,
        channel_id: row.channel_id,
        content: row.content,
        encrypted: true,
        encryption_metadata: row.encryption_metadata,
        media_paths: row.media_paths,
      })
      .select('id')
      .single()
    if (error) throw new Error(`copy: ${error.message}`)
    copyId = data.id
  })

  await test.step('Ben reads both; only the later row is marked repeated', async () => {
    await benPage.reload()
    await dismissAnnouncements(benPage)
    await expect(item(benPage, text)).toHaveCount(2, { timeout: 30000 })
    const list = messageList(benPage)
    await expect(list.locator(`[data-message-id="${copyId}"]`).getByTestId('message-replayed')).toBeVisible({ timeout: 30000 })
    await expect(list.locator(`[data-message-id="${copyId}"]`).getByTestId('message-replayed')).toHaveText('Repeated')
    await expect(list.locator(`[data-message-id="${originalId}"]`).getByTestId('message-replayed')).toHaveCount(0)
  })
})
