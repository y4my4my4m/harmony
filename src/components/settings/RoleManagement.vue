<template>
  <!-- =====================================================================
       Roles - two-pane layout matching ChannelEditModal:
         - Left rail: list of roles (drag-reorderable; Alt+Up/Down on a role
           moves it), with color dot, member count, and a "dirty" indicator
           when there are unsaved changes for that role.
         - Right pane: Move up/down for the selected role, and a tabbed editor
           (Display / Permissions / Members).
       No slide-over editor: at this width both panes fit, and the rail stays
       visible while switching roles.
       ===================================================================== -->
  <div class="role-management">
    <!-- Header (full width) -->
    <header class="management-header">
      <div class="header-text">
        <h2>{{ t('server.roles') }}</h2>
        <p v-if="canEditRoles">{{ t('server.roleManagement.intro') }}</p>
        <p v-else>{{ t('server.roleManagement.noPermission') }}</p>
      </div>
      <button v-if="canEditRoles" type="button" class="create-role-btn" @click="createRole">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
        </svg>
        {{ t('server.roleManagement.create') }}
      </button>
    </header>

    <div class="role-layout">
      <!-- ===== Left rail: role list ===== -->
      <div ref="railEl" class="role-rail">
        <h3 :id="`${a11yId}-rail`" class="rail-section-label">
          {{ t('server.roleManagement.count', roles.length) }}
        </h3>

        <div v-if="loading && roles.length === 0" class="rail-loading" role="status" :aria-label="t('common.loading')">
          <div class="spinner small"></div>
        </div>

        <!-- force-fallback: pointer-driven drag. Tauri's WebView2 drag-drop handler (on for OS file drops) swallows HTML5 drag and drop on Windows. -->
        <draggable
          v-else
          v-model="roles"
          item-key="id"
          tag="ul"
          handle=".drag-handle"
          :disabled="!canEditRoles"
          :force-fallback="true"
          :fallback-tolerance="3"
          :aria-labelledby="`${a11yId}-rail`"
          @end="handleReorder"
          class="rail-list"
        >
          <template #item="{ element: role }">
            <li class="role-row">
              <button
                type="button"
                class="role-pill"
                :class="{ active: selectedRole?.id === role.id }"
                :data-role-id="role.id"
                :aria-current="selectedRole?.id === role.id ? 'true' : undefined"
                :aria-keyshortcuts="isMovable(role) ? 'Alt+ArrowUp Alt+ArrowDown' : undefined"
                @click="selectRole(role)"
                @keydown="onPillKeydown($event, role)"
              >
                <span v-if="isMovable(role)" class="drag-handle" :title="t('server.roleManagement.dragHandle')" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="
                      M9 3a2 2 0 1 0 .001 0zm6 0a2 2 0 1 0 .001 0z
                      M9 10a2 2 0 1 0 .001 0zm6 0a2 2 0 1 0 .001 0z
                      M9 17a2 2 0 1 0 .001 0zm6 0a2 2 0 1 0 .001 0z
                    "/>
                  </svg>
                </span>
                <span class="drag-handle-spacer" v-else aria-hidden="true"></span>
                <span class="role-color" :style="{ background: role.color || '#99AAB5' }" aria-hidden="true"></span>
                <span class="role-pill-name">{{ role.name }}</span>
                <span v-if="role.is_admin" class="role-badge admin">{{ t('server.roleManagement.badgeAdmin') }}</span>
                <span v-else-if="role.is_default" class="role-badge default">{{ t('server.roleManagement.badgeDefault') }}</span>
                <template v-if="isThisRoleDirty(role.id)">
                  <span class="role-pill-dot" :title="t('a11y.unsavedChanges')" aria-hidden="true"></span>
                  <span class="sr-only">{{ t('a11y.unsavedChanges') }}</span>
                </template>
                <span class="role-pill-count" aria-hidden="true">{{ getRoleDisplayCount(role) }}</span>
                <span class="sr-only">{{ t('server.membersCount', getRoleDisplayCount(role)) }}</span>
              </button>
            </li>
          </template>
        </draggable>
      </div>

      <!-- ===== Right pane: editor ===== -->
      <section class="role-editor">
        <!-- Empty state when no role selected -->
        <div v-if="!selectedRole" class="editor-empty">
          <p>{{ t('server.roleManagement.emptyEditor') }}</p>
        </div>

        <template v-else>
          <!-- Editor header -->
          <header class="editor-head">
            <div class="editor-title">
              <span class="role-color" :style="{ background: selectedRole.color || '#99AAB5' }" aria-hidden="true"></span>
              <h3 :id="`${a11yId}-editor-title`">{{ selectedRole.name }}</h3>
              <span v-if="selectedRole.is_admin" class="role-badge admin">{{ t('server.roleManagement.badgeAdmin') }}</span>
              <span v-else-if="selectedRole.is_default" class="role-badge default">{{ t('server.roleManagement.badgeDefault') }}</span>
              <div v-if="canEditRoles && !selectedRole.is_default" class="role-move">
                <span :id="`${a11yId}-position`" class="role-move-position">
                  {{ t('server.roleManagement.position', { position: selectedPosition, total: roles.length }) }}
                </span>
                <IconButton
                  class="role-move-btn"
                  data-testid="role-move-up"
                  icon="arrow-up"
                  :size="16"
                  :label="t('server.roleManagement.moveUp', { name: selectedRole.name })"
                  :aria-describedby="`${a11yId}-position`"
                  :aria-disabled="canMoveRole(selectedRole, -1) ? undefined : 'true'"
                  @click="moveRole(selectedRole, -1, false)"
                />
                <IconButton
                  class="role-move-btn"
                  data-testid="role-move-down"
                  icon="arrow-down"
                  :size="16"
                  :label="t('server.roleManagement.moveDown', { name: selectedRole.name })"
                  :aria-describedby="`${a11yId}-position`"
                  :aria-disabled="canMoveRole(selectedRole, 1) ? undefined : 'true'"
                  @click="moveRole(selectedRole, 1, false)"
                />
              </div>
            </div>
            <div
              ref="tablistEl"
              class="editor-tabs"
              role="tablist"
              :aria-labelledby="`${a11yId}-editor-title`"
              @keydown="onTabsKeydown"
            >
              <button
                v-for="tab in editorTabs"
                :key="tab.id"
                :id="`${a11yId}-tab-${tab.id}`"
                type="button"
                role="tab"
                class="tab-btn"
                :class="{ active: activeTab === tab.id }"
                :data-tab="tab.id"
                :aria-selected="activeTab === tab.id ? 'true' : 'false'"
                :aria-controls="`${a11yId}-panel-${tab.id}`"
                :tabindex="activeTab === tab.id ? 0 : -1"
                @click="activeTab = tab.id"
              >
                {{ tab.label }}
              </button>
            </div>
          </header>

          <fieldset class="editor-content" :disabled="!selectedEditable">
          <div
            :id="`${a11yId}-panel-${activeTab}`"
            :key="activeTab"
            class="tab-content"
            role="tabpanel"
            :aria-labelledby="`${a11yId}-tab-${activeTab}`"
            tabindex="0"
          >
          <!-- Display Tab -->
          <template v-if="activeTab === 'display'">
            <div class="form-group">
              <label :for="`${a11yId}-name`">{{ t('server.roleManagement.roleName') }}</label>
              <input
                :id="`${a11yId}-name`"
                v-model="editForm.name"
                type="text"
                class="form-input"
                :disabled="selectedRole.is_default"
                :placeholder="t('server.roleManagement.roleName')"
                :aria-describedby="selectedRole.is_default ? `${a11yId}-name-help` : undefined"
                maxlength="100"
              />
              <p v-if="selectedRole.is_default" :id="`${a11yId}-name-help`" class="form-help">
                {{ t('server.roleManagement.everyoneNameLocked') }}
              </p>
            </div>

            <div class="form-group">
              <div class="form-label" aria-hidden="true">{{ t('server.roleManagement.roleColor') }}</div>
              <ColorPicker
                :color="editForm.color || '#99AAB5'"
                :label="t('server.roleManagement.roleColor')"
                @update:color="editForm.color = $event"
                @change="editForm.color = $event"
              />
            </div>

            <div class="form-group toggle-row">
              <div class="toggle-info">
                <span :id="`${a11yId}-hoist`" class="toggle-title">{{ t('server.roleManagement.hoist') }}</span>
                <p :id="`${a11yId}-hoist-desc`" class="form-help">{{ t('server.roleManagement.hoistDesc') }}</p>
              </div>
              <ToggleSwitch v-model="editForm.hoist" :labelledby="`${a11yId}-hoist`" :describedby="`${a11yId}-hoist-desc`" />
            </div>

            <div class="form-group toggle-row">
              <div class="toggle-info">
                <span :id="`${a11yId}-mention`" class="toggle-title">{{ t('server.roleManagement.mentionable') }}</span>
                <p :id="`${a11yId}-mention-desc`" class="form-help">{{ t('server.roleManagement.mentionableDesc') }}</p>
              </div>
              <ToggleSwitch v-model="editForm.mentionable" :labelledby="`${a11yId}-mention`" :describedby="`${a11yId}-mention-desc`" />
            </div>
          </template>

          <!-- Permissions Tab -->
          <template v-if="activeTab === 'permissions'">
            <p class="perm-intro">{{ t('server.roleManagement.permIntro') }}</p>
            <div
              v-for="section in permissionSections"
              :key="section.id"
              class="perm-group"
              :class="{ 'perm-group-dangerous': section.id === 'dangerous' }"
            >
              <div class="perm-group-head">
                <h4 class="perm-group-label">{{ section.title }}</h4>
                <span v-if="section.id === 'dangerous'" class="perm-group-warn">
                  {{ t('server.roleManagement.dangerWarn') }}
                </span>
              </div>
              <div
                v-for="perm in section.permissions"
                :key="perm.key"
                class="perm-row"
              >
                <div class="perm-row-text">
                  <span :id="`${a11yId}-perm-${perm.key}`" class="perm-row-label">{{ perm.label }}</span>
                  <span :id="`${a11yId}-perm-${perm.key}-desc`" class="perm-row-desc">{{ perm.description }}</span>
                </div>
                <ToggleSwitch
                  :labelledby="`${a11yId}-perm-${perm.key}`"
                  :describedby="`${a11yId}-perm-${perm.key}-desc`"
                  :model-value="hasPermission(perm.key)"
                  :disabled="(selectedRole.is_admin && perm.key === 'ADMINISTRATOR') || (!hasPermission(perm.key) && !canGrant(perm.key))"
                  @update:model-value="togglePermission(perm.key)"
                />
              </div>
            </div>
          </template>

          <!-- Members Tab -->
          <template v-if="activeTab === 'members'">
            <!-- @everyone is everyone; no member roster -->
            <div v-if="selectedRole.is_default" class="members-everyone-note">
              <p>{{ t('server.roleManagement.everyoneMembersNote') }}</p>
            </div>

            <template v-else>
              <!-- Add Members -->
              <div v-if="selectedEditable" class="members-block">
                <div class="members-block-head">
                  <label :for="`${a11yId}-add`" class="members-block-label">{{ t('server.roleManagement.addMembers') }}</label>
                </div>
                <input
                  :id="`${a11yId}-add`"
                  ref="addSearchEl"
                  v-model="addMemberSearch"
                  type="text"
                  class="form-input"
                  :placeholder="t('server.roleManagement.searchMembers')"
                  @input="handleAddMemberSearch"
                />
                <div v-if="addMemberSearch && searchingMembers" class="loading-members">
                  <div class="spinner small"></div>
                </div>
                <div v-else-if="addMemberSearch && availableMembers.length > 0" class="member-result-list">
                  <button
                    v-for="member in availableMembers"
                    :key="member.id"
                    type="button"
                    class="member-row member-row-add"
                    :aria-label="t('server.roleManagement.addMemberTo', { member: memberName(member), role: selectedRole.name })"
                    @click="addMemberToRole(member.id)"
                  >
                    <Avatar :src="member.avatar_url" :alt="memberName(member)" size="xs" />
                    <span class="member-name">
                      <span v-if="member.isBridged">{{ memberName(member) }}</span>
                      <DisplayName v-else :user-id="member.id" :fallback="memberName(member)" />
                    </span>
                    <span class="member-action-icon" aria-hidden="true">+</span>
                  </button>
                </div>
                <EmptyState
                  v-else-if="addMemberSearch && !searchingMembers"
                  size="sm"
                  icon="search"
                  :title="t('empty.roleMembers.noMatch')"
                />
              </div>

              <!-- Current Members -->
              <div class="members-block">
                <div class="members-block-head">
                  <h4 ref="currentHeadEl" :id="`${a11yId}-current`" class="members-block-label" tabindex="-1">
                    {{ t('server.roleManagement.currentMembers') }}
                    <span class="member-count-pill">{{ roleMembers.length }}</span>
                  </h4>
                </div>
                <input
                  v-if="roleMembers.length > 5"
                  v-model="memberSearch"
                  type="text"
                  class="form-input"
                  :aria-label="t('server.roleManagement.filterMembers')"
                  :placeholder="t('server.roleManagement.filterPlaceholder')"
                />

                <div v-if="loadingMembers" class="loading-members">
                  <div class="spinner small"></div>
                </div>
                <EmptyState
                  v-else-if="filteredMembers.length === 0"
                  size="sm"
                  :icon="memberSearch ? 'search' : 'users'"
                  :title="memberSearch ? t('empty.roleMembers.noFilterMatch') : t('empty.roleMembers.none')"
                />
                <ul v-else ref="memberListEl" class="member-result-list" :aria-labelledby="`${a11yId}-current`">
                  <li
                    v-for="member in filteredMembers"
                    :key="member.id"
                    class="member-row"
                  >
                    <Avatar :src="member.avatar_url" :alt="memberName(member)" size="xs" />
                    <span class="member-name">
                      <span v-if="member.isBridged">{{ memberName(member) }}</span>
                      <DisplayName v-else :user-id="member.id" :fallback="memberName(member)" />
                      <span v-if="member.isBridged" class="bridged-member-badge" :title="t('server.roleManagement.bridgedTitle')">{{ t('server.roleManagement.bridged') }}</span>
                      <span v-if="isServerOwner(member.id)" class="owner-badge">{{ t('server.roleManagement.owner') }}</span>
                    </span>
                    <button
                      v-if="canRemoveMember(member)"
                      type="button"
                      class="member-action-icon danger"
                      data-role-remove-member
                      :aria-label="t('server.roleManagement.removeMemberFrom', { member: memberName(member), role: selectedRole.name })"
                      :title="t('server.roleManagement.removeMemberFrom', { member: memberName(member), role: selectedRole.name })"
                      @click="removeMember(member)"
                    >
                      <span aria-hidden="true">&minus;</span>
                    </button>
                    <span
                      v-else-if="selectedRole?.is_admin && isServerOwner(member.id)"
                      class="protected-badge"
                      :title="t('server.roleManagement.protectedTitle')"
                    >
                      {{ t('server.roleManagement.protected') }}
                    </span>
                  </li>
                </ul>
              </div>
            </template>
          </template>
          </div>
        </fieldset>

        <!-- Editor footer -->
        <footer v-if="selectedEditable" class="editor-footer">
          <button
            v-if="!selectedRole.is_default && !selectedRole.is_admin"
            type="button"
            class="delete-btn"
            :aria-describedby="`${a11yId}-editor-title`"
            @click="deleteRole"
          >
            {{ t('server.roleManagement.deleteRole') }}
          </button>
          <div class="footer-spacer"></div>
          <button
            type="button"
            class="cancel-btn"
            :aria-describedby="`${a11yId}-editor-title`"
            :aria-disabled="hasChanges ? undefined : 'true'"
            @click="onResetClick"
          >
            {{ t('common.reset') }}
          </button>
          <!-- aria-disabled, not disabled: focus stays on the button once the save clears the changes. -->
          <button
            type="button"
            class="save-btn"
            :aria-describedby="`${a11yId}-editor-title`"
            :aria-disabled="saving || !hasChanges ? 'true' : undefined"
            @click="saveRole"
          >
            {{ saving ? t('server.roleManagement.saving') : t('server.roleManagement.save') }}
          </button>
        </footer>
        </template>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import draggable from 'vuedraggable'
