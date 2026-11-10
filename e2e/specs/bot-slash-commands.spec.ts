// Journey: bot slash commands. A bot registers commands with PUT /commands, a member picks one
// from the composer's `/` list, fills its options in the command bar and runs it; the gateway
// delivers INTERACTION_CREATE to that bot and the bot answers through /interactions/{id}/...
//
// Covered: a public answer headed "<member> used /weather" for a second member; an answer only
// the invoker sees; defer then edit; two connections answering yield one reply; a command
// needing BAN_MEMBERS absent from a member's list; no answer within 5 s; a disconnected bot
// refused as offline; a command run in a thread answered in the thread; a Japanese command name.

import { test, expect, type Page } from '@playwright/test'
import WebSocket from 'ws'
import {
  addMember,
  adminClient,
  composer,
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
import { startBotGateway, type BotGateway } from './botGateway'

const admin = adminClient()
let owner: SpecUser
let alice: SpecUser
let bob: SpecUser
let server: SeededServer
let botId = ''
let botName = ''
let token = ''
let gateway: BotGateway

const COMMANDS = [
  {
    name: 'weather',
    description: 'Current weather for a city',
    options: [
      { type: 3, name: 'city', description: 'City name', required: true, max_length: 80 },
      { type: 3, name: 'units', description: 'Units', choices: [{ name: 'Celsius', value: 'c' }, { name: 'Fahrenheit', value: 'f' }] },
    ],
  },
  { name: 'ping', description: 'Answer only to you' },
  { name: 'later', description: 'Defers, then answers' },
  { name: 'silent', description: 'Never answers' },
  { name: 'secret', description: 'Moderators only', required_permissions: ['BAN_MEMBERS'] },
  { name: '天気', description: '天気を表示します' },
]

type Interaction = {
  id: string
  channel_id: string
  thread_id: string | null
  user: { id: string; username: string }
  data: { name: string; options?: Array<{ name: string; type: number; value?: unknown }> }
  respond_by: string
  expires_at: string
}

/** One identified gateway connection that records INTERACTION_CREATE and answers by command name. */
class BotConnection {
  readonly interactions: Interaction[] = []
  private constructor(private ws: WebSocket) {}

  static async open(answer: (i: Interaction) => Promise<void>): Promise<BotConnection> {
    const ws = new WebSocket(gateway.wsUrl)
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const conn = new BotConnection(ws)
    const ready = new Promise<void>((resolve) => {
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString())
        if (frame.t === 'READY') resolve()
        if (frame.t === 'INTERACTION_CREATE') {
          conn.interactions.push(frame.d)
          answer(frame.d).catch((err) => console.error('answer failed:', err))
        }
      })
    })
    ws.send(JSON.stringify({ op: 2, d: { token } }))
    await ready
    return conn
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return
    const closed = new Promise((resolve) => this.ws.once('close', resolve))
    this.ws.close()
    await closed
  }
}

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${gateway.url}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const callback = (id: string, body: unknown) => api('POST', `/interactions/${id}/callback`, body)

/** The answers this spec's bot gives, by command name. */
async function standardAnswer(i: Interaction): Promise<void> {
  if (i.data.name === 'weather') {
    const city = i.data.options?.find((o) => o.name === 'city')?.value
    expect((await callback(i.id, { type: 4, data: { content: `Sunny in ${city}` } })).status).toBe(204)
  } else if (i.data.name === 'ping') {
    expect((await callback(i.id, { type: 4, data: { content: 'Pong, privately', flags: 64 } })).status).toBe(204)
  } else if (i.data.name === 'later') {
    // Past the 5 s answer window, so the invoker's line is seen deferred first.
    expect((await callback(i.id, { type: 5, data: {} })).status).toBe(204)
    await new Promise((resolve) => setTimeout(resolve, 8000))
    expect((await api('PATCH', `/interactions/${i.id}/response`, { content: 'Done after a wait' })).status).toBe(200)
  } else if (i.data.name === '天気') {
    await callback(i.id, { type: 4, data: { content: '東京は晴れ' } })
  }
}

