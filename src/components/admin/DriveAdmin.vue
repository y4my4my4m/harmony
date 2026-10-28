<!-- Instance Drive settings: quotas by role, temporary uploads, link sharing; usage per account
     with quota overrides; blocked file hashes. -->
<template>
  <div class="drive-admin" data-testid="drive-admin">
    <section class="drive-admin__card">
      <header class="drive-admin__head">
        <Icon name="hard-drive" :size="18" />
        <h2>{{ t('driveAdmin.settings') }}</h2>
      </header>
      <form class="drive-admin__grid" @submit.prevent="save">
        <label>
          <span>{{ t('driveAdmin.quotaUser') }}</span>
          <span class="drive-admin__unit"><input v-model.number="form.drive_quota_user_mb" type="number" min="0" step="1" class="drive-input" data-testid="drive-admin-quota-user" /> MB</span>
        </label>
        <label>
          <span>{{ t('driveAdmin.quotaModerator') }}</span>
          <span class="drive-admin__unit"><input v-model.number="form.drive_quota_moderator_mb" type="number" min="0" step="1" class="drive-input" /> MB</span>
        </label>
        <label>
          <span>{{ t('driveAdmin.quotaAdmin') }}</span>
          <span class="drive-admin__unit"><input v-model.number="form.drive_quota_admin_mb" type="number" min="0" step="1" class="drive-input" /> MB</span>
        </label>
        <label>
          <span>{{ t('driveAdmin.ephemeralDays') }}</span>
          <span class="drive-admin__unit"><input v-model.number="form.drive_ephemeral_days" type="number" min="1" max="365" step="1" class="drive-input" /> {{ t('driveAdmin.days') }}</span>
        </label>
        <label>
          <span>{{ t('driveAdmin.ephemeralDaily') }}</span>
          <span class="drive-admin__unit"><input v-model.number="form.drive_ephemeral_daily_mb" type="number" min="0" step="1" class="drive-input" /> MB</span>
        </label>
        <div class="drive-admin__toggle">
          <span :id="`${uid}-links`">{{ t('driveAdmin.linkSharing') }}</span>
          <ToggleSwitch v-model="form.drive_link_sharing" :labelledby="`${uid}-links`" />
        </div>
        <p class="drive-admin__hint">{{ t('driveAdmin.hint') }}</p>
        <div class="drive-admin__actions">
          <span v-if="saved" class="drive-admin__saved" role="status">{{ t('driveAdmin.saved') }}</span>
          <button type="submit" class="drive-btn drive-btn--primary" :disabled="saving" data-testid="drive-admin-save">{{ t('driveAdmin.save') }}</button>
        </div>
      </form>
    </section>

    <section class="drive-admin__card" data-testid="drive-admin-usage">
      <header class="drive-admin__head">
        <Icon name="users" :size="18" />
        <h2 :id="`${uid}-usage`">{{ t('driveAdmin.usage') }}</h2>
      </header>
      <input
        v-model="search"
        type="search"
        class="drive-input drive-admin__search"
        :placeholder="t('driveAdmin.searchHint')"
        :aria-label="t('driveAdmin.searchLabel')"
        data-testid="drive-admin-search"
      />
      <div v-if="usageLoading && usage.length === 0" class="drive-admin__loading" role="status">
        <LoadingSpinner :size="20" />
        <span class="sr-only">{{ t('driveAdmin.loading') }}</span>
      </div>
      <div v-else-if="usage.length" class="drive-admin__scroll">
        <table class="drive-admin__table" :aria-labelledby="`${uid}-usage`" :aria-busy="usageLoading || undefined">
          <thead>
            <tr>
              <th scope="col">{{ t('driveAdmin.account') }}</th>
              <th scope="col">{{ t('driveAdmin.used') }}</th>
              <th scope="col">{{ t('driveAdmin.temporary') }}</th>
              <th scope="col">{{ t('driveAdmin.quota') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in usage" :key="row.profile_id" data-testid="drive-admin-usage-row" :data-profile-id="row.profile_id">
              <td>
                <span class="drive-admin__account">
                  <DisplayName class="drive-admin__name" :user-id="row.profile_id" :fallback="row.display_name || row.username" truncate />
                  <span class="drive-admin__handle">@{{ row.username }}</span>
                  <CopyIdButton :id="row.profile_id" kind="user" :target="`@${row.username}`" />
                </span>
              </td>
              <td>
                <span class="drive-admin__bar"><span :style="{ transform: `scaleX(${Math.min(1, row.quota_bytes ? row.used_bytes / row.quota_bytes : 0)})` }" /></span>
                {{ formatBytes(row.used_bytes) }}
              </td>
              <td>{{ formatBytes(row.ephemeral_bytes) }}</td>
              <td>
                <span class="drive-admin__unit">
                  <input
                    :value="row.quota_override === null ? '' : Math.round(row.quota_override / 1048576)"
                    type="number"
                    min="0"
                    class="drive-input drive-admin__override"
                    :placeholder="String(Math.round(row.quota_bytes / 1048576))"
                    :aria-label="t('driveAdmin.override', { name: row.username })"
                    @change="setOverride(row.profile_id, ($event.target as HTMLInputElement).value)"
                  /> MB
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="drive-admin__muted" data-testid="drive-admin-usage-empty">{{ searchTerm ? t('driveAdmin.noMatch') : t('driveAdmin.noUsage') }}</p>
      <nav v-if="usageTotal > USAGE_PAGE" class="drive-admin__pager" :aria-label="t('driveAdmin.pages')">
        <button
          type="button"
          class="drive-btn drive-btn--ghost"
          data-testid="drive-admin-prev"
          :disabled="usageOffset === 0 || usageLoading"
          @click="goToPage(usageOffset - USAGE_PAGE)"
        >{{ t('driveAdmin.previous') }}</button>
        <span class="drive-admin__range" role="status" data-testid="drive-admin-range">
          {{ t('driveAdmin.range', { from: usageOffset + 1, to: Math.min(usageOffset + USAGE_PAGE, usageTotal), total: usageTotal }) }}
        </span>
        <button
          type="button"
          class="drive-btn drive-btn--ghost"
          data-testid="drive-admin-next"
          :disabled="usageOffset + USAGE_PAGE >= usageTotal || usageLoading"
          @click="goToPage(usageOffset + USAGE_PAGE)"
        >{{ t('driveAdmin.next') }}</button>
      </nav>
    </section>

    <section class="drive-admin__card">
      <header class="drive-admin__head">
        <Icon name="shield" :size="18" />
        <h2>{{ t('driveAdmin.blocked') }}</h2>
      </header>
      <ul v-if="blocked.length" class="drive-admin__blocked">
        <li v-for="row in blocked" :key="row.sha256">
          <code>{{ row.sha256.slice(0, 16) }}…</code>
          <span>{{ row.reason || '—' }}</span>
          <button type="button" class="drive-btn drive-btn--ghost" @click="unblock(row.sha256)">{{ t('driveAdmin.unblock') }}</button>
        </li>
      </ul>
      <p v-else class="drive-admin__muted">{{ t('driveAdmin.noBlocked') }}</p>
    </section>
    <p v-if="error" class="drive-admin__error" role="alert">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, useId, watch } from 'vue'
import DisplayName from '@/components/DisplayName.vue'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { userDataService } from '@/services/userDataService'
import { supabase } from '@/supabase'
import CopyIdButton from './CopyIdButton.vue'
import { useT } from '@/composables/useT'
import { formatBytes } from '@/components/drive/driveFormat'
import '@/components/drive/drive.css'

const KEYS = ['drive_quota_user_mb', 'drive_quota_moderator_mb', 'drive_quota_admin_mb', 'drive_ephemeral_days', 'drive_ephemeral_daily_mb', 'drive_link_sharing'] as const

const { t } = useT()
const uid = useId()
const form = reactive({
  drive_quota_user_mb: 1024,
  drive_quota_moderator_mb: 25600,
  drive_quota_admin_mb: 102400,
  drive_ephemeral_days: 30,
  drive_ephemeral_daily_mb: 2048,
  drive_link_sharing: true,
})
/** Row of admin_drive_usage; bigint columns arrive as numbers. */
interface UsageRow {
  profile_id: string
  username: string
  display_name: string | null
  used_bytes: number
  quota_bytes: number
  ephemeral_bytes: number
  quota_override: number | null
  total_count: number
}

const USAGE_PAGE = 50
const SEARCH_DEBOUNCE_MS = 300

const usage = ref<UsageRow[]>([])
const usageTotal = ref(0)
const usageOffset = ref(0)
const usageLoading = ref(false)
const search = ref('')
const searchTerm = computed(() => search.value.trim())
const blocked = ref<Array<{ sha256: string; reason: string | null }>>([])
const saving = ref(false)
const saved = ref(false)
const error = ref<string | null>(null)

async function load(): Promise<void> {
  const { data } = await supabase.from('instance_config').select('config_key, config_value').in('config_key', [...KEYS])
  for (const row of data ?? []) {
    const key = row.config_key as typeof KEYS[number]
    const value = row.config_value
    if (key === 'drive_link_sharing') form.drive_link_sharing = value !== false && value !== 'false'
    else if (Number.isFinite(Number(value))) (form as Record<string, number | boolean>)[key] = Number(value)
  }
  const [b] = await Promise.all([
    supabase.from('drive_blocked_hashes').select('sha256, reason').order('created_at', { ascending: false }),
    loadUsage(),
  ])
  blocked.value = b.data ?? []
}

let usageSeq = 0

async function loadUsage(): Promise<void> {
  const seq = ++usageSeq
  usageLoading.value = true
  try {
    const { data, error: e } = await supabase.rpc('admin_drive_usage', {
      p_search: searchTerm.value || null,
      p_limit: USAGE_PAGE,
      p_offset: usageOffset.value,
    })
    if (seq !== usageSeq) return
    if (e) throw e
    const rows = (data as UsageRow[] | null) ?? []
    // A shrinking match set can leave the offset past the end; step back to the last page.
    if (rows.length === 0 && usageOffset.value > 0) {
      usageOffset.value = Math.max(0, usageOffset.value - USAGE_PAGE)
      return loadUsage()
    }
    usage.value = rows
    usageTotal.value = rows.length ? Number(rows[0].total_count) : 0
    if (rows.length) void userDataService.ensureUsersLoaded(rows.map((r) => r.profile_id)).catch(() => {})
  } catch (e) {
    if (seq !== usageSeq) return
    error.value = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e)
  } finally {
    if (seq === usageSeq) usageLoading.value = false
  }
}

