// Journey: Drive file links. Copy link gives /drive/file/<id>; it opens, through sign-in, for
// the recipient of a people share and shows a stranger a no-access page naming nothing. A link
// in a channel renders the file's card for a reader with access and a restricted card for one
// without; a /d/<token> link renders a card for anyone, and its link-preview page names the file
// until the link is revoked. Pasting a link of one's own file that the channel cannot open
// offers, once, to share it; after Share another member sees the card, after Send anyway the
// file stays unshared.
//
// Drive files are uploaded through storage as their owner, which is what Drive's upload does.

import { randomUUID } from 'node:crypto'
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { startBackend, type Backend } from './backend'
import {
  addMember,
  adminClient,
  composer,
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

const admin = adminClient()
let owner: SpecUser
let recipient: SpecUser
let member: SpecUser
let stranger: SpecUser
let server: SeededServer
let harborId: string
let lighthouseId: string
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
  owner = await createUser(admin, 'dlo')
  recipient = await createUser(admin, 'dlr')
  member = await createUser(admin, 'dlm')
  stranger = await createUser(admin, 'dls')
  server = await seedServer(admin, owner, `Drive links ${owner.username}`)
  await addMember(admin, recipient, server.id)
  await addMember(admin, member, server.id)

  harborId = await uploadDriveFile(owner, 'harbor.png', 'image/png', PNG)
  lighthouseId = await uploadDriveFile(owner, 'lighthouse.png', 'image/png', PNG)
  agendaId = await uploadDriveFile(owner, 'agenda.txt', 'text/plain', Buffer.from('1. ferry\n2. lunch\n'))
  minutesId = await uploadDriveFile(owner, 'minutes.txt', 'text/plain', Buffer.from('nothing decided\n'))

  const client = await userClient(owner)
  const { error } = await client.rpc('drive_share_file', { p_file: harborId, p_scope: 'user', p_target: recipient.id })
  if (error) throw new Error(`share harbor.png: ${error.message}`)
})

test.afterAll(async () => {
  for (const user of [stranger, member, recipient, owner]) await deleteUser(admin, user)
})

const fileLink = (page: Page, id: string) => `${new URL(page.url()).origin}/drive/file/${id}`

async function signedIn(browser: Browser, user: SpecUser, options: Parameters<Browser['newContext']>[0] = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(options)
  const page = await context.newPage()
  await signIn(page, user)
  return { context, page }
}

const card = (page: Page, text: string) =>
  messageList(page).locator('.message-item').filter({ hasText: text }).getByTestId('drive-card')

test('Copy link opens the file for a share recipient, through sign-in', async ({ browser }) => {
  test.setTimeout(180_000)
  const { context, page } = await signedIn(browser, owner, { permissions: ['clipboard-read', 'clipboard-write'] })
  let link = ''
  try {
    await test.step('the file menu copies the in-app address', async () => {
      await page.getByTestId('rail-drive').click()
      await dismissAnnouncements(page)
      await page.getByTestId('drive-layout-list').click()
      const row = page.getByTestId('drive-items').getByTestId('drive-file').filter({ hasText: 'harbor.png' })
      await expect(row).toBeVisible({ timeout: 30000 })
      await row.click({ button: 'right' })
      await page.getByTestId('drive-menu-copy-link').click()
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(fileLink(page, harborId))
      link = await page.evaluate(() => navigator.clipboard.readText())
    })

    await test.step('the details panel opens the image in the lightbox and copies the same address', async () => {
      await page.getByTestId('drive-items').getByTestId('drive-file').filter({ hasText: 'harbor.png' }).click()
      await page.getByTestId('drive-details-open-media').click()
      const lightbox = page.locator('.media-lightbox-overlay')
      await expect(lightbox.locator('img.media-image')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(lightbox).toHaveCount(0)
      await page.evaluate(() => navigator.clipboard.writeText(''))
      await page.getByTestId('drive-details-copy-link').click()
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(link)
    })

    await test.step('the full-window preview hands the image to the lightbox', async () => {
      await page.getByTestId('drive-items').getByTestId('drive-file').filter({ hasText: 'harbor.png' }).dblclick()
      const preview = page.getByTestId('drive-preview')
      await expect(preview).toBeVisible()
      await preview.getByTestId('drive-preview-lightbox').click()
      await expect(page.locator('.media-lightbox-overlay img.media-image')).toBeVisible()
      await expect(preview).toBeHidden()
      await page.keyboard.press('Escape')
      await expect(page.locator('.media-lightbox-overlay')).toHaveCount(0)
      await expect(preview).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(preview).toHaveCount(0)
    })

    await test.step('the share dialog shows the address for people with access apart from the public link', async () => {
      await page.getByTestId('drive-share-open').click()
      const dialog = page.getByTestId('drive-share-dialog')
      await expect(dialog.getByTestId('drive-file-link-url')).toHaveValue(link)
      await expect(dialog.getByTestId('drive-share-access-link')).toContainText('Link for people with access')
      await expect(dialog.getByTestId('drive-link-url')).toHaveCount(0)
    })
  } finally {
    await context.close()
  }

  await test.step('the recipient, signed out, signs in and lands on the file', async () => {
    const reader = await browser.newContext()
    try {
      const page2 = await reader.newPage()
      await page2.goto(new URL(link).pathname)
      await expect(page2).toHaveURL(/\/login/, { timeout: 30000 })
      await page2.locator('[data-testid="auth-email"]').fill(recipient.email)
      await page2.locator('[data-testid="auth-password"]').fill(recipient.password)
      await page2.locator('[data-testid="auth-submit"]').click()
      await page2.waitForURL(new RegExp(`/drive/file/${harborId}$`), { timeout: 30000 })
      await dismissAnnouncements(page2)
      await expect(page2.getByTestId('drive-file-name')).toHaveText('harbor.png', { timeout: 30000 })
      await expect(page2.getByTestId('drive-file-owner')).toContainText(owner.displayName)
      const image = page2.getByTestId('drive-file-image')
      await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), { timeout: 15000 }).toBe(1)
      await page2.getByTestId('drive-file-open-media').click()
      await expect(page2.locator('.media-lightbox-overlay img.media-image')).toBeVisible()
    } finally {
      await reader.close()
    }
  })
})

