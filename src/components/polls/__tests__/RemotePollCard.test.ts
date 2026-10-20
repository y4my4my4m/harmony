/**
 * The fediverse poll card: answers to choose and a Vote button until the caller votes, then
 * the counts vote_remote_poll returns with the caller's answers marked; closed polls and
 * cards without a post show the counts only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const rpc = vi.hoisted(() => vi.fn())
const myVotes = vi.hoisted(() => ({ rows: [] as Array<{ post_id: string; choice: number }>, reads: 0 }))
const toastError = vi.hoisted(() => vi.fn())

vi.mock('@/supabase', () => ({
  supabase: {
    rpc,
    from: () => ({
      select: () => ({
        in: async (_c: string, ids: string[]) => {
          myVotes.reads++
          return { data: myVotes.rows.filter((r) => ids.includes(r.post_id)), error: null }
        },
      }),
    }),
  },
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: toastError, success: vi.fn() }) }))
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({
    t: (key: string, named?: Record<string, unknown>) => (named && 'count' in named ? `${key}:${named.count}` : key),
  }),
}))

import RemotePollCard from '../RemotePollCard.vue'

const metadata = (over: Record<string, unknown> = {}) => ({
  is_poll: true,
  poll_options: [{ name: 'Tea', votes: 2 }, { name: 'Coffee', votes: 1 }, { name: 'Water', votes: 0 }],
  poll_multiple_choice: false,
  poll_end_time: '2999-01-01T00:00:00Z',
  poll_voters_count: 3,
  poll_closed: false,
  ...over,
})

async function render(props: Record<string, unknown>) {
  const wrapper = mount(RemotePollCard, { props, global: { stubs: { Icon: true } } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  await flushPromises()
  return wrapper
}

const choices = (w: Awaited<ReturnType<typeof render>>) => w.findAll('[data-testid="remote-poll-option"]')
const results = (w: Awaited<ReturnType<typeof render>>) => w.findAll('[data-testid="remote-poll-result"]')

afterEach(() => {
  rpc.mockReset()
  toastError.mockReset()
  myVotes.rows = []
  myVotes.reads = 0
})

describe('RemotePollCard', () => {
  it('offers the answers as radios and votes the chosen one', async () => {
    rpc.mockResolvedValue({ data: metadata({ poll_options: [{ name: 'Tea', votes: 2 }, { name: 'Coffee', votes: 2 }, { name: 'Water', votes: 0 }], poll_voters_count: 4 }), error: null })
    const w = await render({ metadata: metadata(), postId: 'p1' })

    expect(choices(w)).toHaveLength(3)
    expect(choices(w).map((c) => c.attributes('role'))).toEqual(['radio', 'radio', 'radio'])
    expect(w.find('[data-testid="remote-poll-vote"]').attributes('disabled')).toBeDefined()

    await choices(w)[0].trigger('click')
    await choices(w)[1].trigger('click')
    expect(choices(w).map((c) => c.attributes('aria-checked'))).toEqual(['false', 'true', 'false'])

    await w.find('[data-testid="remote-poll-vote"]').trigger('click')
    await flushPromises()

    expect(rpc).toHaveBeenCalledWith('vote_remote_poll', { p_post_id: 'p1', p_choices: [1] })
    expect(choices(w)).toHaveLength(0)
    expect(results(w).map((r) => r.classes().includes('is-mine'))).toEqual([false, true, false])
    expect(w.find('[data-testid="remote-poll-voters"]').text()).toBe('polls.remote.voters:4')
    expect(w.find('[data-testid="remote-poll-vote"]').exists()).toBe(false)
  })

  it('takes several answers on a multiple-choice poll', async () => {
    rpc.mockResolvedValue({ data: metadata({ poll_multiple_choice: true }), error: null })
    const w = await render({ metadata: metadata({ poll_multiple_choice: true }), postId: 'p1' })
    expect(choices(w)[0].attributes('role')).toBe('checkbox')
    await choices(w)[2].trigger('click')
    await choices(w)[0].trigger('click')
    await w.find('[data-testid="remote-poll-vote"]').trigger('click')
    await flushPromises()
    expect(rpc).toHaveBeenCalledWith('vote_remote_poll', { p_post_id: 'p1', p_choices: [0, 2] })
  })

  it('shows the counts with the caller\'s answer when the caller has voted', async () => {
    myVotes.rows = [{ post_id: 'p1', choice: 0 }]
    const w = await render({ metadata: metadata(), postId: 'p1' })
    expect(choices(w)).toHaveLength(0)
    expect(results(w).map((r) => r.classes().includes('is-mine'))).toEqual([true, false, false])
  })

  it('reads the caller\'s votes of several cards in one query', async () => {
    mount(RemotePollCard, { props: { metadata: metadata(), postId: 'p1' }, global: { stubs: { Icon: true } } })
    mount(RemotePollCard, { props: { metadata: metadata(), postId: 'p2' }, global: { stubs: { Icon: true } } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await flushPromises()
    expect(myVotes.reads).toBe(1)
  })

  it('shows a closed poll\'s counts and takes no vote', async () => {
    const w = await render({ metadata: metadata({ poll_closed: true }), postId: 'p1' })
    expect(choices(w)).toHaveLength(0)
    expect(results(w)).toHaveLength(3)
    expect(w.find('[data-testid="remote-poll-vote"]').exists()).toBe(false)
  })

  it('shows results on request before voting', async () => {
    const w = await render({ metadata: metadata(), postId: 'p1' })
    await w.find('[data-testid="remote-poll-results"]').trigger('click')
    expect(results(w)).toHaveLength(3)
    expect(w.find('[data-testid="remote-poll-results"]').text()).toBe('polls.hideResults')
  })

  it('reads the stored answers back when the vote was already cast', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'POLL_ALREADY_VOTED: a vote is final' } })
    const w = await render({ metadata: metadata(), postId: 'p1' })
    myVotes.rows = [{ post_id: 'p1', choice: 2 }]
    await choices(w)[0].trigger('click')
    await w.find('[data-testid="remote-poll-vote"]').trigger('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await flushPromises()
    expect(toastError).toHaveBeenCalledWith('polls.errors.alreadyVoted')
    expect(results(w).map((r) => r.classes().includes('is-mine'))).toEqual([false, false, true])
  })

  it('closes the card when the poll ended meanwhile', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'POLL_CLOSED: the poll has ended' } })
    const w = await render({ metadata: metadata(), postId: 'p1' })
    await choices(w)[0].trigger('click')
    await w.find('[data-testid="remote-poll-vote"]').trigger('click')
    await flushPromises()
    expect(toastError).toHaveBeenCalledWith('polls.errors.closed')
    expect(results(w)).toHaveLength(3)
  })

  it('without a post shows the counts and links the original', async () => {
    const w = await render({ metadata: metadata(), originalUrl: 'https://mastodon.test/@carol/1' })
    expect(choices(w)).toHaveLength(0)
    expect(results(w)).toHaveLength(3)
    expect(w.find('a').attributes('href')).toBe('https://mastodon.test/@carol/1')
    expect(myVotes.reads).toBe(0)
  })
})
