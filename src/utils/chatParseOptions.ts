/**
 * Context-aware parse options for chat message input.
 *
 * Server chat: '#name' resolves against the current server's text channels
 * (the store only ever holds channels of a server the user is a member of,
 * so the map is inherently access-scoped). DMs: '#' has no meaning at all.
 */

import { useServerChannelStore } from '@/stores/useServerChannel'
import { useProfileStore } from '@/stores/useProfile'
import { emoticonPreferences } from '@/composables/useVisualTheme'
import { roleService, Permission } from '@/services/RoleService'
import { hasTypedMassMention, type MassMentionOptions } from './massMentions'
import type { ContentParseOptions } from './unifiedContentProcessing'

export function buildChatParseOptions(isDM: boolean): ContentParseOptions {
  const convertEmoticons = emoticonPreferences().convertSent
  if (isDM) return { hashtags: 'none', convertEmoticons }

  const serverChannelStore = useServerChannelStore()
  const serverId = serverChannelStore.currentServerId
  if (!serverId) return { hashtags: 'none', convertEmoticons }

  const channelDataMap: Record<string, { id: string; serverId: string; name: string }> = {}
  for (const channel of serverChannelStore.channels) {
    if (channel.type === 0) {
      channelDataMap[channel.name.toLowerCase()] = {
        id: channel.id,
        serverId: channel.server_id || serverId,
        name: channel.name,
      }
    }
  }
  return { hashtags: 'channels', channelDataMap, convertEmoticons }
}

/**
 * ContentParseOptions.massMentions for `text` sent by the signed-in user in a server channel:
 * MENTION_EVERYONE there as get_user_permissions resolves it, which
 * handle_role_mention_notifications also reads, and the server's default role. Undefined when the
 * text types neither word or there is no channel; both then stay text.
 */
export async function resolveChatMassMentions(
  text: string,
  serverId: string | null | undefined,
  channelId: string | null | undefined,
): Promise<MassMentionOptions | undefined> {
  if (!serverId || !channelId || !hasTypedMassMention(text)) return undefined
  const profileId = useProfileStore().profile?.id
  if (!profileId) return undefined
  const [allowed, roles] = await Promise.all([
    roleService.hasPermission(profileId, serverId, Permission.MENTION_EVERYONE, channelId),
    roleService.getRolesForServer(serverId).catch(() => []),
  ])
  const role = roles.find((r) => r.is_default)
  return {
    allowed,
    everyoneRole: role ? { id: role.id, name: role.name, color: role.color ?? null } : null,
  }
}
