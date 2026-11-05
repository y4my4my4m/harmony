// Journey: polls held by another instance (20261105990001_federated_message_polls.sql). In a copy
// of a server hosted elsewhere, a poll from the host shows the host's counts; a member picks an
// answer, sends it with Vote, sees it counted at once, and cannot change or remove it. A poll a
// Mastodon account sent in a direct message takes a final multiple-choice vote the same way, on
// a phone too. A copy whose host does not federate polls offers none and create_message_poll
// refuses one there.
//
// This stack has no federation backend: rows are written here as the backend writes them
// (store_federated_message_poll), and the vote's delivery is read off message_poll_outbox.

import { test, expect, devices, type Locator, type Page } from '@playwright/test'
import crypto from 'node:crypto'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  openChannel,
  signIn,
  userClient,
  type SpecUser,
} from './harness'

const admin = adminClient()
let member: SpecUser

const host = 'polls.example'
const hostUser = { id: crypto.randomUUID(), username: `fph${Date.now().toString(36)}` }
const masto = { id: crypto.randomUUID(), username: `fpm${Date.now().toString(36)}`, domain: 'masto.example' }
const copy = { id: crypto.randomUUID(), channel: crypto.randomUUID() }
const oldCopy = { id: crypto.randomUUID(), channel: crypto.randomUUID() }
const channelPoll = { message: crypto.randomUUID(), poll: crypto.randomUUID(), question: 'Lunch on the boat?' }
const dmPoll = { message: crypto.randomUUID(), poll: crypto.randomUUID(), question: 'Which snacks?' }
let conversation = ''

async function must<T extends { error: { message: string } | null }>(what: string, result: PromiseLike<T>): Promise<T> {
  const r = await result
  if (r.error) throw new Error(`${what}: ${r.error.message}`)
  return r
}

/** A copied server's row and channel, with `member` in it. */
async function seedCopy(id: string, channel: string, name: string, metadata: Record<string, unknown>) {
  const groupUrl = `https://${host}/servers/${id}`
  await must(name, admin.from('servers').insert({
    id, name, owner: hostUser.id, public: true, is_local_server: false, federation_enabled: true,
    ap_id: groupUrl, federation_inbox_url: `${groupUrl}/inbox`, federation_domain: host, federation_metadata: metadata,
  }))
  await admin.from('channels').delete().eq('server_id', id)
  await must(`${name} channel`, admin.from('channels').insert({
    id: channel, server_id: id, name: 'general', type: 0, is_remote: true, ap_id: `${groupUrl}/channels/${channel}`,
  }))
  await must(`${name} membership`, admin.from('user_servers').upsert(
    { server_id: id, user_id: member.id, status: 'accepted', member_instance: 'localhost' },
    { onConflict: 'user_id,server_id' },
  ))
}

/** A message holding a poll another instance holds, stored as the federation backend stores one. */
async function seedRemotePoll(
  where: { channel_id?: string; conversation_id?: string },
  author: string,
  poll: { message: string; poll: string; question: string },
  answers: string[],
  votes: number[],
  voters: number,
  allowMultiple: boolean,
) {
  const apId = `https://${host}/messages/${poll.message}`
  const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString()
  await must('poll message', admin.from('messages').insert({
    id: poll.message, user_id: author, ...where,
    content: [
      { type: 'poll', pollId: poll.poll, question: poll.question, options: answers, allowMultiple, expiresAt },
      { type: 'text', text: [`📊 ${poll.question}`, ...answers.map((a, i) => `${i + 1}. ${a}`)].join('\n') },
    ],
    metadata: { federated: true, ap_id: apId },
    federation_status: 'skipped',
  }))
  const { data, error } = await admin.rpc('store_federated_message_poll', {
    p_message_id: poll.message, p_poll_id: poll.poll, p_question: poll.question, p_options: answers,
    p_allow_multiple: allowMultiple, p_expires_at: expiresAt, p_remote: true, p_ap_id: apId,
    p_votes: votes, p_voters: voters,
  })
  if (error || data !== poll.poll) throw new Error(`store_federated_message_poll: ${error?.message ?? data}`)
}

