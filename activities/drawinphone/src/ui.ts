/**
 * DrawinPhone screens. App picks a screen from the public state and this member's session; a screen
 * is rebuilt only when its key (phase, game, step, kind) changes and otherwise updated in place, so
 * inputs keep focus and drawings keep their canvas while ticks and timers move.
 */

import type { Room, ThemeInfo } from '../../sdk'
import { DRAW_SECONDS, REACTIONS, TEXT_MAX, WRITE_SECONDS, entryKey, type Assign, type Award, type Entry, type PublicState } from './game'
import { avatar, clear, h, icon, ICONS } from './dom'
import { Editor } from './editor'
import { translator, type Key } from './i18n'
import { decodeOpsSafe, LOGICAL_H, LOGICAL_W } from './ops'
import { randomPrompt } from './prompts'
import { drawOps, Replay } from './render'
import type { Session } from './session'
import type { Mode } from './assign'

interface Screen {
  key: string
  el: HTMLElement
  update?(): void
  destroy?(): void
}

const VIEW_W = 1200
const VIEW_H = 900

export class App {
  readonly t: ReturnType<typeof translator>
  private readonly root: HTMLElement
  private readonly header: HTMLElement
  private readonly main: HTMLElement
  private readonly toasts: HTMLElement
  private readonly floats: HTMLElement
  private screen: Screen | null = null
  private frame = 0
  private readonly editors = new Map<string, Editor>()
  private readonly texts = new Map<string, string>()
  private readonly editing = new Set<string>()
  private timerEl: HTMLElement | null = null

  constructor(private readonly room: Room, private readonly session: Session) {
    this.t = translator(room.locale)
    document.documentElement.lang = room.locale
    this.header = h('header', { class: 'bar' })
    this.main = h('main', { class: 'main' })
    this.toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' })
    this.floats = h('div', { class: 'floats', 'aria-hidden': 'true' })
    this.root = h('div', { class: 'app' }, this.header, this.main, this.floats, this.toasts)
    document.body.appendChild(this.root)
    this.applyTheme(room.theme)
    room.on('theme', (theme) => this.applyTheme(theme))
    room.on('visibility', () => this.root.classList.toggle('is-hidden', !room.visible))
    setInterval(() => this.tickTimer(), 250)
  }

