// Journey: who reads an encrypted room's messages from before they joined
// (20261028200001_megolm_history_visibility.sql).
//
//   none     a newcomer reads what was sent after they joined; no member, the author
//            included, hands over an earlier session.
//   pinned   a newcomer reads a pinned message from before they joined, not the messages
//            around it in the same session: the key of that message alone is handed over.
//   group    a member added to a group conversation reads what follows, never what came
//            before; conversations have no setting.
//   switch   the owner turns a channel from none to all in its settings; a waiting request is
//            answered on a holder's next unlock. Turning it back revokes nothing delivered.
//
// The stack runs no realtime: requests and answers travel through the unlock sweeps.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  channelRow,
  dismissAnnouncements,
  messageList,
  sendMessage,
  signIn,
  type SpecUser,
} from './harness'
import { setUpEncryption } from './encryption'
import { expectNoAxeViolations } from './a11y'
import {
  Cast,
  comeBack,
  historyBeforeJoin,
  item,
  openPins,
  relayableFor,
  requestsOf,
  sweepAgain,
} from './encryptedHistory'

const admin = adminClient()
const cast = new Cast(admin)

test.afterAll(async () => {
  await cast.cleanup()
})

async function openChannelSettings(page: Page, name: string) {
  await channelRow(page, name).click({ button: 'right' })
  await page.locator('.context-menu .context-menu-item').filter({ hasText: 'Edit channel' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit channel' })
  await expect(dialog).toBeVisible({ timeout: 15000 })
  return dialog
}

test('none: a newcomer reads only what was sent after they joined', async ({ browser }) => {
  test.setTimeout(300_000)
  const h = await historyBeforeJoin(admin, cast, browser, 'khn', { visibility: 'none' })
  const after = `ava after cleo joined ${h.ava.username}`

  await test.step('Ben and Ava come back; neither may answer for the earlier session', async () => {
    await comeBack(h.benProfile)
    const avaPage = await comeBack(h.avaProfile, `/chat/${h.server.id}/${h.server.generalChannelId}`)
    await expect(messageList(avaPage)).toBeVisible({ timeout: 30000 })
    expect(await relayableFor(h.ben)).toEqual([])
    expect(await relayableFor(h.ava)).toEqual([])
    expect((await requestsOf(admin, h.cleo)).every((r) => r.status === 'pending')).toBe(true)

    await test.step('Ava posts after Cleo joined', async () => {
      await sendMessage(avaPage, after)
    })
  })

  await test.step('Cleo reads the new message and not the earlier one', async () => {
    await h.cleoPage.reload()
    await dismissAnnouncements(h.cleoPage)
    await expect(item(h.cleoPage, after)).toHaveCount(1, { timeout: 30000 })
    await expect(item(h.cleoPage, h.avaTexts[0])).toHaveCount(0)
    expect((await requestsOf(admin, h.cleo)).filter((r) => r.status !== 'pending' && r.status !== 'cancelled')).toEqual([])
  })

  await test.step('the earlier pin stays locked for Cleo', async () => {
    const pins = await openPins(h.cleoPage, 1)
    await expect(pins.getByText('Encrypted message')).toBeVisible({ timeout: 30000 })
    await expect(pins.getByText(h.avaTexts[0])).toHaveCount(0)
  })
})

test('pinned only: a newcomer reads the pin, not the messages around it', async ({ browser }) => {
  test.setTimeout(300_000)
  const h = await historyBeforeJoin(admin, cast, browser, 'khp', {
    visibility: 'pinned',
    avaTexts: (ava) => [`left neighbour ${ava.username}`, `pinned middle ${ava.username}`, `right neighbour ${ava.username}`],
    pinned: 1,
  })
  const [before, pin, afterPin] = h.avaTexts
  const pinId = h.avaMessageIds[1]

  await test.step("Ben comes back; his sweep hands over the pinned message's key alone", async () => {
    await comeBack(h.benProfile)
    await expect
      .poll(async () => (await requestsOf(admin, h.cleo)).find((r) => r.message_id === pinId)?.status, { timeout: 60000 })
      .not.toBe('pending')
    const answered = (await requestsOf(admin, h.cleo)).find((r) => r.message_id === pinId)!
    expect(answered.key_scope).toBe('message')
    expect(answered.fulfilled_by_user_id).toBe(h.ben.id)
    expect((await requestsOf(admin, h.cleo)).filter((r) => r.message_id !== pinId).map((r) => r.status))
      .toEqual(['pending'])
  })

  await test.step('Cleo reads the pin in the channel, not its neighbours', async () => {
    await h.cleoPage.reload()
    await dismissAnnouncements(h.cleoPage)
    await expect(item(h.cleoPage, pin)).toHaveCount(1, { timeout: 30000 })
    await expect(item(h.cleoPage, before)).toHaveCount(0)
    await expect(item(h.cleoPage, afterPin)).toHaveCount(0)
  })

  await test.step('and in the pinned messages panel', async () => {
    const pins = await openPins(h.cleoPage, 1)
    await expect(pins.getByText(pin)).toBeVisible({ timeout: 30000 })
  })
})

test('group conversation: a member added later reads what follows, not what came before', async ({ browser }) => {
  test.setTimeout(300_000)
  const ava = await cast.actor('khgava')
  const ben = await cast.actor('khgben')
  const cleo = await cast.actor('khgcleo')
  const before = `group before cleo ${ava.username}`
  const after = `group after cleo ${ava.username}`

  const { data: conversation, error } = await admin
    .from('conversations')
    .insert({ type: 'group', name: `Group ${ava.username}`, created_by: ava.id })
    .select('id')
    .single()
  if (error || !conversation) throw new Error(`conversation: ${error?.message}`)
  const conversationId = conversation.id as string
  await admin.from('conversation_participants').insert([
    { conversation_id: conversationId, user_id: ava.id },
    { conversation_id: conversationId, user_id: ben.id },
  ])
  const { error: encError } = await admin
    .from('conversation_encryption_settings')
    .insert({ conversation_id: conversationId, encryption_enabled: true })
  if (encError) throw new Error(`conversation encryption: ${encError.message}`)
  const path = `/dm/${conversationId}`

  async function openConversation(page: Page, user: SpecUser) {
    await signIn(page, user)
    await page.goto(path)
    await dismissAnnouncements(page)
    await expect(messageList(page)).toBeVisible({ timeout: 30000 })
  }

  const benProfile = await cast.profile(browser)
  const benPage = await benProfile.newPage()
  await openConversation(benPage, ben)
  await setUpEncryption(benPage, ben)

  const avaProfile = await cast.profile(browser)
  const avaPage = await avaProfile.newPage()

  await test.step('Ava posts while Ben is in the group; Ben reads it', async () => {
    await openConversation(avaPage, ava)
    await setUpEncryption(avaPage, ava)
    await sendMessage(avaPage, before)
    await benPage.reload()
    await dismissAnnouncements(benPage)
    await expect(item(benPage, before)).toHaveCount(1, { timeout: 30000 })
  })

  const cleoPage = await (await cast.profile(browser)).newPage()

  await test.step('Cleo is added and asks for the earlier session', async () => {
    const { error: addError } = await admin
      .from('conversation_participants')
      .insert({ conversation_id: conversationId, user_id: cleo.id })
    if (addError) throw new Error(`add cleo: ${addError.message}`)
    await openConversation(cleoPage, cleo)
    await setUpEncryption(cleoPage, cleo)
    await cleoPage.reload()
    await dismissAnnouncements(cleoPage)
    await expect(messageList(cleoPage)).toBeVisible({ timeout: 30000 })
    await expect(item(cleoPage, before)).toHaveCount(0)
    await expect.poll(async () => (await requestsOf(admin, cleo)).length, { timeout: 30000 }).toBeGreaterThan(0)
  })

  await test.step('neither Ava nor Ben may answer it', async () => {
    await sweepAgain(benPage)
    await sweepAgain(avaPage)
    expect(await relayableFor(ben)).toEqual([])
    expect(await relayableFor(ava)).toEqual([])
    expect((await requestsOf(admin, cleo)).every((r) => r.status === 'pending')).toBe(true)
  })

  await test.step('Ava posts after Cleo joined; Cleo reads that, never the earlier message', async () => {
    await sendMessage(avaPage, after)
    await cleoPage.reload()
    await dismissAnnouncements(cleoPage)
    await expect(item(cleoPage, after)).toHaveCount(1, { timeout: 30000 })
    await expect(item(cleoPage, before)).toHaveCount(0)
  })
})

test('switching a live channel from none to all answers a waiting newcomer; switching back revokes nothing', async ({ browser }) => {
  test.setTimeout(300_000)
  const h = await historyBeforeJoin(admin, cast, browser, 'khs', { visibility: 'none' })
  const benPage = await comeBack(h.benProfile)

  await test.step("under none Ben's sweep leaves Cleo's request waiting", async () => {
    expect(await relayableFor(h.ben)).toEqual([])
    expect((await requestsOf(admin, h.cleo)).every((r) => r.status === 'pending')).toBe(true)
  })

  // Ava's own unlock sweep lists requests before the switch. Listed after it, the request is
  // hers to answer as the session's sender, and Ben's sweep finds it answered.
  const avaPage = await comeBack(h.avaProfile, `/chat/${h.server.id}/${h.server.generalChannelId}`)

  await test.step('Ava turns the channel to all messages in its settings', async () => {
    await expect(messageList(avaPage)).toBeVisible({ timeout: 30000 })
    const dialog = await openChannelSettings(avaPage, 'general')
    const select = dialog.getByTestId('channel-history-visibility')
    await expect(select).toHaveValue('none', { timeout: 15000 })
    await expect(dialog).toContainText('Members who join later read only messages sent after they joined.')
    await expectNoAxeViolations(avaPage, { include: '[role="dialog"]', label: 'channel edit dialog, history visibility' })
    const saved = avaPage.waitForResponse((r) => r.url().includes('/rpc/set_channel_history_visibility'))
    await select.selectOption('all')
    expect((await saved).status()).toBe(200)
    await expect(select).toHaveValue('all')
    const { data } = await admin
      .from('channel_encryption_settings')
      .select('history_visibility')
      .eq('channel_id', h.server.generalChannelId)
      .single()
    expect(data?.history_visibility).toBe('all')
  })

  await test.step("Ben's next unlock relays the earlier session; Cleo reads it", async () => {
    await sweepAgain(benPage)
    await expect
      .poll(async () => (await requestsOf(admin, h.cleo)).some((r) => r.fulfilled_by_user_id === h.ben.id), { timeout: 60000 })
      .toBe(true)
    await h.cleoPage.reload()
    await dismissAnnouncements(h.cleoPage)
    await expect(item(h.cleoPage, h.avaTexts[0])).toHaveCount(1, { timeout: 30000 })
  })

  await test.step('back to none: what Cleo received stays readable', async () => {
    const dialog = avaPage.getByRole('dialog', { name: 'Edit channel' })
    const saved = avaPage.waitForResponse((r) => r.url().includes('/rpc/set_channel_history_visibility'))
    await dialog.getByTestId('channel-history-visibility').selectOption('none')
    expect((await saved).status()).toBe(200)
    await h.cleoPage.reload()
    await dismissAnnouncements(h.cleoPage)
    await expect(item(h.cleoPage, h.avaTexts[0])).toHaveCount(1, { timeout: 30000 })
  })
})