test.beforeAll(async () => {
  member = await createUser(admin, 'fpoll')
  await must('remote people', admin.from('profiles').insert([
    {
      id: hostUser.id, username: hostUser.username, display_name: 'Host owner', domain: host, is_local: false,
      federated_id: `https://${host}/users/${hostUser.username}`, inbox_url: `https://${host}/users/${hostUser.username}/inbox`,
    },
    {
      id: masto.id, username: masto.username, display_name: 'Masto friend', domain: masto.domain, is_local: false,
      federated_id: `https://${masto.domain}/users/${masto.username}`, inbox_url: `https://${masto.domain}/users/${masto.username}/inbox`,
    },
  ]))
  await seedCopy(copy.id, copy.channel, 'Boat club', { message_polls: true })
  await seedCopy(oldCopy.id, oldCopy.channel, 'Old harbour', {})
  await seedRemotePoll({ channel_id: copy.channel }, hostUser.id, channelPoll, ['Pizza', 'Soup'], [3, 1], 4, false)

  const conv = await must('conversation', admin.from('conversations').insert({ type: 'direct', created_by: masto.id }).select('id').single())
  conversation = conv.data!.id
  await must('participants', admin.from('conversation_participants').insert([
    { conversation_id: conversation, user_id: member.id },
    { conversation_id: conversation, user_id: masto.id },
  ]))
  await seedRemotePoll({ conversation_id: conversation }, masto.id, dmPoll, ['Chips', 'Fruit', 'Nuts'], [0, 0, 0], 0, true)
})

test.afterAll(async () => {
  await admin.from('servers').delete().in('id', [copy.id, oldCopy.id])
  if (conversation) await admin.from('conversations').delete().eq('id', conversation)
  await admin.from('profiles').delete().in('id', [hostUser.id, masto.id])
  await deleteUser(admin, member)
})

const pollCard = (page: Page, question: string) =>
  messageList(page).locator('[data-testid="poll-card"]').filter({ hasText: question })
const option = (card: Locator, text: string) =>
  card.locator('[data-testid="poll-option"]').filter({ hasText: text })
const voters = (card: Locator) => card.locator('[data-testid="poll-voters"]')

async function openPlusMenu(page: Page): Promise<void> {
  await page.locator('[data-testid="composer-attach"]').click()
  await expect(page.locator('.file-upload-menu')).toBeVisible({ timeout: 15000 })
}

async function outbox(pollId: string): Promise<string[]> {
  const { data } = await admin.from('message_poll_outbox').select('kind, user_id').eq('poll_id', pollId)
  return (data ?? []).map((r: any) => `${r.kind}:${r.user_id === member.id ? 'member' : r.user_id}`)
}

/** Picks answers, sends them with Vote, and waits for vote_message_poll to land. */
async function voteOnce(page: Page, card: Locator, answers: string[]): Promise<void> {
  await expect(card).toContainText("Your vote can't be changed once sent")
  const vote = card.locator('[data-testid="poll-vote"]')
  await expect(vote).toBeDisabled()
  for (const answer of answers) {
    await option(card, answer).click()
    await expect(option(card, answer)).toHaveAttribute('aria-checked', 'true')
  }
  // Picking sends nothing; Vote does.
  await expect(card.locator('.poll-option-percent')).toHaveCount(0)
  const saved = page.waitForResponse((r) => r.url().includes('/rpc/vote_message_poll'))
  await vote.click()
  expect((await saved).ok()).toBe(true)
}

