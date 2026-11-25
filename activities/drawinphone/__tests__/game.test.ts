import { describe, expect, it } from 'vitest'
import { chainOf } from '../src/assign'
import { ALL_DONE_PAUSE_MS, DEADLINE_GRACE_MS, HostCore, entryKey, type Assign, type Effects, type Submission, type ToMember } from '../src/game'
import { LOCALES, missingKeys } from '../src/i18n'
import { DRAWING_MAX_BYTES, encodeOps } from '../src/ops'

const A = 'a'
const B = 'b'
const C = 'c'
const PLAYERS = [{ id: A, name: 'Ann' }, { id: B, name: 'Ben' }, { id: C, name: 'Cat' }]
const all = new Set([A, B, C])
const T0 = 1_000_000

const drawing = (marks = 2): Submission => ({
  kind: 'drawing',
  ops: encodeOps(Array.from({ length: marks }, (_, i) => ({ k: 'stroke' as const, color: 0, alpha: 100, size: 4, pts: [i * 10, i * 10, 128, i * 10 + 50, i * 10 + 40, 128] }))),
})

function core(): HostCore {
  return new HostCore(() => 'auto prompt')
}

function assigns(effects: Effects): Map<string, Assign> {
  const out = new Map<string, Assign>()
  for (const send of effects.send) {
    if (send.data.t === 'assign' && send.to !== 'all') out.set(send.to[0], send.data)
  }
  return out
}

function started(): { host: HostCore; first: Map<string, Assign> } {
  const host = core()
  const first = assigns(host.start(PLAYERS, 7, T0))
  return { host, first }
}

function submitAll(host: HostCore, list: Map<string, Assign>, now: number, entry: (id: string, a: Assign) => Submission | null): void {
  for (const [id, a] of list) {
    const sub = entry(id, a)
    if (sub) host.submit(id, { t: 'submit', game: a.game, step: a.step, chain: a.chain, entry: sub }, now)
  }
}

function playStep(host: HostCore, list: Map<string, Assign>, now: number): Map<string, Assign> {
  submitAll(host, list, now, (id, a) => (a.kind === 'draw' ? drawing() : { kind: 'text', text: `${id} at ${a.step}` }))
  host.tick(now, all)
  return assigns(host.tick(now + ALL_DONE_PAUSE_MS, all))
}

