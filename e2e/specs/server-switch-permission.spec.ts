// Journey: the composer stays writable across server switches. A switch asks get_user_permissions
// for the new server with the previous channel, and that pair answers with no permission
// (20261109600001). The route below holds that answer back until the others have landed: the
// order that replaced the field with "You do not have permission to send messages in this channel."

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  composer,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  sendMessage,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let member: SpecUser
let one: SeededServer
let two: SeededServer

const REFUSED = 'You do not have permission to send messages in this channel.'
const HOLD_MS = 1500

test.beforeAll(async () => {
  member = await createUser(admin, 'swperm')
  one = await seedServer(admin, member, `Switch one ${member.username.slice(-6)}`)
  two = await seedServer(admin, member, `Switch two ${member.username.slice(-6)}`)
})

test.afterAll(async () => {
  await deleteUser(admin, member)
})

/** Delays each get_user_permissions whose channel is outside the server asked about. */
async function holdMismatched(page: Page): Promise<string[]> {
  const home = new Map([
    [one.generalChannelId, one.id],
    [two.generalChannelId, two.id],
  ])
  const held: string[] = []
  await page.route('**/rest/v1/rpc/get_user_permissions', async (route) => {
    const body = route.request().postDataJSON() as { p_server_id?: string; p_channel_id?: string | null }
    const server = body.p_channel_id ? home.get(body.p_channel_id) : undefined
    if (server && server !== body.p_server_id) {
      held.push(`${body.p_server_id}/${body.p_channel_id}`)
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS))
    }
    await route.continue()
  })
  return held
}

const serverButton = (page: Page, server: SeededServer) =>
  page.locator('nav[aria-label="Servers"]').getByRole('button', { name: new RegExp(`^${server.name}`) })

test('the composer stays writable when the previous channel\'s answer arrives last', async ({ page }) => {
  test.setTimeout(120000)
  await signIn(page, member)
  await openChannel(page, one.id, one.generalChannelId)
  const held = await holdMismatched(page)

  for (const target of [two, one, two]) {
    await serverButton(page, target).click()
    await page.waitForURL(new RegExp(`/chat/${target.id}/`), { timeout: 30000 })
    await expect(composer(page)).toBeVisible({ timeout: 30000 })
    // Past the held answer.
    await page.waitForTimeout(HOLD_MS + 1000)
    await expect(page.getByText(REFUSED)).toHaveCount(0)
    await expect(composer(page)).toBeVisible()
  }

  await sendMessage(page, `sent after three switches ${member.username.slice(-6)}`)
  test.info().annotations.push({ type: 'held', description: String(held.length) })
})
