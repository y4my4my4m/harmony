// Journey: Drive file addresses. Every Copy link gives the file's /d/<token>. Restricted, the
// address opens, through sign-in, for the recipient of a people share and shows a stranger a
// no-access page naming nothing; signed out, it asks for sign-in. General access set to Anyone with
// the link opens the public page for a signed-out stranger, with the footer links and no owner
// until Show my name is on, then the owner's name with its custom emoji. An expired link is
// restricted again; Reset link kills the old address. A 1.8.11 /drive/file/<id> address lands on
// /d/<token>. Link-preview crawlers get OpenGraph only while the file is public.
//
// Drive files are uploaded through storage as their owner, which is what Drive's upload does.

import { randomUUID } from 'node:crypto'
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { startBackend, type Backend } from './backend'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  signIn,
  userClient,
  type SpecUser,
} from './harness'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
const CRAWLER = { 'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' }

const admin = adminClient()
let owner: SpecUser
let recipient: SpecUser
let stranger: SpecUser
let harborId: string
let lighthouseId: string
let agendaId: string
let emojiName: string

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

async function tokenOf(fileId: string): Promise<string> {
  const { data, error } = await admin.from('drive_files').select('link_token').eq('id', fileId).single()
  if (error || !data) throw new Error(`link_token of ${fileId}: ${error?.message}`)
  return data.link_token as string
}

test.beforeAll(async () => {
  test.setTimeout(120_000)
  owner = await createUser(admin, 'dlo')
  recipient = await createUser(admin, 'dlr')
  stranger = await createUser(admin, 'dls')

  // The owner's display name carries a custom emoji the public page draws.
  emojiName = `dlwave${owner.username.slice(-6)}`
  const { error: emojiError } = await admin.from('emojis')
    .insert({ name: emojiName, url: 'https://emoji.e2e.test/wave.png', scope: 'instance' })
  if (emojiError) throw new Error(`emoji: ${emojiError.message}`)
  const { error: nameError } = await admin.from('profiles')
    .update({ display_name: `${owner.displayName} :${emojiName}:` }).eq('id', owner.id)
  if (nameError) throw new Error(`display name: ${nameError.message}`)

  harborId = await uploadDriveFile(owner, 'harbor.png', 'image/png', PNG)
  lighthouseId = await uploadDriveFile(owner, 'lighthouse.png', 'image/png', PNG)
  agendaId = await uploadDriveFile(owner, 'agenda.txt', 'text/plain', Buffer.from('1. ferry\n2. lunch\n'))

  const client = await userClient(owner)
  const { error } = await client.rpc('drive_share_file', { p_file: harborId, p_scope: 'user', p_target: recipient.id })
  if (error) throw new Error(`share harbor.png: ${error.message}`)
})

test.afterAll(async () => {
  await admin.from('emojis').delete().eq('name', emojiName)
  for (const user of [stranger, recipient, owner]) await deleteUser(admin, user)
})

const address = (page: Page, token: string) => `${new URL(page.url()).origin}/d/${token}`

async function signedIn(browser: Browser, user: SpecUser, options: Parameters<Browser['newContext']>[0] = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(options)
  const page = await context.newPage()
  await signIn(page, user)
  return { context, page }
}

async function openDriveFile(page: Page, name: string): Promise<void> {
  await page.getByTestId('rail-drive').click()
  await dismissAnnouncements(page)
  await page.getByTestId('drive-layout-list').click()
  const row = page.getByTestId('drive-items').getByTestId('drive-file').filter({ hasText: name })
  await expect(row).toBeVisible({ timeout: 30000 })
  await row.click()
}

async function openShareDialog(page: Page, name: string) {
  await openDriveFile(page, name)
  await page.getByTestId('drive-share-open').click()
  const dialog = page.getByTestId('drive-share-dialog')
  await expect(dialog.getByTestId('drive-link-url')).toHaveValue(/\/d\/[A-Za-z0-9_-]{24}$/, { timeout: 15000 })
  return dialog
}

