<template>
  <div class="antispam-admin">
    <!-- Settings -->
    <div class="admin-module">
      <div class="module-header">
        <Icon name="shield" :size="20" />
        <h2>{{ $t('admin.antiSpam.title') }}</h2>
        <div class="module-actions">
          <button class="primary-btn-sm" :disabled="saving || !dirty || !draft" @click="save">
            <Icon v-if="saving" name="loader" :size="14" class="spin" />
            {{ $t('common.save') }}
          </button>
        </div>
      </div>
      <div class="module-body">
        <p class="module-hint">{{ $t('admin.antiSpam.hint') }}</p>

        <div v-if="!draft" class="loading-state"><LoadingSpinner :size="20" /><span>{{ $t('admin.antiSpam.loadingSettings') }}</span></div>
        <template v-else>
          <h3 class="group-title">{{ $t('admin.antiSpam.newAccounts.title') }}</h3>
          <div class="settings-grid">
            <label class="setting">
              <span class="setting-label">{{ $t('admin.antiSpam.newAccounts.hours') }}</span>
              <input v-model.number="draft.new_account_hours" type="number" min="1" max="8760" class="cyber-input" />
            </label>
            <label class="setting">
              <span class="setting-label">{{ $t('admin.antiSpam.newAccounts.messagesPerMinute') }}</span>
              <input v-model.number="draft.new_account_messages_per_minute" type="number" min="0" max="600" class="cyber-input" />
              <span class="setting-hint">{{ $t('admin.antiSpam.newAccounts.messagesPerMinuteHint') }}</span>
            </label>
            <label class="setting">
              <span class="setting-label">{{ $t('admin.antiSpam.newAccounts.postsPerHour') }}</span>
              <input v-model.number="draft.new_account_posts_per_hour" type="number" min="0" max="1000" class="cyber-input" />
            </label>
            <label class="setting">
              <span class="setting-label">{{ $t('admin.antiSpam.newAccounts.strangerMentions') }}</span>
              <input v-model.number="draft.new_account_max_stranger_mentions" type="number" min="0" max="100" class="cyber-input" />
              <span class="setting-hint">{{ $t('admin.antiSpam.newAccounts.strangerMentionsHint') }}</span>
            </label>
          </div>
          <label class="check-setting">
            <input v-model="draft.new_account_block_links" type="checkbox" />
            <span>{{ $t('admin.antiSpam.newAccounts.blockLinks') }}</span>
          </label>
          <p class="setting-hint">{{ $t('admin.antiSpam.newAccounts.staffExempt') }}</p>

          <h3 class="group-title">{{ $t('admin.antiSpam.federation.title') }}</h3>
          <div class="settings-grid">
            <label class="setting">
              <span class="setting-label">{{ $t('admin.antiSpam.federation.mode') }}</span>
              <select v-model="draft.federation_spam_mode" class="cyber-select">
                <option value="off">{{ $t('admin.antiSpam.federation.modes.off') }}</option>
                <option value="flag">{{ $t('admin.antiSpam.federation.modes.flag') }}</option>
                <option value="hold">{{ $t('admin.antiSpam.federation.modes.hold') }}</option>
                <option value="reject">{{ $t('admin.antiSpam.federation.modes.reject') }}</option>
              </select>
            </label>
            <label class="setting">
              <span class="setting-label">{{ $t('admin.antiSpam.federation.maxMentions') }}</span>
              <input v-model.number="draft.federation_max_mentions" type="number" min="2" max="500" class="cyber-input" />
            </label>
            <label class="setting">
              <span class="setting-label">{{ $t('admin.antiSpam.federation.newActorDays') }}</span>
              <input v-model.number="draft.federation_new_actor_days" type="number" min="0" max="365" class="cyber-input" />
            </label>
          </div>
          <p class="setting-hint">{{ $t('admin.antiSpam.federation.heuristicHint') }}</p>
        </template>
      </div>
    </div>

    <!-- Review queue -->
    <div class="admin-module">
      <div class="module-header">
        <Icon name="flag" :size="20" />
        <h2>{{ $t('admin.antiSpam.queue.title') }}</h2>
        <div class="module-actions">
          <select v-model="statusFilter" class="cyber-select compact" :aria-label="$t('admin.antiSpam.queue.filterByStatus')">
            <option value="open">{{ $t('admin.antiSpam.queue.statuses.open') }}</option>
            <option value="all">{{ $t('admin.antiSpam.queue.statuses.all') }}</option>
            <option value="released">{{ $t('admin.antiSpam.queue.statuses.released') }}</option>
            <option value="confirmed">{{ $t('admin.antiSpam.queue.statuses.confirmed') }}</option>
            <option value="dismissed">{{ $t('admin.antiSpam.queue.statuses.dismissed') }}</option>
          </select>
          <button class="action-btn" :disabled="queueLoading" @click="loadQueue">
            <Icon :name="queueLoading ? 'loader' : 'refresh-cw'" :size="16" :class="{ spin: queueLoading }" />
            {{ $t('admin.antiSpam.queue.refresh') }}
          </button>
        </div>
      </div>
      <div class="module-body">
        <p class="module-hint">{{ $t('admin.antiSpam.queue.hint') }}</p>

        <div v-if="queueLoading && items.length === 0" class="loading-state"><LoadingSpinner :size="20" /></div>
        <div v-else-if="items.length === 0" class="empty-state">{{ $t('admin.antiSpam.queue.empty') }}</div>
        <ul v-else class="queue-list">
          <li v-for="item in items" :key="item.id" class="queue-item">
            <div class="queue-head">
              <span class="queue-actor">{{ item.actor_display_name || item.actor_username || item.actor_uri }}</span>
              <span class="queue-domain">{{ item.actor_domain }}</span>
              <span class="badge" :class="item.action">{{ actionLabel(item.action) }}</span>
              <span class="badge kind">{{ item.kind === 'federation_dm' ? $t('admin.antiSpam.queue.kindDm') : $t('admin.antiSpam.queue.kindMention') }}</span>
              <span v-if="item.status !== 'open'" class="badge status">{{ statusLabel(item.status) }}</span>
              <span class="queue-time">{{ formatTime(item.created_at) }}</span>
            </div>
            <div class="queue-reasons">
              <span v-for="r in item.reasons" :key="r" class="reason">{{ reasonLabel(r) }}</span>
              <span v-if="item.targets.length" class="queue-targets">{{ $t('admin.antiSpam.queue.targets', { users: item.targets.map(u => '@' + u.username).join(', ') }) }}</span>
            </div>
            <div v-if="item.summary" class="queue-summary">{{ item.summary }}</div>
            <div v-if="item.status === 'open'" class="queue-actions">
              <button
                v-if="item.action === 'held' && item.has_activity"
                class="primary-btn-sm"
                :disabled="reviewing.has(item.id)"
                @click="review(item, 'release')"
              >{{ $t('admin.antiSpam.queue.release') }}</button>
              <button class="action-btn" :disabled="reviewing.has(item.id)" @click="review(item, 'confirm')">{{ $t('admin.antiSpam.queue.confirmSpam') }}</button>
              <button class="action-btn" :disabled="reviewing.has(item.id)" @click="review(item, 'dismiss')">{{ $t('admin.antiSpam.queue.dismiss') }}</button>
            </div>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { debug } from '@/utils/debug'