async function presence(): Promise<string | undefined> {
  const { data } = await admin.from('bot_presence').select('status').eq('bot_id', botId).maybeSingle()
  return data?.status
}

/** Types `/<prefix>` into the composer and picks the bot command with that full name. */
async function pickCommand(page: Page, prefix: string, name: string): Promise<void> {
  await composer(page).click()
  await composer(page).pressSequentially(`/${prefix}`, { delay: 20 })
  const row = page.locator(`[data-testid="bot-command-suggestion"][data-command-name="${name}"]`)
  await expect(row).toBeVisible({ timeout: 15000 })
  await row.click()
  await expect(page.getByTestId('bot-command-bar')).toBeVisible({ timeout: 5000 })
}

const notices = (page: Page) => page.getByTestId('bot-interaction-notice')
const botMessage = (page: Page, text: string) =>
  messageList(page).locator('.message-item').filter({ hasText: text })

test.beforeAll(async () => {
  owner = await createUser(admin, 'slo')
  server = await seedServer(admin, owner, `Commands ${owner.username}`)
  const client = await userClient(owner)
  botName = `cmd${owner.username.slice(-8)}`
  const { data, error } = await client.rpc('create_bot', {
    p_username: botName,
    p_display_name: 'Weatherbot',
    p_bio: 'Answers slash commands',
    p_bot_type: 'bot',
    p_is_public: false,
  })
  if (error || !data?.bot?.id || !data?.token) throw new Error(`create_bot: ${error?.message}`)
  botId = data.bot.id
  token = data.token
  const { error: installError } = await admin.from('bot_server_permissions').insert({
    bot_id: botId, server_id: server.id, installed_by: owner.id, is_active: true, read_messages: true, send_messages: true,
  })
  if (installError) throw new Error(`install: ${installError.message}`)
  alice = await createUser(admin, 'sla')
  bob = await createUser(admin, 'slb')
  await addMember(admin, alice, server.id)
  await addMember(admin, bob, server.id)
  gateway = await startBotGateway()

  const put = await api('PUT', '/commands', COMMANDS)
  if (put.status !== 200) throw new Error(`PUT /commands: ${put.status} ${await put.text()}`)
})

test.afterAll(async () => {
  await gateway?.stop()
  await deleteUser(admin, bob)
  await deleteUser(admin, alice)
  await deleteUser(admin, owner)
})

test('registration keeps ids and refuses Discord permission bits', async () => {
  const listed = await (await api('GET', '/commands')).json() as Array<{ id: string; name: string; required_permissions: string[] }>
  expect(listed.map((c) => c.name).sort()).toEqual(COMMANDS.map((c) => c.name).sort())
  expect(listed.find((c) => c.name === 'secret')?.required_permissions).toEqual(['BAN_MEMBERS'])

  const again = await (await api('PUT', '/commands', COMMANDS)).json() as Array<{ id: string; name: string }>
  expect(Object.fromEntries(again.map((c) => [c.name, c.id]))).toEqual(Object.fromEntries(listed.map((c) => [c.name, c.id])))

  const discordBits = await api('POST', '/commands', { name: 'kick', description: 'Kick', default_member_permissions: '2' })
  expect(discordBits.status).toBe(400)
})

