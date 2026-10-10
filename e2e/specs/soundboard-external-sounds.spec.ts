// Journey: soundboard sounds of other servers (20261012300001_soundboard_external_sounds.sql).
//
// A member of Home, Echo and Quiet opens the soundboard in a Home voice channel. Echo's
// sound is listed under Echo and plays; Quiet, whose owner stopped sharing in Server
// Settings, is absent. In a channel denying USE_EXTERNAL_SOUNDS the Echo sound is disabled
// and says why, while Home's own sound stays playable. A signed-in user of none of these
// servers resolves Echo's sound and not Quiet's.
//
// The stack has no LiveKit, realtime or storage, so no call can be joined and no clip
// fetched. The voice store is set as a joined call leaves it; the dock, its soundboard
// button and the popover then run against the real database. Delivery of a play to other
// participants and its playback are not covered here.

import { randomUUID } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import {
  adminClient,
  addMember,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

test.describe.configure({ mode: 'serial' })

const admin = adminClient()
let owner: SpecUser
let member: SpecUser
let stranger: SpecUser
let home: SeededServer
let echo: SeededServer
let quiet: SeededServer
let openVoice: string
let lockedVoice: string

const SOUNDS = {
  doorbell: randomUUID(),
  applause: randomUUID(),
  hush: randomUUID(),
}

// USE_EXTERNAL_SOUNDS, bit 31.
const USE_EXTERNAL_SOUNDS = 2 ** 31

async function addVoiceChannel(server: SeededServer, name: string): Promise<string> {
  const { data, error } = await admin
    .from('channels')
    .insert({ server_id: server.id, name, type: 1 })
    .select('id')
    .single()
  if (error || !data) throw new Error(`voice channel ${name}: ${error?.message}`)
  return data.id
}

async function addSound(server: SeededServer, id: string, name: string, emoji: string): Promise<void> {
  // Service-role inserts skip the client guard that wants the file in the soundboard bucket;
  // the stack has no storage.
  const { error } = await admin.from('server_sounds').insert({
    id,
    server_id: server.id,
    name,
    emoji,
    volume: 0.8,
    duration_ms: 1200,
    storage_path: `${server.id}/${id}.mp3`,
  })
  if (error) throw new Error(`sound ${name}: ${error.message}`)
}

test.beforeAll(async () => {
  owner = await createUser(admin, 'sbo')
  member = await createUser(admin, 'sbm')
  stranger = await createUser(admin, 'sbs')
  home = await seedServer(admin, owner, `Home ${owner.username}`)
  echo = await seedServer(admin, owner, `Echo ${owner.username}`)
  quiet = await seedServer(admin, owner, `Quiet ${owner.username}`)
  for (const server of [home, echo, quiet]) await addMember(admin, member, server.id)

  await addSound(home, SOUNDS.doorbell, 'Doorbell', '🔔')
  await addSound(echo, SOUNDS.applause, 'Applause', '👏')
  await addSound(quiet, SOUNDS.hush, 'Hush', '🤫')

  openVoice = await addVoiceChannel(home, 'lounge')
  lockedVoice = await addVoiceChannel(home, 'stage-left')
  const { data: everyone, error: roleError } = await admin
    .from('server_roles')
    .select('id')
    .eq('server_id', home.id)
    .eq('is_default', true)
    .single()
  if (roleError || !everyone) throw new Error(`@everyone of ${home.name}: ${roleError?.message}`)
  const { error } = await admin.from('channel_permission_overrides').insert({
    channel_id: lockedVoice,
    target_type: 'role',
    role_id: everyone.id,
    allow_permissions: 0,
    deny_permissions: USE_EXTERNAL_SOUNDS,
  })
  if (error) throw new Error(`override: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
  await deleteUser(admin, member)
  await deleteUser(admin, stranger)
})

/**
 * The voice store as a joined call leaves it. Only the fields the soundboard reads are set;
 * no transport exists, so a play is recorded locally and sent nowhere.
 */
async function enterVoice(page: Page, serverId: string, channelId: string, userId: string): Promise<void> {
  await page.evaluate(({ serverId, channelId, userId }) => {
    type Store = { $patch: (fn: (state: Record<string, any>) => void) => void }
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, Store> } } } }
    }
    const voice = root.__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel')
    if (!voice) throw new Error('voice store not created')
    voice.$patch((state) => {
      state.isConnected = true
      state.currentServerId = serverId
      state.currentChannelId = channelId
      state.currentChannelName = 'voice'
      state.localState.userId = userId
    })
  }, { serverId, channelId, userId })
}

async function openSoundboard(page: Page) {
  const button = page.locator('.unified-voice-dock .soundboard-btn')
  await expect(button).toBeVisible({ timeout: 30000 })
  await button.click()
  const popover = page.locator('.sbp')
  await expect(popover).toBeVisible({ timeout: 10000 })
  return popover
}

const section = (popover: ReturnType<Page['locator']>, serverId: string) =>
  popover.locator(`[data-testid="soundboard-section-external"][data-server-id="${serverId}"]`)

test('a sound manager stops sharing the server\'s sounds in Server Settings', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await page.goto(`/server/${quiet.id}?section=soundboard`)
  const toggle = page.locator('[data-testid="soundboard-share-toggle"]')
  await expect(toggle).toBeVisible({ timeout: 30000 })
  await expect(toggle).toHaveAttribute('aria-checked', 'true')

  const saved = page.waitForResponse(
    (r) => r.url().includes('/rest/v1/rpc/set_server_sound_sharing') && r.request().method() === 'POST',
  )
  await toggle.click()
  expect((await saved).ok()).toBe(true)
  await expect(toggle).toHaveAttribute('aria-checked', 'false')

  const { data } = await admin
    .from('server_settings')
    .select('allow_cross_server_sounds')
    .eq('server_id', quiet.id)
    .single()
  expect(data?.allow_cross_server_sounds).toBe(false)

  await page.reload()
  await expect(page.locator('[data-testid="soundboard-share-toggle"]')).toHaveAttribute('aria-checked', 'false', {
    timeout: 30000,
  })
})

test('the soundboard lists the member\'s other servers that share sounds', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, member)
  await openChannel(page, home.id, home.generalChannelId)

  await test.step('in a channel allowing external sounds, Echo\'s sound plays', async () => {
    await enterVoice(page, home.id, openVoice, member.id)
    const popover = await openSoundboard(page)

    const own = popover.locator('[data-testid="soundboard-section-server"]')
    await expect(own.locator('.sbp-section-name')).toHaveText(home.name)
    await expect(own.locator('[data-testid="soundboard-tile"]')).toHaveText(['🔔Doorbell'])

    const echoSection = section(popover, echo.id)
    await expect(echoSection).toBeVisible({ timeout: 30000 })
    await expect(echoSection.locator('.sbp-section-name')).toHaveText(echo.name)
    const applause = echoSection.locator('[data-testid="soundboard-tile"]')
    await expect(applause).toHaveText(['👏Applause'])
    await expect(applause).toBeEnabled()
    await expect(echoSection.locator('[data-testid="soundboard-locked"]')).toHaveCount(0)

    await expect(section(popover, quiet.id)).toHaveCount(0)
    await expect(popover.getByText('Hush')).toHaveCount(0)

    await applause.click()
    await expect(page.locator('.sba-item').filter({ hasText: 'Applause' })).toBeVisible({ timeout: 10000 })
  })

  await test.step('the search reaches every section', async () => {
    const popover = page.locator('.sbp')
    await popover.locator('[data-testid="soundboard-search"]').fill('appl')
    await expect(popover.locator('[data-testid="soundboard-tile"]')).toHaveText(['👏Applause'])
    await popover.locator('[data-testid="soundboard-search"]').fill('')
    await popover.press('Escape')
    await expect(popover).toBeHidden()
  })

  await test.step('in a channel denying USE_EXTERNAL_SOUNDS, Echo\'s sound is disabled', async () => {
    await enterVoice(page, home.id, lockedVoice, member.id)
    const popover = await openSoundboard(page)

    const echoSection = section(popover, echo.id)
    await expect(echoSection).toBeVisible({ timeout: 30000 })
    const applause = echoSection.locator('[data-testid="soundboard-tile"]')
    await expect(applause).toBeDisabled({ timeout: 10000 })
    await expect(applause).toHaveAttribute('title', /Use External Sounds/)
    await expect(echoSection.locator('[data-testid="soundboard-locked"]')).toBeVisible()

    const doorbell = popover.locator('[data-testid="soundboard-section-server"] [data-testid="soundboard-tile"]')
    await expect(doorbell).toBeEnabled()
  })
})

test('a listener outside the sound\'s server resolves a shared sound, not an unshared one', async () => {
  const client = await userClient(stranger)

  const { data: shared, error } = await client.rpc('resolve_soundboard_sound', {
    p_sound_id: SOUNDS.applause,
    p_server_id: home.id,
  })
  expect(error).toBeNull()
  expect(shared).toEqual([
    expect.objectContaining({
      id: SOUNDS.applause,
      server_id: echo.id,
      name: 'Applause',
      duration_ms: 1200,
      storage_path: `${echo.id}/${SOUNDS.applause}.mp3`,
    }),
  ])

  const { data: table } = await client.from('server_sounds').select('id').eq('id', SOUNDS.applause)
  expect(table).toEqual([])

  const { data: unshared } = await client.rpc('resolve_soundboard_sound', {
    p_sound_id: SOUNDS.hush,
    p_server_id: home.id,
  })
  expect(unshared).toEqual([])

  const { data: library } = await client.rpc('list_soundboard_library')
  expect(library).toEqual([])

  const anon = createClient(
    process.env.E2E_SUPABASE_URL ?? process.env.TEST_SUPABASE_URL ?? '',
    process.env.E2E_SUPABASE_ANON_KEY ?? process.env.TEST_SUPABASE_ANON_KEY ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
  const { error: anonError } = await anon.rpc('resolve_soundboard_sound', {
    p_sound_id: SOUNDS.applause,
    p_server_id: home.id,
  })
  expect(anonError?.code).toBe('42501')
})
