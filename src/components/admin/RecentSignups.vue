<template>
  <div class="admin-module signups-module" data-testid="recent-signups">
    <div class="module-header">
      <Icon name="user-plus" :size="20" />
      <h2 ref="titleEl" tabindex="-1" class="signups-title">{{ t('adminSignups.title') }}</h2>
    </div>
    <p class="module-intro">{{ t('adminSignups.intro') }}</p>
    <p v-if="showLimitsLink" class="module-intro">
      <router-link class="signups-link" :to="{ query: { tab: 'invites' } }" data-testid="signups-limits-link">
        {{ t('adminSignups.limitsLink') }}
      </router-link>
    </p>

    <div class="signups-toolbar">
      <div class="signups-filters" role="group" :aria-label="t('adminSignups.windowLabel')">
        <button
          v-for="option in WINDOWS"
          :key="option"
          type="button"
          :class="['filter-btn', { active: days === option }]"
          :aria-pressed="days === option"
          :data-testid="`signups-window-${option}`"
          @click="days = option"
        >{{ t('adminSignups.window', { count: option }, option) }}</button>
      </div>
      <div class="signups-filters" role="group" :aria-label="t('adminSignups.filters.label')">
        <button
          v-for="option in STATUSES"
          :key="option"
          type="button"
          :class="['filter-btn', { active: status === option }]"
          :aria-pressed="status === option"
          :data-testid="`signups-status-${option}`"
          @click="status = option"
        >{{ t(`adminSignups.filters.${option}`) }}</button>
      </div>
      <div class="signups-search">
        <span class="signups-search-icon"><Icon name="search" :size="16" /></span>
        <input
          v-model="search"
          type="search"
          class="cyber-input"
          :placeholder="t('adminSignups.searchHint')"
          :aria-label="t('adminSignups.searchLabel')"
          data-testid="signups-search"
        />
      </div>
    </div>

    <p v-if="loadError" class="signups-error" role="alert">{{ loadError }}</p>

    <section class="signups-section" :aria-labelledby="`${uid}-groups`">
      <h3 :id="`${uid}-groups`" class="signups-heading">{{ t('adminSignups.groups.title') }}</h3>
      <p v-if="!groups.length" class="signups-muted" data-testid="signup-groups-empty">
        {{ t('adminSignups.groups.empty', { count: SIGNUP_GROUP_MIN_SIZE }) }}
      </p>
      <ul v-else class="group-list">
        <li
          v-for="group in groups"
          :key="`${group.kind}:${group.key}`"
          class="group-card"
          :class="{ active: activeGroupKey === groupKey(group) }"
          data-testid="signup-group"
          :data-group-kind="group.kind"
          :data-group-key="group.key"
        >
          <div class="group-info">
            <div class="group-title">
              <span class="group-label">{{ group.label }}</span>
              <span class="group-kind">
                {{ t(group.kind === 'email_domain' ? 'adminSignups.groups.kindDomain' : 'adminSignups.groups.kindServer') }}
              </span>
            </div>
            <div class="group-meta">
              <strong>{{ t('adminSignups.groups.size', { count: group.size }, group.size) }}</strong>
              <span>
                {{ t(group.kind === 'email_domain' ? 'adminSignups.groups.priorDomain' : 'adminSignups.groups.priorServer',
                     { count: group.prior_count }, group.prior_count) }}
              </span>
              <span v-if="group.suspended > 0">{{ t('adminSignups.groups.suspended', { count: group.suspended }) }}</span>
              <span>{{ t('adminSignups.groups.span', { from: formatMoment(group.first_at), to: formatMoment(group.last_at) }) }}</span>
            </div>
          </div>
          <div class="group-actions">
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              :aria-pressed="activeGroupKey === groupKey(group)"
              :aria-label="t('adminSignups.groups.showLabel', { label: group.label })"
              data-testid="signup-group-show"
              @click="toggleGroup(group)"
            >{{ t('adminSignups.groups.show') }}</button>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              :aria-label="t('adminSignups.groups.selectLabel', { label: group.label })"
              data-testid="signup-group-select"
              @click="selectGroup(group)"
            >{{ t('adminSignups.groups.select') }}</button>
          </div>
        </li>
      </ul>
    </section>

    <section class="signups-section" :aria-labelledby="`${uid}-accounts`">
      <h3 :id="`${uid}-accounts`" class="signups-heading">
        {{ t('adminSignups.rows.title', { count: total }, total) }}
      </h3>
      <p v-if="activeGroup" class="group-filter" data-testid="signup-group-filter">
        <span>{{ t('adminSignups.groups.filterActive', { label: activeGroup.label }) }}</span>
        <button type="button" class="btn btn-secondary btn-sm" @click="activeGroup = null">
          {{ t('adminSignups.groups.clear') }}
        </button>
      </p>

      <div v-if="loading && rows.length === 0" class="loading-state"><LoadingSpinner :size="20" /></div>
      <EmptyState
        v-else-if="rows.length === 0"
        size="sm"
        icon="users"
        :title="search || status !== 'all' || activeGroup ? t('adminSignups.rows.emptySearch') : t('adminSignups.rows.empty')"
      />
      <ul v-else class="signup-list">
        <li
          v-for="row in rows"
          :key="row.id"
          class="signup-row"
          :class="{ suspended: row.is_suspended }"
          data-testid="signup-row"
          :data-username="row.username"
        >
          <input
            type="checkbox"
            class="signup-check"
            :checked="selected.has(row.id)"
            :disabled="row.is_staff || (!selected.has(row.id) && selected.size >= BULK_LIMIT)"
            :aria-label="t('adminSignups.rows.selectAccount', { name: row.username })"
            data-testid="signup-select"
            @change="toggle(row.id)"
          />
          <Avatar :src="row.avatar_url" :alt="row.display_name || row.username" size="sm" />
          <div class="signup-info">
            <div class="signup-name">
              <span class="signup-display">{{ row.display_name || row.username }}</span>
              <span class="signup-handle">@{{ row.username }}</span>
              <span v-if="row.is_staff" class="badge admin">{{ t('adminSignups.rows.staff') }}</span>
              <span v-if="row.is_suspended" class="badge suspended">{{ t('adminSignups.rows.suspended') }}</span>
              <span v-if="!row.email_confirmed" class="badge inactive">{{ t('adminSignups.rows.unconfirmed') }}</span>
              <CopyIdButton :id="row.id" kind="user" :target="`@${row.username}`" />
            </div>
            <div class="signup-meta">
              <span>{{ t('adminSignups.rows.signedUp', { time: formatMoment(row.signed_up_at) }) }}</span>
              <span data-testid="signup-domain">{{ row.email_domain ?? t('adminSignups.rows.noEmail') }}</span>
              <span>{{ t('adminSignups.rows.posts', { count: row.post_count }, row.post_count) }}</span>
              <span>{{ t('adminSignups.rows.messages', { count: row.message_count }, row.message_count) }}</span>
              <span>{{ t('adminSignups.rows.servers', { count: row.server_count }, row.server_count) }}</span>
              <span v-if="row.owned_server_count > 0">{{ t('adminSignups.rows.owns', { count: row.owned_server_count }, row.owned_server_count) }}</span>
              <span v-if="row.first_server_name">
                {{ t('adminSignups.rows.firstServer', { server: row.first_server_name, minutes: Math.round((row.first_server_after_seconds ?? 0) / 60) }) }}
              </span>
            </div>
            <p v-if="row.is_suspended && row.suspension_reason" class="signup-reason">{{ row.suspension_reason }}</p>
          </div>
        </li>
      </ul>

      <div v-if="total > SIGNUPS_PAGE_SIZE" class="pagination">
        <button class="pagination-btn" :disabled="offset === 0" @click="page(-1)">{{ t('adminSignups.previous') }}</button>
        <span class="pagination-info">{{ offset + 1 }}–{{ Math.min(offset + SIGNUPS_PAGE_SIZE, total) }} / {{ total }}</span>
        <button class="pagination-btn" :disabled="offset + SIGNUPS_PAGE_SIZE >= total" @click="page(1)">{{ t('adminSignups.next') }}</button>
      </div>
    </section>

    <section class="signups-section" :aria-labelledby="`${uid}-daily`">
      <h3 :id="`${uid}-daily`" class="signups-heading">{{ t('adminSignups.daily.title') }}</h3>
      <div class="daily-scroll" tabindex="0" :aria-labelledby="`${uid}-daily`">
        <table class="daily-table" data-testid="signup-daily">
          <thead>
            <tr>
              <th scope="col">{{ t('adminSignups.daily.day') }}</th>
              <th scope="col">{{ t('adminSignups.daily.signups') }}</th>
              <th scope="col">{{ t('adminSignups.daily.domains') }}</th>
              <th scope="col">{{ t('adminSignups.daily.topDomain') }}</th>
              <th scope="col">{{ t('adminSignups.daily.peakHour') }}</th>
              <th scope="col">{{ t('adminSignups.daily.suspended') }}</th>
              <th scope="col">{{ t('adminSignups.daily.refused') }}</th>
              <th scope="col">{{ t('adminSignups.daily.wouldRefuse') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in dailyRows" :key="d.day">
              <th scope="row">{{ d.day }}</th>
              <td>{{ d.signups }}</td>
              <td>{{ d.email_domains }}</td>
              <td>{{ d.top_domain_count }}</td>
              <td>{{ d.peak_hour_count }}</td>
              <td>{{ d.suspended }}</td>
              <td>{{ d.refused }}</td>
              <td>{{ d.would_refuse }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <div v-if="selected.size > 0" class="selection-bar" data-testid="signup-selection">
      <span role="status">{{ t('adminSignups.selection.count', { count: selected.size }) }}</span>
      <span v-if="selectionCapped" class="signups-muted">{{ t('adminSignups.selection.limit', { count: BULK_LIMIT }) }}</span>
      <div class="selection-actions">
        <button type="button" class="btn btn-danger btn-sm" data-testid="signup-bulk-suspend" @click="openDialog(true)">
          {{ t('adminSignups.selection.suspend') }}
        </button>
        <button type="button" class="btn btn-secondary btn-sm" data-testid="signup-bulk-unsuspend" @click="openDialog(false)">
          {{ t('adminSignups.selection.unsuspend') }}
        </button>
        <button type="button" class="btn btn-secondary btn-sm" data-testid="signup-selection-clear" @click="clearSelection">
          {{ t('adminSignups.selection.clear') }}
        </button>
      </div>
    </div>

    <BulkSuspendDialog
      v-if="dialogOpen"
      :show="dialogOpen"
      :ids="[...selected]"
      :suspending="dialogSuspending"
      @close="dialogOpen = false"
      @done="onBulkDone"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import { useToast } from 'vue-toastification'
import Avatar from '@/components/common/Avatar.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import BulkSuspendDialog from './BulkSuspendDialog.vue'
import CopyIdButton from './CopyIdButton.vue'
import { useT } from '@/composables/useT'
import { hasCapability } from '@/services/instanceCapabilities'
import { useProfileStore } from '@/stores/useProfile'
import { debug } from '@/utils/debug'
import {
  BULK_LIMIT,
  listRecentSignups,
  listSignupDays,
  listSignupGroups,
  SIGNUP_GROUP_MIN_SIZE,
  SIGNUPS_PAGE_SIZE,
  type BulkResult,
  type RecentSignup,
  type SignupDay,
  type SignupGroup,
  type SignupStatus,
} from '@/services/SignupReviewService'

const WINDOWS = [1, 7, 30] as const
const STATUSES: readonly SignupStatus[] = ['all', 'active', 'suspended']

const { t } = useT()
const toast = useToast()
const uid = `recent-signups-${useId()}`
const profileStore = useProfileStore()
// Moderators have no Invites tab.
const showLimitsLink = computed(() => profileStore.profile?.is_admin === true && hasCapability('instance-invites'))

const days = ref<number>(7)
const status = ref<SignupStatus>('all')
const search = ref('')
const offset = ref(0)
const activeGroup = ref<SignupGroup | null>(null)

const rows = ref<RecentSignup[]>([])
const total = ref(0)
const groups = ref<SignupGroup[]>([])
const daily = ref<SignupDay[]>([])
const loading = ref(false)
const loadError = ref('')

const titleEl = ref<HTMLElement | null>(null)

const selected = ref(new Set<string>())
const selectionCapped = ref(false)
const dialogOpen = ref(false)
const dialogSuspending = ref(true)

const groupKey = (group: SignupGroup) => `${group.kind}:${group.key}`
const activeGroupKey = computed(() => (activeGroup.value ? groupKey(activeGroup.value) : null))
// Days with no signups and no refusals add nothing to a month's table; the current day always shows.
const dailyRows = computed(() => daily.value.filter((d, i) => i === 0 || d.signups > 0 || d.refused > 0 || d.would_refuse > 0))

function formatMoment(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}

let rowSeq = 0
async function loadRows() {
  const seq = ++rowSeq
  loading.value = true
  loadError.value = ''
  try {
    const result = await listRecentSignups({
      days: days.value,
      search: search.value,
      status: status.value,
      profileIds: activeGroup.value?.member_ids ?? null,
      offset: offset.value,
    })
    if (seq !== rowSeq) return
    // A page past the end, after a bulk action emptied it, reports no total: go back to the first.
    if (result.rows.length === 0 && offset.value > 0) {
      offset.value = 0
      void loadRows()
      return
    }
    rows.value = result.rows
    total.value = result.total
  } catch (error) {
    if (seq !== rowSeq) return
    debug.error('Failed to load signups:', error)
    loadError.value = t('adminSignups.loadError')
  } finally {
    if (seq === rowSeq) loading.value = false
  }
}

let summarySeq = 0
async function loadSummary() {
  const seq = ++summarySeq
  try {
    const [nextGroups, nextDaily] = await Promise.all([listSignupGroups(days.value), listSignupDays(days.value)])
    if (seq !== summarySeq) return
    groups.value = nextGroups
    daily.value = nextDaily
    if (activeGroup.value) {
      activeGroup.value = nextGroups.find((g) => groupKey(g) === activeGroupKey.value) ?? null
    }
  } catch (error) {
    if (seq !== summarySeq) return
    debug.error('Failed to load signup groups:', error)
    loadError.value = t('adminSignups.loadError')
  }
}

function reloadAll() {
  void loadSummary()
  void loadRows()
}

function page(direction: 1 | -1) {
  offset.value = Math.max(0, offset.value + direction * SIGNUPS_PAGE_SIZE)
  void loadRows()
}

function toggleGroup(group: SignupGroup) {
  activeGroup.value = activeGroupKey.value === groupKey(group) ? null : group
}

function toggle(id: string) {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else if (next.size < BULK_LIMIT) next.add(id)
  selected.value = next
  selectionCapped.value = false
}

function selectGroup(group: SignupGroup) {
  const next = new Set(selected.value)
  for (const id of group.member_ids) {
    if (next.size >= BULK_LIMIT) break
    next.add(id)
  }
  selected.value = next
  selectionCapped.value = group.member_ids.some((id) => !next.has(id))
}

function clearSelection() {
  selected.value = new Set()
  selectionCapped.value = false
}

function openDialog(suspending: boolean) {
  dialogSuspending.value = suspending
  dialogOpen.value = true
}

function onBulkDone(result: BulkResult) {
  dialogOpen.value = false
  const changed = result.changed.length
  toast.success(t(result.suspended ? 'adminSignups.done.suspended' : 'adminSignups.done.unsuspended', { count: changed }, changed))
  clearSelection()
  window.dispatchEvent(new CustomEvent('admin:activity-changed'))
  window.dispatchEvent(new CustomEvent('admin:users-changed'))
  reloadAll()
  // The selection bar that opened the dialog is gone.
  void nextTick(() => {
    const active = document.activeElement
    if (!active || active === document.body) titleEl.value?.focus()
  })
}

watch(days, () => {
  offset.value = 0
  reloadAll()
})
watch([status, activeGroup], () => {
  offset.value = 0
  void loadRows()
})
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    offset.value = 0
    void loadRows()
  }, 300)
})