import { supabase } from '@/supabase'
import { roleService } from '@/services/RoleService'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import Avatar from '@/components/common/Avatar.vue'
import DisplayName from '@/components/DisplayName.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import ColorPicker from '@/components/common/ColorPicker.vue'
import IconButton from '@/components/a11y/IconButton.vue'
import type { ServerRole } from '@/services/RoleService'
import {
  fetchBridgedServerUsers,
  type BridgedChannelUser,
} from '@/services/bridgedChannelUsersService'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useAnnouncer } from '@/composables/useAnnouncer'
import { useRovingTabindex } from '@/composables/useRovingTabindex'
import { useToast } from 'vue-toastification'
import { useProfileStore } from '@/stores/useProfile'

import { uid, focusElement, focusProgrammatically } from '@/utils/a11y/focus'

// Ids pairing controls with their labels, tabs with their panel.
const a11yId = uid('role-management')

interface RoleMemberRow {
  id: string
  username: string
  display_name: string
  avatar_url: string
  isBridged?: boolean
}

interface Props {
  serverId: string
}

const props = defineProps<Props>()
const toast = useToast()
const { confirm } = useConfirmDialog()
const { t } = useI18n()
const { polite } = useAnnouncer()

// State
const loading = ref(false)
const saving = ref(false)
const moving = ref(false)
const roles = ref<ServerRole[]>([])
const selectedRole = ref<ServerRole | null>(null)
const activeTab = ref<EditorTab>('display')
const railEl = ref<HTMLElement | null>(null)
const tablistEl = ref<HTMLElement | null>(null)
const addSearchEl = ref<HTMLInputElement | null>(null)
const currentHeadEl = ref<HTMLElement | null>(null)
const memberListEl = ref<HTMLElement | null>(null)
const memberSearch = ref('')
const roleMembers = ref<RoleMemberRow[]>([])
const loadingMembers = ref(false)
const serverOwnerId = ref<string | null>(null)
const profileStore = useProfileStore()
// The owner and instance admins manage every role. A MANAGE_ROLES holder manages roles ranked
// below their highest role and grants only permissions they hold; the database enforces both.
const myPermissions = ref<Partial<Record<string, boolean>>>({})
const myRank = ref(0)
const outranksAll = computed(() => {
  const profile = profileStore.profile
  if (!profile) return false
  return profile.id === serverOwnerId.value || profile.is_admin === true
})
const canEditRoles = computed(() => outranksAll.value || myPermissions.value.MANAGE_ROLES === true)
const canManageRole = (role: ServerRole): boolean =>
  outranksAll.value || (canEditRoles.value && (role.is_default || role.position < myRank.value))
