// Journey: instance limits. One test per refusal: each sets its limit low, reaches it through the
// app, and reads the refusal the person sees. Refused writes are not stored, and the refused message
// and post stay in their composers. An account an admin exempts in Users passes. An admin tunes
// each limit in the panel. A bot past its overall ceiling gets 429 from a real gateway with the time
// to wait.
//
// The seed turns these limits off. They are instance-wide, so afterEach puts back what beforeAll read
// and clears the counted writes.

import { randomBytes, randomUUID } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
  composer,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  openChannel,
  seedServer,
  sendMessage,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'
import { startBotGateway, type BotGateway } from './botGateway'

test.describe.configure({ mode: 'serial' })

const admin = adminClient()
const CONFIG_KEYS = ['antispam', 'max_servers_per_user', 'max_bots_per_user', 'drive_instance_limit_mb']
const TOO_QUICKLY = 'too quickly'

let saved: Array<{ config_key: string; config_value: unknown }> = []
let antispam: Record<string, unknown> = {}
const users: SpecUser[] = []
let staff: SpecUser
let server: SeededServer

async function newUser(tag: string): Promise<SpecUser> {
  const user = await createUser(admin, tag)
  users.push(user)
  return user
}

async function limits(patch: Record<string, unknown>): Promise<void> {
  const { error } = await admin.from('instance_config')
    .update({ config_value: { ...antispam, ...patch } }).eq('config_key', 'antispam')
  if (error) throw new Error(`antispam: ${error.message}`)
}

async function setConfig(key: string, value: unknown): Promise<void> {
  const { error } = await admin.from('instance_config')
    .upsert({ config_key: key, config_value: value }, { onConflict: 'config_key' })
  if (error) throw new Error(`${key}: ${error.message}`)
}

async function configValue(key: string): Promise<unknown> {
  const { data } = await admin.from('instance_config').select('config_value').eq('config_key', key).single()
  return data?.config_value
}

const toast = (page: Page, text: string | RegExp) =>
  page.locator('.Vue-Toastification__toast').filter({ hasText: text })

test.beforeAll(async () => {
  const { data, error } = await admin.from('instance_config').select('config_key, config_value').in('config_key', CONFIG_KEYS)
  if (error) throw new Error(`instance_config: ${error.message}`)
  saved = data ?? []
  antispam = saved.find((row) => row.config_key === 'antispam')?.config_value as Record<string, unknown>
  staff = await newUser('ilsta')
  await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  server = await seedServer(admin, staff, `Limits ${staff.username.slice(-6)}`)
})

test.afterEach(async () => {
  await admin.from('instance_config').upsert(saved, { onConflict: 'config_key' })
  await admin.from('automod_recent_activity').delete().in('user_id', users.map((u) => u.id))
})

test.afterAll(async () => {
  await admin.from('limit_exempt_accounts').delete().in('profile_id', users.map((u) => u.id))
  for (const user of users) await deleteUser(admin, user)
})

test('a message past the limit is refused and stays in the composer', async ({ page }) => {
  test.setTimeout(180_000)
  const member = await newUser('ilmsg')
  await addMember(admin, member, server.id)
  await limits({ account_messages_per_minute: 2 })

  await signIn(page, member)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
  await sendMessage(page, 'limit one')
  await sendMessage(page, 'limit two')

  await composer(page).click()
  await composer(page).pressSequentially('limit three', { delay: 10 })
  await page.keyboard.press('Enter')
  await expect(toast(page, TOO_QUICKLY)).toBeVisible({ timeout: 15000 })
  await expect(composer(page)).toContainText('limit three')
  await expect(messageList(page).locator('.message-item').filter({ hasText: 'limit three' })).toHaveCount(0)

  const { count } = await admin.from('messages').select('id', { count: 'exact', head: true })
    .eq('user_id', member.id).eq('channel_id', server.generalChannelId)
  expect(count).toBe(2)
})