describe('DrawinPhone host: playing', () => {
  it('starts with a private write assignment per seat', () => {
    const { host, first } = started()
    expect([...first.keys()].sort()).toEqual([A, B, C])
    for (const a of first.values()) expect(a).toMatchObject({ game: 1, step: 0, steps: 3, kind: 'write', prev: null, deadline: T0 + 40_000 })
    expect(new Set([...first.values()].map((a) => a.chain)).size).toBe(3)
    const pub = host.public()
    expect(pub).toMatchObject({ phase: 'play', game: 1, players: [A, B, C], step: 0, steps: 3, kind: 'write', done: [] })
  })

  it('needs two players', () => {
    const host = core()
    expect(host.start([PLAYERS[0]], 1, T0).state).toBe(false)
    expect(host.phase).toBe('lobby')
  })

  it('acknowledges a submission and marks the seat done', () => {
    const { host, first } = started()
    const a = first.get(A)!
    const effects = host.submit(A, { t: 'submit', game: 1, step: 0, chain: a.chain, entry: { kind: 'text', text: '  a   red  fox ' } }, T0 + 5000)
    expect(effects.send).toEqual([{ to: [A], data: { t: 'ack', game: 1, step: 0, chain: a.chain } }])
    expect(host.public().done).toEqual([A])
    expect(host.game!.entries[entryKey(a.chain, 0)]).toEqual({ by: A, kind: 'text', text: 'a red fox' })
  })

  it('ignores a submission for a chain the seat does not hold, and acks a stale one', () => {
    const { host, first } = started()
    const a = first.get(A)!
    const wrong = (a.chain + 1) % 3
    expect(host.submit(A, { t: 'submit', game: 1, step: 0, chain: wrong, entry: { kind: 'text', text: 'x' } }, T0).send).toEqual([])
    expect(host.submit(A, { t: 'submit', game: 1, step: 5, chain: a.chain, entry: { kind: 'text', text: 'x' } }, T0).send).toEqual([
      { to: [A], data: { t: 'ack', game: 1, step: 5, chain: a.chain } },
    ])
    expect(host.submit('zed', { t: 'submit', game: 1, step: 0, chain: 0, entry: { kind: 'text', text: 'x' } }, T0).send).toEqual([])
  })

  it('refuses a drawing of the wrong kind or over the size cap', () => {
    const { host, first } = started()
    const list = playStep(host, first, T0 + 1000)
    const a = list.get(A)!
    expect(a.kind).toBe('draw')
    expect(host.submit(A, { t: 'submit', game: 1, step: 1, chain: a.chain, entry: { kind: 'text', text: 'no' } }, T0).send).toEqual([])
    const huge = { kind: 'drawing' as const, ops: 'd1.' + 'A'.repeat(DRAWING_MAX_BYTES) }
    expect(host.submit(A, { t: 'submit', game: 1, step: 1, chain: a.chain, entry: huge }, T0).send).toEqual([])
  })

  it('moves on once every connected seat is done, handing each the previous entry', () => {
    const { host, first } = started()
    submitAll(host, first, T0 + 1000, (id) => ({ kind: 'text', text: `prompt by ${id}` }))
    expect(host.tick(T0 + 1000, all).state).toBe(false)
    const second = assigns(host.tick(T0 + 1000 + ALL_DONE_PAUSE_MS, all))
    expect(host.public()).toMatchObject({ step: 1, kind: 'draw', deadline: T0 + 1000 + ALL_DONE_PAUSE_MS + 90_000 })
    for (const [id, a] of second) {
      expect(a.kind).toBe('draw')
      expect(a.prev).toMatchObject({ kind: 'text' })
      expect((a.prev as { by: string }).by).not.toBe(id)
    }
  })

  it('fills missing work at the deadline with a picked prompt or a blank drawing', () => {
    const { host, first } = started()
    submitAll(host, first, T0, (id) => (id === C ? null : { kind: 'text', text: 'hi' }))
    expect(host.tick(T0 + 40_000, all).state).toBe(false)
    const second = assigns(host.tick(T0 + 40_000 + DEADLINE_GRACE_MS, all))
    const cChain = first.get(C)!.chain
    expect(host.game!.entries[entryKey(cChain, 0)]).toEqual({ by: C, kind: 'text', text: 'auto prompt', filled: true })
    // Drawing step: nobody draws, so every entry is a blank drawing.
    const third = assigns(host.tick(second.get(A)!.deadline + DEADLINE_GRACE_MS, all))
    expect(third.get(A)!.prev).toMatchObject({ kind: 'drawing', marks: 0, filled: true })
  })

  it('does not wait for a seat that left', () => {
    const { host, first } = started()
    submitAll(host, first, T0, (id) => (id === C ? null : { kind: 'text', text: 'hi' }))
    const present = new Set([A, B])
    host.tick(T0 + 10, present)
    const next = assigns(host.tick(T0 + 10 + ALL_DONE_PAUSE_MS, present))
    expect(next.size).toBe(3)
    expect(host.game!.entries[entryKey(first.get(C)!.chain, 0)]).toMatchObject({ filled: true })
  })

  it('treats an empty text as a filled prompt and an empty drawing as blank', () => {
    const { host, first } = started()
    const a = first.get(A)!
    host.submit(A, { t: 'submit', game: 1, step: 0, chain: a.chain, entry: { kind: 'text', text: '   ' } }, T0)
    expect(host.game!.entries[entryKey(a.chain, 0)]).toMatchObject({ text: 'auto prompt', filled: true })
  })

  it('reopens a retracted answer', () => {
    const { host, first } = started()
    const a = first.get(A)!
    host.submit(A, { t: 'submit', game: 1, step: 0, chain: a.chain, entry: { kind: 'text', text: 'x' } }, T0)
    expect(host.public().done).toEqual([A])
    expect(host.retract(A, { t: 'retract', game: 1, step: 0, chain: a.chain }).state).toBe(true)
    expect(host.public().done).toEqual([])
    expect(host.takeStoreWrites()).toContainEqual([`e:${entryKey(a.chain, 0)}`, undefined])
  })
})

