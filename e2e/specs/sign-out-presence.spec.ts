// Journey: signing out leaves the account offline. Sign-out ends this tab's presence
// (presence_offline) first and then waits on two bounded writes (push detach, view context
// 'away'). Before 1.9.8 the minute heartbeat kept running through that wait: a heartbeat landing
// after presence_offline listed the device again, and the account showed online to everyone for
// up to presence_sweep's 150 s after it signed out.
//
// The page runs on a clock the test controls: it pauses the clock just before the next heartbeat,
// holds the 'away' write, and lets the heartbeat's minute come due while sign-out waits on it.

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'

const admin = adminClient()
let user: SpecUser

test.beforeAll(async () => {
  user = await createUser(admin, 'signoutpres')
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

const HEARTBEAT_MS = 60_000

async function devices(): Promise<string[]> {
  const { data, error } = await admin.from('presence_devices').select('device_id').eq('profile_id', user.id)
  if (error) throw new Error(`presence_devices: ${error.message}`)
  return (data ?? []).map((row) => row.device_id as string)
}

test('signing out leaves the account offline while sign-out waits on its last writes', async ({ page }) => {
  test.setTimeout(120_000)
  await page.clock.install()
  // Page-clock time of every presence write, in the order sent.
  await page.addInitScript(() => {
    const sent: Array<{ fn: string; at: number }> = []
    ;(window as unknown as { __presence: typeof sent }).__presence = sent
    const original = window.fetch
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const fn = /\/rpc\/(presence_heartbeat|presence_offline)$/.exec(new URL(url, location.href).pathname)?.[1]
      if (fn) sent.push({ fn, at: Date.now() })
      return original.call(this, input, init)
    }
  })
  const presence = () => page.evaluate(() => (window as unknown as { __presence: Array<{ fn: string; at: number }> }).__presence)

  await signIn(page, user)
  await page.goto('/settings/account')
  await dismissAnnouncements(page)
  const logOut = page.getByRole('button', { name: 'Log out' })
  await expect(logOut).toBeVisible({ timeout: 30000 })
  await expect.poll(async () => (await presence()).filter((p) => p.fn === 'presence_heartbeat').length, { timeout: 15000 }).toBeGreaterThan(0)
  await expect.poll(devices, { timeout: 15000 }).toHaveLength(1)

  await test.step('the clock stops just before the next heartbeat is due', async () => {
    const started = (await presence()).find((p) => p.fn === 'presence_heartbeat')!.at
    const now = await page.evaluate(() => Date.now())
    const due = started + HEARTBEAT_MS * Math.ceil((now - started + 1_000) / HEARTBEAT_MS)
    await page.clock.pauseAt(due - 300)
  })

  await test.step('sign out; the heartbeat minute comes due while the away write is held', async () => {
    let held = false
    await page.route('**/rpc/sync_view_context_from_presence', async (route) => {
      if ((route.request().postDataJSON() as { p_view_type?: string } | null)?.p_view_type !== 'away' || held) {
        await route.fallback()
        return
      }
      held = true
      // Short of the 2 s bound sign-out puts on this write.
      await page.clock.runFor(1_500)
      await page.waitForTimeout(1_500)
      await route.fallback()
    })
    await logOut.click()
    await expect.poll(() => held, { timeout: 15000 }).toBe(true)
    await page.clock.resume()
    await expect(page).toHaveURL(/\/login/, { timeout: 30000 })
  })

  await test.step('presence_offline is the last presence write, and no device is listed', async () => {
    const sent = (await presence()).map((p) => p.fn)
    expect(sent.at(-1)).toBe('presence_offline')
    await page.waitForTimeout(1_000)
    expect(await devices()).toEqual([])
  })
})
