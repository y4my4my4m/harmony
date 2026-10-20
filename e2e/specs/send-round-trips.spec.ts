// Journey: a warm send costs one PostgREST request, the insert. The server is an ocean away
// from some members (0.2-0.6 s per round trip), so every serial request before the insert
// delays the pending row turning into the sent one.
//
// The window runs from Enter until the row loses its temp- id. Requests issued before the
// insert are the send's critical path and must be absent. One kind is excluded from that
// prefix: mark_channel_as_read / mark_conversation_as_read, the list's read marker for the
// warm-up message, which fires on its own timer and is not awaited by the send. Requests
// after the insert are listed in the log and do not count against the send.
//
// A channel encrypted while it is open still sends on the first Enter: the database refuses
// the plaintext row, the client re-reads the channel and inserts once more, encrypted. The
// stack runs no realtime, so the open client is never told of the change; the refusal is
// its only signal.

import { test, expect, type Page, type Request, type Response } from '@playwright/test'
import {
  adminClient,
  composer,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  sendMessage,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'
import { setUpEncryption } from './encryption'

const admin = adminClient()
let owner: SpecUser
let partner: SpecUser
let server: SeededServer
let conversationId: string

test.beforeAll(async () => {
  owner = await createUser(admin, 'rtto')
  partner = await createUser(admin, 'rttp')
  server = await seedServer(admin, owner, `Round trips ${owner.username}`)

  const { data, error } = await admin
    .from('conversations')
    .insert({ type: 'direct', created_by: owner.id })
    .select('id')
    .single()
  if (error || !data) throw new Error(`conversation: ${error?.message}`)
  conversationId = data.id
  await admin.from('conversation_participants').insert([
    { conversation_id: conversationId, user_id: owner.id },
    { conversation_id: conversationId, user_id: partner.id },
  ])
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
  await deleteUser(admin, partner)
})

interface Logged {
  at: number
  method: string
  url: string
  status?: number
}

/** Requests to PostgREST and storage in issue order, with their response status once known. */
function recordBackendRequests(page: Page): Logged[] {
  const log: Logged[] = []
  const byRequest = new Map<Request, Logged>()
  page.on('request', (request: Request) => {
    const url = request.url()
    if (!url.includes('/rest/v1/') && !url.includes('/storage/v1/')) return
    const entry = { at: Date.now(), method: request.method(), url: decodeURIComponent(url) }
    byRequest.set(request, entry)
    log.push(entry)
  })
  page.on('response', (response: Response) => {
    const entry = byRequest.get(response.request())
    if (entry) entry.status = response.status()
  })
  return log
}

const isMessageInsert = (r: Logged) => r.method === 'POST' && /\/rest\/v1\/messages(\?|$)/.test(r.url)
const isReadMarker = (r: Logged) => /\/rpc\/mark_(channel|conversation)_as_read/.test(r.url)

/** Sends `text` and returns the backend requests issued between Enter and confirmation. */
async function measuredSend(page: Page, log: Logged[], text: string): Promise<Logged[]> {
  await composer(page).click()
  await composer(page).pressSequentially(text, { delay: 10 })
  const start = Date.now()
  await page.keyboard.press('Enter')
  const posted = messageList(page).locator('.message-item').filter({ hasText: text }).last()
  await expect(posted).toBeVisible({ timeout: 30000 })
  await expect(posted).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
  return log.filter((r) => r.at >= start)
}

function describe(requests: Logged[]): string {
  return requests
    .map((r) => `${r.method} ${r.url.replace(/^https?:\/\/[^/]+/, '')}${r.status ? ` ${r.status}` : ''}`)
    .join('\n')
}

function expectOnlyTheInsert(window: Logged[]) {
  const inserts = window.filter(isMessageInsert)
  expect(inserts, describe(window)).toHaveLength(1)
  const beforeInsert = window.slice(0, window.indexOf(inserts[0])).filter((r) => !isReadMarker(r))
  expect(beforeInsert, describe(window)).toEqual([])
}

test('a warm channel send issues the insert and nothing before it', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await sendMessage(page, `warm-up ${owner.username}`)

  const log = recordBackendRequests(page)
  const window = await measuredSend(page, log, `measured ${owner.username}`)
  console.log(`channel send window:\n${describe(window)}`)
  expectOnlyTheInsert(window)
})

test('a warm DM send issues the insert and nothing before it', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await page.goto(`/dm/${conversationId}`)
  await expect(messageList(page)).toBeVisible({ timeout: 30000 })
  await sendMessage(page, `dm warm-up ${owner.username}`)

  const log = recordBackendRequests(page)
  const window = await measuredSend(page, log, `dm measured ${owner.username}`)
  console.log(`DM send window:\n${describe(window)}`)
  expectOnlyTheInsert(window)
})