onMounted(reloadAll)
onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer)
})
</script>

<style scoped src="./adminShared.css"></style>
<style scoped>
.module-intro {
  margin: 0;
  padding: 12px 24px 0;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.5;
}

.signups-title:focus {
  outline: none;
}

.signups-link {
  color: var(--text-link);
  text-decoration: underline;
}

.signups-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 16px 24px 0;
}

.signups-filters {
  display: flex;
  flex-wrap: wrap;
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

.signups-search {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1 1 220px;
}

.signups-search-icon {
  position: absolute;
  left: 12px;
  display: flex;
  color: var(--text-muted);
  pointer-events: none;
}

.signups-search .cyber-input {
  padding-left: 36px;
}

.signups-section {
  padding: 16px 24px 0;
}

.signups-section:last-of-type {
  padding-bottom: 24px;
}

.signups-heading {
  margin: 0 0 10px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.signups-muted {
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
}

.signups-error {
  margin: 0;
  padding: 16px 24px 0;
  color: var(--text-danger);
}

.group-list,
.signup-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.group-card {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}

.group-card.active {
  border-color: var(--harmony-primary);
}

.group-info {
  flex: 1 1 260px;
  min-width: 0;
}

.group-title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}

.group-label {
  font-weight: 600;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.group-kind {
  color: var(--text-secondary);
  font-size: 12px;
}

.group-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  color: var(--text-secondary);
  font-size: 13px;
}

.group-meta strong {
  color: var(--text-primary);
}

.group-actions,
.selection-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.group-filter {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0 0 10px;
  color: var(--text-primary);
  font-size: 14px;
}

.signup-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}

