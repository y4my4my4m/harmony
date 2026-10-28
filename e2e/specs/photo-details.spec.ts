// Journey: photo and video metadata is removed on the device before upload unless the sender
// keeps it (src/utils/stripMetadata.ts).
//
//   strip     a JPEG carrying GPS sent in a channel shows "Location removed"; the stored object
//             has no Exif GPS, XMP, IPTC or trailer, and keeps its orientation
//   keep      "Keep photo details" checked shows "Includes location"; the stored object is the
//             picked file byte for byte
//   default   "Keep photo details by default" in Privacy is stored per account and checks the box
//             for the next photo, in a browser that never saw the switch
//   avatar    an animated avatar, which skips the crop and was stored as picked, loses its Exif
//             and XMP and keeps its frames
//   encrypted a photo in an encrypted conversation: the row is ciphertext, the object it names
//             has no GPS
//   drive     Drive lists the picked photos with details before uploading, one box each
//   post      a post's photos are uploaded on publish, each as its box says
//
// Fixture: tests/fixtures/media-metadata (gps-rotated.jpg: 32×16, orientation 6, Exif GPS,
// make HarmonyCam, XMP GPS, IPTC City, COM, MPF, bytes after EOI; anim.webp: two frames, EXIF
// GPS and XMP).

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  composer,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  signIn,
  type SpecUser,
} from './harness'
import { setUpEncryption } from './encryption'

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures/media-metadata')
const PHOTO = readFileSync(path.join(FIXTURES, 'gps-rotated.jpg'))
const ANIMATED = readFileSync(path.join(FIXTURES, 'anim.webp'))

const KEEP = 'Keep photo details (location, camera)'
/** A finished upload: new bytes, or the same bytes found in the sender's Drive. */
const UPLOADED = /Uploaded|In your Drive/

const admin = adminClient()
const users: SpecUser[] = []
const conversations: string[] = []

async function user(tag: string): Promise<SpecUser> {
  const created = await createUser(admin, tag)
  users.push(created)
  return created
}

test.afterAll(async () => {
  for (const id of conversations) await admin.from('conversations').delete().eq('id', id)
  for (const u of users) {
    await admin.from('photo_details_settings').delete().eq('user_id', u.id)
    await deleteUser(admin, u)
  }
})

/** Metadata strings the fixtures carry. */
function markers(bytes: Buffer): string[] {
  const text = bytes.toString('latin1')
  return ['HarmonyCam', 'Fixture 1', 'GPSLatitude', 'Tokyo', 'fixture comment', 'TRAILER'].filter((m) => text.includes(m))
}

/** Exif APP1 segments of a JPEG ahead of SOS, each as [IFD0 Orientation, GPS IFD with lat/long]. */
function jpegExif(b: Buffer): Array<{ orientation: number; gps: boolean }> {
  const found: Array<{ orientation: number; gps: boolean }> = []
  let p = 2
  while (p + 4 <= b.length && b[p] === 0xff && b[p + 1] !== 0xda) {
    const end = p + 2 + b.readUInt16BE(p + 2)
    if (b[p + 1] === 0xe1 && b.toString('latin1', p + 4, p + 10) === 'Exif\0\0') {
      const t = p + 10
      const le = b.toString('latin1', t, t + 2) === 'II'
      const u16 = (o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o))
      const u32 = (o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o))
      const entries = (ifd: number) => Array.from({ length: u16(ifd) }, (_, i) => ifd + 2 + i * 12)
      let orientation = 1
      let gps = false
      for (const e of entries(t + u32(t + 4))) {
        if (u16(e) === 0x0112) orientation = u16(e + 8)
        if (u16(e) === 0x8825) gps = entries(t + u32(e + 8)).some((g) => u16(g) === 2 || u16(g) === 4)
      }
      found.push({ orientation, gps })
    }
    p = end
  }
  return found
}

const preview = (page: Page) => page.getByTestId('file-preview-item').filter({ hasText: 'IMG_0420.jpg' })
const chip = (page: Page) => preview(page).getByTestId('photo-location-chip')
const keepBox = (page: Page) => preview(page).getByRole('checkbox', { name: KEEP })

async function attachPhoto(page: Page) {
  await page.getByTestId('composer-file-input').setInputFiles({ name: 'IMG_0420.jpg', mimeType: 'image/jpeg', buffer: PHOTO })
  await expect(chip(page)).toBeVisible({ timeout: 15000 })
}

