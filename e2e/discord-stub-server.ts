// A stand-in for Discord, for the "Migrate from Discord" journey: the identify-only user OAuth
// (authorize, token, @me) and the bot-token reads the gateway makes (guild roles, members, bans,
// channels, the bot's application). Started in-process by e2e/specs/discord-migration.spec.ts; the bot
// gateway points DISCORD_OAUTH_BASE at `url` and DISCORD_API_BASE at `apiUrl`.
//
// The state is a plain object the spec edits between steps (drop a role from a member, ...).

import http from 'node:http'
import type { AddressInfo } from 'node:net'

export const STUB_BOT_TOKEN = 'stubbottoken0000.stub.stubbottoken0000'
export const STUB_CLIENT_ID = '900000000000000001'
export const STUB_CLIENT_SECRET = 'stub-client-secret'

export interface StubRole {
  id: string
  name: string
  color?: number
  position: number
  /** Discord permission bitfield, as a decimal string. */
  permissions: string
  managed?: boolean
}

export interface StubMember {
  user: { id: string; username: string; global_name?: string | null; avatar?: string | null }
  roles: string[]
  nick?: string | null
  joined_at: string
  communication_disabled_until?: string | null
}

export interface DiscordStubState {
  guildId: string
  roles: StubRole[]
  members: StubMember[]
  bans: string[]
  /** The Discord user a consent click signs in as. */
  consentUserId: string
}

export interface DiscordStub {
  /** Root: serves /oauth2/authorize (DISCORD_OAUTH_BASE). */
  url: string
  /** REST base (DISCORD_API_BASE). */
  apiUrl: string
  state: DiscordStubState
  /** Paths the gateway asked for, in order, for assertions. */
  requests: string[]
  stop(): Promise<void>
}

export async function startDiscordStub(state: DiscordStubState): Promise<DiscordStub> {
  const requests: string[] = []
  const codes = new Map<string, string>()

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub')
    const path = url.pathname
    requests.push(`${req.method} ${path}`)
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const bot = req.headers.authorization === `Bot ${STUB_BOT_TOKEN}`
    const memberBody = (m: StubMember) => ({
      user: m.user,
      roles: m.roles,
      nick: m.nick ?? null,
      joined_at: m.joined_at,
      communication_disabled_until: m.communication_disabled_until ?? null,
    })

    // The consent screen: approves at once and returns to the redirect URI, as Discord does for
    // an app the user already authorised (prompt=none).
    if (path === '/oauth2/authorize') {
      const redirect = url.searchParams.get('redirect_uri')
      const stateParam = url.searchParams.get('state') ?? ''
      if (!redirect) return json(400, { message: 'redirect_uri missing' })
      const code = `code-${codes.size + 1}-${Date.now()}`
      codes.set(code, state.consentUserId)
      const back = new URL(redirect)
      back.searchParams.set('code', code)
      back.searchParams.set('state', stateParam)
      // A page with a button rather than a 302: the spec's proxy for /bot-gateway sees a
      // click's navigation, not a redirect hop.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return void res.end(
        `<!doctype html><title>Discord</title><h1>Authorize the app</h1>` +
          `<p>Scope: ${(url.searchParams.get('scope') ?? '').replace(/[<&]/g, '')}</p>` +
          `<a id="stub-authorize" href="${back.toString().replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">Authorize</a>`,
      )
    }

    if (!path.startsWith('/api/v10/')) return json(404, { message: 'Not Found', code: 0 })
    const rest = path.slice('/api/v10'.length)

    if (req.method === 'POST' && rest === '/oauth2/token') {
      let raw = ''
      req.on('data', (c: Buffer) => { raw += c.toString() })
      req.on('end', () => {
        const form = new URLSearchParams(raw)
        const userId = codes.get(form.get('code') ?? '')
        if (!userId || form.get('client_secret') !== STUB_CLIENT_SECRET) return json(400, { error: 'invalid_grant' })
        json(200, { access_token: `access-${userId}`, token_type: 'Bearer', scope: 'identify' })
      })
      return
    }

    if (rest === '/users/@me') {
      const userId = /^Bearer access-(\d+)$/.exec(req.headers.authorization ?? '')?.[1]
      const m = state.members.find((x) => x.user.id === userId)
      if (!m) return json(401, { message: '401: Unauthorized', code: 0 })
      return json(200, m.user)
    }

    if (!bot) return json(401, { message: '401: Unauthorized', code: 0 })

    if (rest === '/oauth2/applications/@me') return json(200, { id: STUB_CLIENT_ID })

    const guild = new RegExp(`^/guilds/${state.guildId}(/.*)?$`).exec(rest)
    if (!guild) return json(404, { message: 'Unknown Guild', code: 10004 })
    const sub = guild[1] ?? ''

    if (sub === '/roles') {
      return json(200, [
        { id: state.guildId, name: '@everyone', color: 0, position: 0, permissions: '0', managed: false },
        ...state.roles.map((r) => ({ ...r, color: r.color ?? 0, managed: r.managed ?? false })),
      ])
    }
    if (sub === '/channels') return json(200, [])
    const memberId = /^\/members\/(\d+)$/.exec(sub)?.[1]
    if (memberId) {
      const m = state.members.find((x) => x.user.id === memberId)
      return m ? json(200, memberBody(m)) : json(404, { message: 'Unknown Member', code: 10007 })
    }
    const banId = /^\/bans\/(\d+)$/.exec(sub)?.[1]
    if (banId) return state.bans.includes(banId) ? json(200, { user: { id: banId } }) : json(404, { message: 'Unknown Ban', code: 10026 })
    return json(404, { message: 'Not Found', code: 0 })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url: origin,
    apiUrl: `${origin}/api/v10`,
    state,
    requests,
    stop: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}