const selectedEditable = computed(() => !!selectedRole.value && canManageRole(selectedRole.value))
const canGrant = (key: string): boolean =>
  outranksAll.value || myPermissions.value.ADMINISTRATOR === true || myPermissions.value[key] === true
// @everyone holds the bottom slot; a role the caller cannot manage holds its slot.
const isMovable = (role: ServerRole): boolean => canEditRoles.value && !role.is_default && canManageRole(role)
const canMoveAt = (index: number, delta: number): boolean => {
  const role = roles.value[index]
  const other = roles.value[index + delta]
  return !!role && !!other && isMovable(role) && isMovable(other)
}
const canMoveRole = (role: ServerRole, delta: number): boolean =>
  canMoveAt(roles.value.findIndex(r => r.id === role.id), delta)
const selectedPosition = computed(() =>
  roles.value.findIndex(r => r.id === selectedRole.value?.id) + 1)

const loadMyStanding = async () => {
  const profileId = profileStore.profile?.id
  if (!profileId || !props.serverId) return
  const [permissions, myRoles] = await Promise.all([
    roleService.getUserPermissions(profileId, props.serverId),
    roleService.getUserRoles(profileId, props.serverId),
  ])
  myPermissions.value = permissions
  myRank.value = Math.max(0, ...myRoles.map(r => r.position ?? 0))
}
const serverBridgedUsers = ref<BridgedChannelUser[]>([])