test('a post past the limit is refused and stays in the composer', async ({ page }) => {
  test.setTimeout(180_000)
  const author = await newUser('ilpst')
  await limits({ account_posts_per_hour: 1 })

  await signIn(page, author)
  await page.goto('/social/home')
  await dismissAnnouncements(page)
  const dialog = page.getByRole('dialog', { name: 'Create a post' })
  const write = async (text: string) => {
    await page.getByTestId('compose-btn').click()
    await expect(dialog).toBeVisible({ timeout: 15000 })
    await dialog.locator('.rich-text-editor').pressSequentially(text, { delay: 10 })
    await dialog.getByTestId('compose-submit').click()
  }

  await write('first post')
  await expect(dialog).toBeHidden({ timeout: 30000 })
  await write('second post')
  await expect(toast(page, TOO_QUICKLY)).toBeVisible({ timeout: 15000 })
  await expect(dialog.locator('.rich-text-editor')).toContainText('second post')

  const { count } = await admin.from('posts').select('id', { count: 'exact', head: true }).eq('author_id', author.id)
  expect(count).toBe(1)
})

test('a reaction past the limit is refused', async ({ page }) => {
  test.setTimeout(180_000)
  const member = await newUser('ilrea')
  await addMember(admin, member, server.id)
  const rows = await admin.from('messages').insert([
    { channel_id: server.generalChannelId, user_id: staff.id, content: [{ type: 'text', text: 'react to me first' }] },
    { channel_id: server.generalChannelId, user_id: staff.id, content: [{ type: 'text', text: 'react to me second' }] },
  ]).select('id')
  if (rows.error) throw new Error(rows.error.message)
  await limits({ account_reactions_per_minute: 1 })

  await signIn(page, member)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
  const react = async (text: string) => {
    const row = messageList(page).locator('.message-item').filter({ hasText: text }).last()
    await expect(row).toBeVisible({ timeout: 30000 })
    await row.click({ button: 'right' })
    await page.getByRole('menu', { name: 'Message options' }).locator('.quick-reaction-btn:not(.more-btn)').first().click()
  }
  const held = async () => (await admin.from('reactions').select('id', { count: 'exact', head: true }).eq('user_id', member.id)).count

  await react('react to me first')
  await expect.poll(held, { timeout: 15000 }).toBe(1)
  await react('react to me second')
  await expect(toast(page, TOO_QUICKLY)).toBeVisible({ timeout: 15000 })
  expect(await held()).toBe(1)
})

test('a follow past the limit is refused', async ({ page }) => {
  test.setTimeout(180_000)
  const follower = await newUser('ilfol')
  const first = await newUser('ilfoa')
  const second = await newUser('ilfob')
  await limits({ account_follows_per_hour: 1 })

  await signIn(page, follower)
  const follow = async (user: SpecUser) => {
    await page.goto(`/social/profile/${user.username}`)
    await dismissAnnouncements(page)
    await page.locator('[data-testid="profile-follow-btn"]').click()
  }
  const following = async () => (await admin.from('follows').select('id', { count: 'exact', head: true }).eq('follower_id', follower.id)).count

  await follow(first)
  await expect.poll(following, { timeout: 15000 }).toBe(1)
  await follow(second)
  await expect(toast(page, TOO_QUICKLY)).toBeVisible({ timeout: 15000 })
  expect(await following()).toBe(1)
})

