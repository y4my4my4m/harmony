// Journey: voting on fediverse polls from the home timeline. A followed remote account has a
// single-choice poll, a multiple-choice poll and a closed poll, stored as the federation
// backend stores an ActivityPub Question (posts.metadata poll keys).
//
//   - an open poll offers its answers and a Vote button, and shows results on request;
//   - a vote is final: the card turns to the counts with the caller's answer marked, the
//     count includes the vote, post_poll_votes holds it, and a reload keeps it;
//   - a multiple-choice poll takes several answers;
//   - a closed poll shows its counts only.
//
// Delivery of the vote to the poll author is the worker's federate-poll-vote job, absent
// here; the federation round trip (e2e/federation/cases/remoteInteractions.ts) covers it.

import crypto from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
let voter: SpecUser
const marker = Date.now().toString(36)
const domain = 'polls.e2e.test'
const remote = { id: crypto.randomUUID(), username: `rpoll${marker}` }

const polls = {
  single: { id: crypto.randomUUID(), text: `tea or coffee ${marker}` },
  multi: { id: crypto.randomUUID(), text: `pick your fruit ${marker}` },
  closed: { id: crypto.randomUUID(), text: `closed question ${marker}` },
}

const metadata = (names: string[], votes: number[], extra: Record<string, unknown> = {}) => ({
  is_poll: true,
  poll_options: names.map((name, i) => ({ name, votes: votes[i] })),
  poll_multiple_choice: false,
  poll_end_time: new Date(Date.now() + 2 * 86_400_000).toISOString(),
  poll_voters_count: votes.reduce((a, b) => a + b, 0),
  poll_closed: false,
  ...extra,
})

test.beforeAll(async () => {
  voter = await createUser(admin, 'pvote')
  const { error: profileError } = await admin.from('profiles').insert({
    id: remote.id,
    username: remote.username,
    display_name: 'Poll Author',
    domain,
    is_local: false,
    federated_id: `https://${domain}/users/${remote.username}`,
    inbox_url: `https://${domain}/users/${remote.username}/inbox`,
  })
  if (profileError) throw new Error(`remote profile: ${profileError.message}`)
  const { error: followError } = await admin.from('follows').insert({ follower_id: voter.id, following_id: remote.id, status: 'accepted' })
  if (followError) throw new Error(`follow: ${followError.message}`)

  const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString()
  const poll = (p: { id: string; text: string }, secondsAgo: number, meta: Record<string, unknown>) => ({
    id: p.id,
    author_id: remote.id,
    visibility: 'public',
    is_local: false,
    ap_type: 'Question',
    ap_id: `https://${domain}/users/${remote.username}/statuses/${p.id}`,
    url: `https://${domain}/@${remote.username}/${p.id}`,
    content: [{ type: 'text', text: p.text }],
    created_at: at(secondsAgo),
    metadata: meta,
  })
  const { error: postError } = await admin.from('posts').insert([
    poll(polls.single, 30, metadata(['Tea', 'Coffee', 'Water'], [2, 1, 0])),
    poll(polls.multi, 20, metadata(['Apple', 'Pear', 'Plum'], [0, 0, 0], { poll_multiple_choice: true, poll_voters_count: 0 })),
    poll(polls.closed, 10, metadata(['Yes', 'No'], [3, 1], { poll_closed: true })),
  ])
  if (postError) throw new Error(`polls: ${postError.message}`)
})

test.afterAll(async () => {
  await admin.from('profiles').delete().eq('id', remote.id)
  await deleteUser(admin, voter)
})

const pollOf = (page: Page, text: string) =>
  page.locator('[data-testid="post-item"]').filter({ hasText: text }).first().locator('[data-testid="remote-poll"]')

async function votesOf(postId: string): Promise<number[]> {
  const { data } = await admin.from('post_poll_votes').select('choice').eq('post_id', postId).eq('user_id', voter.id).order('choice')
  return (data ?? []).map((r) => r.choice)
}

