<template>
  <div class="category-privacy" data-testid="category-privacy">
    <div class="privacy-head">
      <div class="privacy-text">
        <span :id="`${uidBase}-label`" class="section-label">{{ t('category.private.label') }}</span>
        <span :id="`${uidBase}-hint`" class="privacy-hint">{{ t('category.private.hint') }}</span>
      </div>
      <ToggleSwitch
        :model-value="modelValue.isPrivate"
        :disabled="disabled"
        :labelledby="`${uidBase}-label`"
        :describedby="`${uidBase}-hint`"
        data-testid="category-private-toggle"
        @change="setPrivate"
      />
    </div>

    <div v-if="modelValue.isPrivate" class="privacy-who">
      <span :id="`${uidBase}-roles`" class="privacy-hint">{{ t('category.private.whoCanSee') }}</span>
      <div class="privacy-role-list" role="group" :aria-labelledby="`${uidBase}-roles`">
        <label v-for="role in assignableRoles" :key="role.id" class="privacy-option" :data-role-id="role.id">
          <input
            type="checkbox"
            :checked="modelValue.roleIds.includes(role.id)"
            @change="toggleRole(role.id, ($event.target as HTMLInputElement).checked)"
          />
          <span class="role-dot" :style="{ background: role.color || '#99aab5' }" aria-hidden="true"></span>
          <span>{{ role.name }}</span>
        </label>
        <span v-if="rolesLoaded && assignableRoles.length === 0" class="privacy-hint">{{ t('category.private.noRoles') }}</span>
      </div>

      <label :for="`${uidBase}-search`" class="privacy-hint">{{ t('category.private.members') }}</label>
      <ul v-if="selectedMembers.length > 0" class="privacy-chips" :aria-label="t('category.private.members')">
        <li v-for="member in selectedMembers" :key="member.id" class="privacy-chip">
          <DisplayName :user-id="member.id" :fallback="member.display_name || member.username" />
          <button
            type="button"
            class="privacy-chip-remove"
            :aria-label="t('category.private.removeMember', { name: member.display_name || member.username })"
            @click="toggleUser(member.id, false)"
          >
            <Icon name="x" :size="12" aria-hidden="true" />
          </button>
        </li>
      </ul>
      <input
        :id="`${uidBase}-search`"
        v-model="memberQuery"
        type="search"
        class="privacy-search"
        autocomplete="off"
        :placeholder="t('category.private.searchMembers')"
        data-testid="category-private-member-search"
      />
      <ul v-if="memberQuery.trim()" class="privacy-results" :aria-label="t('category.private.searchMembers')">
        <li v-for="member in memberMatches" :key="member.id">
          <label class="privacy-option" :data-user-id="member.id">
            <input
              type="checkbox"
              :checked="modelValue.userIds.includes(member.id)"
              @change="toggleUser(member.id, ($event.target as HTMLInputElement).checked)"
            />
            <DisplayName :user-id="member.id" :fallback="member.display_name || member.username" />
            <span class="privacy-handle">@{{ member.username }}</span>
          </label>
        </li>
        <li v-if="memberMatches.length === 0" class="privacy-hint">{{ t('category.private.noMembers') }}</li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import Icon from '@/components/common/Icon.vue'
import DisplayName from '@/components/DisplayName.vue'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { uid } from '@/utils/a11y/focus'
import { roleService, type ServerRole } from '@/services/RoleService'
import type { CategoryPrivacy } from '@/services/categoryPermissions'

interface Member {
  id: string
  username: string
  display_name: string | null
}

const props = defineProps<{
  serverId: string
  modelValue: CategoryPrivacy
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: CategoryPrivacy]
}>()

const { t } = useI18n()
const uidBase = uid('category-privacy')

const MAX_MATCHES = 8

const roles = ref<ServerRole[]>([])
const rolesLoaded = ref(false)
const members = ref<Member[]>([])
const memberQuery = ref('')

const assignableRoles = computed(() => roles.value.filter(r => !r.is_default))
const selectedMembers = computed(() =>
  props.modelValue.userIds.map(id => members.value.find(m => m.id === id) ?? { id, username: id, display_name: null }))
const memberMatches = computed(() => {
  const q = memberQuery.value.trim().toLowerCase()
  if (!q) return []
  return members.value
    .filter(m => m.username.toLowerCase().includes(q) || (m.display_name ?? '').toLowerCase().includes(q))
    .slice(0, MAX_MATCHES)
})

function update(patch: Partial<CategoryPrivacy>) {
  emit('update:modelValue', { ...props.modelValue, ...patch })
}

function setPrivate(value: boolean) {
  update({ isPrivate: value })
}

function toggleRole(roleId: string, on: boolean) {
  const rest = props.modelValue.roleIds.filter(id => id !== roleId)
  update({ roleIds: on ? [...rest, roleId] : rest })
}

function toggleUser(userId: string, on: boolean) {
  const rest = props.modelValue.userIds.filter(id => id !== userId)
  update({ userIds: on ? [...rest, userId] : rest })
}

async function load(serverId: string) {
  rolesLoaded.value = false
  const [roleRows, memberRows] = await Promise.all([
    roleService.getRolesForServer(serverId),
    supabase
      .from('user_servers')
      .select('user_id, profiles:user_id (id, username, display_name)')
      .eq('server_id', serverId)
      .eq('status', 'accepted')
      .limit(1000),
  ])
  roles.value = [...roleRows].sort((a, b) => b.position - a.position)
  rolesLoaded.value = true
  if (memberRows.error) {
    debug.warn('Category privacy member list failed:', memberRows.error.message)
    return
  }
  members.value = (memberRows.data ?? [])
    .map((row: any) => row.profiles)
    .filter((p: any) => p?.id && p?.username)
    .map((p: any) => ({ id: p.id, username: p.username, display_name: p.display_name ?? null }))
}

watch(() => props.serverId, (serverId) => {
  if (serverId) load(serverId).catch(error => debug.error('Category privacy load failed:', error))
}, { immediate: true })
</script>

<style scoped>
.category-privacy {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.privacy-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.privacy-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.section-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.privacy-hint {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  line-height: 1.4;
}

.privacy-who {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.privacy-role-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
}

.privacy-option {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-primary);
  cursor: pointer;
}

.role-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.privacy-search {
  width: 100%;
  background: var(--background-quinary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
  padding: 8px 10px;
  color: var(--text-primary);
  font-size: 14px;
}

.privacy-search:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}

.privacy-results,
.privacy-chips {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.privacy-chips {
  flex-direction: row;
  flex-wrap: wrap;
}

.privacy-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px 2px 10px;
  border-radius: var(--radius-full);
  background: var(--background-quinary);
  color: var(--text-primary);
  font-size: 13px;
}

.privacy-chip-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.privacy-chip-remove:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.privacy-handle {
  color: var(--text-muted);
  font-size: 12px;
}
</style>