async function sendAttached(page: Page, text: string) {
  await expect(preview(page)).toContainText(UPLOADED, { timeout: 30000 })
  await composer(page).click()
  await composer(page).pressSequentially(text, { delay: 10 })
  await page.keyboard.press('Enter')
  const posted = messageList(page).locator('.message-item').filter({ hasText: text }).last()
  await expect(posted).toBeVisible({ timeout: 30000 })
  await expect(posted).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
}

/** The message_media object the latest message of the room names, as stored. */
async function storedObject(room: { channel_id: string } | { conversation_id: string }) {
  const [column, id] = Object.entries(room)[0]
  const { data: row, error } = await admin
    .from('messages')
    .select('content, media_paths, encrypted')
    .eq(column, id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()
  if (error || !row) throw new Error(`message: ${error?.message}`)
  const objectPath: string = row.encrypted
    ? row.media_paths[0]
    : (row.content as Array<{ type: string; path?: string }>).find((part) => part.type === 'file')!.path!
  const { data: blob, error: downloadError } = await admin.storage.from('message_media').download(objectPath)
  if (downloadError || !blob) throw new Error(`download ${objectPath}: ${downloadError?.message}`)
  return { row, path: objectPath, bytes: Buffer.from(await blob.arrayBuffer()) }
}

function expectStripped(bytes: Buffer) {
  expect(markers(bytes)).toEqual([])
  expect(jpegExif(bytes)).toEqual([{ orientation: 6, gps: false }])
  expect(bytes.subarray(0, 2).toString('hex')).toBe('ffd8')
  expect(bytes.subarray(-2).toString('hex')).toBe('ffd9')
  expect(bytes.length).toBeLessThan(PHOTO.length)
}

test.describe('chat attachments', () => {
  test.beforeAll(() => {
    expect(markers(PHOTO).length).toBe(6)
    expect(jpegExif(PHOTO)).toEqual([{ orientation: 6, gps: true }])
  })

  test('a photo with GPS goes up without its location and camera details', async ({ page }) => {
    test.setTimeout(120_000)
    const owner = await user('phd')
    const server = await seedServer(admin, owner, `Photo details ${owner.username}`)
    await signIn(page, owner)
    await openChannel(page, server.id, server.generalChannelId)
    await attachPhoto(page)
    await expect(chip(page)).toHaveText('Location removed')
    await expect(keepBox(page)).not.toBeChecked()
    await sendAttached(page, `stripped ${owner.username}`)

    const stored = await storedObject({ channel_id: server.generalChannelId })
    expectStripped(stored.bytes)
  })

  test('Keep photo details sends the photo as picked', async ({ page }) => {
    test.setTimeout(120_000)
    const owner = await user('phk')
    const server = await seedServer(admin, owner, `Photo kept ${owner.username}`)
    await signIn(page, owner)
    await openChannel(page, server.id, server.generalChannelId)
    await attachPhoto(page)
    await expect(preview(page)).toContainText(UPLOADED, { timeout: 30000 })
    await keepBox(page).focus()
    await page.keyboard.press('Space')
    await expect(keepBox(page)).toBeChecked()
    await expect(chip(page)).toHaveText('Includes location')
    await sendAttached(page, `kept ${owner.username}`)

    const stored = await storedObject({ channel_id: server.generalChannelId })
    expect(stored.bytes.equals(PHOTO)).toBe(true)
    expect(jpegExif(stored.bytes)).toEqual([{ orientation: 6, gps: true }])
    // The stripped upload made before the box was checked is deleted.
    const folder = stored.path.slice(0, stored.path.lastIndexOf('/'))
    await expect.poll(async () => (await admin.storage.from('message_media').list(folder)).data?.map((o) => `${folder}/${o.name}`))
      .toEqual([stored.path])
  })
})

test('Keep photo details by default is stored per account and starts the box checked', async ({ browser }) => {
  test.setTimeout(180_000)
  const keeper = await user('phs')
  const server = await seedServer(admin, keeper, `Photo default ${keeper.username}`)

  const first = await browser.newContext()
  const settingsPage = await first.newPage()
  await test.step('Privacy: turn on Keep photo details by default', async () => {
    await signIn(settingsPage, keeper)
    await settingsPage.goto('/settings/privacy')
    const toggle = settingsPage.getByRole('switch', { name: 'Keep photo details by default' })
    await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 30000 })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect.poll(async () => (await admin.from('photo_details_settings').select('keep_by_default').eq('user_id', keeper.id).maybeSingle()).data?.keep_by_default ?? null)
      .toBe(true)
  })
  await first.close()

  const second = await browser.newContext()
  const page = await second.newPage()
  await test.step('another browser: the next photo starts with its details kept', async () => {
    await signIn(page, keeper)
    await openChannel(page, server.id, server.generalChannelId)
    await attachPhoto(page)
    await expect(keepBox(page)).toBeChecked()
    await expect(chip(page)).toHaveText('Includes location')
    await sendAttached(page, `kept by default ${keeper.username}`)
    const stored = await storedObject({ channel_id: server.generalChannelId })
    expect(stored.bytes.equals(PHOTO)).toBe(true)
  })
  await second.close()
})

