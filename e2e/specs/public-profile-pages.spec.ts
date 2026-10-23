// Journey: an account's public page /@<name> and a post's /@<name>/<post id> read without signing
// in, as on Mastodon. A visitor sees the profile, its pinned and public posts and never a
// followers-only one; the post page shows its image; an unlisted post's page is noindex. With
// Admin > Config > Federation "Show profiles and public posts to visitors who aren't signed in"
// off, a visitor is sent to sign in and a link-preview crawler still gets the page, noindex. A
// signed-in browser lands in the in-app profile and post: through the proxy's cookie rule, and
// through the page's hand-off when the cookie is missing.
//
// The reverse proxy is not part of this stack. proxyLikeNginx() applies its rule to the page's
// document requests (dev/nginx-harmony.template.conf map $public_page_app): /@ paths go to the
// federation backend (e2e/specs/backend.ts) unless the request carries harmony_app=1 and no
// ActivityPub Accept, /posts/<id> always does. scripts/check-nginx-template.sh and
// scripts/check-caddyfile.sh cover the proxies themselves.
//
// PUBLIC_PAGE_SHOTS=<directory> saves both pages, light and dark, at desktop and phone width.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type BrowserContext, type Browser, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'
import { startBackend, type Backend } from './backend'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SHOTS = process.env.PUBLIC_PAGE_SHOTS ?? ''
const DISCORDBOT = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'

const admin = adminClient()
let backend: Backend
let author: SpecUser
let reader: SpecUser
let staff: SpecUser
const posts = { pinned: '', image: '', text: '', unlisted: '', followers: '' }
const uploaded: string[] = []
let savedSetting: unknown = null

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

async function upload(file: string, contentType: string): Promise<string> {
  const key = `${author.id}/posts/${path.basename(file)}`
  const { error } = await admin.storage.from('user_media').upload(key, fs.readFileSync(path.join(ROOT, file)), { contentType, upsert: true })
  if (error) throw new Error(`upload ${file}: ${error.message}`)
  uploaded.push(key)
  return admin.storage.from('user_media').getPublicUrl(key).data.publicUrl
}

async function post(text: string, visibility: string, minutes: number, extra: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await admin.from('posts').insert({
    author_id: author.id,
    is_local: true,
    visibility,
    content: [{ type: 'text', text }],
    created_at: minutesAgo(minutes),
    ...extra,
  }).select('id').single()
  if (error) throw new Error(`post ${text}: ${error.message}`)
  return data!.id as string
}

async function setPublicPages(on: boolean): Promise<void> {
  const { error } = await admin.from('instance_config')
    .upsert({ config_key: 'public_profile_pages', config_value: on }, { onConflict: 'config_key' })
  if (error) throw new Error(`public_profile_pages: ${error.message}`)
}

/** The reverse proxy's rule for /@ paths and /posts/<id>, applied to document requests. */
async function proxyLikeNginx(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => /^\/(@[^/]+(\/[^/]+)?\/?|posts\/[0-9a-f-]{36})$/.test(url.pathname),
    async (route) => {
      const request = route.request()
      if (request.resourceType() !== 'document') return route.continue()
      const headers = await request.allHeaders()
      const url = new URL(request.url())
      const activityPub = /application\/(activity|ld)\+json/i.test(headers.accept ?? '')
      const appCookie = /(?:^|;\s*)harmony_app=1(?:;|$)/.test(headers.cookie ?? '')
      if (url.pathname.startsWith('/@') && appCookie && !activityPub) return route.continue()
      const response = await route.fetch({ url: `${backend.url}${url.pathname}${url.search}`, maxRedirects: 0 })
      await route.fulfill({ response })
    },
  )
}

/** Screenshots: lazy images below the fold load before a full-page capture. */
async function shoot(page: Page, file: string): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await expect.poll(() => page.locator('img').evaluateAll((imgs: HTMLImageElement[]) =>
    imgs.filter((img) => !img.complete).map((img) => img.currentSrc || img.src))).toEqual([])
  await page.evaluate(() => window.scrollTo(0, 0))
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.screenshot({ path: path.join(SHOTS, `${file}-${scheme}.png`), fullPage: true })
  }
}

async function visitor(browser: Browser, options: Parameters<Browser['newContext']>[0] = {}): Promise<BrowserContext> {
  const context = await browser.newContext({ serviceWorkers: 'block', ...options })
  await proxyLikeNginx(context)
  return context
}

test.describe.configure({ mode: 'serial' })
// A document fulfilled by route() has no address space of its own: Chrome's Local Network
// Access then refuses its loopback subresources, the stack's storage among them. Behind the
// proxy the page and its media share the instance's address space.
test.use({ launchOptions: { args: ['--disable-features=LocalNetworkAccessChecks'] } })

