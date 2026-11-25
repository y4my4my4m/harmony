/**
 * Signing in to a Matrix homeserver from the browser, for a bridge this instance runs with a
 * community's own account. The password goes to the homeserver alone.
 */

/** Homeservers allow cross-origin requests to these routes: client-server API, "Web Browser Clients". */
const REQUEST_MS = 15_000
const DEVICE_NAME = 'Harmony bridge'
/** matrix_bridge_set_account. */
const HOMESERVER_URL_MAX = 255
const ACCESS_TOKEN = /^[\x21-\x7e]{8,4096}$/

export type MatrixSignInIssue =
  | 'address'
  | 'unreachable'
  | 'not_matrix'
  | 'no_password'
  | 'wrong_password'
  | 'deactivated'
  | 'limited'
  | 'expires'
  | 'token_refused'
  | 'refused'

export class MatrixSignInError extends Error {
  constructor(
    readonly issue: MatrixSignInIssue,
    readonly retryAfterSeconds = 0,
  ) {
    super(issue)
    this.name = 'MatrixSignInError'
  }
}

/** https origin of a server name, an address or a user id; null when it names none. */
export function homeserverOrigin(input: string): string | null {
  const text = input.trim().replace(/^@[^:\s]+:/, '')
  if (!text || /\s/.test(text)) return null
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null
  if (url.pathname !== '/' || url.search || url.hash) return null
  return url.origin.length <= HOMESERVER_URL_MAX ? url.origin : null
}

export type MatrixTokenIssue = 'empty' | 'harmonyToken' | 'notToken'

export function checkMatrixToken(input: string): { token: string; issue: MatrixTokenIssue | null } {
  const token = input.trim().replace(/^bearer\s+/i, '').replace(/^["']|["']$/g, '').trim()
  if (!token) return { token, issue: 'empty' }
  if (token.startsWith('harmony_bot_')) return { token, issue: 'harmonyToken' }
  return { token, issue: ACCESS_TOKEN.test(token) ? null : 'notToken' }
}

interface Answer {
  status: number
  retryAfter: string | null
  body: Record<string, unknown>
}

/** A redirect would carry a password or a token to another host; discovery alone follows one. */
async function request(url: string, init: RequestInit = {}): Promise<Answer> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), REQUEST_MS)
  let response: Response
  let text: string
  try {
    response = await fetch(url, { redirect: 'error', ...init, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: abort.signal })
    text = await response.text()
  } catch {
    throw new MatrixSignInError('unreachable')
  } finally {
    clearTimeout(timer)
  }
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    /* an answer that is no JSON has no fields */
  }
  return {
    status: response.status,
    retryAfter: response.headers.get('Retry-After'),
    body: body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {},
  }
}

/** Well-known discovery: m.homeserver.base_url of the server name, else the address itself. */
export async function resolveClientApi(origin: string): Promise<string> {
  let answer: Answer
  try {
    answer = await request(`${origin}/.well-known/matrix/client`, { redirect: 'follow' })
  } catch {
    return origin
  }
  const named = (answer.body['m.homeserver'] as { base_url?: unknown } | null | undefined)?.base_url
  if (answer.status !== 200 || typeof named !== 'string') return origin
  let base: URL
  try {
    base = new URL(named)
  } catch {
    throw new MatrixSignInError('not_matrix')
  }
  // A password is sent there.
  if (base.protocol !== 'https:' || base.username || base.password) throw new MatrixSignInError('not_matrix')
  return `${base.origin}${base.pathname}`.replace(/\/+$/, '')
}

function failure({ status, retryAfter, body }: Answer): MatrixSignInError {
  const code = body.errcode
  if (status === 429 || code === 'M_LIMIT_EXCEEDED') {
    const ms = Number(body.retry_after_ms) || Number(retryAfter) * 1000 || 0
    return new MatrixSignInError('limited', Math.ceil(Math.min(Math.max(ms, 0), 86_400_000) / 1000))
  }
  if (code === 'M_USER_DEACTIVATED') return new MatrixSignInError('deactivated')
  if (code === 'M_FORBIDDEN') return new MatrixSignInError('wrong_password')
  return new MatrixSignInError(typeof code === 'string' ? 'refused' : 'not_matrix')
}

/** Throws no_password where the homeserver signs people in some other way only. */
export async function requirePasswordLogin(clientApi: string): Promise<void> {
  const answer = await request(`${clientApi}/_matrix/client/v3/login`)
  const { flows } = answer.body
  if (answer.status !== 200 || !Array.isArray(flows)) {
    const error = failure(answer)
    // The listing of flows checks no password.
    throw error.issue === 'wrong_password' ? new MatrixSignInError('refused') : error
  }
  if (!flows.some((flow) => (flow as { type?: unknown } | null)?.type === 'm.login.password')) throw new MatrixSignInError('no_password')
}

/** The access token of a new session. Without refresh_token in the request it does not expire. */
export async function signInWithPassword(clientApi: string, user: string, password: string): Promise<string> {
  const answer = await request(`${clientApi}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password,
      initial_device_display_name: DEVICE_NAME,
    }),
  })
  if (answer.status !== 200) throw failure(answer)
  const token = answer.body.access_token
  if (typeof token !== 'string' || !ACCESS_TOKEN.test(token)) throw new MatrixSignInError('not_matrix')
  if (typeof answer.body.expires_in_ms === 'number' || answer.body.refresh_token) {
    await signOut(clientApi, token)
    throw new MatrixSignInError('expires')
  }
  return token
}

/** Throws token_refused for a token the homeserver does not know; silent when it cannot be asked. */
export async function checkTokenWithHomeserver(clientApi: string, token: string): Promise<void> {
  let answer: Answer
  try {
    answer = await request(`${clientApi}/_matrix/client/v3/account/whoami`, { headers: { Authorization: `Bearer ${token}` } })
  } catch {
    return
  }
  if (answer.status === 401 || answer.body.errcode === 'M_UNKNOWN_TOKEN') throw new MatrixSignInError('token_refused')
}

/** Ends a session that came to no use. */
export async function signOut(clientApi: string, token: string): Promise<void> {
  try {
    await request(`${clientApi}/_matrix/client/v3/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
  } catch {
    /* the session stays in the account's list as "Harmony bridge" */
  }
}