describe('DrawinPhone host: sync', () => {
  it('answers a reloaded member with its assignment and its own answer', () => {
    const { host, first } = started()
    const a = first.get(B)!
    let reply = host.sync(B).send
    expect(reply).toHaveLength(1)
    expect(reply[0]).toMatchObject({ to: [B], data: { t: 'assign', step: 0, chain: a.chain, mine: null } })
    host.submit(B, { t: 'submit', game: 1, step: 0, chain: a.chain, entry: { kind: 'text', text: 'mine' } }, T0)
    reply = host.sync(B).send
    expect((reply[0].data as Assign).mine).toEqual({ by: B, kind: 'text', text: 'mine' })
  })

  it('gives a member who joined mid-game nothing to do: it spectates', () => {
    const { host } = started()
    expect(host.assignmentFor('late')).toBeNull()
    expect(host.sync('late').send).toEqual([])
  })

  it('answers during the reveal with the current chain so far and the member favourite', () => {
    const { host, first } = started()
    let list = first
    for (let i = 0; i < 3; i++) list = playStep(host, list, T0 + i * 1000)
    expect(host.phase).toBe('reveal')
    host.next(T0 + 9000)
    host.fav(B, { t: 'fav', game: 1, chain: 0, step: 1 })
    const reply = host.sync(B).send.map((s) => s.data as ToMember)
    expect(reply.filter((d) => d.t === 'album').map((d) => (d as { step: number }).step)).toEqual([0, 1])
    expect(reply.at(-1)).toEqual({ t: 'faved', game: 1, key: '0:1' })
  })
})

describe('DrawinPhone host: hand-off', () => {
  it('continues the game from the public state and store of the previous host', () => {
    const { host, first } = started()
    const store = new Map<string, unknown>()
    const flush = () => {
      for (const [key, value] of host.takeStoreWrites()) {
        if (value === undefined) store.delete(key)
        else store.set(key, JSON.parse(JSON.stringify(value)))
      }
    }
    const second = playStep(host, first, T0 + 1000)
    const a = second.get(A)!
    host.submit(A, { t: 'submit', game: 1, step: 1, chain: a.chain, entry: drawing(3) }, T0 + 2000)
    flush()
    const state = JSON.parse(JSON.stringify(host.public()))

    const next = core()
    expect(next.restore(state, store)).toBe(true)
    expect(next.public()).toEqual(host.public())
    expect(next.assignmentFor(B)).toEqual(host.assignmentFor(B))
    expect(next.assignmentFor(A)!.mine).toMatchObject({ kind: 'drawing', marks: 3 })
    const b = next.assignmentFor(B)!
    next.submit(B, { t: 'submit', game: 1, step: 1, chain: b.chain, entry: drawing() }, T0 + 3000)
    const c = next.assignmentFor(C)!
    next.submit(C, { t: 'submit', game: 1, step: 1, chain: c.chain, entry: drawing() }, T0 + 3000)
    next.tick(T0 + 3000, all)
    const third = assigns(next.tick(T0 + 3000 + ALL_DONE_PAUSE_MS, all))
    expect(third.get(A)).toMatchObject({ step: 2, kind: 'describe' })
  })

  it('restarts in the lobby when the store lost the game', () => {
    const { host } = started()
    const next = core()
    expect(next.restore(host.public(), new Map())).toBe(false)
    expect(next.phase).toBe('lobby')
  })
})

