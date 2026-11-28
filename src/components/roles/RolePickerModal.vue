<template>
  <UnifiedModal
    :model-value="!!serverId"
    :title="t('rolePicker.title')"
    :subtitle="serverName"
    size="md"
    container-class="role-picker-modal"
    @update:model-value="(open: boolean) => { if (!open) store.closeModal() }"
  >
    <div class="rp-body" data-testid="role-picker">
      <p class="rp-intro">{{ t('rolePicker.intro') }}</p>
      <p v-if="!isLocal" class="rp-empty">{{ t('rolePicker.errors.notLocal') }}</p>
      <p v-else-if="!hasPickable" class="rp-empty" data-testid="role-picker-empty">{{ t('rolePicker.empty') }}</p>
      <section v-for="group in groups" :key="group.name ?? ''" class="rp-group">
        <h3 class="rp-group-title">{{ group.name ?? t('rolePicker.otherRoles') }}</h3>
        <RoleChipGroup
          :roles="group.roles"
          :held="held"
          :pending="pending"
          :label="group.name ?? t('rolePicker.otherRoles')"
          :disabled="!loaded"
          @toggle="toggle"
        />
      </section>
    </div>
  </UnifiedModal>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import UnifiedModal from '@/components/shared/UnifiedModal.vue'
import RoleChipGroup from '@/components/roles/RoleChipGroup.vue'
import { useRolePickerStore } from '@/stores/useRolePicker'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useSelfAssignableRoles } from '@/composables/useSelfAssignableRoles'

const { t } = useI18n()
const store = useRolePickerStore()
const serverChannelStore = useServerChannelStore()

const serverId = computed(() => store.modalServerId)
const serverName = computed(() => serverChannelStore.servers.find((s) => s.id === serverId.value)?.name ?? '')
const { groups, hasPickable, held, pending, loaded, isLocal, toggle } = useSelfAssignableRoles(serverId)
</script>

<style scoped>
.rp-body {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.rp-intro,
.rp-empty {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--font-size-sm, 14px);
}

.rp-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.rp-group + .rp-group {
  border-top: 1px solid var(--border-primary);
  padding-top: 16px;
}

.rp-group-title {
  margin: 0;
  font-size: var(--font-size-xs, 12px);
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
</style>
