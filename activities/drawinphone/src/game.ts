/**
 * DrawinPhone rules, host side. HostCore holds the game and turns every input into Effects: messages
 * to send, whether the public state changed, store writes. It never touches the room, so it runs the
 * same in tests and in the frame.
 *
 * Public state (room.setState): phase, settings, seats, step, deadline (relay clock), who is done,
 * the reveal position and the awards. Host store: 'game' (the game without entries) and one key per
 * entry, 'e:<chain>:<step>', so a promoted host continues where the last one stopped.
 *
 * Messages, member -> host: sync, submit, retract, fav. Host -> member: assign, ack, album, faved. Any member
 * -> everyone: react.
 */

import { chainOf, handler, offsets, stepCount, stepKind, MAX_PLAYERS, MIN_PLAYERS, type Mode, type StepKind } from './assign'
import { DRAWING_MAX_BYTES, countMarks, decodeOps, encodeOps } from './ops'

export const TEXT_MAX = 140
/** Time past the deadline the host waits for auto-submitted work. */
export const DEADLINE_GRACE_MS = 2500
/** Pause between the last submission and the next step. */
export const ALL_DONE_PAUSE_MS = 700
export const REACTIONS = ['😂', '😍', '🤯', '👏', '🔥', '💀'] as const

export interface Settings {
  mode: Mode
  drawSeconds: number
  writeSeconds: number
}

export const DRAW_SECONDS = [30, 45, 60, 75, 90, 120, 180]
export const WRITE_SECONDS = [15, 20, 30, 40, 60, 90]

export const MODE_TIMERS: Record<Mode, { draw: number; write: number }> = {
  classic: { draw: 90, write: 40 },
  speed: { draw: 45, write: 20 },
  marathon: { draw: 75, write: 30 },
}

export const DEFAULT_SETTINGS: Settings = { mode: 'classic', drawSeconds: 90, writeSeconds: 40 }

export type Entry =
  | { by: string; kind: 'text'; text: string; filled?: boolean }
  | { by: string; kind: 'drawing'; ops: string; marks: number; filled?: boolean }

/** What a member submits; `by` and `marks` are the host's to set. */
export type Submission = { kind: 'text'; text: string } | { kind: 'drawing'; ops: string }

export interface Game {
  id: number
  seed: number
  players: string[]
  names: Record<string, string>
  offsets: number[]
  steps: number
  step: number
  settings: Settings
  stepStart: number
  deadline: number
  /** Complete since this relay time; 0 while not. */
  completeAt: number
  entries: Record<string, Entry>
  /** Voter -> entry key. */
  favs: Record<string, string>
  /** Entry key -> reactions received. */
  reactions: Record<string, number>
  /** Player -> [total ms to submit, submissions]. */
  pace: Record<string, [number, number]>
}

export type Phase = 'lobby' | 'play' | 'reveal' | 'over'

export interface Award {
  id: 'favourite' | 'reactions' | 'speed' | 'detail'
  player: string
  chain?: number
  step?: number
  value: number
}

export interface Reveal {
  chain: number
  upto: number
  auto: boolean
  /** Relay time the auto-player moves on. */
  nextAt: number
}

export interface PublicState {
  v: 1
  phase: Phase
  game: number
  settings: Settings
  players: string[]
  names: Record<string, string>
  step: number
  steps: number
  kind: StepKind
  deadline: number
  done: string[]
  reveal: Reveal | null
  awards: Award[] | null
}

export interface Assign {
  t: 'assign'
  game: number
  step: number
  steps: number
  chain: number
  kind: StepKind
  /** The entry this step responds to; null at the first step. */
  prev: Entry | null
  deadline: number
  /** This member's entry for the step, when the host has it. */
  mine: Entry | null
}

export type ToHost =
  | { t: 'sync' }
  | { t: 'submit'; game: number; step: number; chain: number; entry: Submission }
  | { t: 'fav'; game: number; chain: number; step: number }
  | { t: 'retract'; game: number; step: number; chain: number }

export type ToMember =
  | Assign
  | { t: 'ack'; game: number; step: number; chain: number }
  | { t: 'album'; game: number; chain: number; step: number; entry: Entry }
  | { t: 'faved'; game: number; key: string | null }

export interface React {
  t: 'react'
  game: number
  chain: number
  step: number
  e: number
}

export interface Outgoing {
  /** 'all' reaches every member including the host itself. */
  to: 'all' | string[]
  data: ToMember
}