test('a copy channel shows the host\'s poll and its counts; a vote is sent once and stays', async ({ page }) => {
  test.setTimeout(150_000)
  const card = pollCard(page, channelPoll.question)

  await test.step('the host\'s counts', async () => {
    await signIn(page, member)
    await openChannel(page, copy.id, copy.channel)
    await expect(card).toBeVisible({ timeout: 30000 })
    await expect(voters(card)).toHaveText('4 votes', { timeout: 30000 })
    await expect(card.locator('[data-testid="poll-option"]')).toHaveText([/Pizza/, /Soup/])
  })

  await test.step('pick Soup, then Vote', async () => {
    await voteOnce(page, card, ['Soup'])
    await expect(voters(card)).toHaveText('5 votes')
    await expect(option(card, 'Soup').locator('.poll-option-percent')).toHaveText('40%')
    await expect(option(card, 'Pizza').locator('.poll-option-percent')).toHaveText('60%')
    await expect(card.locator('[data-testid="poll-vote"]')).toHaveCount(0)
    await expect(card.locator('[data-testid="poll-remove-vote"]')).toHaveCount(0)
    await expect(option(card, 'Pizza')).toBeDisabled()
    expect(await outbox(channelPoll.poll)).toEqual(['vote:member'])
  })

  await test.step('reloaded: the vote stays the member\'s', async () => {
    await page.reload()
    await expect(card).toBeVisible({ timeout: 30000 })
    await expect(voters(card)).toHaveText('5 votes', { timeout: 30000 })
    await expect(option(card, 'Soup')).toHaveAttribute('aria-checked', 'true')
    await expect(option(card, 'Soup')).toBeDisabled()
  })

  await test.step('a second vote is refused', async () => {
    const client = await userClient(member)
    const { data: polls } = await client.rpc('get_message_polls', { p_poll_ids: [channelPoll.poll] })
    const pizza = (polls?.[0]?.options ?? []).find((o: any) => o.text === 'Pizza')?.id
    const { error } = await client.rpc('vote_message_poll', { p_poll_id: channelPoll.poll, p_option_ids: [pizza] })
    expect(error?.message ?? '').toContain('POLL_ALREADY_VOTED')
  })
})

test('a copy whose host does not federate polls offers none', async ({ page }) => {
  test.setTimeout(150_000)

  await test.step('create_message_poll refuses the copy', async () => {
    const client = await userClient(member)
    const { error } = await client.rpc('create_message_poll', {
      p_channel_id: oldCopy.channel, p_conversation_id: null, p_question: 'Sail?', p_options: ['Yes', 'No'],
    })
    expect(error?.message ?? '').toContain('POLL_HOST_UNSUPPORTED')
  })

  await test.step('its + menu has no Create poll; the other copy\'s has', async () => {
    await signIn(page, member)
    await openChannel(page, oldCopy.id, oldCopy.channel)
    await openPlusMenu(page)
    await expect(page.locator('[data-testid="upload-menu-file"]')).toBeVisible()
    await expect(page.locator('[data-testid="upload-menu-poll"]')).toHaveCount(0)
    await page.keyboard.press('Escape')

    await openChannel(page, copy.id, copy.channel)
    await openPlusMenu(page)
    await expect(page.locator('[data-testid="upload-menu-poll"]')).toBeVisible()
  })
})

test.describe('on a phone', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
  test.use({ viewport: { width: 375, height: viewport.height }, userAgent, deviceScaleFactor, isMobile, hasTouch })

  test('a poll a Mastodon account sent in a direct message takes a final multiple-choice vote', async ({ page }) => {
    test.setTimeout(150_000)
    const card = pollCard(page, dmPoll.question)

    await signIn(page, member)
    await page.goto(`/dm/${conversation}`)
    await dismissAnnouncements(page)
    await expect(card).toBeVisible({ timeout: 30000 })
    await expect(voters(card)).toHaveText('0 votes', { timeout: 30000 })
    await expect(card.locator('[data-testid="poll-option"]').first()).toHaveAttribute('role', 'checkbox')

    const box = await card.boundingBox()
    expect(box && box.x >= 0 && box.x + box.width <= 375).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    await voteOnce(page, card, ['Chips', 'Nuts'])
    await expect(voters(card)).toHaveText('1 vote')
    await expect(option(card, 'Chips').locator('.poll-option-percent')).toHaveText('100%')
    await expect(option(card, 'Fruit').locator('.poll-option-percent')).toHaveText('0%')
    await expect(card.locator('[data-testid="poll-remove-vote"]')).toHaveCount(0)
    expect(await outbox(dmPoll.poll)).toEqual(['vote:member'])

    await page.reload()
    await expect(card).toBeVisible({ timeout: 30000 })
    await expect(option(card, 'Nuts')).toHaveAttribute('aria-checked', 'true')
    await expect(option(card, 'Fruit')).toBeDisabled()
  })
})
