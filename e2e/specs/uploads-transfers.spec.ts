// Journey: files keep their names and uploads outlive the page that started them.
//
// A file sent in a channel downloads under the name it was sent with, not its object name
// (<uuid>.zip), unicode, spaces, quotes, & # + included; so does a Drive file. A single emoji
// upload shows its progress. An emoji upload started in server settings keeps going after the
// settings close, in the transfers indicator, and the emoji lands. A file over 6 MiB goes up
// through storage's resumable (tus) endpoint: its first PATCH is cut after half its bytes reach
// storage, and the upload resumes from the offset storage reports rather than from zero. Cut after
// 5.5 MiB, which S3 storage keeps as a short part R2 cannot complete, the upload is terminated and
// sent again from zero.

import { createHash, randomBytes } from 'node:crypto'
import { test, expect, type Download, type Page, type Route } from '@playwright/test'
import {
  adminClient,
  composer,
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
// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
const EMOJI_POST = '**/storage/v1/object/emojis/**'
const TUS = '**/storage/v1/upload/resumable**'
const MiB = 1024 * 1024

let owner: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  owner = await createUser(admin, 'xfer')
  server = await seedServer(admin, owner, `Transfers ${owner.username}`)
})

test.afterAll(async () => {
  const { data: rows } = await admin.from('emojis').select('url').eq('server_id', server?.id ?? '')
  await admin.from('emojis').delete().eq('server_id', server?.id ?? '')
  const paths = (rows ?? []).map((r) => r.url.split('/storage/v1/object/public/emojis/')[1]).filter(Boolean)
  if (paths.length) await admin.storage.from('emojis').remove(paths)
  await deleteUser(admin, owner)
})

const previews = (page: Page) => page.getByTestId('file-preview-item')

/** A silent 16-bit mono PCM WAV. */
function wav(seconds = 0.25, rate = 8000): Buffer {
  const data = Buffer.alloc(Math.round(seconds * rate) * 2)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

/**
 * The name Chrome saves `name` under: it replaces " * : < > ? \\ | with _ in every saved file
 * name, whatever the server sends.
 */
const savedAs = (name: string) => name.replace(/["*:<>?\\|]/g, '_')

/** The download a click starts, in this page or in a tab it opens. */
async function downloadOf(page: Page, click: () => Promise<void>): Promise<Download> {
  const inPage = page.waitForEvent('download', { timeout: 30000 })
  const inTab = page.context().waitForEvent('page', { timeout: 30000 }).then((tab) => tab.waitForEvent('download', { timeout: 30000 }))
  inTab.catch(() => {})
  inPage.catch(() => {})
  await click()
  return Promise.any([inPage, inTab])
}

async function sendAttachment(page: Page, file: { name: string; mimeType: string; buffer: Buffer }, text: string, uploadTimeout = 15000) {
  await page.getByTestId('composer-file-input').setInputFiles(file)
  await expect(previews(page).filter({ hasText: file.name })).toContainText('Uploaded', { timeout: uploadTimeout })
  await composer(page).click()
  await composer(page).pressSequentially(text, { delay: 10 })
  await page.keyboard.press('Enter')
  const posted = messageList(page).locator('.message-item').filter({ hasText: text }).last()
  await expect(posted).toBeVisible({ timeout: 30000 })
  await expect(posted).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
  return posted
}

test('files download under the names they were sent and kept with', async ({ page }) => {
  test.setTimeout(180_000)
  const name = `amogus ünï 'q' "x" & co #2 + 50%.zip`

  await test.step('a file sent in a channel', async () => {
    await signIn(page, owner)
    await openChannel(page, server.id, server.generalChannelId)
    const posted = await sendAttachment(page, { name, mimeType: 'application/zip', buffer: randomBytes(2048) }, `zip by ${owner.username}`)
    const link = posted.getByTestId('file-attachment-link').or(posted.locator('.file-attachment a.file-name'))
    await expect(link).toHaveText(name)
    const download = await downloadOf(page, () => link.click())
    expect(new URL(download.url()).searchParams.get('download')).toBe(name)
    expect(download.suggestedFilename()).toBe(savedAs(name))
  })

  await test.step('an audio file plays from its named URL, whose own Download keeps the name', async () => {
    const song = `song ünï & co.wav`
    await sendAttachment(page, { name: song, mimeType: 'audio/wav', buffer: wav() }, `wav by ${owner.username}`)
    // This client renders its own upload from a local copy until a reload.
    await page.reload()
    const audio = messageList(page).locator('.message-item').filter({ hasText: song }).last().locator('audio.content-audio')
    await expect(audio).toHaveAttribute('src', /[?&]download=/, { timeout: 30000 })
    expect(new URL((await audio.getAttribute('src'))!).searchParams.get('download')).toBe(song)
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.readyState), { timeout: 15000 }).toBeGreaterThan(0)
    expect(await audio.evaluate((el: HTMLAudioElement) => el.duration)).toBeGreaterThan(0)
  })

  await test.step('a file kept in Drive', async () => {
    const kept = 'notes & plans #2 + ünï.txt'
    await page.getByTestId('rail-drive').click()
    await expect(page).toHaveURL(/\/drive/)
    await dismissAnnouncements(page)
    await page.getByTestId('drive-file-input').setInputFiles({ name: kept, mimeType: 'text/plain', buffer: Buffer.from(`kept ${Date.now()}\n`) })
    const row = page.getByTestId('drive-items').getByTestId('drive-file').filter({ hasText: kept })
    await expect(row).toBeVisible({ timeout: 30000 })
    await row.click()
    const download = await downloadOf(page, () => page.getByTestId('drive-details').getByRole('button', { name: 'Download' }).click())
    expect(download.suggestedFilename()).toBe(kept)
  })
})

/** Holds POSTs of emoji objects until released. */
async function holdEmojiUploads(page: Page) {
  let release!: () => void
  const released = new Promise<void>((resolve) => { release = resolve })
  let held = 0
  await page.route(EMOJI_POST, async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    held++
    await released
    await route.fallback()
  })
  return { release: () => release(), held: () => held }
}

