// Journey: upload limits. An instance admin sets the tiers in Admin > Config > Uploads under the
// operator's ceiling (FILE_SIZE_LIMIT, 50 MB on this stack). A member's file over the default
// tier is refused in the composer before a byte is sent, the limit named on the attachment and
// in the transfers list; an instance moderator, whose tier is higher, uploads the same file. An
// admin raises one member's limit in Admin > Users and that member uploads it; "Use the tier"
// returns the member to the default. Straight to the storage API, a member's file over the
// limit is refused by storage itself: a single-request upload once its bytes arrive, leaving no
// object, and a resumable upload when it is created, before any byte.
//
// Tiers are instance-wide: 16 and 24 MB, and an 18 MB file, stay above every file other
// journeys upload (13 MiB at most); afterAll puts back 50 MB.

import { randomBytes, randomUUID } from 'node:crypto'
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
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

test.describe.configure({ mode: 'serial' })

const MiB = 1024 * 1024
const DEFAULT_MB = 16
const MODERATOR_MB = 24
const FILE_BYTES = 18 * MiB
// Uploads: single-request object POSTs and TUS creation and PATCHes.
const STORAGE = (url: URL) => /\/storage\/v1\/(object\/message_media\/|upload\/resumable)/.test(url.pathname)

const admin = adminClient()
let staff: SpecUser
let moderator: SpecUser
let member: SpecUser
let raised: SpecUser
let server: SeededServer
const file = { name: 'site-backup.zip', mimeType: 'application/zip', buffer: randomBytes(FILE_BYTES) }

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

test.beforeAll(async () => {
  staff = await createUser(admin, 'ulsta')
  moderator = await createUser(admin, 'ulmod')
  member = await createUser(admin, 'ulmem')
  raised = await createUser(admin, 'ulrai')
  await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  await admin.from('profiles').update({ is_moderator: true }).eq('id', moderator.id)
  server = await seedServer(admin, staff, `Uploads ${staff.username}`)
  for (const user of [moderator, member, raised]) await addMember(admin, user, server.id)
})

test.afterAll(async () => {
  await admin.from('instance_config').update({ config_value: 50 })
    .in('config_key', ['upload_limit_user_mb', 'upload_limit_moderator_mb', 'upload_limit_admin_mb'])
  await admin.from('upload_limit_overrides').delete().in('profile_id', [member?.id, raised?.id].filter(Boolean))
  const { data: objects } = await admin.from('drive_files').select('path')
    .in('owner_id', [moderator?.id, member?.id, raised?.id].filter(Boolean)).eq('bucket', 'message_media')
  const paths = (objects ?? []).map((o) => o.path)
  if (paths.length) await admin.storage.from('message_media').remove(paths)
  for (const user of [staff, moderator, member, raised]) await deleteUser(admin, user)
})

const chip = (page: Page) => page.getByTestId('file-preview-item').filter({ hasText: file.name })

async function attach(page: Page, user: SpecUser): Promise<void> {
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await page.getByTestId('composer-file-input').setInputFiles(file)
}

test('an admin sets the tiers under the ceiling in Admin > Config > Uploads', async ({ page }) => {
  await signIn(page, staff)
  await page.goto('/admin?tab=config')
  await dismissAnnouncements(page)
  await page.locator('.config-tab-btn').filter({ hasText: 'Uploads' }).click()
  const section = page.getByTestId('upload-limits-admin')
  await expect(section.getByTestId('upload-limit-ceiling')).toHaveText('50 MB', { timeout: 15000 })
  await expect(section.getByTestId('upload-limit-user')).toHaveValue('50')

  await section.getByTestId('upload-limit-admin').fill('60')
  await expect(section).toContainText('Above the ceiling of 50 MB')
  await expect(section.getByTestId('upload-limits-save')).toBeDisabled()

  await section.getByTestId('upload-limit-user').fill(String(DEFAULT_MB))
  await section.getByTestId('upload-limit-moderator').fill(String(MODERATOR_MB))
  await section.getByTestId('upload-limit-admin').fill('50')
  await section.getByTestId('upload-limits-save').click()
  await expect(section.getByRole('status')).toHaveText('Saved')
  const { data } = await admin.from('instance_config').select('config_key, config_value')
    .in('config_key', ['upload_limit_user_mb', 'upload_limit_moderator_mb'])
  expect(Object.fromEntries((data ?? []).map((r) => [r.config_key, Number(r.config_value)])))
    .toEqual({ upload_limit_user_mb: DEFAULT_MB, upload_limit_moderator_mb: MODERATOR_MB })
})

