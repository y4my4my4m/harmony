/**
 * One member's side of a DrawinPhone session: the player every member is, and the host one member is.
 *
 * Non-hosts hold only what the host sends them, so they ask for it (sync) on connect, after a
 * resync, after a host change and whenever the public state names a step or reveal entry they lack.
 * A submission is resent every RESEND_MS until the host acknowledges it, and at once to a new host.
 * Work in progress lives in memory only: a reloaded frame starts its step over.
 */

import type { EndReason, Json, Room } from '../../sdk'
import { HostCore, entryKey, isPublicState, type Assign, type Entry, type PublicState, type React, type Settings, type Submission, type ToHost, type ToMember, type Effects } from './game'
import { encodeOps } from './ops'
import { randomPrompt } from './prompts'
import { translator, type Key } from './i18n'

const TICK_MS = 250
const RESEND_MS = 3000
const SYNC_RETRY_MS = 2500
/** Work goes in this long before the deadline. */
const AUTO_SUBMIT_LEAD_MS = 300
const REACTION_WINDOW_MS = 2000
const REACTIONS_PER_WINDOW = 6

export interface SessionHooks {
  changed(): void
  newHost(name: string): void
  reacted(key: string, emoji: number): void
}

type SubmitMsg = Extract<ToHost, { t: 'submit' }>

export class Session {
  readonly core: HostCore
  hosting = false
  assignment: Assign | null = null
  /** game:step keys the host acknowledged. */
  readonly acked = new Set<string>()
  /** This member's last submission per game:step, for "change my answer". */
  readonly submitted = new Map<string, Submission>()
  pending: { msg: SubmitMsg; at: number } | null = null
  /** game|chain:step -> entry. */
  readonly album = new Map<string, Entry>()
  readonly reactions = new Map<string, number>()
  fav: string | null = null
  ended: EndReason | null = null
  draft: (() => Submission | null) | null = null
  private lastSync = 0
  private reactionTimes: number[] = []
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(readonly room: Room, private readonly hooks: SessionHooks) {
    this.core = new HostCore(() => randomPrompt(room.locale))
  }

  get state(): PublicState | null {
    return isPublicState(this.room.state) ? this.room.state : null
  }

  get me(): string {
    return this.room.me.id
  }