function goToPage(offset: number): void {
  usageOffset.value = Math.max(0, offset)
  void loadUsage()
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => goToPage(0), SEARCH_DEBOUNCE_MS)
})
onUnmounted(() => { if (searchTimer) clearTimeout(searchTimer) })

async function save(): Promise<void> {
  saving.value = true
  saved.value = false
  error.value = null
  try {
    const { error: e } = await supabase.rpc('batch_set_instance_config', {
      p_keys: [...KEYS],
      p_values: KEYS.map((k) => form[k]),
    })
    if (e) throw e
    saved.value = true
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e)
  } finally {
    saving.value = false
  }
}

async function setOverride(profileId: string, raw: string): Promise<void> {
  const mb = raw.trim() === '' ? null : Math.max(0, Math.round(Number(raw)))
  const { error: e } = await supabase.rpc('admin_set_drive_quota', {
    p_profile: profileId,
    p_quota_bytes: mb === null ? null : mb * 1048576,
  })
  if (e) error.value = e.message
  await loadUsage()
}

async function unblock(sha256: string): Promise<void> {
  const { error: e } = await supabase.rpc('admin_drive_unblock_hash', { p_sha256: sha256 })
  if (e) error.value = e.message
  await load()
}

onMounted(() => { void load().catch((e) => { error.value = String(e) }) })
</script>