export interface Effects {
  send: Outgoing[]
  state: boolean
}

const none = (): Effects => ({ send: [], state: false })

export const entryKey = (chain: number, step: number) => `${chain}:${step}`

export function clampSettings(input: Partial<Settings> | null | undefined): Settings {
  const mode: Mode = input?.mode === 'speed' || input?.mode === 'marathon' ? input.mode : 'classic'
  const draw = DRAW_SECONDS.includes(Number(input?.drawSeconds)) ? Number(input!.drawSeconds) : MODE_TIMERS[mode].draw
  const write = WRITE_SECONDS.includes(Number(input?.writeSeconds)) ? Number(input!.writeSeconds) : MODE_TIMERS[mode].write
  return { mode, drawSeconds: draw, writeSeconds: write }
}

export function lobbyState(settings: Settings = DEFAULT_SETTINGS, game = 0): PublicState {
  return {
    v: 1,
    phase: 'lobby',
    game,
    settings,
    players: [],
    names: {},
    step: 0,
    steps: 0,
    kind: 'write',
    deadline: 0,
    done: [],
    reveal: null,
    awards: null,
  }
}

export function isPublicState(value: unknown): value is PublicState {
  const v = value as PublicState | null
  return !!v && typeof v === 'object' && v.v === 1 && typeof v.phase === 'string' && Array.isArray(v.players)
}

/** Seconds a step lasts. */
export function stepSeconds(settings: Settings, kind: StepKind): number {
  return kind === 'draw' ? settings.drawSeconds : settings.writeSeconds
}

/** How long the auto-player shows an entry, ms. */
export function revealDuration(entry: Entry | undefined): number {
  if (!entry || entry.kind === 'text') return 3500
  return Math.min(7000, 1800 + entry.marks * 60) + 1800
}

export class HostCore {
  phase: Phase = 'lobby'
  settings: Settings = DEFAULT_SETTINGS
  game: Game | null = null
  reveal: Reveal | null = null
  awards: Award[] | null = null
  lastGameId = 0
  private dirty = new Set<string>()
  private removed = new Set<string>()

  constructor(private readonly pickPrompt: () => string) {}

  /** Continues from the public state and store a previous host left. False when it cannot. */
  restore(state: unknown, store: ReadonlyMap<string, unknown>): boolean {
    if (!isPublicState(state)) return false
    this.settings = clampSettings(state.settings)
    this.lastGameId = state.game
    if (state.phase === 'lobby') {
      this.phase = 'lobby'
      return true
    }
    const meta = store.get('game') as Omit<Game, 'entries'> | undefined
    if (!meta || meta.id !== state.game) {
      this.phase = 'lobby'
      this.game = null
      return false
    }
    const entries: Record<string, Entry> = {}
    for (const [key, value] of store) {
      if (key.startsWith('e:')) entries[key.slice(2)] = value as Entry
    }
    this.game = { ...meta, entries }
    this.phase = state.phase
    this.reveal = state.reveal
    this.awards = state.awards
    return true
  }

  public(): PublicState {
    const g = this.game
    if (this.phase === 'lobby' || !g) return lobbyState(this.settings, this.lastGameId)
    return {
      v: 1,
      phase: this.phase,
      game: g.id,
      settings: g.settings,
      players: g.players,
      names: g.names,
      step: g.step,
      steps: g.steps,
      kind: stepKind(Math.min(g.step, g.steps - 1)),
      deadline: g.deadline,
      done: this.phase === 'play' ? g.players.filter((p) => !!this.entryFor(g, p, g.step)) : [],
      reveal: this.reveal,
      awards: this.awards,
    }
  }

  /** Store writes since the last call: [key, value] with value undefined for a delete. */
  takeStoreWrites(): Array<[string, unknown]> {
    const out: Array<[string, unknown]> = []
    for (const key of this.removed) out.push([key, undefined])
    for (const key of this.dirty) {
      if (key === 'game') {
        const { entries: _entries, ...meta } = this.game!
        out.push(['game', meta])
      } else {
        out.push([key, this.game!.entries[key.slice(2)]])
      }
    }
    this.dirty.clear()
    this.removed.clear()
    return out
  }

  setSettings(input: Partial<Settings>): Effects {
    if (this.phase !== 'lobby') return none()
    this.settings = clampSettings({ ...this.settings, ...input })
    return { send: [], state: true }
  }

