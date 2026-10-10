// Journey: the server owner picks @here from the composer's suggestions and sends it. The member
// who is online is notified and sees the message highlighted; the member who is offline is not
// notified.
//
// The stack runs no realtime and no presence sweep. The online member's presence is a heartbeat
// sent through presence_heartbeat with their own session, as the client sends it; the offline
// member never sends one.

import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import {
  adminClient,
  addMember,
  createUser,
  deleteUser,
  dismissAnnouncements,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let author: SpecUser
let online: SpecUser
let offline: SpecUser
let server: SeededServer

function env(...names: string[]): string {
  for (const name of names) if (process.env[name]) return process.env[name]!
  throw new Error(`none of ${names.join(', ')} is set - run: npm run e2e:up`)
}

async function heartbeat(user: SpecUser): Promise<void> {
  const client = createClient(
    env('E2E_SUPABASE_URL', 'TEST_SUPABASE_URL'),
    env('E2E_SUPABASE_ANON_KEY', 'TEST_SUPABASE_ANON_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
  const { error: signInError } = await client.auth.signInWithPassword({ email: user.email, password: user.password })
  if (signInError) throw new Error(`${user.username} sign-in: ${signInError.message}`)
  const { error } = await client.rpc('presence_heartbeat', { p_device_id: 'e2e-here', p_status: 1, p_is_mobile: false })
  if (error) throw new Error(`${user.username} heartbeat: ${error.message}`)
}

/** Mention notifications of a member for a message, with their is_here flag. */
async function mentionsOf(user: SpecUser, messageId: string): Promise<boolean[]> {
  const { data, error } = await admin
    .from('notifications')
    .select('data')
    .eq('user_id', user.id)
    .eq('type', 'mention')
    .eq('data->>message_id', messageId)
  if (error) throw new Error(`notifications: ${error.message}`)
  return (data ?? []).map((n: { data: { is_here?: boolean } }) => n.data?.is_here === true)
}

test.beforeAll(async () => {
  author = await createUser(admin, 'herea')
  online = await createUser(admin, 'hereb')
  offline = await createUser(admin, 'herec')
  server = await seedServer(admin, author, `Here ${author.username}`)
  await addMember(admin, online, server.id)
  await addMember(admin, offline, server.id)
})

test.afterAll(async () => {
  await deleteUser(admin, author)
  await deleteUser(admin, online)
  await deleteUser(admin, offline)
})

test('@here notifies the online member and highlights the message for them', async ({ browser }) => {
  test.setTimeout(180_000)

  const channelUrl = `/chat/${server.id}/${server.generalChannelId}`
  const authorContext = await browser.newContext()
  const page = await authorContext.newPage()
  let messageId = ''

  await test.step('the owner opens #general', async () => {
    await signIn(page, author)
    await page.goto(channelUrl)
    await dismissAnnouncements(page)
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 30000 })
  })

  await test.step('@here is offered beside @everyone and sent as a pill', async () => {
    await heartbeat(online)

    const input = page.locator('[data-testid="message-input"] .rich-text-editor')
    await input.click()
    await input.pressSequentially('@he', { delay: 30 })
    const option = page.getByRole('option').filter({ hasText: '@here' })
    await expect(option).toBeVisible({ timeout: 15000 })
    await option.click()
    await expect(input.locator('.editor-role-mention')).toHaveText('@here')
    // The editor puts the caret after the pill two frames after it renders. Typing goes through
    // the keyboard: locator input focuses the editor, which moves the caret to its start.
    await expect.poll(() => input.evaluate((el) => {
      const selection = window.getSelection()
      if (!selection?.anchorNode || !el.contains(selection.anchorNode)) return false
      const before = document.createRange()
      before.setStart(el, 0)
      before.setEnd(selection.anchorNode, selection.anchorOffset)
      return before.cloneContents().querySelector('.editor-role-mention') !== null
    })).toBe(true)
    await page.keyboard.type('standup', { delay: 10 })
    await page.keyboard.press('Enter')

    const posted = page.locator('[data-testid="message-list"] .message-item').filter({ hasText: 'standup' })
    await expect(posted).toBeVisible({ timeout: 30000 })
    await expect(posted).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
    await expect(posted.locator('.role-mention')).toHaveText('@here')
    messageId = (await posted.getAttribute('data-message-id')) ?? ''
  })

  await test.step('the online member is notified once; the offline member is not', async () => {
    const { data: row } = await admin.from('messages').select('content').eq('id', messageId).single()
    expect(row?.content).toContainEqual({ type: 'role_mention', roleId: 'here', roleName: 'here', roleColor: null })
    await expect.poll(() => mentionsOf(online, messageId), { timeout: 15000 }).toEqual([true])
    expect(await mentionsOf(offline, messageId)).toEqual([])
    expect(await mentionsOf(author, messageId)).toEqual([])
  })

  await test.step('the online member sees the message highlighted', async () => {
    const readerContext = await browser.newContext()
    const readerPage = await readerContext.newPage()
    await signIn(readerPage, online)
    await readerPage.goto(channelUrl)
    await dismissAnnouncements(readerPage)
    const message = readerPage.locator(`[data-testid="message-list"] .message-item[data-message-id="${messageId}"]`)
    await expect(message).toBeVisible({ timeout: 30000 })
    await expect(message).toHaveClass(/mentions-me/)
    await expect(message.locator('.role-mention')).toHaveText('@here')
    await readerContext.close()
  })

  await authorContext.close()
})
