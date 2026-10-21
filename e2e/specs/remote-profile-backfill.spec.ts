// Journey: a remote profile opened while its outbox backfill runs. The backfill stores the
// account's posts newest first, one row at a time, and each row reaches the open profile over
// realtime. Each takes its place by date: the newest stays on top and older posts fill in below
// it, never one on top of the other.
//
// The federation backend and the realtime service are absent from this stack. The rows are
// inserted through the service role in the backfill's order and spacing, and each row's
// feed_event, which the broadcast_post_event trigger sends, is delivered to the profile's
// feed:user channel in the page.

import { randomUUID } from 'node:crypto'
import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
const DOMAIN = 'backfill.example'
const POSTS = 8
let viewer: SpecUser
const remote = {
  id: randomUUID(),
  username: `fill${Date.now().toString(36)}`,
}

const label = (n: number) => `backfilled post ${n}`

test.beforeAll(async () => {
  viewer = await createUser(admin, 'rbf')
  const actor = `https://${DOMAIN}/users/${remote.username}`
  const { error } = await admin.from('profiles').insert({
    id: remote.id,
    username: remote.username,
    display_name: 'Backfill',
    domain: DOMAIN,
    is_local: false,
    federated_id: actor,
    inbox_url: `${actor}/inbox`,
    outbox_url: `${actor}/outbox`,
  })
  if (error) throw new Error(`remote profile: ${error.message}`)
})

test.afterAll(async () => {
  await admin.from('posts').delete().eq('author_id', remote.id)
  await admin.from('profiles').delete().eq('id', remote.id)
  await deleteUser(admin, viewer)
})

test('an outbox backfill fills a remote profile in date order, newest on top', async ({ page }) => {
  test.setTimeout(180_000)
  const posts = page.locator('.posts-tab [data-testid="post-item"]')

  await signIn(page, viewer)
  await page.goto(`/social/profile/@${remote.username}@${DOMAIN}`)
  await expect(page.locator('.name-handle-section .user-handle')).toContainText(remote.username, { timeout: 30000 })
  // Every post found on top of the list while the backfill runs.
  await page.evaluate(() => {
    const w = window as unknown as { __tops: string[] }
    w.__tops = []
    new MutationObserver(() => {
      const top = document.querySelector('.posts-tab [data-testid="post-item"]')?.textContent?.match(/backfilled post \d+/)?.[0]
      if (top && w.__tops[w.__tops.length - 1] !== top) w.__tops.push(top)
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  })
  // The profile's channel exists once the profile is shown.
  await expect.poll(() => page.evaluate(async (topic) => {
    const { supabase } = await import('/src/supabase.ts')
    return supabase.getChannels().some((c) => c.topic === topic)
  }, `realtime:feed:user:${remote.id}`), { timeout: 30000 }).toBe(true)

  // Post 1 is the newest, a minute apart; stored newest first as the outbox lists them.
  const actor = `https://${DOMAIN}/users/${remote.username}`
  const start = Date.UTC(2026, 9, 20)
  for (let n = 1; n <= POSTS; n++) {
    const { data, error } = await admin.from('posts').insert({
      author_id: remote.id,
      ap_id: `${actor}/statuses/${n}`,
      is_local: false,
      visibility: 'public',
      content: [{ type: 'text', text: label(n) }],
      created_at: new Date(start - n * 60_000).toISOString(),
    }).select('id').single()
    if (error) throw new Error(`post ${n}: ${error.message}`)
    await page.evaluate(async ({ topic, event }) => {
      const { supabase } = await import('/src/supabase.ts')
      const channel = supabase.getChannels().find((c) => c.topic === topic)!
      ;(channel as unknown as { _trigger: (type: string, payload: unknown) => void })
        ._trigger('broadcast', { type: 'broadcast', event: 'feed_event', payload: event })
    }, {
      topic: `realtime:feed:user:${remote.id}`,
      event: { type: 'post:new', post_id: data!.id, author_id: remote.id, visibility: 'public', is_local: false },
    })
    await page.waitForTimeout(300)
  }

  await expect(posts).toHaveCount(POSTS, { timeout: 30000 })
  const listed = await posts.evaluateAll((items) => items.map((el) => el.textContent?.match(/backfilled post \d+/)?.[0]))
  expect(listed).toEqual(Array.from({ length: POSTS }, (_, i) => label(i + 1)))
  expect(await page.evaluate(() => (window as unknown as { __tops: string[] }).__tops)).toEqual([label(1)])
})
