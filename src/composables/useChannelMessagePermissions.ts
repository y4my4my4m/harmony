import { computed, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { roleService, Permission } from '@/services/RoleService'
import { useProfileStore } from '@/stores/useProfile'

type Resolved = Partial<Record<Permission, boolean>>

/**
 * MANAGE_MESSAGES, PIN_MESSAGES and CREATE_PUBLIC_THREADS as get_user_permissions resolves them
 * in one server channel: role grants, then the channel's @everyone, role and member overrides.
 * The server owner and ADMINISTRATOR holders hold all in every channel. False until resolved,
 * and without a channel. Mirrors can_current_user_manage_messages_in_channel, pin_message,
 * set_message_embeds_suppressed and create_thread.
 */
export function useChannelMessagePermissions(
  serverId: MaybeRefOrGetter<string | null | undefined>,
  channelId: MaybeRefOrGetter<string | null | undefined>,
) {
  const profileStore = useProfileStore()
  const resolved = ref<Resolved | null>(null)
  let request = 0

  watch(
    () => [profileStore.profile?.id, toValue(serverId), toValue(channelId)] as const,
    async ([profileId, server, channel]) => {
      const current = ++request
      resolved.value = null
      if (!profileId || !server || !channel) return
      const permissions = await roleService.getUserPermissions(profileId, server, channel)
      if (current === request) resolved.value = permissions
    },
    { immediate: true },
  )

  const has = (permission: Permission): boolean =>
    resolved.value?.[Permission.ADMINISTRATOR] === true || resolved.value?.[permission] === true

  const canManageMessages = computed(() => has(Permission.MANAGE_MESSAGES))
  const canPinMessages = computed(() => has(Permission.PIN_MESSAGES) || has(Permission.MANAGE_MESSAGES))
  // Harmony threads are public; CREATE_PRIVATE_THREADS starts none.
  const canCreateThreads = computed(() => has(Permission.CREATE_PUBLIC_THREADS))
  // Null until resolved; set_message_embeds_suppressed keeps embeds hidden without it.
  const canEmbedLinks = computed((): boolean | null => (resolved.value ? has(Permission.EMBED_LINKS) : null))
  // handle_role_mention_notifications reads it in the message's channel.
  const canMentionEveryone = computed(() => has(Permission.MENTION_EVERYONE))

  return { canManageMessages, canPinMessages, canCreateThreads, canEmbedLinks, canMentionEveryone }
}
