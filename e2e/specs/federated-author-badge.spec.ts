// Journey: a member from another instance posts in a server hosted here. The author line of
// their message, and the reply preview naming them, carry the federated globe named after their
// instance, as mentions and the member list do; a local member's author line does not.

import { test, expect } from '@playwright/test'
import crypto from 'node:crypto'
import {
  adminClient, createUser, deleteUser, messageList, openChannel, seedServer, signIn,
  type SeededServer, type SpecUser,
} from './harness'

const admin = adminClient()
const DOMAIN = 'remote.e2e.test'
let owner: SpecUser
let server: SeededServer
const remote = { id: crypto.randomUUID(), username: `fab${Date.now().toString(36)}`, displayName: 'Spartzy remote' }
const REMOTE_TEXT = 'Greetings from another instance'
const LOCAL_TEXT = 'Welcome to the town hall'
const ids = { remote: '', local: '' }

test.use({ colorScheme: 'dark' })

test.beforeAll(async () => {
  owner = await createUser(admin, 'fab')
  server = await seedServer(admin, owner, `Fed author ${owner.username}`)
  const fed = await admin.from('servers').update({ federation_enabled: true }).eq('id', server.id)
  if (fed.error) throw new Error(fed.error.message)
  const { error: profileError } = await admin.from('profiles').insert({
    id: remote.id,
    username: remote.username,
    display_name: remote.displayName,
    domain: DOMAIN,
    is_local: false,
    federated_id: `https://${DOMAIN}/users/${remote.username}`,
    inbox_url: `https://${DOMAIN}/users/${remote.username}/inbox`,
  })
  if (profileError) throw new Error(`remote profile: ${profileError.message}`)
  const { error: memberError } = await admin.from('user_servers').insert({
    server_id: server.id, user_id: remote.id, status: 'accepted', member_instance: DOMAIN,
  })
  if (memberError) throw new Error(`remote membership: ${memberError.message}`)

  const { data: first, error: remoteError } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: remote.id,
    content: [{ type: 'text', text: REMOTE_TEXT }],
  }).select('id').single()
  if (remoteError || !first) throw new Error(`remote message: ${remoteError?.message}`)
  ids.remote = first.id
  // A reply to the remote message, mentioning its author: the reply preview names the remote
  // author with the globe, and the mention chip shows its own.
  const { data: second, error: localError } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: owner.id,
    reply_to: first.id,
    content: [
      { type: 'text', text: `${LOCAL_TEXT} ` },
      { type: 'mention', userId: remote.id, username: remote.username, domain: DOMAIN, isLocal: false },
    ],
  }).select('id').single()
  if (localError || !second) throw new Error(`local message: ${localError?.message}`)
  ids.local = second.id
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', server.id)
  await admin.from('profiles').delete().eq('id', remote.id)
  await deleteUser(admin, owner)
})

test('a remote author\'s name carries the globe naming their instance; a local author\'s does not', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await expect(page.locator('html')).toHaveAttribute('data-theme-type', 'dark')

  const row = (id: string) => messageList(page).locator(`.message-item[data-message-id="${id}"]`)
  const remoteRow = row(ids.remote)
  const localRow = row(ids.local)
  await expect(remoteRow).toContainText(REMOTE_TEXT, { timeout: 30000 })
  await expect(localRow).toContainText(LOCAL_TEXT, { timeout: 30000 })

  const remoteAuthor = remoteRow.locator('.message-meta .username')
  await expect(remoteAuthor).toContainText(remote.displayName)
  const globe = remoteAuthor.getByRole('img', { name: `From ${DOMAIN}` })
  await expect(globe).toBeVisible({ timeout: 30000 })
  await expect(globe).toHaveAttribute('title', `From ${DOMAIN}`)
  await expect(remoteAuthor).toHaveAccessibleName(new RegExp(`^${remote.displayName}\\s*From ${DOMAIN.replace(/\./g, '\\.')}$`))

  const replyPreview = localRow.locator('.reply-reference')
  await expect(replyPreview).toContainText(remote.displayName)
  await expect(replyPreview.getByRole('img', { name: `From ${DOMAIN}` })).toBeVisible()

  const localAuthor = localRow.locator('.message-meta .username')
  await expect(localAuthor).toContainText(owner.displayName)
  await expect(localAuthor.getByRole('img', { name: /^From / })).toHaveCount(0)
  await expect(localAuthor.locator('[data-testid="federated-user-badge"]')).toHaveCount(0)

  const shot = testInfo.outputPath('federated-author-badge.png')
  await messageList(page).screenshot({ path: shot })
  await testInfo.attach('federated author badge (dark)', { path: shot, contentType: 'image/png' })
})