test('a server join past the limit is refused', async ({ page }) => {
  test.setTimeout(180_000)
  const joiner = await newUser('iljoi')
  const other = await seedServer(admin, staff, `Limits B ${staff.username.slice(-6)}`)
  const suffix = randomBytes(4).toString('hex').toUpperCase()
  const codes = [`LA${suffix}`, `LB${suffix}`]
  const invites = await admin.from('invites').insert([
    { code: codes[0], server_id: server.id, created_by: staff.id, max_uses: 0 },
    { code: codes[1], server_id: other.id, created_by: staff.id, max_uses: 0 },
  ])
  if (invites.error) throw new Error(invites.error.message)
  await limits({ account_joins_per_hour: 1 })

  await signIn(page, joiner)
  const accept = async (code: string) => {
    await page.goto(`/invite/${code}`)
    await page.locator('.invite-btn.primary').click()
  }
  await accept(codes[0])
  await page.waitForURL(new RegExp(`/chat/${server.id}/`), { timeout: 60000 })
  await accept(codes[1])
  await expect(page.getByText(TOO_QUICKLY).first()).toBeVisible({ timeout: 15000 })

  const { count } = await admin.from('user_servers').select('id', { count: 'exact', head: true })
    .eq('user_id', joiner.id).eq('server_id', other.id)
  expect(count).toBe(0)
})

test('a server past the cap or the hourly rate is refused', async ({ page }) => {
  test.setTimeout(240_000)
  const founder = await newUser('ilsrv')
  await seedServer(admin, founder, `Owned ${founder.username.slice(-6)}`)
  await signIn(page, founder)

  const create = async (name: string) => {
    await page.goto('/chat')
    await dismissAnnouncements(page)
    await page.getByRole('button', { name: 'Harmony Portal' }).click()
    await page.getByRole('dialog', { name: 'Discover communities' }).locator('.create-server-btn').click()
    await page.locator('[data-testid="create-server-name-input"]').fill(name)
    await page.locator('[data-testid="create-server-btn"]').click()
  }
  const owned = async () => (await admin.from('servers').select('id', { count: 'exact', head: true }).eq('owner', founder.id)).count

  await test.step('at the cap', async () => {
    await setConfig('max_servers_per_user', 1)
    await create('Over the cap')
    await expect(page.getByText('at most 1 servers')).toBeVisible({ timeout: 15000 })
    expect(await owned()).toBe(1)
  })

  await test.step('at the hourly rate, under no cap', async () => {
    await setConfig('max_servers_per_user', 0)
    await limits({ account_servers_per_hour: 1 })
    await create('Within the hour')
    await expect.poll(owned, { timeout: 30000 }).toBe(2)
    await create('Past the hour')
    await expect(page.getByText(TOO_QUICKLY)).toBeVisible({ timeout: 15000 })
    expect(await owned()).toBe(2)
  })
})

test('a bot past the cap is refused, and no client inserts a bot directly', async ({ page }) => {
  test.setTimeout(180_000)
  const owner = await newUser('ilbot')
  const client = await userClient(owner)
  await setConfig('max_bots_per_user', 1)

  const made = await client.rpc('create_bot', { p_username: `il${owner.username.slice(-10)}a` })
  expect(made.error).toBeNull()

  await test.step('straight to the table', async () => {
    const direct = await client.from('bots')
      .insert({ username: `il${owner.username.slice(-10)}b`, display_name: 'Direct', bot_type: 'bot', owner_id: owner.id })
    expect(direct.error?.code).toBe('42501')
  })

  await test.step('through My bots', async () => {
    await signIn(page, owner)
    await page.goto('/settings/bots')
    await dismissAnnouncements(page)
    await page.getByRole('button', { name: 'New bot' }).click()
    await page.locator('#bot-create-username').fill(`il${owner.username.slice(-10)}c`)
    await page.getByRole('button', { name: 'Create bot' }).click()
    await expect(toast(page, 'at most 1 bots')).toBeVisible({ timeout: 15000 })
  })

  const { count } = await admin.from('bots').select('id', { count: 'exact', head: true }).eq('owner_id', owner.id)
  expect(count).toBe(1)
})

async function startDm(page: Page, user: SpecUser): Promise<void> {
  await page.goto('/dm')
  await dismissAnnouncements(page)
  await expect(page.locator('[data-testid="dm-sidebar"]')).toBeVisible({ timeout: 30000 })
  await page.locator('[data-testid="dm-new-conversation"]').click()
  await page.locator('.user-search-section .search-input').fill(user.username)
  await page.locator('.search-result-item').filter({ hasText: user.username }).first().click()
}

