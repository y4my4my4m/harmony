// Journey: voice and video encryption is set per voice channel, independent of the server's
// message encryption mode (20261021300001_voice_encryption_per_channel.sql), and a DM call in an
// encrypted conversation is end-to-end encrypted.
//
// The server has no encryption policy row: message encryption is disabled. The owner turns a
// voice channel's encryption on in its settings and creates a second voice channel encrypted;
// both carry the voice lock in the channel list. The owner has no encryption keys, so joining
// an encrypted channel or calling in an encrypted conversation is refused with the key setup
// prompt and rings no one. Server settings name the voice modes Per channel and Required for
// every voice channel; Required locks a channel's voice on.
//
// The stack has no LiveKit and no realtime. A join is refused before the transport is chosen;
// the DM call decision is read from the voice store (resolveVoiceE2EERequired), the value the
// join hands the transport as requireE2EE.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  channelRow,
  createUser,
  deleteUser,
  dismissAnnouncements,
  openChannel,
  openCreateChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'
import { expectNoAxeViolations } from './a11y'

test.describe.configure({ mode: 'serial' })

const admin = adminClient()
let owner: SpecUser
let peer: SpecUser
let server: SeededServer
let lounge = ''
let encryptedConversation = ''
let plainConversation = ''

const VOICE_LOCK = 'Voice and video are end-to-end encrypted'

async function conversationWith(text: string): Promise<string> {
  const { data, error } = await admin.from('conversations').insert({ type: 'direct', created_by: owner.id }).select('id').single()
  if (error || !data) throw new Error(`conversation: ${error?.message}`)
  await admin.from('conversation_participants').insert([
    { conversation_id: data.id, user_id: owner.id },
    { conversation_id: data.id, user_id: peer.id },
  ])
  await admin.from('messages').insert({ conversation_id: data.id, user_id: peer.id, content: [{ type: 'text', text }] })
  return data.id
}

async function voiceRow(channelId: string) {
  const { data } = await admin.from('channel_encryption_settings')
    .select('messages_encrypted, voice_encrypted').eq('channel_id', channelId).single()
  return data
}

test.beforeAll(async () => {
  owner = await createUser(admin, 'vepo')
  peer = await createUser(admin, 'vepp')
  server = await seedServer(admin, owner, `Voice encryption ${owner.username}`)
  const { data: general } = await admin.from('channels').select('category').eq('id', server.generalChannelId).single()
  const { data: channel, error } = await admin.from('channels')
    .insert({ server_id: server.id, name: 'lounge', type: 1, category: general?.category ?? null })
    .select('id').single()
  if (error || !channel) throw new Error(`lounge: ${error?.message}`)
  lounge = channel.id

  encryptedConversation = await conversationWith('hello before encryption')
  plainConversation = await conversationWith('hello in the clear')
  const { error: encError } = await admin.from('conversation_encryption_settings')
    .insert({ conversation_id: encryptedConversation, encryption_enabled: true })
  if (encError) throw new Error(`conversation encryption: ${encError.message}`)
})

test.afterAll(async () => {
  for (const id of [encryptedConversation, plainConversation]) {
    if (id) await admin.from('conversations').delete().eq('id', id)
  }
  await deleteUser(admin, owner)
  await deleteUser(admin, peer)
})

