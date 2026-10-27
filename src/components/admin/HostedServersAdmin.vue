<template>
  <div ref="rootEl" class="admin-module hosted-servers-module" data-testid="hosted-servers">
    <div class="module-header">
      <Icon name="server" :size="20" />
      <h2 ref="titleEl" tabindex="-1" class="hosted-title">{{ t('hostStaff.title') }}</h2>
      <span class="staff-pill"><Icon name="shield" :size="13" />{{ staffLabel }}</span>
    </div>
    <p class="module-intro">{{ t('hostStaff.intro', { instance }) }}</p>

    <HostedServerDetail
      v-if="selected"
      ref="detailEl"
      :server="selected"
      :instance="instance"
      :refresh-key="refreshKey"
      @back="closeServer"
      @act="request"
    />

    <template v-else>
      <div class="hosted-toolbar">
        <div class="hosted-search">
          <Icon name="search" :size="16" />
          <input
            v-model="search"
            type="search"
            class="cyber-input"
            :placeholder="t('hostStaff.searchHint')"
            :aria-label="t('hostStaff.searchLabel')"
            data-testid="hosted-servers-search"
          />
        </div>
        <div class="hosted-filters" role="group" :aria-label="t('hostStaff.title')">
          <button
            type="button"
            :class="['filter-btn', { active: !suspendedOnly }]"
            :aria-pressed="!suspendedOnly"
            @click="suspendedOnly = false"
          >{{ t('hostStaff.filterAll') }}</button>
          <button
            type="button"
            :class="['filter-btn', { active: suspendedOnly }]"
            :aria-pressed="suspendedOnly"
            @click="suspendedOnly = true"
          >{{ t('hostStaff.filterSuspended') }}</button>
        </div>
      </div>

      <div v-if="loading && servers.length === 0" class="loading-state">
        <LoadingSpinner :size="20" />
      </div>
      <p v-else-if="loadError" class="hosted-error" role="alert">{{ loadError }}</p>
      <EmptyState
        v-else-if="servers.length === 0"
        size="sm"
        icon="server"
        :title="search || suspendedOnly ? t('hostStaff.emptySearch') : t('hostStaff.empty')"
      />
      <ul v-else class="hosted-list">
        <li
          v-for="server in servers"
          :key="server.id"
          class="hosted-row"
          :class="{ suspended: !!server.suspended_at }"
          data-testid="hosted-server-row"
        >
          <img class="hosted-icon" :src="getServerIconUrl(server.icon, 96, server.name)" alt="" />
          <div class="hosted-info">
            <div class="hosted-name">
              <span>{{ server.name }}</span>
              <span v-if="server.suspended_at" class="badge suspended">{{ t('hostStaff.suspendedBadge') }}</span>
            </div>
            <div class="hosted-meta">
              <span>
                {{ t('hostStaff.owner') }}:
                <template v-if="server.owner_id">
                  {{ server.owner_display_name || server.owner_username }}
                  <span class="hosted-handle">@{{ server.owner_username }}</span>
                </template>
                <template v-else>{{ t('hostStaff.noOwner') }}</template>
              </span>
              <span>{{ t('hostStaff.members', { count: server.member_count }, server.member_count) }}</span>
              <span v-if="server.remote_member_count > 0">
                {{ t('hostStaff.remoteMembers', { count: server.remote_member_count }) }}
              </span>
            </div>
            <p v-if="server.suspended_at && server.suspended_reason" class="hosted-reason">
              {{ t('hostStaff.suspendedReason', { reason: server.suspended_reason }) }}
            </p>
          </div>
          <div class="hosted-actions">
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              data-testid="hosted-server-open"
              :data-server-id="server.id"
              :aria-label="rowAction('hostStaff.open', server.name)"
              @click="openServer(server)"
            >{{ t('hostStaff.open') }}</button>
            <button
              v-if="server.suspended_at"
              type="button"
              class="btn btn-secondary btn-sm"
              :aria-label="rowAction('hostStaff.actions.unsuspendServer', server.name)"
              @click="request({ kind: 'unsuspend', server })"
            >{{ t('hostStaff.actions.unsuspendServer') }}</button>
            <button
              v-else
              type="button"
              class="btn btn-secondary btn-sm staff-warn"
              data-testid="hosted-server-suspend"
              :aria-label="rowAction('hostStaff.actions.suspendServer', server.name)"
              @click="request({ kind: 'suspend', server })"
            >{{ t('hostStaff.actions.suspendServer') }}</button>
            <button
              type="button"
              class="btn btn-danger btn-sm"
              data-testid="hosted-server-delete"
              :aria-label="rowAction('hostStaff.actions.deleteServer', server.name)"
              @click="request({ kind: 'delete', server })"
            >{{ t('hostStaff.actions.deleteServer') }}</button>
          </div>
        </li>
      </ul>

      <div v-if="total > PAGE" class="pagination">
        <button class="pagination-btn" :disabled="offset === 0" @click="page(-1)">{{ t('hostStaff.previous') }}</button>
        <span class="pagination-info">{{ offset + 1 }}–{{ Math.min(offset + PAGE, total) }} / {{ total }}</span>
        <button class="pagination-btn" :disabled="offset + PAGE >= total" @click="page(1)">{{ t('hostStaff.next') }}</button>
      </div>
    </template>

    <StaffActionDialog
      v-if="pending"
      :show="!!pending"
      :title="dialog.title"
      :staff-label="staffLabel"
      :scope-line="t('hostStaff.confirm.asStaff', { instance, server: pending.server.name })"
      :consequences="dialog.consequences"
      :record-line="dialog.record"
      :reason-hint="dialog.reasonHint"
      :confirm-label="dialog.confirm"
      :danger="pending.kind !== 'unsuspend'"
      :confirm-text="pending.kind === 'delete' ? pending.server.name : ''"
      :busy="busy"
      :error="actionError"
      @close="pending = null"
      @confirm="run"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import HostedServerDetail from './HostedServerDetail.vue'