test('a person chooses who can start a conversation with them', async ({ browser }) => {
  test.setTimeout(240_000)
  const target = await newUser('ildmt')
  const stranger = await newUser('ildms')

  const targetContext = await browser.newContext()
  const targetPage = await targetContext.newPage()
  await test.step('the setting saves and holds', async () => {
    await signIn(targetPage, target)
    await targetPage.goto('/settings/privacy')
    await dismissAnnouncements(targetPage)
    const select = targetPage.getByTestId('dm-policy-select')
    await expect(select).toBeEnabled({ timeout: 30000 })
    await expect(select).toHaveValue('everyone')
    await select.selectOption('following')
    await expect(toast(targetPage, 'Privacy settings')).toBeVisible({ timeout: 15000 })
    await targetPage.reload()
    await expect(targetPage.getByTestId('dm-policy-select')).toHaveValue('following', { timeout: 30000 })
  })
  await targetContext.close()

  const context = await browser.newContext()
  const page = await context.newPage()
  await signIn(page, stranger)
  const conversations = async () => (await admin.from('conversations').select('id', { count: 'exact', head: true }).eq('created_by', stranger.id)).count

  await test.step('a stranger is refused', async () => {
    await startDm(page, target)
    await expect(toast(page, 'only accepts new conversations')).toBeVisible({ timeout: 15000 })
    expect(await conversations()).toBe(0)
  })

  await test.step('someone they follow is admitted', async () => {
    const follow = await admin.from('follows').insert({ follower_id: target.id, following_id: stranger.id, status: 'accepted' })
    if (follow.error) throw new Error(follow.error.message)
    await startDm(page, target)
    await page.waitForURL(/\/dm\/[0-9a-f-]{36}/, { timeout: 30000 })
    expect(await conversations()).toBe(1)
  })

  await test.step('tightening later leaves that conversation open', async () => {
    await admin.from('follows').delete().eq('follower_id', target.id).eq('following_id', stranger.id)
    await startDm(page, target)
    await page.waitForURL(/\/dm\/[0-9a-f-]{36}/, { timeout: 30000 })
    expect(await conversations()).toBe(1)
  })
  await context.close()
})

test('new conversations with strangers past the limit are refused', async ({ page }) => {
  test.setTimeout(180_000)
  const sender = await newUser('ildmr')
  const first = await newUser('ildma')
  const second = await newUser('ildmb')
  await limits({ new_account_stranger_dms_per_hour: 1 })

  await signIn(page, sender)
  await startDm(page, first)
  await page.waitForURL(/\/dm\/[0-9a-f-]{36}/, { timeout: 30000 })
  await startDm(page, second)
  await expect(toast(page, TOO_QUICKLY)).toBeVisible({ timeout: 15000 })

  const { count } = await admin.from('conversations').select('id', { count: 'exact', head: true }).eq('created_by', sender.id)
  expect(count).toBe(1)
})

test('a new account counts people it shares only a server with; an older account does not', async ({ page }) => {
  test.setTimeout(180_000)
  const sender = await newUser('ilsvs')
  const first = await newUser('ilsva')
  const second = await newUser('ilsvb')
  for (const user of [sender, first, second]) await addMember(admin, user, server.id)
  await limits({ new_account_stranger_dms_per_hour: 1 })
  const started = async () => (await admin.from('conversations')
    .select('id', { count: 'exact', head: true }).eq('created_by', sender.id)).count

  await signIn(page, sender)
  await startDm(page, first)
  await page.waitForURL(/\/dm\/[0-9a-f-]{36}/, { timeout: 30000 })
  await startDm(page, second)
  await expect(toast(page, TOO_QUICKLY)).toBeVisible({ timeout: 15000 })
  expect(await started()).toBe(1)

  await admin.from('profiles')
    .update({ created_at: new Date(Date.now() - 30 * 86_400_000).toISOString() }).eq('id', sender.id)
  await startDm(page, second)
  await page.waitForURL(/\/dm\/[0-9a-f-]{36}/, { timeout: 30000 })
  expect(await started()).toBe(2)
})