test('a single emoji upload shows its progress', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await page.goto(`/server/${server.id}?section=emoji`)
  const upload = page.getByTestId('emoji-upload-input')
  await expect(upload).toBeAttached({ timeout: 30000 })

  const gate = await holdEmojiUploads(page)
  await upload.setInputFiles({ name: 'wave.png', mimeType: 'image/png', buffer: PNG })
  await expect.poll(gate.held).toBe(1)

  const progress = page.locator('.emoji-library .upload-progress')
  await expect(progress).toBeVisible()
  await expect(progress).toContainText('wave.png')
  await expect(progress.getByRole('progressbar')).toHaveAttribute('aria-valuenow', /^\d+$/)

  gate.release()
  await expect(page.locator('.emoji-item').filter({ hasText: ':wave:' })).toBeVisible({ timeout: 20000 })
  await expect(progress).toBeHidden()
  await page.unroute(EMOJI_POST)
})

test('an upload keeps going after its page is left', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await page.goto(`/server/${server.id}?section=emoji`)
  const upload = page.getByTestId('emoji-upload-input')
  await expect(upload).toBeAttached({ timeout: 30000 })

  const gate = await holdEmojiUploads(page)
  await upload.setInputFiles({ name: 'party.png', mimeType: 'image/png', buffer: PNG })
  await expect.poll(gate.held).toBe(1)

  // Escape closes server settings into the server, in the same page.
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Escape')
  await expect(messageList(page)).toBeVisible({ timeout: 30000 })
  await expect(upload).toHaveCount(0)

  const indicator = page.getByTestId('transfers-indicator')
  const item = indicator.getByTestId('transfer-item').filter({ hasText: 'party.png' })
  await expect(item).toBeVisible({ timeout: 10000 })
  await expect(item).toHaveAttribute('data-status', 'running')
  await expect(indicator.getByRole('progressbar')).toBeVisible()

  gate.release()
  await expect(item).toHaveAttribute('data-status', 'completed', { timeout: 20000 })
  await expect
    .poll(async () => (await admin.from('emojis').select('name').eq('server_id', server.id).eq('name', 'party')).data?.length, { timeout: 20000 })
    .toBe(1)
  await page.unroute(EMOJI_POST)
})