test('Copy link gives the /d/ address; restricted, it opens for a share recipient through sign-in', async ({ browser }) => {
  test.setTimeout(180_000)
  const token = await tokenOf(harborId)
  const { context, page } = await signedIn(browser, owner, { permissions: ['clipboard-read', 'clipboard-write'] })
  let link = ''
  try {
    await test.step('the file menu copies the /d/ address', async () => {
      await openDriveFile(page, 'harbor.png')
      const row = page.getByTestId('drive-items').getByTestId('drive-file').filter({ hasText: 'harbor.png' })
      await row.click({ button: 'right' })
      await page.getByTestId('drive-menu-copy-link').click()
      link = address(page, token)
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(link)
    })

    await test.step('the details panel opens the image in the lightbox and copies the same address', async () => {
      await page.getByTestId('drive-details-open-media').click()
      const lightbox = page.locator('.media-lightbox-overlay')
      await expect(lightbox.locator('img.media-image')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(lightbox).toHaveCount(0)
      await page.evaluate(() => navigator.clipboard.writeText(''))
      await page.getByTestId('drive-details-copy-link').click()
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(link)
    })

    await test.step('the share dialog shows the address, restricted, and copies it', async () => {
      await page.getByTestId('drive-share-open').click()
      const dialog = page.getByTestId('drive-share-dialog')
      await expect(dialog.getByTestId('drive-link-url')).toHaveValue(link)
      await expect(dialog.getByTestId('drive-link-access')).toHaveValue('restricted')
      await expect(dialog.getByTestId('drive-link-access-hint')).toHaveText('Opens only for people who can already see this file.')
      await expect(dialog.getByTestId('drive-link-show-owner')).toHaveCount(0)
      await page.evaluate(() => navigator.clipboard.writeText(''))
      await dialog.getByTestId('drive-link-copy').click()
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(link)
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
      await page2.waitForURL(new RegExp(`/d/${token}$`), { timeout: 30000 })
      await dismissAnnouncements(page2)
      await expect(page2.getByTestId('drive-file-name')).toHaveText('harbor.png', { timeout: 30000 })
      await expect(page2.getByTestId('drive-file-owner')).toContainText(owner.displayName)
      await expect(page2.getByTestId('drive-file-owner').locator(`img[alt=":${emojiName}:"]`)).toHaveCount(1)
      const image = page2.getByTestId('drive-file-image')
      await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), { timeout: 15000 }).toBe(1)
      await page2.getByTestId('drive-file-open-media').click()
      await expect(page2.locator('.media-lightbox-overlay img.media-image')).toBeVisible()
    } finally {
      await reader.close()
    }
  })
})

test('a restricted address shows a stranger no access and no name', async ({ browser }) => {
  test.setTimeout(120_000)
  const token = await tokenOf(harborId)
  const { context, page } = await signedIn(browser, stranger)
  try {
    for (const path of [`/d/${token}`, `/drive/file/${harborId}`]) {
      const answer = page.waitForResponse((r) => r.url().includes('/rest/v1/rpc/drive_file_card'))
      await page.goto(path)
      expect(await (await answer).json()).toEqual({ access: false })
      await expect(page.getByTestId('drive-file-no-access')).toBeVisible({ timeout: 30000 })
      await expect(page.getByTestId('drive-file-no-access')).toContainText("You don't have access to this file")
      await expect(page).toHaveURL(new RegExp(`${path}$`))
      await expect(page.getByTestId('drive-file-name')).toHaveCount(0)
      await expect(page.locator('main img')).toHaveCount(0)
      expect(await page.locator('body').innerText()).not.toContain('harbor')
      expect(await page.title()).not.toContain('harbor')
    }
  } finally {
    await context.close()
  }

  await test.step('signed out, the address asks for sign-in and names nothing', async () => {
    const visitor = await browser.newContext()
    try {
      const page2 = await visitor.newPage()
      await page2.goto(`/d/${token}`)
      await expect(page2).toHaveURL(/\/login/, { timeout: 30000 })
      expect(await page2.locator('body').innerText()).not.toContain('harbor')
    } finally {
      await visitor.close()
    }
  })
})

