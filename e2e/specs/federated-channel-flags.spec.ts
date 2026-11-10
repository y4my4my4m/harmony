// Journey: a copy of a server hosted elsewhere shows what its host says of each channel
// (channels.host_flags, migration 20261109900001): the lock on an encrypted channel, the private
// mark on a channel or category @everyone cannot view. An encrypted text channel's composer gives
// way to a note, and an encrypted voice channel says why it cannot be joined without asking the
// host. A plain channel of the same copy shows none of it.
//
// This stack has no federation backend: the rows are written here as it writes them.

import { test, expect, type Page } from '@playwright/test'
import crypto from 'node:crypto'
import { adminClient, channelRow, createUser, deleteUser, openChannel, signIn, type SpecUser } from './harness'
import { expectNoAxeViolations } from './a11y'

test.use({ serviceWorkers: 'block' })
test.describe.configure({ mode: 'serial' })

const admin = adminClient()
const host = 'flags.example'
const VOICE_NOTE = 'This channel is end-to-end encrypted on its home instance, so accounts from other instances cannot join its calls.'
const MESSAGES_NOTE = 'This channel is end-to-end encrypted on its home instance, so accounts from other instances cannot read or send its messages.'

const copy = {
  id: crypto.randomUUID(),
  category: crypto.randomUUID(),
  general: crypto.randomUUID(),
  vault: crypto.randomUUID(),
  staff: crypto.randomUUID(),
  lounge: crypto.randomUUID(),
  plainVoice: crypto.randomUUID(),
}
const groupUrl = `https://${host}/servers/${copy.id}`
const hostOwner = { id: crypto.randomUUID(), username: `fcf${Date.now().toString(36)}` }
let member: SpecUser

async function must<T extends { error: { message: string } | null }>(what: string, result: PromiseLike<T>): Promise<T> {
  const r = await result
  if (r.error) throw new Error(`${what}: ${r.error.message}`)
  return r
}

test.beforeAll(async () => {
  member = await createUser(admin, 'fcf')
  await must('host owner', admin.from('profiles').insert({
    id: hostOwner.id, username: hostOwner.username, display_name: hostOwner.username, domain: host, is_local: false,
    federated_id: `https://${host}/users/${hostOwner.username}`, inbox_url: `https://${host}/users/${hostOwner.username}/inbox`,
  }))
  await must('copy', admin.from('servers').insert({
    id: copy.id, name: `Flags ${member.username.slice(-4)}`, owner: hostOwner.id, public: true, is_local_server: false,
    federation_enabled: true, ap_id: groupUrl, federation_inbox_url: `${groupUrl}/inbox`, federation_domain: host,
  }))
  await admin.from('channels').delete().eq('server_id', copy.id)
  await must('category', admin.from('channel_categories').insert(
    { id: copy.category, server_id: copy.id, name: 'Hidden', order: 1, host_flags: { private: true } },
  ))
  const channel = (id: string, name: string, type: number, order: number, host_flags: Record<string, boolean>, category?: string) => ({
    id, server_id: copy.id, name, type, order, is_remote: true, ap_id: `${groupUrl}/channels/${id}`, host_flags, category: category ?? null,
  })
  await must('channels', admin.from('channels').insert([
    channel(copy.general, 'general', 0, 0, {}),
    channel(copy.vault, 'vault', 0, 1, { messages: true }),
    channel(copy.lounge, 'lounge', 1, 2, { voice: true }),
    channel(copy.plainVoice, 'plain-voice', 1, 3, {}),
    channel(copy.staff, 'staff', 0, 0, { private: true }, copy.category),
  ]))
  await must('membership', admin.from('user_servers').upsert(
    { server_id: copy.id, user_id: member.id, status: 'accepted', member_instance: 'localhost' },
    { onConflict: 'user_id,server_id' },
  ))
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', copy.id)
  await admin.from('profiles').delete().eq('id', hostOwner.id)
  await deleteUser(admin, member)
})

const row = (page: Page, id: string) => page.locator(`[data-nav-kind="channel"][data-nav-id="${id}"]`)

