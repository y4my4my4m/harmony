// Journey: deleting the only message of a thread deletes the thread (migration 20261106200001).
// The member deleting it in the thread side panel is left in the channel with the panel closed;
// in the full thread view, is returned to the channel. The thread leaves the channel list and
// no error toast shows. A viewer of the thread who did not delete it is returned to the channel
// when the thread:delete broadcast arrives. Deleting a channel message that started a thread
// says what happens to the thread: with replies the thread stays, without replies it goes. A
// deleted thread opened again, from the channel's 'started a thread' notice or its address,
// says it was deleted and closes.
//
// The stack runs no Realtime server. The broadcast is handed to the page's threads store as
// broadcast_thread_change sends it on server-structure:<server id>.

import crypto from 'node:crypto'
import { test, expect, type Page, type Locator } from '@playwright/test'
import {
  addMember,
  adminClient,
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
let owner: SpecUser
let member: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  owner = await createUser(admin, 'eto')
  member = await createUser(admin, 'etm')
  server = await seedServer(admin, owner, `Empty threads ${owner.username}`)
  await addMember(admin, member, server.id)
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  await deleteUser(admin, owner)
  await deleteUser(admin, member)
})

const tag = () => crypto.randomUUID().slice(0, 6)

/** A standalone thread by `author` holding one message of theirs. */
async function threadWithOneMessage(author: SpecUser, name: string, text: string): Promise<string> {
  const client = await userClient(author)
  const { data: id, error } = await client.rpc('create_channel_thread', {
    p_channel_id: server.generalChannelId, p_name: name, p_auto_archive_duration: 1440,
  })
  if (error || !id) throw new Error(`thread ${name}: ${error?.message}`)
  const sent = await client.from('messages').insert({
    channel_id: server.generalChannelId, thread_id: id, user_id: author.id, content: [{ type: 'text', text }],
  })
  if (sent.error) throw new Error(`message in ${name}: ${sent.error.message}`)
  return id as string
}

async function threadRow(id: string) {
  const { data } = await admin.from('threads').select('id').eq('id', id).maybeSingle()
  return data
}

const sidebarThread = (page: Page, name: string) => page.locator('.channel-thread-item').filter({ hasText: name })
const errorToasts = (page: Page) => page.locator('.Vue-Toastification__toast--error')
const rowIn = (scope: Locator, text: string) =>
  scope.locator('[data-testid="message-list"]').getByRole('article').filter({ hasText: text })

/** Deletes a message through its context menu and the confirmation. */
async function deleteRow(page: Page, row: Locator, button = 'Delete') {
  await row.click({ button: 'right' })
  await page.getByRole('menu', { name: 'Message options' }).getByRole('menuitem', { name: 'Delete message' }).click()
  await confirmDelete(page, button)
}

/** A phone's long press opens the floating message actions; Delete is one of them. */
async function deleteRowByLongPress(page: Page, row: Locator) {
  const box = (await row.boundingBox())!
  const touch = { identifier: 1, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }
  await row.dispatchEvent('touchstart', { touches: [touch], changedTouches: [touch], targetTouches: [touch] })
  await page.waitForTimeout(900)
  await row.dispatchEvent('contextmenu', { clientX: touch.clientX, clientY: touch.clientY, button: 2 })
  await row.dispatchEvent('touchend', { touches: [], changedTouches: [touch], targetTouches: [] })
  await page.getByRole('toolbar', { name: 'Message actions' }).getByTestId('msg-action-delete').tap()
  await confirmDelete(page, 'Delete')
}

async function confirmDelete(page: Page, button: string) {
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: button, exact: true }).click()
  await expect(confirm).toBeHidden()
}

async function openThreadPanel(page: Page, name: string): Promise<Locator> {
  await page.locator('.chat-header .threads-btn').click()
  const modal = page.locator('.threads-modal')
  await expect(modal).toBeVisible({ timeout: 15000 })
  await modal.locator('.thread-item').filter({ has: page.locator('.thread-name', { hasText: name }) }).click()
  const panel = page.locator('.thread-panel')
  await expect(panel.locator('.thread-info h3')).toHaveText(name, { timeout: 15000 })
  return panel
}

async function openThreadFullView(page: Page, name: string, id: string): Promise<Locator> {
  await sidebarThread(page, name).click()
  await page.waitForURL(new RegExp(`/chat/${server.id}/thread/${id}$`), { timeout: 15000 })
  const view = page.locator('.thread-full-view')
  await expect(view.locator('.thread-title')).toHaveText(name, { timeout: 15000 })
  return view
}

