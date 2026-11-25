/**
 * Local activity harness: plays the Harmony client for several sandboxed frames on one page, with an
 * in-memory relay that follows federation-backend src/activities/relay.ts: first member hosts, host
 * writes state and store, store handed to a promoted host, messages to everyone / the host / listed
 * members, member state, end. Frames load /activities/<id>/<entry> from the dev server. Not a
 * security boundary: dev frames carry no CSP.
 *
 * window.harness exposes the controls to scripted tests.
 */

import {
  MEMBER_STATE_MAX_BYTES,
  MESSAGE_MAX_BYTES,
  PROTOCOL_VERSION,
  STATE_MAX_BYTES,
  STORE_VALUE_MAX_BYTES,
  jsonBytes,
  type FrameToHost,
  type HostToFrame,
  type Json,
  type SessionInfo,
  type ThemeInfo,
  type WireMember,
} from '../sdk/protocol'

interface CatalogApp {
  id: string
  name: string
  entry: string
  minPlayers: number
  maxPlayers: number
}

interface Player {
  id: string
  name: string
  panel: HTMLElement
  frame: HTMLIFrameElement
  hostBadge: HTMLElement
  connected: boolean
  joinedAt: number
  state: Json
  avatar: Blob
}

const NAMES = ['Ava', 'Ben', 'Cleo', 'Dev', 'Emi', 'Finn', 'Gus', 'Hana', 'Ivo', 'Jun', 'Kai', 'Lea', 'Mo', 'Nia', 'Oz', 'Pia']
const COLOURS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899']
const HOST_GRACE_MS = 1500

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const grid = $('grid')
const logEl = $('log')
const appSelect = $<HTMLSelectElement>('app')
const themeSelect = $<HTMLSelectElement>('theme')
const localeSelect = $<HTMLSelectElement>('locale')
const sizeSelect = $<HTMLSelectElement>('size')
const motionBox = $<HTMLInputElement>('motion')

function log(text: string): void {
  logEl.textContent = `${new Date().toLocaleTimeString()} ${text}\n${logEl.textContent}`.slice(0, 6000)
}

function avatarBlob(name: string, i: number): Blob {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${COLOURS[i % COLOURS.length]}"/><text x="32" y="42" font-family="sans-serif" font-size="30" font-weight="700" text-anchor="middle" fill="#fff">${name[0]}</text></svg>`
  return new Blob([svg], { type: 'image/svg+xml' })
}

class FakeRelay {
  readonly players = new Map<string, Player>()
  host: string | null = null
  state: Json = null
  readonly store = new Map<string, Json>()
  readonly saved: Array<{ name: string; size: number; type: string }> = []
  ended = false
  private seq = 0
  private hostTimer: ReturnType<typeof setTimeout> | null = null
  private readonly session: SessionInfo

  constructor(readonly app: CatalogApp) {
    this.session = { id: crypto.randomUUID(), appId: app.id, context: 'group', startedBy: null, maxPlayers: app.maxPlayers, minPlayers: app.minPlayers }
    window.addEventListener('message', (event) => this.onMessage(event))
  }

  get theme(): ThemeInfo {
    return { scheme: themeSelect.value === 'light' ? 'light' : 'dark', accent: '#0ea5e9', reducedMotion: motionBox.checked }
  }

