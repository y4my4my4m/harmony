// Instance values for the web build. The web image writes /config.json at
// container start, so one bundle serves any instance; a build with VITE_*
// inlined runs without the file. A non-empty /config.json key overrides the
// build variable named beside it in RuntimeConfig.
//
// The top-level await below holds back every module that imports this one
// until /config.json has resolved, so module-scope reads see the final values.

import { debug } from '@/utils/debug'

export interface RuntimeConfig {
  /** VITE_SUPABASE_URL */
  supabaseUrl?: string
  /** VITE_SUPABASE_ANON_KEY */
  supabaseAnonKey?: string
  /** VITE_DOMAIN: host part of local handles and ActivityPub ids. */
  domain?: string
  /** VITE_INSTANCE_DOMAIN: instance settings default before instance_config loads. */
  instanceDomain?: string
  /** VITE_INSTANCE_NAME */
  instanceName?: string
  /** VITE_APP_URL: public origin of the web app. */
  appUrl?: string
  /** VITE_FEDERATION_URL: public origin of the federation backend. */
  federationUrl?: string
  /** VITE_STORAGE_DOMAIN: comma-separated hosts serving local storage. */
  storageDomain?: string
  /** VITE_HARMONY_ALT_DOMAINS: comma-separated alternate instance hosts. */
  altDomains?: string
  /** VITE_TERMS_URL */
  termsUrl?: string
  /** VITE_PRIVACY_URL */
  privacyUrl?: string
  /** VITE_ENABLED_OAUTH_PROVIDERS: comma-separated provider ids. */
  oauthProviders?: string
}

export const RUNTIME_CONFIG_KEYS = [
  'supabaseUrl',
  'supabaseAnonKey',
  'domain',
  'instanceDomain',
  'instanceName',
  'appUrl',
  'federationUrl',
  'storageDomain',
  'altDomains',
  'termsUrl',
  'privacyUrl',
  'oauthProviders',
] as const satisfies readonly (keyof RuntimeConfig)[]

export const RUNTIME_CONFIG_PATH = '/config.json'

const FETCH_TIMEOUT_MS = 10_000

let runtime: RuntimeConfig = {}

/**
 * Known keys with non-empty string values, trimmed. Null when the document is
 * not a JSON object.
 */
export function parseRuntimeConfig(raw: unknown): RuntimeConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  const out: RuntimeConfig = {}
  for (const key of RUNTIME_CONFIG_KEYS) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) out[key] = value.trim()
  }
  return out
}

/**
 * Fetches /config.json, bypassing every cache. Resolves to {} when the file is
 * absent (404, or a SPA fallback answering with index.html), malformed or
 * unreachable; the build values then apply unchanged.
 */
export async function fetchRuntimeConfig(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<RuntimeConfig> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${RUNTIME_CONFIG_PATH}?t=${Date.now()}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return {}
    if (!(response.headers.get('content-type') || '').includes('json')) return {}
    const text = await response.text()
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      debug.error('[runtimeConfig] /config.json is not valid JSON; using build-time values')
      return {}
    }
    const parsed = parseRuntimeConfig(raw)
    if (!parsed) {
      debug.error('[runtimeConfig] /config.json is not a JSON object; using build-time values')
      return {}
    }
    return parsed
  } catch (error) {
    debug.error('[runtimeConfig] /config.json unavailable; using build-time values:', error)
    return {}
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Web pages only. Native clients pick their instance at runtime
 * (instanceConfig.ts) and unit tests run on the build env.
 */
export function shouldFetchRuntimeConfig(
  mode: string = import.meta.env.MODE,
  scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>
): boolean {
  if (mode === 'test') return false
  if (typeof scope.window === 'undefined') return false
  // Same test as instanceConfig.isTauriRuntime; importing it closes an import cycle.
  return typeof scope.__TAURI_INTERNALS__ === 'undefined' && typeof scope.__TAURI__ === 'undefined'
}

/** Replaces the loaded values. {} restores the build values. */
export function setRuntimeConfig(config: RuntimeConfig): void {
  runtime = { ...config }
}

/**
 * Instance values: /config.json first, then the VITE_* inlined at build time.
 * Every read resolves at access time.
 */
export const runtimeConfig = {
  get supabaseUrl(): string | undefined {
    return runtime.supabaseUrl || import.meta.env.VITE_SUPABASE_URL
  },
  get supabaseAnonKey(): string | undefined {
    return runtime.supabaseAnonKey || import.meta.env.VITE_SUPABASE_ANON_KEY
  },
  get domain(): string | undefined {
    return runtime.domain || import.meta.env.VITE_DOMAIN
  },
  get instanceDomain(): string | undefined {
    return runtime.instanceDomain || import.meta.env.VITE_INSTANCE_DOMAIN
  },
  get instanceName(): string | undefined {
    return runtime.instanceName || import.meta.env.VITE_INSTANCE_NAME
  },
  get appUrl(): string | undefined {
    return runtime.appUrl || import.meta.env.VITE_APP_URL
  },
  get federationUrl(): string | undefined {
    return runtime.federationUrl || import.meta.env.VITE_FEDERATION_URL
  },
  get storageDomain(): string | undefined {
    return runtime.storageDomain || import.meta.env.VITE_STORAGE_DOMAIN
  },
  get altDomains(): string | undefined {
    return runtime.altDomains || import.meta.env.VITE_HARMONY_ALT_DOMAINS
  },
  get termsUrl(): string | undefined {
    return runtime.termsUrl || import.meta.env.VITE_TERMS_URL
  },
  get privacyUrl(): string | undefined {
    return runtime.privacyUrl || import.meta.env.VITE_PRIVACY_URL
  },
  get oauthProviders(): string | undefined {
    return runtime.oauthProviders || import.meta.env.VITE_ENABLED_OAUTH_PROVIDERS
  },
}

if (shouldFetchRuntimeConfig()) {
  setRuntimeConfig(await fetchRuntimeConfig())
}