  start(): void {
    const room = this.room
    room.on('message', (_from, data, fromId) => this.onMessage(fromId, data))
    room.on('state', () => this.onState())
    room.on('host', (hostId, previous) => this.onHost(hostId, previous))
    room.on('resync', () => {
      if (room.isHost) this.becomeHost()
      else this.sync(true)
      this.hooks.changed()
    })
    room.on('join', () => this.hooks.changed())
    room.on('leave', () => this.hooks.changed())
    room.on('member', () => this.hooks.changed())
    room.on('connection', () => this.hooks.changed())
    room.on('ended', (reason) => {
      this.ended = reason
      this.stop()
      this.hooks.changed()
    })
    if (room.isHost) this.becomeHost()
    else this.sync(true)
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /* -------------------------------------------------------------------------------------------- */
  /* Host                                                                                          */
  /* -------------------------------------------------------------------------------------------- */

  private becomeHost(): void {
    this.hosting = true
    const state = this.room.state
    const restored = this.core.restore(state, this.room.store)
    if (!restored || !isPublicState(state)) {
      if (!restored && isPublicState(state)) this.core.settings = state.settings
      this.core.playAgain()
      this.publish({ send: [], state: true })
    }
    // A submission sent to the previous host may not have reached it.
    if (this.pending) this.toHost(this.pending.msg)
  }

  private connected(): Set<string> {
    return new Set(this.room.members.map((m) => m.id))
  }

  private publish(effects: Effects): void {
    const room = this.room
    for (const [key, value] of this.core.takeStoreWrites()) {
      try {
        room.storeSet(key, value as Json | undefined)
      } catch {
        // Over the store limit: the game goes on in memory; a promoted host restarts in the lobby.
      }
    }
    for (const out of effects.send) {
      const local = out.to === 'all' || out.to.includes(this.me)
      const others = out.to === 'all' ? null : out.to.filter((id) => id !== this.me)
      try {
        if (out.to === 'all') room.send(out.data as unknown as Json)
        else if (others!.length) room.send(out.data as unknown as Json, others!)
      } catch {
        // Too large to send; the member asks again through sync.
      }
      if (local) this.fromHost(out.data)
    }
    if (effects.state) room.setState(this.core.public() as unknown as Json)
    if (effects.state || effects.send.length) this.hooks.changed()
  }

  hostStart(): void {
    if (!this.hosting) return
    const players = [...this.room.members].sort((a, b) => a.joinedAt - b.joinedAt).map((m) => ({ id: m.id, name: m.name }))
    this.publish(this.core.start(players, Math.floor(Math.random() * 2 ** 32), this.room.serverNow()))
  }

  hostSettings(settings: Partial<Settings>): void {
    if (this.hosting) this.publish(this.core.setSettings(settings))
  }

  hostNext(): void {
    if (this.hosting) this.publish(this.core.next(this.room.serverNow()))
  }

  hostAuto(on: boolean): void {
    if (this.hosting) this.publish(this.core.setAuto(on, this.room.serverNow()))
  }

  hostFinish(): void {
    if (this.hosting) this.publish(this.core.finish())
  }

  hostPlayAgain(): void {
    if (!this.hosting) return
    this.publish(this.core.playAgain())
  }

  private onHostMessage(from: string, msg: ToHost): void {
    switch (msg.t) {
      case 'sync':
        this.publish(this.core.sync(from))
        break
      case 'submit':
        this.publish(this.core.submit(from, msg, this.room.serverNow()))
        break
      case 'retract':
        this.publish(this.core.retract(from, msg))
        break
      case 'fav':
        this.publish(this.core.fav(from, msg))
        break
    }
  }

  /* -------------------------------------------------------------------------------------------- */
  /* Player                                                                                        */
  /* -------------------------------------------------------------------------------------------- */

  private onMessage(fromId: string, data: Json): void {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return
    const msg = data as unknown as { t: string }
    if (msg.t === 'sync' || msg.t === 'submit' || msg.t === 'retract' || msg.t === 'fav') {
      if (this.room.isHost) this.onHostMessage(fromId, msg as ToHost)
      return
    }
    if (msg.t === 'react') {
      this.onReact(msg as React, false)
      return
    }
    // Everything else only counts from the host.
    if (fromId !== this.room.hostId) return
    this.fromHost(msg as ToMember)
  }

  private fromHost(msg: ToMember): void {
    switch (msg.t) {
      case 'assign': {
        if (this.assignment && (msg.game < this.assignment.game || (msg.game === this.assignment.game && msg.step < this.assignment.step))) return
        const fresh = !this.assignment || this.assignment.game !== msg.game || this.assignment.step !== msg.step
        this.assignment = msg
        // A hidden panel or background tab hears about a new step through the client.
        if (fresh && !msg.mine && !this.room.visible) {
          const t = translator(this.room.locale)
          this.room.notify(t('yourTurn', { what: t(`kind_${msg.kind}` as Key) }))
        }
        if (msg.mine) {
          this.acked.add(`${msg.game}:${msg.step}`)
          if (!this.submitted.has(`${msg.game}:${msg.step}`)) this.submitted.set(`${msg.game}:${msg.step}`, toSubmission(msg.mine))
          if (this.pending?.msg.game === msg.game && this.pending.msg.step === msg.step) this.pending = null
        }
        break
      }
      case 'ack':
        this.acked.add(`${msg.game}:${msg.step}`)
        if (this.pending && this.pending.msg.game === msg.game && this.pending.msg.step === msg.step) this.pending = null
        break
      case 'album':
        if (!this.album.size || [...this.album.keys()][0].split('|')[0] !== String(msg.game)) {
          this.album.clear()
          this.reactions.clear()
          this.fav = null
        }
        this.album.set(`${msg.game}|${entryKey(msg.chain, msg.step)}`, msg.entry)
        break
      case 'faved':
        this.fav = msg.key
        break
    }
    this.hooks.changed()
  }

  private toHost(msg: ToHost): void {
    if (this.room.isHost && this.hosting) this.onHostMessage(this.me, msg)
    else this.room.send(msg as unknown as Json, 'host')
  }

  /** Asks the host for this member's assignment, acknowledgements and reveal entries. */
  sync(force = false): void {
    if (this.room.isHost) return
    const now = Date.now()
    if (!force && now - this.lastSync < SYNC_RETRY_MS) return
    this.lastSync = now
    this.room.send({ t: 'sync' }, 'host')
  }

  private onHost(hostId: string, previous: string): void {
    if (hostId === this.me) this.becomeHost()
    else {
      this.hosting = false
      this.sync(true)
      if (this.pending) {
        this.room.send(this.pending.msg as unknown as Json, 'host')
        this.pending.at = Date.now()
      }
    }
    if (previous && hostId !== previous) {
      const name = this.room.member(hostId)?.name
      if (name) this.hooks.newHost(name)
    }
    this.hooks.changed()
  }

  private onState(): void {
    const s = this.state
    if (s && s.phase === 'lobby') this.assignment = null
    this.hooks.changed()
  }

  /** True when this member is seated in the running game. */
  seated(): boolean {
    const s = this.state
    return !!s && s.phase !== 'lobby' && s.players.includes(this.me)
  }

  /** The assignment for the step the public state names, if this member has it. */
  current(): Assign | null {
    const s = this.state
    const a = this.assignment
    if (!s || s.phase !== 'play' || !a || a.game !== s.game || a.step !== s.step) return null
    return a
  }

  isSubmitted(a: Assign): boolean {
    const key = `${a.game}:${a.step}`
    return this.acked.has(key) || (this.pending?.msg.game === a.game && this.pending.msg.step === a.step)
  }

  submit(entry: Submission): void {
    const a = this.current()
    if (!a) return
    const msg: SubmitMsg = { t: 'submit', game: a.game, step: a.step, chain: a.chain, entry }
    this.submitted.set(`${a.game}:${a.step}`, entry)
    this.acked.delete(`${a.game}:${a.step}`)
    this.pending = { msg, at: Date.now() }
    this.room.setMyState({ done: `${a.game}:${a.step}` })
    this.toHost(msg)
    this.hooks.changed()
  }

  /** Reopens the step for editing; the answer stays with the host until replaced. */
  unsubmit(): void {
    const a = this.current()
    if (!a) return
    this.acked.delete(`${a.game}:${a.step}`)
    if (this.pending?.msg.step === a.step) this.pending = null
    this.room.setMyState(null)
    this.toHost({ t: 'retract', game: a.game, step: a.step, chain: a.chain })
    this.hooks.changed()
  }

  private tick(): void {
    const s = this.state
    const now = this.room.serverNow()
    if (this.hosting && this.room.isHost) {
      const effects = this.core.tick(now, this.connected())
      if (effects.state || effects.send.length) this.publish(effects)
    }
    if (!s || this.ended) return

    if (s.phase === 'play' && s.players.includes(this.me)) {
      const a = this.current()
      if (!a) this.sync()
      else if (!this.isSubmitted(a) && now >= a.deadline - AUTO_SUBMIT_LEAD_MS) {
        this.submit(this.draft?.() ?? this.submitted.get(`${a.game}:${a.step}`) ?? emptySubmission(a))
      }
    }
    if ((s.phase === 'reveal' || s.phase === 'over') && s.reveal) {
      const key = `${s.game}|${entryKey(s.reveal.chain, s.reveal.upto)}`
      if (s.phase === 'reveal' && !this.album.has(key)) this.sync()
    }
    if (this.pending && Date.now() - this.pending.at >= RESEND_MS) {
      this.pending.at = Date.now()
      this.toHost(this.pending.msg)
    }
  }

  /* -------------------------------------------------------------------------------------------- */
  /* Reveal                                                                                        */
  /* -------------------------------------------------------------------------------------------- */

  entry(chain: number, step: number): Entry | undefined {
    const s = this.state
    return s ? this.album.get(`${s.game}|${entryKey(chain, step)}`) : undefined
  }

  react(chain: number, step: number, emoji: number): void {
    const s = this.state
    if (!s) return
    const now = Date.now()
    this.reactionTimes = this.reactionTimes.filter((t) => now - t < REACTION_WINDOW_MS)
    if (this.reactionTimes.length >= REACTIONS_PER_WINDOW) return
    this.reactionTimes.push(now)
    const msg: React = { t: 'react', game: s.game, chain, step, e: emoji }
    this.room.send(msg as unknown as Json)
    this.onReact(msg, true)
  }

  private onReact(msg: React, own: boolean): void {
    const s = this.state
    if (!s || msg.game !== s.game || !Number.isInteger(msg.e) || msg.e < 0 || msg.e > 5) return
    if (this.hosting && this.room.isHost) this.core.react(msg)
    const key = entryKey(msg.chain, msg.step)
    this.reactions.set(key, (this.reactions.get(key) ?? 0) + 1)
    this.hooks.reacted(key, msg.e)
    if (!own) this.hooks.changed()
  }

  toggleFav(chain: number, step: number): void {
    const s = this.state
    if (!s) return
    this.toHost({ t: 'fav', game: s.game, chain, step })
  }
}

export function emptySubmission(a: Assign): Submission {
  return a.kind === 'draw' ? { kind: 'drawing', ops: encodeOps([]) } : { kind: 'text', text: '' }
}

function toSubmission(entry: Entry): Submission {
  return entry.kind === 'drawing' ? { kind: 'drawing', ops: entry.ops } : { kind: 'text', text: entry.filled ? '' : entry.text }
}
