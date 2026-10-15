// Journey: the PWA share target. The manifest's share_target sends GET /share with title,
// text and url; the page asks where the share goes, lists DMs and the text channels the
// user can post in, and opens that composer with the shared text as its draft. A signed-out
// visitor signs in first and lands back on the share page with the same parameters.
//
// Each case sends the composer and reads the stored message back.

import { test, expect, type Page } from '@playwright/test'
import {
  addChannel,
  addMember,
  adminClient,
  composer,
  createUser,
  deleteUser,
  dismissAnnouncements,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let member: SpecUser
let friend: SpecUser
let server: SeededServer
let readOnlyChannel = ''
let conversation = ''

const SEND_MESSAGES = 2 ** 12

test.beforeAll(async () => {
  owner = await createUser(admin, 'shro')
  member = await createUser(admin, 'shrm')
  friend = await createUser(admin, 'shrf')
  server = await seedServer(admin, owner, `Share ${owner.username}`)
  await addMember(admin, member, server.id)

  readOnlyChannel = await addChannel(admin, server, 'read-only')
  const { data: everyone, error: roleError } = await admin
    .from('server_roles').select('id').eq('server_id', server.id).eq('is_default', true).single()
  if (roleError || !everyone) throw new Error(`@everyone: ${roleError?.message}`)
  const { error: overrideError } = await admin.from('channel_permission_overrides').insert({
    channel_id: readOnlyChannel,
    target_type: 'role',
    role_id: everyone.id,
    allow_permissions: 0,
    deny_permissions: SEND_MESSAGES,
  })
  if (overrideError) throw new Error(`override: ${overrideError.message}`)

  const { data, error } = await admin.from('conversations').insert({ type: 'direct', created_by: member.id }).select('id').single()
  if (error || !data) throw new Error(`conversation: ${error?.message}`)
  conversation = data.id
  await admin.from('conversation_participants').insert([
    { conversation_id: conversation, user_id: member.id },
    { conversation_id: conversation, user_id: friend.id },
  ])
  await admin.from('messages').insert({ conversation_id: conversation, user_id: friend.id, content: [{ type: 'text', text: 'hello there' }] })
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
  await deleteUser(admin, member)
  await deleteUser(admin, friend)
})

function shareUrl(params: Record<string, string>): string {
  return `/share?${new URLSearchParams(params).toString()}`
}

async function lastText(column: 'channel_id' | 'conversation_id', id: string): Promise<string | null> {
  const { data } = await admin.from('messages').select('content').eq(column, id).eq('user_id', member.id)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (!data) return null
  return (data.content as Array<{ type: string; text?: string; url?: string }>).map((p) => p.type === 'text' ? p.text : p.type === 'url' ? p.url : `[${p.type}]`).join('')
}

/** Sends the composer as it stands; the draft must survive the route change intact. */
async function sendComposer(page: Page) {
  await composer(page).click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await expect(composer(page)).toHaveText('', { timeout: 15000 })
}

test('a shared link goes to a channel the user can post in', async ({ page }) => {
  test.setTimeout(150_000)
  const shared = 'Harmony site\nhave a look\nhttps://example.com/harmony'

  await test.step('open the share page', async () => {
    await signIn(page, member)
    await page.goto(shareUrl({ title: 'Harmony site', text: 'have a look', url: 'https://example.com/harmony' }))
    await dismissAnnouncements(page)
    await expect(page.getByRole('heading', { name: 'Share to Harmony' })).toBeVisible({ timeout: 30000 })
    await expect(page.getByTestId('share-preview')).toHaveText(shared)
  })

  await test.step('the server lists channels the user can post in, not read-only ones', async () => {
    const serverRow = page.locator(`[data-testid="share-server"][data-server-id="${server.id}"]`)
    await expect(serverRow).toHaveAttribute('aria-expanded', 'false')
    await serverRow.click()
    await expect(serverRow).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator(`[data-testid="share-channel"][data-channel-id="${server.generalChannelId}"]`)).toBeVisible({ timeout: 30000 })
    await expect(page.locator(`[data-testid="share-channel"][data-channel-id="${readOnlyChannel}"]`)).toHaveCount(0)
  })

  await test.step('choosing the channel opens its composer with the shared text', async () => {
    await page.locator(`[data-testid="share-channel"][data-channel-id="${server.generalChannelId}"]`).click()
    await expect(page).toHaveURL(new RegExp(`/chat/${server.id}/${server.generalChannelId}$`), { timeout: 30000 })
    await expect(composer(page)).toContainText('have a look', { timeout: 30000 })
    await expect(composer(page)).toContainText('https://example.com/harmony')
    await sendComposer(page)
    await expect.poll(() => lastText('channel_id', server.generalChannelId), { timeout: 15000 }).toBe(shared)
  })
})

test('a signed-out share signs in first, then goes to a DM', async ({ page }) => {
  test.setTimeout(150_000)
  const url = shareUrl({ text: 'https://example.com/from-android' })

  await test.step('sign in from the share link', async () => {
    await page.goto(url)
    await expect(page).toHaveURL(/\/login/, { timeout: 30000 })
    await page.locator('[data-testid="auth-email"]').fill(member.email)
    await page.locator('[data-testid="auth-password"]').fill(member.password)
    await page.locator('[data-testid="auth-submit"]').click()
    await expect(page).toHaveURL(/\/share\?text=https%3A%2F%2Fexample\.com%2Ffrom-android$/, { timeout: 30000 })
    await dismissAnnouncements(page)
    await expect(page.getByTestId('share-preview')).toHaveText('https://example.com/from-android')
  })

  await test.step('search narrows the list; the DM opens with the link in its composer', async () => {
    await page.getByTestId('share-search').fill(friend.username)
    const dm = page.locator(`[data-testid="share-dm"][data-conversation-id="${conversation}"]`)
    await expect(dm).toBeVisible({ timeout: 30000 })
    await expect(page.locator(`[data-testid="share-server"][data-server-id="${server.id}"]`)).toHaveCount(0)
    await dm.click()
    await expect(page).toHaveURL(new RegExp(`/dm/${conversation}$`), { timeout: 30000 })
    await expect(composer(page)).toContainText('https://example.com/from-android', { timeout: 30000 })
    await sendComposer(page)
    await expect.poll(() => lastText('conversation_id', conversation), { timeout: 15000 }).toBe('https://example.com/from-android')
  })
})
