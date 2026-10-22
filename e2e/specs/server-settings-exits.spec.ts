// Journey: Server settings keeps the user's place on the way out.
// - Saving keeps Settings open. Closing lands on the edited server's channel, not on the
//   last channel viewed in another server.
// - Deleting a server drops it from the rail and lands on chat in a server that remains,
//   also when the deleted server was first in the rail. Back does not return to the
//   deleted server's settings.
// - On a phone, Server settings opened from the drawer's server menu takes taps: the
//   drawer closes on the way, and nothing is left inert.

import { test, expect, devices, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let editor: SpecUser
let deleter: SpecUser
let phone: SpecUser
let alpha: SeededServer
let bravo: SeededServer
let keep: SeededServer
let phoneLab: SeededServer

test.beforeAll(async () => {
  editor = await createUser(admin, 'sseed')
  deleter = await createUser(admin, 'ssedel')
  phone = await createUser(admin, 'ssepho')
  alpha = await seedServer(admin, editor, `Alpha ${editor.username.slice(-6)}`)
  bravo = await seedServer(admin, editor, `Bravo ${editor.username.slice(-6)}`)
  keep = await seedServer(admin, deleter, `Keep ${deleter.username.slice(-6)}`)
  phoneLab = await seedServer(admin, phone, `Phone ${phone.username.slice(-6)}`)
})

test.afterAll(async () => {
  await deleteUser(admin, editor)
  await deleteUser(admin, deleter)
  await deleteUser(admin, phone)
})

const railItem = (page: Page, serverId: string) =>
  page.locator(`[data-rail-kind="server"][data-rail-id="${serverId}"]`)

async function setRailPosition(user: SpecUser, serverId: string, position: number) {
  const { error } = await admin
    .from('user_servers')
    .update({ position })
    .eq('user_id', user.id)
    .eq('server_id', serverId)
  if (error) throw new Error(`position: ${error.message}`)
}

test('saving keeps Settings open; closing lands on the edited server', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, editor)
  await openChannel(page, alpha.id, alpha.generalChannelId)

  await page.goto(`/server/${bravo.id}`)
  const description = page.locator('#server-description')
  await expect(description).toBeVisible({ timeout: 30000 })

  await test.step('Save stores the edit and stays in Settings', async () => {
    await description.fill('Bravo, edited from its settings')
    const saved = page.waitForResponse((r) => r.url().includes('/rpc/update_server') && r.request().method() === 'POST')
    await page.locator('.server-settings-header').getByRole('button', { name: 'Save changes' }).click()
    expect((await saved).ok()).toBe(true)
    await expect(page.getByText('Server updated')).toBeVisible()
    await page.waitForTimeout(1000)
    await expect(page).toHaveURL(new RegExp(`/server/${bravo.id}$`))
    await expect(description).toHaveValue('Bravo, edited from its settings')
  })

  await test.step('closing lands on the edited server, not the channel viewed before', async () => {
    await page.getByRole('button', { name: 'Back to chat' }).click()
    await expect(page).toHaveURL(new RegExp(`/chat/${bravo.id}/${bravo.generalChannelId}$`), { timeout: 15000 })
    await expect(page.locator('.channel-sidebar .server-name')).toContainText(bravo.name)
  })
})

