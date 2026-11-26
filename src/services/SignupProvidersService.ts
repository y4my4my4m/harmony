/**
 * Whom each sign-in provider makes a new account for: instance_config.signup_providers, which the
 * sign-up hook reads (20261126500001_signup_methods.sql).
 *
 *   { "<provider>": { "mode": "open" } | { "mode": "domains", "domains": ["myschool.edu"] } }
 *
 * A provider absent follows instance_config.registration_policy, as email sign-up does. "domains"
 * takes an address the provider marks verified at a listed domain or a subdomain of one.
 */
import { supabase } from '@/supabase'
import { adminService } from '@/services/AdminService'
import { runtimeConfig } from '@/services/runtimeConfig'
import { BUILT_IN_OAUTH_PROVIDERS, oauthProviderLabel, parseCustomOAuthProviders } from '@/utils/customOAuthProviders'

export type SignupMode = 'follow' | 'open' | 'domains'

export interface ProviderSignup {
  mode: SignupMode
  domains: string[]
}

export interface SignupProvider {
  id: string
  name: string
  /** A service anyone can create an account at, as opposed to the instance's own. */
  public: boolean
  signup: ProviderSignup
}

export interface SignupProviders {
  providers: SignupProvider[]
  /** GoTrue's sign-up switch refuses every new account; null when /settings did not answer. */
  switchOn: boolean | null
}

const KEY = 'signup_providers'
const NOT_PROVIDERS = new Set(['email', 'phone', 'anonymous_users'])

const FOLLOW: Readonly<ProviderSignup> = { mode: 'follow', domains: [] }

/** The entries of a stored value; one the hook would read as following registration is left out. */
export function parseSignupProviders(raw: unknown): Record<string, ProviderSignup> {
  const out: Record<string, ProviderSignup> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const { mode, domains } = entry as Record<string, unknown>
    const name = typeof mode === 'string' ? mode.trim().toLowerCase() : ''
    if (name === 'open') {
      out[id] = { mode: 'open', domains: [] }
    } else if (name === 'domains') {
      const list = Array.isArray(domains) ? domains.filter((d): d is string => typeof d === 'string') : []
      out[id] = { mode: 'domains', domains: list }
    }
  }
  return out
}

/** The value to store: providers that follow registration are absent. */
export function serializeSignupProviders(entries: Record<string, ProviderSignup>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const id of Object.keys(entries).sort()) {
    const entry = entries[id]
    if (entry.mode === 'open') out[id] = { mode: 'open' }
    else if (entry.mode === 'domains') out[id] = { mode: 'domains', domains: [...entry.domains] }
  }
  return out
}

/** GoTrue's /settings: the providers it has on and its sign-up switch. */
async function authSettings(): Promise<{ external: Record<string, unknown>; disableSignup: boolean | null } | null> {
  const base = (runtimeConfig.supabaseUrl || '').replace(/\/+$/, '')
  const key = runtimeConfig.supabaseAnonKey
  if (!base || !key) return null
  try {
    const res = await fetch(`${base}/auth/v1/settings`, { headers: { apikey: key }, cache: 'no-store' })
    if (!res.ok) return null
    const body = (await res.json()) as { external?: Record<string, unknown>; disable_signup?: unknown }
    return {
      external: body.external ?? {},
      disableSignup: typeof body.disable_signup === 'boolean' ? body.disable_signup : null,
    }
  } catch {
    return null
  }
}

/**
 * The providers to show: GoTrue's own that are on, the built-in ones first, then the instance's
 * own (custom_oauth_providers), then any other with a stored entry.
 */
export async function loadSignupProviders(): Promise<SignupProviders> {
  const [settings, rows] = await Promise.all([
    authSettings(),
    supabase.from('instance_config').select('config_key, config_value').in('config_key', [KEY, 'custom_oauth_providers']),
  ])
  if (rows.error) throw rows.error
  const stored = new Map((rows.data ?? []).map((row) => [row.config_key, row.config_value as unknown]))
  const entries = parseSignupProviders(stored.get(KEY))
  const custom = parseCustomOAuthProviders(stored.get('custom_oauth_providers'))

  const ids: string[] = []
  const add = (id: string) => { if (!ids.includes(id)) ids.push(id) }
  const external = settings?.external ?? {}
  for (const id of BUILT_IN_OAUTH_PROVIDERS) if (external[id] === true) add(id)
  for (const [id, on] of Object.entries(external)) if (on === true && !NOT_PROVIDERS.has(id)) add(id)
  for (const provider of custom) add(provider.id)
  for (const id of Object.keys(entries)) add(id)

  return {
    providers: ids.map((id) => ({
      id,
      name: oauthProviderLabel(id, custom),
      public: !id.startsWith('custom:') && !id.startsWith('sso:'),
      signup: entries[id] ?? { ...FOLLOW },
    })),
    switchOn: settings?.disableSignup ?? null,
  }
}

/** Stores every provider's entry, the ones that follow registration removed. */
export async function saveSignupProviders(providers: SignupProvider[], adminId: string): Promise<void> {
  const entries: Record<string, ProviderSignup> = {}
  for (const provider of providers) entries[provider.id] = provider.signup
  await adminService.setInstanceConfigs({ [KEY]: serializeSignupProviders(entries) }, adminId)
}
