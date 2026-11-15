// Journey: with bridge attachments set to "Refresh on demand", an expired Discord file link a
// member pasted is re-signed when someone views it.
//
//   pasted link  a member sends an expired cdn.discordapp.com link; the client asks the bot gateway,
//                which re-signs it with the instance Discord application's token and writes it
//                back without marking the message edited ("discord.com" is a local HTTPS server,
//                fakeHttpsHost.ts). The stack has no realtime: a reload shows the new link, which
//                plays. The browser's cdn.discordapp.com is a route: 404 for an expired signature.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'
import {
  adminClient,
  composer,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  signIn,
  userClient,
  type SpecUser,
} from './harness'
import { startBotGateway } from './botGateway'
import { fakeHttpsHost } from './fakeHttpsHost'

const CLIP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/clip-6s.webm'))
const ATTACHMENT = '/attachments/492163058312151061/1569015022057693324/clip.webm'
// Passes discord_bridge_instance_bot_set's three-segment check; not shaped like a real Discord token.
const BOT_TOKEN = 'e2e-fake-bot.token.not-a-discord-token'

const admin = adminClient()
const users: SpecUser[] = []
const hex = (ms: number) => Math.floor(ms / 1000).toString(16)
const live = (url: string) => parseInt(new URL(url).searchParams.get('ex') ?? '0', 16) * 1000 > Date.now()

test.afterAll(async () => {
  for (const u of users) await deleteUser(admin, u)
})

async function instanceConfig(key: string) {
  const { data } = await admin.from('instance_config').select('config_key, config_value').eq('config_key', key).maybeSingle()
  return data
}

async function restoreConfig(key: string, previous: { config_key: string; config_value: unknown } | null) {
  if (previous) await admin.from('instance_config').upsert(previous, { onConflict: 'config_key' })
  else await admin.from('instance_config').delete().eq('config_key', key)
}

test("a member's expired Discord link is re-signed when viewed", async ({ page }) => {
  test.setTimeout(150_000)
  const staff = await createUser(admin, 'dlrs')
  const member = await createUser(admin, 'dlrm')
  users.push(staff, member)
  const { error: adminError } = await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  if (adminError) throw new Error(`is_admin: ${adminError.message}`)
  const server = await seedServer(admin, member, `Discord links ${member.username}`)

  const previousMode = await instanceConfig('bridge_attachment_mode')
  const previousEnabled = await instanceConfig('discord_bridge_instance_bot_enabled')
  const staffDb = await userClient(staff)

  const discordCalls: Array<{ path: string; auth: string; urls: string[] }> = []
  const discord = await fakeHttpsHost('discord.com', (req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const urls = (JSON.parse(body || '{}').attachment_urls ?? []) as string[]
      discordCalls.push({ path: req.url ?? '', auth: String(req.headers.authorization), urls })
      const refreshed_urls = urls.map((original) => ({
        original,
        refreshed: `${original.split('?')[0]}?ex=${hex(Date.now() + 86_400_000)}&is=${hex(Date.now())}&hm=${'b'.repeat(64)}&`,
      }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ refreshed_urls }))
    })
  })
  const gateway = await startBotGateway(discord.env)

  try {
    for (const [key, value] of [['bridge_attachment_mode', 'refresh'], ['discord_bridge_instance_bot_enabled', true]] as const) {
      const { error } = await admin.from('instance_config').upsert({ config_key: key, config_value: value }, { onConflict: 'config_key' })
      if (error) throw new Error(`${key}: ${error.message}`)
    }
    const { error: botError } = await staffDb.rpc('discord_bridge_instance_bot_set', {
      p_application_id: '111111111111111111', p_client_secret: 'e2e-client-secret-0123456789', p_bot_token: BOT_TOKEN,
    })
    if (botError) throw new Error(`discord_bridge_instance_bot_set: ${botError.message}`)

    // The app's /bot-gateway path, served by the spawned gateway.
    await page.route('**/bot-gateway/attachments/refresh', async (route) => {
      const response = await route.fetch({ url: `${gateway.url}/attachments/refresh` })
      await route.fulfill({ response })
    })
    const cdnRequests: string[] = []
    await page.route('https://cdn.discordapp.com/**', (route) => {
      cdnRequests.push(route.request().url())
      return live(route.request().url())
        ? route.fulfill({ status: 200, contentType: 'video/webm', body: CLIP })
        : route.fulfill({ status: 404, contentType: 'text/plain', body: 'This content is no longer available.' })
    })

    const expired = `https://cdn.discordapp.com${ATTACHMENT}?ex=${hex(Date.now() - 3_600_000)}&is=${hex(Date.now() - 90_000_000)}&hm=${'a'.repeat(64)}&`
    await signIn(page, member)
    await openChannel(page, server.id, server.generalChannelId)
    await composer(page).click()
    await composer(page).pressSequentially(expired, { delay: 5 })
    await page.keyboard.press('Enter')

    const posted = messageList(page).locator('.message-item').filter({ has: page.locator('video.content-video') }).last()
    await expect(posted).toBeVisible({ timeout: 30000 })
    await expect(posted).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
    const messageId = await posted.getAttribute('data-message-id')
    expect(messageId).toBeTruthy()

    // Re-signed with the instance application's token and written back.
    const stored = async () => {
      const { data } = await admin.from('messages').select('content, created_at, updated_at').eq('id', messageId as string).single()
      return data as { content: Array<{ type: string; url?: string }>; created_at: string; updated_at: string }
    }
    await expect.poll(async () => (await stored()).content.find((p) => p.type === 'url')?.url, { timeout: 30000 })
      .not.toBe(expired)
    const row = await stored()
    const fresh = row.content.find((p) => p.type === 'url')?.url as string
    expect(fresh).toMatch(new RegExp(`^https://cdn\\.discordapp\\.com${ATTACHMENT}\\?ex=`))
    expect(live(fresh)).toBe(true)
    expect(row.updated_at).toBe(row.created_at)
    expect(discordCalls).toEqual([{ path: '/api/v10/attachments/refresh-urls', auth: `Bot ${BOT_TOKEN}`, urls: [expired] }])
    expect(discord.tunnels).toEqual(['discord.com:443'])
    expect(cdnRequests.some((u) => !live(u))).toBe(true)

    await page.reload()
    const video = messageList(page).locator(`.message-item[data-message-id="${messageId}"] video.content-video`)
    await expect(video).toHaveAttribute('src', fresh, { timeout: 30000 })
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 30000 }).toBeGreaterThan(0)
    await expect(video.evaluate((v: HTMLVideoElement) => v.error?.code ?? null)).resolves.toBeNull()
    await expect(messageList(page).locator(`.message-item[data-message-id="${messageId}"] .edited-indicator`)).toHaveCount(0)
    expect(discordCalls).toHaveLength(1)
  } finally {
    await gateway.stop()
    await discord.close()
    await staffDb.rpc('discord_bridge_instance_bot_clear')
    await restoreConfig('discord_bridge_instance_bot_enabled', previousEnabled)
    await restoreConfig('bridge_attachment_mode', previousMode)
  }
})