async function openChannelSettings(page: Page, name: string) {
  await channelRow(page, name).click({ button: 'right' })
  await page.locator('.context-menu .context-menu-item').filter({ hasText: 'Edit channel' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit channel' })
  await expect(dialog).toBeVisible({ timeout: 15000 })
  return dialog
}

const lock = (page: Page, name: string) => channelRow(page, name).locator(`.channel-lock[title="${VOICE_LOCK}"]`)

test("a voice channel's encryption is its own while message encryption is disabled", async ({ page }) => {
  test.setTimeout(180_000)
  const { data: policy } = await admin.from('server_encryption_settings').select('server_id').eq('server_id', server.id).maybeSingle()
  expect(policy).toBeNull()

  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await expect(channelRow(page, 'lounge')).toBeVisible({ timeout: 30000 })
  await expect(lock(page, 'lounge')).toHaveCount(0)

  let dialog = await openChannelSettings(page, 'lounge')
  const messages = dialog.getByTestId('channel-messages-encryption')
  const voice = dialog.getByTestId('channel-voice-encryption')

  await test.step('messages are locked off; voice is a free switch', async () => {
    await expect(voice).toHaveAttribute('aria-checked', 'false', { timeout: 15000 })
    await expect(voice).toHaveAttribute('aria-disabled', 'false')
    await expect(messages).toHaveAttribute('aria-disabled', 'true')
    await expect(dialog).toContainText('Calls are encrypted before they reach the media server.')
    await expectNoAxeViolations(page, { include: '[role="dialog"]', label: 'channel edit dialog, voice encryption' })
  })

  await test.step('turning voice on stores it and posts the notice', async () => {
    const saved = page.waitForResponse((r) => r.url().includes('/rpc/set_channel_encryption'))
    await voice.click()
    expect((await saved).status()).toBe(200)
    await expect(voice).toHaveAttribute('aria-checked', 'true')
    expect(await voiceRow(lounge)).toEqual({ messages_encrypted: false, voice_encrypted: true })
    const { count } = await admin.from('messages').select('id', { count: 'exact', head: true })
      .eq('channel_id', lounge).eq('is_system', true).eq('metadata->>type', 'channel_voice_encryption_enabled')
    expect(count).toBe(1)
  })

  await test.step('the channel list shows the voice lock', async () => {
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(lock(page, 'lounge')).toHaveCount(1)
  })

  await test.step('the setting survives a reload', async () => {
    await openChannel(page, server.id, server.generalChannelId)
    await expect(lock(page, 'lounge')).toHaveCount(1, { timeout: 30000 })
    dialog = await openChannelSettings(page, 'lounge')
    await expect(dialog.getByTestId('channel-voice-encryption')).toHaveAttribute('aria-checked', 'true', { timeout: 15000 })
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })
})

test('a voice channel is created encrypted', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const modal = await openCreateChannel(page)

  await modal.locator('label.channel-type-option').filter({ hasText: 'Voice' }).click()
  const voiceSwitch = modal.getByTestId('create-voice-encryption').getByRole('switch', { name: 'Encrypt voice and video' })
  await expect(voiceSwitch).toHaveAttribute('aria-checked', 'false')
  // Message encryption is disabled on this server; its option is absent.
  await expect(modal.getByRole('switch', { name: 'End-to-end encryption' })).toHaveCount(0)
  await voiceSwitch.click()
  await expect(voiceSwitch).toHaveAttribute('aria-checked', 'true')
  await modal.locator('input.modern-input').fill('secret lounge')
  await expectNoAxeViolations(page, { include: '[role="dialog"]', label: 'create channel dialog, voice encryption' })

  // The channel is created encrypted: create_channel carries the choice.
  const saved = page.waitForResponse((r) => r.url().includes('/rpc/create_channel'))
  await modal.locator('button').filter({ hasText: 'Create channel' }).click()
  const response = await saved
  expect(response.status()).toBe(200)
  expect(response.request().postDataJSON()).toMatchObject({ p_type: 1, p_voice_encrypted: true })
  await expect(modal).toBeHidden({ timeout: 30000 })

  const { data: created } = await admin.from('channels').select('id, type').eq('server_id', server.id).eq('name', 'secret lounge').single()
  expect(created?.type).toBe(1)
  expect(await voiceRow(created!.id)).toEqual({ messages_encrypted: false, voice_encrypted: true })
  await expect(lock(page, 'secret lounge')).toHaveCount(1, { timeout: 30000 })
})

test('joining an encrypted voice channel without keys opens the setup prompt', async ({ page }) => {
  test.setTimeout(180_000)
  await admin.from('voice_channel_participants').delete().eq('channel_id', lounge)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  await channelRow(page, 'lounge').locator('.channel-item').click()
  await expect(page.getByText('This voice channel is end-to-end encrypted. Set up encryption to join.')).toBeVisible({ timeout: 30000 })
  await expect(page.getByRole('heading', { name: 'Set up message encryption' })).toBeVisible({ timeout: 15000 })

  const voice = await page.evaluate(() => {
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, Record<string, unknown>> } } } }
    }
    const store = root.__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel')!
    return { isConnected: store.isConnected, isConnecting: store.isConnecting, joinError: store.joinError }
  })
  expect(voice).toEqual({
    isConnected: false,
    isConnecting: false,
    joinError: 'This voice channel is end-to-end encrypted. Set up encryption to join.',
  })
  // A refused join never announced presence.
  const { count } = await admin.from('voice_channel_participants').select('user_id', { count: 'exact', head: true }).eq('channel_id', lounge)
  expect(count).toBe(0)
})