.signup-row.suspended {
  border-color: color-mix(in srgb, var(--warning) 40%, var(--border-color));
}

.signup-check {
  flex: none;
  width: 18px;
  height: 18px;
  margin: 8px 0 0;
  accent-color: var(--harmony-primary);
}

.signup-info {
  flex: 1;
  min-width: 0;
}

.signup-name {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  margin-bottom: 4px;
}

.signup-display {
  font-weight: 600;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.signup-handle {
  color: var(--text-secondary);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.signup-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 12px;
  color: var(--text-secondary);
  font-size: 13px;
}

.signup-reason {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: 13px;
  font-style: italic;
  overflow-wrap: anywhere;
}

.loading-state {
  display: flex;
  justify-content: center;
  padding: 24px;
}

.daily-scroll {
  overflow-x: auto;
}

.daily-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  color: var(--text-primary);
}

.daily-table th,
.daily-table td {
  padding: 6px 12px;
  text-align: right;
  white-space: nowrap;
  border-bottom: 1px solid var(--border-color);
}

.daily-table thead th {
  color: var(--text-secondary);
  font-weight: 500;
}

.daily-table th:first-child {
  text-align: left;
  font-weight: 500;
}

.selection-bar {
  position: sticky;
  bottom: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 12px 24px;
  background: var(--background-secondary);
  border-top: 1px solid var(--border-color);
  color: var(--text-primary);
  font-size: 14px;
}

.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding-top: 12px;
}

@media (max-width: 480px) {
  .signups-toolbar,
  .signups-section,
  .selection-bar {
    padding-left: 16px;
    padding-right: 16px;
  }

  .module-intro {
    padding-left: 16px;
    padding-right: 16px;
  }
}
</style>