test('an old /drive/file/ address lands on the file\'s /d/ address', async ({ browser }) => {
  test.setTimeout(120_000)
  const token = await tokenOf(harborId)
  const { context, page } = await signedIn(browser, recipient)
  try {
    await page.goto(`/drive/file/${harborId}`)
    await page.waitForURL(new RegExp(`/d/${token}$`), { timeout: 30000 })
    await expect(page.getByTestId('drive-file-name')).toHaveText('harbor.png', { timeout: 30000 })
  } finally {
    await context.close()
  }
})

test('Anyone with the link: the public page, Show my name, expiry, and OpenGraph only while public', async ({ browser }) => {
  test.setTimeout(300_000)
  const backend: Backend = await startBackend()
  const token = await tokenOf(lighthouseId)
  const { context, page } = await signedIn(browser, owner)
  const visitor = await browser.newContext({ serviceWorkers: 'block' })
  try {
    const anonymous = await visitor.newPage()
    await backend.route(anonymous)
    const publicUrl = address(page, token)

    await test.step('restricted, crawlers get no OpenGraph', async () => {
      const res = await fetch(`${backend.url}/d/${token}`, { headers: CRAWLER })
      expect(res.status).toBe(404)
      const html = await res.text()
      expect(html).not.toContain('lighthouse')
      expect(html).not.toContain('og:')
    })

    const dialog = await openShareDialog(page, 'lighthouse.png')
    await test.step('General access to Anyone with the link keeps the address', async () => {
      await expect(dialog.getByTestId('drive-link-url')).toHaveValue(publicUrl)
      await dialog.getByTestId('drive-link-access').selectOption('anyone')
      await expect(dialog.getByTestId('drive-link-access-hint')).toHaveText('Anyone with the link can view and download.')
      await expect(dialog.getByTestId('drive-link-show-owner')).toHaveAttribute('aria-checked', 'false')
      await expect(dialog.getByTestId('drive-link-url')).toHaveValue(publicUrl)
    })

    await test.step('crawlers get the name and type, and no owner', async () => {
      const res = await fetch(`${backend.url}/d/${token}`, { headers: CRAWLER })
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('<meta property="og:title" content="lighthouse.png">')
      expect(html).toContain('<meta property="og:description" content="Image · image/png">')
      expect(html).not.toContain(owner.username)
    })

    await test.step('a signed-out stranger sees the public page, its footer and no owner', async () => {
      await anonymous.goto(`/d/${token}`)
      await expect(anonymous.getByTestId('drive-link-name')).toHaveText('lighthouse.png', { timeout: 30000 })
      const image = anonymous.getByRole('img', { name: 'lighthouse.png' })
      await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), { timeout: 15000 }).toBe(1)
      const origin = new URL(anonymous.url()).origin
      // The instance's domain (VITE_DOMAIN of e2e/stack.env), linking to its origin.
      await expect(anonymous.getByTestId('drive-link-footer')).toHaveText('Powered by Harmony on localhost')
      await expect(anonymous.getByTestId('drive-link-harmony')).toHaveAttribute('href', 'https://mony.lol')
      await expect(anonymous.getByTestId('drive-link-harmony')).toHaveAttribute('target', '_blank')
      await expect(anonymous.getByTestId('drive-link-instance')).toHaveAttribute('href', origin)
      await expect(anonymous.getByTestId('drive-link-instance')).toHaveAttribute('target', '_blank')
      await expect(anonymous.getByTestId('drive-link-owner')).toHaveCount(0)
      const text = await anonymous.locator('body').innerText()
      expect(text).not.toContain(owner.displayName)
      expect(text).not.toContain(owner.username)
    })

    await test.step('Show my name puts the owner, with the emoji of the name, on the page', async () => {
      await dialog.getByTestId('drive-link-show-owner').click()
      await expect(dialog.getByTestId('drive-link-show-owner')).toHaveAttribute('aria-checked', 'true')
      await anonymous.reload()
      const shown = anonymous.getByTestId('drive-link-owner')
      await expect(shown).toContainText(`Shared by ${owner.displayName}`, { timeout: 30000 })
      await expect(shown.locator(`img[alt=":${emojiName}:"]`)).toHaveAttribute('src', 'https://emoji.e2e.test/wave.png')
      await expect(anonymous.getByTestId('drive-link-owner-name')).toHaveAttribute('href', `/social/profile/${owner.username}`)
    })

    await test.step('an expiry shows on the page; once passed, the file is restricted again', async () => {
      await dialog.getByTestId('drive-link-expiry').selectOption('1')
      // A set expiry stays selected as its date.
      await expect(dialog.getByTestId('drive-link-expiry')).toHaveValue('current')
      await expect(dialog.getByTestId('drive-link-expiry').locator('option[value="current"]')).toHaveText(/^Until /)
      await expect(dialog.getByTestId('drive-link-show-owner')).toHaveAttribute('aria-checked', 'true')
      await anonymous.reload()
      await expect(anonymous.getByText(/^Link expires /)).toBeVisible({ timeout: 30000 })

      const { error } = await admin.from('drive_shares').update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
        .eq('file_id', lighthouseId).eq('scope', 'link')
      expect(error).toBeNull()
      await anonymous.goto(`/d/${token}`)
      await expect(anonymous).toHaveURL(/\/login/, { timeout: 30000 })
      const res = await fetch(`${backend.url}/d/${token}`, { headers: CRAWLER })
      expect(res.status).toBe(404)
      expect(await res.text()).not.toContain('og:')
    })

    await test.step('the owner still opens the same address', async () => {
      await page.keyboard.press('Escape')
      await page.goto(`/d/${token}`)
      await expect(page.getByTestId('drive-file-name')).toHaveText('lighthouse.png', { timeout: 30000 })
      await expect(page.getByTestId('drive-file-owner')).toContainText('Your file')
    })
    await anonymous.unrouteAll({ behavior: 'ignoreErrors' })
  } finally {
    await visitor.close()
    await context.close()
    await backend.stop()
  }
})

