// Journey: instance staff and Drive. An admin sets the user quota in Admin > Drive and sees
// accounts by usage. A reported message's file is removed and blocked from the report: the
// block waits for the server's own hash of the bytes (the uploader's sha256 is a claim), then
// lists under blocked files; the offender's composer refuses the same bytes and says why; the
// block lifts on Unblock. The server's own Reports view offers no file removal: it is instance
// staff's.
//
// The stack runs no queue worker: the hash job's drive_record_hash call is made here as the
// service role, with the hash of the bytes the offender uploaded.

import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { test, expect } from '@playwright/test'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  openChannel,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head, data])))
  return Buffer.concat([len, head, data, crc])
}
// 16x1 8-bit greyscale with random pixels: bytes no other spec uploads, so the block touches
// nothing else on the stack. No ancillary chunk and nothing after IEND, so the composer's
// metadata strip leaves them as they are and hashes the same bytes.
const IHDR = Buffer.from([0, 0, 0, 16, 0, 0, 0, 1, 8, 0, 0, 0, 0])
const BYTES = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  pngChunk('IHDR', IHDR),
  pngChunk('IDAT', zlib.deflateSync(Buffer.concat([Buffer.from([0]), crypto.randomBytes(16)]))),
  pngChunk('IEND', Buffer.alloc(0)),
])
const SHA = crypto.createHash('sha256').update(BYTES).digest('hex')

const admin = adminClient()
let staff: SpecUser
let offender: SpecUser
let reporter: SpecUser
let server: SeededServer
let path: string

test.beforeAll(async () => {
  staff = await createUser(admin, 'dadm')
  offender = await createUser(admin, 'doff')
  reporter = await createUser(admin, 'drep')
  await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  server = await seedServer(admin, reporter, `Reports ${reporter.username}`)
  await addMember(admin, offender, server.id)

  const client = await userClient(offender)
  path = `c/${server.generalChannelId}/${offender.id}/${crypto.randomUUID()}.png`
  // The claimed sha256 names other bytes; a block must not take it at its word.
  const { error: uploadError } = await client.storage.from('message_media').upload(path, BYTES, {
    contentType: 'image/png',
    metadata: { name: 'bad.png', sha256: 'ab'.repeat(32) },
  })
  if (uploadError) throw new Error(`upload: ${uploadError.message}`)
  const { data: message, error: messageError } = await client.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: offender.id,
    content: [
      { type: 'text', text: 'look at this' },
      { type: 'file', fileType: 'image', url: '', path, fileName: 'bad.png' },
    ],
  }).select('id').single()
  if (messageError || !message) throw new Error(`message: ${messageError?.message}`)

  const reporting = await userClient(reporter)
  const { error: reportError } = await reporting.rpc('create_report', {
    p_report_type: 'message',
    p_reported_user_id: offender.id,
    p_reported_post_id: null,
    p_reported_message_id: message.id,
    p_reported_server_id: server.id,
    p_reason: 'spam',
    p_category: null,
    p_comment: 'drive admin journey',
    p_forward: false,
    p_evidence_text: null,
  })
  if (reportError) throw new Error(`report: ${reportError.message}`)
})

test.afterAll(async () => {
  await admin.from('drive_blocked_hashes').delete().eq('sha256', SHA)
  await deleteUser(admin, reporter)
  await deleteUser(admin, offender)
  await deleteUser(admin, staff)
})

test('quota settings, usage, and a reported file removed and blocked', async ({ page, browser }) => {
  test.setTimeout(180_000)
  await signIn(page, staff)

  await test.step('the user quota saves from Admin > Drive; usage lists the offender', async () => {
    await page.goto('/admin?tab=drive')
    await dismissAnnouncements(page)
    const panel = page.getByTestId('drive-admin')
    await expect(panel).toBeVisible({ timeout: 30000 })
    await expect(panel.locator('tr').filter({ hasText: `@${offender.username}` })).toBeVisible()

    const quota = panel.getByTestId('drive-admin-quota-user')
    await expect(quota).toHaveValue('1024')
    await quota.fill('1536')
    await panel.getByTestId('drive-admin-save').click()
    await expect(panel.getByRole('status')).toHaveText('Saved')
    const { data } = await admin.from('instance_config').select('config_value').eq('config_key', 'drive_quota_user_mb').single()
    expect(Number(data?.config_value)).toBe(1536)
    await quota.fill('1024')
    await panel.getByTestId('drive-admin-save').click()
    await expect.poll(async () => {
      const { data: back } = await admin.from('instance_config').select('config_value').eq('config_key', 'drive_quota_user_mb').single()
      return Number(back?.config_value)
    }).toBe(1024)
  })

  await test.step('the report removes and blocks its file; the block waits for the server hash', async () => {
    await page.goto('/admin?tab=reports')
    const report = page.locator('.report-item').filter({ hasText: offender.username }).first()
    await report.click()
    const files = report.getByTestId('report-files')
    await expect(files).toContainText('bad.png')
    await files.getByTestId('report-block-file').click()
    await expect(files).toContainText('Removed')

    const { data: row } = await admin.from('drive_files').select('id, state, gone_reason').eq('path', path).single()
    expect(row).toMatchObject({ state: 'gone', gone_reason: 'removed' })
    const { data: pending } = await admin.from('drive_pending_blocks').select('reason').eq('file_id', row!.id)
    expect(pending).toEqual([{ reason: 'spam' }])
    const { count } = await admin.from('drive_blocked_hashes').select('sha256', { count: 'exact', head: true }).eq('sha256', 'ab'.repeat(32))
    expect(count).toBe(0)

    const { data: recorded, error } = await admin.rpc('drive_record_hash', { p_bucket: 'message_media', p_path: path, p_sha256: SHA })
    expect(error).toBeNull()
    expect(recorded).toBe('blocked')
  })

  await test.step('the offender\'s composer refuses the same bytes and says why', async () => {
    const context = await browser.newContext()
    try {
      const other = await context.newPage()
      await signIn(other, offender)
      await openChannel(other, server.id, server.generalChannelId)
      await other.getByTestId('composer-file-input').setInputFiles({ name: 'again.png', mimeType: 'image/png', buffer: BYTES })
      const item = other.getByTestId('file-preview-item').filter({ hasText: 'again.png' })
      await expect(item).toContainText('This file was removed by the instance moderators.', { timeout: 15000 })
    } finally {
      await context.close()
    }
  })

  await test.step('the server owner sees the report without the instance file actions', async () => {
    const context = await browser.newContext()
    try {
      const owner = await context.newPage()
      await signIn(owner, reporter)
      await owner.goto(`/server/${server.id}?section=reports`)
      const report = owner.locator('.report-item').filter({ hasText: offender.username }).first()
      await expect(report).toBeVisible({ timeout: 30000 })
      await report.click()
      await expect(report.locator('.report-detail')).toBeVisible()
      await expect(report.getByTestId('report-files')).toHaveCount(0)
    } finally {
      await context.close()
    }
  })

  await test.step('the blocked hash lists in Admin > Drive and lifts on Unblock', async () => {
    await page.goto('/admin?tab=drive')
    const panel = page.getByTestId('drive-admin')
    const blocked = panel.locator('li').filter({ hasText: SHA.slice(0, 16) })
    await expect(blocked).toContainText('spam', { timeout: 30000 })
    await blocked.getByRole('button', { name: 'Unblock' }).click()
    await expect(blocked).toHaveCount(0)
    const { count } = await admin.from('drive_blocked_hashes').select('sha256', { count: 'exact', head: true }).eq('sha256', SHA)
    expect(count).toBe(0)
  })
})
