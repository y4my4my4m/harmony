import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SEND_TURN_HOLD_MS, inSendOrder, resetSendOrder, takeSendTurn } from '@/stores/shared/sendOrder'
import { placeStoredRow } from '@/stores/shared/messageCacheUtils'
import type { Message } from '@/types'

/** An insert that answers when told to, recording when it started. */
function heldInsert(log: string[], name: string) {
  let answer!: (value: string) => void
  let refuse!: (error: Error) => void
  const insert = vi.fn(() => {
    log.push(`start ${name}`)
    return new Promise<string>((resolve, reject) => {
      answer = (value) => { log.push(`end ${name}`); resolve(value) }
      refuse = (error) => { log.push(`fail ${name}`); reject(error) }
    })
  })
  return { insert, answer: (v = name) => answer(v), refuse: (e = new Error(name)) => refuse(e) }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => resetSendOrder())
afterEach(() => vi.useRealTimers())

describe('send order', () => {
  it('starts each insert of a target after the previous one settled, whatever order they answer in', async () => {
    const log: string[] = []
    const one = heldInsert(log, '1')
    const two = heldInsert(log, '2')
    const three = heldInsert(log, '3')
    const results = [
      inSendOrder('channel:a', one.insert),
      inSendOrder('channel:a', two.insert),
      inSendOrder('channel:a', three.insert),
    ]
    await tick()
    expect(log).toEqual(['start 1'])
    one.answer()
    await tick()
    two.answer()
    await tick()
    three.answer()
    expect(await Promise.all(results)).toEqual(['1', '2', '3'])
    expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3'])
  })

  it('a failure in the middle lets the next insert go and keeps its own rejection', async () => {
    const log: string[] = []
    const one = heldInsert(log, '1')
    const two = heldInsert(log, '2')
    const three = heldInsert(log, '3')
    const first = inSendOrder('dm:a', one.insert)
    const second = inSendOrder('dm:a', two.insert)
    const third = inSendOrder('dm:a', three.insert)
    await tick()
    one.answer()
    await tick()
    two.refuse(new Error('refused'))
    await expect(second).rejects.toThrow('refused')
    await tick()
    three.answer()
    expect(await first).toBe('1')
    expect(await third).toBe('3')
    expect(log).toEqual(['start 1', 'end 1', 'start 2', 'fail 2', 'start 3', 'end 3'])
  })

  it('different targets do not wait on each other', async () => {
    const log: string[] = []
    const a = heldInsert(log, 'a')
    const b = heldInsert(log, 'b')
    void inSendOrder('channel:a', a.insert)
    void inSendOrder('channel:b', b.insert)
    await tick()
    expect(log).toEqual(['start a', 'start b'])
  })

  it('a turn taken at Enter holds its place while the message is parsed', async () => {
    const log: string[] = []
    const slow = heldInsert(log, 'mention')
    const quick = heldInsert(log, 'plain')
    const turn = takeSendTurn('channel:a')
    void inSendOrder('channel:a', quick.insert)
    await tick()
    expect(log).toEqual([])

    void turn.run(slow.insert)
    await tick()
    expect(log).toEqual(['start mention'])
    slow.answer()
    await tick()
    expect(log).toEqual(['start mention', 'end mention', 'start plain'])
  })

  it('a released turn lets the next one go; a second run takes a new turn', async () => {
    const log: string[] = []
    const later = heldInsert(log, 'later')
    const turn = takeSendTurn('channel:a')
    void inSendOrder('channel:a', later.insert)
    turn.release()
    await tick()
    expect(log).toEqual(['start later'])

    const again = heldInsert(log, 'again')
    void turn.run(again.insert)
    await tick()
    expect(log).toEqual(['start later'])
    later.answer()
    await tick()
    expect(log).toEqual(['start later', 'end later', 'start again'])
  })

  it('neither an unused turn nor a request that never answers holds the target past the limit', async () => {
    vi.useFakeTimers()
    const log: string[] = []
    takeSendTurn('channel:a')
    const hung = heldInsert(log, 'hung')
    const next = heldInsert(log, 'next')
    void inSendOrder('channel:a', hung.insert)
    void inSendOrder('channel:a', next.insert)

    await vi.advanceTimersByTimeAsync(SEND_TURN_HOLD_MS)
    expect(log).toEqual(['start hung'])
    await vi.advanceTimersByTimeAsync(SEND_TURN_HOLD_MS)
    expect(log).toEqual(['start hung', 'start next'])
  })
})

const row = (id: string, at: number, extra: Partial<Message> & { sending?: boolean; failed?: boolean } = {}) =>
  ({ id, created_at: new Date(at), content: [], ...extra }) as unknown as Message

describe('placing a stored row', () => {
  it('moves the stored row past server rows on the wrong side of its created_at', () => {
    // Another member's message arrived while ours was pending; the server stored ours first.
    const list = [row('a', 100), row('temp-1', 205, { sending: true }), row('b', 150)]
    placeStoredRow(list, 'temp-1', row('m1', 120))
    expect(list.map((m) => m.id)).toEqual(['a', 'm1', 'b'])

    const later = [row('a', 100), row('b', 150), row('temp-2', 90, { sending: true })]
    placeStoredRow(later, 'temp-2', row('m2', 160))
    expect(later.map((m) => m.id)).toEqual(['a', 'b', 'm2'])
  })

  it('never crosses a pending or failed row: typed order holds and a failed row stays put', () => {
    const list = [
      row('a', 100),
      row('temp-f', 300, { failed: true }),
      row('b', 200),
      row('temp-2', 310, { sending: true }),
      row('temp-3', 320, { sending: true }),
    ]
    placeStoredRow(list, 'temp-2', row('m2', 150))
    expect(list.map((m) => m.id)).toEqual(['a', 'temp-f', 'm2', 'b', 'temp-3'])
  })

  it('reports a pending row already replaced', () => {
    const list = [row('m1', 100)]
    expect(placeStoredRow(list, 'temp-1', row('m1', 100))).toBe(false)
    expect(list.map((m) => m.id)).toEqual(['m1'])
  })
})
