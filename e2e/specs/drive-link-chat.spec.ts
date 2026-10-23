// Journey: Drive links in chat render as attachments. An image link shows the picture inline, as
// an uploaded image does, with a Drive mark naming the file and Open in Drive; it opens in the
// media viewer. A member without access sees one "Restricted file" line naming nothing. A message
// that is only the link shows the file without the URL text, for /drive/file/<id> and /d/<token>
// alike; a file that is not media renders as the attachment file row. Pasting a link the channel
// cannot open offers, once, to share it; after Share another member sees the file, after Send
// anyway the file stays unshared.
//
// Drive files are uploaded through storage as their owner, which is what Drive's upload does.
// /d/ links come from drive_link_create, which answers a token on every schema.

import { randomUUID } from 'node:crypto'
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
  composer,
  createUser,
  deleteUser,
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

const admin = adminClient()
let owner: SpecUser
let recipient: SpecUser
let member: SpecUser
let server: SeededServer
let harborId: string
let ledgerId: string
let notesId: string
let agendaId: string
let minutesId: string

async function uploadDriveFile(user: SpecUser, name: string, mimeType: string, body: Buffer): Promise<string> {
  const client = await userClient(user)
  const ext = name.split('.').pop()
  const path = `u/${user.id}/${randomUUID()}.${ext}`
  const { error } = await client.storage.from('message_media').upload(path, body, { contentType: mimeType, metadata: { name } })
  if (error) throw new Error(`upload ${name}: ${error.message}`)
  const { data, error: rowError } = await admin.from('drive_files').select('id').eq('path', path).single()
  if (rowError || !data) throw new Error(`drive_files row of ${name}: ${rowError?.message}`)
  return data.id
}

test.beforeAll(async () => {
  test.setTimeout(120_000)
  owner = await createUser(admin, 'dco')
  recipient = await createUser(admin, 'dcr')
  member = await createUser(admin, 'dcm')
  server = await seedServer(admin, owner, `Drive chat ${owner.username}`)
  await addMember(admin, recipient, server.id)
  await addMember(admin, member, server.id)

  harborId = await uploadDriveFile(owner, 'harbor.png', 'image/png', PNG)
  ledgerId = await uploadDriveFile(owner, 'ledger.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n%%EOF\n'))
  notesId = await uploadDriveFile(owner, 'notes.txt', 'text/plain', Buffer.from('tide tables\n'))
  agendaId = await uploadDriveFile(owner, 'agenda.txt', 'text/plain', Buffer.from('1. ferry\n2. lunch\n'))
  minutesId = await uploadDriveFile(owner, 'minutes.txt', 'text/plain', Buffer.from('nothing decided\n'))

  const client = await userClient(owner)
  const { error } = await client.rpc('drive_share_file', { p_file: harborId, p_scope: 'user', p_target: recipient.id })
  if (error) throw new Error(`share harbor.png: ${error.message}`)
})

test.afterAll(async () => {
  for (const user of [member, recipient, owner]) await deleteUser(admin, user)
})

const fileLink = (page: Page, id: string) => `${new URL(page.url()).origin}/drive/file/${id}`
const tokenLink = (page: Page, token: string) => `${new URL(page.url()).origin}/d/${token}`

async function signedIn(browser: Browser, user: SpecUser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await signIn(page, user)
  return { context, page }
}

const message = (page: Page, text: string) =>
  messageList(page).locator('.message-item').filter({ hasText: text }).last()
const attachment = (page: Page, text: string) => message(page, text).getByTestId('drive-attachment')

/** Sends text that renders no text of its own: waits for the row holding `shown`. */
async function sendBare(page: Page, text: string, shown: string) {
  await composer(page).click()
  await composer(page).pressSequentially(text, { delay: 10 })
  await page.keyboard.press('Enter')
  const posted = message(page, shown)
  await expect(posted).toBeVisible({ timeout: 30000 })
  await expect(posted).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
  return posted
}

