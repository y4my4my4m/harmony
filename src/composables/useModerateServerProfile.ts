/** Moderator actions on another member's server profile: nickname change and full reset. */
import { useToast } from 'vue-toastification'
import { useI18n } from 'vue-i18n'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { moderateServerProfile } from '@/services/serverProfileService'
import { debug } from '@/utils/debug'
import { userDataService } from '@/services/userDataService'

export interface ModeratedMember {
  id: string
  username: string
  display_name?: string | null
}

/**
 * The toast text for a failed moderation call: translated only, never the RPC's own message.
 * 42501 (missing permission, or a member of equal or higher rank) gets its own text; anything
 * else the generic one. The raw error goes to the debug log.
 */
export function moderationErrorMessage(
  error: unknown,
  t: (key: string, params?: Record<string, unknown>) => string,
  name: string,
): string {
  debug.error('moderate_server_profile failed:', error)
  const code = (error as { code?: string } | null)?.code
  return code === '42501'
    ? t('moderation.serverProfile.noPermission', { name })
    : t('moderation.serverProfile.failed', { name })
}

/** Call in setup; the returned actions run later, from event handlers. */
export function useModerateServerProfile() {
  const { t } = useI18n()
  const toast = useToast()
  const { confirm } = useConfirmDialog()
  let resetPending = false

  /** Confirms, resets the member's server profile (keeps the nickname) and mirrors it in the cache. Resolves true once reset. */
  async function resetServerProfileWithConfirm(serverId: string, user: ModeratedMember): Promise<boolean> {
    if (resetPending) return false
    resetPending = true
    try {
      return await runReset(serverId, user)
    } finally {
      resetPending = false
    }
  }

  async function runReset(serverId: string, user: ModeratedMember): Promise<boolean> {
    const name = user.display_name || user.username

    const ok = await confirm({
      title: t('moderation.serverProfile.resetTitle'),
      message: t('moderation.serverProfile.resetMessage', { name }),
      confirmButtonText: t('moderation.serverProfile.resetConfirm'),
      dangerAction: true,
    })
    if (!ok) return false

    try {
      await moderateServerProfile(serverId, user.id, { resetProfile: true })
      userDataService.setMemberServerProfile(serverId, user.id, { avatar_url: null, banner_url: null, bio: null, pronouns: null })
      toast.success(t('moderation.serverProfile.resetDone', { name }))
      return true
    } catch (error) {
      toast.error(moderationErrorMessage(error, t, name))
      return false
    }
  }

  return { resetServerProfileWithConfirm }
}