test('a remote poll takes the reader\'s vote once and keeps it', async ({ page }) => {
  test.setTimeout(180_000)

  await test.step('sign in and open the home timeline', async () => {
    await signIn(page, voter)
    await page.goto('/social/home')
    await expect(page.locator('[data-testid="timeline-feed"]')).toBeVisible({ timeout: 90000 })
    await expect(pollOf(page, polls.single.text)).toBeVisible({ timeout: 30000 })
  })

  const single = pollOf(page, polls.single.text)

  await test.step('an open poll offers its answers; results show on request', async () => {
    await expect(single.locator('[data-testid="remote-poll-option"]')).toHaveCount(3)
    await expect(single.locator('[data-testid="remote-poll-option"]').first()).toHaveAttribute('role', 'radio')
    await expect(single.locator('[data-testid="remote-poll-vote"]')).toBeDisabled()
    await single.locator('[data-testid="remote-poll-results"]').click()
    await expect(single.locator('[data-testid="remote-poll-result"]')).toHaveCount(3)
    await expect(single.locator('[data-testid="remote-poll-result"]').first()).toContainText('67%')
    await single.locator('[data-testid="remote-poll-results"]').click()
    await expect(single.locator('[data-testid="remote-poll-option"]')).toHaveCount(3)
  })

  await test.step('the vote turns the card to the counts with the answer marked', async () => {
    await single.locator('[data-testid="remote-poll-option"]').filter({ hasText: 'Coffee' }).click()
    await expect(single.locator('[data-testid="remote-poll-option"]').filter({ hasText: 'Coffee' })).toHaveAttribute('aria-checked', 'true')
    await single.locator('[data-testid="remote-poll-vote"]').click()
    await expect(single.locator('[data-testid="remote-poll-result"]')).toHaveCount(3, { timeout: 30000 })
    await expect(single.locator('[data-testid="remote-poll-result"].is-mine')).toHaveCount(1)
    await expect(single.locator('[data-testid="remote-poll-result"].is-mine')).toContainText('Coffee')
    await expect(single.locator('[data-testid="remote-poll-result"]').filter({ hasText: 'Coffee' })).toContainText('50%')
    await expect(single.locator('[data-testid="remote-poll-voters"]')).toHaveText('4 people voted')
    await expect(single.locator('[data-testid="remote-poll-vote"]')).toHaveCount(0)
    await expect.poll(() => votesOf(polls.single.id), { timeout: 15000 }).toEqual([1])
  })

  await test.step('a multiple-choice poll takes several answers', async () => {
    const multi = pollOf(page, polls.multi.text)
    await expect(multi.locator('[data-testid="remote-poll-option"]').first()).toHaveAttribute('role', 'checkbox')
    await multi.locator('[data-testid="remote-poll-option"]').filter({ hasText: 'Plum' }).click()
    await multi.locator('[data-testid="remote-poll-option"]').filter({ hasText: 'Apple' }).click()
    await multi.locator('[data-testid="remote-poll-vote"]').click()
    await expect(multi.locator('[data-testid="remote-poll-result"].is-mine')).toHaveCount(2, { timeout: 30000 })
    await expect(multi.locator('[data-testid="remote-poll-voters"]')).toHaveText('1 person voted')
    await expect.poll(() => votesOf(polls.multi.id), { timeout: 15000 }).toEqual([0, 2])
  })

  await test.step('a closed poll shows its counts only', async () => {
    const closed = pollOf(page, polls.closed.text)
    await expect(closed.locator('[data-testid="remote-poll-result"]')).toHaveCount(2)
    await expect(closed.locator('[data-testid="remote-poll-option"]')).toHaveCount(0)
    await expect(closed).toContainText('Poll closed')
  })

  await test.step('the votes survive a reload', async () => {
    await page.reload()
    await expect(pollOf(page, polls.single.text).locator('[data-testid="remote-poll-result"].is-mine')).toContainText('Coffee', { timeout: 60000 })
    await expect(pollOf(page, polls.single.text).locator('[data-testid="remote-poll-option"]')).toHaveCount(0)
    await expect(pollOf(page, polls.multi.text).locator('[data-testid="remote-poll-result"].is-mine')).toHaveCount(2)
  })
})
