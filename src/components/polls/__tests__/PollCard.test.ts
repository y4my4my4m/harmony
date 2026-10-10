/**
 * The poll card in a chat message: answers as buttons, results after a vote or at the end,
 * optimistic votes through vote_message_poll, and the author's End poll.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const rpc = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())

vi.mock('@/supabase', () => ({ supabase: { rpc } }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: toastError, success: vi.fn() }) }))
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({
    t: (key: string, named?: Record<string, unknown>) => (named && 'count' in named ? `${key}:${named.count}` : key),
  }),
}))

import PollCard from '../PollCard.vue'

const PART = {
  type: 'poll' as const,
  pollId: 'p1',
  question: 'Lunch?',
  options: ['Pizza', 'Sushi'],
  allowMultiple: false,
  expiresAt: '2099-01-01T00:00:00Z',
}

const row = (over: Record<string, unknown> = {}) => ({
  poll_id: 'p1',
  message_id: 'm1',
  question: 'Lunch?',
  allow_multiple: false,
  expires_at: '2099-01-01T00:00:00Z',
  closed: false,
  total_voters: 3,
  options: [
    { id: 'a', position: 0, text: 'Pizza', votes: 2 },
    { id: 'b', position: 1, text: 'Sushi', votes: 1 },
  ],
  my_option_ids: [],
  is_author: false,
  ...over,
})

async function render(polls: Record<string, unknown>[] = [row()], props: Record<string, unknown> = {}) {
  rpc.mockImplementation(async (fn: string) => (fn === 'get_message_polls' ? { data: polls, error: null } : { data: null, error: null }))
  const wrapper = mount(PollCard, {
    props: { poll: PART, messageId: 'm1', ...props },
    global: { stubs: { Icon: true } },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  await flushPromises()
  return wrapper
}

const options = (w: Awaited<ReturnType<typeof render>>) => w.findAll('[data-testid="poll-option"]')

beforeEach(() => {
  setActivePinia(createPinia())
  rpc.mockReset()
  toastError.mockReset()
})
afterEach(() => { document.body.innerHTML = '' })

describe('PollCard', () => {
  it('shows the answers without results before the caller votes', async () => {
    const w = await render()
    expect(rpc).toHaveBeenCalledWith('get_message_polls', { p_poll_ids: ['p1'] })
    expect(w.text()).toContain('Lunch?')
    expect(options(w).map((o) => o.text())).toEqual(['Pizza', 'Sushi'])
    expect(w.find('.poll-option-percent').exists()).toBe(false)
    expect(w.find('[data-testid="poll-voters"]').text()).toBe('polls.votes:3')
  })

  it('votes optimistically and then shows results', async () => {
    const w = await render()
    let answer!: (v: unknown) => void
    rpc.mockImplementation((fn: string) => fn === 'vote_message_poll'
      ? new Promise((resolve) => { answer = resolve })
      : Promise.resolve({ data: [], error: null }))

    await options(w)[1].trigger('click')
    expect(rpc).toHaveBeenCalledWith('vote_message_poll', { p_poll_id: 'p1', p_option_ids: ['b'] })
    expect(options(w)[1].attributes('aria-checked')).toBe('true')
    expect(w.findAll('.poll-option-percent').map((p) => p.text())).toEqual(['50%', '50%'])

    answer({ data: [row({ total_voters: 4, my_option_ids: ['b'], options: [
      { id: 'a', position: 0, text: 'Pizza', votes: 2 },
      { id: 'b', position: 1, text: 'Sushi', votes: 2 },
    ] })], error: null })
    await flushPromises()
    expect(w.find('[data-testid="poll-voters"]').text()).toBe('polls.votes:4')
    expect(w.find('[data-testid="poll-remove-vote"]').exists()).toBe(true)
  })

  it('removes the vote with an empty answer list', async () => {
    const w = await render([row({ my_option_ids: ['a'] })])
    rpc.mockResolvedValue({ data: [row()], error: null })
    await w.find('[data-testid="poll-remove-vote"]').trigger('click')
    expect(rpc).toHaveBeenCalledWith('vote_message_poll', { p_poll_id: 'p1', p_option_ids: [] })
  })

  it('toggles answers of a multiple-choice poll', async () => {
    const w = await render([row({ allow_multiple: true, my_option_ids: ['a'] })])
    rpc.mockResolvedValue({ data: [row({ allow_multiple: true, my_option_ids: ['a', 'b'] })], error: null })
    await options(w)[1].trigger('click')
    expect(rpc).toHaveBeenCalledWith('vote_message_poll', { p_poll_id: 'p1', p_option_ids: ['a', 'b'] })
    expect(options(w)[0].attributes('role')).toBe('checkbox')
  })

  it('reports a failed vote and restores the answers', async () => {
    const w = await render()
    rpc.mockImplementation(async (fn: string) => fn === 'vote_message_poll'
      ? { data: null, error: { message: 'POLL_CLOSED: the poll has ended' } }
      : { data: [row({ closed: true })], error: null })
    await options(w)[0].trigger('click')
    await flushPromises()
    expect(toastError).toHaveBeenCalledWith('polls.errors.closed')
    expect(options(w)[0].attributes('aria-checked')).toBe('false')
  })

  it('shows results and takes no vote once closed', async () => {
    const w = await render([row({ closed: true })])
    expect(w.text()).toContain('polls.closed')
    expect(w.findAll('.poll-option-percent').map((p) => p.text())).toEqual(['67%', '33%'])
    expect(options(w).every((o) => o.attributes('disabled') !== undefined)).toBe(true)
  })

  it('offers End poll to the author', async () => {
    const w = await render([row({ is_author: true })])
    rpc.mockResolvedValue({ data: [row({ is_author: true, closed: true })], error: null })
    await w.find('[data-testid="poll-end"]').trigger('click')
    await flushPromises()
    expect(rpc).toHaveBeenCalledWith('end_message_poll', { p_poll_id: 'p1' })
    expect(w.text()).toContain('polls.closed')
    expect(w.find('[data-testid="poll-end"]').exists()).toBe(false)
  })

  it('reads a poll it cannot load, or of another message, as unavailable', async () => {
    const missing = await render([])
    expect(missing.text()).toContain('polls.unavailable')
    expect(options(missing).map((o) => o.text())).toEqual(['Pizza', 'Sushi'])

    setActivePinia(createPinia())
    const foreign = await render([row({ message_id: 'other' })])
    expect(foreign.text()).toContain('polls.unavailable')
    expect(options(foreign).every((o) => o.attributes('disabled') !== undefined)).toBe(true)
  })
})