test('a large upload resumes from where storage cut it off', async ({ page }) => {
  test.setTimeout(240_000)
  const size = 13 * MiB + 12345
  const bytes = randomBytes(size)
  const name = 'big video ünï.bin'
  const patches: Array<{ offset: number; bytes: number }> = []
  const heads: string[] = []
  let cut = false

  await page.route(TUS, async (route: Route) => {
    const request = route.request()
    if (request.method() === 'HEAD') heads.push(request.url())
    if (request.method() !== 'PATCH') return route.fallback()
    const body = request.postDataBuffer() ?? Buffer.alloc(0)
    patches.push({ offset: Number(request.headers()['upload-offset']), bytes: body.length })
    if (!cut) {
      cut = true
      // Half the chunk reaches storage, then the connection drops.
      const half = body.subarray(0, body.length / 2)
      const headers = { ...request.headers() }
      delete headers['content-length']
      await route.fetch({ postData: half, headers })
      return route.abort('connectionreset')
    }
    return route.fallback()
  })

  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const text = `big file by ${owner.username}`
  const posted = await sendAttachment(page, { name, mimeType: 'application/octet-stream', buffer: bytes }, text, 120_000)
  await expect(posted).toContainText(name)

  expect(cut).toBe(true)
  expect(heads.length).toBeGreaterThan(0)
  expect(patches).toEqual([
    { offset: 0, bytes: 6 * MiB },
    { offset: 3 * MiB, bytes: 3 * MiB },
    { offset: 6 * MiB, bytes: 6 * MiB },
    { offset: 12 * MiB, bytes: size - 12 * MiB },
  ])

  const { data } = await admin.from('messages').select('content').eq('channel_id', server.generalChannelId).eq('user_id', owner.id)
  const content = (data ?? []).map((row) => row.content as Array<{ type: string; text?: string; path?: string; fileName?: string }>)
    .find((parts) => JSON.stringify(parts).includes(text))
  const part = content?.find((p) => p.type === 'file')
  expect(part?.fileName).toBe(name)
  const stored = await admin.storage.from('message_media').download(part!.path!)
  expect(stored.error).toBeNull()
  const got = Buffer.from(await stored.data!.arrayBuffer())
  expect(got.length).toBe(size)
  expect(createHash('sha256').update(got).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'))
  // The tus upload carries the Drive metadata a one-request upload does.
  const { data: kept } = await admin.from('drive_files').select('name, size_bytes, sha256').eq('path', part!.path!)
  expect(kept?.[0]).toMatchObject({ name, size_bytes: size, sha256: createHash('sha256').update(bytes).digest('hex') })
  await page.unroute(TUS)
})

test('a large upload cut with a short part stored starts over', async ({ page }) => {
  test.setTimeout(240_000)
  const size = 13 * MiB + 777
  const bytes = randomBytes(size)
  const name = 'short part.bin'
  const patches: Array<{ id: string; offset: number; bytes: number }> = []
  const deleted: string[] = []
  let cut = false

  const idOf = (url: string) => new URL(url).pathname.split('/').pop() ?? ''
  await page.route(TUS, async (route: Route) => {
    const request = route.request()
    if (request.method() === 'DELETE') deleted.push(idOf(request.url()))
    if (request.method() !== 'PATCH') return route.fallback()
    const body = request.postDataBuffer() ?? Buffer.alloc(0)
    patches.push({ id: idOf(request.url()), offset: Number(request.headers()['upload-offset']), bytes: body.length })
    if (!cut) {
      cut = true
      // 5.5 MiB reach storage, then the connection drops.
      const headers = { ...request.headers() }
      delete headers['content-length']
      await route.fetch({ postData: body.subarray(0, 5.5 * MiB), headers })
      return route.abort('connectionreset')
    }
    return route.fallback()
  })

  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const text = `short part by ${owner.username}`
  const posted = await sendAttachment(page, { name, mimeType: 'application/octet-stream', buffer: bytes }, text, 120_000)
  await expect(posted).toContainText(name)

  const [first, second] = [patches[0].id, patches[1].id]
  expect(first).not.toBe(second)
  expect(patches).toEqual([
    { id: first, offset: 0, bytes: 6 * MiB },
    { id: second, offset: 0, bytes: 6 * MiB },
    { id: second, offset: 6 * MiB, bytes: 6 * MiB },
    { id: second, offset: 12 * MiB, bytes: size - 12 * MiB },
  ])
  await expect.poll(() => deleted).toEqual([first])

  const { data } = await admin.from('messages').select('content').eq('channel_id', server.generalChannelId).eq('user_id', owner.id)
  const content = (data ?? []).map((row) => row.content as Array<{ type: string; text?: string; path?: string; fileName?: string }>)
    .find((parts) => JSON.stringify(parts).includes(text))
  const part = content?.find((p) => p.type === 'file')
  const stored = await admin.storage.from('message_media').download(part!.path!)
  expect(stored.error).toBeNull()
  const got = Buffer.from(await stored.data!.arrayBuffer())
  expect(createHash('sha256').update(got).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'))
  await page.unroute(TUS)
})