test('a member runs a command and everyone sees the public answer', async ({ browser }) => {
  test.setTimeout(120_000)
  const bot = await BotConnection.open(standardAnswer)
  const aliceContext = await browser.newContext()
  const bobContext = await browser.newContext()
  try {
    const alicePage = await aliceContext.newPage()
    const bobPage = await bobContext.newPage()
    await signIn(alicePage, alice)
    await openChannel(alicePage, server.id, server.generalChannelId)
    await signIn(bobPage, bob)
    await openChannel(bobPage, server.id, server.generalChannelId)

    await test.step('the command bar takes the option and Enter runs it', async () => {
      await pickCommand(alicePage, 'wea', 'weather')
      await alicePage.getByTestId('bot-command-option-city').fill('Tokyo')
      await alicePage.keyboard.press('Enter')
      await expect.poll(() => bot.interactions.length, { timeout: 15000 }).toBe(1)
      const [interaction] = bot.interactions
      expect(interaction.user.id).toBe(alice.id)
      expect(interaction.channel_id).toBe(server.generalChannelId)
      expect(interaction.data.options).toEqual([{ name: 'city', type: 3, value: 'Tokyo' }])
    })

    await test.step('both members see the answer with its header; only Alice saw the pending line', async () => {
      await expect(notices(alicePage)).toHaveCount(1)
      await expect(notices(bobPage)).toHaveCount(0)
      // No push without Realtime: Alice's line re-reads the interaction at its 5 s deadline and
      // fetches the answer into the channel; Bob reloads.
      await expect(botMessage(alicePage, 'Sunny in Tokyo')).toHaveCount(1, { timeout: 20000 })
      await expect(notices(alicePage)).toHaveCount(0, { timeout: 10000 })
      await bobPage.reload()
      for (const page of [alicePage, bobPage]) {
        const answer = botMessage(page, 'Sunny in Tokyo')
        await expect(answer).toHaveCount(1, { timeout: 20000 })
        await expect(answer.getByTestId('interaction-header')).toContainText('used /weather')
        await expect(answer.getByTestId('interaction-header')).toContainText(alice.displayName)
        // The bot is private: members read its name through get_bot_profile.
        await expect(answer).toContainText('Weatherbot')
      }
      await expect(notices(bobPage)).toHaveCount(0)
    })

    await test.step('a private answer reaches only the invoker, and Dismiss removes it', async () => {
      await pickCommand(alicePage, 'pin', 'ping')
      await alicePage.keyboard.press('Enter')
      const reply = alicePage.getByTestId('bot-interaction-reply')
      await expect(reply).toContainText('Pong, privately', { timeout: 20000 })
      await expect(notices(alicePage)).toContainText('Only you can see this')
      await expect(bobPage.getByText('Pong, privately')).toHaveCount(0)
      await expect(botMessage(alicePage, 'Pong, privately')).toHaveCount(0)
      await alicePage.getByTestId('bot-interaction-dismiss').click()
      await expect(notices(alicePage)).toHaveCount(0)
    })

    await test.step('a deferred answer keeps the line waiting, then arrives when the bot edits it in', async () => {
      await pickCommand(alicePage, 'lat', 'later')
      await alicePage.keyboard.press('Enter')
      await expect(notices(alicePage)).toHaveAttribute('data-status', 'deferred', { timeout: 15000 })
      await expect(notices(alicePage)).toContainText('is thinking')
      await expect.poll(async () => {
        const { data } = await admin.from('messages').select('id').eq('bot_id', botId)
          .filter('content', 'cs', JSON.stringify([{ text: 'Done after a wait' }]))
        return data?.length
      }, { timeout: 30000 }).toBe(1)
      await bobPage.reload()
      const answer = botMessage(bobPage, 'Done after a wait')
      await expect(answer).toHaveCount(1, { timeout: 20000 })
      await expect(answer.getByTestId('interaction-header')).toContainText('used /later')
    })

    await test.step('a Japanese command name is listed and runs', async () => {
      await pickCommand(alicePage, '天', '天気')
      await alicePage.keyboard.press('Enter')
      await expect(botMessage(alicePage, '東京は晴れ')).toHaveCount(1, { timeout: 20000 })
    })

    await test.step('without an answer the invoker sees that the bot did not respond', async () => {
      await pickCommand(alicePage, 'sil', 'silent')
      await alicePage.keyboard.press('Enter')
      const notice = notices(alicePage)
      await expect(notice).toBeVisible({ timeout: 10000 })
      await expect(notice).toHaveAttribute('data-status', 'timed_out', { timeout: 15000 })
      const late = bot.interactions.find((i) => i.data.name === 'silent')!
      expect((await callback(late.id, { type: 4, data: { content: 'too late' } })).status).toBe(400)
    })

    await test.step('a command needing BAN_MEMBERS is not offered to a member without it', async () => {
      await composer(alicePage).click()
      await alicePage.keyboard.press('Escape')
      await composer(alicePage).fill('')
      await composer(alicePage).pressSequentially('/sec', { delay: 20 })
      await expect(alicePage.locator('[data-testid="bot-command-suggestion"][data-command-name="secret"]')).toHaveCount(0)
      const ownerClient = await userClient(owner)
      const { data } = await ownerClient.rpc('get_channel_bot_commands', { p_channel_id: server.generalChannelId, p_thread_id: null })
      expect((data as Array<{ name: string }>).map((c) => c.name)).toContain('secret')
    })
  } finally {
    await bot.close()
    await aliceContext.close()
    await bobContext.close()
  }
})