test('uploads stop past the instance total, except for staff', async ({ page }) => {
  test.setTimeout(180_000)
  const member = await newUser('ildrv')
  await addMember(admin, member, server.id)
  const stored = await admin.from('drive_files').insert({
    owner_id: staff.id, bucket: 'message_media', path: `il/${staff.id}/${randomBytes(4).toString('hex')}.bin`,
    name: 'filler.bin', size_bytes: 2 * 1024 * 1024, state: 'drive',
  }).select('id').single()
  if (stored.error) throw new Error(stored.error.message)

  const bytes = randomBytes(1024)
  const upload = async (user: SpecUser, name: string) => {
    const client = await userClient(user)
    const path = `c/${server.generalChannelId}/${user.id}/${randomUUID()}-${name}`
    const { error } = await client.storage.from('message_media').upload(path, bytes, { contentType: 'application/octet-stream' })
    if (!error) await admin.storage.from('message_media').remove([path])
    return error
  }

  try {
    expect(await upload(member, 'under.bin')).toBeNull()
    await setConfig('drive_instance_limit_mb', 1)
    expect((await upload(member, 'over.bin'))?.message).toMatch(/row-level security/)
    expect(await upload(staff, 'staff.bin')).toBeNull()

    await signIn(page, member)
    await openChannel(page, server.id, server.generalChannelId)
    await dismissAnnouncements(page)
    await page.getByTestId('composer-file-input').setInputFiles({ name: 'over.bin', mimeType: 'application/octet-stream', buffer: bytes })
    await composer(page).click()
    await page.keyboard.press('Enter')
    await expect(page.getByText('Storage is full').first()).toBeVisible({ timeout: 30000 })
  } finally {
    await admin.from('drive_files').delete().eq('id', stored.data.id)
  }
})

test('a bot past its overall ceiling gets 429 from the gateway with the time to wait', async () => {
  test.setTimeout(180_000)
  const owner = await newUser('ilgwo')
  const client = await userClient(owner)
  const made = await client.rpc('create_bot', { p_username: `il${owner.username.slice(-10)}g` })
  expect(made.error).toBeNull()
  const second = await client.rpc('create_bot', { p_username: `il${owner.username.slice(-10)}h` })
  expect(second.error).toBeNull()
  await limits({ bot_requests_per_minute: 3 })

  let gateway: BotGateway | undefined
  try {
    // Overall never reads below the route limit per minute.
    gateway = await startBotGateway({ RATE_LIMIT_MAX_REQUESTS: '2' })
    const call = (token: string, path: string) =>
      fetch(`${gateway!.url}/api/v1${path}`, { headers: { Authorization: `Bot ${token}` } })
    const token = made.data.token as string
    const botId = made.data.bot.id as string

    expect((await call(token, '/users/@me')).status).toBe(200)
    expect((await call(token, `/users/${botId}`)).status).not.toBe(429)
    expect((await call(token, '/no-such-route')).status).toBe(404)

    const refused = await call(token, '/no-other-route')
    expect(refused.status).toBe(429)
    const body = await refused.json() as { retry_after: number }
    expect(body.retry_after).toBeGreaterThan(0)
    expect(body.retry_after).toBeLessThanOrEqual(60)
    expect(refused.headers.get('retry-after')).toBe(String(body.retry_after))

    expect((await call(second.data.token as string, '/users/@me')).status).toBe(200)
  } finally {
    await gateway?.stop()
  }
})

