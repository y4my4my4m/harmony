import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from '@supabase/supabase-js'

// A token that cannot be refreshed while GoTrue or the network is away ends nothing: auth-js keeps the
// stored session, and the connection is tried again. Signed out, it is final.

const auth = vi.hoisted(() => ({
  answers: [] as Array<() => Promise<unknown>>,
  listener: null as unknown as (event: string, session: unknown) => void,
  asked: 0,
}))
vi.mock('@/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => {
        auth.asked++
        return (auth.answers.length > 1 ? auth.answers.shift()! : auth.answers[0])()
      },
      onAuthStateChange: (listener: typeof auth.listener) => {
        auth.listener = listener
        return { data: { subscription: { unsubscribe: () => {} } } }
      },
    },
  },
}))
vi.mock('../catalog', () => ({ activityRelayUrl: () => 'wss://relay.test/socket' }))

import { RelayConnection, type FinalReason } from '../relayConnection'

class FakeSocket {
  static OPEN = 1
  static CONNECTING = 0
  static made: FakeSocket[] = []
  readyState = 0
  sent: Array<Record<string, unknown>> = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  constructor(public url: string) { FakeSocket.made.push(this) }
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }) }
  drop(code: number) { this.readyState = 3; this.onclose?.({ code }) }
}

const session = (token = 'token') => async () => ({ data: { session: { access_token: token } }, error: null })
const refused = (error: unknown) => async () => ({ data: { session: null }, error })

let statuses: string[]
let finals: FinalReason[]
let connection: RelayConnection

function start(...answers: Array<() => Promise<unknown>>) {
  auth.answers = answers
  connection = new RelayConnection('s1', {
    frame: () => {}, clock: () => {}, status: (s) => statuses.push(s), final: (r) => finals.push(r),
  })
  connection.start()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeSocket)
  FakeSocket.made = []
  statuses = []
  finals = []
  auth.asked = 0
})

afterEach(() => {
  connection.stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('a relay connection whose token cannot be refreshed', () => {
  it.each([
    ['the network is away', refused(new AuthRetryableFetchError('Failed to fetch', 0))],
    ['GoTrue answers 503', refused(new AuthRetryableFetchError('Service Unavailable', 503))],
    ['GoTrue answers 500', refused(new AuthApiError('Internal error', 500, 'unexpected_failure'))],
    ['getSession itself fails', async () => { throw new TypeError('Failed to fetch') }],
    ['auth-js cannot take its lock', async () => { throw Object.assign(new Error('Acquiring an exclusive Navigator LockManager lock timed out'), { isAcquireTimeout: true }) }],
  ])('after a 4013, while %s: tried again with backoff, then connected', async (_what, away) => {
    start(session(), away, away, session('refreshed'))
    await vi.advanceTimersByTimeAsync(0)
    FakeSocket.made[0].open()
    FakeSocket.made[0].drop(4013)
    await vi.advanceTimersByTimeAsync(500)
    expect(auth.asked).toBe(2)
    expect(finals).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(auth.asked).toBe(3)
    expect(FakeSocket.made).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2_000)

    expect(FakeSocket.made).toHaveLength(2)
    FakeSocket.made[1].open()
    expect(FakeSocket.made[1].sent[0]).toMatchObject({ op: 'hello', token: 'refreshed', session: 's1' })
    FakeSocket.made[1].receive({ op: 'welcome', serverTime: Date.now() })
    expect(statuses).toEqual(['reconnecting', 'offline', 'offline', 'connected'])
    expect(finals).toEqual([])
  })

  it('from the start, is tried again too', async () => {
    start(refused(new AuthRetryableFetchError('Failed to fetch', 0)), session())
    await vi.advanceTimersByTimeAsync(0)
    expect(statuses).toEqual(['reconnecting'])
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeSocket.made).toHaveLength(1)
    expect(finals).toEqual([])
  })

  it.each([
    ['signed out', refused(null)],
    ['with a session GoTrue no longer knows', refused(new AuthSessionMissingError())],
    ['with a refresh token GoTrue refuses', refused(new AuthApiError('Invalid Refresh Token', 400, 'refresh_token_not_found'))],
  ])('%s, it is over', async (_what, answer) => {
    start(session(), answer)
    await vi.advanceTimersByTimeAsync(0)
    FakeSocket.made[0].drop(4013)
    await vi.advanceTimersByTimeAsync(500)
    expect(finals).toEqual([{ kind: 'unauthorized' }])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(auth.asked).toBe(2)
  })

  it('a sign-out during the backoff ends it', async () => {
    start(session(), refused(new AuthRetryableFetchError('Failed to fetch', 0)))
    await vi.advanceTimersByTimeAsync(0)
    FakeSocket.made[0].drop(4013)
    await vi.advanceTimersByTimeAsync(500)
    auth.listener('SIGNED_OUT', null)
    expect(finals).toEqual([{ kind: 'closed' }])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(auth.asked).toBe(2)
  })
})