test('two connections answering post one reply', async () => {
  test.setTimeout(60_000)
  const statuses: number[] = []
  const answerBoth = async (i: Interaction) => {
    statuses.push((await callback(i.id, { type: 4, data: { content: `once ${i.id}` } })).status)
  }
  const first = await BotConnection.open(answerBoth)
  const second = await BotConnection.open(answerBoth)
  try {
    const aliceClient = await userClient(alice)
    const commandId = (await (await api('GET', '/commands')).json() as Array<{ id: string; name: string }>)
      .find((c) => c.name === 'weather')!.id
    const { data, error } = await aliceClient.rpc('invoke_bot_command', {
      p_channel_id: server.generalChannelId, p_thread_id: null, p_command_id: commandId, p_path: [], p_options: { city: 'Osaka' },
    })
    expect(error).toBeNull()
    const id = (data as { id: string }).id
    await expect.poll(() => statuses.length, { timeout: 15000 }).toBe(2)
    expect(statuses.sort()).toEqual([204, 400])
    await expect.poll(async () => {
      const { data: rows } = await admin.from('messages').select('id').eq('bot_id', botId).eq('metadata->interaction->>id', id)
      return rows?.length
    }, { timeout: 15000 }).toBe(1)
  } finally {
    await first.close()
    await second.close()
  }
})

test('a command run in a thread is answered in the thread', async () => {
  test.setTimeout(60_000)
  const bot = await BotConnection.open(standardAnswer)
  try {
    const created = await api('POST', `/channels/${server.generalChannelId}/threads`, { name: 'Forecasts' })
    expect(created.status).toBe(201)
    const threadId = (await created.json()).id as string
    const aliceClient = await userClient(alice)
    const commandId = (await (await api('GET', '/commands')).json() as Array<{ id: string; name: string }>)
      .find((c) => c.name === 'weather')!.id
    const { error } = await aliceClient.rpc('invoke_bot_command', {
      p_channel_id: server.generalChannelId, p_thread_id: threadId, p_command_id: commandId, p_path: [], p_options: { city: 'Kyoto' },
    })
    expect(error).toBeNull()
    await expect.poll(() => bot.interactions.find((i) => i.thread_id === threadId)?.thread_id, { timeout: 15000 }).toBe(threadId)
    await expect.poll(async () => {
      const { data } = await admin.from('messages').select('thread_id').eq('bot_id', botId).filter('content', 'cs', JSON.stringify([{ text: 'Sunny in Kyoto' }]))
      return data?.map((m) => m.thread_id)
    }, { timeout: 15000 }).toEqual([threadId])
  } finally {
    await bot.close()
  }
})

test('a disconnected bot is refused as offline', async ({ page }) => {
  test.setTimeout(90_000)
  const bot = await BotConnection.open(standardAnswer)
  await bot.close()
  await expect.poll(presence, { timeout: 15000 }).toBe('offline')

  await signIn(page, alice)
  await openChannel(page, server.id, server.generalChannelId)
  await pickCommand(page, 'pin', 'ping')
  await page.keyboard.press('Enter')
  const notice = notices(page)
  await expect(notice).toHaveAttribute('data-status', 'offline', { timeout: 10000 })
  await expect(notice).toContainText('is offline')
  await expect(page.getByTestId('bot-command-bar')).toHaveCount(0)
})
