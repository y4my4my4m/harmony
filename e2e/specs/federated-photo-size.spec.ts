// Journey: a photo larger than instance_config.federate_image_max_px (default 1920) goes to other
// servers as its storage render, fitted inside the cap, in its own format; a photo within the
// cap goes as stored. The post keeps the cap it was made under: posts made after the setting
// changed to 0 send originals.
//
// The composer records each photo's size; the Note is the backend's GET /posts/:id
// (e2e/specs/backend.ts). The render is fetched with the Accept the self-host proxy pins
// (self-host/Caddyfile): format=origin keeps it JPEG.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'
import { startBackend, type Backend } from './backend'

const admin = adminClient()
let author: SpecUser
let backend: Backend

test.beforeAll(async () => {
  test.setTimeout(120_000)
  author = await createUser(admin, 'fps')
  backend = await startBackend()
})

test.afterAll(async () => {
  await backend?.stop()
  await admin.from('instance_config').delete().eq('config_key', 'federate_image_max_px')
  await deleteUser(admin, author)
})

/** A JPEG of `width` × `height` drawn by a blank page's canvas. */
async function canvasJpeg(page: Page, width: number, height: number): Promise<Buffer> {
  const blank = await page.context().newPage()
  const dataUrl = await blank.evaluate(async ([w, h]) => {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    const gradient = ctx.createLinearGradient(0, 0, w, h)
    gradient.addColorStop(0, '#0ea5e9')
    gradient.addColorStop(1, '#f59e0b')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, w, h)
    const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.85))
    return new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.readAsDataURL(blob)
    })
  }, [width, height] as const)
  await blank.close()
  return Buffer.from(dataUrl.split(',')[1], 'base64')
}

/** Width and height from a JPEG's first SOFn segment. */
function jpegSize(b: Buffer): { width: number; height: number } {
  expect(b.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true)
  let p = 2
  while (p + 9 <= b.length) {
    const marker = b[p + 1]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(p + 5), width: b.readUInt16BE(p + 7) }
    }
    p += 2 + b.readUInt16BE(p + 2)
  }
  throw new Error('no JPEG frame header')
}

type Media = { url: string; name: string; width?: number; height?: number }

async function post(page: Page, text: string, photos: Array<{ name: string; buffer: Buffer }>): Promise<{ id: string; media: Media[]; cap: unknown }> {
  await page.goto('/social/home')
  await dismissAnnouncements(page)
  await page.getByRole('button', { name: 'New post' }).click()
  const dialog = page.getByRole('dialog', { name: 'Create a post' })
  await expect(dialog).toBeVisible({ timeout: 15000 })
  await dialog.locator('.rich-text-editor').click()
  await page.keyboard.type(text)
  await dialog.locator('input[type="file"][accept="image/*,video/*"]').setInputFiles(
    photos.map((p) => ({ name: p.name, mimeType: 'image/jpeg', buffer: p.buffer })),
  )
  await expect(dialog.locator('.media-preview-item')).toHaveCount(photos.length, { timeout: 15000 })
  await dialog.getByTestId('compose-submit').click()
  await expect(dialog).toBeHidden({ timeout: 30000 })

  let row: { id: string; media_attachments: Media[]; metadata: Record<string, unknown> } | null = null
  await expect.poll(async () => {
    const { data } = await admin.from('posts').select('id, media_attachments, metadata, content')
      .eq('author_id', author.id).order('created_at', { ascending: false }).limit(1).maybeSingle()
    row = JSON.stringify(data?.content ?? '').includes(text) ? data as typeof row : null
    return row?.media_attachments?.length ?? 0
  }, { timeout: 20000 }).toBe(photos.length)
  return { id: row!.id, media: row!.media_attachments, cap: row!.metadata?.federate_image_max_px }
}

async function note(id: string): Promise<{ attachment: Array<{ url: string; mediaType: string; width?: number; height?: number }> }> {
  const res = await fetch(`${backend.url}/posts/${id}`, { headers: { Accept: 'application/activity+json' } })
  expect(res.status).toBe(200)
  return res.json()
}

const renderOf = (url: string, cap: number) =>
  `${url.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/')}?width=${cap}&height=${cap}&resize=contain&quality=85&format=origin`

test('a photo past the cap federates as its render, fitted; a smaller one as stored', async ({ page }) => {
  test.setTimeout(180_000)
  const large = await canvasJpeg(page, 3000, 2000)
  const small = await canvasJpeg(page, 800, 600)
  await signIn(page, author)

  const first = await test.step('the composer records each photo size and the post the cap', async () => {
    const created = await post(page, `harbour ${author.username}`, [
      { name: 'harbour.jpg', buffer: large },
      { name: 'pier.jpg', buffer: small },
    ])
    const byName = Object.fromEntries(created.media.map((m) => [m.name, m]))
    expect([byName['harbour.jpg'].width, byName['harbour.jpg'].height]).toEqual([3000, 2000])
    expect([byName['pier.jpg'].width, byName['pier.jpg'].height]).toEqual([800, 600])
    expect(created.cap).toBe(1920)
    return { ...created, byName }
  })

  await test.step('the Note names the render of the large photo and the small one as stored', async () => {
    const [a, b] = (await note(first.id)).attachment
    expect(a).toMatchObject({ mediaType: 'image/jpeg', url: renderOf(first.byName['harbour.jpg'].url, 1920), width: 1920, height: 1280 })
    expect(b).toMatchObject({ mediaType: 'image/jpeg', url: first.byName['pier.jpg'].url, width: 800, height: 600 })
  })

  await test.step('the render is a JPEG of the size the Note states', async () => {
    const [a] = (await note(first.id)).attachment
    const res = await fetch(a.url, { headers: { Accept: 'image/webp,*/*;q=0.8' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(jpegSize(Buffer.from(await res.arrayBuffer()))).toEqual({ width: 1920, height: 1280 })
  })

  await test.step('with the setting at 0, a new post sends its original and the first keeps its render', async () => {
    const { error } = await admin.from('instance_config')
      .upsert({ config_key: 'federate_image_max_px', config_value: 0 }, { onConflict: 'config_key' })
    if (error) throw new Error(error.message)
    const later = await post(page, `harbour again ${author.username}`, [{ name: 'harbour.jpg', buffer: large }])
    expect(later.cap).toBe(0)
    const [a] = (await note(later.id)).attachment
    expect(a).toMatchObject({ url: later.media[0].url, width: 3000, height: 2000 })
    expect((await note(first.id)).attachment[0].url).toBe(renderOf(first.byName['harbour.jpg'].url, 1920))
  })
})
