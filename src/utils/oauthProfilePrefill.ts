import { isOAuthIdentityProvider } from '@/utils/customOAuthProviders'
import { normalizeUsernameInput } from '@/utils/usernameRules'

export interface ProfilePrefill {
  /** null: the identity carries no picture, or no OAuth identity is linked. */
  avatar: string | null
  displayName: string
  bio: string
  /** Normalized; may be shorter than the minimum length. */
  username: string
}

/**
 * The new-profile form's starting values from GoTrue's user_metadata. Display name, picture and
 * bio come only from an OAuth identity; the username also falls back to the address.
 *
 * GoTrue's Discord provider: full_name is the Discord username, name is "username#0",
 * custom_claims.global_name the display name.
 */
export function oauthProfilePrefill(
  metadata: Record<string, any>,
  identities: Array<{ provider: string }>,
  email?: string,
): ProfilePrefill {
  const oauth = identities.some((i) => isOAuthIdentityProvider(i.provider))
  const discord = identities.some((i) => i.provider === 'discord')
  const globalName = discord && typeof metadata.custom_claims?.global_name === 'string'
    ? metadata.custom_claims.global_name.trim()
    : ''
  const about = metadata.bio || metadata.description
  return {
    avatar: oauth ? metadata.avatar_url || metadata.picture || null : null,
    displayName: oauth ? globalName || metadata.full_name || metadata.name || metadata.preferred_username || '' : '',
    bio: oauth && about ? String(about).substring(0, 500) : '',
    username: normalizeUsernameInput(
      metadata.preferred_username || metadata.user_name || metadata.username || metadata.login ||
      (discord ? metadata.full_name : '') ||
      (email ? email.split('@')[0] : ''),
    ),
  }
}
