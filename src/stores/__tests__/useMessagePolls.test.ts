import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { MessagePollState } from '@/services/MessagePollService'

const api = vi.hoisted(() => ({
  fetchMessagePolls: vi.fn(),
  voteMessagePoll: vi.fn(),
  endMessagePoll: vi.fn(),
}))
vi.mock('@/services/MessagePollService', () => api)

import { useMessagePollsStore, withPollChoice } from '@/stores/useMessagePolls'

const poll = (over: Partial<MessagePollState> = {}): MessagePollState => ({
  pollId: 'p1',
  messageId: 'm1',
  question: 'Lunch?',
  allowMultiple: false,
  expiresAt: '2099-01-01T00:00:00Z',
  closed: false,
  totalVoters: 2,
  options: [
    { id: 'a', position: 0, text: 'Pizza', votes: 2 },
    { id: 'b', position: 1, text: 'Sushi', votes: 0 },
  ],
  myOptionIds: [],
  isAuthor: false,
  ...over,
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  setActivePinia(createPinia())
  api.fetchMessagePolls.mockReset()
  api.voteMessagePoll.mockReset()
  api.endMessagePoll.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('poll loading', () => {
  it('batches requests made in the same tick into one call', async () => {
    api.fetchMessagePolls.mockResolvedValue([poll(), poll({ pollId: 'p2', messageId: 'm2' })])
    const store = useMessagePollsStore()
    store.request('p1')
    store.request('p2')
    store.request('p3')
    await tick()
    await tick()
    expect(api.fetchMessagePolls).toHaveBeenCalledTimes(1)
    expect(api.fetchMessagePolls).toHaveBeenCalledWith(['p1', 'p2', 'p3'])
    expect(store.get('p2')?.messageId).toBe('m2')
    expect(store.isUnavailable('p3')).toBe(true)

    store.request('p1')
    store.request('p3')
    await tick()
    expect(api.fetchMessagePolls).toHaveBeenCalledTimes(1)
  })

  it('reads a held poll again once it is a minute old', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-10-10T12:00:00Z'))
    api.fetchMessagePolls.mockResolvedValue([poll()])
    const store = useMessagePollsStore()
    store.request('p1')
    await tick()
    await tick()
    store.request('p1')
    await tick()
    expect(api.fetchMessagePolls).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.parse('2026-10-10T12:01:01Z'))
    store.request('p1')
    await tick()
    expect(api.fetchMessagePolls).toHaveBeenCalledTimes(2)
  })
})

describe('voting', () => {
  async function loaded(state = poll()) {
    api.fetchMessagePolls.mockResolvedValue([state])
    const store = useMessagePollsStore()
    store.request(state.pollId)
    await tick()
    await tick()
    return store
  }

  it('moves counts with the caller\'s answers', () => {
    const voted = withPollChoice(poll(), ['b'])
    expect(voted.totalVoters).toBe(3)
    expect(voted.options.map((o) => o.votes)).toEqual([2, 1])
    const moved = withPollChoice({ ...voted }, ['a'])
    expect(moved.totalVoters).toBe(3)
    expect(moved.options.map((o) => o.votes)).toEqual([3, 0])
    const removed = withPollChoice(moved, [])
    expect(removed.totalVoters).toBe(2)
    expect(removed.myOptionIds).toEqual([])
  })

  it('applies a vote before the server answers, then takes the server\'s state', async () => {
    const store = await loaded()
    let answer!: (s: MessagePollState) => void
    api.voteMessagePoll.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    const pending = store.vote('p1', ['b'])
    expect(store.get('p1')?.myOptionIds).toEqual(['b'])
    expect(store.get('p1')?.options[1].votes).toBe(1)
    answer(poll({ totalVoters: 5, myOptionIds: ['b'], options: [
      { id: 'a', position: 0, text: 'Pizza', votes: 3 },
      { id: 'b', position: 1, text: 'Sushi', votes: 2 },
    ] }))
    await pending
    expect(store.get('p1')?.totalVoters).toBe(5)
    expect(api.voteMessagePoll).toHaveBeenCalledWith('p1', ['b'])
  })

  it('restores the earlier state when the vote fails', async () => {
    const store = await loaded()
    api.voteMessagePoll.mockRejectedValue(new Error('POLL_CLOSED: the poll has ended'))
    api.fetchMessagePolls.mockResolvedValue([poll({ closed: true })])
    await expect(store.vote('p1', ['b'])).rejects.toThrow('POLL_CLOSED')
    expect(store.get('p1')?.myOptionIds).toEqual([])
    await tick()
    await tick()
    expect(store.get('p1')?.closed).toBe(true)
  })

  it('keeps the newest of overlapping votes', async () => {
    const store = await loaded()
    const answers: Array<(s: MessagePollState) => void> = []
    api.voteMessagePoll.mockImplementation(() => new Promise((resolve) => answers.push(resolve)))
    const first = store.vote('p1', ['a'])
    const second = store.vote('p1', ['b'])
    answers[1](poll({ myOptionIds: ['b'] }))
    await second
    answers[0](poll({ myOptionIds: ['a'] }))
    await first
    expect(store.get('p1')?.myOptionIds).toEqual(['b'])
  })
})

describe('realtime', () => {
  it('applies broadcast counts and keeps the caller\'s answers', async () => {
    api.fetchMessagePolls.mockResolvedValue([poll({ myOptionIds: ['a'] })])
    const store = useMessagePollsStore()
    store.request('p1')
    await tick()
    await tick()
    store.applyRealtime({
      type: 'poll:vote', poll_id: 'p1', message_id: 'm1', expires_at: '2099-01-01T00:00:00Z',
      total_voters: 4, options: [{ id: 'a', votes: 2 }, { id: 'b', votes: 2 }],
    })
    expect(store.get('p1')).toMatchObject({ totalVoters: 4, myOptionIds: ['a'], closed: false })
    expect(store.get('p1')?.options.map((o) => o.votes)).toEqual([2, 2])

    store.applyRealtime({ type: 'poll:ended', poll_id: 'p1', expires_at: '2026-01-01T00:00:00Z', total_voters: 4, options: [] })
    expect(store.get('p1')?.closed).toBe(true)
  })

  it('ignores polls it does not hold', () => {
    const store = useMessagePollsStore()
    store.applyRealtime({ type: 'poll:vote', poll_id: 'zz', total_voters: 1, options: [] })
    expect(store.get('zz')).toBeUndefined()
  })
})
