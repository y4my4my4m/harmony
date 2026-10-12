import { computed, ref, watch, type Ref } from 'vue'
import { trendingService } from '@/services/TrendingService'

/**
 * NodeInfo software.name of chat servers on which a follow is a friend request. Shoot marks
 * every actor manuallyApprovesFollowers and accepts a follow as a friendship.
 */
const FRIEND_REQUEST_SOFTWARE = new Set(['shoot'])

export type FollowAction = 'follow' | 'request' | 'friendRequest'

interface FollowTarget {
  is_local?: boolean | null
  domain?: string | null
  federated_id?: string | null
  manually_approves_followers?: boolean | null
}

/** Host serving the account's actor document; the handle's domain when the actor URL is absent. */
function actorHost(target: FollowTarget): string | null {
  if (target.federated_id) {
    try {
      return new URL(target.federated_id).host.toLowerCase()
    } catch {
      // Falls back to the handle's domain.
    }
  }
  return target.domain?.toLowerCase() || null
}

/**
 * What following the account does, for the follow button: follow outright, send a request
 * the account approves (manuallyApprovesFollowers), or send a friend request (a chat server).
 * `locked` overrides the target's own flag when the caller reads it elsewhere.
 */
export function useFollowAction(
  source: () => FollowTarget | null | undefined,
  locked?: () => boolean,
): { action: Ref<FollowAction> } {
  const software = ref<string | null>(null)
  const isLocked = () => {
    const target = source()
    return !!target && (locked ? locked() : target.manually_approves_followers === true)
  }

  watch(
    () => {
      const target = source()
      return target && target.is_local === false && isLocked() ? actorHost(target) : null
    },
    async (host) => {
      software.value = null
      if (!host) return
      const row = await trendingService.getFederatedInstanceByDomain(host)
      const current = source()
      if (current && actorHost(current) === host) software.value = typeof row?.software === 'string' ? row.software : null
    },
    { immediate: true },
  )

  const action = computed<FollowAction>(() => {
    if (!isLocked()) return 'follow'
    return software.value && FRIEND_REQUEST_SOFTWARE.has(software.value.trim().toLowerCase()) ? 'friendRequest' : 'request'
  })
  return { action }
}

/** i18n keys of the button's visible text and its accessible name, which names the handle. */
export const FOLLOW_ACTION_KEYS: Record<FollowAction, { text: string; label: string }> = {
  follow: { text: 'activitypub.follow', label: 'activitypub.followUser' },
  request: { text: 'activitypub.requestToFollow', label: 'activitypub.requestToFollowUser' },
  friendRequest: { text: 'activitypub.sendFriendRequest', label: 'activitypub.sendFriendRequestUser' },
}