const channelUrl = () => new RegExp(`/chat/${server.id}/${server.generalChannelId}$`)

test('the only message deleted in the side panel takes the thread; the panel closes on the channel', async ({ page }) => {
  test.setTimeout(150_000)
  const name = `Panel ${tag()}`
  const text = `only in ${name}`
  const id = await threadWithOneMessage(member, name, text)

  await signIn(page, member)
  await openChannel(page, server.id, server.generalChannelId)
  await expect(sidebarThread(page, name)).toBeVisible({ timeout: 30000 })
  const panel = await openThreadPanel(page, name)
  const row = rowIn(panel, text)
  await expect(row).toBeVisible({ timeout: 30000 })

  await deleteRow(page, row)

  await expect(panel).toBeHidden({ timeout: 15000 })
  await expect(page).toHaveURL(channelUrl())
  await expect(messageList(page)).toBeVisible()
  await expect(sidebarThread(page, name)).toHaveCount(0)
  await expect.poll(() => threadRow(id), { timeout: 15000 }).toBeNull()
  await expect(errorToasts(page)).toHaveCount(0)

  await page.locator('.chat-header .threads-btn').click()
  const modal = page.locator('.threads-modal')
  await expect(modal).toBeVisible({ timeout: 15000 })
  await expect(modal.locator('.thread-item').filter({ hasText: name })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(modal).toBeHidden()

  // The channel keeps its 'started a thread' notice, as a manual thread delete leaves it.
  await messageList(page).locator('.system-thread-link').filter({ hasText: name }).click()
  await expect(page.locator('.Vue-Toastification__toast--info').filter({ hasText: 'This thread was deleted.' }))
    .toBeVisible({ timeout: 15000 })
  await expect(panel).toBeHidden({ timeout: 15000 })
  await expect(page).toHaveURL(channelUrl())
  await expect(errorToasts(page)).toHaveCount(0)
})

test('the only message deleted in the full thread view takes the thread; the view returns to the channel', async ({ page }) => {
  test.setTimeout(150_000)
  const name = `Full ${tag()}`
  const text = `only in ${name}`
  const id = await threadWithOneMessage(member, name, text)

  await signIn(page, member)
  await openChannel(page, server.id, server.generalChannelId)
  const view = await openThreadFullView(page, name, id)
  const row = rowIn(view, text)
  await expect(row).toBeVisible({ timeout: 30000 })

  await deleteRow(page, row)

  await expect(page).toHaveURL(channelUrl(), { timeout: 15000 })
  await expect(view).toBeHidden()
  await expect(sidebarThread(page, name)).toHaveCount(0)
  await expect.poll(() => threadRow(id), { timeout: 15000 }).toBeNull()
  await expect(errorToasts(page)).toHaveCount(0)

  // Its address, opened again, says the thread was deleted and leaves the thread view.
  await page.goto(`/chat/${server.id}/thread/${id}`)
  await expect(page.locator('.Vue-Toastification__toast--info').filter({ hasText: 'This thread was deleted.' }))
    .toBeVisible({ timeout: 30000 })
  await expect(page).not.toHaveURL(/\/thread\//, { timeout: 15000 })
  await expect(errorToasts(page)).toHaveCount(0)
})

test('a viewer of a thread another member emptied returns to the channel when the delete is broadcast', async ({ page }) => {
  test.setTimeout(150_000)
  const name = `Watched ${tag()}`
  const text = `only in ${name}`
  const id = await threadWithOneMessage(member, name, text)

  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const view = await openThreadFullView(page, name, id)
  await expect(rowIn(view, text)).toBeVisible({ timeout: 30000 })

  const client = await userClient(member)
  const removed = await client.from('messages').update({ is_deleted: true, content: [{ type: 'text', text: '[deleted]' }] })
    .eq('thread_id', id).select('id')
  expect(removed.data?.length).toBe(1)
  await expect.poll(() => threadRow(id), { timeout: 15000 }).toBeNull()

  // broadcast_thread_change's payload for the DELETE, as server-structure delivers it.
  await page.evaluate(async (threadId) => {
    const app = (document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, { applyBroadcast: (e: unknown) => Promise<void> }> } } } }
    }).__vue_app__
    await app.config.globalProperties.$pinia._s.get('threads')!.applyBroadcast({ type: 'thread:delete', new: null, old: { id: threadId } })
  }, id)

  await expect(page).toHaveURL(channelUrl(), { timeout: 15000 })
  await expect(sidebarThread(page, name)).toHaveCount(0)
  await expect(errorToasts(page)).toHaveCount(0)
})

