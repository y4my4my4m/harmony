// Journey: a reply typed into a push notification is sent only as the account the notification
// was for (public/service-worker.js 3.10, ServiceWorkerManager.drainQuickReplyQueue).
//
// Playwright cannot press a system notification's Reply: the worker's own handleQuickReply runs in
// the worker with the notification data and the text, as its notificationclick handler calls it.
// ann and ben share a group conversation. ann's reply is sent as ann. After ann signs out, a reply
// to her stale notification and one naming no account (as a worker before 3.10 queues it) wait in
// the queue; ben signs in on the same browser and neither is sent as him. ben's own reply is.

import { test, expect, type Page, type Worker } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
let ann: SpecUser
let ben: SpecUser
let groupId = ''

const posted = async () => ((await admin.from('messages').select('user_id, content')
  .eq('conversation_id', groupId).order('created_at')).data ?? [])
  .map((m: { user_id: string; content: Array<{ text?: string }> }) =>
    `${m.user_id === ann.id ? 'ann' : m.user_id === ben.id ? 'ben' : 'other'}: ${m.content?.[0]?.text}`)

/** Entries in the worker's queue, read as the app reads them. */
const queued = (page: Page) => page.evaluate(() => new Promise<number>((resolve, reject) => {
  const open = indexedDB.open('harmony-sw', 1)
  open.onupgradeneeded = () => open.result.createObjectStore('pending-quick-replies', { keyPath: 'id', autoIncrement: true })
  open.onerror = () => reject(open.error)
  open.onsuccess = () => {
    const request = open.result.transaction('pending-quick-replies', 'readonly').objectStore('pending-quick-replies').count()
    request.onsuccess = () => { open.result.close(); resolve(request.result) }
    request.onerror = () => reject(request.error)
  }
}))

/** handleQuickReply as notificationclick runs it; focusing a window may be refused without a click. */
const typeReply = (worker: Worker, data: Record<string, unknown>, text: string) =>
  worker.evaluate(([d, t]) => (self as any).handleQuickReply(d, t).catch(() => null), [data, text] as const)

test.beforeAll(async () => {
  ann = await createUser(admin, 'qrann')
  ben = await createUser(admin, 'qrben')
  const { data, error } = await admin.from('conversations')
    .insert({ type: 'group', name: 'quick replies', created_by: ann.id }).select('id').single()
  if (error || !data) throw new Error(`conversation: ${error?.message}`)
  groupId = data.id
  const joined = await admin.from('conversation_participants').insert([
    { conversation_id: groupId, user_id: ann.id, role: 'admin' },
    { conversation_id: groupId, user_id: ben.id, role: 'member' },
  ])
  if (joined.error) throw new Error(`participants: ${joined.error.message}`)
})

test.afterAll(async () => {
  if (groupId) await admin.from('conversations').delete().eq('id', groupId)
  await deleteUser(admin, ann)
  await deleteUser(admin, ben)
})

test('a quick reply is sent only as the account its notification was for', async ({ context, page }) => {
  test.setTimeout(180_000)

  await signIn(page, ann)
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')

  await test.step('ann\'s reply to her notification is sent as ann', async () => {
    await typeReply(worker, { conversation_id: groupId, recipient_id: ann.id }, 'ann from the tray')
    await expect.poll(posted, { timeout: 30000 }).toEqual(['ann: ann from the tray'])
  })

  await test.step('replies typed after ann signs out wait in the queue', async () => {
    await page.goto('/logout')
    await page.getByTestId('logout-confirm-btn').click()
    await expect(page).toHaveURL(/login|\/$/, { timeout: 30000 })
    await typeReply(worker, { conversation_id: groupId, recipient_id: ann.id }, 'ann after sign-out')
    await typeReply(worker, { conversation_id: groupId }, 'no account after sign-out')
    await expect.poll(() => queued(page), { timeout: 15000 }).toBe(2)
  })

  await test.step('ben signs in on the same browser and neither is sent as him', async () => {
    await signIn(page, ben)
    // The drain that runs once ben's data has loaded drops what is not his.
    await expect.poll(() => queued(page), { timeout: 30000 }).toBe(0)
    await page.waitForTimeout(2000)
    expect(await posted()).toEqual(['ann: ann from the tray'])
  })

  await test.step('ben\'s reply to his notification is sent as ben', async () => {
    await typeReply(worker, { conversation_id: groupId, recipient_id: ben.id }, 'ben from the tray')
    await expect.poll(posted, { timeout: 30000 }).toEqual(['ann: ann from the tray', 'ben: ben from the tray'])
  })
})
