// Journey: Server settings › Emoji on the shared emoji library (EmojiLibraryManager), the
// surface Settings › My emojis also uses.
//
// The owner uploads a PNG: it lists with the count against max_custom_emojis_per_server, and
// 0 there reads as no limit (the count alone). The hint names the formats the emojis bucket
// takes, SVG excluded. Rename and delete run by keyboard as on My emojis: Enter saves and
// focus returns to Rename, an invalid name stays in the field with the reason, deletion
// confirms and focus moves to the list heading once it empties.

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, seedServer, signIn, type SeededServer, type SpecUser } from './harness'
import { expectNoAxeViolations } from './a11y'

const admin = adminClient()
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
const KEY = 'max_custom_emojis_per_server'

let owner: SpecUser
let server: SeededServer
let saved: { config_value: unknown } | null = null

test.beforeAll(async () => {
  const { data } = await admin.from('instance_config').select('config_value').eq('config_key', KEY).maybeSingle()
  saved = data
  owner = await createUser(admin, 'semo')
  server = await seedServer(admin, owner, `Emoji Library ${owner.username}`)
})

test.afterAll(async () => {
  if (saved) await admin.from('instance_config').update({ config_value: saved.config_value }).eq('config_key', KEY)
  else await admin.from('instance_config').delete().eq('config_key', KEY)
  const { data: rows } = await admin.from('emojis').select('url').eq('server_id', server?.id ?? '')
  await admin.from('emojis').delete().eq('server_id', server?.id ?? '')
  const paths = (rows ?? []).map((r) => r.url.split('/storage/v1/object/public/emojis/')[1]).filter(Boolean)
  if (paths.length) await admin.storage.from('emojis').remove(paths)
  await deleteUser(admin, owner)
})

test('the owner uploads, renames and deletes a server emoji; 0 is no limit', async ({ page }) => {
  test.setTimeout(180_000)
  await admin.from('instance_config').upsert({ config_key: KEY, config_value: 50 }, { onConflict: 'config_key' })
  await signIn(page, owner)
  await page.goto(`/server/${server.id}?section=emoji`)

  const upload = page.getByTestId('emoji-upload-input')
  await expect(upload).toBeAttached({ timeout: 30000 })
  await expect(page.getByText('Formats: PNG, GIF, WebP, APNG, JPEG.')).toBeVisible()
  await expect(upload).toHaveAttribute('accept', 'image/png,image/gif,image/webp,image/apng,image/jpeg')
  const count = page.getByTestId('emoji-count')
  await expect(count).toHaveText('0 / 50')

  await upload.setInputFiles({ name: 'wave.png', mimeType: 'image/png', buffer: PNG })
  const item = page.locator('.emoji-item').filter({ hasText: ':wave:' })
  await expect(item).toBeVisible({ timeout: 20000 })
  await expect(count).toHaveText('1 / 50')
  await expectNoAxeViolations(page, { include: '.server-emoji-management', label: 'server settings/emoji' })

  await admin.from('instance_config').update({ config_value: 0 }).eq('config_key', KEY)
  await page.reload()
  await expect(page.getByTestId('emoji-count')).toHaveText('1', { timeout: 30000 })

  const rename = page.getByRole('button', { name: 'Rename :wave:' })
  await rename.focus()
  await page.keyboard.press('Enter')
  const field = page.getByRole('textbox', { name: 'New name for :wave:' })
  await expect(field).toBeFocused()
  await page.keyboard.type('bad name')
  await page.keyboard.press('Enter')
  await expect(field).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText('Names are 2 to 64 letters, digits, _ or -.')).toBeVisible()
  await field.fill('hello_wave')
  await page.keyboard.press('Enter')
  await expect(page.locator('.emoji-item .emoji-name')).toHaveText(':hello_wave:')
  await expect(page.getByRole('button', { name: 'Rename :hello_wave:' })).toBeFocused()
  await expect
    .poll(async () => (await admin.from('emojis').select('name').eq('server_id', server.id)).data?.map((r) => r.name))
    .toEqual(['hello_wave'])

  await page.getByRole('button', { name: 'Delete :hello_wave:' }).focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('hello_wave')
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText('No custom emojis yet')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Custom emojis' })).toBeFocused()
  await expect
    .poll(async () => (await admin.from('emojis').select('id').eq('server_id', server.id)).data?.length)
    .toBe(0)
})
