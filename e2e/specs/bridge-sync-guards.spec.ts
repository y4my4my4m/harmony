// Journey: the Discord bridge bot's sync endpoints against a server's own emoji, stickers and
// sounds (bot-gateway, 20261112500001_bridge_sync_guards.sql).
//
// The bot removes what it imported and nothing a member added: the member's emoji stays in
// Server settings › Emoji while the imported one leaves it. The bot restores an emoji it
// removed, and no longer after the owner removed it.
//
// The bot gateway runs as a child process (e2e/specs/botGateway.ts); rows the bridge would have
// imported are written with the service role, with their images where bot-gateway stores them.

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, seedServer, signIn, userClient, type SeededServer, type SpecUser } from './harness'
import { startBotGateway, type BotGateway } from './botGateway'

const admin = adminClient()
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
const STORAGE = (process.env.E2E_SUPABASE_URL ?? process.env.TEST_SUPABASE_URL ?? '').replace(/\/$/, '')

let owner: SpecUser
let server: SeededServer
let gateway: BotGateway
let botId = ''
let token = ''
const ids = { memberEmoji: '', importedEmoji: '', memberSticker: '', importedSticker: '', memberSound: '', importedSound: '' }

function api(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${gateway.url}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function seedEmoji(name: string, path: string, extra: Record<string, unknown>): Promise<string> {
  const { error: uploadError } = await admin.storage.from('emojis').upload(path, PNG, { contentType: 'image/png', upsert: true })
  if (uploadError) throw new Error(`emoji image ${path}: ${uploadError.message}`)
  const { data, error } = await admin
    .from('emojis')
    .insert({ name, url: `${STORAGE}/storage/v1/object/public/emojis/${path}`, server_id: server.id, scope: 'server', ...extra })
    .select('id')
    .single()
  if (error || !data) throw new Error(`emoji ${name}: ${error?.message}`)
  return data.id
}

async function seedSticker(name: string, file: string, extra: Record<string, unknown>): Promise<string> {
  const path = `server/${server.id}/${file}.png`
  const { data, error } = await admin
    .from('stickers')
    .insert({
      scope: 'server', server_id: server.id, name, description: 'A sticker', path,
      url: `${STORAGE}/storage/v1/object/public/stickers/${path}`, mime_type: 'image/png', file_size: PNG.byteLength,
      width: 1, height: 1, ...extra,
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`sticker ${name}: ${error?.message}`)
  return data.id
}

async function seedSound(name: string, file: string, discordSoundId: string | null): Promise<string> {
  const { data, error } = await admin
    .from('server_sounds')
    .insert({
      server_id: server.id, name, volume: 1, duration_ms: 1000,
      storage_path: `${server.id}/${file}.mp3`, discord_sound_id: discordSoundId,
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`sound ${name}: ${error?.message}`)
  return data.id
}

test.beforeAll(async () => {
  test.setTimeout(120_000)
  owner = await createUser(admin, 'bsg')
  server = await seedServer(admin, owner, `Bridge sync ${owner.username}`)

  const client = await userClient(owner)
  const { data: created, error: botError } = await client.rpc('create_bot', {
    p_username: `brg${owner.username.slice(-8)}`,
    p_display_name: 'Discord Bridge',
    p_bio: 'Bridge sync journey',
    p_bot_type: 'bot',
    p_is_public: false,
  })
  if (botError || !created?.bot?.id || !created?.token) throw new Error(`create_bot: ${botError?.message}`)
  botId = created.bot.id
  token = created.token
  const { error: installError } = await admin.from('bot_server_permissions').insert({
    bot_id: botId, server_id: server.id, installed_by: owner.id, is_active: true, read_messages: true, send_messages: true,
  })
  if (installError) throw new Error(`install: ${installError.message}`)
  const { error: bridgeError } = await admin
    .from('discord_bridges')
    .insert({ server_id: server.id, bot_id: botId, mode: 'self', discord_guild_id: '900000000000000910', created_by: owner.id })
  if (bridgeError) throw new Error(`bridge: ${bridgeError.message}`)

  ids.memberEmoji = await seedEmoji('members_own', `${server.id}/${owner.id}/members_own.png`, { uploader: owner.id })
  ids.importedEmoji = await seedEmoji('from_discord', `${server.id}/discord/9100.png`, { discord_emoji_id: '9100' })
  ids.memberSticker = await seedSticker('members_sticker', '279a0000-0000-4000-8000-000000000001', { uploader: owner.id })
  ids.importedSticker = await seedSticker('discord_sticker', '279a0000-0000-4000-8000-000000000002', { discord_sticker_id: '9200' })
  ids.memberSound = await seedSound('members sound', '279a0000-0000-4000-8000-000000000003', null)
  ids.importedSound = await seedSound('discord sound', '279a0000-0000-4000-8000-000000000004', '9300')

  gateway = await startBotGateway()
})

test.afterAll(async () => {
  await gateway?.stop()
  if (server) {
    await admin.from('server_sounds').delete().eq('server_id', server.id)
    await admin.from('stickers').delete().eq('server_id', server.id)
    await admin.from('emojis').delete().eq('server_id', server.id)
    await admin.storage.from('emojis').remove([`${server.id}/${owner.id}/members_own.png`, `${server.id}/discord/9100.png`])
    await admin.from('discord_bridges').delete().eq('server_id', server.id)
  }
  if (botId) await admin.from('bots').delete().eq('id', botId)
  await deleteUser(admin, owner)
})

test('the bridge bot removes what it imported and nothing a member added', async ({ page }) => {
  test.setTimeout(180_000)

  await test.step('the gateway names the sync features', async () => {
    const me = await api('GET', '/users/@me')
    expect(me.status).toBe(200)
    expect((await me.json()).capabilities).toEqual(expect.arrayContaining(['bridge_sound_sync', 'bridge_emoji_sync', 'bridge_sticker_sync']))
  })

  await signIn(page, owner)
  await page.goto(`/server/${server.id}?section=emoji`)
  const emoji = (name: string) => page.locator('.emoji-item').filter({ hasText: `:${name}:` })
  await expect(emoji('members_own')).toBeVisible({ timeout: 30000 })
  await expect(emoji('from_discord')).toBeVisible()

  await test.step('the emoji list marks the import', async () => {
    const res = await api('GET', `/servers/${server.id}/emojis/discord`)
    expect(res.status).toBe(200)
    const listed = Object.fromEntries(
      ((await res.json()).emojis as Array<{ name: string; imported: boolean; restorable: boolean; removed: boolean }>)
        .map((e) => [e.name, [e.imported, e.removed, e.restorable]]),
    )
    expect(listed).toEqual({ members_own: [false, false, false], from_discord: [true, false, false] })
  })

  await test.step('emoji: the member\'s is refused, the import is removed', async () => {
    const refused = await api('DELETE', `/servers/${server.id}/emojis/${ids.memberEmoji}`)
    expect(refused.status).toBe(403)
    expect((await refused.json()).code).toBe('EMOJI_NOT_LINKED')
    expect((await api('DELETE', `/servers/${server.id}/emojis/${ids.importedEmoji}`)).status).toBe(204)

    await page.reload()
    await expect(emoji('members_own')).toBeVisible({ timeout: 30000 })
    await expect(emoji('from_discord')).toHaveCount(0)
  })

  await test.step('the bot restores the emoji it removed, until the owner removes it', async () => {
    const body = { discord_emoji_id: '9100', name: 'from_discord', animated: false, update: true }
    const restored = await api('POST', `/servers/${server.id}/emojis/discord`, body)
    expect(restored.status).toBe(200)
    expect((await restored.json()).status).toBe('updated')
    await page.reload()
    await expect(emoji('from_discord')).toBeVisible({ timeout: 30000 })

    const client = await userClient(owner)
    const { error } = await client.rpc('remove_emoji', { p_emoji_id: ids.importedEmoji })
    expect(error).toBeNull()
    const refused = await api('POST', `/servers/${server.id}/emojis/discord`, body)
    expect(refused.status).toBe(403)
    expect((await refused.json()).code).toBe('EMOJI_REMOVED')
    await page.reload()
    await expect(emoji('members_own')).toBeVisible({ timeout: 30000 })
    await expect(emoji('from_discord')).toHaveCount(0)
  })

  await test.step('stickers: the member\'s is refused, the import is retired', async () => {
    const refused = await api('DELETE', `/servers/${server.id}/stickers/${ids.memberSticker}`)
    expect(refused.status).toBe(403)
    expect((await refused.json()).code).toBe('STICKER_NOT_LINKED')
    expect((await api('DELETE', `/servers/${server.id}/stickers/${ids.importedSticker}`)).status).toBe(204)
    const { data } = await admin.from('stickers').select('name, removed_at').eq('server_id', server.id).order('name')
    expect(data?.map((s) => [s.name, s.removed_at !== null])).toEqual([['discord_sticker', true], ['members_sticker', false]])
  })

  await test.step('sounds: the member\'s is refused, the import is deleted', async () => {
    const refused = await api('DELETE', `/servers/${server.id}/sounds/${ids.memberSound}`)
    expect(refused.status).toBe(403)
    expect((await refused.json()).code).toBe('SOUND_NOT_LINKED')
    expect((await api('DELETE', `/servers/${server.id}/sounds/${ids.importedSound}`)).status).toBe(204)
    const { data } = await admin.from('server_sounds').select('name').eq('server_id', server.id)
    expect(data?.map((s) => s.name)).toEqual(['members sound'])
  })
})