test('the same link shows a stranger no access and no name', async ({ browser }) => {
  test.setTimeout(120_000)
  const { context, page } = await signedIn(browser, stranger)
  try {
    const answer = page.waitForResponse((r) => r.url().includes('/rest/v1/rpc/drive_file_card'))
    await page.goto(`/drive/file/${harborId}`)
    expect(await (await answer).json()).toEqual({ access: false })
    await expect(page.getByTestId('drive-file-no-access')).toBeVisible({ timeout: 30000 })
    await expect(page.getByTestId('drive-file-no-access')).toContainText("You don't have access to this file")
    await expect(page.getByTestId('drive-file-name')).toHaveCount(0)
    await expect(page.locator('main img')).toHaveCount(0)
    expect(await page.locator('body').innerText()).not.toContain('harbor')
    expect(await page.title()).not.toContain('harbor')
  } finally {
    await context.close()
  }
})

test('a Drive link in a channel: the card for a reader with access, restricted for one without', async ({ browser }) => {
  test.setTimeout(180_000)
  const { context, page } = await signedIn(browser, owner)
  try {
    await openChannel(page, server.id, server.generalChannelId)
    await sendMessage(page, `harbor photo ${fileLink(page, harborId)}`)
    await expect(card(page, 'harbor photo')).toHaveAttribute('data-state', 'ready', { timeout: 30000 })
  } finally {
    await context.close()
  }

  await test.step('the recipient of the share sees the card', async () => {
    const { context: c, page: reader } = await signedIn(browser, recipient)
    try {
      await openChannel(reader, server.id, server.generalChannelId)
      const shown = card(reader, 'harbor photo')
      await expect(shown).toHaveAttribute('data-state', 'ready', { timeout: 30000 })
      await expect(shown.getByTestId('drive-card-name')).toHaveText('harbor.png')
      const image = shown.locator('img')
      await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), { timeout: 15000 }).toBe(1)
    } finally {
      await c.close()
    }
  })

  await test.step('a member without access sees a restricted card naming nothing', async () => {
    const { context: c, page: other } = await signedIn(browser, member)
    try {
      await openChannel(other, server.id, server.generalChannelId)
      const shown = card(other, 'harbor photo')
      await expect(shown).toHaveAttribute('data-state', 'restricted', { timeout: 30000 })
      await expect(shown.getByTestId('drive-card-restricted')).toContainText('Restricted file')
      await expect(shown).not.toContainText('harbor')
      await expect(shown.locator('img')).toHaveCount(0)
    } finally {
      await c.close()
    }
  })
})

