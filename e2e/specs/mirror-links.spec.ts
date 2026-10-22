// Journey: links to X posts a user sends go out on fixupx.com, the embed-fixer mirror other
// apps preview with the post's media; Harmony still shows the post. Appearance turns the
// rewrite off per site, the choice is stored on the profile, and a link sent then stays as
// typed.
//
// The stack runs no federation backend and no realtime: the preview is written into the
// message metadata as the backend's enrichment writes it, keyed by the stored link, and the
// channel is opened again to read it.

import { test, expect, type Page } from '@playwright/test'
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
let user: SpecUser
let server: SeededServer

const POST = 'https://x.com/NASA/status/2112560723603632217'
const MIRRORED = 'https://fixupx.com/NASA/status/2112560723603632217'
const OTHER_POST = 'https://x.com/NASA/status/2112560723603632218'
const PHOTO = 'https://pbs.twimg.com/media/HUiP9IrX0AARv5Q.jpg?name=orig'

test.beforeAll(async () => {
  user = await createUser(admin, 'mirror')
  server = await seedServer(admin, user, `Mirrors ${user.username}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

/** Sends `label link` from the composer and returns the stored url parts. */
async function send(page: Page, label: string, link: string): Promise<string[]> {
  await composer(page).click()
  await composer(page).pressSequentially(`${label} ${link}`, { delay: 5 })
  await page.keyboard.press('Enter')
  const row = messageList(page).locator('.message-item').filter({ hasText: `${label} ` }).last()
  await expect(row).toBeVisible({ timeout: 30000 })
  await expect(row).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
  const id = await row.getAttribute('data-message-id')
  const { data, error } = await admin.from('messages').select('content').eq('id', id!).single()
  if (error) throw new Error(`message: ${error.message}`)
  return (data!.content as Array<{ type: string; url?: string }>).filter((p) => p.type === 'url').map((p) => p.url!)
}

async function storedMirrors(): Promise<unknown> {
  const { data } = await admin.from('profiles').select('appearance_settings').eq('id', user.id).single()
  return (data as { appearance_settings: { linkMirrors?: unknown } | null }).appearance_settings?.linkMirrors
}

test('a sent X post link is stored on fixupx.com and still shows the post', async ({ page }) => {
  test.setTimeout(120_000)
  await page.route('https://pbs.twimg.com/**', (route) => route.fulfill({
    status: 200, contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#0ea5e9"/></svg>',
  }))
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)

  expect(await send(page, 'mirroron', POST)).toEqual([MIRRORED])
  const row = messageList(page).locator('.message-item').filter({ hasText: 'mirroron ' })
  await expect(row.locator('a.url-link')).toHaveAttribute('href', MIRRORED)

  await test.step('the preview the backend stores for the mirror link shows the post', async () => {
    const { data: stored } = await admin.from('messages').select('id').eq('channel_id', server.generalChannelId)
      .eq('user_id', user.id).order('created_at', { ascending: false }).limit(1).single()
    const now = Date.now()
    const { error } = await admin.from('messages').update({
      metadata: {
        embeds: {
          [MIRRORED]: {
            cacheKey: `x:${MIRRORED}`, url: MIRRORED, normalizedUrl: MIRRORED, provider: 'x',
            title: 'NASA (@NASA)', description: 'Rollout day', siteName: 'X (Twitter)', image: PHOTO,
            media: [{ type: 'image', url: PHOTO, width: 1280, height: 960 }],
            social: { platform: 'x', url: POST, author: { name: 'NASA', handle: '@NASA' }, text: 'Rollout day', publishedAt: '2026-10-20T15:05:00.000Z' },
            fetchedAt: new Date(now).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString(),
          },
        },
      },
    }).eq('id', stored!.id)
    if (error) throw new Error(`embeds: ${error.message}`)
    await openChannel(page, server.id, server.generalChannelId)
    const card = messageList(page).locator('.message-item').filter({ hasText: 'mirroron ' }).locator('[data-testid="social-embed"]')
    await expect(card).toBeVisible({ timeout: 30000 })
    await expect(card).toHaveAttribute('data-platform', 'x')
    await expect(card.getByTestId('social-embed-text')).toHaveText('Rollout day')
  })
})

test('with the X mirror turned off in Appearance, a sent link stays as typed', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, user)
  await page.goto('/settings/appearance')
  await dismissAnnouncements(page)

  const section = page.getByTestId('mirror-links-settings')
  await expect(section).toBeVisible({ timeout: 30000 })
  await expect(section).toContainText('people outside Harmony see the mirror link')
  const xToggle = section.getByRole('switch', { name: 'X posts' })
  await expect(xToggle).toHaveAttribute('aria-checked', 'true')
  await expect(section.getByTestId('mirror-host-x')).toHaveValue('fixupx.com')
  await expect(section.getByRole('switch', { name: 'Instagram posts' })).toHaveAttribute('aria-checked', 'false')
  await expect(section.getByRole('switch', { name: 'Bluesky posts' })).toHaveAttribute('aria-checked', 'false')

  await xToggle.click()
  await expect(xToggle).toHaveAttribute('aria-checked', 'false')
  await expect(section.getByTestId('mirror-host-x')).toBeDisabled()
  const saveBar = page.getByTestId('appearance-save-bar')
  await saveBar.getByRole('button', { name: 'Save changes' }).click()
  await expect(saveBar).toBeHidden()
  await expect.poll(storedMirrors).toMatchObject({ x: { enabled: false, host: 'fixupx.com' } })

  await openChannel(page, server.id, server.generalChannelId)
  expect(await send(page, 'mirroroff', OTHER_POST)).toEqual([OTHER_POST])
})
