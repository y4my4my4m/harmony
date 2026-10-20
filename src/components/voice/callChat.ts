/**
 * The call's text chat beside the call view, as Discord shows a voice
 * channel's chat: the voice channel's messages for a server call, the
 * conversation for a DM call.
 *
 * The chat stores hold one channel and one conversation at a time, loaded and
 * subscribed by the routed ChatView/DMView. The side chat therefore shows the
 * routed chat and routes the main window to the call's chat when the user opens it; the
 * routed view yields its message list while the side chat shows it, so one
 * list and one composer exist per chat.
 */

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { useRouter, type RouteLocationRaw } from 'vue-router'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useDMStore } from '@/stores/useDM'
import { useChatStore } from '@/stores/useChat'
import { useProfileStore } from '@/stores/useProfile'
import { useUnreadCounts } from '@/composables/useUnreadCounts'
import { dmCallSignaling } from '@/services/DMCallSignaling'
import { userStorage } from '@/utils/userScopedStorage'
import { callPopoutActive } from './callPopout'

export type CallChatTarget =
  | { kind: 'channel'; serverId: string; channelId: string }
  | { kind: 'dm'; conversationId: string }

/** CSS px. */
export const CALL_CHAT_WIDTH = { min: 280, initial: 360, max: 640 } as const

const OPEN_KEY = 'voice-call-chat-open'
const WIDTH_KEY = 'voice-call-chat-width'

const open = ref(false)
const width = ref<number>(CALL_CHAT_WIDTH.initial)
let loadedFor: string | null | undefined

