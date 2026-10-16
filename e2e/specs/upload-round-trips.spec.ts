// Journey: what one composer attachment costs in backend requests, from attaching the file to
// the message turning from pending to sent. Every serial request is a round trip of 0.2-0.6 s
// for members far from the server.
//
// The upload's chain is the Drive hash lookup, the object POST and the signing of the part's
// compat URL. The bucket limits and the Drive probe are read when the composer mounts, so even
// the session's first attachment does not wait on them. get_my_drive_usage is the composer's
// usage meter, refreshed beside the upload and after it; the upload never waits on it.

import { test, expect, type Page, type Request } from '@playwright/test'
import {
  adminClient,
  composer,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  sendMessage,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  owner = await createUser(admin, 'upro')
  server = await seedServer(admin, owner, `Upload trips ${owner.username}`)
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
})

interface Logged {
  at: number
  method: string
  url: string
}

function recordBackendRequests(page: Page): Logged[] {
  const log: Logged[] = []
  page.on('request', (request: Request) => {
    const url = request.url()
    if (!url.includes('/rest/v1/') && !url.includes('/storage/v1/')) return
    log.push({ at: Date.now(), method: request.method(), url: decodeURIComponent(url) })
  })
  return log
}

function describe(requests: Logged[]): string {
  return requests.map((r) => `${r.method} ${r.url.replace(/^https?:\/\/[^/]+/, '')}`).join('\n')
}

/** A distinct text file: Drive holds no file with its SHA-256. */
const freshFile = (name: string) => ({
  name,
  mimeType: 'text/plain',
  buffer: Buffer.from(`${name} ${Date.now()} ${Math.random()}\n`),
})

const preview = (page: Page, name: string) => page.getByTestId('file-preview-item').filter({ hasText: name })

async function attachAndSend(page: Page, log: Logged[], name: string, text: string) {
  const attachedAt = Date.now()
  await page.getByTestId('composer-file-input').setInputFiles(freshFile(name))
  await expect(preview(page, name)).toContainText('Uploaded', { timeout: 15000 })
  const uploadedAt = Date.now()
  await composer(page).click()
  await composer(page).pressSequentially(text, { delay: 10 })
  const sentAt = Date.now()
  await page.keyboard.press('Enter')
  const posted = messageList(page).locator('.message-item').filter({ hasText: text }).last()
  await expect(posted).toBeVisible({ timeout: 30000 })
  await expect(posted).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
  await expect(posted).toContainText(name)
  return {
    upload: log.filter((r) => r.at >= attachedAt && r.at < uploadedAt),
    send: log.filter((r) => r.at >= sentAt),
  }
}

const isUsageMeter = (r: Logged) => r.url.includes('/rpc/get_my_drive_usage')
// The list's read marker for the row just shown; not on the upload or send path.
const isReadMarker = (r: Logged) => /\/rpc\/mark_(channel|conversation)_as_read/.test(r.url)
const isObjectPost = (r: Logged) => r.method === 'POST' && /\/storage\/v1\/object\/message_media\//.test(r.url)
const isSign = (r: Logged) => r.method === 'POST' && r.url.includes('/storage/v1/object/sign/message_media/')
const isMessageInsert = (r: Logged) => r.method === 'POST' && /\/rest\/v1\/messages(\?|$)/.test(r.url)

function expectUploadChain(upload: Logged[]) {
  const chain = upload.filter((r) => !isUsageMeter(r) && !isReadMarker(r))
  expect(chain.map((r) => isObjectPost(r) ? 'upload' : isSign(r) ? 'sign' : r.url.replace(/^.*\/v1\//, '')),
    describe(upload)).toEqual(['rpc/drive_find_by_hash', 'upload', 'sign'])
}

function expectSendIsTheInsert(send: Logged[]) {
  const inserts = send.filter(isMessageInsert)
  expect(inserts, describe(send)).toHaveLength(1)
  expect(send.slice(0, send.indexOf(inserts[0])).filter((r) => !isReadMarker(r)), describe(send)).toEqual([])
}

test('an attachment uploads and sends with the fewest serial requests', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await sendMessage(page, `warm-up ${owner.username}`)
  const log = recordBackendRequests(page)

  await test.step('the session\'s first attachment', async () => {
    const first = await attachAndSend(page, log, 'first.txt', `first file ${owner.username}`)
    console.log(`first attachment upload:\n${describe(first.upload)}\nfirst attachment send:\n${describe(first.send)}`)
    expectUploadChain(first.upload)
    expectSendIsTheInsert(first.send)
  })

  await test.step('a later attachment', async () => {
    const second = await attachAndSend(page, log, 'second.txt', `second file ${owner.username}`)
    console.log(`second attachment upload:\n${describe(second.upload)}\nsecond attachment send:\n${describe(second.send)}`)
    expectUploadChain(second.upload)
    expectSendIsTheInsert(second.send)
  })
})

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

test('a private image signed once is not signed again after a reload', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const text = `photo ${owner.username}`

  await page.getByTestId('composer-file-input').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: PNG })
  await expect(preview(page, 'photo.png')).toContainText('Uploaded', { timeout: 15000 })
  await composer(page).click()
  await composer(page).pressSequentially(text, { delay: 10 })
  await page.keyboard.press('Enter')
  const row = messageList(page).locator('.message-item').filter({ hasText: text }).last()
  await expect(row).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
  // The local preview gives way to the signed thumbnail once it loaded.
  await expect(row.locator('img[src*="/storage/v1/"]').first()).toBeVisible({ timeout: 30000 })
  const objectPath = decodeURIComponent((await row.locator('img[src*="/storage/v1/"]').first().getAttribute('src'))!)
    .replace(/^.*\/message_media\//, '').replace(/\?.*$/, '')
  // Signed URLs are written to storage 2 s after the last signing.
  await page.waitForTimeout(2500)

  const log = recordBackendRequests(page)
  await page.reload()
  const after = messageList(page).locator('.message-item').filter({ hasText: text }).last()
  await expect(after.locator('img[src*="/storage/v1/"]').first()).toBeVisible({ timeout: 30000 })
  const signs = log.filter((r) => r.url.includes('/object/sign/') && r.url.includes(objectPath))
  expect(signs, describe(log)).toEqual([])
})
