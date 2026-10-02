import { computed, ref } from 'vue'
import { debug } from '@/utils/debug'
import { useAuthStore } from '@/stores/auth'
import { useServerStore } from '@/stores/server'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useOpenServer } from '@/composables/useOpenServer'
import {
  getOnboardingServers,
  type OnboardingServer,
  type OnboardingSuggestions,
} from '@/services/ServerWelcomeService'

const DISMISSED_KEY = 'harmony:onboarding-servers-dismissed'

function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function writeDismissed(ids: string[]): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids.slice(-50)))
  } catch {
    /* storage unavailable */
  }
}

/**
 * Servers suggested to someone who has none yet: the instance welcome server, or featured
 * servers when none is set (get_onboarding_servers). Joining goes through join_public_server
 * and lands in the server's default channel.
 *
 * With `respectDismissed`, dismissals persist in this device's localStorage and hide those servers.
 */
export function useOnboardingServers(options: { respectDismissed?: boolean } = {}) {
  const authStore = useAuthStore()
  const serverStore = useServerStore()
  const serverChannelStore = useServerChannelStore()
  const openServer = useOpenServer()

  const suggestions = ref<OnboardingSuggestions>({ source: 'none', servers: [] })
  const loaded = ref(false)
  const joiningId = ref<string | null>(null)
  const dismissed = ref<string[]>(options.respectDismissed ? readDismissed() : [])

  const servers = computed<OnboardingServer[]>(() =>
    suggestions.value.servers.filter((s) => !dismissed.value.includes(s.id)),
  )

  async function load(): Promise<OnboardingSuggestions> {
    try {
      suggestions.value = await getOnboardingServers()
    } catch (error) {
      debug.warn('Onboarding suggestions unavailable:', error)
      suggestions.value = { source: 'none', servers: [] }
    } finally {
      loaded.value = true
    }
    return suggestions.value
  }

  /** True once the caller is in the server; join_public_server failures toast themselves. */
  async function join(serverId: string): Promise<boolean> {
    if (joiningId.value) return false
    joiningId.value = serverId
    try {
      const joined = await serverStore.joinServer(serverId)
      if (!joined) return false
      const userId = authStore.session?.user?.id
      if (userId) await serverChannelStore.fetchServersForUser(userId, true)
      await openServer(serverId)
      return true
    } catch (error) {
      debug.error('Joining a suggested server failed:', error)
      return false
    } finally {
      joiningId.value = null
    }
  }

  function dismiss(): void {
    const ids = suggestions.value.servers.map((s) => s.id)
    dismissed.value = [...new Set([...dismissed.value, ...ids])]
    if (options.respectDismissed) writeDismissed(dismissed.value)
  }

  return { suggestions, servers, loaded, joiningId, load, join, dismiss }
}