  start(players: Array<{ id: string; name: string }>, seed: number, now: number): Effects {
    if (this.phase !== 'lobby') return none()
    const seats = players.slice(0, MAX_PLAYERS)
    if (seats.length < MIN_PLAYERS) return none()
    const n = seats.length
    const steps = stepCount(n, this.settings.mode)
    this.clearStore()
    const game: Game = {
      id: this.lastGameId + 1,
      seed: seed >>> 0,
      players: seats.map((p) => p.id),
      names: Object.fromEntries(seats.map((p) => [p.id, p.name])),
      offsets: offsets(n, steps, seed),
      steps,
      step: 0,
      settings: this.settings,
      stepStart: now,
      deadline: now + stepSeconds(this.settings, 'write') * 1000,
      completeAt: 0,
      entries: {},
      favs: {},
      reactions: {},
      pace: {},
    }
    this.lastGameId = game.id
    this.game = game
    this.phase = 'play'
    this.reveal = null
    this.awards = null
    this.dirty.add('game')
    return { send: game.players.map((p) => ({ to: [p], data: this.assignmentFor(p)! })), state: true }
  }

  /** The step `player` works on now, or null when not seated or not playing. */
  assignmentFor(player: string): Assign | null {
    const g = this.game
    if (!g || this.phase !== 'play') return null
    const seat = g.players.indexOf(player)
    if (seat < 0) return null
    const chain = chainOf(seat, g.step, g.players.length, g.offsets)
    return {
      t: 'assign',
      game: g.id,
      step: g.step,
      steps: g.steps,
      chain,
      kind: stepKind(g.step),
      prev: g.step > 0 ? g.entries[entryKey(chain, g.step - 1)] ?? null : null,
      deadline: g.deadline,
      mine: g.entries[entryKey(chain, g.step)] ?? null,
    }
  }

  /** Everything a member needs after a reload, a reconnect or a host change. */
  sync(player: string): Effects {
    const g = this.game
    if (!g) return none()
    if (this.phase === 'play') {
      const assign = this.assignmentFor(player)
      return { send: assign ? [{ to: [player], data: assign }] : [], state: false }
    }
    if ((this.phase === 'reveal' || this.phase === 'over') && this.reveal) {
      const send: Outgoing[] = []
      const lastChain = this.phase === 'over' ? g.players.length - 1 : this.reveal.chain
      const chains = this.phase === 'over' ? this.awardChains() : [lastChain]
      for (const chain of chains) {
        const upto = this.phase === 'over' || chain < this.reveal.chain ? g.steps - 1 : this.reveal.upto
        for (let step = 0; step <= upto; step++) {
          const entry = g.entries[entryKey(chain, step)]
          if (entry) send.push({ to: [player], data: { t: 'album', game: g.id, chain, step, entry } })
        }
      }
      send.push({ to: [player], data: { t: 'faved', game: g.id, key: g.favs[player] ?? null } })
      return { send, state: false }
    }
    return none()
  }

  submit(from: string, msg: Extract<ToHost, { t: 'submit' }>, now: number): Effects {
    const g = this.game
    if (!g || this.phase !== 'play' || msg.game !== g.id) return none()
    const ack: Outgoing = { to: [from], data: { t: 'ack', game: msg.game, step: msg.step, chain: msg.chain } }
    // A late or repeated submission is acknowledged so the sender stops resending.
    if (msg.step !== g.step) return { send: [ack], state: false }
    const seat = g.players.indexOf(from)
    if (seat < 0 || chainOf(seat, g.step, g.players.length, g.offsets) !== msg.chain) return none()
    const entry = this.validate(from, stepKind(g.step), msg.entry)
    if (!entry) return none()
    const key = entryKey(msg.chain, g.step)
    const first = !g.entries[key] || g.entries[key].filled
    g.entries[key] = entry
    this.dirty.add('e:' + key)
    if (first && !entry.filled) {
      const [total, count] = g.pace[from] ?? [0, 0]
      g.pace[from] = [total + Math.max(0, now - g.stepStart), count + 1]
      this.dirty.add('game')
    }
    return { send: [ack], state: true }
  }

  /** The member reopened its answer: it no longer counts as done until it submits again. */
  retract(from: string, msg: Extract<ToHost, { t: 'retract' }>): Effects {
    const g = this.game
    if (!g || this.phase !== 'play' || msg.game !== g.id || msg.step !== g.step) return none()
    const seat = g.players.indexOf(from)
    if (seat < 0 || chainOf(seat, g.step, g.players.length, g.offsets) !== msg.chain) return none()
    const key = entryKey(msg.chain, g.step)
    if (!g.entries[key]) return none()
    delete g.entries[key]
    this.removed.add('e:' + key)
    this.dirty.delete('e:' + key)
    return { send: [], state: true }
  }