const addMemberSearch = ref('')
const searchingMembers = ref(false)
const availableMembers = ref<any[]>([])
const allServerMembers = ref<any[]>([])
let searchTimeout: ReturnType<typeof setTimeout> | null = null

// Form state
const editForm = ref({
  name: '',
  color: '#99AAB5',
  hoist: false,
  mentionable: false,
  permissions: [] as string[],
})

// Tabs: automatic activation, focus and selection move together.
type EditorTab = 'display' | 'permissions' | 'members'
const editorTabs = computed(() =>
  (['display', 'permissions', 'members'] as const).map(id => ({
    id,
    label: t(`server.roleManagement.tabs.${id}`),
  })))
const { onKeydown: onTabsKeydown } = useRovingTabindex(tablistEl, {
  itemSelector: '[role="tab"]',
  orientation: 'horizontal',
  onActivate: (item) => {
    activeTab.value = item.dataset.tab as EditorTab
  },
})

// Color presets
const colorPresets = [
  '#1ABC9C', '#2ECC71', '#3498DB', '#9B59B6', '#E91E63',
  '#F1C40F', '#E67E22', '#E74C3C', '#95A5A6', '#607D8B',
  '#11806A', '#1F8B4C', '#206694', '#71368A', '#AD1457',
  '#C27C0E', '#A84300', '#992D22', '#979C9F', '#546E7A',
]

// Permission sections mirror Harmony's feature set. Labels and descriptions are
// server.roleManagement.perms.<KEY>.{label,description}.
const PERMISSION_SECTIONS: Array<{ id: string; keys: string[] }> = [
  {
    id: 'general',
    keys: ['VIEW_CHANNEL', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'MANAGE_SERVER', 'CREATE_INVITE', 'VIEW_AUDIT_LOG', 'MANAGE_EMOJIS', 'MANAGE_WEBHOOKS'],
  },
  {
    id: 'membership',
    keys: ['KICK_MEMBERS', 'BAN_MEMBERS', 'TIMEOUT_MEMBERS'],
  },
  {
    id: 'text',
    keys: ['SEND_MESSAGES', 'EMBED_LINKS', 'ATTACH_FILES', 'ADD_REACTIONS', 'MENTION_EVERYONE', 'MANAGE_MESSAGES', 'READ_MESSAGE_HISTORY', 'USE_EXTERNAL_EMOJIS', 'PIN_MESSAGES'],
  },
  {
    id: 'threads',
    keys: ['CREATE_PUBLIC_THREADS', 'CREATE_PRIVATE_THREADS', 'SEND_MESSAGES_IN_THREADS'],
  },
  {
    id: 'voice',
    keys: ['CONNECT', 'SPEAK', 'STREAM', 'MUTE_MEMBERS', 'DEAFEN_MEMBERS', 'MOVE_MEMBERS', 'USE_SOUNDBOARD', 'USE_EXTERNAL_SOUNDS'],
  },
]

const permissionSections = computed(() =>
  PERMISSION_SECTIONS.map(section => ({
    id: section.id,
    title: t(`server.roleManagement.sections.${section.id}`),
    permissions: section.keys.map(key => ({
      key,
      label: t(`server.roleManagement.perms.${key}.label`),
      description: t(`server.roleManagement.perms.${key}.description`),
    })),
  })))

// Helper to safely convert permissions to array
// DB stores as { 'VIEW_CHANNEL': true, 'SEND_MESSAGES': true }
// Frontend expects ['VIEW_CHANNEL', 'SEND_MESSAGES']
const ensurePermissionsArray = (perms: unknown): string[] => {
  if (Array.isArray(perms)) {
    return [...perms]
  } else if (typeof perms === 'object' && perms !== null) {
    const obj = perms as Record<string, unknown>
    return Object.entries(obj)
      .filter(([_, value]) => value === true)
      .map(([key]) => key)
  } else if (typeof perms === 'string') {
    try {
      const parsed = JSON.parse(perms)
      if (Array.isArray(parsed)) {
        return parsed
      } else if (typeof parsed === 'object') {
        return Object.entries(parsed)
          .filter(([_, value]) => value === true)
          .map(([key]) => key)
      }
      return []
    } catch {
      return []
    }
  }
  return []
}

// Helper to convert permissions array to JSONB object format for database
const permissionsArrayToObject = (perms: string[]): Record<string, boolean> => {
  const obj: Record<string, boolean> = {}
  for (const perm of perms) {
    obj[perm] = true
  }
  return obj
}

// Computed
const hasChanges = computed(() => {
  if (!selectedRole.value) return false
  return isThisRoleDirty(selectedRole.value.id)
})

