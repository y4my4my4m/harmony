<!--
  PermissionRoleEditor - Discord-style role rail and Deny / Inherit / Allow editor for one
  set of permission overrides (a channel's, or a category's template). The parent holds the
  state; edits arrive as `set` and `reset`.

    <PermissionRoleEditor
      v-model:selected-role-id="roleId"
      :roles="roles" :groups="groups" :state="state" :dirty-role-ids="dirty"
      :loading="loading" :legend="t('...')"
      @set="(roleId, perm, value) => ..." @reset="roleId => ..."
    />
-->
<template>
  <div class="perm-layout" data-testid="permission-role-editor">
    <div class="perm-role-rail">
      <h3 :id="`${a11yId}-roles`" class="perm-rail-label">{{ t('server.roles') }}</h3>
      <ul class="perm-role-list" :aria-labelledby="`${a11yId}-roles`">
        <li v-for="role in roles" :key="role.id">
          <button
            type="button"
            class="perm-role-pill"
            :class="{ active: selectedRoleId === role.id, dirty: isDirty(role.id) }"
            :data-role-id="role.id"
            :aria-current="selectedRoleId === role.id ? 'true' : undefined"
            @click="selectedRoleId = role.id"
          >
            <span class="role-color-dot" :style="{ background: role.color || '#99aab5' }" aria-hidden="true"></span>
            <span class="role-pill-name">{{ role.name }}</span>
            <template v-if="isDirty(role.id)">
              <span class="role-pill-dot" :title="t('a11y.unsavedChanges')" aria-hidden="true"></span>
              <span class="sr-only">{{ t('a11y.unsavedChanges') }}</span>
            </template>
          </button>
        </li>
      </ul>
      <div v-if="!loading && roles.length === 0" class="perm-empty-mini">
        {{ t('channel.edit.noRoles') }}
      </div>
    </div>

    <section class="perm-editor">
      <div v-if="loading" class="perm-loading" role="status">{{ t('channel.edit.loadingRoles') }}</div>
      <template v-else-if="selectedRole">
        <header class="perm-editor-head">
          <div class="perm-editor-title">
            <span class="role-color-dot" :style="{ background: selectedRole.color || '#99aab5' }" aria-hidden="true"></span>
            <h3 ref="roleTitleEl" :id="`${a11yId}-role-title`" tabindex="-1">{{ selectedRole.name }}</h3>
          </div>
          <p class="perm-editor-sub">
            {{ legend }}
            <button
              v-if="isDirty(selectedRole.id)"
              type="button"
              class="perm-reset-link"
              :aria-label="t('channel.edit.resetRoleFor', { role: selectedRole.name })"
              @click="onReset(selectedRole)"
            >
              {{ t('channel.edit.resetRole') }}
            </button>
          </p>
        </header>

        <div v-for="group in groups" :key="group.id" class="perm-group">
          <h4 class="perm-group-label">{{ t(`channel.edit.groups.${group.id}`) }}</h4>
          <div v-for="perm in group.permissions" :key="perm.key" class="perm-row" :data-perm="perm.key">
            <div class="perm-row-text">
              <span :id="`${a11yId}-perm-${perm.key}`" class="perm-row-label">{{ t(`channel.edit.perms.${perm.key}.label`) }}</span>
              <span :id="`${a11yId}-perm-${perm.key}-desc`" class="perm-row-desc">{{ t(`channel.edit.perms.${perm.key}.description`) }}</span>
            </div>
            <ChannelPermissionTriState
              :model-value="state[selectedRole.id]?.[perm.key] ?? 'inherit'"
              :labelledby="`${a11yId}-perm-${perm.key}`"
              :describedby="`${a11yId}-perm-${perm.key}-desc`"
              @update:model-value="emit('set', selectedRole.id, perm.key, $event)"
            />
          </div>
        </div>
      </template>
      <div v-else class="perm-empty">{{ t('channel.edit.selectRole') }}</div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ChannelPermissionTriState, { type TriState } from '@/components/ChannelPermissionTriState.vue'
import { useAnnouncer } from '@/composables/useAnnouncer'
import { uid, focusProgrammatically } from '@/utils/a11y/focus'
import type { Permission, ServerRole } from '@/services/RoleService'
import type { PermissionGroup } from '@/services/channelPermissionGroups'

export type RolePermissionState = Record<string, Partial<Record<Permission, TriState>>>

const props = defineProps<{
  roles: ServerRole[]
  groups: PermissionGroup[]
  /** Per role, each permission's state; an absent key is Inherit. */
  state: RolePermissionState
  dirtyRoleIds: ReadonlySet<string>
  loading: boolean
  /** The line under the role's name. */
  legend: string
}>()

const emit = defineEmits<{
  set: [roleId: string, perm: Permission, value: TriState]
  reset: [roleId: string]
}>()

const selectedRoleId = defineModel<string | null>('selectedRoleId', { default: null })

const { t } = useI18n()
const { polite } = useAnnouncer()

const a11yId = uid('perm-editor')
const roleTitleEl = ref<HTMLElement | null>(null)

const selectedRole = computed(() => props.roles.find(r => r.id === selectedRoleId.value) ?? null)

const isDirty = (roleId: string) => props.dirtyRoleIds.has(roleId)

// The reset link unmounts once the role is clean; focus lands on the role's heading.
async function onReset(role: ServerRole) {
  emit('reset', role.id)
  polite(t('channel.edit.roleReset', { role: role.name }))
  await nextTick()
  focusProgrammatically(roleTitleEl.value)
}
</script>

<style scoped>
.perm-layout {
  display: grid;
  grid-template-columns: 200px 1fr;
  gap: 20px;
  min-height: 360px;
}

.perm-role-rail {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-right: 4px;
  border-right: 1px solid var(--border-color);
}

.perm-rail-label {
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  padding: 0 8px 8px;
}

.perm-role-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.perm-role-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  transition: background 0.12s, color 0.12s;
}

.perm-role-pill:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.perm-role-pill.active {
  background: var(--background-tertiary);
  color: var(--text-primary);
}

.perm-role-pill .role-pill-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.role-pill-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--harmony-primary);
  flex-shrink: 0;
}

.perm-empty-mini {
  padding: 8px 10px;
  font-size: 12px;
  color: var(--text-muted);
}

.perm-editor {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.perm-editor-head {
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 12px;
}

.perm-editor-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}

.perm-editor-title h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.perm-editor-sub {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.perm-reset-link {
  background: none;
  border: none;
  padding: 0;
  font-size: 12px;
  color: var(--text-link);
  cursor: pointer;
  text-decoration: underline;
}

.perm-group {
  display: flex;
  flex-direction: column;
}

.perm-group-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  margin: 8px 0 4px;
}

.perm-loading,
.perm-empty {
  padding: 24px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 13px;
}

.role-color-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex-shrink: 0;
}

.perm-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 4px;
  border-top: 1px solid var(--border-color);
}

.perm-group .perm-row:first-of-type {
  border-top: none;
}

.perm-row-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.perm-row-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.perm-row-desc {
  font-size: 11px;
  color: var(--text-secondary);
}

/* Rail above the editor on narrow screens; the 200px column leaves the editor no room. */
@media (max-width: 600px) {
  .perm-layout {
    grid-template-columns: 1fr;
    min-height: 0;
  }

  .perm-role-rail {
    padding-right: 0;
    padding-bottom: 12px;
    border-right: none;
    border-bottom: 1px solid var(--border-color);
  }
}
</style>
