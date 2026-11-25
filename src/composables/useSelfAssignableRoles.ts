import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { roleService, type SelfAssignError } from '@/services/RoleService'
import { notifyModerationRejection } from '@/services/AutoModService'
import { useServerRolesStore } from '@/stores/useServerRoles'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useProfileStore } from '@/stores/useProfile'
import { pickableRoleGroups } from '@/utils/selfAssignableRoles'

/**
 * The self-assignable roles of a server for the signed-in member: the groups they may pick from
 * (optionally one group), which they hold, and a toggle that applies at once and reverts when
 * set_my_self_assignable_role refuses. Follows role and assignment changes made elsewhere.
 */
export function useSelfAssignableRoles(serverId: Ref<string | null | undefined>, group?: Ref<string | null | undefined>) {
  const { t } = useI18n()
  const toast = useToast()
  const rolesStore = useServerRolesStore()
  const serverStore = useServerChannelStore()
  const profileStore = useProfileStore()

  const held = ref(new Set<string>())
  const pending = ref(new Set<string>())
  const loaded = ref(false)

  const server = computed(() => serverStore.servers.find((s) => s.id === serverId.value) ?? null)
  /** A copy's roles are written by its host; members pick them there. */
  const isLocal = computed(() => server.value?.is_local_server !== false)
  const isMember = computed(() => !!server.value)
  const roles = computed(() => (serverId.value ? rolesStore.rolesByServer.get(serverId.value) ?? [] : []))
  const groups = computed(() => pickableRoleGroups(roles.value, group?.value ?? null))
  const hasPickable = computed(() => groups.value.some((g) => g.roles.length > 0))

  async function loadHeld(): Promise<void> {
    const id = serverId.value
    const userId = profileStore.profileId
    if (!id || !userId) return
    const mine = await roleService.getUserRoles(userId, id)
    if (serverId.value !== id) return
    const next = new Set(mine.map((r) => r.id))
    // A toggle in flight keeps its optimistic state.
    for (const roleId of pending.value) {
      if (held.value.has(roleId)) next.add(roleId)
      else next.delete(roleId)
    }
    held.value = next
    loaded.value = true
  }

  async function load(): Promise<void> {
    const id = serverId.value
    if (!id) return
    await rolesStore.ensureServerLoaded(id)
    await loadHeld()
  }

  watch(serverId, () => {
    held.value = new Set()
    loaded.value = false
    void load()
  }, { immediate: true })

  const onChange = (event: Event) => {
    const detail = (event as CustomEvent).detail
    const changed = detail?.new?.server_id ?? detail?.old?.server_id
    if (changed && changed === serverId.value) void loadHeld()
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('server-structure:user-role-change', onChange)
    window.addEventListener('server-structure:role-change', onChange)
  }
  onBeforeUnmount(() => {
    window.removeEventListener('server-structure:user-role-change', onChange)
    window.removeEventListener('server-structure:role-change', onChange)
  })

  function errorText(code: SelfAssignError): string {
    switch (code) {
      case 'NOT_A_MEMBER': return t('rolePicker.errors.notMember')
      case 'SERVER_NOT_LOCAL': return t('rolePicker.errors.notLocal')
      case 'ROLE_NOT_FOUND':
      case 'NOT_SELF_ASSIGNABLE': return t('rolePicker.errors.unavailable')
      case 'ROLE_IS_ADMIN':
      case 'ROLE_GRANTS_PERMISSIONS':
      case 'ROLE_RANKS_TOO_HIGH':
      case 'ROLE_OVERRIDE_GRANTS': return t('rolePicker.errors.notPickable')
      default: return t('rolePicker.errors.failed')
    }
  }

  async function toggle(roleId: string): Promise<void> {
    const id = serverId.value
    const userId = profileStore.profileId
    if (!id || !userId || pending.value.has(roleId)) return
    const on = !held.value.has(roleId)
    const apply = (value: boolean) => {
      const next = new Set(held.value)
      if (value) next.add(roleId)
      else next.delete(roleId)
      held.value = next
    }
    apply(on)
    pending.value = new Set(pending.value).add(roleId)
    try {
      const result = await roleService.setMySelfAssignableRole(userId, id, roleId, on)
      if (!result.ok) {
        apply(!on)
        // An account over account_role_picks_per_minute gets the wait in the message.
        if (!notifyModerationRejection(result.cause)) toast.error(errorText(result.error))
      }
    } finally {
      const next = new Set(pending.value)
      next.delete(roleId)
      pending.value = next
    }
  }

  return { roles, groups, hasPickable, held, pending, loaded, isLocal, isMember, toggle, reload: load }
}