test('server settings name the voice modes; Required locks every voice channel on', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, owner)
  await page.goto(`/server/${server.id}?section=privacy`)
  await dismissAnnouncements(page)

  const group = page.getByRole('radiogroup', { name: 'Voice & video encryption' })
  await expect(group).toBeVisible({ timeout: 30000 })
  const perChannel = group.getByRole('radio', { name: 'Per channel' })
  const required = group.getByRole('radio', { name: 'Required for every voice channel' })
  await expect(perChannel).toBeChecked()
  await expect(required).not.toBeChecked()
  await expect(page.getByRole('radiogroup', { name: 'Encryption mode' }).getByRole('radio', { name: 'Disabled' })).toBeChecked()
  await expectNoAxeViolations(page, { include: '.server-encryption-settings', label: 'server encryption settings' })

  await test.step('Required is saved apart from the message mode', async () => {
    await group.locator('label').filter({ hasText: 'Required for every voice channel' }).click()
    await expect(required).toBeChecked()
    const saved = page.waitForResponse((r) => r.url().includes('/server_encryption_settings') && r.request().method() === 'POST')
    await page.getByRole('button', { name: 'Save changes' }).first().click()
    expect((await saved).status()).toBeLessThan(300)
    const { data } = await admin.from('server_encryption_settings')
      .select('encryption_mode, voice_encryption_mode').eq('server_id', server.id).single()
    expect(data).toEqual({ encryption_mode: 'disabled', voice_encryption_mode: 'required' })
  })

  await test.step("a voice channel's switch is on and locked", async () => {
    await openChannel(page, server.id, server.generalChannelId)
    const dialog = await openChannelSettings(page, 'secret lounge')
    const voice = dialog.getByTestId('channel-voice-encryption')
    await expect(voice).toHaveAttribute('aria-checked', 'true', { timeout: 15000 })
    await expect(voice).toHaveAttribute('aria-disabled', 'true')
    await expect(dialog).toContainText('This server requires encrypted voice and video in every voice channel.')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })

  await test.step('back to Per channel, the channels stay encrypted and unlocked', async () => {
    await admin.from('server_encryption_settings').update({ voice_encryption_mode: 'disabled' }).eq('server_id', server.id)
    await openChannel(page, server.id, server.generalChannelId)
    const dialog = await openChannelSettings(page, 'lounge')
    const voice = dialog.getByTestId('channel-voice-encryption')
    await expect(voice).toHaveAttribute('aria-checked', 'true', { timeout: 15000 })
    await expect(voice).toHaveAttribute('aria-disabled', 'false')
    await page.keyboard.press('Escape')
  })
})

test('a DM call in an encrypted conversation is end-to-end encrypted', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, owner)
  await page.goto(`/dm/${encryptedConversation}`)
  await dismissAnnouncements(page)
  await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 30000 })

  await test.step('the voice store requires E2EE for this conversation only', async () => {
    const decided = await page.evaluate(async ({ encrypted, plain }) => {
      const root = document.querySelector('#app') as unknown as {
        __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, any> } } } }
      }
      const voice = root.__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel')
      return {
        encrypted: await voice.resolveVoiceE2EERequired('dm', `dm-${encrypted}`),
        plain: await voice.resolveVoiceE2EERequired('dm', `dm-${plain}`),
        federated: await voice.resolveVoiceE2EERequired('dm', `federated-dm-${encrypted}`),
      }
    }, { encrypted: encryptedConversation, plain: plainConversation })
    expect(decided).toEqual({ encrypted: true, plain: false, federated: false })
    await expectNoAxeViolations(page, { include: '.dm-header', label: 'DM header' })
  })

  await test.step('calling without keys opens the setup prompt and rings no one', async () => {
    await page.getByTitle('Start voice call').click()
    await expect(page.getByText('Calls in this conversation are end-to-end encrypted. Set up encryption to call or answer.'))
      .toBeVisible({ timeout: 30000 })
    await expect(page.getByRole('heading', { name: 'Set up message encryption' })).toBeVisible({ timeout: 15000 })
    const { count } = await admin.from('messages').select('id', { count: 'exact', head: true })
      .eq('conversation_id', encryptedConversation).eq('metadata->>type', 'call_started')
    expect(count).toBe(0)
  })
})