  addPlayer(): Player {
    const index = this.seq++
    const id = `p${index}`
    const name = NAMES[index % NAMES.length] + (index >= NAMES.length ? ` ${Math.floor(index / NAMES.length) + 1}` : '')
    const [w, h] = sizeSelect.value.split('x').map(Number)
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.width = String(w)
    frame.height = String(h)
    frame.title = name
    frame.dataset.player = id
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><script src="${location.origin}/activities/${this.app.id}/${this.app.entry}"></script></body></html>`
    const hostBadge = document.createElement('span')
    hostBadge.className = 'host'
    const head = document.createElement('div')
    head.className = 'player-head'
    const title = document.createElement('strong')
    title.textContent = name
    const leave = document.createElement('button')
    leave.type = 'button'
    leave.textContent = 'Remove'
    leave.addEventListener('click', () => this.removePlayer(id, 'left'))
    const reload = document.createElement('button')
    reload.type = 'button'
    reload.textContent = 'Reload'
    reload.addEventListener('click', () => this.reload(id))
    head.append(title, hostBadge, reload, leave)
    const panel = document.createElement('section')
    panel.className = 'player'
    panel.id = id
    panel.append(head, frame)
    grid.appendChild(panel)
    const player: Player = { id, name, panel, frame, hostBadge, connected: false, joinedAt: 0, state: null, avatar: avatarBlob(name, index) }
    this.players.set(id, player)
    return player
  }

  /** The frame reloads; the member keeps its place, as the relay keeps a reconnecting member. */
  reload(id: string): void {
    const p = this.players.get(id)
    if (!p) return
    p.frame.srcdoc = p.frame.srcdoc + ' '
  }

  removePlayer(id: string, reason: 'left' | 'timeout' | 'removed'): void {
    const p = this.players.get(id)
    if (!p || !p.connected) return
    p.connected = false
    p.panel.classList.add('is-gone')
    p.frame.srcdoc = '<body style="background:#000"></body>'
    this.broadcast({ hp: PROTOCOL_VERSION, t: 'leave', id, reason })
    log(`${p.name} left (${reason})`)
    if (this.host === id) {
      const promote = () => {
        this.hostTimer = null
        if (this.host === id) this.promote()
      }
      if (reason === 'removed') promote()
      else this.hostTimer = setTimeout(promote, HOST_GRACE_MS)
    }
  }

  killHost(): void {
    if (this.host) this.removePlayer(this.host, 'timeout')
  }

  setTheme(): void {
    this.broadcast({ hp: PROTOCOL_VERSION, t: 'theme', theme: this.theme })
  }

  private connected(): Player[] {
    return [...this.players.values()].filter((p) => p.connected).sort((a, b) => a.joinedAt - b.joinedAt)
  }

  private wire(p: Player): WireMember {
    return { id: p.id, name: p.name, username: p.name.toLowerCase(), avatarUrl: null, joinedAt: p.joinedAt, spectator: false, state: p.state, avatarBlob: p.avatar, nameParts: [{ text: p.name }] }
  }

  private storeObject(): Record<string, Json> {
    return Object.fromEntries(this.store)
  }

  private post(p: Player, msg: HostToFrame): void {
    p.frame.contentWindow?.postMessage(msg, '*')
  }

  private broadcast(msg: HostToFrame, except?: Player): void {
    for (const p of this.connected()) if (p !== except) this.post(p, msg)
  }

  private promote(): void {
    const next = this.connected()[0]
    if (!next) return
    this.host = next.id
    for (const p of this.connected()) this.post(p, p === next ? { hp: PROTOCOL_VERSION, t: 'host', id: next.id, store: this.storeObject() } : { hp: PROTOCOL_VERSION, t: 'host', id: next.id })
    this.paintHost()
    log(`${next.name} is host`)
  }

  private paintHost(): void {
    for (const p of this.players.values()) p.hostBadge.textContent = p.id === this.host ? '★ host' : ''
  }

  private error(p: Player, code: 'NOT_HOST' | 'TOO_LARGE'): void {
    this.post(p, { hp: PROTOCOL_VERSION, t: 'error', code })
    log(`${p.name}: ${code}`)
  }

  private onMessage(event: MessageEvent): void {
    const p = [...this.players.values()].find((x) => x.frame.contentWindow === event.source)
    const msg = event.data as FrameToHost
    if (!p || !msg || msg.hp !== PROTOCOL_VERSION || typeof msg.t !== 'string' || this.ended) return
    if (msg.t === 'ready') return this.ready(p)
    if (!p.connected) return
    switch (msg.t) {
      case 'send': {
        if (jsonBytes(msg.data) > MESSAGE_MAX_BYTES) return this.error(p, 'TOO_LARGE')
        const out: HostToFrame = { hp: PROTOCOL_VERSION, t: 'message', from: p.id, data: msg.data }
        if (!msg.to) this.broadcast(out, p)
        else if (msg.to === 'host') {
          const host = this.host ? this.players.get(this.host) : undefined
          if (host?.connected && host !== p) this.post(host, out)
        } else {
          for (const id of new Set(msg.to)) {
            const target = this.players.get(id)
            if (target?.connected && target !== p) this.post(target, out)
          }
        }
        return
      }
      case 'state':
        if (this.host !== p.id) return this.error(p, 'NOT_HOST')
        if (jsonBytes(msg.state) > STATE_MAX_BYTES) return this.error(p, 'TOO_LARGE')
        this.state = msg.state
        this.broadcast({ hp: PROTOCOL_VERSION, t: 'state', state: msg.state, from: p.id }, p)
        return
      case 'store':
        if (this.host !== p.id) return this.error(p, 'NOT_HOST')
        if (msg.value === undefined) this.store.delete(msg.key)
        else if (jsonBytes(msg.value) > STORE_VALUE_MAX_BYTES) return this.error(p, 'TOO_LARGE')
        else this.store.set(msg.key, msg.value)
        return
      case 'me':
        if (jsonBytes(msg.state) > MEMBER_STATE_MAX_BYTES) return this.error(p, 'TOO_LARGE')
        p.state = msg.state
        this.broadcast({ hp: PROTOCOL_VERSION, t: 'member', id: p.id, state: msg.state }, p)
        return
      case 'end':
        if (this.host !== p.id) return this.error(p, 'NOT_HOST')
        this.broadcast({ hp: PROTOCOL_VERSION, t: 'ended', reason: 'host_ended' })
        this.ended = true
        log('ended')
        return
      case 'leave':
        this.removePlayer(p.id, 'left')
        return
      case 'notify':
        log(`${p.name} notify: ${msg.text}`)
        return
      case 'save': {
        this.saved.push({ name: msg.name, size: msg.blob.size, type: msg.blob.type })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(msg.blob)
        a.download = msg.name
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
        this.post(p, { hp: PROTOCOL_VERSION, t: 'saved', id: msg.id, ok: true })
        log(`${p.name} saved ${msg.name} (${msg.blob.size} B)`)
        return
      }
    }
  }

  private ready(p: Player): void {
    const rejoin = p.connected
    if (!p.connected) {
      p.connected = true
      p.joinedAt = p.joinedAt || Date.now()
      p.panel.classList.remove('is-gone')
    }
    let promoted = false
    if (this.host === null || (!this.players.get(this.host)?.connected && !this.hostTimer)) {
      this.host = p.id
      promoted = true
    } else if (this.host === p.id && this.hostTimer) {
      clearTimeout(this.hostTimer)
      this.hostTimer = null
    }
    this.post(p, {
      hp: PROTOCOL_VERSION,
      t: 'init',
      session: this.session,
      you: p.id,
      members: this.connected().map((m) => this.wire(m)),
      host: this.host!,
      state: this.state,
      ...(this.host === p.id ? { store: this.storeObject() } : {}),
      canEnd: this.host === p.id,
      clockOffset: 0,
      locale: localeSelect.value,
      theme: this.theme,
      visible: true,
    })
    if (!rejoin) this.broadcast({ hp: PROTOCOL_VERSION, t: 'join', member: this.wire(p) }, p)
    if (promoted) this.broadcast({ hp: PROTOCOL_VERSION, t: 'host', id: p.id }, p)
    this.paintHost()
    log(`${p.name} ${rejoin ? 'reloaded' : 'joined'}`)
  }
}

let relay: FakeRelay | null = null
let apps: CatalogApp[] = []

function reset(players = 3): void {
  grid.textContent = ''
  const app = apps.find((a) => a.id === appSelect.value) ?? apps[0]
  if (!app) return
  relay = new FakeRelay(app)
  for (let i = 0; i < players; i++) relay.addPlayer()
}

async function boot(): Promise<void> {
  const catalog = await fetch('/activities/index.json').then((r) => r.json()) as { apps: CatalogApp[] }
  apps = catalog.apps
  for (const app of apps) appSelect.appendChild(new Option(app.name, app.id))
  const params = new URLSearchParams(location.search)
  if (params.get('app')) appSelect.value = params.get('app')!
  if (params.get('size')) sizeSelect.value = params.get('size')!
  if (params.get('theme')) themeSelect.value = params.get('theme')!
  if (params.get('locale')) localeSelect.value = params.get('locale')!
  reset(Number(params.get('players') ?? 3))
}

$('add').addEventListener('click', () => relay?.addPlayer())
$('kill').addEventListener('click', () => relay?.killHost())
$('reset').addEventListener('click', () => reset(relay ? relay.players.size : 3))
appSelect.addEventListener('change', () => reset())
themeSelect.addEventListener('change', () => relay?.setTheme())
motionBox.addEventListener('change', () => relay?.setTheme())
localeSelect.addEventListener('change', () => reset(relay ? relay.players.size : 3))
sizeSelect.addEventListener('change', () => {
  const [w, h] = sizeSelect.value.split('x')
  for (const frame of grid.querySelectorAll('iframe')) {
    frame.width = w
    frame.height = h
  }
})

;(window as unknown as { harness: unknown }).harness = {
  get relay() { return relay },
  addPlayer: () => relay?.addPlayer().id,
  removePlayer: (id: string) => relay?.removePlayer(id, 'left'),
  killHost: () => relay?.killHost(),
  reload: (id: string) => relay?.reload(id),
  reset,
}

boot().catch((error: Error) => log(`boot failed: ${error.message}`))