  /** Re-render on the next frame. */
  changed(): void {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.render()
    })
  }

  toast(text: string, tone: 'info' | 'warn' = 'info'): void {
    const el = h('div', { class: `toast toast--${tone}` }, text)
    this.toasts.appendChild(el)
    setTimeout(() => el.classList.add('is-leaving'), 2600)
    setTimeout(() => el.remove(), 3000)
  }

  reacted(key: string, emoji: number): void {
    const s = this.session.state
    if (s?.reveal && key === entryKey(s.reveal.chain, s.reveal.upto) && !this.room.theme.reducedMotion && this.room.visible) {
      const el = h('span', { class: 'float', style: `left:${10 + Math.random() * 80}%` }, REACTIONS[emoji])
      this.floats.appendChild(el)
      setTimeout(() => el.remove(), 1800)
    }
    this.screen?.update?.()
  }

  private applyTheme(theme: ThemeInfo): void {
    const doc = document.documentElement
    doc.dataset.scheme = theme.scheme
    doc.style.setProperty('--accent', theme.accent)
    doc.classList.toggle('reduced-motion', theme.reducedMotion)
  }

  /* ---------------------------------------------------------------------------------------------- */

  private render(): void {
    this.renderHeader()
    const next = this.pick()
    if (this.screen && this.screen.key === next.key) {
      this.screen.update?.()
      return
    }
    this.screen?.destroy?.()
    this.session.draft = null
    this.screen = next.build()
    clear(this.main)
    this.main.appendChild(this.screen.el)
    this.screen.update?.()
  }

  private pick(): { key: string; build: () => Screen } {
    const s = this.session.state
    const session = this.session
    if (session.ended) return { key: 'ended', build: () => this.endedScreen() }
    if (!s) return { key: 'connecting', build: () => this.connectingScreen() }
    if (s.phase === 'lobby') return { key: `lobby:${s.game}`, build: () => this.lobbyScreen() }
    if (s.phase === 'play') {
      if (!s.players.includes(this.room.me.id)) return { key: `watch:${s.game}`, build: () => this.watchScreen() }
      const a = session.current()
      if (!a) return { key: `loading:${s.game}:${s.step}`, build: () => this.connectingScreen() }
      const id = `${a.game}:${a.step}`
      if (session.isSubmitted(a) && !this.editing.has(id)) return { key: `wait:${id}`, build: () => this.waitScreen(a) }
      return { key: `input:${id}:${a.kind}`, build: () => this.inputScreen(a) }
    }
    if (s.phase === 'reveal') return { key: `reveal:${s.game}:${s.reveal?.chain}`, build: () => this.revealScreen() }
    return { key: `over:${s.game}`, build: () => this.overScreen() }
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Header                                                                                         */
  /* ---------------------------------------------------------------------------------------------- */

  private renderHeader(): void {
    const s = this.session.state
    const t = this.t
    clear(this.header)
    this.timerEl = null
    // The client's panel names the app; the header carries the step, the timer and the connection.
    if (s && s.phase === 'play' && !this.session.ended) {
      const kind = s.kind
      this.header.appendChild(h('div', { class: 'step' },
        h('span', { class: `kind kind--${kind}` }, t(`kind_${kind}` as Key)),
        h('span', { class: 'step-count' }, t('stepOf', { n: s.step + 1, total: s.steps }))))
      this.timerEl = h('div', { class: 'timer', testid: 'dp-timer', role: 'timer', 'aria-live': 'off' })
      this.header.appendChild(this.timerEl)
      this.tickTimer()
    } else if (s && (s.phase === 'reveal' || s.phase === 'over')) {
      this.header.appendChild(h('div', { class: 'step' }, h('span', { class: 'kind kind--reveal' }, s.phase === 'over' ? t('awardsTitle') : t('revealTitle'))))
    }
    if (this.room.connection !== 'connected') {
      this.header.appendChild(h('div', { class: 'conn' }, t('reconnecting')))
    }
    this.header.hidden = this.header.childElementCount === 0
  }

  private tickTimer(): void {
    const s = this.session.state
    if (!this.timerEl || !s || s.phase !== 'play') return
    const left = Math.max(0, Math.ceil((s.deadline - this.room.serverNow()) / 1000))
    const total = s.kind === 'draw' ? s.settings.drawSeconds : s.settings.writeSeconds
    this.timerEl.textContent = ''
    const ring = h('span', { class: 'timer-ring', style: `--p:${Math.max(0, Math.min(1, left / total))}`, 'aria-hidden': 'true' })
    this.timerEl.append(ring, h('span', { class: 'timer-text' }, left > 0 ? `${left}` : this.t('timeUp')))
    this.timerEl.classList.toggle('is-urgent', left <= 10)
    this.timerEl.setAttribute('aria-label', left > 0 ? this.t('seconds', { n: left }) : this.t('timeUp'))
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Screens                                                                                        */
  /* ---------------------------------------------------------------------------------------------- */

  private connectingScreen(): Screen {
    return { key: 'connecting', el: h('section', { class: 'center' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('p', { class: 'muted' }, this.t('connecting'))) }
  }

  private endedScreen(): Screen {
    return {
      key: 'ended',
      el: h('section', { class: 'center ended', testid: 'dp-ended' },
        h('div', { class: 'hero-mark', 'aria-hidden': 'true' }, icon([...ICONS.pencil], 40)),
        h('h1', {}, this.t('endedTitle')),
        h('p', { class: 'muted' }, this.t('endedBody'))),
    }
  }

  private memberName(id: string, s: PublicState | null): string {
    return this.room.member(id)?.name ?? s?.names[id] ?? '…'
  }

  private memberAvatar(id: string, s: PublicState | null, size = 36): HTMLElement {
    const m = this.room.member(id)
    return avatar(this.memberName(id, s), id, m?.avatar ?? null, size)
  }

  private lobbyScreen(): Screen {
    const t = this.t
    const room = this.room
    const session = this.session
    const list = h('ul', { class: 'players', 'aria-label': t('players') })
    const count = h('span', { class: 'count' })
    const modeSelect: HTMLSelectElement = h('select', { testid: 'dp-mode', 'aria-label': t('mode'), onchange: () => session.hostSettings({ mode: modeSelect.value as Mode, drawSeconds: 0, writeSeconds: 0 }) },
      ...(['classic', 'speed', 'marathon'] as Mode[]).map((m) => h('option', { value: m }, t(`mode_${m}` as Key))))
    const hint = h('p', { class: 'hint' })
    const drawSelect: HTMLSelectElement = h('select', { 'aria-label': t('drawTime'), onchange: () => session.hostSettings({ drawSeconds: Number(drawSelect.value) }) },
      ...DRAW_SECONDS.map((n) => h('option', { value: n }, t('seconds', { n }))))
    const writeSelect: HTMLSelectElement = h('select', { 'aria-label': t('writeTime'), onchange: () => session.hostSettings({ writeSeconds: Number(writeSelect.value) }) },
      ...WRITE_SECONDS.map((n) => h('option', { value: n }, t('seconds', { n }))))
    const start = h('button', { type: 'button', class: 'primary big', testid: 'dp-start', onclick: () => session.hostStart() }, icon([...ICONS.play], 18), t('start'))
    const footer = h('div', { class: 'lobby-footer' })
    const note = h('p', { class: 'muted small' })

    const el = h('section', { class: 'lobby', testid: 'dp-lobby' },
      h('div', { class: 'hero' },
        h('div', { class: 'hero-mark', 'aria-hidden': 'true' }, icon([...ICONS.pencil], 34)),
        h('div', {}, h('h1', {}, 'DrawinPhone'), h('p', { class: 'muted' }, t('tagline')))),
      h('div', { class: 'lobby-grid' },
        h('div', { class: 'card' }, h('h2', {}, t('players'), ' ', count), list),
        h('div', { class: 'card settings' },
          h('h2', {}, t('settings')),
          h('label', { class: 'field' }, h('span', {}, t('mode')), modeSelect),
          hint,
          h('label', { class: 'field' }, h('span', {}, t('drawTime')), drawSelect),
          h('label', { class: 'field' }, h('span', {}, t('writeTime')), writeSelect))),
      footer)

    const update = () => {
      const s = session.state
      if (!s) return
      const members = [...room.members].sort((a, b) => a.joinedAt - b.joinedAt).slice(0, 16)
      clear(list)
      for (const m of members) {
        const badges = h('span', { class: 'player-badges' },
          m.id === room.hostId ? h('span', { class: 'badge badge--host', title: t('host') }, icon([...ICONS.crown], 12), t('host')) : null,
          m.id === room.me.id ? h('span', { class: 'badge' }, t('you')) : null)
        list.appendChild(h('li', { class: 'player', testid: 'dp-player' },
          avatar(m.name, m.id, m.avatar, 40),
          h('span', { class: 'player-info' }, h('span', { class: 'player-name' }, m.name), badges.childNodes.length ? badges : null)))
      }
      count.textContent = `${members.length}/16`
      modeSelect.value = s.settings.mode
      drawSelect.value = String(s.settings.drawSeconds)
      writeSelect.value = String(s.settings.writeSeconds)
      hint.textContent = t(`hint_${s.settings.mode}` as Key)
      for (const sel of [modeSelect, drawSelect, writeSelect]) sel.disabled = !room.isHost
      clear(footer)
      if (room.isHost) {
        start.disabled = members.length < 2
        footer.append(start)
        note.textContent = members.length < 2 ? t('needMore') : members.length < 4 ? t('best') : ''
        if (note.textContent) footer.append(note)
      } else {
        footer.append(h('p', { class: 'muted waiting-host' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), t('waitHost', { name: this.memberName(room.hostId, s) })))
      }
    }
    return { key: 'lobby', el, update }
  }

  private progress(s: PublicState): HTMLElement {
    const row = h('ul', { class: 'progress', 'aria-label': this.t('players') })
    for (const id of s.players) {
      const done = s.done.includes(id)
      const gone = !this.room.member(id)
      row.appendChild(h('li', { class: `chip${done ? ' is-done' : ''}${gone ? ' is-gone' : ''}`, title: this.memberName(id, s) },
        this.memberAvatar(id, s, 30),
        done ? h('span', { class: 'tick', 'aria-hidden': 'true' }, icon([...ICONS.check], 12)) : null,
        h('span', { class: 'sr' }, `${this.memberName(id, s)}${done ? ' ✓' : ''}${gone ? ` (${this.t('left')})` : ''}`)))
    }
    return row
  }

  private watchScreen(): Screen {
    const t = this.t
    const body = h('div', {})
    const el = h('section', { class: 'center', testid: 'dp-spectating' },
      h('div', { class: 'hero-mark', 'aria-hidden': 'true' }, icon([...ICONS.eye], 34)),
      h('h1', {}, t('spectating')),
      h('p', { class: 'muted' }, t('spectatingBody')),
      body)
    return {
      key: 'watch',
      el,
      update: () => {
        const s = this.session.state
        clear(body)
        if (s) body.appendChild(this.progress(s))
      },
    }
  }

  private waitScreen(a: Assign): Screen {
    const t = this.t
    const body = h('div', {})
    const count = h('p', { class: 'muted' })
    const id = `${a.game}:${a.step}`
    const edit = h('button', { type: 'button', class: 'ghost', testid: 'dp-edit', onclick: () => {
      this.editing.add(id)
      this.session.unsubmit()
      this.changed()
    } }, icon([...ICONS.pencil], 16), t('edit'))
    const el = h('section', { class: 'center waiting', testid: 'dp-waiting' },
      h('div', { class: 'done-mark', 'aria-hidden': 'true' }, icon([...ICONS.check], 40)),
      h('h1', {}, t('waitingTitle')),
      count,
      body,
      edit)
    return {
      key: 'wait',
      el,
      update: () => {
        const s = this.session.state
        clear(body)
        if (!s) return
        body.appendChild(this.progress(s))
        const working = s.players.filter((p) => !s.done.includes(p) && this.room.member(p)).length
        count.textContent = working ? t('waitingCount', { n: working }) : ''
        edit.hidden = this.room.serverNow() >= a.deadline - 1000
      },
    }
  }

  private inputScreen(a: Assign): Screen {
    const t = this.t
    const id = `${a.game}:${a.step}`
    const session = this.session
    const submitButton = h('button', { type: 'button', class: 'primary submit', testid: 'dp-submit' }, icon([...ICONS.check], 18), t('submit'))
    const finishEditing = () => this.editing.delete(id)

    if (a.kind === 'draw') {
      let editor = this.editors.get(id)
      if (!editor) {
        editor = new Editor(t, (text) => this.toast(text, 'warn'))
        for (const key of this.editors.keys()) if (key !== id) { this.editors.get(key)!.destroy(); this.editors.delete(key) }
        this.editors.set(id, editor)
        const previous = session.submitted.get(id)
        if (previous?.kind === 'drawing') editor.load(previous.ops)
      }
      const ed = editor
      const prompt = a.prev?.kind === 'text' ? a.prev : null
      session.draft = () => ({ kind: 'drawing', ops: ed.encoded() })
      submitButton.addEventListener('click', () => {
        finishEditing()
        session.submit({ kind: 'drawing', ops: ed.encoded() })
      })
      const el = h('section', { class: 'draw' },
        h('div', { class: 'draw-head' },
          h('div', { class: 'prompt' },
            h('span', { class: 'prompt-label' }, t('drawTitle')),
            h('strong', { class: 'prompt-text', testid: 'dp-draw-prompt' }, prompt?.text ?? '…'),
            prompt?.filled ? h('span', { class: 'badge badge--soft', title: t('autoPicked') }, icon([...ICONS.dice], 12)) : null),
          submitButton),
        ed.el)
      ed.setEnabled(true)
      return { key: 'draw', el, destroy: () => ed.setEnabled(false) }
    }

    const isWrite = a.kind === 'write'
    const input = h('input', {
      type: 'text',
      class: 'text-input',
      maxlength: TEXT_MAX,
      autocomplete: 'off',
      spellcheck: 'true',
      testid: isWrite ? 'dp-prompt-input' : 'dp-guess-input',
      placeholder: isWrite ? t('writePlaceholder') : t('describePlaceholder'),
      'aria-label': isWrite ? t('writeTitle') : t('describeTitle'),
    })
    const previous = session.submitted.get(id)
    input.value = this.texts.get(id) ?? (previous?.kind === 'text' ? previous.text : '')
    const counter = h('span', { class: 'counter', 'aria-hidden': 'true' })
    const refresh = () => {
      this.texts.set(id, input.value)
      counter.textContent = `${input.value.length}/${TEXT_MAX}`
      submitButton.disabled = !input.value.trim()
    }
    input.addEventListener('input', refresh)
    const send = () => {
      if (!input.value.trim()) return
      finishEditing()
      session.submit({ kind: 'text', text: input.value })
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        send()
      }
    })
    submitButton.addEventListener('click', send)
    session.draft = () => ({ kind: 'text', text: input.value })
    refresh()

    const actions = h('div', { class: 'text-actions' })
    if (isWrite) {
      actions.appendChild(h('button', { type: 'button', class: 'ghost', testid: 'dp-inspire', onclick: () => {
        input.value = randomPrompt(this.room.locale, input.value)
        refresh()
        input.focus()
      } }, icon([...ICONS.dice], 16), t('inspire')))
    }
    actions.appendChild(submitButton)

    let media: HTMLElement | null = null
    if (!isWrite) media = this.drawingView(a.prev, false)
    const el = h('section', { class: `text-step ${isWrite ? 'is-write' : 'is-describe'}` },
      h('h1', {}, isWrite ? t('writeTitle') : t('describeTitle')),
      media,
      h('div', { class: 'text-row' }, h('div', { class: 'text-wrap' }, input, counter), actions))
    queueMicrotask(() => input.focus({ preventScroll: true }))
    return { key: 'text', el }
  }

  /** A drawing entry, replayed when `animate`; a placeholder for a blank one. */
  private drawingView(entry: Entry | null | undefined, animate: boolean, onDone?: () => void): HTMLElement {
    const box = h('div', { class: 'drawing' })
    if (!entry || entry.kind !== 'drawing' || entry.filled || entry.marks === 0) {
      box.classList.add('is-blank')
      box.appendChild(h('span', {}, this.t('blankDrawing')))
      onDone?.()
      return box
    }
    const canvas = h('canvas', { width: VIEW_W, height: VIEW_H, role: 'img', 'aria-label': this.t('canvasLabel') })
    box.appendChild(canvas)
    const ops = decodeOpsSafe(entry.ops)
    if (!animate || this.room.theme.reducedMotion || !this.room.visible) {
      drawOps(canvas.getContext('2d')!, ops)
      onDone?.()
    } else {
      const replay = new Replay(canvas, ops, Math.min(7000, 1800 + entry.marks * 60), onDone)
      replay.play()
      const replayButton = h('button', { type: 'button', class: 'replay', 'aria-label': this.t('replay'), title: this.t('replay'), onclick: () => {
        const again = new Replay(canvas, ops, Math.min(7000, 1800 + entry.marks * 60))
        again.play()
      } }, icon([...ICONS.replay], 16))
      box.appendChild(replayButton)
    }
    return box
  }

  private entryCard(chain: number, step: number, entry: Entry, latest: boolean, s: PublicState): HTMLElement {
    const t = this.t
    const card = h('article', { class: `entry${latest ? ' is-latest' : ''}`, testid: 'dp-album-entry' })
    const who = h('div', { class: 'entry-who' }, this.memberAvatar(entry.by, s, 28), h('span', {}, this.memberName(entry.by, s)))
    if (entry.filled) who.appendChild(h('span', { class: 'badge badge--soft' }, t('skipped')))
    card.appendChild(who)
    if (entry.kind === 'text') {
      card.appendChild(h('p', { class: `bubble${step === 0 ? ' is-first' : ''}` }, entry.text))
    } else {
      card.appendChild(this.drawingView(entry, latest))
    }
    return card
  }

  private revealScreen(): Screen {
    const t = this.t
    const room = this.room
    const session = this.session
    const list = h('div', { class: 'album-list' })
    const title = h('h1', {})
    const sub = h('p', { class: 'muted small' })
    const reacts = h('div', { class: 'reacts', role: 'group' })
    const fav = h('button', { type: 'button', class: 'react fav', testid: 'dp-fav', 'aria-pressed': 'false', 'aria-label': t('favourite'), title: t('favourite') }, icon([...ICONS.star], 18))
    const footer = h('div', { class: 'album-footer' })
    const next = h('button', { type: 'button', class: 'primary', testid: 'dp-next', onclick: () => session.hostNext() })
    const auto = h('label', { class: 'switch' }, h('input', { type: 'checkbox', testid: 'dp-autoplay', onchange: (e: Event) => session.hostAuto((e.target as HTMLInputElement).checked) }), h('span', {}, t('autoplay')))
    const save = h('button', { type: 'button', class: 'ghost', testid: 'dp-save' }, icon([...ICONS.download], 16), t('save'))
    const shown = new Set<string>()

    REACTIONS.forEach((emoji, i) => {
      reacts.appendChild(h('button', { type: 'button', class: 'react', testid: `dp-react-${i}`, 'aria-label': t('react', { emoji }), onclick: () => {
        const s = session.state
        if (s?.reveal) session.react(s.reveal.chain, s.reveal.upto, i)
      } }, h('span', { class: 'react-emoji' }, emoji)))
    })
    reacts.appendChild(fav)
    fav.addEventListener('click', () => {
      const s = session.state
      if (s?.reveal) session.toggleFav(s.reveal.chain, s.reveal.upto)
    })
    save.addEventListener('click', async () => {
      const s = session.state
      if (!s?.reveal) return
      const blob = await chainImage(s, s.reveal.chain, (step) => session.entry(s.reveal!.chain, step), (id) => this.memberName(id, s), t)
      const ok = blob ? await room.saveImage(blob, `drawinphone-${this.memberName(s.players[s.reveal.chain], s).replace(/[^\w-]+/g, '_')}.png`) : false
      this.toast(ok ? t('saved') : t('saveFailed'), ok ? 'info' : 'warn')
    })

    const el = h('section', { class: 'album', testid: 'dp-album' },
      h('div', { class: 'album-head' }, h('div', {}, title, sub), save),
      list,
      h('div', { class: 'album-bar' }, reacts, footer))

    const update = () => {
      const s = session.state
      if (!s?.reveal) return
      const { chain, upto } = s.reveal
      const owner = s.players[chain]
      title.textContent = t('chainOf', { name: this.memberName(owner, s) })
      sub.textContent = t('chainProgress', { n: chain + 1, total: s.players.length })
      for (let step = 0; step <= upto; step++) {
        const key = entryKey(chain, step)
        if (shown.has(key)) continue
        const entry = session.entry(chain, step)
        if (!entry) break
        shown.add(key)
        list.querySelector('.entry.is-latest')?.classList.remove('is-latest')
        const card = this.entryCard(chain, step, entry, step === upto, s)
        list.appendChild(card)
        requestAnimationFrame(() => card.scrollIntoView({ behavior: room.theme.reducedMotion ? 'auto' : 'smooth', block: 'end' }))
      }
      const favKey = session.fav
      const current = entryKey(chain, upto)
      fav.setAttribute('aria-pressed', String(favKey === current))
      fav.classList.toggle('is-on', favKey === current)
      const count = session.reactions.get(current) ?? 0
      reacts.dataset.count = count ? String(count) : ''

      clear(footer)
      if (room.isHost) {
        const last = chain + 1 >= s.players.length && upto + 1 >= s.steps
        const lastOfChain = upto + 1 >= s.steps
        next.textContent = ''
        next.append(icon([...ICONS.next], 18), last ? t('showAwards') : lastOfChain ? t('nextChain') : t('next'))
        ;(auto.querySelector('input') as HTMLInputElement).checked = s.reveal.auto
        footer.append(auto, next)
      } else {
        footer.append(h('p', { class: 'muted small' }, t('presenting', { name: this.memberName(room.hostId, s) })))
      }
    }
    return { key: 'reveal', el, update }
  }

  private overScreen(): Screen {
    const t = this.t
    const room = this.room
    const session = this.session
    const grid = h('div', { class: 'awards' })
    const footer = h('div', { class: 'lobby-footer' })
    const el = h('section', { class: 'over', testid: 'dp-awards' },
      h('div', { class: 'hero' }, h('div', { class: 'hero-mark', 'aria-hidden': 'true' }, icon([...ICONS.crown], 34)), h('h1', {}, t('awardsTitle'))),
      grid,
      footer)
    const update = () => {
      const s = session.state
      if (!s) return
      clear(grid)
      const awards = s.awards ?? []
      if (!awards.length) grid.appendChild(h('p', { class: 'muted' }, t('noAwards')))
      for (const award of awards) grid.appendChild(this.awardCard(award, s))
      clear(footer)
      if (room.isHost) footer.append(h('button', { type: 'button', class: 'primary big', testid: 'dp-play-again', onclick: () => session.hostPlayAgain() }, icon([...ICONS.replay], 18), t('playAgain')))
      else footer.append(h('p', { class: 'muted waiting-host' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), t('waitAgain', { name: this.memberName(room.hostId, s) })))
    }
    return { key: 'over', el, update }
  }

  private awardCard(award: Award, s: PublicState): HTMLElement {
    const t = this.t
    const value = award.id === 'favourite' ? t('awardVotes', { n: award.value })
      : award.id === 'reactions' ? t('awardReactions', { n: award.value })
        : award.id === 'speed' ? t('awardSeconds', { n: award.value })
          : t('awardMarks', { n: award.value })
    const emoji = { favourite: '⭐', reactions: '🎉', speed: '⚡', detail: '🔍' }[award.id]
    const card = h('article', { class: `award award--${award.id}` },
      h('div', { class: 'award-emoji', 'aria-hidden': 'true' }, emoji),
      h('h2', {}, t(`award_${award.id}` as Key)),
      h('div', { class: 'award-who' }, this.memberAvatar(award.player, s, 32), h('strong', {}, this.memberName(award.player, s))),
      h('p', { class: 'muted small' }, value))
    if (award.chain !== undefined && award.step !== undefined) {
      const entry = this.session.entry(award.chain, award.step)
      if (entry?.kind === 'drawing') card.appendChild(this.drawingView(entry, false))
      else if (entry?.kind === 'text') card.appendChild(h('p', { class: 'bubble small' }, entry.text))
    }
    return card
  }
}

