import { computed } from 'vue'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'
import { useProfileStore } from '@/stores/useProfile'
import type { VoiceActivity } from '@/services/activities/activityService'

/** Mirrors voice_activity_control: anyone controls unless the host locked it and is still in the call. */
export function useActivityControl(activity: () => VoiceActivity) {
  const voice = useUnifiedVoiceChannelStore()
  const profile = useProfileStore()
  const isHost = computed(() => activity().host_id === profile.profile?.id)
  const hostPresent = computed(() => voice.allParticipants.some((p: { userId?: string }) => p.userId === activity().host_id))
  const canControl = computed(() => activity().controls === 'everyone' || isHost.value || !hostPresent.value)
  return { isHost, canControl }
}