test('Reset link kills the old address', async ({ browser }) => {
  test.setTimeout(180_000)
  const client = await userClient(owner)
  const { error } = await client.rpc('drive_link_set', { p_file: agendaId, p_public: true })
  expect(error).toBeNull()
  const oldToken = await tokenOf(agendaId)

  const { context, page } = await signedIn(browser, owner)
  let newToken = ''
  try {
    const dialog = await openShareDialog(page, 'agenda.txt')
    await expect(dialog.getByTestId('drive-link-url')).toHaveValue(address(page, oldToken))
    await dialog.getByTestId('drive-link-reset').click()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toContainText('stops working for everyone')
    await confirm.getByRole('button', { name: 'Reset link' }).click()
    await expect(dialog.getByTestId('drive-link-url')).not.toHaveValue(address(page, oldToken), { timeout: 15000 })
    newToken = await tokenOf(agendaId)
    expect(newToken).not.toBe(oldToken)
    await expect(dialog.getByTestId('drive-link-url')).toHaveValue(address(page, newToken))
    await expect(dialog.getByTestId('drive-link-access')).toHaveValue('anyone')
  } finally {
    await context.close()
  }

  const visitor = await browser.newContext()
  try {
    const anonymous = await visitor.newPage()
    await anonymous.goto(`/d/${newToken}`)
    await expect(anonymous.getByTestId('drive-link-name')).toHaveText('agenda.txt', { timeout: 30000 })
    await anonymous.goto(`/d/${oldToken}`)
    await expect(anonymous).toHaveURL(/\/login/, { timeout: 30000 })
    expect(await anonymous.locator('body').innerText()).not.toContain('agenda')
  } finally {
    await visitor.close()
  }
})
