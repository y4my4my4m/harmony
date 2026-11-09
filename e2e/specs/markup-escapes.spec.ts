// Journey: a backslash shows the next character as typed. An escaped mention, channel, emoji, link,
// quote or formatting marker draws nothing and pings nobody; an edit shows what was typed; inline
// code keeps its backslash.

import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  adminClient,
  addMember,
  composer,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let member: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  owner = await createUser(admin, 'mes')
  member = await createUser(admin, 'mem')
  server = await seedServer(admin, owner, `Escapes ${owner.username.slice(-6)}`)
  await addMember(admin, member, server.id)
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  await deleteUser(admin, owner)
  await deleteUser(admin, member)
})

// Types as a person does: the composer's own markup and pills see each key.
async function send(page: Page, tag: string, typed: string): Promise<Locator> {
  await composer(page).click()
  await composer(page).pressSequentially(`${tag} ${typed}`, { delay: 5 })
  await page.keyboard.press('Enter')
  const row = page.locator('[data-testid="message-list"] .message-item').filter({ hasText: tag }).last()
  await expect(row).toBeVisible({ timeout: 30000 })
  await expect(row).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
  return row
}

test('escaped markers draw nothing and show the character', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  const cases: Array<[string, string, string, string]> = [
    ['bold', '\\*\\*word\\*\\*', '**word**', '.md-bold'],
    ['italic', '\\*word\\*', '*word*', '.md-italic'],
    ['under', '\\_word\\_', '_word_', '.md-italic'],
    ['strike', '\\~\\~word\\~\\~', '~~word~~', '.md-strikethrough'],
    ['spoil', '\\|\\|word\\|\\|', '||word||', '.md-spoiler'],
    ['code', '\\`word\\`', '`word`', '.md-code'],
  ]
  for (const [tag, typed, shown, drawn] of cases) {
    const row = await send(page, `esc${tag}`, typed)
    await expect(row).toContainText(shown)
    await expect(row.locator(drawn)).toHaveCount(0)
    await expect(row).not.toContainText('\\')
  }
})

test('an escaped line start draws no quote', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const tag = `escquote${Date.now().toString(36)}`
  await composer(page).click()
  await composer(page).pressSequentially(`\\> ${tag}`, { delay: 5 })
  await page.keyboard.press('Enter')
  const posted = page.locator('[data-testid="message-list"] .message-item').filter({ hasText: tag }).last()
  await expect(posted).toBeVisible({ timeout: 30000 })
  await expect(posted.locator('blockquote')).toHaveCount(0)
  await expect(posted).toContainText(`> ${tag}`)
  await expect(posted).not.toContainText('\\')
})

test('an escaped mention, channel and link are text, and the part stored says so', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  const mention = await send(page, 'escmention', `\\@${member.username} `)
  await expect(mention.locator('.mention')).toHaveCount(0)
  await expect(mention).toContainText(`@${member.username}`)
  await expect(mention).not.toContainText('\\@')

  const channel = await send(page, 'escchannel', '\\#general ')
  await expect(channel.locator('.channel-mention')).toHaveCount(0)
  await expect(channel).toContainText('#general')

  const link = await send(page, 'esclink', '\\https://x.example/a ')
  await expect(link.locator('a.url-link')).toHaveCount(0)
  await expect(link).toContainText('https://x.example/a')

  const { data } = await admin.from('messages').select('content').eq('channel_id', server.generalChannelId)
  const parts = (data ?? []).flatMap((m) => m.content as Array<{ type: string }>)
  expect(parts.filter((p) => p.type === 'mention' || p.type === 'channel_mention')).toEqual([])

  const unread = await admin.from('notifications').select('id').eq('user_id', member.id).eq('type', 'mention')
  expect(unread.data ?? []).toEqual([])
})

test('an edit shows what was typed; inline code keeps its backslash', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const row = await send(page, 'escedit', '\\*word\\*')
  await row.hover()
  await row.getByTestId('msg-action-edit').click()
  await expect(row.locator('.rich-text-editor')).toContainText('\\*word\\*')
  await page.keyboard.press('Escape')

  const code = await send(page, 'esccode', '`\\*word\\*`')
  await expect(code.locator('code')).toHaveText('\\*word\\*')
})