  private validate(by: string, kind: StepKind, sub: Submission | undefined): Entry | null {
    if (!sub || typeof sub !== 'object') return null
    if (kind === 'draw') {
      if (sub.kind !== 'drawing' || typeof sub.ops !== 'string' || sub.ops.length > DRAWING_MAX_BYTES) return null
      let marks: number
      try {
        marks = countMarks(decodeOps(sub.ops))
      } catch {
        return null
      }
      return marks === 0 ? { by, kind: 'drawing', ops: encodeOps([]), marks: 0, filled: true } : { by, kind: 'drawing', ops: sub.ops, marks }
    }
    if (sub.kind !== 'text' || typeof sub.text !== 'string') return null
    const text = sub.text.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX)
    return text ? { by, kind: 'text', text } : { by, kind: 'text', text: this.pickPrompt(), filled: true }
  }

  /** Steps the game on: early when every connected seat is done, else after the deadline's grace. */
  tick(now: number, connected: ReadonlySet<string>): Effects {
    const g = this.game
    if (!g) return none()
    if (this.phase === 'reveal' && this.reveal?.auto && now >= this.reveal.nextAt) return this.next(now)
    if (this.phase !== 'play') return none()

    const working = g.players.filter((p) => connected.has(p))
    const complete = working.length > 0 && working.every((p) => !!this.entryFor(g, p, g.step))
    if (complete && !g.completeAt) g.completeAt = now
    if (!complete) g.completeAt = 0
    if ((complete && now >= g.completeAt + ALL_DONE_PAUSE_MS) || now >= g.deadline + DEADLINE_GRACE_MS) {
      return this.advance(now)
    }
    return none()
  }

  private entryFor(g: Game, player: string, step: number): Entry | undefined {
    const seat = g.players.indexOf(player)
    if (seat < 0) return undefined
    return g.entries[entryKey(chainOf(seat, step, g.players.length, g.offsets), step)]
  }

  /** Fills every missing entry of the step, then opens the next step or the reveal. */
  advance(now: number): Effects {
    const g = this.game
    if (!g || this.phase !== 'play') return none()
    const n = g.players.length
    const kind = stepKind(g.step)
    for (let chain = 0; chain < n; chain++) {
      const key = entryKey(chain, g.step)
      if (g.entries[key]) continue
      const by = g.players[handler(chain, g.step, n, g.offsets)]
      g.entries[key] = kind === 'draw'
        ? { by, kind: 'drawing', ops: encodeOps([]), marks: 0, filled: true }
        : { by, kind: 'text', text: this.pickPrompt(), filled: true }
      this.dirty.add('e:' + key)
    }
    g.completeAt = 0
    this.dirty.add('game')
    if (g.step + 1 < g.steps) {
      g.step++
      g.stepStart = now
      g.deadline = now + stepSeconds(g.settings, stepKind(g.step)) * 1000
      return { send: g.players.map((p) => ({ to: [p], data: this.assignmentFor(p)! })), state: true }
    }
    this.phase = 'reveal'
    this.reveal = { chain: 0, upto: 0, auto: false, nextAt: 0 }
    return { send: [this.albumOut(0, 0)], state: true }
  }

  private albumOut(chain: number, step: number): Outgoing {
    const g = this.game!
    return { to: 'all', data: { t: 'album', game: g.id, chain, step, entry: g.entries[entryKey(chain, step)] } }
  }

  /** The next entry of the reveal, the next chain, or the awards. */
  next(now: number): Effects {
    const g = this.game
    const r = this.reveal
    if (!g || !r || this.phase !== 'reveal') return none()
    if (r.upto + 1 < g.steps) {
      r.upto++
    } else if (r.chain + 1 < g.players.length) {
      r.chain++
      r.upto = 0
    } else {
      return this.finish()
    }
    r.nextAt = now + revealDuration(g.entries[entryKey(r.chain, r.upto)])
    return { send: [this.albumOut(r.chain, r.upto)], state: true }
  }

  setAuto(on: boolean, now: number): Effects {
    if (!this.reveal || this.phase !== 'reveal') return none()
    this.reveal.auto = on
    this.reveal.nextAt = now + revealDuration(this.game!.entries[entryKey(this.reveal.chain, this.reveal.upto)])
    return { send: [], state: true }
  }

  finish(): Effects {
    if (!this.game || (this.phase !== 'reveal' && this.phase !== 'over')) return none()
    this.phase = 'over'
    this.awards = computeAwards(this.game)
    this.dirty.add('game')
    return { send: [], state: true }
  }

  /** Back to the lobby; the next start makes a new game. */
  playAgain(): Effects {
    if (this.phase === 'lobby') return none()
    this.phase = 'lobby'
    this.clearStore()
    this.game = null
    this.reveal = null
    this.awards = null
    return { send: [], state: true }
  }

  fav(from: string, msg: Extract<ToHost, { t: 'fav' }>): Effects {
    const g = this.game
    if (!g || msg.game !== g.id || (this.phase !== 'reveal' && this.phase !== 'over')) return none()
    const key = entryKey(msg.chain, msg.step)
    if (!g.entries[key] || !this.revealed(msg.chain, msg.step)) return none()
    if (g.favs[from] === key) delete g.favs[from]
    else g.favs[from] = key
    this.dirty.add('game')
    return { send: [{ to: [from], data: { t: 'faved', game: g.id, key: g.favs[from] ?? null } }], state: false }
  }

  react(msg: React): void {
    const g = this.game
    if (!g || msg.game !== g.id || !this.revealed(msg.chain, msg.step)) return
    const key = entryKey(msg.chain, msg.step)
    if (!g.entries[key]) return
    g.reactions[key] = (g.reactions[key] ?? 0) + 1
    this.dirty.add('game')
  }

  private revealed(chain: number, step: number): boolean {
    const r = this.reveal
    if (!r) return false
    if (this.phase === 'over') return true
    return chain < r.chain || (chain === r.chain && step <= r.upto)
  }

  /** Chains an award points at. */
  private awardChains(): number[] {
    return [...new Set((this.awards ?? []).map((a) => a.chain).filter((c): c is number => c !== undefined))]
  }

  private clearStore(): void {
    const g = this.game
    if (!g) return
    for (const key of Object.keys(g.entries)) this.removed.add('e:' + key)
    this.removed.add('game')
    this.dirty.clear()
  }
}