/**
 * Per-role dirty check, used by the editor footer ("Save Changes" enabled?)
 * and the role rail ("show unsaved dot?"). Compares against the canonical
 * role record in `roles.value`, not the in-form snapshot: a role can be
 * inspected without being selected, and the dot must clear after save/reset.
 */
function isThisRoleDirty(roleId: string): boolean {
  if (!selectedRole.value || selectedRole.value.id !== roleId) return false
  const role = roles.value.find(r => r.id === roleId)
  if (!role) return false
  const currentPerms = ensurePermissionsArray(role.permissions)
  return (
    editForm.value.name !== role.name ||
    editForm.value.color !== (role.color || '#99AAB5') ||
    editForm.value.hoist !== role.hoist ||
    editForm.value.mentionable !== role.mentionable ||
    JSON.stringify([...editForm.value.permissions].sort()) !==
      JSON.stringify([...currentPerms].sort())
  )
}

const filteredMembers = computed(() => {
  if (!memberSearch.value) return roleMembers.value
  const search = memberSearch.value.toLowerCase()
  return roleMembers.value.filter(m => 
    (m.display_name || '').toLowerCase().includes(search) ||
    (m.username || '').toLowerCase().includes(search)
  )
})

// Methods
const loadRoles = async () => {
  if (!props.serverId) return
  loading.value = true
  try {
    const data = await roleService.getServerRoles(props.serverId, true)
    roles.value = data.sort((a, b) => b.position - a.position)
    // Auto-select the highest-position role (or @everyone) so the editor
    // pane has content immediately. Don't override an existing selection
    // if the same role still exists (e.g. user just saved).
    if (selectedRole.value) {
      const stillThere = roles.value.find(r => r.id === selectedRole.value!.id)
      if (stillThere) {
        return
      }
    }
    const initial = roles.value.find(r => !r.is_default) || roles.value[0]
    if (initial) {
      void selectRole(initial)
    }
  } catch (error) {
    console.error('Failed to load roles:', error)
  } finally {
    loading.value = false
  }
}

const createRole = async () => {
  try {
    const newRole = await roleService.createRole(props.serverId, {
      name: t('server.roleManagement.newRoleName'),
      color: colorPresets[Math.floor(Math.random() * colorPresets.length)],
      // Below the caller's highest role, the highest slot they may use.
      position: outranksAll.value ? undefined : Math.max(myRank.value - 1, 0),
    })
    if (newRole) {
      roles.value = [...roles.value, newRole].sort((a, b) => b.position - a.position)
      selectRole(newRole)
      polite(t('server.roleManagement.created', { name: newRole.name }))
    } else {
      toast.error(t('server.roleManagement.errors.create'))
    }
  } catch (error) {
    console.error('Failed to create role:', error)
    toast.error(t('server.roleManagement.errors.create'))
  }
}

const selectRole = async (role: ServerRole) => {
  selectedRole.value = role
  activeTab.value = 'display'
  resetForm()
  
  addMemberSearch.value = ''
  availableMembers.value = []
  
  loadingMembers.value = true
  try {
    await Promise.all([
      loadServerMembers(),
      loadServerBridgedUsers({ force: true }),
    ])
    const members = await roleService.getRoleMembers(role.id)
    roleMembers.value = mergeRoleMembers(members, role.id)
  } catch (error) {
    console.error('Failed to load role members:', error)
    roleMembers.value = []
  } finally {
    loadingMembers.value = false
  }
}

function bridgedUsersForRole(roleId: string): RoleMemberRow[] {
  return serverBridgedUsers.value
    .filter(u => u.harmonyRoleIds?.includes(roleId))
    .map(u => ({
      id: `discord:${u.id}`,
      username: u.username,
      display_name: u.displayName,
      avatar_url: u.avatarUrl,
      isBridged: true,
    }))
}

function normalizeHarmonyRoleMembers(
  members: Array<{ id: string; username: string; display_name?: string; avatar_url?: string }>,
): RoleMemberRow[] {
  return members.map(m => ({
    id: m.id,
    username: m.username,
    display_name: m.display_name ?? m.username,
    avatar_url: m.avatar_url ?? '',
  }))
}

function mergeRoleMembers(
  harmonyMembers: Array<{ id: string; username: string; display_name?: string; avatar_url?: string }>,
  roleId: string,
): RoleMemberRow[] {
  return [...normalizeHarmonyRoleMembers(harmonyMembers), ...bridgedUsersForRole(roleId)].sort((a, b) =>
    (a.display_name || a.username).localeCompare(b.display_name || b.username),
  )
}

function getRoleDisplayCount(role: ServerRole): number {
  const base = role.member_count || 0
  const bridged = bridgedUsersForRole(role.id).length
  return base + bridged
}

async function loadServerBridgedUsers(options: { force?: boolean } = {}) {
  try {
    const result = await fetchBridgedServerUsers(props.serverId, options)
    serverBridgedUsers.value = result.users
  } catch (error) {
    console.error('Failed to load bridged server users:', error)
    serverBridgedUsers.value = []
  }
}

const resetForm = () => {
  if (!selectedRole.value) return
  
  editForm.value = {
    name: selectedRole.value.name,
    color: selectedRole.value.color || '#99AAB5',
    hoist: selectedRole.value.hoist || false,
    mentionable: selectedRole.value.mentionable || false,
    permissions: ensurePermissionsArray(selectedRole.value.permissions),
  }
}

const hasPermission = (key: string) => {
  return editForm.value.permissions.includes(key)
}

const togglePermission = (key: string) => {
  const index = editForm.value.permissions.indexOf(key)
  if (index >= 0) {
    editForm.value.permissions.splice(index, 1)
  } else {
    editForm.value.permissions.push(key)
  }
}

const onResetClick = () => {
  if (!hasChanges.value) return
  resetForm()
  polite(t('server.roleManagement.changesReset'))
}