test('an admin exempts an account in Users, and it passes', async ({ browser }) => {
  test.setTimeout(240_000)
  const member = await newUser('ilexm')
  await addMember(admin, member, server.id)
  await limits({ account_messages_per_minute: 1 })

  const memberContext = await browser.newContext()
  const memberPage = await memberContext.newPage()
  await signIn(memberPage, member)
  await openChannel(memberPage, server.id, server.generalChannelId)
  await dismissAnnouncements(memberPage)
  await sendMessage(memberPage, 'exempt one')
  await composer(memberPage).click()
  await composer(memberPage).pressSequentially('exempt two', { delay: 10 })
  await memberPage.keyboard.press('Enter')
  await expect(toast(memberPage, TOO_QUICKLY)).toBeVisible({ timeout: 15000 })

  const staffContext = await browser.newContext()
  const staffPage = await staffContext.newPage()
  await signIn(staffPage, staff)
  await staffPage.goto('/admin?tab=users')
  await dismissAnnouncements(staffPage)
  await staffPage.getByPlaceholder('Search users…').fill(member.username)
  const row = staffPage.locator('.user-item').filter({ hasText: member.displayName })
  await expect(row).toHaveCount(1, { timeout: 15000 })
  const exempt = row.getByTestId('user-limit-exempt')
  await expect(exempt).toHaveAttribute('aria-pressed', 'false')
  await exempt.click()
  await expect(exempt).toHaveAttribute('aria-pressed', 'true')
  await expect(exempt).toHaveClass(/limit-exempt-on/)
  await expect.poll(async () => (await admin.from('limit_exempt_accounts').select('profile_id').eq('profile_id', member.id)).data?.length,
    { timeout: 15000 }).toBe(1)

  await memberPage.keyboard.press('Enter')
  await expect(messageList(memberPage).locator('.message-item').filter({ hasText: 'exempt two' })).toBeVisible({ timeout: 30000 })

  await exempt.click()
  await expect(exempt).toHaveAttribute('aria-pressed', 'false')
  await staffContext.close()
  await memberContext.close()
})

test('an admin tunes the limits in the panel', async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page, staff)

  await test.step('Anti-spam', async () => {
    await page.goto('/admin?tab=antispam')
    await dismissAnnouncements(page)
    const field = page.getByTestId('antispam-account_messages_per_minute')
    await expect(field).toBeVisible({ timeout: 30000 })
    await field.fill('77')
    await page.getByTestId('antispam-bridge_requests_per_minute').fill('4000')
    await page.locator('.antispam-admin .primary-btn-sm').first().click()
    await expect.poll(async () => (await configValue('antispam') as Record<string, unknown>).account_messages_per_minute, { timeout: 15000 }).toBe(77)
    expect((await configValue('antispam') as Record<string, unknown>).bridge_requests_per_minute).toBe(4000)
  })

  await test.step('Config > General', async () => {
    await page.goto('/admin?tab=config')
    const servers = page.getByTestId('config-max-servers-per-user')
    // Enabled once the stored values are read.
    await expect(servers).toBeEnabled({ timeout: 30000 })
    await servers.fill('50')
    await page.getByTestId('config-max-bots-per-user').fill('5')
    await page.getByRole('button', { name: 'Save changes' }).first().click()
    await expect.poll(() => configValue('max_servers_per_user'), { timeout: 15000 }).toBe(50)
    expect(await configValue('max_bots_per_user')).toBe(5)
  })

  await test.step('Drive', async () => {
    await page.goto('/admin?tab=drive')
    const panel = page.getByTestId('drive-admin')
    const total = panel.getByTestId('drive-admin-instance-limit')
    await expect(total).toBeVisible({ timeout: 30000 })
    await total.fill('2048')
    await panel.getByTestId('drive-admin-save').click()
    await expect(panel.getByRole('status')).toHaveText('Saved')
    expect(await configValue('drive_instance_limit_mb')).toBe(2048)
  })
})
