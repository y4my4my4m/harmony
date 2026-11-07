// Journey: editing a message keeps its channel mentions. The editor shows "#zeta" where the
// message links #zeta, and the saved edit still holds the channel_mention part; a link to a
// message in a channel keeps its messageId. A mention of a member of another instance keeps
// its domain, so the edit does not re-point it at a local account of the same name.
//
// The edit text came from messagePartsToMarkdown, which had no channel_mention case and wrote
// a remote mention as a bare @username.

import crypto from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  addChannel,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer
let zetaId: string
const REMOTE = { username: 'bob', domain: 'remote.e2e.test' }

test.beforeAll(async () => {
  owner = await createUser(admin, 'chme')
  server = await seedServer(admin, owner, `Mentions ${owner.username.slice(-6)}`)
  zetaId = await addChannel(admin, server, 'zeta')
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  await deleteUser(admin, owner)
})

const rowOf = (page: Page, text: string) => messageList(page).getByRole('article').filter({ hasText: text })

async function seed(content: Array<Record<string, unknown>>): Promise<string> {
  const { data, error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId, user_id: owner.id, content,
  }).select('id').single()
  if (error || !data) throw new Error(`seed: ${error?.message}`)
  return data.id as string
}

async function stored(id: string): Promise<Array<Record<string, unknown>>> {
  const { data } = await admin.from('messages').select('content').eq('id', id).single()
  return (data?.content ?? []) as Array<Record<string, unknown>>
}

/** Opens the editor of the row holding `marker`; returns its text. */
async function openEditor(page: Page, marker: string) {
  const row = rowOf(page, marker)
  await row.focus()
  await page.keyboard.press('Enter')
  const menu = page.getByRole('menu', { name: 'Message options' })
  await menu.getByRole('menuitem', { name: 'Edit message' }).focus()
  await page.keyboard.press('Enter')
  const editor = row.getByRole('textbox', { name: 'Edit message' })
  await expect(editor).toBeFocused()
  return editor
}

async function appendAndSave(page: Page, suffix: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(suffix)
  await page.keyboard.press('Enter')
}

test('a channel mention survives an edit', async ({ page }) => {
  test.setTimeout(120_000)
  const marker = `see ${crypto.randomUUID().slice(0, 6)}`
  const id = await seed([
    { type: 'text', text: `${marker} ` },
    { type: 'channel_mention', channelId: zetaId, serverId: server.id, name: 'zeta' },
    { type: 'text', text: ' now' },
  ])
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await expect(rowOf(page, marker).locator('.channel-mention')).toHaveText('#zeta', { timeout: 15000 })

  const editor = await openEditor(page, marker)
  await expect(editor).toContainText(`${marker} #zeta now`)
  await appendAndSave(page, ' later')

  await expect.poll(async () => (await stored(id)).filter((p) => p.type === 'channel_mention').map((p) => p.channelId), { timeout: 15000 })
    .toEqual([zetaId])
  await expect.poll(async () => JSON.stringify(await stored(id))).toContain('later')
  await expect(rowOf(page, marker).locator('.channel-mention')).toHaveText('#zeta')
})

test('a link to a message keeps its messageId through an edit', async ({ page }) => {
  test.setTimeout(120_000)
  const target = await seed([{ type: 'text', text: `target ${crypto.randomUUID().slice(0, 6)}` }])
  const marker = `look ${crypto.randomUUID().slice(0, 6)}`
  const id = await seed([
    { type: 'text', text: `${marker} ` },
    { type: 'channel_mention', channelId: server.generalChannelId, serverId: server.id, name: 'general', messageId: target },
  ])
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await expect(rowOf(page, marker)).toBeVisible({ timeout: 15000 })

  await openEditor(page, marker)
  await appendAndSave(page, ' please')

  await expect.poll(async () => JSON.stringify(await stored(id)), { timeout: 15000 }).toContain('please')
  const mention = (await stored(id)).find((p) => p.type === 'channel_mention')
  expect(mention).toMatchObject({ channelId: server.generalChannelId, messageId: target })
})

test('a remote mention keeps its domain through an edit', async ({ page }) => {
  test.setTimeout(120_000)
  const marker = `ping ${crypto.randomUUID().slice(0, 6)}`
  const id = await seed([
    { type: 'text', text: `${marker} ` },
    { type: 'mention', userId: `https://${REMOTE.domain}/users/${REMOTE.username}`, username: REMOTE.username, domain: REMOTE.domain, isLocal: false },
  ])
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await expect(rowOf(page, marker)).toBeVisible({ timeout: 15000 })

  const editor = await openEditor(page, marker)
  await expect(editor).toContainText(`@${REMOTE.username}@${REMOTE.domain}`)
  await appendAndSave(page, ' hi')
  await expect.poll(async () => JSON.stringify(await stored(id)), { timeout: 15000 }).toContain(' hi')
})
