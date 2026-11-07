// Journey: an instance admin turns Drive off in Admin > Drive. A member then has no Drive button,
// no Drive page and no From Drive or temporary attachments, and a file sent past their storage,
// with the daily temporary allowance used, is kept with no expiry. Turned on again, Drive
// returns. The database side (sharing, links, expiry) is 235_drive_switch.sql.
//
// drive_enabled is instance-wide; CI runs journeys one at a time and afterAll restores it.

import crypto from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  openChannel,
  seedServer,
  sendMessage,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let staff: SpecUser
let member: SpecUser
let server: SeededServer
const fileName = `kept-${Date.now().toString(36)}.txt`
const BYTES = Buffer.from(`kept while Drive is off ${crypto.randomUUID()}\n`)

async function setConfig(key: string, value: unknown) {
  const { error } = await admin.from('instance_config').update({ config_value: value }).eq('config_key', key)
  if (error) throw new Error(`${key}: ${error.message}`)
}

test.beforeAll(async () => {
  staff = await createUser(admin, 'dsws')
  member = await createUser(admin, 'dswm')
  await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  server = await seedServer(admin, member, `Drive off ${member.username}`)
  // Full, with the daily temporary allowance used: with Drive on, every upload is refused.
  const { error } = await admin.from('drive_quota_overrides').upsert({ profile_id: member.id, quota_bytes: 0 })
  if (error) throw new Error(`quota: ${error.message}`)
  await setConfig('drive_ephemeral_daily_mb', 0)
})

test.afterAll(async () => {
  await setConfig('drive_enabled', true)
  await setConfig('drive_ephemeral_daily_mb', 2048)
  await admin.from('drive_quota_overrides').delete().eq('profile_id', member.id)
  await deleteUser(admin, member)
  await deleteUser(admin, staff)
})

async function driveSwitch(page: Page, on: boolean) {
  await page.goto('/admin?tab=drive')
  await dismissAnnouncements(page)
  const panel = page.getByTestId('drive-admin')
  await expect(panel).toBeVisible({ timeout: 30000 })
  const toggle = panel.getByTestId('drive-admin-enabled')
  await expect(toggle).toHaveAttribute('aria-checked', on ? 'false' : 'true')
  await toggle.click()
  await expect(panel.getByTestId('drive-admin-off-hint')).toHaveCount(on ? 0 : 1)
  await panel.getByTestId('drive-admin-save').click()
  await expect(panel.getByRole('status')).toHaveText('Saved')
  await expect.poll(async () => {
    const { data } = await admin.from('instance_config').select('config_value').eq('config_key', 'drive_enabled').single()
    return data?.config_value
  }).toBe(on)
}

test('Drive turned off: no Drive in the app, and an upload past storage is kept', async ({ page, browser }) => {
  test.setTimeout(240_000)

  await test.step('the admin turns Drive off in Admin > Drive', async () => {
    await signIn(page, staff)
    await driveSwitch(page, false)
  })

  const memberContext = await browser.newContext()
  const memberPage = await memberContext.newPage()

  await test.step('the member has no Drive button and no Drive page', async () => {
    await signIn(memberPage, member)
    await openChannel(memberPage, server.id, server.generalChannelId)
    await expect(memberPage.getByTestId('rail-drive')).toHaveCount(0)
    await memberPage.goto('/drive')
    await expect(memberPage).not.toHaveURL(/\/drive/, { timeout: 30000 })
    await expect(memberPage.getByTestId('drive-view')).toHaveCount(0)
  })

  await test.step('the composer offers neither From Drive nor temporary files', async () => {
    await openChannel(memberPage, server.id, server.generalChannelId)
    await memberPage.getByTestId('composer-attach').click()
    await expect(memberPage.getByTestId('upload-menu-file')).toBeVisible()
    await expect(memberPage.getByTestId('upload-menu-drive')).toHaveCount(0)
    await memberPage.keyboard.press('Escape')

    await memberPage.getByTestId('composer-file-input').setInputFiles({ name: fileName, mimeType: 'text/plain', buffer: BYTES })
    const preview = memberPage.getByTestId('file-preview-item').filter({ hasText: fileName })
    await expect(preview).toBeVisible()
    await expect(preview.getByTestId('temporary-file-button')).toHaveCount(0)
    await expect(preview.getByTestId('file-temporary')).toHaveCount(0)
  })

  await test.step('a file past the member\'s storage is sent and kept with no expiry', async () => {
    await sendMessage(memberPage, 'sent with Drive off')
    await expect(messageList(memberPage).locator('.message-item').filter({ hasText: 'sent with Drive off' }))
      .toContainText(fileName, { timeout: 30000 })
    await expect.poll(async () => {
      const { data } = await admin.from('drive_files').select('state, expires_at, ephemeral_at_upload')
        .eq('owner_id', member.id).eq('name', fileName).maybeSingle()
      return data
    }, { timeout: 30000 }).toEqual({ state: 'drive', expires_at: null, ephemeral_at_upload: false })
  })

  await test.step('turned on again, Drive returns', async () => {
    await driveSwitch(page, true)
    await memberPage.reload()
    await dismissAnnouncements(memberPage)
    await expect(memberPage.getByTestId('rail-drive')).toBeVisible({ timeout: 30000 })
  })

  await memberContext.close()
})