<style scoped>
.drive-admin {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.drive-admin__card {
  padding: var(--space-4) var(--space-5);
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
}

.drive-admin__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
  color: var(--text-primary);
}

.drive-admin__head h2 {
  margin: 0;
  font-size: var(--font-size-md, 15px);
}

.drive-admin__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: var(--space-3) var(--space-5);
}

.drive-admin__grid label,
.drive-admin__toggle {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.drive-admin__toggle {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}

.drive-admin__unit {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-sm);
  color: var(--text-muted);
}

.drive-admin__hint,
.drive-admin__muted {
  grid-column: 1 / -1;
  margin: 0;
  font-size: var(--font-size-xs);
  line-height: var(--line-height-normal);
  color: var(--text-muted);
}

.drive-admin__actions {
  display: flex;
  grid-column: 1 / -1;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
}

.drive-admin__saved {
  font-size: var(--font-size-sm);
  color: var(--text-success, #3ba55c);
}

.drive-admin__table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-size-sm);
}

.drive-admin__table th {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-color);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--text-muted);
  text-align: left;
}

.drive-admin__table td {
  padding: 6px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 50%, transparent);
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.drive-admin__handle {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.drive-admin__search {
  width: 100%;
  max-width: 320px;
  margin-bottom: var(--space-3);
}

.drive-admin__loading {
  display: flex;
  justify-content: center;
  padding: var(--space-5) 0;
}

.drive-admin__scroll {
  overflow-x: auto;
}

.drive-admin__account {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 340px;
}

.drive-admin__name {
  min-width: 0;
}

.drive-admin__pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.drive-admin__range {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.drive-admin__bar {
  display: inline-block;
  width: 60px;
  height: 5px;
  margin-right: 6px;
  overflow: hidden;
  background: var(--background-modifier-active);
  border-radius: var(--radius-full);
  vertical-align: middle;
}

.drive-admin__bar span {
  display: block;
  height: 100%;
  background: var(--harmony-primary);
  transform-origin: left center;
}

.drive-admin__override {
  width: 100px;
  min-height: 30px;
}

.drive-admin__blocked {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.drive-admin__blocked li {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.drive-admin__blocked span {
  flex: 1;
}

.drive-admin__error {
  margin: 0;
  color: var(--danger);
}
</style>
