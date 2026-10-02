import { onScopeDispose, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { SERVER_BOT_CHANGE_EVENT, fetchServerBots, type ServerBot } from '@/services/serverBotsService'
import { debug } from '@/utils/debug'

/** Collapses a burst of installation or presence broadcasts into one fetch. */
export const SERVER_BOTS_REFETCH_MS = 250

/**
 * Bots installed in a server. Fetched on server change, and again on a server-structure bot
 * broadcast for that server or a `bot:updated` event for a listed bot. The list is replaced
 * whole; rows are plain objects.
 */
export function useServerBots(serverId: MaybeRefOrGetter<string | null | undefined>) {
  const bots = shallowRef<ServerBot[]>([])
  let request = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const load = async (id: string) => {
    const seq = ++request
    try {
      const rows = await fetchServerBots(id)
      if (seq === request) bots.value = rows
    } catch (error) {
      if (seq === request) debug.warn('get_server_bots failed:', error)
    }
  }

  const scheduleRefetch = () => {
    const id = toValue(serverId)
    if (!id) return
    clearTimer()
    timer = setTimeout(() => {
      timer = null
      void load(id)
    }, SERVER_BOTS_REFETCH_MS)
  }

  watch(
    () => toValue(serverId),
    (id) => {
      clearTimer()
      request++
      bots.value = []
      if (id) void load(id)
    },
    { immediate: true },
  )

  const onBotChange = (event: Event) => {
    const serverOf = (event as CustomEvent<{ server_id?: string } | null>).detail?.server_id
    if (serverOf && serverOf === toValue(serverId)) scheduleRefetch()
  }

  const onBotUpdated = (event: Event) => {
    const botId = (event as CustomEvent<{ id?: string } | null>).detail?.id
    if (botId && bots.value.some(bot => bot.id === botId)) scheduleRefetch()
  }

  window.addEventListener(SERVER_BOT_CHANGE_EVENT, onBotChange)
  window.addEventListener('bot:updated', onBotUpdated)

  onScopeDispose(() => {
    clearTimer()
    request++
    window.removeEventListener(SERVER_BOT_CHANGE_EVENT, onBotChange)
    window.removeEventListener('bot:updated', onBotUpdated)
  })

  return { bots }
}
