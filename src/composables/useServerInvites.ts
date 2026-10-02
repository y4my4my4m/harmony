import { computed, ref, type Ref } from 'vue'
import { debug } from '@/utils/debug'
import { useAuthStore } from '@/stores/auth'
import { generateInviteUrl, getInviteHistory, revokeInvite, type Invite } from '@/services/inviteService'
import { getInviteConstraints } from '@/services/permissionsService'
import {
  allowedExpiryChoices,
  allowedMaxUseChoices,
  buildInviteUrl,
  inviteCodeFromUrl,
  isInviteActive,
  pickChoice,
} from '@/utils/inviteLink'

/**
 * Invite state for one server: the link on show, the caller's other active
 * links, and the server's limits on new ones. Invites are keyed by the auth
 * user id, as inviteService writes them.
 */
export function useServerInvites(serverId: Ref<string | undefined>) {
  const authStore = useAuthStore()

  const invites = ref<Invite[]>([])
  const currentCode = ref<string | null>(null)
  const canCreate = ref(true)
  const maxExpiration = ref(0)
  const maxUsesLimit = ref(0)
  const loading = ref(false)
  const creating = ref(false)

  const expiryChoices = computed(() => allowedExpiryChoices(maxExpiration.value))
  const maxUseChoices = computed(() => allowedMaxUseChoices(maxUsesLimit.value))
  const expiresIn = ref(0)
  const maxUses = ref(0)

  const activeInvites = computed(() => invites.value.filter((i) => isInviteActive(i)))
  const current = computed(() => activeInvites.value.find((i) => i.code === currentCode.value) ?? null)
  const currentUrl = computed(() =>
    current.value ? buildInviteUrl(current.value.code, import.meta.env.VITE_APP_URL || window.location.origin) : '',
  )
  const otherInvites = computed(() => activeInvites.value.filter((i) => i.code !== currentCode.value))

  const userId = () => authStore.session?.user?.id

  async function loadInvites() {
    const uid = userId()
    if (!uid || !serverId.value) return
    invites.value = await getInviteHistory(uid, serverId.value)
  }

  async function loadConstraints() {
    const uid = userId()
    if (!uid || !serverId.value) return
    const c = await getInviteConstraints(uid, serverId.value)
    canCreate.value = c.canCreate
    maxExpiration.value = c.maxExpiration
    maxUsesLimit.value = c.maxUses
    // Never expires by default, unless the server caps invite lifetime.
    expiresIn.value = pickChoice(expiryChoices.value, c.maxExpiration > 0 ? c.defaultExpiration : 0)
    maxUses.value = pickChoice(maxUseChoices.value, 0)
  }

  /** Creates a link with the chosen settings and shows it. False on failure. */
  async function create(): Promise<boolean> {
    const uid = userId()
    if (!uid || !serverId.value) return false
    creating.value = true
    try {
      const result = await generateInviteUrl(serverId.value, uid, {
        expiresIn: expiresIn.value,
        maxUses: maxUses.value,
      })
      if (!result.success || !result.url) {
        debug.warn('Invite not created:', result.error)
        return false
      }
      await loadInvites()
      currentCode.value = inviteCodeFromUrl(result.url)
      return true
    } catch (err) {
      debug.error('Failed to create invite:', err)
      return false
    } finally {
      creating.value = false
    }
  }

  /** Revokes a link; the next active link, if any, takes the current slot. */
  async function revoke(invite: Invite): Promise<boolean> {
    const uid = userId()
    if (!uid) return false
    const ok = await revokeInvite(invite.id, uid)
    if (!ok) return false
    await loadInvites()
    if (invite.code === currentCode.value) currentCode.value = activeInvites.value[0]?.code ?? null
    return true
  }

  function show(invite: Invite) {
    currentCode.value = invite.code
  }

  /**
   * Shows the newest active link, creating one when none exists and the
   * caller may create invites.
   */
  async function open() {
    loading.value = true
    currentCode.value = null
    try {
      await Promise.all([loadConstraints(), loadInvites()])
      currentCode.value = activeInvites.value[0]?.code ?? null
      if (!currentCode.value && canCreate.value) await create()
    } catch (err) {
      debug.error('Failed to load invites:', err)
    } finally {
      loading.value = false
    }
  }

  return {
    activeInvites,
    canCreate,
    create,
    creating,
    current,
    currentUrl,
    expiresIn,
    expiryChoices,
    loading,
    maxUseChoices,
    maxUses,
    open,
    otherInvites,
    revoke,
    show,
  }
}
