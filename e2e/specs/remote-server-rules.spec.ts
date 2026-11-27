// Journey: joining a server hosted on another instance after reading its rules, and being held to
// them here. The other instance is e2e/specs/directoryPeer.ts; its Group carries harmony:welcome
// (a welcome message, one rule, acceptance required) and harmony:instanceRules. This instance's
// federation backend (e2e/specs/backend.ts) discovers the Group, sends the Join and stores the
// screen on the copy (federation-backend activitypub/groupWelcome.ts).
//
// - Join remote server, given the Group's URL, lists the host instance's rules, then the server's,
//   and says joining means agreeing to them.
// - Joining opens the copy with the host's welcome screen asking to accept its rules; until then
//   the message box asks the same.
// - Accepting closes the screen, the message box returns, and a message is sent.

import { test, expect } from '@playwright/test'
import crypto from 'node:crypto'
import {
  adminClient, composer, createUser, deleteUser, messageList, openChannel, seedServer, sendMessage, signIn,
  type SeededServer, type SpecUser,
} from './harness'
import { startBackend, type Backend } from './backend'
import { startDirectoryPeer, type DirectoryPeer } from './directoryPeer'

test.use({ serviceWorkers: 'block' })

const admin = adminClient()
let user: SpecUser
let home: SeededServer
let backend: Backend
let peer: DirectoryPeer
const hall = {
  id: crypto.randomUUID(),
  name: 'Rule Hall',
  summary: 'A server with rules',
  memberCount: 3,
  extra: {
    'harmony:welcome': {
      rules: [{ title: 'Be kind', description: 'To everyone, every time.' }],
      enabled: true,
      message: 'Welcome aboard',
      enabledAt: '2026-01-01T00:00:00Z',
      requireAcceptance: true,
      acceptanceRequiredAt: '2026-01-01T00:00:00Z',
    },
    'harmony:instanceRules': ['Follow the law'],
  },
}

test.beforeAll(async () => {
  test.setTimeout(120_000)
  user = await createUser(admin, 'rsr')
  home = await seedServer(admin, user, `Home ${user.username}`)
  peer = await startDirectoryPeer([hall])
  backend = await startBackend({ NODE_TLS_REJECT_UNAUTHORIZED: '0' })
})

test.afterAll(async () => {
  await backend?.stop()
  const { data: copy } = await admin.from('servers').select('id').eq('ap_id', peer?.groupUrl(hall.id) ?? '').maybeSingle()
  if (copy) await admin.from('servers').delete().eq('id', copy.id)
  await peer?.stop()
  await admin.from('servers').delete().eq('id', home?.id ?? '')
  await deleteUser(admin, user)
})

test('a server hosted elsewhere shows its rules before joining and holds its members to them', async ({ page }) => {
  test.setTimeout(180_000)
  await backend.route(page)
  await signIn(page, user)
  await openChannel(page, home.id, home.generalChannelId)

  const join = page.getByRole('dialog', { name: 'Join remote server' })
  await test.step('Join remote server lists the host instance\'s rules, then the server\'s', async () => {
    await page.getByRole('button', { name: 'Harmony Portal' }).click()
    await page.getByRole('button', { name: 'Join by URL' }).click()
    await expect(join).toBeVisible()
    await join.locator('#server-url').fill(peer.groupUrl(hall.id))
    await join.locator('#server-url').press('Enter')
    await expect(join.locator('.server-name')).toHaveText(hall.name, { timeout: 30000 })
    const rules = join.getByTestId('join-federated-rules')
    await expect(rules.locator('li')).toHaveText(['Follow the law', 'Be kind'])
    await expect(rules).toContainText('By joining, you agree to these rules.')
  })

  const welcome = page.getByRole('dialog').filter({ hasText: 'Welcome aboard' })
  await test.step('joining opens the copy with the host\'s welcome screen, asking to accept the rules', async () => {
    await join.getByTestId('join-federated-submit').click()
    await expect(page).toHaveURL(new RegExp(`/chat/${hall.id}/`), { timeout: 30000 })
    await expect(welcome).toBeVisible({ timeout: 30000 })
    await expect(welcome).toContainText('Be kind')
    await expect(welcome).toContainText('To everyone, every time.')
    await expect(welcome.getByTestId('welcome-screen-action')).toHaveText('Accept rules')
    await expect(page.getByTestId('rules-accept-prompt')).toBeVisible()
  })

  await test.step('accepting closes the screen and the message is sent', async () => {
    await welcome.getByTestId('welcome-screen-action').click()
    await expect(welcome).toBeHidden({ timeout: 15000 })
    await expect(page.getByTestId('rules-accept-prompt')).toHaveCount(0)
    await expect(composer(page)).toBeVisible()
    await sendMessage(page, 'hello rule hall')
    await expect(messageList(page).getByText('hello rule hall')).toBeVisible({ timeout: 15000 })

    const { data: member } = await admin.from('user_servers').select('rules_accepted_at')
      .eq('server_id', hall.id).eq('user_id', user.id).single()
    expect(member?.rules_accepted_at).toBeTruthy()
    const { data: screen } = await admin.from('server_welcome_screens').select('require_acceptance, updated_by')
      .eq('server_id', hall.id).single()
    expect(screen).toEqual({ require_acceptance: true, updated_by: null })
  })
})
