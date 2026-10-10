import { describe, expect, it } from 'vitest'
import { remotePollFromMetadata } from '@/utils/remotePoll'

describe('fediverse polls on posts', () => {
  const now = Date.parse('2026-10-10T12:00:00Z')

  it('reads a single-choice poll as shares of votes', () => {
    const poll = remotePollFromMetadata({
      is_poll: true,
      poll_options: [{ name: 'Tea', votes: 3 }, { name: 'Coffee', votes: 1 }],
      poll_multiple_choice: false,
      poll_end_time: '2026-10-11T12:00:00Z',
      poll_voters_count: 4,
      poll_closed: false,
    }, now)
    expect(poll).toMatchObject({ multiple: false, voters: 4, votersReported: true, closed: false })
    expect(poll?.options.map((o) => o.percent)).toEqual([75, 25])
  })

  it('reads a multiple-choice poll as shares of voters', () => {
    const poll = remotePollFromMetadata({
      is_poll: true,
      poll_options: [{ name: 'A', votes: 2 }, { name: 'B', votes: 2 }],
      poll_multiple_choice: true,
      poll_voters_count: 2,
    }, now)
    expect(poll?.options.map((o) => o.percent)).toEqual([100, 100])
  })

  it('counts votes when the origin reports no voters, and closes past the end', () => {
    const poll = remotePollFromMetadata({
      is_poll: true,
      poll_options: [{ name: 'A', votes: 1 }, { name: 'B', votes: 2 }],
      poll_end_time: '2026-10-10T11:00:00Z',
    }, now)
    expect(poll).toMatchObject({ voters: 3, votersReported: false, closed: true })
  })

  it('is null for a post without a poll', () => {
    expect(remotePollFromMetadata({})).toBeNull()
    expect(remotePollFromMetadata({ is_poll: true, poll_options: [] })).toBeNull()
    expect(remotePollFromMetadata(null)).toBeNull()
  })
})