import {
  cleanDbMessage,
  getInstanceAntiSpamSettings,
  getSuspiciousActivity,
  reviewSuspiciousActivity,
  updateInstanceAntiSpamSettings,
  type InstanceAntiSpamSettings,
  type SuspiciousActivity,
} from '@/services/AutoModService'

const { t } = useI18n()
const toast = useToast()

const saved = ref<InstanceAntiSpamSettings | null>(null)
const draft = ref<InstanceAntiSpamSettings | null>(null)
const saving = ref(false)
const dirty = computed(() => JSON.stringify(saved.value) !== JSON.stringify(draft.value))

const items = ref<SuspiciousActivity[]>([])
const queueLoading = ref(false)
const statusFilter = ref<'open' | 'all' | SuspiciousActivity['status']>('open')
const reviewing = ref(new Set<string>())

const REASONS = new Set(['mass_mention', 'new_actor', 'no_followers', 'no_relationship', 'unknown_age'])
const ACTIONS = new Set(['flagged', 'held', 'rejected'])
const STATUSES = new Set(['open', 'released', 'confirmed', 'dismissed'])

function reasonLabel(r: string) {
  return REASONS.has(r) ? t(`admin.antiSpam.reasons.${r}`) : r
}

function actionLabel(a: string) {
  return ACTIONS.has(a) ? t(`admin.antiSpam.queue.actions.${a}`) : a
}

