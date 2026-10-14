// Journey: the server rail's edges. The mention badge of the first server sits whole inside
// the rail; it overhangs its icon by 6px and the rail clipped it. Scrolled, entries fade out
// under the top and bottom edges instead of being cut there; at rest the edge with nothing
// beyond it does not fade.
//
// The reader belongs to enough servers for the rail to scroll at a phone's height. The first
// server's mentions come from messages naming the reader, written by the service role.

import { test, expect, type Page } from '@playwright/test'
import { addMember, adminClient, createUser, deleteUser, dismissAnnouncements, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

const admin = adminClient()
let owner: SpecUser
let reader: SpecUser
const servers: SeededServer[] = []

test.beforeAll(async () => {
  owner = await createUser(admin, 'rleo')
  reader = await createUser(admin, 'rler')
  for (let i = 0; i < 14; i++) {
    const server = await seedServer(admin, owner, `Rail ${i} ${owner.username}`)
    await addMember(admin, reader, server.id)
    servers.push(server)
  }
  const { data: first } = await admin.from('user_servers').select('server_id')
    .eq('user_id', reader.id).order('position', { ascending: true }).limit(1).single()
  const top = servers.find((s) => s.id === first!.server_id)!
  const mention = { type: 'mention', userId: reader.id, username: reader.username, domain: 'localhost', isLocal: true }
  const { error } = await admin.from('messages').insert(Array.from({ length: 3 }, (_, i) => ({
    channel_id: top.generalChannelId,
    user_id: owner.id,
    content: [mention, { type: 'text', text: ` ping ${i}` }],
  })))
  if (error) throw new Error(`mentions: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, reader)
  await deleteUser(admin, owner)
})

const rail = (page: Page) => page.locator('.servers-scroll-area')

test('the first server badge is whole and scrolled entries fade at the rail edges', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1280, height: 640 })
  await signIn(page, reader)
  // Direct messages: opening a server would read its mentions.
  await page.goto('/dm')
  await dismissAnnouncements(page)

  const badge = rail(page).locator('.rail-entry').first().locator('.unread-badge')

  await test.step('the badge of the first server is inside the rail', async () => {
    await expect(badge).toHaveText('3', { timeout: 30000 })
    const box = (await badge.boundingBox())!
    const area = (await rail(page).boundingBox())!
    expect(box.y).toBeGreaterThanOrEqual(area.y)
  })

  await test.step('at the top only the bottom edge fades', async () => {
    await expect(rail(page)).toHaveClass(/fade-bottom/)
    await expect(rail(page)).not.toHaveClass(/fade-top/)
  })

  await test.step('scrolled to the end, only the top edge fades', async () => {
    await rail(page).evaluate((el) => { el.scrollTop = el.scrollHeight })
    await expect(rail(page)).toHaveClass(/fade-top/)
    await expect(rail(page)).not.toHaveClass(/fade-bottom/)
    const mask = await rail(page).evaluate((el) => getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage)
    expect(mask).toContain('linear-gradient')
  })
})
