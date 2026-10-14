// Journey: the composer and Drive. A file sent in a channel is in the sender's Drive under
// that server; the same bytes attached again are recognised and not uploaded twice; a Drive
// file attaches through "From Drive"; an attachment made temporary lands in Temporary; a file
// shared with a channel is under another member's Shared with me. Once the sender deletes a
// sent file forever, or moves one to the trash, that member sees a placeholder in its place.

import { test, expect, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  openChannel,
  seedServer,
  sendMessage,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
const MINUTES = Buffer.from('1. budget\n2. venue\n')

const admin = adminClient()
let owner: SpecUser
let member: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  owner = await createUser(admin, 'dco')
  member = await createUser(admin, 'dcm')
  server = await seedServer(admin, owner, `Drive composer ${owner.username}`)
  await addMember(admin, member, server.id)
})

test.afterAll(async () => {
  await deleteUser(admin, member)
  await deleteUser(admin, owner)
})

const preview = (page: Page, name: string) => page.getByTestId('file-preview-item').filter({ hasText: name })
const driveFiles = (page: Page) => page.getByTestId('drive-items').getByTestId('drive-file')
const driveFile = (page: Page, name: string) => driveFiles(page).filter({ hasText: name })

async function attach(page: Page, name: string, mimeType: string, buffer: Buffer) {
  await page.getByTestId('composer-file-input').setInputFiles({ name, mimeType, buffer })
  await expect(preview(page, name)).toBeVisible()
}

async function openDrive(page: Page) {
  await page.getByTestId('rail-drive').click()
  await expect(page.getByTestId('drive-view')).toBeVisible({ timeout: 30000 })
  await dismissAnnouncements(page)
  await page.getByTestId('drive-layout-list').click()
}

test('sent files live in Drive, reuse, From Drive, temporary, and the gone placeholder', async ({ page, browser }) => {
  test.setTimeout(240_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  await test.step('a sent attachment is in Drive under its server', async () => {
    await attach(page, 'minutes.txt', 'text/plain', MINUTES)
    await expect(preview(page, 'minutes.txt')).toContainText('Uploaded', { timeout: 15000 })
    await sendMessage(page, 'minutes attached')
    await expect(messageList(page).locator('.message-item').filter({ hasText: 'minutes attached' })).toContainText('minutes.txt')

    await openDrive(page)
    await page.getByTestId('drive-nav-server').filter({ hasText: server.name }).click()
    await expect(driveFile(page, 'minutes.txt')).toBeVisible({ timeout: 15000 })
  })

  await test.step('the same bytes attached again are not uploaded twice', async () => {
    await openChannel(page, server.id, server.generalChannelId)
    await attach(page, 'minutes-again.txt', 'text/plain', MINUTES)
    await expect(preview(page, 'minutes-again.txt').getByTestId('file-reused')).toBeVisible({ timeout: 15000 })
    await preview(page, 'minutes-again.txt').getByRole('button', { name: 'Remove minutes-again.txt' }).click()
  })

  await test.step('a Drive file attaches through From Drive', async () => {
    await openDrive(page)
    await page.getByTestId('drive-file-input').setInputFiles({ name: 'poster.png', mimeType: 'image/png', buffer: PNG })
    await expect(driveFile(page, 'poster.png')).toBeVisible({ timeout: 30000 })

    await openChannel(page, server.id, server.generalChannelId)
    await page.getByTestId('composer-attach').click()
    await page.getByTestId('upload-menu-drive').click()
    const picker = page.getByTestId('drive-picker')
    await picker.getByTestId('drive-picker-file').filter({ hasText: 'poster.png' }).click()
    await page.getByTestId('drive-picker-confirm').click()
    await expect(preview(page, 'poster.png').getByTestId('file-from-drive')).toBeVisible()
    await sendMessage(page, 'poster from drive')
    const sent = messageList(page).locator('.message-item').filter({ hasText: 'poster from drive' })
    await expect(sent.locator('img').first()).toBeVisible({ timeout: 15000 })
  })

  await test.step('an attachment made temporary lands in Temporary', async () => {
    await attach(page, 'scratch.txt', 'text/plain', Buffer.from(`scratch ${Date.now()}\n`))
    await expect(preview(page, 'scratch.txt')).toContainText('Uploaded', { timeout: 15000 })
    await preview(page, 'scratch.txt').getByTestId('temporary-file-button').click()
    await expect(preview(page, 'scratch.txt').getByTestId('file-temporary')).toBeVisible()
    await sendMessage(page, 'scratch for now')

    await openDrive(page)
    await page.getByTestId('drive-nav-ephemeral').click()
    await expect(page.getByTestId('drive-temporary-banner')).toBeVisible()
    await expect(driveFiles(page)).toHaveCount(1, { timeout: 15000 })
    await expect(driveFile(page, 'scratch.txt')).toBeVisible()
  })

  await test.step('a file shared with a channel is shared with its members', async () => {
    await page.getByTestId('drive-nav-root').click()
    await driveFile(page, 'poster.png').click()
    await page.getByTestId('drive-share-open').click()
    const dialog = page.getByTestId('drive-share-dialog')
    await dialog.getByTestId('drive-share-server').selectOption({ label: server.name })
    await dialog.getByTestId('drive-share-channel').selectOption({ label: '#general' })
    await dialog.getByTestId('drive-share-add').click()
    await expect(dialog.getByTestId('drive-share-list')).toContainText('general')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  await test.step('the sender deletes the minutes forever', async () => {
    await page.getByTestId('drive-nav-root').click()
    await driveFile(page, 'minutes.txt').click()
    await page.getByTestId('drive-details-delete').click()
    await expect(driveFile(page, 'minutes.txt')).toHaveCount(0)
    await page.getByTestId('drive-nav-trash').click()
    await driveFile(page, 'minutes.txt').click({ button: 'right' })
    await page.getByTestId('drive-file-menu').getByRole('menuitem', { name: 'Delete forever' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete forever' }).click()
    await expect(driveFile(page, 'minutes.txt')).toHaveCount(0)
  })

  await test.step('another member sees the shared file and a placeholder where the minutes were', async () => {
    const context = await browser.newContext()
    try {
      const other = await context.newPage()
      await signIn(other, member)
      await openChannel(other, server.id, server.generalChannelId)
      const row = messageList(other).locator('.message-item').filter({ hasText: 'minutes attached' })
      await expect(row.getByTestId('drive-gone-file')).toBeVisible({ timeout: 30000 })

      await openDrive(other)
      await other.getByTestId('drive-nav-shared').click()
      await expect(driveFiles(other)).toHaveCount(1, { timeout: 15000 })
      await expect(driveFile(other, 'poster.png')).toBeVisible()

      const sender = await userClient(owner)
      const { data: poster } = await sender.from('drive_files').select('id').like('path', '%.png').eq('name', 'poster.png').single()
      const { error } = await sender.rpc('drive_trash_files', { p_files: [poster!.id] })
      expect(error).toBeNull()
      await openChannel(other, server.id, server.generalChannelId)
      const sent = messageList(other).locator('.message-item').filter({ hasText: 'poster from drive' })
      await expect(sent.getByTestId('drive-gone-file')).toContainText('This file is unavailable', { timeout: 30000 })
    } finally {
      await context.close()
    }
  })
})