test('a channel encrypted while open sends the next message encrypted, on the first Enter', async ({ page }) => {
  test.setTimeout(150_000)
  const later = await seedServer(admin, owner, `Encrypted later ${owner.username}`)
  await signIn(page, owner)
  await openChannel(page, later.id, later.generalChannelId)
  await setUpEncryption(page, owner)
  await sendMessage(page, `plain before ${owner.username}`)

  await test.step('the server starts requiring encryption; the open client is not told', async () => {
    const { error } = await admin
      .from('server_encryption_settings')
      .upsert({ server_id: later.id, encryption_mode: 'required' }, { onConflict: 'server_id' })
    if (error) throw new Error(`encryption floor: ${error.message}`)
  })

  const secret = `secret after ${owner.username}`
  const log = recordBackendRequests(page)
  const window = await measuredSend(page, log, secret)
  console.log(`encrypted-since send window:\n${describe(window)}`)

  await test.step('the refused plaintext insert is followed by one encrypted insert', async () => {
    await expect.poll(() => window.filter(isMessageInsert).every((r) => r.status !== undefined)).toBe(true)
    const inserts = window.filter(isMessageInsert)
    expect(inserts.map((r) => r.status), describe(window)).toEqual([400, 201])
    const between = window.slice(window.indexOf(inserts[0]), window.indexOf(inserts[1]))
    expect(between.filter((r) => r.url.includes('/rpc/effective_channel_encryption')), describe(window)).toHaveLength(1)
  })

  await test.step('the stored row is ciphertext; the sender reads the text', async () => {
    const { data, error } = await admin
      .from('messages')
      .select('encrypted, content')
      .eq('channel_id', later.generalChannelId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
    if (error || !data) throw new Error(`stored row: ${error?.message}`)
    expect(data.encrypted).toBe(true)
    expect(JSON.stringify(data.content)).not.toContain(secret)
    await expect(messageList(page).locator('.message-item').filter({ hasText: secret })).toHaveCount(1)
  })

  await test.step('the next send is encrypted without a refusal', async () => {
    const next = `secret again ${owner.username}`
    const again = await measuredSend(page, log, next)
    const inserts = again.filter(isMessageInsert)
    await expect.poll(() => inserts.every((r) => r.status !== undefined)).toBe(true)
    expect(inserts.map((r) => r.status), describe(again)).toEqual([201])
  })
})

test('a DM encrypted while open sends the next message encrypted, on the first Enter', async ({ page }) => {
  test.setTimeout(150_000)
  const { data, error } = await admin
    .from('conversations')
    .insert({ type: 'direct', created_by: owner.id })
    .select('id')
    .single()
  if (error || !data) throw new Error(`conversation: ${error?.message}`)
  const later = data.id as string
  await admin.from('conversation_participants').insert([
    { conversation_id: later, user_id: owner.id },
    { conversation_id: later, user_id: partner.id },
  ])

  await signIn(page, owner)
  await page.goto(`/dm/${later}`)
  await expect(messageList(page)).toBeVisible({ timeout: 30000 })
  await setUpEncryption(page, owner)
  await sendMessage(page, `dm plain before ${owner.username}`)

  await test.step('the partner turns encryption on; the open client is not told', async () => {
    const { error: toggleError } = await admin
      .from('conversation_encryption_settings')
      .upsert({ conversation_id: later, encryption_enabled: true }, { onConflict: 'conversation_id' })
    if (toggleError) throw new Error(`encryption: ${toggleError.message}`)
  })

  const secret = `dm secret after ${owner.username}`
  const log = recordBackendRequests(page)
  const window = await measuredSend(page, log, secret)
  console.log(`DM encrypted-since send window:\n${describe(window)}`)

  await test.step('the refused plaintext insert is followed by one encrypted insert', async () => {
    await expect.poll(() => window.filter(isMessageInsert).every((r) => r.status !== undefined)).toBe(true)
    expect(window.filter(isMessageInsert).map((r) => r.status), describe(window)).toEqual([400, 201])
  })

  await test.step('the stored row is ciphertext; the sender reads the text', async () => {
    const { data: stored, error: readError } = await admin
      .from('messages')
      .select('encrypted, content')
      .eq('conversation_id', later)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
    if (readError || !stored) throw new Error(`stored row: ${readError?.message}`)
    expect(stored.encrypted).toBe(true)
    expect(JSON.stringify(stored.content)).not.toContain(secret)
    await expect(messageList(page).locator('.message-item').filter({ hasText: secret })).toHaveCount(1)
  })
})
