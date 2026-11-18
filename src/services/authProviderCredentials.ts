// Sign-in credentials of the built-in OAuth providers (migration 20261117800001). The secret is
// write-only: the status names the client id and whether a secret is stored.

import { supabase } from '@/supabase'
import { runtimeConfig } from '@/services/runtimeConfig'
import { BUILT_IN_OAUTH_PROVIDERS, type BuiltInOAuthProvider } from '@/utils/customOAuthProviders'

export interface ProviderCredentials {
  provider: BuiltInOAuthProvider
  clientId: string | null
  hasSecret: boolean
  updatedAt: string | null
}

export interface CredentialsWriter {
  seenAt: string | null
  appliedAt: string | null
  error: string | null
  /** The federation server passed within 90 s. */
  live: boolean
}

export interface CredentialsStatus {
  providers: Partial<Record<BuiltInOAuthProvider, ProviderCredentials>>
  writer: CredentialsWriter
}

// auth_provider_valid_value(): no character that could end a value or open another key.
const VALUE = /^[A-Za-z0-9][A-Za-z0-9._~+/=-]*$/

export type CredentialProblem = 'clientId' | 'discordId' | 'secret' | 'needBoth'

/**
 * What the database would refuse in a save of PROVIDER, null when nothing. Empty fields keep the
 * stored values; a provider without stored ones needs both.
 */
export function credentialProblem(
  provider: BuiltInOAuthProvider,
  clientId: string,
  secret: string,
  stored: ProviderCredentials | undefined,
): CredentialProblem | null {
  const id = clientId.trim()
  const key = secret.trim()
  if (id) {
    if (provider === 'discord' && !/^[0-9]{17,20}$/.test(id)) return 'discordId'
    if (id.length > 256 || !VALUE.test(id)) return 'clientId'
  }
  if (key && (key.length < 8 || key.length > 512 || !VALUE.test(key))) return 'secret'
  if (!(id || stored?.clientId) || !(key || stored?.hasSecret)) return 'needBoth'
  return null
}

function parseStatus(raw: unknown): CredentialsStatus {
  const value = (raw ?? {}) as { providers?: unknown; writer?: Record<string, unknown> }
  const providers: CredentialsStatus['providers'] = {}
  for (const row of Array.isArray(value.providers) ? value.providers : []) {
    const r = row as Record<string, unknown>
    const provider = r.provider as BuiltInOAuthProvider
    if (!BUILT_IN_OAUTH_PROVIDERS.includes(provider)) continue
    providers[provider] = {
      provider,
      clientId: typeof r.client_id === 'string' ? r.client_id : null,
      hasSecret: r.has_secret === true,
      updatedAt: typeof r.updated_at === 'string' ? r.updated_at : null,
    }
  }
  const w = value.writer ?? {}
  return {
    providers,
    writer: {
      seenAt: typeof w.seen_at === 'string' ? w.seen_at : null,
      appliedAt: typeof w.applied_at === 'string' ? w.applied_at : null,
      error: typeof w.error === 'string' ? w.error : null,
      live: w.live === true,
    },
  }
}

export async function fetchCredentialsStatus(): Promise<CredentialsStatus> {
  const { data, error } = await supabase.rpc('auth_provider_credentials_status')
  if (error) throw error
  return parseStatus(data)
}

/** Empty CLIENT_ID or SECRET keeps the stored value. */
export async function saveCredentials(
  provider: BuiltInOAuthProvider,
  clientId: string,
  secret: string,
): Promise<CredentialsStatus> {
  const { data, error } = await supabase.rpc('auth_provider_credentials_set', {
    p_provider: provider,
    p_client_id: clientId.trim() || null,
    p_secret: secret.trim() || null,
  })
  if (error) throw error
  return parseStatus(data)
}

export async function clearCredentials(provider: BuiltInOAuthProvider): Promise<CredentialsStatus> {
  const { data, error } = await supabase.rpc('auth_provider_credentials_clear', { p_provider: provider })
  if (error) throw error
  return parseStatus(data)
}

/**
 * Providers the running sign-in service has on: GoTrue's public GET /auth/v1/settings,
 * `external`. null when it cannot be read.
 */
export async function fetchSignInServiceProviders(): Promise<Partial<Record<BuiltInOAuthProvider, boolean>> | null> {
  const base = (runtimeConfig.supabaseUrl || '').replace(/\/+$/, '')
  const key = runtimeConfig.supabaseAnonKey
  if (!base || !key) return null
  try {
    const res = await fetch(`${base}/auth/v1/settings`, { headers: { apikey: key }, cache: 'no-store' })
    if (!res.ok) return null
    const external = ((await res.json()) as { external?: Record<string, unknown> }).external ?? {}
    const out: Partial<Record<BuiltInOAuthProvider, boolean>> = {}
    for (const provider of BUILT_IN_OAUTH_PROVIDERS) out[provider] = external[provider] === true
    return out
  } catch {
    return null
  }
}

/** instance_config.oauth_providers as AuthComponent reads it: an array, an object or a string of either. */
export function parseButtonList(raw: unknown): BuiltInOAuthProvider[] {
  let value = raw
  if (typeof value === 'string') {
    const text = value.trim()
    if (text.startsWith('[') || text.startsWith('{')) {
      try {
        value = JSON.parse(text)
      } catch {
        return []
      }
    } else {
      value = text.split(',').map((p) => p.trim())
    }
  }
  let ids: string[] = []
  if (Array.isArray(value)) ids = value.filter((p): p is string => typeof p === 'string')
  else if (value && typeof value === 'object') {
    ids = Object.entries(value as Record<string, unknown>)
      .filter(([, on]) => on === true || on === 'true')
      .map(([id]) => id)
  }
  const lower = new Set(ids.map((p) => p.toLowerCase()))
  return BUILT_IN_OAUTH_PROVIDERS.filter((p) => lower.has(p))
}