const saveRole = async () => {
  if (!selectedRole.value || !hasChanges.value || saving.value) return
  
  saving.value = true
  try {
    const updated = await roleService.updateRole(selectedRole.value.id, {
      name: editForm.value.name,
      color: editForm.value.color,
      hoist: editForm.value.hoist,
      mentionable: editForm.value.mentionable,
      permissions: permissionsArrayToObject(editForm.value.permissions),
    })
    
    if (updated) {
      const index = roles.value.findIndex(r => r.id === updated.id)
      if (index >= 0) {
        roles.value[index] = updated
      }
      selectedRole.value = updated
      resetForm()
      polite(t('server.roleManagement.saved', { name: updated.name }))
    } else {
      toast.error(t('server.roleManagement.errors.save'))
    }
  } catch (error) {
    console.error('Failed to save role:', error)
    toast.error(t('server.roleManagement.errors.save'))
  } finally {
    saving.value = false
  }
}

const isProtectedRole = computed(() => {
  return selectedRole.value?.is_default || selectedRole.value?.is_admin
})

const deleteRole = async () => {
  if (!selectedRole.value || isProtectedRole.value) return
  
  const deletedName = selectedRole.value.name
  if (!(await confirm({
    title: t('server.roleManagement.confirmDeleteTitle'),
    message: t('server.roleManagement.confirmDeleteMessage', { name: deletedName }),
    confirmButtonText: t('common.delete'),
    dangerAction: true,
  }))) {
    return
  }
  
  try {
    const deletedId = selectedRole.value.id
    if (!(await roleService.deleteRole(deletedId))) {
      toast.error(t('server.roleManagement.errors.delete'))
      return
    }
    roles.value = roles.value.filter(r => r.id !== deletedId)
    // Land on the next-best role instead of an empty pane.
    const next = roles.value.find(r => !r.is_default) || roles.value[0] || null
    if (next) {
      void selectRole(next)
    } else {
      selectedRole.value = null
    }
    polite(t('server.roleManagement.deleted', { name: deletedName }))
    // Focus moves to the newly selected role: the delete button can unmount with the footer.
    await nextTick()
    if (next) focusPill(next.id)
  } catch (error: any) {
    console.error('Failed to delete role:', error)
    toast.error(error.message || t('server.roleManagement.errors.delete'))
  }
}

const removeMember = async (member: RoleMemberRow) => {
  if (!selectedRole.value || member.isBridged) return
  
  const roleName = selectedRole.value.name
  try {
    const index = filteredMembers.value.findIndex(m => m.id === member.id)
    const success = await roleService.removeRole(member.id, selectedRole.value.id)
    if (success) {
      roleMembers.value = roleMembers.value.filter(m => m.id !== member.id)
      polite(t('server.roleManagement.memberRemoved', { member: memberName(member), role: roleName }))
      // The removed row's button unmounts: focus the row now in its place, else the list heading.
      await nextTick()
      const buttons = memberListEl.value?.querySelectorAll<HTMLElement>('[data-role-remove-member]') ?? []
      const target = buttons[Math.min(index, buttons.length - 1)]
      if (!focusElement(target)) focusProgrammatically(currentHeadEl.value)
    }
  } catch (error: any) {
    console.error('Failed to remove member from role:', error)
    if (error.message?.includes('server owner')) {
      toast.error(t('server.roleManagement.errors.removeOwnerAdmin'))
    } else {
      toast.error(error.message || t('server.roleManagement.errors.removeMember'))
    }
  }
}

const loadServerMembers = async () => {
  try {
    const { data, error } = await supabase
      .from('user_servers')
      .select(`
        user_id,
        profiles:user_id (
          id,
          username,
          display_name,
          avatar_url
        )
      `)
      .eq('server_id', props.serverId)
    
    if (error) throw error
    
    allServerMembers.value = (data || []).map((us: any) => ({
      id: us.user_id,
      username: us.profiles?.username || 'Unknown',
      display_name: us.profiles?.display_name,
      avatar_url: us.profiles?.avatar_url,
    }))
  } catch (error) {
    console.error('Failed to load server members:', error)
    allServerMembers.value = []
  }
}

const handleAddMemberSearch = () => {
  if (searchTimeout) {
    clearTimeout(searchTimeout)
  }
  
  searchTimeout = setTimeout(() => {
    searchAvailableMembers()
  }, 200)
}

// Search for members that can be added (not already in role)
const searchAvailableMembers = () => {
  const query = addMemberSearch.value.toLowerCase().trim()
  if (!query) {
    availableMembers.value = []
    return
  }
  
  searchingMembers.value = true
  
  const roleMemberIds = new Set(roleMembers.value.map(m => m.id))
  
  availableMembers.value = allServerMembers.value.filter(member => {
    // Exclude members who already have this role
    if (roleMemberIds.has(member.id)) return false
    
    // Match by username or display name
    const username = (member.username || '').toLowerCase()
    const displayName = (member.display_name || '').toLowerCase()
    
    return username.includes(query) || displayName.includes(query)
  }).slice(0, 10) // Limit to 10 results
  
  searchingMembers.value = false
  polite(
    availableMembers.value.length > 0
      ? t('server.roleManagement.searchResults', availableMembers.value.length)
      : t('empty.roleMembers.noMatch'),
    { key: 'role-member-search' },
  )
}

const addMemberToRole = async (memberId: string) => {
  if (!selectedRole.value) return
  
  try {
    const roleName = selectedRole.value.name
    const success = await roleService.assignRole(memberId, selectedRole.value.id, props.serverId)
    if (success) {
      const member = availableMembers.value.find(m => m.id === memberId)
      if (member) {
        roleMembers.value.push(member)
        availableMembers.value = availableMembers.value.filter(m => m.id !== memberId)
        polite(t('server.roleManagement.memberAdded', { member: memberName(member), role: roleName }))
        // The added row's button unmounts with the search result.
        await nextTick()
        focusElement(addSearchEl.value)
      }
    }
  } catch (error: any) {
    console.error('Failed to add member to role:', error)
    toast.error(error.message || t('server.roleManagement.errors.addMember'))
  }
}

const handleReorder = async (): Promise<boolean> => {
  // @everyone keeps position 0.
  let updates: { id: string; position: number }[]
  if (outranksAll.value) {
    updates = roles.value
      .map((role, index) => ({ id: role.id, position: roles.value.length - index, isDefault: role.is_default }))
      .filter(u => !u.isDefault)
      .map(({ id, position }) => ({ id, position }))
  } else {
    // Manageable roles trade the positions they held: none rises to the caller's rank.
    const manageable = roles.value.filter(r => !r.is_default && canManageRole(r))
    const slots = manageable.map(r => r.position).sort((a, b) => b - a)
    updates = manageable.map((r, i) => ({ id: r.id, position: slots[i] }))
  }

  const ok = await roleService.reorderRoles(props.serverId, updates)
  if (!ok) toast.error(t('server.roleManagement.errors.reorder'))
  if (!ok || !outranksAll.value) await loadRoles()
  return ok
}