import StaffActionDialog from './StaffActionDialog.vue'
import { useT } from '@/composables/useT'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { getServerIconUrl } from '@/utils/serverUtils'
import { debug } from '@/utils/debug'
import {
  listHostedServers,
  staffDeleteServer,
  staffRemoveMember,
  staffRemoveMessage,
  staffSetServerSuspended,
  STAFF_PAGE_SIZE,
  type HostedServer,
} from '@/services/HostedServerStaffService'
import { staffActionCopy, type StaffAction } from './hostedServerStaff'

const PAGE = STAFF_PAGE_SIZE

const { t } = useT()
const toast = useToast()
const instanceSettings = useInstanceSettingsStore()
const instance = computed(() => instanceSettings.settings.domain)
const staffLabel = computed(() => t('hostStaff.staffBadge', { instance: instance.value }))

const servers = ref<HostedServer[]>([])
const total = ref(0)
const offset = ref(0)
const search = ref('')
const suspendedOnly = ref(false)
const loading = ref(false)
const loadError = ref('')
const selected = ref<HostedServer | null>(null)
const refreshKey = ref(0)

const pending = ref<StaffAction | null>(null)
const busy = ref(false)
const actionError = ref('')

const rootEl = ref<HTMLElement | null>(null)
const titleEl = ref<HTMLElement | null>(null)
const detailEl = ref<InstanceType<typeof HostedServerDetail> | null>(null)

function rowAction(actionKey: string, server: string): string {
  return t('hostStaff.rowAction', { action: t(actionKey), target: server })
}

// Open and Back replace the view that holds the focused button: focus moves to the new view's
// heading, and back to the row's Open button.
async function openServer(server: HostedServer) {
  selected.value = server
  await nextTick()
  detailEl.value?.focusHeading()
}

async function closeServer() {
  const id = selected.value?.id
  selected.value = null
  await nextTick()
  focusListAt(id)
}

// A row that is gone (deleted, or off this page) leaves the list heading.
function focusListAt(serverId: string | null | undefined) {
  const open = serverId
    ? rootEl.value?.querySelector<HTMLElement>(`[data-testid="hosted-server-open"][data-server-id="${CSS.escape(serverId)}"]`)
    : null
  ;(open ?? titleEl.value)?.focus()
}

