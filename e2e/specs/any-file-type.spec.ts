// Journey: any file type, as Discord takes it. An APK, an SVG and an HTML page attach in a DM and
// in Drive. A type storage does not serve as itself (the bucket's list) is stored as
// application/octet-stream under its own name: it shows as a file card and downloads, and nothing
// that would run (SVG, HTML) opens as a page or an inline image. A PNG keeps its type and shows
// inline.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, messageList, sendMessage, signIn, type SpecUser } from './harness'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

const admin = adminClient()
let owner: SpecUser
let member: SpecUser
let dm = ''

test.beforeAll(async () => {
  owner = await createUser(admin, 'aftown')
  member = await createUser(admin, 'aftmem')
  const conversation = await admin.from('conversations').insert({ type: 'direct', created_by: owner.id }).select('id').single()
  if (conversation.error) throw new Error(conversation.error.message)
  dm = conversation.data.id
  const joined = await admin.from('conversation_participants').insert([
    { conversation_id: dm, user_id: owner.id }, { conversation_id: dm, user_id: member.id },
  ])
  if (joined.error) throw new Error(joined.error.message)
})

test.afterAll(async () => {
  if (dm) await admin.from('conversations').delete().eq('id', dm)
  await deleteUser(admin, member)
  await deleteUser(admin, owner)
})

const preview = (page: Page, name: string) => page.getByTestId('file-preview-item').filter({ hasText: name })

async function attach(page: Page, name: string, mimeType: string, buffer: Buffer) {
  await page.getByTestId('composer-file-input').setInputFiles({ name, mimeType, buffer })
  await expect(preview(page, name)).toContainText('Uploaded', { timeout: 20_000 })
}

/** The stored type of each file part of the latest message whose text is `text`. */
async function storedTypes(text: string): Promise<Record<string, string>> {
  const { data, error } = await admin.from('messages').select('content').eq('conversation_id', dm).order('created_at', { ascending: false }).limit(20)
  if (error) throw new Error(error.message)
  const row = (data ?? []).find((m: { content: Array<{ type: string; text?: string }> }) => m.content.some((p) => p.type === 'text' && p.text?.includes(text)))
  if (!row) throw new Error(`no message "${text}"`)
  const types: Record<string, string> = {}
  for (const part of (row.content as Array<{ type: string; path?: string; fileName?: string; fileType?: string }>).filter((p) => p.type === 'file')) {
    const download = await admin.storage.from('message_media').download(part.path!)
    if (download.error) throw new Error(download.error.message)
    types[part.fileName!] = `${download.data.type} ${part.fileType}`
  }
  return types
}

test('an APK, an SVG and an HTML page send as files; a PNG still shows inline', async ({ page, browser }) => {
  test.setTimeout(180_000)
  await signIn(page, owner)
  await page.goto(`/dm/${dm}`)
  await dismissAnnouncements(page)

  await test.step('every type attaches, none is refused', async () => {
    await attach(page, 'cartouche-0.5.1.apk', 'application/vnd.android.package-archive', Buffer.from('PK\x03\x04 apk bytes'))
    await attach(page, 'logo.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))
    await attach(page, 'page.html', 'text/html', Buffer.from('<!doctype html><script>alert(1)</script>'))
    await attach(page, 'dot.png', 'image/png', PNG)
    await expect(page.getByText("isn't allowed")).toHaveCount(0)
    await sendMessage(page, 'four files')
  })

  const sent = messageList(page).locator('.message-item').filter({ hasText: 'four files' })

  await test.step('each is stored as storage will serve it', async () => {
    await expect(sent).toContainText('cartouche-0.5.1.apk', { timeout: 20_000 })
    await expect.poll(() => storedTypes('four files'), { timeout: 20_000 }).toEqual({
      'cartouche-0.5.1.apk': 'application/octet-stream file',
      'logo.svg': 'application/octet-stream file',
      'page.html': 'application/octet-stream file',
      'dot.png': 'image/png image',
    })
  })

  await test.step('the other member sees three file cards and one image', async () => {
    const other = await browser.newContext()
    const p = await other.newPage()
    await signIn(p, member)
    await p.goto(`/dm/${dm}`)
    await dismissAnnouncements(p)
    const row = messageList(p).locator('.message-item').filter({ hasText: 'four files' })
    for (const name of ['cartouche-0.5.1.apk', 'logo.svg', 'page.html']) await expect(row).toContainText(name, { timeout: 20_000 })
    await expect(row.locator('img[alt="logo.svg"], img[src*="logo.svg"]')).toHaveCount(0)
    await expect(row.locator('img').first()).toBeVisible()
    await other.close()
  })

  await test.step('Drive takes an APK too', async () => {
    await page.getByTestId('rail-drive').click()
    await expect(page.getByTestId('drive-view')).toBeVisible({ timeout: 30_000 })
    await dismissAnnouncements(page)
    await page.getByTestId('drive-layout-list').click()
    await page.getByTestId('drive-file-input').setInputFiles({ name: 'tool.apk', mimeType: 'application/vnd.android.package-archive', buffer: Buffer.from('PK\x03\x04 drive apk') })
    await expect(page.getByTestId('drive-items').getByTestId('drive-file').filter({ hasText: 'tool.apk' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("isn't allowed")).toHaveCount(0)
  })
})
