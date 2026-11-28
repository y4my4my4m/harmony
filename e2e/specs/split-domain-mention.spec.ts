// Journey: a chat mention typed with the host that serves a split-domain account's actor
// opens that account.
//
// A split-domain account (Mastodon LOCAL_DOMAIN + WEB_DOMAIN, Shoot webapp_url +
// instance_url) is stored under its account domain; its actor id is on the serving host.
//
//   - a message typed with @user@<serving host> stores the account's id under its account
//     domain, shows @<account domain>, and its mention opens the account without a lookup;
//   - a message stored with `unresolved-<user>@<serving host>`, as messages sent before the
//     account was matched hold, opens the account through /lookup-user. The federation
//     backend (e2e/specs/backend.ts) answers it from the stored profile by the host serving
//     its actor; nothing is fetched from the remote.

import crypto from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import {
  adminClient, composer, createUser, deleteUser, messageList, openChannel, seedServer, signIn,
  type SeededServer, type SpecUser,
} from './harness'
import { startBackend, type Backend } from './backend'

test.use({ serviceWorkers: 'block' })

const admin = adminClient()
const marker = Date.now().toString(36)
const accountDomain = `acct${marker}.e2e.example`
const servingHost = `chat.${accountDomain}`
const remote = { id: crypto.randomUUID(), username: `maddy${marker}` }
const actor = `https://${servingHost}/users/${remote.username}`
let owner: SpecUser
let server: SeededServer
let backend: Backend

test.beforeAll(async () => {
  owner = await createUser(admin, 'sdm')
  server = await seedServer(admin, owner, `Split ${marker}`)
  // Synced now, so /lookup-user answers it as stored and starts no remote read.
  const now = new Date().toISOString()
  const { error } = await admin.from('profiles').insert({
    id: remote.id,
    username: remote.username,
    display_name: 'Split Account',
    domain: accountDomain,
    is_local: false,
    federated_id: actor,
    inbox_url: `${actor}/inbox`,
    last_synced_at: now,
    remote_counts_fetched_at: now,
  })
  if (error) throw new Error(`remote profile: ${error.message}`)
  backend = await startBackend()
})

test.afterAll(async () => {
  await backend?.stop()
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  await admin.from('profiles').delete().eq('id', remote.id)
  await deleteUser(admin, owner)
})

const rowOf = (page: Page, text: string) => messageList(page).getByRole('article').filter({ hasText: text })

async function latestMentions(): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await admin
    .from('messages')
    .select('content')
    .eq('channel_id', server.generalChannelId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()
  if (error || !data) throw new Error(`latest message: ${error?.message}`)
  return (data.content as Array<Record<string, unknown>>).filter((p) => p.type === 'mention')
}

test('a mention typed with the host serving a split-domain account opens that account', async ({ page }) => {
  test.setTimeout(180_000)
  const lookups: string[] = []
  page.on('request', (request) => {
    if (!request.url().includes('/api/federation/lookup-user')) return
    lookups.push(String(JSON.parse(request.postData() ?? '{}').handle ?? ''))
  })
  await backend.route(page)
  await signIn(page, owner)
  const handle = page.getByTestId('profile-modal-handle')

  await test.step('a new message stores the account the serving host names', async () => {
    await openChannel(page, server.id, server.generalChannelId)
    await composer(page).click()
    await composer(page).pressSequentially(`fresh @${remote.username}@${servingHost} hello`, { delay: 10 })
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await latestMentions().catch(() => [])).map((m) => m.userId), { timeout: 30000 })
      .toEqual([remote.id])
    const [mention] = await latestMentions()
    expect(mention).toMatchObject({ username: remote.username, domain: accountDomain, isLocal: false })
  })

  await test.step('its mention shows the account domain and opens the account without a lookup', async () => {
    const row = rowOf(page, 'fresh')
    await expect(row).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
    const pill = row.locator('button.mention')
    await expect(pill).toContainText('Split Account', { timeout: 30000 })
    await expect(pill.locator('.mention-domain')).toHaveText(`@${accountDomain}`)
    await pill.click()
    await expect(handle).toHaveText(`@${remote.username}@${accountDomain}`, { timeout: 30000 })
    expect(lookups).toEqual([])
    await page.keyboard.press('Escape')
    await expect(handle).toHaveCount(0, { timeout: 10000 })
  })

  await test.step('a message stored with the handle unresolved opens the account through the lookup', async () => {
    const { error } = await admin.from('messages').insert({
      channel_id: server.generalChannelId,
      user_id: owner.id,
      content: [
        { type: 'text', text: 'earlier ' },
        {
          type: 'mention',
          userId: `unresolved-${remote.username}@${servingHost}`,
          username: remote.username,
          domain: servingHost,
          isLocal: false,
        },
      ],
    })
    expect(error).toBeNull()
    await openChannel(page, server.id, server.generalChannelId)
    await rowOf(page, 'earlier').locator('button.mention').click()
    await expect(handle).toHaveText(`@${remote.username}@${accountDomain}`, { timeout: 30000 })
    expect(lookups).toEqual([`${remote.username}@${servingHost}`])
  })
})