async function createLink(fileId: string): Promise<string> {
  const client = await userClient(owner)
  const { data, error } = await client.rpc('drive_link_create', { p_file: fileId })
  if (error) throw new Error(`drive_link_create: ${error.message}`)
  return (data as { token: string }).token
}

test('a Drive image renders inline like an attachment for a reader, restricted for one without access', async ({ browser }) => {
  test.setTimeout(180_000)
  let link = ''
  const { context, page } = await signedIn(browser, owner)
  try {
    await openChannel(page, server.id, server.generalChannelId)
    link = fileLink(page, harborId)
    await sendMessage(page, `harbor photo ${link}`)
    const shown = attachment(page, 'harbor photo')
    await expect(shown).toHaveAttribute('data-state', 'ready', { timeout: 30000 })
    await expect(shown).toHaveAttribute('data-kind', 'image')
    // Beside other words the link stays in the text.
    await expect(message(page, 'harbor photo').locator('a.url-link')).toHaveAttribute('href', link)
  } finally {
    await context.close()
  }

  await test.step('the recipient of the share sees the picture as an image attachment and opens it in the viewer', async () => {
    const { context: c, page: reader } = await signedIn(browser, recipient)
    try {
      await openChannel(reader, server.id, server.generalChannelId)
      const shown = attachment(reader, 'harbor photo')
      await expect(shown).toHaveAttribute('data-state', 'ready', { timeout: 30000 })
      await expect(shown).toHaveClass(/media-container/)
      await expect(shown.locator('.drive-card')).toHaveCount(0)
      const image = shown.locator('.media-frame img.content-image')
      await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), { timeout: 15000 }).toBe(1)

      const mark = shown.getByTestId('drive-attachment-mark')
      await expect(mark).toHaveAttribute('title', 'harbor.png')
      await expect(mark).toHaveCSS('opacity', '0')
      await shown.locator('.media-frame').hover()
      await expect(mark).toHaveCSS('opacity', '1')
      await expect(mark).toHaveText('Drive')

      await image.click()
      const viewer = reader.locator('.media-lightbox-overlay')
      await expect(viewer.locator('img.media-image')).toBeVisible()
      await reader.keyboard.press('Escape')
      await expect(viewer).toHaveCount(0)

      await shown.locator('.media-frame').hover()
      await shown.getByTestId('drive-attachment-open').click()
      await reader.waitForURL(new RegExp(`/drive/file/${harborId}$`), { timeout: 30000 })
    } finally {
      await c.close()
    }
  })

  await test.step('a member without access sees one restricted line naming nothing', async () => {
    const { context: c, page: other } = await signedIn(browser, member)
    try {
      await openChannel(other, server.id, server.generalChannelId)
      const shown = attachment(other, 'harbor photo')
      await expect(shown).toHaveAttribute('data-state', 'restricted', { timeout: 30000 })
      await expect(shown).toHaveText('Restricted file')
      await expect(shown.locator('img, a, button')).toHaveCount(0)
      const box = await shown.boundingBox()
      expect(box?.height ?? 0).toBeLessThan(40)
    } finally {
      await c.close()
    }
  })
})