function statusLabel(s: string) {
  return STATUSES.has(s) ? t(`admin.antiSpam.queue.statuses.${s}`) : s
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

async function loadSettings() {
  try {
    const s = await getInstanceAntiSpamSettings()
    saved.value = { ...s }
    draft.value = { ...s }
  } catch (err: any) {
    debug.error('Failed to load anti-spam settings:', err)
    toast.error(err?.message || t('admin.antiSpam.errors.loadSettings'))
  }
}

async function save() {
  if (!draft.value) return
  saving.value = true
  try {
    const s = await updateInstanceAntiSpamSettings(draft.value)
    saved.value = { ...s }
    draft.value = { ...s }
    toast.success(t('admin.antiSpam.saved'))
  } catch (err: any) {
    toast.error(cleanDbMessage(err?.message || t('admin.antiSpam.errors.save')))
  } finally {
    saving.value = false
  }
}

async function loadQueue() {
  queueLoading.value = true
  try {
    items.value = await getSuspiciousActivity(statusFilter.value)
  } catch (err: any) {
    debug.error('Failed to load suspicious activity:', err)
    toast.error(err?.message || t('admin.antiSpam.errors.loadQueue'))
  } finally {
    queueLoading.value = false
  }
}

async function review(item: SuspiciousActivity, decision: 'dismiss' | 'confirm' | 'release') {
  reviewing.value.add(item.id)
  try {
    const result = await reviewSuspiciousActivity(item.id, decision)
    item.status = result.status as SuspiciousActivity['status']
    if (statusFilter.value === 'open') items.value = items.value.filter((x) => x.id !== item.id)
    toast.success(decision === 'release' ? t('admin.antiSpam.queue.released') : t('admin.antiSpam.queue.reviewed'))
  } catch (err: any) {
    toast.error(err?.message || t('admin.antiSpam.errors.review'))
  } finally {
    reviewing.value.delete(item.id)
  }
}

watch(statusFilter, loadQueue)
onMounted(() => {
  void loadSettings()
  void loadQueue()
})
</script>

<style scoped src="./adminShared.css"></style>
<style scoped>
.antispam-admin {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.module-body {
  padding: 16px 24px 24px;
}

.module-hint {
  margin: 0 0 16px;
  font-size: 13px;
  color: var(--text-secondary);
}

.group-title {
  margin: 20px 0 10px;
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--text-secondary);
}

.settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
}

.setting {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.setting-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.check-setting {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  font-size: 14px;
  color: var(--text-primary);
  cursor: pointer;
}

.check-setting input {
  accent-color: var(--harmony-primary);
}

.cyber-select.compact {
  width: auto;
  padding: 6px 10px;
}

.empty-state {
  padding: 24px;
  text-align: center;
  color: var(--text-secondary);
}

.queue-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.queue-item {
  padding: 12px 0;
  border-bottom: 1px solid var(--border-color);
}

.queue-item:last-child {
  border-bottom: none;
}

.queue-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  font-size: 14px;
}

.queue-actor {
  font-weight: 600;
  color: var(--text-primary);
}

.queue-domain,
.queue-time,
.queue-targets {
  color: var(--text-secondary);
  font-size: 13px;
}

.queue-time {
  margin-left: auto;
}

.badge {
  padding: 0 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  background: var(--background-tertiary);
  color: var(--text-secondary);
}

.badge.held,
.badge.rejected {
  background: color-mix(in srgb, var(--error) 22%, transparent);
  color: var(--text-primary);
}

.queue-reasons {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.reason {
  padding: 0 6px;
  border-radius: 4px;
  font-size: 12px;
  background: var(--background-tertiary);
  color: var(--text-secondary);
}

.queue-summary {
  margin-top: 6px;
  padding: 6px 10px;
  border-left: 3px solid var(--border-color);
  background: var(--background-tertiary);
  font-size: 13px;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

.queue-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
</style>