/** Crowd favourite, most reactions, fastest hands, most detailed. Ties go to the earliest seat or entry. */
export function computeAwards(g: Game): Award[] {
  const awards: Award[] = []
  const keys = Object.keys(g.entries).sort((a, b) => {
    const [ac, as] = a.split(':').map(Number)
    const [bc, bs] = b.split(':').map(Number)
    return ac - bc || as - bs
  })

  const votes = new Map<string, number>()
  for (const key of Object.values(g.favs)) votes.set(key, (votes.get(key) ?? 0) + 1)
  let favKey = ''
  for (const key of keys) if ((votes.get(key) ?? 0) > (votes.get(favKey) ?? 0)) favKey = key
  if (favKey && !g.entries[favKey].filled) {
    const [chain, step] = favKey.split(':').map(Number)
    awards.push({ id: 'favourite', player: g.entries[favKey].by, chain, step, value: votes.get(favKey)! })
  }

  const received = new Map<string, number>()
  for (const [key, count] of Object.entries(g.reactions)) {
    const entry = g.entries[key]
    if (entry && !entry.filled) received.set(entry.by, (received.get(entry.by) ?? 0) + count)
  }
  let loud = ''
  for (const p of g.players) if ((received.get(p) ?? 0) > (received.get(loud) ?? 0)) loud = p
  if (loud) awards.push({ id: 'reactions', player: loud, value: received.get(loud)! })

  let fastest = ''
  let best = Infinity
  for (const p of g.players) {
    const [total, count] = g.pace[p] ?? [0, 0]
    if (count >= Math.max(1, Math.floor(g.steps / 2)) && total / count < best) {
      best = total / count
      fastest = p
    }
  }
  if (fastest) awards.push({ id: 'speed', player: fastest, value: Math.round(best / 1000) })

  let detailKey = ''
  let marks = 0
  for (const key of keys) {
    const entry = g.entries[key]
    if (entry.kind === 'drawing' && !entry.filled && entry.marks > marks) {
      marks = entry.marks
      detailKey = key
    }
  }
  if (detailKey) {
    const [chain, step] = detailKey.split(':').map(Number)
    awards.push({ id: 'detail', player: g.entries[detailKey].by, chain, step, value: marks })
  }
  return awards
}
