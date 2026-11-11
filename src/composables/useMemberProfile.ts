/**
 * Server-aware member profile resolver. Each getter takes (userId, serverId) per call, so one
 * screen can show the same user under two names (a server, a DM). serverId = null, or a user
 * with no server row, resolves to the account values.
 *
 * Reactive like useUserData's getters: computed refs over the shared service-event counter.
 */

import { computed, type ComputedRef } from 'vue'
import { userDataService, type MemberServerFields } from '@/services/userDataService'
import { useUserData, useUserDataVersion } from '@/composables/useUserData'

type ServerId = string | null

function serverFields(userId: string, serverId: ServerId): MemberServerFields | null {
  return serverId ? userDataService.getMemberServerFields(serverId, userId) : null
}

/** Trimmed non-empty value, else null. */
function present(value: string | null | undefined): string | null {
  const t = (value ?? '').trim()
  return t ? t : null
}

export function getMemberDisplayName(userId: string, serverId: ServerId): ComputedRef<string> {
  const account = useUserData().getUserDisplayName(userId)
  return computed(() => {
    useUserDataVersion()
    return present(serverFields(userId, serverId)?.nickname) ?? account.value
  })
}

export function getMemberAvatarUrl(userId: string, serverId: ServerId): ComputedRef<string> {
  const account = useUserData().getUserAvatarUrl(userId)
  return computed(() => {
    useUserDataVersion()
    return present(serverFields(userId, serverId)?.avatar_url) ?? account.value
  })
}

export function getMemberBannerUrl(userId: string, serverId: ServerId): ComputedRef<string | null> {
  const account = useUserData().getUserBannerUrl(userId)
  return computed(() => {
    useUserDataVersion()
    return present(serverFields(userId, serverId)?.banner_url) ?? (account.value || null)
  })
}

export function getMemberBio(userId: string, serverId: ServerId): ComputedRef<string | null> {
  const account = useUserData().getUserBio(userId)
  return computed(() => {
    useUserDataVersion()
    return present(serverFields(userId, serverId)?.bio) ?? account.value
  })
}

export function getMemberPronouns(userId: string, serverId: ServerId): ComputedRef<string | null> {
  const account = useUserData().getUserPronouns(userId)
  return computed(() => {
    useUserDataVersion()
    return present(serverFields(userId, serverId)?.pronouns) ?? account.value
  })
}

/** Raw server values (no account fallback), for the settings tab and the profile card. */
export function getMemberServerProfile(userId: string, serverId: ServerId): ComputedRef<MemberServerFields | null> {
  return computed(() => {
    useUserDataVersion()
    const f = serverFields(userId, serverId)
    return f ? { ...f } : null
  })
}