test.beforeAll(async () => {
  // Starts the federation backend under tsx: past 30 s on a loaded CI runner.
  test.setTimeout(120_000)
  author = await createUser(admin, 'ppa')
  reader = await createUser(admin, 'ppr')
  staff = await createUser(admin, 'pps')
  await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)

  const { data } = await admin.from('instance_config').select('config_value').eq('config_key', 'public_profile_pages').maybeSingle()
  savedSetting = data?.config_value ?? null
  await setPublicPages(true)

  const avatar = await upload('public/img/app_icon_square.png', 'image/png')
  const banner = await upload('public/backgrounds/login/5.webp', 'image/webp')
  const photo = await upload('public/backgrounds/login/2.webp', 'image/webp')
  const { error } = await admin.from('profiles').update({
    display_name: 'Ada Lumen',
    bio: 'Painter of night skies.\n\nPosts about light, colour and <b>tags</b> that stay text.',
    avatar_url: avatar,
    banner_url: banner,
    profile_fields: [{ name: 'Studio', value: 'https://example.com' }, { name: 'Pronouns', value: 'she/her' }],
  }).eq('id', author.id)
  if (error) throw new Error(`profile: ${error.message}`)

  posts.pinned = await post('Pinned: start here', 'public', 60, { is_pinned: true })
  posts.followers = await post('Followers only, never public', 'followers', 50)
  posts.image = await post('Tonight over the harbour', 'public', 40, {
    media_attachments: [{ type: 'Image', url: photo, mediaType: 'image/webp', name: 'harbour.webp', description: 'Lights over a dark harbour' }],
  })
  posts.unlisted = await post('Unlisted note to self', 'unlisted', 30)
  posts.text = await post('Hello from the public page', 'public', 20)

  backend = await startBackend()
})

test.afterAll(async () => {
  if (savedSetting === null) await admin.from('instance_config').delete().eq('config_key', 'public_profile_pages')
  else await admin.from('instance_config').upsert({ config_key: 'public_profile_pages', config_value: savedSetting }, { onConflict: 'config_key' })
  await backend?.stop()
  if (uploaded.length) await admin.storage.from('user_media').remove(uploaded)
  await admin.from('posts').delete().eq('author_id', author?.id ?? '')
  await deleteUser(admin, author)
  await deleteUser(admin, reader)
  await deleteUser(admin, staff)
})

test('a visitor reads the profile and its public posts', async ({ browser }) => {
  const context = await visitor(browser)
  const page = await context.newPage()
  const response = await page.goto(`/@${author.username}`)
  expect(response?.status()).toBe(200)
  expect(response?.headers()['x-robots-tag']).toBeUndefined()

  const profile = page.getByTestId('public-profile')
  await expect(profile.getByRole('heading', { level: 1 })).toHaveText('Ada Lumen')
  await expect(profile).toContainText(`@${author.username}@localhost`)
  await expect(page.getByTestId('public-bio')).toContainText('<b>tags</b> that stay text')
  await expect(profile.locator('dl.fields')).toContainText('Studio')
  await expect(page.getByTestId('public-pinned')).toContainText('Pinned: start here')

  const feed = page.getByTestId('public-feed')
  await expect(feed.getByTestId('public-post')).toHaveCount(3)
  await expect(feed).toContainText('Hello from the public page')
  await expect(feed).toContainText('Unlisted note to self')
  await expect(feed).toContainText('Tonight over the harbour')
  await expect(page.locator('body')).not.toContainText('Followers only, never public')
  await expect(page.getByTestId('public-sign-in')).toHaveAttribute('href', `/login?redirect=${encodeURIComponent(`/@${author.username}`)}`)

  if (SHOTS) await shoot(page, 'profile-desktop')

  // The username is matched without case and moved to its spelling. Asked of the backend: a
  // redirect fulfilled through route() navigates the page twice.
  const moved = await fetch(`${backend.url}/@${author.username.toUpperCase()}`, { redirect: 'manual' })
  expect([moved.status, moved.headers.get('location')]).toEqual([301, `/@${author.username}`])
  await context.close()
})

test('a visitor opens a post and sees its image', async ({ browser }) => {
  const context = await visitor(browser)
  const page = await context.newPage()
  const response = await page.goto(`/@${author.username}/${posts.image}`)
  expect(response?.status()).toBe(200)
  expect(response?.headers()['x-robots-tag']).toBeUndefined()

  const card = page.getByTestId('public-post')
  await expect(card).toContainText('Tonight over the harbour')
  const image = card.locator('.media-grid img')
  await expect(image).toHaveAttribute('alt', 'Lights over a dark harbour')
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), { timeout: 15000 }).toBeGreaterThan(0)
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /\/storage\/v1\/object\/public\/user_media\/.+2\.webp$/)
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0)

  // /posts/<id> is the same page, canonical at /@<name>/<id>.
  await page.goto(`/posts/${posts.image}`)
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://localhost/@${author.username}/${posts.image}`)
  await expect(page.getByTestId('public-post').locator('.media-grid img')).toBeVisible()

  if (SHOTS) {
    await page.goto(`/@${author.username}/${posts.image}`)
    await shoot(page, 'post-desktop')
  }
  await context.close()
})