test('an animated avatar is stored without its metadata', async ({ page }) => {
  test.setTimeout(120_000)
  const owner = await user('pha')
  expect(markers(ANIMATED)).toEqual(expect.arrayContaining(['HarmonyCam', 'GPSLatitude']))
  const { data: before } = await admin.from('profiles').select('avatar_url').eq('id', owner.id).single()

  await signIn(page, owner)
  await page.goto('/settings/account')
  await page.locator('.user-account-settings .avatar-wrapper input[type="file"]').setInputFiles({
    name: 'loop.webp', mimeType: 'image/webp', buffer: ANIMATED,
  })
  await expect(page.getByTestId('crop-animated-note')).toBeVisible({ timeout: 15000 })
  await page.getByTestId('crop-apply').click()
  await expect(page.getByText('Avatar updated')).toBeVisible({ timeout: 30000 })
  let url = ''
  await expect.poll(async () => {
    url = (await admin.from('profiles').select('avatar_url').eq('id', owner.id).single()).data?.avatar_url ?? ''
    return url
  }).not.toBe(before?.avatar_url ?? '')

  // profiles.avatar_url holds the path inside the avatars bucket (avatarUtils normalizeAvatarForStorage).
  const objectPath = url.replace(/^.*\/storage\/v1\/object\/public\/avatars\//, '')
  const { data: blob, error } = await admin.storage.from('avatars').download(decodeURIComponent(objectPath))
  if (error || !blob) throw new Error(`avatar: ${error?.message}`)
  const stored = Buffer.from(await blob.arrayBuffer())
  expect(markers(stored)).toEqual([])
  const text = stored.toString('latin1')
  expect(text).not.toContain('EXIF')
  expect(text).not.toContain('XMP ')
  expect(text.split('ANMF').length - 1).toBe(2)
  expect(stored.readUInt32LE(4)).toBe(stored.length - 8)
})

test('a photo in an encrypted conversation is stripped before it is stored', async ({ page }) => {
  test.setTimeout(150_000)
  const sender = await user('phe')
  const partner = await user('php')
  const { data, error } = await admin.from('conversations').insert({ type: 'direct', created_by: sender.id }).select('id').single()
  if (error || !data) throw new Error(`conversation: ${error?.message}`)
  const conversationId = data.id as string
  conversations.push(conversationId)
  await admin.from('conversation_participants').insert([
    { conversation_id: conversationId, user_id: sender.id },
    { conversation_id: conversationId, user_id: partner.id },
  ])
  const { error: encError } = await admin.from('conversation_encryption_settings')
    .insert({ conversation_id: conversationId, encryption_enabled: true })
  if (encError) throw new Error(`conversation encryption: ${encError.message}`)

  await signIn(page, sender)
  await page.goto(`/dm/${conversationId}`)
  await expect(messageList(page)).toBeVisible({ timeout: 30000 })
  await setUpEncryption(page, sender)
  await attachPhoto(page)
  await expect(chip(page)).toHaveText('Location removed')
  const text = `encrypted photo ${sender.username}`
  await sendAttached(page, text)

  const stored = await storedObject({ conversation_id: conversationId })
  expect(stored.row.encrypted).toBe(true)
  expect(JSON.stringify(stored.row.content)).not.toContain(text)
  expect(stored.row.media_paths).toEqual([stored.path])
  expectStripped(stored.bytes)
})

test('Drive asks before uploading photos with details; each keeps or loses them on its own', async ({ page }) => {
  test.setTimeout(150_000)
  const owner = await user('phv')
  await signIn(page, owner)
  await page.getByTestId('rail-drive').click()
  await expect(page.getByTestId('drive-view')).toBeVisible({ timeout: 30000 })

  await page.getByTestId('drive-file-input').setInputFiles([
    { name: 'IMG_A.jpg', mimeType: 'image/jpeg', buffer: PHOTO },
    { name: 'IMG_B.jpg', mimeType: 'image/jpeg', buffer: PHOTO },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') },
  ])
  const dialog = page.getByRole('dialog', { name: 'Photo and video details' })
  await expect(dialog).toBeVisible({ timeout: 15000 })
  const rows = dialog.getByRole('listitem')
  await expect(rows).toHaveCount(2)
  await expect(rows.filter({ hasText: 'notes.txt' })).toHaveCount(0)
  const b = rows.filter({ hasText: 'IMG_B.jpg' })
  await expect(rows.filter({ hasText: 'IMG_A.jpg' }).getByTestId('photo-location-chip')).toHaveText('Location removed')
  await b.getByRole('checkbox', { name: KEEP }).check()
  await expect(b.getByTestId('photo-location-chip')).toHaveText('Includes location')
  await dialog.getByRole('button', { name: 'Upload' }).click()
  await expect(dialog).toBeHidden()

  for (const name of ['IMG_A.jpg', 'IMG_B.jpg', 'notes.txt']) {
    await expect(page.getByTestId('drive-file').filter({ hasText: name })).toBeVisible({ timeout: 30000 })
  }
  const stored = async (name: string) => {
    const { data } = await admin.from('drive_files').select('path').eq('owner_id', owner.id).eq('name', name).single()
    const { data: blob, error } = await admin.storage.from('message_media').download(data!.path)
    if (error || !blob) throw new Error(`download ${name}: ${error?.message}`)
    return Buffer.from(await blob.arrayBuffer())
  }
  expectStripped(await stored('IMG_A.jpg'))
  expect((await stored('IMG_B.jpg')).equals(PHOTO)).toBe(true)
  expect((await stored('notes.txt')).toString()).toBe('notes')
})

test('a post keeps or drops each photo\'s details as its box says', async ({ page }) => {
  test.setTimeout(150_000)
  const author = await user('pho')
  await signIn(page, author)
  await page.goto('/social/home')
  await page.getByRole('button', { name: 'New post' }).click()
  const dialog = page.getByRole('dialog', { name: 'Create a post' })
  await expect(dialog).toBeVisible({ timeout: 15000 })
  await dialog.locator('.rich-text-editor').click()
  await page.keyboard.type(`photos ${author.username}`)
  await dialog.locator('input[type="file"][accept="image/*,video/*"]').setInputFiles([
    { name: 'IMG_A.jpg', mimeType: 'image/jpeg', buffer: PHOTO },
    { name: 'IMG_B.jpg', mimeType: 'image/jpeg', buffer: PHOTO },
  ])
  const item = (name: string) => dialog.locator('.media-preview-item').filter({ hasText: name })
  await expect(item('IMG_A.jpg').getByTestId('photo-location-chip')).toHaveText('Location removed', { timeout: 15000 })
  await expect(item('IMG_B.jpg').getByRole('checkbox', { name: KEEP })).not.toBeChecked()
  await item('IMG_B.jpg').getByRole('checkbox', { name: KEEP }).check()
  await expect(item('IMG_B.jpg').getByTestId('photo-location-chip')).toHaveText('Includes location')
  await dialog.getByTestId('compose-submit').click()
  await expect(dialog).toBeHidden({ timeout: 30000 })

  let media: Array<{ url: string; name?: string }> = []
  await expect.poll(async () => {
    const { data } = await admin.from('posts').select('media_attachments').eq('author_id', author.id).maybeSingle()
    media = (data?.media_attachments as typeof media | null) ?? []
    return media.length
  }, { timeout: 15000 }).toBe(2)
  const stored = async (name: string) => {
    const url = media.find((m) => m.name === name)!.url
    const objectPath = url.replace(/^.*\/storage\/v1\/object\/public\/user_media\//, '')
    const { data: blob, error } = await admin.storage.from('user_media').download(objectPath)
    if (error || !blob) throw new Error(`download ${name}: ${error?.message}`)
    return Buffer.from(await blob.arrayBuffer())
  }
  expectStripped(await stored('IMG_A.jpg'))
  expect((await stored('IMG_B.jpg')).equals(PHOTO)).toBe(true)
})
