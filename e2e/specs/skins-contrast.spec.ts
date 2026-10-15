// Journey: every skin, and no skin, in dark and light theme keeps text readable where the owner
// found it unreadable: the server chat (channel list with the open channel, a message that
// mentions the reader, a reply, a code block, the member list), the DM list with a selected
// conversation, and a message's context menu. axe color-contrast runs on each with the shared
// AXE_EXCLUSIONS (white on the brand blue, role-coloured names).
//
// Skin and theme are the profile's appearance_settings, written before the page loads.

import { test, expect, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'
import { expectNoAxeViolations } from './a11y'

const SKINS = [null, 'paper', 'flux', 'lattice', 'sdr-001', 'skyglass'] as const
const THEMES = ['dark', 'light'] as const

const admin = adminClient()
let reader: SpecUser
let friend: SpecUser
let server: SeededServer
let conversationId = ''

test.beforeAll(async () => {
  reader = await createUser(admin, 'skinc')
  friend = await createUser(admin, 'skincf')
  server = await seedServer(admin, reader, `Skins ${reader.username}`)
  await addMember(admin, friend, server.id)
  const { data: first, error } = await admin
    .from('messages')
    .insert({ channel_id: server.generalChannelId, user_id: friend.id, content: [{ type: 'text', text: 'Morning! Anyone around?' }] })
    .select('id')
    .single()
  if (error || !first) throw new Error(`message: ${error?.message}`)
  await admin.from('messages').insert([
    {
      channel_id: server.generalChannelId,
      user_id: friend.id,
      content: [
        { type: 'mention', userId: reader.id, username: reader.username, domain: 'localhost', isLocal: true },
        { type: 'text', text: ' can you check the build?' },
      ],
    },
    {
      channel_id: server.generalChannelId,
      user_id: reader.id,
      reply_to: first.id,
      content: [{ type: 'text', text: 'Here:\n```ts\nconst answer: number = 42 // checked\nexport function build() { return "ok" }\n```' }],
    },
  ])
  const { data: conversation, error: dmError } = await admin.from('conversations').insert({ type: 'direct', created_by: reader.id }).select('id').single()
  if (dmError || !conversation) throw new Error(`conversation: ${dmError?.message}`)
  conversationId = conversation.id
  await admin.from('conversation_participants').insert([
    { conversation_id: conversationId, user_id: reader.id },
    { conversation_id: conversationId, user_id: friend.id },
  ])
  await admin.from('messages').insert({ conversation_id: conversationId, user_id: friend.id, content: [{ type: 'text', text: 'see you at the call' }] })
})

test.afterAll(async () => {
  await deleteUser(admin, friend)
  await deleteUser(admin, reader)
})

async function useAppearance(skin: string | null, theme: string) {
  const { error } = await admin.from('profiles').update({ appearance_settings: { theme, activeSkinId: skin } }).eq('id', reader.id)
  if (error) throw new Error(`appearance: ${error.message}`)
}

async function settled(page: Page, theme: string, skin: string | null) {
  await expect(page.locator('html')).toHaveAttribute('data-theme-type', theme, { timeout: 15000 })
  if (skin) await expect(page.locator('html')).toHaveAttribute('data-skin', skin, { timeout: 15000 })
  else await expect(page.locator('html')).not.toHaveAttribute('data-skin', /.+/)
  // Skin sheets load as chunks; transitions blend colours that axe would read mid-way.
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(600)
}

for (const skin of SKINS) {
  for (const theme of THEMES) {
    test(`${skin ?? 'no skin'} in ${theme}: chat, DM list and context menu read`, async ({ page }) => {
      test.setTimeout(120_000)
      await useAppearance(skin, theme)
      await signIn(page, reader)
      const label = `${skin ?? 'no skin'} ${theme}`

      await test.step('server chat', async () => {
        await openChannel(page, server.id, server.generalChannelId)
        await expect(page.getByText('can you check the build?')).toBeVisible({ timeout: 30000 })
        await settled(page, theme, skin)
        await expectNoAxeViolations(page, { rules: ['color-contrast'], label: `${label} chat` })
      })

      await test.step('message context menu', async () => {
        await page.locator('.text-content', { hasText: 'Morning! Anyone around?' }).first().click({ button: 'right' })
        const menu = page.getByRole('menu').first()
        await expect(menu).toBeVisible()
        await page.waitForTimeout(300)
        await expectNoAxeViolations(page, { rules: ['color-contrast'], label: `${label} context menu` })
        await page.keyboard.press('Escape')
      })

      await test.step('DM list with the selected conversation', async () => {
        await page.goto(`/dm/${conversationId}`)
        await dismissAnnouncements(page)
        await expect(page.getByText('see you at the call').first()).toBeVisible({ timeout: 30000 })
        await settled(page, theme, skin)
        await expectNoAxeViolations(page, { rules: ['color-contrast'], label: `${label} DM` })
      })
    })
  }
}