/** One chain as a PNG: title band, then each entry, text as a bubble and drawings at 600 x 450. */
async function chainImage(
  s: PublicState,
  chain: number,
  entryAt: (step: number) => Entry | undefined,
  name: (id: string) => string,
  t: ReturnType<typeof translator>,
): Promise<Blob | null> {
  const W = 760
  const PAD = 36
  const DRAW_W = W - PAD * 2
  const DRAW_H = Math.round((DRAW_W * LOGICAL_H) / LOGICAL_W)
  const entries: Entry[] = []
  for (let step = 0; step < s.steps; step++) {
    const e = entryAt(step)
    if (e) entries.push(e)
  }
  if (!entries.length) return null
  const heights = entries.map((e) => 34 + (e.kind === 'drawing' ? DRAW_H : 72) + 24)
  const H = 110 + heights.reduce((a, b) => a + b, 0) + 30
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  const font = (size: number, weight = 600) => `${weight} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Hiragino Sans", "Microsoft YaHei", sans-serif`
  const bg = ctx.createLinearGradient(0, 0, W, H)
  bg.addColorStop(0, '#1e1b4b')
  bg.addColorStop(1, '#4c0519')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = '#fdba74'
  ctx.font = font(15, 700)
  ctx.fillText('DRAWINPHONE', PAD, 46)
  ctx.fillStyle = '#ffffff'
  ctx.font = font(28, 800)
  ctx.fillText(t('chainOf', { name: name(s.players[chain]) }), PAD, 84)
  let y = 110
  const scratch = document.createElement('canvas')
  scratch.width = VIEW_W
  scratch.height = VIEW_H
  for (const entry of entries) {
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    ctx.font = font(15)
    ctx.fillText(name(entry.by), PAD, y + 22)
    y += 34
    if (entry.kind === 'drawing') {
      drawOps(scratch.getContext('2d')!, decodeOpsSafe(entry.ops))
      roundRect(ctx, PAD, y, DRAW_W, DRAW_H, 14)
      ctx.save()
      ctx.clip()
      ctx.drawImage(scratch, PAD, y, DRAW_W, DRAW_H)
      ctx.restore()
      y += DRAW_H
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.12)'
      roundRect(ctx, PAD, y, DRAW_W, 72, 16)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.font = font(22, 700)
      ctx.fillText(fit(ctx, entry.text, DRAW_W - 40), PAD + 20, y + 44)
      y += 72
    }
    y += 24
  }
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'))
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function fit(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text
  let out = text
  while (out.length > 1 && ctx.measureText(out + '…').width > width) out = out.slice(0, -1)
  return out + '…'
}