describe('DrawinPhone host: reveal and awards', () => {
  function revealed(): HostCore {
    const { host, first } = started()
    let list = first
    for (let i = 0; i < 3; i++) list = playStep(host, list, T0 + i * 1000)
    return host
  }

  it('walks every entry of every chain, then the awards', () => {
    const host = revealed()
    const seen: string[] = []
    let effects: Effects = { send: [], state: false }
    for (let i = 0; i < 20 && host.phase === 'reveal'; i++) {
      effects = host.next(T0 + 10_000 + i)
      for (const s of effects.send) if (s.data.t === 'album') seen.push(entryKey(s.data.chain, s.data.step))
    }
    expect(seen).toEqual(['0:1', '0:2', '1:0', '1:1', '1:2', '2:0', '2:1', '2:2'])
    expect(host.phase).toBe('over')
  })

  it('auto-advances by the entry duration', () => {
    const host = revealed()
    host.setAuto(true, T0)
    expect(host.tick(T0 + 1000, all).state).toBe(false)
    expect(host.tick(T0 + 60_000, all).state).toBe(true)
    expect(host.reveal!.upto).toBe(1)
  })

  it('counts favourites and reactions into awards', () => {
    const host = revealed()
    for (let i = 0; i < 8; i++) host.next(T0 + i)
    const drawingKey = Object.entries(host.game!.entries).find(([, e]) => e.kind === 'drawing')![0]
    const [chain, step] = drawingKey.split(':').map(Number)
    host.fav(A, { t: 'fav', game: 1, chain, step })
    host.fav(B, { t: 'fav', game: 1, chain, step })
    host.react({ t: 'react', game: 1, chain, step, e: 0 })
    host.react({ t: 'react', game: 1, chain, step, e: 1 })
    host.finish()
    const awards = host.public().awards!
    const by = host.game!.entries[drawingKey].by
    expect(awards.find((a) => a.id === 'favourite')).toEqual({ id: 'favourite', player: by, chain, step, value: 2 })
    expect(awards.find((a) => a.id === 'reactions')).toMatchObject({ player: by, value: 2 })
    expect(awards.find((a) => a.id === 'detail')).toMatchObject({ value: 2 })
    expect(awards.find((a) => a.id === 'speed')).toBeDefined()
  })

  it('toggles a favourite off', () => {
    const host = revealed()
    host.fav(A, { t: 'fav', game: 1, chain: 0, step: 0 })
    expect(host.fav(A, { t: 'fav', game: 1, chain: 0, step: 0 }).send[0].data).toEqual({ t: 'faved', game: 1, key: null })
  })

  it('refuses favourites and reactions on entries not yet revealed', () => {
    const host = revealed()
    expect(host.fav(A, { t: 'fav', game: 1, chain: 2, step: 2 }).send).toEqual([])
    host.react({ t: 'react', game: 1, chain: 2, step: 2, e: 0 })
    expect(host.game!.reactions['2:2']).toBeUndefined()
  })

  it('goes back to the lobby and clears the store', () => {
    const host = revealed()
    host.takeStoreWrites()
    host.finish()
    host.playAgain()
    const writes = host.takeStoreWrites()
    expect(writes.every(([, v]) => v === undefined)).toBe(true)
    expect(writes.map(([k]) => k)).toContain('game')
    expect(host.public()).toMatchObject({ phase: 'lobby', game: 1 })
    const again = assigns(host.start(PLAYERS, 9, T0))
    expect(again.get(A)!.game).toBe(2)
  })
})

describe('DrawinPhone strings', () => {
  it.each(LOCALES)('%s has every key', (locale) => {
    expect(missingKeys(locale)).toEqual([])
  })
})

describe('DrawinPhone seats', () => {
  it('assigns each seat the chain chainOf names', () => {
    const { host, first } = started()
    const g = host.game!
    for (const [id, a] of first) expect(a.chain).toBe(chainOf(g.players.indexOf(id), 0, 3, g.offsets))
  })
})