test('the pages fit a phone', async ({ browser }) => {
  const context = await visitor(browser, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  for (const [name, url] of [['profile', `/@${author.username}`], ['post', `/@${author.username}/${posts.image}`]] as const) {
    await page.goto(url)
    await expect(page.getByTestId('public-post').first()).toBeVisible()
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(scroll, `${name} scrolls sideways`).toBeLessThanOrEqual(0)
    if (SHOTS) await shoot(page, `${name}-phone`)
  }
  await context.close()
})

test('an unlisted post\'s page is noindex; a followers-only post has none', async ({ browser }) => {
  const context = await visitor(browser)
  const page = await context.newPage()
  const unlisted = await page.goto(`/@${author.username}/${posts.unlisted}`)
  expect(unlisted?.status()).toBe(200)
  expect(unlisted?.headers()['x-robots-tag']).toBe('noindex, noarchive')
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, noarchive')
  await expect(page.getByTestId('public-post')).toContainText('Unlisted note to self')

  const hidden = await page.goto(`/@${author.username}/${posts.followers}`)
  expect(hidden?.status()).toBe(404)
  await expect(page.getByTestId('public-status')).toBeVisible()
  await expect(page.locator('body')).not.toContainText('Followers only, never public')
  await context.close()
})

test('a signed-in reader lands in the app, with the cookie and through the hand-off', async ({ browser }) => {
  test.setTimeout(90_000)
  const context = await visitor(browser)
  const page = await context.newPage()
  await signIn(page, reader)
  await expect.poll(async () => (await context.cookies()).find((c) => c.name === 'harmony_app')?.value).toBe('1')

  // The cookie: the proxy serves the app, which opens the in-app profile.
  await page.goto(`/@${author.username}`)
  await page.waitForURL(new RegExp(`/social/profile/${author.username}$`), { timeout: 30000 })
  await dismissAnnouncements(page)
  await expect(page.getByTestId('profile-follow-btn')).toBeVisible({ timeout: 30000 })

  // No cookie: the backend's page hands the session's browser to the app and sets it again.
  await context.clearCookies({ name: 'harmony_app' })
  await page.goto(`/@${author.username}/${posts.text}`)
  await page.waitForURL(new RegExp(`/social/post/${posts.text}$`), { timeout: 30000 })
  await expect(page.locator('body')).toContainText('Hello from the public page', { timeout: 30000 })
  expect((await context.cookies()).find((c) => c.name === 'harmony_app')?.value).toBe('1')

  // Signing out clears it.
  await page.goto('/logout')
  await page.getByTestId('logout-confirm-btn').click()
  await expect.poll(async () => (await context.cookies()).some((c) => c.name === 'harmony_app'), { timeout: 30000 }).toBe(false)
  await context.close()
})

test('with the setting off, a visitor is sent to sign in and a crawler still gets the page', async ({ browser }) => {
  test.setTimeout(90_000)
  const staffContext = await browser.newContext({ serviceWorkers: 'block' })
  const staffPage = await staffContext.newPage()
  await signIn(staffPage, staff)
  await staffPage.goto('/admin?tab=config')
  await dismissAnnouncements(staffPage)
  await staffPage.locator('.config-tab-btn').filter({ hasText: 'Federation' }).click()
  const toggle = staffPage.getByTestId('public-profile-pages-toggle')
  await expect(toggle).toBeChecked({ timeout: 15000 })
  const label = staffPage.locator('label').filter({ has: toggle })
  await expect(label).toContainText("Show profiles and public posts to visitors who aren't signed in")
  await label.click()
  await expect(toggle).not.toBeChecked()
  await staffPage.locator('.config-section').filter({ hasText: 'Federation settings' }).getByRole('button', { name: 'Save changes' }).click()
  await expect.poll(async () => {
    const { data } = await admin.from('instance_config').select('config_value').eq('config_key', 'public_profile_pages').maybeSingle()
    return data?.config_value
  }, { timeout: 15000 }).toBe(false)
  await staffContext.close()

  const context = await visitor(browser)
  const page = await context.newPage()
  await page.goto(`/@${author.username}/${posts.image}`)
  await page.waitForURL((url) => url.pathname === '/login', { timeout: 30000 })
  expect(new URL(page.url()).searchParams.get('redirect')).toBe(`/@${author.username}/${posts.image}`)
  await expect(page.locator('[data-testid="auth-email"]')).toBeVisible({ timeout: 30000 })
  await context.close()

  const crawl = await fetch(`${backend.url}/@${author.username}`, { headers: { 'User-Agent': DISCORDBOT } })
  expect(crawl.status).toBe(200)
  expect(crawl.headers.get('x-robots-tag')).toBe('noindex, noarchive')
  expect(await crawl.text()).toContain('<meta property="og:title" content="Ada Lumen')

  await setPublicPages(true)
})