test('deleting a server drops it from the rail and lands on chat in a server that remains', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, deleter)

  async function deleteFromSettings(doomed: SeededServer) {
    await page.goto(`/server/${doomed.id}?section=advanced`)
    await dismissAnnouncements(page)
    await expect(railItem(page, doomed.id)).toHaveCount(1, { timeout: 30000 })
    await page.getByTestId('delete-server-open').click()
    const dialog = page.getByRole('alertdialog', { name: 'Delete server' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('textbox', { name: /Type the server name to confirm/ }).fill(doomed.name)
    await dialog.getByRole('button', { name: 'Delete server' }).click()
    await expect(page.getByText('Server deleted')).toBeVisible({ timeout: 15000 })
  }

  async function expectLandedOnKeep(doomed: SeededServer) {
    await expect(page).toHaveURL(new RegExp(`/chat/${keep.id}/${keep.generalChannelId}$`), { timeout: 15000 })
    await expect(messageList(page)).toBeVisible({ timeout: 30000 })
    await expect(railItem(page, doomed.id)).toHaveCount(0)
    await expect(railItem(page, keep.id)).toHaveCount(1)
    await expect(page.getByTestId('delete-server-open')).toHaveCount(0)
  }

  await test.step('a server below another in the rail', async () => {
    const doomed = await seedServer(admin, deleter, `Doomed ${deleter.username.slice(-6)}`)
    await setRailPosition(deleter, keep.id, 0)
    await setRailPosition(deleter, doomed.id, 1)
    await deleteFromSettings(doomed)
    await expectLandedOnKeep(doomed)
  })

  await test.step('the first server in the rail; Back does not reopen its settings', async () => {
    const doomed = await seedServer(admin, deleter, `First ${deleter.username.slice(-6)}`)
    await setRailPosition(deleter, doomed.id, 0)
    await setRailPosition(deleter, keep.id, 1)
    await deleteFromSettings(doomed)
    await expectLandedOnKeep(doomed)
    await page.goBack()
    await page.waitForTimeout(500)
    await expect(page).not.toHaveURL(new RegExp(`/server/${doomed.id}`))
  })
})

test.describe('on a phone', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })

  test('Server settings opened from the drawer takes taps', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, phone)
    await page.goto(`/chat/${phoneLab.id}/${phoneLab.generalChannelId}`)
    await dismissAnnouncements(page)
    await expect(messageList(page)).toBeVisible({ timeout: 30000 })

    await page.getByRole('button', { name: 'Navigation menu' }).first().tap()
    await page.locator('.channel-sidebar .server-name').tap()
    await page.getByRole('menuitem', { name: 'Server settings' }).tap()
    await expect(page).toHaveURL(new RegExp(`/server/${phoneLab.id}$`))

    await test.step('the drawer is closed and nothing outside it is inert', async () => {
      await expect(page.locator('.base-layout')).not.toHaveClass(/sidebar-open/)
      expect(await page.locator('.server-settings').evaluate((el) => !!el.closest('[inert]'))).toBe(false)
    })

    await test.step('a section from the list opens', async () => {
      await page.locator('#server-settings-sidebar').getByRole('button', { name: 'Roles' }).tap({ timeout: 5000 })
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Roles')
    })

    await test.step('✕ returns to the channel', async () => {
      await page.locator('.mobile-nav').getByRole('button', { name: 'Close settings' }).tap({ timeout: 5000 })
      await expect(page).toHaveURL(new RegExp(`/chat/${phoneLab.id}/${phoneLab.generalChannelId}$`), { timeout: 15000 })
    })
  })

  test('Server settings opened from the rail menu takes taps', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, phone)
    await page.goto(`/chat/${phoneLab.id}/${phoneLab.generalChannelId}`)
    await dismissAnnouncements(page)
    await expect(messageList(page)).toBeVisible({ timeout: 30000 })

    await page.getByRole('button', { name: 'Navigation menu' }).first().tap()
    await railItem(page, phoneLab.id).click({ button: 'right' })
    await page.locator('.rail-menu-item[data-action="settings"]').tap()
    await expect(page).toHaveURL(new RegExp(`/server/${phoneLab.id}$`))

    await expect(page.locator('.base-layout')).not.toHaveClass(/sidebar-open/)
    await page.locator('#server-settings-sidebar').getByRole('button', { name: 'Roles' }).tap({ timeout: 5000 })
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Roles')

    await test.step('Back returns to the channel with the drawer closed', async () => {
      await page.goBack()
      await expect(page).toHaveURL(new RegExp(`/chat/${phoneLab.id}/${phoneLab.generalChannelId}$`), { timeout: 15000 })
      await expect(page.locator('.base-layout')).not.toHaveClass(/sidebar-open/)
    })
  })
})