test('a member\'s file over the default tier is refused before a byte is sent', async ({ page }) => {
  let storageRequests = 0
  await page.route(STORAGE, (route) => {
    storageRequests++
    return route.continue()
  })
  await attach(page, member)
  const refusal = `“${file.name}” is 18 MB, over your upload limit of ${DEFAULT_MB} MB.`
  await expect(chip(page).locator('.error-message')).toHaveText(refusal, { timeout: 15000 })
  const item = page.getByTestId('transfers-indicator').getByTestId('transfer-item').filter({ hasText: file.name })
  await expect(item).toHaveAttribute('data-status', 'error')
  await expect(item.locator('.transfers__error')).toHaveText(refusal)
  expect(storageRequests).toBe(0)
})

test('a moderator, whose tier is higher, uploads the same file', async ({ page }) => {
  test.setTimeout(120_000)
  await attach(page, moderator)
  await expect(chip(page)).toContainText('Uploaded', { timeout: 60000 })
})

test('an admin sets one member\'s limit in Admin > Users', async ({ page }) => {
  await signIn(page, staff)
  await page.goto('/admin?tab=users')
  await dismissAnnouncements(page)
  await page.getByPlaceholder('Search users…').fill(raised.username)
  const row = page.locator('.user-item').filter({ hasText: raised.displayName })
  await expect(row).toHaveCount(1, { timeout: 15000 })
  await row.getByTestId('user-upload-limit').click()
  const dialog = page.getByTestId('upload-limit-dialog')
  await expect(dialog.getByTestId('upload-limit-tier')).toHaveText(`Tier: account, ${DEFAULT_MB} MB`)
  await expect(dialog.getByTestId('upload-limit-use-tier')).toBeChecked()
  await dialog.getByTestId('upload-limit-custom').check()
  await dialog.getByTestId('upload-limit-custom-mb').fill('20')
  await page.getByTestId('upload-limit-save').click()
  await expect(dialog.getByTestId('upload-limit-effective')).toHaveText('Largest file now: 20 MB')
})

test('that member uploads the file; "Use the tier" returns them to the default', async ({ page }) => {
  test.setTimeout(120_000)
  await attach(page, raised)
  await expect(chip(page)).toContainText('Uploaded', { timeout: 60000 })

  const client = await userClient(staff)
  const { data, error } = await client.rpc('admin_set_upload_limit', { p_profile: raised.id, p_limit_bytes: null })
  expect(error).toBeNull()
  expect(data.effective_bytes).toBe(DEFAULT_MB * MiB)
  const own = await userClient(raised)
  expect((await own.rpc('get_my_upload_limit')).data).toBe(DEFAULT_MB * MiB)
})

test('storage refuses a member\'s file over the limit sent straight to its API', async () => {
  test.setTimeout(120_000)
  const client = await userClient(member)
  const owned = (path: string) => admin.from('drive_files').select('path, state').eq('path', path)

  await test.step('a single-request upload: refused once its bytes arrive, no object left', async () => {
    const path = `c/${server.generalChannelId}/${member.id}/${randomUUID()}.zip`
    const { error } = await client.storage.from('message_media').upload(path, file.buffer, { contentType: 'application/zip' })
    expect(error).toMatchObject({ statusCode: '403', message: 'new row violates row-level security policy' })
    const { data: listed } = await admin.storage.from('message_media').list(`c/${server.generalChannelId}/${member.id}`)
    expect((listed ?? []).map((o) => o.name)).not.toContain(path.split('/').pop())
    expect((await owned(path)).data).toEqual([])

    const small = `c/${server.generalChannelId}/${member.id}/${randomUUID()}.zip`
    const { error: smallError } = await client.storage.from('message_media').upload(small, randomBytes(64 * 1024), { contentType: 'application/zip' })
    expect(smallError).toBeNull()
  })

  await test.step('a resumable upload: refused when created, from the size it declares', async () => {
    const { data: { session } } = await client.auth.getSession()
    const create = (bytes: number, name: string) => fetch(`${env('E2E_SUPABASE_URL')}/storage/v1/upload/resumable`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session!.access_token}`,
        apikey: env('E2E_SUPABASE_ANON_KEY'),
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(bytes),
        'Upload-Metadata': [
          `bucketName ${Buffer.from('message_media').toString('base64')}`,
          `objectName ${Buffer.from(`c/${server.generalChannelId}/${member.id}/${name}`).toString('base64')}`,
          `contentType ${Buffer.from('application/zip').toString('base64')}`,
        ].join(','),
      },
    })
    const over = await create(FILE_BYTES, `${randomUUID()}.zip`)
    expect(over.status).toBe(403)
    expect(await over.text()).toBe('new row violates row-level security policy')

    const within = await create(DEFAULT_MB * MiB, `${randomUUID()}.zip`)
    expect(within.status).toBe(201)
    const id = (within.headers.get('location') ?? '').split('/').pop()
    await fetch(`${env('E2E_SUPABASE_URL')}/storage/v1/upload/resumable/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session!.access_token}`, apikey: env('E2E_SUPABASE_ANON_KEY'), 'Tus-Resumable': '1.0.0' },
    })
  })
})