test('a starter with replies keeps its thread; one without replies takes it', async ({ page }) => {
  test.setTimeout(150_000)
  const ownerClient = await userClient(owner)
  const starter = async (label: string) => {
    const { data, error } = await ownerClient.from('messages').insert({
      channel_id: server.generalChannelId, user_id: owner.id, content: [{ type: 'text', text: label }],
    }).select('id').single()
    if (error || !data) throw new Error(`starter ${label}: ${error?.message}`)
    return data.id as string
  }
  const keptName = `Kept ${tag()}`
  const goneName = `Gone ${tag()}`
  const keptStarter = await starter(`starter of ${keptName}`)
  const goneStarter = await starter(`starter of ${goneName}`)
  const create = async (messageId: string, threadName: string) => {
    const { data, error } = await ownerClient.rpc('create_thread', {
      p_message_id: messageId, p_name: threadName, p_auto_archive_duration: 1440,
    })
    if (error || !data) throw new Error(`thread ${threadName}: ${error?.message}`)
    return data as string
  }
  const keptId = await create(keptStarter, keptName)
  const goneId = await create(goneStarter, goneName)
  const reply = await (await userClient(member)).from('messages').insert({
    channel_id: server.generalChannelId, thread_id: keptId, user_id: member.id, content: [{ type: 'text', text: 'a reply' }],
  })
  if (reply.error) throw new Error(`reply: ${reply.error.message}`)

  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await expect(sidebarThread(page, keptName)).toBeVisible({ timeout: 30000 })
  await expect(sidebarThread(page, goneName)).toBeVisible({ timeout: 30000 })

  await test.step('with a reply: the dialog says the thread stays, and it does', async () => {
    const row = messageList(page).getByRole('article').filter({ hasText: `starter of ${keptName}` })
    await row.click({ button: 'right' })
    await page.getByRole('menu', { name: 'Message options' }).getByRole('menuitem', { name: 'Delete message' }).click()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toContainText(`This message started the thread “${keptName}”.`)
    await expect(confirm).toContainText('The thread and its replies stay; the thread shows this message as deleted.')
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(confirm).toBeHidden()
    await expect.poll(async () => (await admin.from('messages').select('is_deleted').eq('id', keptStarter).single()).data?.is_deleted,
      { timeout: 15000 }).toBe(true)
    expect(await threadRow(keptId)).not.toBeNull()
    await expect(sidebarThread(page, keptName)).toBeVisible()
  })

  await test.step('without replies: the dialog says the thread goes, and it does', async () => {
    const row = messageList(page).getByRole('article').filter({ hasText: `starter of ${goneName}` })
    await row.click({ button: 'right' })
    await page.getByRole('menu', { name: 'Message options' }).getByRole('menuitem', { name: 'Delete message' }).click()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toContainText('The thread has no replies and is deleted with this message.')
    await confirm.getByRole('button', { name: 'Delete message and thread', exact: true }).click()
    await expect(confirm).toBeHidden()
    await expect.poll(() => threadRow(goneId), { timeout: 15000 }).toBeNull()
    await expect(sidebarThread(page, goneName)).toHaveCount(0)
  })

  await test.step('after a reload the kept thread is listed and the other is not', async () => {
    await openChannel(page, server.id, server.generalChannelId)
    await expect(sidebarThread(page, keptName)).toBeVisible({ timeout: 30000 })
    await expect(sidebarThread(page, goneName)).toHaveCount(0)
    await expect(errorToasts(page)).toHaveCount(0)
  })
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

  test('the only message deleted in the thread panel takes the thread', async ({ page }) => {
    test.setTimeout(150_000)
    const name = `Phone ${tag()}`
    const text = `only in ${name}`
    const id = await threadWithOneMessage(member, name, text)

    await signIn(page, member)
    await openChannel(page, server.id, server.generalChannelId)
    await page.getByRole('button', { name: 'More options' }).first().tap()
    await page.getByRole('menuitem', { name: /threads/i }).tap()
    await page.locator('.threads-modal').getByText(name).first().tap()
    const panel = page.locator('.thread-panel')
    await expect(panel.locator('.thread-info h3')).toHaveText(name, { timeout: 15000 })
    const row = rowIn(panel, text)
    await expect(row).toBeVisible({ timeout: 30000 })

    await deleteRowByLongPress(page, row)

    await expect(panel).toBeHidden({ timeout: 15000 })
    await expect(page).toHaveURL(channelUrl())
    await expect.poll(() => threadRow(id), { timeout: 15000 }).toBeNull()
    await expect(errorToasts(page)).toHaveCount(0)
  })
})