const focusPill = (roleId: string) => {
  const pills = railEl.value?.querySelectorAll<HTMLElement>('.role-pill') ?? []
  focusElement(Array.from(pills).find(el => el.dataset.roleId === roleId))
}

/**
 * Keyboard reorder: swaps the role with its neighbour and saves through
 * handleReorder, the drag-drop path. `fromPill` refocuses the role's list
 * entry, which the list re-render can detach from focus.
 */
const moveRole = async (role: ServerRole, delta: -1 | 1, fromPill: boolean) => {
  if (moving.value) return
  const index = roles.value.findIndex(r => r.id === role.id)
  if (!canMoveAt(index, delta)) return
  const next = [...roles.value]
  ;[next[index], next[index + delta]] = [next[index + delta], next[index]]
  roles.value = next
  moving.value = true
  try {
    if (fromPill) {
      await nextTick()
      focusPill(role.id)
    }
    const ok = await handleReorder()
    if (ok) {
      const position = roles.value.findIndex(r => r.id === role.id) + 1
      polite(t('server.roleManagement.moved', { name: role.name, position, total: roles.value.length }))
    }
  } finally {
    moving.value = false
  }
  if (fromPill) {
    await nextTick()
    focusPill(role.id)
  }
}

const onPillKeydown = (event: KeyboardEvent, role: ServerRole) => {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
  event.preventDefault()
  void moveRole(role, event.key === 'ArrowUp' ? -1 : 1, true)
}

const memberName = (member: { display_name?: string; username: string }): string =>
  member.display_name || member.username

// Watch for server changes
watch(() => props.serverId, () => {
  selectedRole.value = null
  roles.value = []
  loadRoles()
  void loadMyStanding()
})

const loadServerOwner = async () => {
  try {
    const { data, error } = await supabase
      .from('servers')
      .select('owner')
      .eq('id', props.serverId)
      .single()
    
    if (!error && data) {
      serverOwnerId.value = data.owner
    }
  } catch (error) {
    console.error('Failed to load server owner:', error)
  }
}

const isServerOwner = (memberId: string): boolean => {
  return serverOwnerId.value === memberId
}

const canRemoveMember = (member: RoleMemberRow): boolean => {
  if (!selectedRole.value || !canManageRole(selectedRole.value)) return false
  if (member.isBridged) return false
  if (selectedRole.value?.is_default) return false
  if (selectedRole.value?.is_admin && isServerOwner(member.id)) return false
  return true
}

onMounted(() => {
  loadRoles()
  void loadMyStanding()
  loadServerOwner()
  void loadServerBridgedUsers()
})
</script>

<style scoped>
/* =========================================================================
   ROOT LAYOUT
   - Header on top (full width).
   - Below: 240px role rail | flex-grow editor.
   ======================================================================= */
.role-management {
  display: flex;
  flex-direction: column;
  min-height: 540px;
  height: 100%;
}

.management-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 16px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--border-color);
}

.header-text h2 {
  margin: 0 0 8px;
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.header-text p {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.create-role-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  border: none;
  border-radius: var(--radius-base);
  font-size: 13px;
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: background-color var(--transition-fast);
  flex-shrink: 0;
}

.create-role-btn:hover { background: var(--harmony-primary-hover); }

.role-layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 20px;
  flex: 1;
  min-height: 0;
}

/* =========================================================================
   ROLE RAIL (left)
   ======================================================================= */
.role-rail {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-right: 8px;
  border-right: 1px solid var(--border-color);
  overflow-y: auto;
  min-height: 0;
}

.rail-section-label {
  margin: 0;
  font-size: 11px;
  font-weight: var(--font-weight-bold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  padding: 0 8px 8px;
}

.rail-loading {
  display: flex;
  justify-content: center;
  padding: 24px 0;
}

.rail-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.role-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: none;
  border-radius: var(--radius-base);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  text-align: left;
  transition: background 0.12s, color 0.12s;
}

.role-pill:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.role-pill.active {
  background: var(--background-tertiary);
  color: var(--text-primary);
}

.role-pill-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.role-pill-count {
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
  padding-left: 4px;
}

.role-pill-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--harmony-primary);
  flex-shrink: 0;
}

.drag-handle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  color: var(--text-muted);
  cursor: grab;
  opacity: 0.5;
  transition: opacity 0.12s;
}

.drag-handle:active { cursor: grabbing; }
.role-pill:hover .drag-handle { opacity: 1; }

.drag-handle-spacer { width: 14px; flex-shrink: 0; }

.role-color {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex-shrink: 0;
}

/* Badges shared with the editor header */
.role-badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  font-weight: var(--font-weight-semibold);
  flex-shrink: 0;
}

.role-badge.admin {
  background: color-mix(in srgb, var(--error) 15%, transparent);
  color: var(--text-danger);
}

.role-badge.default {
  background: var(--background-tertiary);
  color: var(--text-secondary);
}

.owner-badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--warning) 15%, transparent);
  color: var(--warning);
  font-weight: var(--font-weight-semibold);
  margin-left: 6px;
}

.protected-badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--background-modifier-selected);
  color: var(--text-secondary);
  font-weight: var(--font-weight-semibold);
  flex-shrink: 0;
}

/* =========================================================================
   EDITOR (right)
   ======================================================================= */
.role-editor {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.editor-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  padding: 32px;
  color: var(--text-secondary);
  font-size: 13px;
}

.editor-head {
  padding: 16px 20px 0;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.editor-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  margin-bottom: 12px;
}

.editor-title h3 {
  margin: 0;
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.role-move {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  flex-shrink: 0;
}

.role-move-position {
  margin-right: 6px;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  white-space: nowrap;
}

.role-move-btn[aria-disabled='true'] {
  opacity: 0.4;
  cursor: not-allowed;
}

.editor-tabs {
  display: flex;
  gap: 4px;
}

.tab-btn {
  padding: 10px 14px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  margin-bottom: -1px;
  transition: color 0.12s, border-color 0.12s;
}

.tab-btn:hover { color: var(--text-primary); }
.tab-btn.active {
  color: var(--text-link);
  border-bottom-color: var(--harmony-primary);
}

.editor-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  min-height: 0;
  min-width: 0;
  margin: 0;
  border: 0;
}

