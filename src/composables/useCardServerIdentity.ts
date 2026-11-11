/**
 * Name, avatar, banner, bio and pronouns a profile card shows for one user. Inside a server
 * (serverId set) the server profile wins field by field and the nickname becomes the name line,
 * with the account name beneath; outside, the account values show, with account pronouns.
 */
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { getMemberServerProfile } from '@/composables/useMemberProfile'
import { useUserData } from '@/composables/useUserData'
import type { MemberServerFields } from '@/services/userDataService'

interface CardUser {
  id?: string
  display_name?: string
  avatar_url?: string
  banner_url?: string
  bio?: string
  pronouns?: string
}

function present(value: string | null | undefined): string | null {
  const t = (value ?? '').trim()
  return t ? t : null
}

export function useCardServerIdentity(
  user: MaybeRefOrGetter<CardUser>,
  serverId: MaybeRefOrGetter<string | null | undefined>,
  /** Replaces the stored server profile (the settings tab previews unsaved edits). */
  override?: MaybeRefOrGetter<Partial<MemberServerFields> | null | undefined>,
) {
  const { getUserPronouns } = useUserData()

  const server = computed<Partial<MemberServerFields> | null>(() => {
    const id = toValue(serverId)
    const u = toValue(user)
    if (!id || !u.id) return null
    return toValue(override) ?? getMemberServerProfile(u.id, id).value
  })

  const nickname = computed(() => present(server.value?.nickname))
  const accountPronouns = computed(() => {
    const u = toValue(user)
    return u.id ? getUserPronouns(u.id).value : null
  })

  return {
    /** The stored (or overriding) server profile; null outside a server. */
    serverFields: server,
    inServer: computed(() => !!toValue(serverId) && !!toValue(user).id),
    nickname,
    avatarUrl: computed(() => present(server.value?.avatar_url) ?? toValue(user).avatar_url),
    bannerUrl: computed(() => present(server.value?.banner_url) ?? toValue(user).banner_url ?? null),
    bio: computed(() => present(server.value?.bio) ?? toValue(user).bio ?? null),
    pronouns: computed(() => present(server.value?.pronouns) ?? present(accountPronouns.value) ?? present(toValue(user).pronouns)),
  }
}
