<template>
  <section class="role-menu-card" :aria-labelledby="titleId" data-testid="role-menu-card">
    <header class="rm-header">
      <span class="rm-icon" aria-hidden="true"><Icon name="users" :size="18" /></span>
      <div class="rm-heading">
        <h4 :id="titleId" class="rm-title">{{ menu.title || t('roleMenu.defaultTitle') }}</h4>
        <span v-if="menu.group" class="rm-subtitle">{{ menu.group }}</span>
      </div>
    </header>

    <p v-if="!inThisServer" class="rm-note">{{ t('roleMenu.otherServer') }}</p>
    <p v-else-if="!isLocal" class="rm-note">{{ t('rolePicker.errors.notLocal') }}</p>
    <p v-else-if="loaded && !hasPickable" class="rm-note" data-testid="role-menu-empty">{{ t('roleMenu.empty') }}</p>
    <template v-else>
      <div v-for="g in groups" :key="g.name ?? ''" class="rm-group">
        <span v-if="showGroupNames" class="rm-group-name">{{ g.name ?? t('rolePicker.otherRoles') }}</span>
        <RoleChipGroup
          :roles="g.roles"
          :held="held"
          :pending="pending"
          :label="g.name ?? menu.title ?? t('roleMenu.defaultTitle')"
          :disabled="!loaded"
          @toggle="toggle"
        />
      </div>
      <p class="rm-hint">{{ t('roleMenu.hint') }}</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import RoleChipGroup from '@/components/roles/RoleChipGroup.vue'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useSelfAssignableRoles } from '@/composables/useSelfAssignableRoles'
import type { RoleMenuContent } from '@/types/chat'

const props = defineProps<{ menu: RoleMenuContent }>()

const { t } = useI18n()
const titleId = `role-menu-${useId()}`
const serverChannelStore = useServerChannelStore()

// A card names its server; it works only in that server's channels.
const inThisServer = computed(() => props.menu.serverId === serverChannelStore.currentServerId)
const serverId = computed(() => (inThisServer.value ? props.menu.serverId : null))
const group = computed(() => props.menu.group)
const { groups, hasPickable, held, pending, loaded, isLocal, toggle } = useSelfAssignableRoles(serverId, group)
// A card offering every group names them, as the role picker does.
const showGroupNames = computed(() => !props.menu.group && groups.value.length > 1)
</script>

<style scoped>
.role-menu-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 560px;
  margin: 4px 0;
  padding: 14px 16px;
  border-radius: 12px;
  border: 1px solid var(--border-primary);
  background: var(--bg-secondary);
}

.rm-header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.rm-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--accent-primary, #0ea5e9) 15%, transparent);
  color: var(--accent-primary, #0ea5e9);
  flex: none;
}

.rm-heading {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.rm-title {
  margin: 0;
  font-size: var(--font-size-base, 15px);
  font-weight: 700;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.rm-subtitle {
  font-size: var(--font-size-xs, 12px);
  color: var(--text-secondary);
}

.rm-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rm-group-name {
  font-size: var(--font-size-xs, 12px);
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.rm-note,
.rm-hint {
  margin: 0;
  font-size: var(--font-size-xs, 12px);
  color: var(--text-secondary);
}
</style>
