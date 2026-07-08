// Shared join pipeline for invite entry points (accept page, in-chat invite card).
// Gates the join behind the rules modal when the server or instance has rules;
// instance rules are acknowledged once per device.

import { ref, computed, type Ref } from 'vue'
import { useRouter } from 'vue-router'
import { useToast } from 'vue-toastification'
import { acceptInvite, type InviteInfo } from '@/services/inviteService'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { debug } from '@/utils/debug'

const INSTANCE_RULES_ACK_KEY = 'harmony-instance-rules-ack'

export function useInviteJoin(
  info: Ref<InviteInfo | null>,
  options: { onJoined?: (serverId: string) => void } = {},
) {
  const router = useRouter()
  const toast = useToast()
  const serverStore = useServerChannelStore()
  const instanceSettings = useInstanceSettingsStore()

  if (!instanceSettings.isLoaded && !instanceSettings.isLoading) {
    void instanceSettings.fetchSettings()
  }

  const isJoining = ref(false)
  const showRules = ref(false)

  const instanceRulesPending = computed(
    () =>
      instanceSettings.settings.instanceRules.length > 0 &&
      localStorage.getItem(INSTANCE_RULES_ACK_KEY) !== 'true',
  )

  // instance rules shown only until acknowledged once on this device
  const pendingInstanceRules = computed(() =>
    instanceRulesPending.value ? instanceSettings.settings.instanceRules : [],
  )

  const serverRules = computed(() => info.value?.rules ?? [])

  const needsAgreement = computed(
    () => serverRules.value.length > 0 || instanceRulesPending.value,
  )

  const join = async (): Promise<void> => {
    const invite = info.value
    if (!invite || isJoining.value) return

    isJoining.value = true
    try {
      // Pattern A: acceptInvite writes user_servers.user_id → profiles(id)
      const { authContextService } = await import('@/services/AuthContextService')
      const profileId = await authContextService.getCurrentProfileId()

      const result = await acceptInvite(invite.code, profileId)
      if (!result.success || !result.serverId) {
        toast.error(result.error || 'Failed to join server')
        return
      }

      if (pendingInstanceRules.value.length > 0) {
        localStorage.setItem(INSTANCE_RULES_ACK_KEY, 'true')
      }

      toast.success(`Joined ${invite.serverName}!`)
      await serverStore.fetchServersForUser(profileId)
      options.onJoined?.(result.serverId)
    } catch (error) {
      debug.error('Error joining server via invite:', error)
      toast.error('Failed to join server')
    } finally {
      isJoining.value = false
    }
  }

  const requestJoin = (): void => {
    if (!info.value || isJoining.value) return
    if (needsAgreement.value) {
      showRules.value = true
    } else {
      void join()
    }
  }

  const confirmJoin = (): void => {
    showRules.value = false
    void join()
  }

  const openServer = async (serverId: string): Promise<void> => {
    serverStore.setCurrentServer(serverId)
    await serverStore.fetchCategoriesAndChannels(serverId)
    const defaultChannel = serverStore.getDefaultChannel()
    await router.push(defaultChannel ? `/chat/${serverId}/${defaultChannel}` : '/chat')
  }

  return {
    isJoining,
    showRules,
    serverRules,
    pendingInstanceRules,
    needsAgreement,
    requestJoin,
    confirmJoin,
    openServer,
  }
}