let loadSeq = 0
async function load() {
  const seq = ++loadSeq
  loading.value = true
  loadError.value = ''
  try {
    const result = await listHostedServers({ search: search.value, suspendedOnly: suspendedOnly.value, offset: offset.value })
    if (seq !== loadSeq) return
    servers.value = result.rows
    total.value = result.total
    if (selected.value) {
      selected.value = result.rows.find(s => s.id === selected.value?.id) ?? selected.value
    }
  } catch (error) {
    if (seq !== loadSeq) return
    debug.error('Failed to load hosted servers:', error)
    loadError.value = t('hostStaff.loadError')
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

function page(direction: 1 | -1) {
  offset.value = Math.max(0, offset.value + direction * PAGE)
  void load()
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    offset.value = 0
    void load()
  }, 300)
})
watch(suspendedOnly, () => {
  offset.value = 0
  void load()
})

const dialog = computed(() => pending.value
  ? staffActionCopy(pending.value, instance.value, t)
  : { title: '', consequences: [], record: '', reasonHint: '', confirm: '', done: '' })

function request(action: StaffAction) {
  actionError.value = ''
  pending.value = action
}

async function run(reason: string) {
  const action = pending.value
  if (!action || busy.value) return
  busy.value = true
  actionError.value = ''
  try {
    switch (action.kind) {
      case 'remove':
      case 'ban':
        await staffRemoveMember(action.server.id, action.member.user_id, { ban: action.kind === 'ban', reason })
        break
      case 'message':
        await staffRemoveMessage(action.message.id, reason)
        break
      case 'suspend':
      case 'unsuspend': {
        const result = await staffSetServerSuspended(action.server.id, action.kind === 'suspend', reason)
        if (selected.value?.id === action.server.id) {
          selected.value = { ...selected.value, ...result }
        }
        break
      }
      case 'delete':
        await staffDeleteServer(action.server.id, reason)
        if (selected.value?.id === action.server.id) selected.value = null
        break
    }
    toast.success(dialog.value.done)
    pending.value = null
    refreshKey.value += 1
    window.dispatchEvent(new CustomEvent('admin:activity-changed'))
    const reloaded = load()
    // The deleted server's row, and the button that opened the dialog, are gone.
    if (action.kind === 'delete') {
      void reloaded.then(() => nextTick()).then(() => {
        const active = document.activeElement
        if (!active || active === document.body) focusListAt(null)
      })
    }
  } catch (error) {
    debug.error('Staff action failed:', error)
    actionError.value = t('hostStaff.failed', { error: error instanceof Error ? error.message : String(error) })
  } finally {
    busy.value = false
  }
}

onMounted(() => { void load() })
</script>

<style scoped src="./adminShared.css"></style>
<style scoped>
.staff-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--warning, #f0b232);
  background: color-mix(in srgb, var(--warning, #f0b232) 14%, transparent);
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.module-intro {
  margin: 0;
  padding: 12px 24px 0;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.5;
}

.hosted-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 16px 24px;
}

.hosted-search {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1 1 240px;
}

.hosted-search :deep(svg) {
  position: absolute;
  left: 12px;
  color: var(--text-muted);
  pointer-events: none;
}

.hosted-search .cyber-input {
  padding-left: 36px;
}

/* Focused after a view change, by script only. */
.hosted-title:focus {
  outline: none;
}

.hosted-filters {
  display: flex;
  gap: 8px;
}

.filter-btn {
  padding: 8px 14px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}

.filter-btn.active {
  background: var(--harmony-primary-fill);
  border-color: var(--harmony-primary);
  color: var(--text-on-primary, #fff);
}

.loading-state {
  display: flex;
  justify-content: center;
  padding: 32px;
}

.hosted-error {
  margin: 0;
  padding: 16px 24px;
  color: var(--text-danger);
}

.hosted-list {
  list-style: none;
  margin: 0;
  padding: 0 24px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hosted-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--background-tertiary);
}

.hosted-row.suspended {
  border-color: color-mix(in srgb, var(--warning) 50%, var(--border-color));
}

.hosted-icon {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  object-fit: cover;
  flex-shrink: 0;
}

.hosted-info {
  flex: 1;
  min-width: 0;
}

.hosted-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.hosted-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin-top: 2px;
  font-size: 13px;
  color: var(--text-secondary);
}

.hosted-handle {
  color: var(--text-muted);
}

.hosted-reason {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--text-muted);
}

.hosted-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.staff-warn {
  border-color: color-mix(in srgb, var(--warning) 60%, var(--border-primary));
}

@media (max-width: 640px) {
  .hosted-row {
    flex-wrap: wrap;
  }

  .hosted-actions {
    width: 100%;
    justify-content: flex-start;
  }
}
</style>
