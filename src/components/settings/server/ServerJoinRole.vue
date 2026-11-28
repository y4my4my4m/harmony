<template>
  <section class="join-role settings-card" :aria-labelledby="headingId" data-testid="join-role">
    <div class="setting-row">
      <div class="setting-info">
        <h3 :id="headingId">{{ t('joinRole.title') }}</h3>
        <p>{{ t('joinRole.description') }}</p>
      </div>
      <select
        :aria-labelledby="headingId"
        class="select-input"
        :value="current ?? ''"
        :disabled="busy || !loaded"
        data-testid="join-role-select"
        @change="onChange"
      >
        <option value="">{{ t('joinRole.none') }}</option>
        <option v-for="role in choices" :key="role.id" :value="role.id">{{ role.name }}</option>
      </select>
    </div>
    <p v-if="currentRefused" class="join-role-note" data-testid="join-role-refused">{{ t('joinRole.currentNotOpen') }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { roleService } from '@/services/RoleService'
import { getServerSettings } from '@/services/permissionsService'
import { useServerRolesStore } from '@/stores/useServerRoles'
import { selfAssignProblem } from '@/utils/selfAssignableRoles'

const props = defineProps<{ serverId: string }>()

const { t } = useI18n()
const toast = useToast()
const rolesStore = useServerRolesStore()

const current = ref<string | null>(null)
const loaded = ref(false)
const busy = ref(false)
const headingId = computed(() => `join-role-${props.serverId}`)

const roles = computed(() => rolesStore.rolesByServer.get(props.serverId) ?? [])

// set_server_join_role gives new members a role that open_role_refusal passes; channel overrides are
// checked by the server only. The role chosen now stays listed, so the select shows it.
const choices = computed(() => roles.value.filter((r) =>
  !r.is_default && !r.is_admin && (r.id === current.value || selfAssignProblem(r, roles.value) === null)))

const currentRefused = computed(() => {
  const role = roles.value.find((r) => r.id === current.value)
  return !!role && selfAssignProblem(role, roles.value) !== null
})

async function load(serverId: string) {
  loaded.value = false
  current.value = null
  const [settings] = await Promise.all([
    getServerSettings(serverId),
    rolesStore.ensureServerLoaded(serverId),
  ])
  if (serverId !== props.serverId) return
  current.value = settings?.default_role_id ?? null
  loaded.value = true
}

function joinRoleError(message: string): string {
  if (message.includes('ROLE_NOT_OPEN')) return t('joinRole.notOpen')
  if (message.includes('ROLE_RANKS_TOO_HIGH')) return t('joinRole.tooHigh')
  return t('joinRole.saveFailed')
}

async function onChange(event: Event) {
  const select = event.target as HTMLSelectElement
  const roleId = select.value || null
  const serverId = props.serverId
  busy.value = true
  try {
    const result = await roleService.setServerJoinRole(serverId, roleId)
    if (result.ok) {
      if (serverId === props.serverId) current.value = roleId
      toast.success(roleId ? t('joinRole.saved') : t('joinRole.cleared'))
    } else {
      toast.error(joinRoleError(result.error))
    }
  } finally {
    busy.value = false
    // A refused save leaves `current` unchanged, so the binding does not restore the DOM value.
    select.value = current.value ?? ''
  }
}

watch(() => props.serverId, (serverId) => { void load(serverId) }, { immediate: true })
</script>

<style scoped>
.join-role-note {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 10px 0 0;
}

.settings-card {
  background-color: var(--background-secondary);
  border-radius: 8px;
  border: 1px solid var(--background-quaternary);
  padding: 16px 20px;
  margin-bottom: 16px;
}

.settings-card h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.setting-info {
  min-width: 0;
}

.setting-info p {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 4px 0 0;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.select-input {
  padding: 8px 10px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 14px;
  min-width: 180px;
  max-width: 50%;
  box-sizing: border-box;
}

.select-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.select-input:disabled {
  opacity: 0.6;
}

@media (max-width: 768px) {
  .setting-row {
    flex-direction: column;
    align-items: stretch;
  }

  .select-input {
    max-width: none;
  }
}
</style>
