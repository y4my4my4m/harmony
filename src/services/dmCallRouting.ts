/**
 * Which call a DM conversation places.
 *
 *   local      room dm-{conversationId} on this instance. Every group call, and
 *              a direct call to a local peer.
 *   federated  room federated-dm-{conversationId}-{millis}, invited over
 *              /api/livekit/federated-call. A direct call to a remote peer;
 *              the protocol carries exactly one callee.
 *   unknown    a direct conversation whose peer profile has not loaded
 *              (placeholder without is_local); resolve it from profiles.
 */

import type { DMConversation } from '@/stores/useDM'

export type DMCallRoute = 'local' | 'federated' | 'unknown'

type CallConversation = Pick<DMConversation, 'type' | 'other_user' | 'participants'>

export function dmCallRoute(conversation: CallConversation): DMCallRoute {
  if (conversation.type === 'group') return 'local'
  const peer = conversation.other_user
  if (!peer?.id) return 'local'
  if (typeof peer.is_local !== 'boolean') return 'unknown'
  return peer.is_local ? 'local' : 'federated'
}

/**
 * Profiles a local call rings. Group members on other instances are left out:
 * the ring topic and the dm-{conversationId} room exist on this instance only.
 */
export function localCallReceivers(conversation: CallConversation, selfId: string | null | undefined): string[] {
  if (!selfId) return []
  if (conversation.type === 'group') {
    return (conversation.participants || [])
      .filter((p) => p.is_local !== false)
      .map((p) => p.id || (p as { user_id?: string }).user_id)
      .filter((id): id is string => !!id && id !== selfId)
  }
  const peerId = conversation.other_user?.id
  return peerId && peerId !== selfId ? [peerId] : []
}
