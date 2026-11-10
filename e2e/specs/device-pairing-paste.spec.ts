// Journey: linking a device by pasting its pairing code, with both sessions in browsers of one
// machine, where neither camera can see the other screen (DevicePairingPanel, DeviceLinkModal,
// PairingCodeField).
//
// Ava sets up encryption and posts in an encrypted channel on her first browser. A second
// browser of hers opens Restore encryption: its code shows as text under the QR code; the first
// browser pastes it, line-wrapped as a chat would carry it, confirms on screen, and the second
// reads the message. A third browser picks Scan or paste a code instead; the first shows its
// code as text, the third pastes it, the first confirms the device that answered, and the third
// reads the message. Pairing requests and answers are polled: the stack runs no realtime.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  dismissAnnouncements,
  openChannel,
  seedServer,
  sendMessage,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'
import { setUpEncryption } from './encryption'
import { Cast, item } from './encryptedHistory'

const admin = adminClient()
const cast = new Cast(admin)
const BASE_URL = process.env.BASE_URL || 'http://localhost:5173'

test.describe.configure({ mode: 'default' })

let ava: SpecUser
let server: SeededServer
let first: Page
let text = ''

test.afterAll(async () => {
  if (server) await admin.from('servers').delete().eq('id', server.id)
  await cast.cleanup()
})

/** In-app navigation: a reload would drop the first browser's keys from memory. */
async function goInApp(page: Page, path: string) {
  await page.evaluate(async (to) => {
    const app = (document.querySelector('#app') as unknown as { __vue_app__: { config: { globalProperties: { $router: { push: (p: string) => Promise<unknown> } } } } }).__vue_app__
    await app.config.globalProperties.$router.push(to)
  }, path)
}

async function openRestore(page: Page) {
  await page.goto('/settings/privacy')
  await dismissAnnouncements(page)
  await page.getByRole('button', { name: 'Unlock message history' }).click({ timeout: 30000 })
  const panel = page.getByTestId('pairing-panel')
  await expect(panel).toBeVisible({ timeout: 15000 })
  return panel
}

async function openLinkDialog(page: Page) {
  await goInApp(page, '/settings/privacy')
  await page.getByTestId('link-device-button').click({ timeout: 30000 })
  const dialog = page.getByTestId('device-link-modal')
  await expect(dialog).toBeVisible({ timeout: 15000 })
  return dialog
}

async function codeShown(scope: ReturnType<Page['getByTestId']>) {
  const field = scope.getByTestId('pairing-code-text')
  await expect(field).toHaveValue(/^HMP:[A-Za-z0-9_-]+$/, { timeout: 30000 })
  return field.inputValue()
}

async function reads(page: Page) {
  await openChannel(page, server.id, server.generalChannelId)
  await expect(item(page, text)).toHaveCount(1, { timeout: 60000 })
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000)
  ava = await cast.actor('pair')
  server = await seedServer(admin, ava, `Pairing ${ava.username}`)
  const { error } = await admin
    .from('server_encryption_settings')
    .upsert({ server_id: server.id, encryption_mode: 'required' }, { onConflict: 'server_id' })
  if (error) throw new Error(`encryption floor: ${error.message}`)

  const context = await cast.profile(browser)
  first = await context.newPage()
  await signIn(first, ava)
  await openChannel(first, server.id, server.generalChannelId)
  await setUpEncryption(first, ava)
  text = `paired history ${ava.username}`
  const posted = await sendMessage(first, text)
  const { data } = await admin.from('messages').select('encrypted').eq('id', (await posted.getAttribute('data-message-id'))!).single()
  expect(data?.encrypted).toBe(true)
})

test('the new browser shows its code as text; the signed-in one pastes it and confirms', async ({ browser }) => {
  test.setTimeout(240_000)
  const context = await cast.profile(browser)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL })
  const second = await context.newPage()
  await signIn(second, ava)

  let code = ''
  await test.step('Restore encryption shows the code as text with a Copy button', async () => {
    const panel = await openRestore(second)
    await expect(panel.getByTestId('pairing-qr')).toBeVisible({ timeout: 30000 })
    await expect(panel).toContainText('or copy the code below and paste it there')
    code = await codeShown(panel)
    expect(code).toHaveLength(96)
    await expect(panel.getByLabel('Pairing code')).toHaveAttribute('readonly', '')
    await panel.getByTestId('pairing-code-copy').click()
    await expect(panel.getByTestId('pairing-code-copy')).toHaveText('Copied')
    expect(await second.evaluate(() => navigator.clipboard.readText())).toBe(code)
  })

  await test.step('the signed-in browser pastes it, wrapped over lines, and confirms', async () => {
    const dialog = await openLinkDialog(first)
    const wrapped = `${code.slice(0, 40)}\n${code.slice(40, 80)} \n${code.slice(80)}`
    await dialog.getByLabel('Or paste the code copied from the new device').fill(wrapped)
    await dialog.getByRole('button', { name: 'Use pasted code' }).click()
    await expect(dialog.getByTestId('link-confirm')).toBeVisible({ timeout: 30000 })
    await expect(dialog.getByTestId('link-confirm')).toContainText('Its key matches the code you scanned.')
    await dialog.getByTestId('link-confirm-button').click()
    await expect(dialog.getByTestId('link-done')).toBeVisible({ timeout: 60000 })
    await dialog.getByRole('button', { name: 'Done' }).click()
  })

  await test.step('the new browser unlocks and reads the encrypted message', async () => {
    await expect(second.getByTestId('pairing-panel')).toHaveCount(0, { timeout: 60000 })
    await expect(second.getByTestId('pairing-error')).toHaveCount(0)
    await reads(second)
  })
})

test('the signed-in browser shows its code as text; a new browser pastes it', async ({ browser }) => {
  test.setTimeout(240_000)
  const context = await cast.profile(browser)
  const third = await context.newPage()
  await signIn(third, ava)

  await test.step('Restore encryption offers Scan or paste a code', async () => {
    const panel = await openRestore(third)
    await panel.getByRole('button', { name: "Other device can't scan? Scan or paste a code from it instead" }).click()
    await expect(panel.getByLabel('Or paste the code from your other device')).toBeVisible()
  })

  let code = ''
  await test.step('the signed-in browser shows its code as text', async () => {
    const dialog = await openLinkDialog(first)
    await dialog.getByRole('button', { name: 'Show a code to scan or copy instead' }).click()
    await expect(dialog.getByTestId('link-qr')).toBeVisible({ timeout: 30000 })
    await expect(dialog).toContainText('or copy the code below and paste it there')
    code = await codeShown(dialog)
    expect(code).toHaveLength(43)
  })

  await test.step('the new browser pastes it; the signed-in one confirms the device that answered', async () => {
    const panel = third.getByTestId('pairing-panel')
    await panel.getByLabel('Or paste the code from your other device').fill(`  ${code}\n`)
    await panel.getByRole('button', { name: 'Use pasted code' }).click()
    await expect(panel).toContainText('Confirm on your other device to finish linking.', { timeout: 30000 })

    const dialog = first.getByTestId('device-link-modal')
    await expect(dialog.getByTestId('link-confirm')).toBeVisible({ timeout: 30000 })
    await expect(dialog.getByTestId('link-confirm')).toContainText('It answered the code this device showed.')
    await dialog.getByTestId('link-confirm-button').click()
    await expect(dialog.getByTestId('link-done')).toBeVisible({ timeout: 60000 })
  })

  await test.step('the new browser unlocks and reads the encrypted message', async () => {
    await expect(third.getByTestId('pairing-panel')).toHaveCount(0, { timeout: 60000 })
    await reads(third)
  })
})