test('a /d/ link renders a card for anyone, and its preview page until revoked', async ({ browser }) => {
  test.setTimeout(240_000)
  const backend: Backend = await startBackend()
  try {
    const client = await userClient(owner)
    const { data: share, error } = await client.rpc('drive_link_create', { p_file: lighthouseId })
    expect(error).toBeNull()
    const token = (share as { token: string; id: string }).token

    const { context, page } = await signedIn(browser, owner)
    try {
      await openChannel(page, server.id, server.generalChannelId)
      await sendMessage(page, `lighthouse link ${new URL(page.url()).origin}/d/${token}`)
    } finally {
      await context.close()
    }

    await test.step('a member with no share of the file sees its card and image', async () => {
      const c = await browser.newContext({ serviceWorkers: 'block' })
      try {
        const other = await c.newPage()
        await backend.route(other)
        await signIn(other, member)
        await openChannel(other, server.id, server.generalChannelId)
        const shown = card(other, 'lighthouse link')
        await expect(shown).toHaveAttribute('data-state', 'ready', { timeout: 30000 })
        await expect(shown.getByTestId('drive-card-name')).toHaveText('lighthouse.png')
        const image = shown.locator('img')
        await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), { timeout: 15000 }).toBe(1)
        // Requests still forwarded to the backend fail once the context closes.
        await other.unrouteAll({ behavior: 'ignoreErrors' })
      } finally {
        await c.close()
      }
    })

    await test.step('link-preview crawlers get the name and type, and nothing once revoked', async () => {
      const crawler = { 'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' }
      const live = await fetch(`${backend.url}/d/${token}`, { headers: crawler })
      expect(live.status).toBe(200)
      const html = await live.text()
      expect(html).toContain('<meta property="og:title" content="lighthouse.png">')
      expect(html).toContain('<meta property="og:description" content="Image · image/png">')
      expect(html).toContain(`/api/federation/drive/link/${token}?thumb=1`)
      const thumb = await fetch(`${backend.url}/drive/link/${token}?thumb=1`, { redirect: 'manual' })
      expect(thumb.status).toBe(302)
      expect(thumb.headers.get('location')).toMatch(/\/storage\/v1\/render\/image\/sign\/message_media\//)
      const rendered = await fetch(thumb.headers.get('location')!)
      expect(rendered.status).toBe(200)
      expect(rendered.headers.get('content-type')).toMatch(/^image\//)

      const { error: unshareError } = await client.rpc('drive_unshare', { p_share: (share as { id: string }).id })
      expect(unshareError).toBeNull()
      const dead = await fetch(`${backend.url}/d/${token}`, { headers: crawler })
      expect(dead.status).toBe(404)
      const deadHtml = await dead.text()
      expect(deadHtml).not.toContain('lighthouse')
      expect(deadHtml).not.toContain('og:')
    })
  } finally {
    await backend.stop()
  }
})

test('pasting a link the channel cannot open offers to share it with the channel', async ({ browser }) => {
  test.setTimeout(180_000)
  const { context, page } = await signedIn(browser, owner)
  try {
    await openChannel(page, server.id, server.generalChannelId)
    const link = fileLink(page, agendaId)
    const paste = (text: string) => composer(page).evaluate((el, value) => {
      const data = new DataTransfer()
      data.setData('text/plain', value)
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, text)

    await test.step('the offer names the channel', async () => {
      await composer(page).click()
      await composer(page).pressSequentially('agenda for friday ', { delay: 10 })
      await paste(link)
      const offer = page.getByTestId('drive-share-offer')
      await expect(offer).toContainText("People in #general can't open this file", { timeout: 15000 })
      await offer.getByTestId('drive-share-offer-share').click()
      await expect(offer).toHaveCount(0)
      const { data: shares } = await admin.from('drive_shares').select('scope, target_id').eq('file_id', agendaId)
      expect(shares).toEqual([{ scope: 'channel', target_id: server.generalChannelId }])
      await composer(page).click()
      await page.keyboard.press('Enter')
      await expect(card(page, 'agenda for friday')).toHaveAttribute('data-state', 'ready', { timeout: 30000 })
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

  await test.step('another member of the channel sees the card', async () => {
    const { context: c, page: other } = await signedIn(browser, member)
    try {
      await openChannel(other, server.id, server.generalChannelId)
      const shown = card(other, 'agenda for friday')
      await expect(shown).toHaveAttribute('data-state', 'ready', { timeout: 30000 })
      await expect(shown.getByTestId('drive-card-name')).toHaveText('agenda.txt')
    } finally {
      await c.close()
    }
  })
})