function readStored(key: string): string | null {
  try {
    return userStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string): void {
  try {
    userStorage.setItem(key, value)
  } catch {
    // Storage full or blocked: the choice lasts for this session.
  }
}

export function clampCallChatWidth(px: number): number {
  if (!Number.isFinite(px)) return CALL_CHAT_WIDTH.initial
  return Math.round(Math.min(CALL_CHAT_WIDTH.max, Math.max(CALL_CHAT_WIDTH.min, px)))
}

/** Per user: the stored choices follow the signed-in account. */
function loadStored(): void {
  let user: string | null = null
  try {
    user = userStorage.getCurrentUser()
  } catch {
    user = null
  }
  if (loadedFor === user) return
  loadedFor = user
  open.value = readStored(OPEN_KEY) === '1'
  const stored = Number(readStored(WIDTH_KEY))
  width.value = stored ? clampCallChatWidth(stored) : CALL_CHAT_WIDTH.initial
}

export function setCallChatOpen(next: boolean): void {
  open.value = next
  writeStored(OPEN_KEY, next ? '1' : '0')
}

export function setCallChatWidth(px: number): void {
  width.value = clampCallChatWidth(px)
  writeStored(WIDTH_KEY, String(width.value))
}

/** Conversation of a DM call room: dm-{id}, or federated-dm-{id}-{ts} as signaling maps it. */
function dmCallConversation(channelId: string): string | null {
  if (channelId.startsWith('federated-dm-')) {
    return dmCallSignaling.conversationForRoom(channelId) ?? channelId.match(/^federated-dm-([a-f0-9-]{36})/i)?.[1] ?? null
  }
  if (channelId.startsWith('dm-')) return channelId.slice(3)
  return null
}

export function targetRoute(target: CallChatTarget): RouteLocationRaw {
  return target.kind === 'channel'
    ? { name: 'ChatChannel', params: { serverId: target.serverId, channelId: target.channelId } }
    : { name: 'DMConversation', params: { conversationId: target.conversationId } }
}

export interface CallChat {
  target: ComputedRef<CallChatTarget | null>
  /** The target's chat is one this user can read here. */
  available: ComputedRef<boolean>
  open: Ref<boolean>
  width: Ref<number>
  /** The side chat is on screen: open, available, and the call view shown. */
  shown: ComputedRef<boolean>
  /** The routed chat is the call's. */
  routed: ComputedRef<boolean>
  showTarget: () => void
  /** The routed view yields its message list for `context`. */
  hosts: (context: { channelId?: string | null; conversationId?: string | null }) => boolean
}

export function useCallChat(): CallChat {
  loadStored()
  const voice = useUnifiedVoiceChannelStore()
  const channels = useServerChannelStore()
  const dms = useDMStore()
  const router = useRouter()

  const target = computed<CallChatTarget | null>(() => {
    const channelId = voice.currentChannelId as string | null
    const serverId = voice.currentServerId as string | null
    if (!channelId || !serverId || !voice.isConnectedOrJoining) return null
    if (serverId === 'dm') {
      const conversationId = dmCallConversation(channelId)
      return conversationId ? { kind: 'dm', conversationId } : null
    }
    return { kind: 'channel', serverId, channelId }
  })

  const available = computed(() => {
    const t = target.value
    if (!t) return false
    if (t.kind === 'dm') return dms.conversations.some((c: { id: string }) => c.id === t.conversationId)
    if (channels.channels.some((c: { id: string }) => c.id === t.channelId)) return true
    const cached = (channels as unknown as { _structureCacheByServer?: Record<string, { channels?: Array<{ id: string }> }> })._structureCacheByServer
    return !!cached?.[t.serverId]?.channels?.some((c) => c.id === t.channelId)
  })

  const callViewShown = computed(() => !!voice.isOverlayVisible || callPopoutActive.value)
  const shown = computed(() => open.value && available.value && callViewShown.value)

  const routed = computed(() => {
    const t = target.value
    const route = router?.currentRoute.value
    if (!t || !route) return false
    if (t.kind === 'channel') return route.name === 'ChatChannel' && route.params.channelId === t.channelId
    return route.name === 'DMConversation' && route.params.conversationId === t.conversationId
  })

  const showTarget = () => {
    const t = target.value
    if (!t || routed.value || !router) return
    void router.push(targetRoute(t)).catch(() => {})
  }

  const hosts: CallChat['hosts'] = (context) => {
    const t = target.value
    if (!shown.value || !t) return false
    return t.kind === 'channel'
      ? !!context.channelId && context.channelId === t.channelId
      : !!context.conversationId && context.conversationId === t.conversationId
  }

  return { target, available, open, width, shown, routed, showTarget, hosts }
}

/**
 * New messages in the call's chat while the side chat is hidden: a message
 * from someone else reaching the routed list, or an unread count on the chat.
 */
export function useCallChatUnread(chat: CallChat): ComputedRef<boolean> {
  const chatStore = useChatStore()
  const dmStore = useDMStore()
  const profile = useProfileStore()
  const { getUnreadMessages } = useUnreadCounts()
  const fresh = ref(false)

  const newest = computed<{ id: string; user_id?: string } | null>(() => {
    const t = chat.target.value
    if (!t) return null
    const list = t.kind === 'channel'
      ? (chatStore.currentChannelId === t.channelId ? chatStore.messages : null)
      : (dmStore.currentConversationId === t.conversationId ? dmStore.currentDMMessages : null)
    return (list?.[list.length - 1] as { id: string; user_id?: string } | undefined) ?? null
  })

  watch(() => newest.value?.id, (id, previous) => {
    if (!id || !previous || id === previous || chat.shown.value) return
    if (id.startsWith('temp-') || newest.value?.user_id === profile.profileId) return
    fresh.value = true
  })

  watch(chat.shown, (shown) => {
    if (shown) fresh.value = false
  })

  watch(() => chat.target.value && JSON.stringify(chat.target.value), () => {
    fresh.value = false
  })

  const counted = computed(() => {
    const t = chat.target.value
    if (!t) return 0
    return t.kind === 'channel'
      ? getUnreadMessages({ serverId: t.serverId, channelId: t.channelId })
      : getUnreadMessages({ conversationId: t.conversationId })
  })

  return computed(() => chat.available.value && !chat.shown.value && (fresh.value || counted.value > 0))
}
