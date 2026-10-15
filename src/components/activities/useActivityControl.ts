import { computed } from 'vue'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'
import { useProfileStore } from '@/stores/useProfile'
import { useServerUsersStore } from '@/stores/useServerUsers'
import { useServerPermissions } from '@/composables/useServerPermissions'
import { Permission } from '@/services/RoleService'
import type { VoiceActivity } from '@/services/activities/activityService'

export function useActivityControl(activity: () => VoiceActivity | null | undefined) {
  const voice = useUnifiedVoiceChannelStore()
  const profile = useProfileStore()
  const perms = useServerPermissions()
  const serverUsers = useServerUsersStore()
  const isHost = computed(() => !!activity() && activity()!.host_id === profile.profile?.id)
  /** voice_channel_participants (the rows the database checks), or the transport's roster. */
  const hostPresent = computed(() => {
    const a = activity()
    if (!a?.host_id) return false
    return (serverUsers.usersInVoiceChannels[a.channel_id] ?? []).includes(a.host_id)
      || voice.allParticipants.some((p: { userId?: string }) => p.userId === a.host_id)
  })
  /** Mirrors voice_activity_control: anyone controls unless the host locked it and is still in the call. */
  const canControl = computed(() => {
    const a = activity()
    return !!a && (a.controls === 'everyone' || isHost.value || !hostPresent.value)
  })
  /** Mirrors voice_activity_may_end: host, instance admin or moderator, MOVE_MEMBERS, or anyone once the host left. */
  const canEnd = computed(() => {
    const a = activity()
    const me = profile.profile
    if (!a || !me) return false
    if (isHost.value || !hostPresent.value || me.is_admin || me.is_moderator) return true
    return !!a.server_id && perms.hasPermission(a.server_id, me.id, Permission.MOVE_MEMBERS)
  })
  return { isHost, canControl, canEnd }
}