test('a message that is only a Drive link shows the file without the URL, for either link form', async ({ browser }) => {
  test.setTimeout(180_000)
  const token = await createLink(notesId)
  const { context, page } = await signedIn(browser, owner)
  try {
    await openChannel(page, server.id, server.generalChannelId)

    await test.step('a /drive/file/ link of a file that is not media: the attachment file row, no URL text', async () => {
      const link = fileLink(page, ledgerId)
      const posted = await sendBare(page, link, 'ledger.pdf')
      const row = posted.getByTestId('drive-attachment')
      await expect(row).toHaveAttribute('data-kind', 'file')
      await expect(row).toHaveClass(/file-attachment/)
      await expect(row.getByTestId('drive-attachment-name')).toHaveText('ledger.pdf')
      await expect(row.locator('.file-size')).toHaveText('15 B')
      await expect(row.getByTestId('drive-attachment-download')).toBeVisible()
      await expect(posted.locator('a.url-link')).toHaveCount(0)
      expect(await posted.innerText()).not.toContain('/drive/file/')
    })

    await test.step('a /d/ link renders the same way', async () => {
      const posted = await sendBare(page, tokenLink(page, token), 'notes.txt')
      const row = posted.getByTestId('drive-attachment')
      await expect(row).toHaveAttribute('data-kind', 'file')
      await expect(row.getByTestId('drive-attachment-name')).toHaveText('notes.txt')
      await expect(posted.locator('a.url-link')).toHaveCount(0)
      expect(await posted.innerText()).not.toContain('/d/')
    })
  } finally {
    await context.close()
  }

  await test.step('another member sees the /d/ link file, and a restricted line for the unshared one', async () => {
    const { context: c, page: other } = await signedIn(browser, member)
    try {
      await openChannel(other, server.id, server.generalChannelId)
      const shared = message(other, 'notes.txt').getByTestId('drive-attachment')
      await expect(shared).toHaveAttribute('data-kind', 'file', { timeout: 30000 })
      await expect(shared.getByTestId('drive-attachment-name')).toHaveText('notes.txt')
      const restricted = messageList(other).locator('[data-testid="drive-attachment"][data-state="restricted"]')
      await expect(restricted.first()).toHaveText('Restricted file')
      expect(await messageList(other).innerText()).not.toContain('ledger')
    } finally {
      await c.close()
    }
  })
})

test('pasting a link the channel cannot open offers to share it with the channel', async ({ browser }) => {
  test.setTimeout(180_000)
  const { context, page } = await signedIn(browser, owner)
  try {
    await openChannel(page, server.id, server.generalChannelId)
    const paste = (text: string) => composer(page).evaluate((el, value) => {
      const data = new DataTransfer()
      data.setData('text/plain', value)
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, text)

    await test.step('the offer names the channel, and Share shares the file with it', async () => {
      await composer(page).click()
      await composer(page).pressSequentially('agenda for friday ', { delay: 10 })
      await paste(fileLink(page, agendaId))
      const offer = page.getByTestId('drive-share-offer')
      await expect(offer).toContainText("People in #general can't open this file", { timeout: 15000 })
      await offer.getByTestId('drive-share-offer-share').click()
      await expect(offer).toHaveCount(0)
      const { data: shares } = await admin.from('drive_shares').select('scope, target_id').eq('file_id', agendaId)
      expect(shares).toEqual([{ scope: 'channel', target_id: server.generalChannelId }])
      await composer(page).click()
      await page.keyboard.press('Enter')
      await expect(attachment(page, 'agenda for friday')).toHaveAttribute('data-state', 'ready', { timeout: 30000 })
    })

    await test.step('Send anyway leaves the file unshared, and the link is not offered again', async () => {
      await composer(page).click()
      await paste(fileLink(page, minutesId))
      const offer = page.getByTestId('drive-share-offer')
      await expect(offer).toBeVisible({ timeout: 15000 })
      await offer.getByTestId('drive-share-offer-dismiss').click()
      await expect(offer).toHaveCount(0)
      await paste(` ${fileLink(page, minutesId)}`)
      // The gap lookup answers within this window; no offer follows.
      await page.waitForTimeout(1500)
      await expect(offer).toHaveCount(0)
      const { data: shares } = await admin.from('drive_shares').select('id').eq('file_id', minutesId)
      expect(shares).toEqual([])
    })
  } finally {
    await context.close()
  }

  await test.step('another member of the channel sees the shared file as its file row', async () => {
    const { context: c, page: other } = await signedIn(browser, member)
    try {
      await openChannel(other, server.id, server.generalChannelId)
      const shown = attachment(other, 'agenda for friday')
      await expect(shown).toHaveAttribute('data-state', 'ready', { timeout: 30000 })
      await expect(shown).toHaveAttribute('data-kind', 'file')
      await expect(shown.getByTestId('drive-attachment-name')).toHaveText('agenda.txt')
    } finally {
      await c.close()
    }
  })
})
