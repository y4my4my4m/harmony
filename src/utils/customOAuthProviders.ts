// Sign-in providers an instance runs itself (custom OAuth 2.0 / OIDC providers of GoTrue).
//
// instance_config.custom_oauth_providers holds what the sign-in page shows of them:
//   [{ "id": "custom:<slug>", "name": "<display name>", "icon": "<https or data:image URL>" }]
// GoTrue holds each provider's endpoints, client id and client secret in
// auth.custom_oauth_providers.

export interface CustomOAuthProvider {
  /** GoTrue identifier, `custom:` prefix included; the `provider` of signInWithOAuth. */
  id: string
  name: string
  /** https or data:image URL, shown in an <img>; null shows the generic sign-in icon. */
  icon: string | null
}

/** Providers with built-in sign-in buttons. */
export const BUILT_IN_OAUTH_PROVIDERS = ['google', 'twitch', 'github'] as const

// GoTrue's custom_oauth_providers_identifier_format, ^[a-z0-9][a-z0-9:-]{0,48}[a-z0-9]$,
// with the custom: prefix it requires: 8 to 50 characters.
const IDENTIFIER = /^custom:[a-z0-9:-]{0,42}[a-z0-9]$/
// GoTrue's custom_oauth_providers_name_length.
const NAME_MAX = 100
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp|avif|svg\+xml);base64,[A-Za-z0-9+/]+=*$/
const DATA_IMAGE_MAX = 65536

export function isCustomOAuthProviderId(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value)
}

const BUILT_IN_LABELS: Record<string, string> = { google: 'Google', twitch: 'Twitch', github: 'GitHub' }

/**
 * Display name of a sign-in provider id: the built-in brand names, a custom provider's name from
 * CUSTOM, else the id after `custom:` or with its first letter capitalised.
 */
export function oauthProviderLabel(id: string, custom: CustomOAuthProvider[] = []): string {
  if (BUILT_IN_LABELS[id]) return BUILT_IN_LABELS[id]
  const own = custom.find((provider) => provider.id === id)
  if (own) return own.name
  if (id.startsWith('custom:')) return id.slice('custom:'.length)
  return id.charAt(0).toUpperCase() + id.slice(1)
}

/** An identity of a provider whose profile prefills the profile form (NewProfile.vue). */
export function isOAuthIdentityProvider(provider: string | null | undefined): boolean {
  if (!provider) return false
  return (BUILT_IN_OAUTH_PROVIDERS as readonly string[]).includes(provider) || isCustomOAuthProviderId(provider)
}

function iconUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const icon = value.trim()
  if (!icon) return null
  if (icon.startsWith('data:')) {
    return icon.length <= DATA_IMAGE_MAX && DATA_IMAGE.test(icon) ? icon : null
  }
  try {
    return new URL(icon).protocol === 'https:' ? icon : null
  } catch {
    return null
  }
}

/**
 * The providers of an instance_config.custom_oauth_providers value, in stored order. Accepts
 * the jsonb array or a JSON string of it; entries without a valid id or name are dropped, a
 * repeated id keeps its first entry, an icon that is not an https or base64 data:image URL
 * becomes null.
 */
export function parseCustomOAuthProviders(raw: unknown): CustomOAuthProvider[] {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return []
    }
  }
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  const providers: CustomOAuthProvider[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const { id, name, icon } = entry as Record<string, unknown>
    if (!isCustomOAuthProviderId(id) || seen.has(id)) continue
    if (typeof name !== 'string') continue
    const label = name.trim()
    if (!label || label.length > NAME_MAX) continue
    seen.add(id)
    providers.push({ id, name: label, icon: iconUrl(icon) })
  }
  return providers
}