@media (prefers-reduced-motion: no-preference) {
  .tab-content {
    animation: fadeIn 0.15s ease;
  }
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* ===== Display tab form bits ===== */
.form-group {
  margin-bottom: 20px;
}
.form-group:last-child { margin-bottom: 0; }

.form-group label,
.form-label {
  display: block;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin-bottom: 8px;
}

.form-group.toggle-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.toggle-info { flex: 1; min-width: 0; }

.toggle-title {
  display: block;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin-bottom: 4px;
  text-transform: none;
  letter-spacing: normal;
}

.form-help {
  margin: 6px 0 0;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.form-input {
  width: 100%;
  padding: 10px 12px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-base);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  outline: none;
  transition: border-color 0.15s;
}

.form-input:focus { border-color: var(--harmony-primary); }
.form-input:disabled { opacity: 0.5; cursor: not-allowed; }
.form-input::placeholder { color: var(--text-muted); }

.color-picker-row {
  display: flex;
  gap: 10px;
}

.color-input {
  width: 42px;
  height: 42px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
  cursor: pointer;
  padding: 0;
  background: transparent;
}

.color-text {
  flex: 1;
  padding: 10px 12px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-base);
  color: var(--text-primary);
  font-size: 13px;
  font-family: ui-monospace, SFMono-Regular, monospace;
  outline: none;
  transition: border-color 0.15s;
}

.color-text:focus { border-color: var(--harmony-primary); }

.color-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.color-preset {
  width: 24px;
  height: 24px;
  border: 1px solid var(--border-secondary);
  border-radius: 50%;
  cursor: pointer;
  padding: 0;
  transition: border-color var(--transition-fast);
}

.color-preset:hover { border-color: var(--border-hover); }

/* ===== Permissions tab ===== */
.perm-intro {
  margin: 0 0 16px;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  line-height: 1.5;
  padding: 10px 12px;
  background: var(--background-tertiary);
  border-radius: var(--radius-base);
}

.perm-group {
  margin-bottom: 24px;
}
.perm-group:last-child { margin-bottom: 0; }

.perm-group-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 4px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border-color);
}

.perm-group-label {
  margin: 0;
  font-size: 11px;
  font-weight: var(--font-weight-bold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.perm-group-warn {
  font-size: var(--font-size-xs);
  color: var(--warning);
}

.perm-group-dangerous .perm-group-label {
  color: var(--text-danger);
}

.perm-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 4px;
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
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
}

.perm-row-desc {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  line-height: 1.4;
}

/* ===== Members tab ===== */
.members-everyone-note {
  padding: 16px;
  background: var(--background-tertiary);
  border-radius: var(--radius-base);
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
}

.members-block {
  margin-bottom: 24px;
}
.members-block:last-child { margin-bottom: 0; }

.members-block-head {
  display: flex;
  align-items: center;
  margin-bottom: 8px;
}

.members-block-label {
  margin: 0;
  font-size: 11px;
  font-weight: var(--font-weight-bold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.member-count-pill {
  margin-left: 6px;
  background: var(--background-tertiary);
  color: var(--text-primary);
  padding: 2px 8px;
  border-radius: var(--radius-full);
  font-size: 10px;
  font-weight: var(--font-weight-semibold);
}

.bridged-member-badge {
  display: inline-flex;
  align-items: center;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: var(--font-weight-semibold);
  color: var(--text-secondary);
  background: var(--background-modifier-selected);
  vertical-align: middle;
}

.member-result-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  max-height: 320px;
  overflow-y: auto;
}

.member-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: transparent;
  border: none;
  border-radius: var(--radius-base);
  color: var(--text-primary);
  font: inherit;
  text-align: left;
  transition: background 0.12s;
}

.member-row-add {
  cursor: pointer;
}

.member-row-add:hover {
  background: var(--background-tertiary);
}

.member-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.member-action-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--harmony-primary) 15%, transparent);
  color: var(--text-link);
  border: none;
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.member-action-icon:hover { background: color-mix(in srgb, var(--harmony-primary) 25%, transparent); }

.member-action-icon.danger {
  background: color-mix(in srgb, var(--error) 15%, transparent);
  color: var(--text-danger);
}

.member-action-icon.danger:hover { background: color-mix(in srgb, var(--error) 25%, transparent); }

.loading-members {
  display: flex;
  justify-content: center;
  padding: 16px;
}

/* ===== Editor footer ===== */
.editor-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--border-color);
  background: var(--background-secondary);
  flex-shrink: 0;
}

.footer-spacer { flex: 1; }

.delete-btn {
  background: transparent;
  border: none;
  color: var(--text-danger);
  font-size: 13px;
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  padding: 8px 12px;
  border-radius: var(--radius-base);
  transition: background 0.15s;
}

.delete-btn:hover { background: color-mix(in srgb, var(--error) 10%, transparent); }

.cancel-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  padding: 8px 12px;
  border-radius: var(--radius-base);
}

.cancel-btn:not([aria-disabled='true']):hover {
  color: var(--text-primary);
  background: var(--background-modifier-hover);
}

.cancel-btn[aria-disabled='true'] { opacity: 0.4; cursor: not-allowed; }

.save-btn {
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  border: none;
  padding: 9px 18px;
  border-radius: var(--radius-base);
  font-size: 13px;
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.save-btn:hover:not([aria-disabled='true']) { background: var(--harmony-primary-hover); }
.save-btn[aria-disabled='true'] { opacity: 0.5; cursor: not-allowed; }

/* ===== Misc ===== */
.spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--border-color);
  border-top-color: var(--harmony-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.spinner.small {
  width: 18px;
  height: 18px;
  border-width: 2px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ===== Responsive: collapse to single column on narrow ===== */
@media (max-width: 720px) {
  .role-layout {
    grid-template-columns: 1fr;
  }
  .role-rail {
    border-right: none;
    border-bottom: 1px solid var(--border-color);
    padding-right: 0;
    padding-bottom: 8px;
    max-height: 220px;
  }
}
</style>

