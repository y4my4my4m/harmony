import { computed, ref, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { roleService, Permission } from '@/services/RoleService'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useEmojiCacheStore } from '@/stores/useEmojiCache'

type ProfileStore = ReturnType<typeof import('@/stores/useProfile').useProfileStore>

/** Any emoji shape a picker, autocomplete or reaction hands around. */
export interface EmojiLike {
  id?: string | null
  url?: string | null
  server_id?: string | null
  scope?: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Bundled unicode artwork (twemoji, packs); never a custom emoji. */
const isAssetUrl = (url: string): boolean => url.startsWith('/assets/') || url.includes('/twemoji/')

/**
 * A custom emoji that is not `serverId`'s own: another server's, instance, personal, AI, remote
 * or Discord. Unicode is never external. Mirrors external_emoji_keys: an emoji counts as the
 * server's when its emojis row has scope 'server' and that server_id.
 */
export function isExternalEmoji(
  emoji: EmojiLike,
  serverId: string | null | undefined,
  lookup: (id: string) => EmojiLike | undefined = () => undefined,
): boolean {
  const url = emoji.url ?? ''
  if (!url || isAssetUrl(url)) return false
  const id = typeof emoji.id === 'string' ? emoji.id : ''
  const row = UUID.test(id) ? lookup(id) ?? emoji : emoji
  if ((row.scope ?? 'server') !== 'server') return true
  return !serverId || row.server_id !== serverId || !UUID.test(id)
}

/**
 * USE_EXTERNAL_EMOJIS in one server channel, as enforce_message_content_permissions and
 * enforce_reaction_external_emoji decide it. `restricted` holds while the viewer lacks it;
 * false until resolved and outside a server channel.
 */
export function useExternalEmojiPolicy(channelId: MaybeRefOrGetter<string | null | undefined>) {
  // Imported on first use in a server channel: useProfile pulls in the whole service layer,
  // which the post composer and the pickers outside a channel never need.
  const profileStore = shallowRef<ProfileStore | null>(null)
  const serverChannelStore = useServerChannelStore()
  const emojiCacheStore = useEmojiCacheStore()
  const allowed = ref<boolean | null>(null)
  let request = 0

  const serverId = computed((): string | null => {
    const channel = toValue(channelId)
    if (!channel) return null
    const row = serverChannelStore.channels.find((c) => c.id === channel)
    return (row?.server_id as string | undefined) ?? serverChannelStore.currentServerId ?? null
  })

  watch(
    () => [serverId.value, toValue(channelId)] as const,
    async ([server, channel]) => {
      if (!server || !channel || profileStore.value) return
      const { useProfileStore } = await import('@/stores/useProfile')
      profileStore.value = useProfileStore()
    },
    { immediate: true },
  )

  watch(
    () => [profileStore.value?.profile?.id, serverId.value, toValue(channelId)] as const,
    async ([profileId, server, channel]) => {
      const current = ++request
      allowed.value = null
      if (!profileId || !server || !channel) return
      const permissions = await roleService.getUserPermissions(profileId, server, channel)
      if (current === request) {
        allowed.value = permissions[Permission.ADMINISTRATOR] === true
          || permissions[Permission.USE_EXTERNAL_EMOJIS] === true
      }
    },
    { immediate: true },
  )

  const restricted = computed(() => !!serverId.value && allowed.value === false)

  const lookup = (id: string): EmojiLike | undefined =>
    emojiCacheStore.globalEmojiIndex.get(id)?.emoji as EmojiLike | undefined

  /** True for an emoji this channel refuses the viewer. */
  const refuses = (emoji: EmojiLike): boolean =>
    restricted.value && isExternalEmoji(emoji, serverId.value, lookup)

  return { restricted, serverId, refuses }
}
