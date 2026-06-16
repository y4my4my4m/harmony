import { computed, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue'
import { useUserData } from '@/composables/useUserData'
import { useServerRolesStore } from '@/stores/useServerRoles'
import supabase from '@/supabase'
import type { Message } from '@/types'
import {
  getBridgeSource,
  getHarmonyProfileUserId,
  isBridgedAuthorMessage,
} from '@/utils/messageAuthor'

const botCache = new Map<string, { username: string; display_name: string; avatar_url: string }>()
const botFetching = new Set<string>()

async function ensureBot(botId: string): Promise<void> {
  if (botCache.has(botId) || botFetching.has(botId)) return
  botFetching.add(botId)
  try {
    const { data } = await supabase
      .from('bots')
      .select('id, username, display_name, avatar_url')
      .eq('id', botId)
      .single()
    if (data) botCache.set(botId, data)
  } finally {
    botFetching.delete(botId)
  }
}

export function useMessageAuthorPresentation(
  message: Ref<Message | null | undefined>,
  options?: { serverId?: MaybeRefOrGetter<string | null | undefined> },
) {
  const { getUserDisplayName, getUserAvatarUrl, getUserColor } = useUserData()
  const serverRolesStore = useServerRolesStore()
  const botTick = ref(0)

  watch(
    () => message.value?.bot_id,
    (botId) => {
      if (botId && !isBridgedAuthorMessage(message.value)) {
        void ensureBot(botId).then(() => { botTick.value++ })
      }
    },
    { immediate: true },
  )

  const bridgeSource = computed(() => getBridgeSource(message.value))
  const isBridged = computed(() => isBridgedAuthorMessage(message.value))
  const profileUserId = computed(() => getHarmonyProfileUserId(message.value))

  const displayName = computed(() => {
    void botTick.value
    const msg = message.value
    if (!msg) return 'Deleted User'
    if (msg.metadata?.discord_user) {
      const bridged = msg.metadata.discord_user
      return bridged.display_name || bridged.username || 'Unknown'
    }
    if (msg.bot_id) {
      const bot = botCache.get(msg.bot_id)
      return bot?.display_name || bot?.username || 'Bot'
    }
    if (msg.user_id) return getUserDisplayName(msg.user_id).value || 'Unknown User'
    return 'Unknown User'
  })

  const avatarUrl = computed(() => {
    void botTick.value
    const msg = message.value
    if (!msg) return '/default_avatar.webp'
    if (msg.metadata?.discord_user) {
      return msg.metadata.discord_user.avatar_url || '/default_avatar.webp'
    }
    if (msg.bot_id) return botCache.get(msg.bot_id)?.avatar_url || '/default_avatar.webp'
    if (msg.user_id) return getUserAvatarUrl(msg.user_id).value
    return '/default_avatar.webp'
  })

  const usernameColor = computed(() => {
    const msg = message.value
    if (!msg) return '#dddddd'
    if (isBridgedAuthorMessage(msg)) return '#5865F2'
    if (msg.bot_id) return '#0EA5E9'
    if (msg.user_id) {
      const serverId = toValue(options?.serverId)
      const roleColor = serverId ? serverRolesStore.getUserRoleColor(serverId, msg.user_id) : null
      return roleColor || getUserColor(msg.user_id).value
    }
    return '#dddddd'
  })

  return {
    bridgeSource,
    isBridged,
    profileUserId,
    displayName,
    avatarUrl,
    usernameColor,
  }
}
