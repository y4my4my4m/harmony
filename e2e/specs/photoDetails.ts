// Shared steps and byte checks of the photo-details journeys (photo-details*.spec.ts).
//
// Fixture: tests/fixtures/media-metadata (gps-rotated.jpg: 32×16, orientation 6, Exif GPS,
// make HarmonyCam, XMP GPS, IPTC City, COM, MPF, bytes after EOI; anim.webp: two frames, EXIF
// GPS and XMP).

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Page } from '@playwright/test'
import { adminClient, composer, messageList } from './harness'

const admin = adminClient()

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures/media-metadata')
export const PHOTO = readFileSync(path.join(FIXTURES, 'gps-rotated.jpg'))
export const ANIMATED = readFileSync(path.join(FIXTURES, 'anim.webp'))

export const KEEP = 'Keep photo details (location, camera)'
/** An attachment ready to send: new bytes, the same bytes found in Drive, or a Drive file sent as is. */
export const UPLOADED = /Uploaded|In your Drive|From Drive/

/** Metadata strings the fixtures carry. */
export function markers(bytes: Buffer): string[] {
  const text = bytes.toString('latin1')
  return ['HarmonyCam', 'Fixture 1', 'GPSLatitude', 'Tokyo', 'fixture comment', 'TRAILER'].filter((m) => text.includes(m))
}

/** Exif APP1 segments of a JPEG ahead of SOS, each as [IFD0 Orientation, GPS IFD with lat/long]. */
export function jpegExif(b: Buffer): Array<{ orientation: number; gps: boolean }> {
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

export const preview = (page: Page) => page.getByTestId('file-preview-item').filter({ hasText: 'IMG_0420.jpg' })
export const chip = (page: Page) => preview(page).getByTestId('photo-location-chip')
export const keepBox = (page: Page) => preview(page).getByRole('checkbox', { name: KEEP })

export async function attachPhoto(page: Page) {
  await page.getByTestId('composer-file-input').setInputFiles({ name: 'IMG_0420.jpg', mimeType: 'image/jpeg', buffer: PHOTO })
  await expect(chip(page)).toBeVisible({ timeout: 15000 })
}

/** Sends the composer's attachments with `text` once the attachment `name` is uploaded. */
export async function sendAttached(page: Page, text: string, name = 'IMG_0420.jpg') {
  await expect(page.getByTestId('file-preview-item').filter({ hasText: name })).toContainText(UPLOADED, { timeout: 30000 })
  await composer(page).click()
  await composer(page).pressSequentially(text, { delay: 10 })
  await page.keyboard.press('Enter')
  const posted = messageList(page).locator('.message-item').filter({ hasText: text }).last()
  await expect(posted).toBeVisible({ timeout: 30000 })
  await expect(posted).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
}

/** The message_media object the latest message of the room names, as stored. */
export async function storedObject(room: { channel_id: string } | { conversation_id: string }) {
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

export function expectStripped(bytes: Buffer) {
  expect(markers(bytes)).toEqual([])
  expect(jpegExif(bytes)).toEqual([{ orientation: 6, gps: false }])
  expect(bytes.subarray(0, 2).toString('hex')).toBe('ffd8')
  expect(bytes.subarray(-2).toString('hex')).toBe('ffd9')
  expect(bytes.length).toBeLessThan(PHOTO.length)
}