test('a copy shows the lock and the private mark its host gives a channel', async ({ page }) => {
  test.setTimeout(120_000)
  await page.route('**/servers/*/status', (route) => route.fulfill({ json: { federationClosed: false } }))
  await signIn(page, member)
  await openChannel(page, copy.id, copy.general)

  await expect(row(page, copy.vault).locator(`.channel-lock[title="${MESSAGES_NOTE}"]`)).toBeVisible()
  await expect(row(page, copy.lounge).locator(`.channel-lock[title="${VOICE_NOTE}"]`)).toBeVisible()
  await expect(row(page, copy.staff).locator('.channel-lock[title="Private channel"]')).toBeVisible()
  await expect(page.locator(`button.category-header[data-nav-id="${copy.category}"]`)).toHaveAttribute('data-private', 'true')

  await expect(row(page, copy.general).locator('.channel-lock')).toHaveCount(0)
  await expect(row(page, copy.plainVoice).locator('.channel-lock')).toHaveCount(0)

  // The state reaches a screen reader through the row's own text.
  await expect(row(page, copy.vault).locator('.sr-only')).toContainText(MESSAGES_NOTE)
  await expect(row(page, copy.staff).locator('.sr-only')).toContainText('rivate')
})

test('an encrypted text channel replaces its composer with a note; a plain one keeps it', async ({ page }) => {
  test.setTimeout(120_000)
  await page.route('**/servers/*/status', (route) => route.fulfill({ json: { federationClosed: false } }))
  await signIn(page, member)

  await openChannel(page, copy.id, copy.general)
  await expect(page.getByTestId('home-encrypted-note')).toHaveCount(0)
  await expect(page.locator('.message-container')).toBeVisible()

  await openChannel(page, copy.id, copy.vault)
  const note = page.getByTestId('home-encrypted-note')
  await expect(note).toBeVisible()
  await expect(note).toContainText(MESSAGES_NOTE)
  await expect(page.locator('.message-container')).toHaveCount(0)
  await expect(page.locator('.channel-details .channel-lock')).toHaveAttribute('title', MESSAGES_NOTE)
  await expectNoAxeViolations(page, { include: '[data-testid="home-encrypted-note"]', label: 'home-encrypted composer note' })
})

test('an encrypted voice channel says why before asking the host', async ({ page }) => {
  test.setTimeout(120_000)
  const joins: string[] = []
  await page.route('**/servers/*/status', (route) => route.fulfill({ json: { federationClosed: false } }))
  await page.route('**/api/federation/voice/join', (route) => {
    joins.push(route.request().postData() ?? '')
    return route.fulfill({ status: 500, json: { error: 'unreached in this journey' } })
  })

  await signIn(page, member)
  await openChannel(page, copy.id, copy.general)

  // A click during the sidebar's first render can be lost.
  await expect(async () => {
    await row(page, copy.lounge).click()
    await expect(page.getByText(VOICE_NOTE, { exact: true }).first()).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await expect(page.getByText('Could not join voice')).toBeVisible()
  expect(joins).toEqual([])
  const state = await page.evaluate(() => {
    const pinia = (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia
    const voice = pinia._s.get('unifiedVoiceChannel')
    return { connecting: voice.isConnecting as boolean, connected: voice.isConnected as boolean, optimistic: voice.optimisticChannelId as string | null }
  })
  expect(state).toEqual({ connecting: false, connected: false, optimistic: null })

  await row(page, copy.plainVoice).click()
  await expect.poll(() => joins.length, { timeout: 15_000 }).toBeGreaterThan(0)
})

test('a flag the host turned off leaves the channel as any other', async ({ page }) => {
  test.setTimeout(120_000)
  await page.route('**/servers/*/status', (route) => route.fulfill({ json: { federationClosed: false } }))
  await must('flag off', admin.from('channels').update({ host_flags: {} }).eq('id', copy.vault))

  await signIn(page, member)
  await openChannel(page, copy.id, copy.vault)
  await expect(page.locator('.message-container')).toBeVisible()
  await expect(page.getByTestId('home-encrypted-note')).toHaveCount(0)
  await expect(row(page, copy.vault).locator('.channel-lock')).toHaveCount(0)
  await expect(channelRow(page, 'lounge').locator('.channel-lock')).toHaveCount(1)
})
