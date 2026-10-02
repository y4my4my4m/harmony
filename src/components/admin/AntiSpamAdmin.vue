<template>
  <div class="antispam-admin">
    <!-- Settings -->
    <div class="admin-module">
      <div class="module-header">
        <Icon name="shield" :size="20" />
        <h2>Anti-spam</h2>
        <div class="module-actions">
          <button class="primary-btn-sm" :disabled="saving || !dirty || !draft" @click="save">
            <Icon v-if="saving" name="loader" :size="14" class="spin" />
            Save
          </button>
        </div>
      </div>
      <div class="module-body">
        <p class="module-hint">
          Instance-wide limits. Server owners configure their own AutoMod in Server Settings; these apply on top of it,
          to every server, DM and post. Every limit here is off or permissive until you change it.
        </p>

        <div v-if="!draft" class="loading-state"><LoadingSpinner :size="20" /><span>Loading settings...</span></div>
        <template v-else>
          <h3 class="group-title">New local accounts</h3>
          <div class="settings-grid">
            <label class="setting">
              <span class="setting-label">An account counts as new for (hours)</span>
              <input v-model.number="draft.new_account_hours" type="number" min="1" max="8760" class="cyber-input" />
            </label>
            <label class="setting">
              <span class="setting-label">Messages per minute (0 = no limit)</span>
              <input v-model.number="draft.new_account_messages_per_minute" type="number" min="0" max="600" class="cyber-input" />
              <span class="setting-hint">Channel messages and DMs together.</span>
            </label>
            <label class="setting">
              <span class="setting-label">Posts per hour (0 = no limit)</span>
              <input v-model.number="draft.new_account_posts_per_hour" type="number" min="0" max="1000" class="cyber-input" />
            </label>
            <label class="setting">
              <span class="setting-label">Mentions of strangers per post (0 = no limit)</span>
              <input v-model.number="draft.new_account_max_stranger_mentions" type="number" min="0" max="100" class="cyber-input" />
              <span class="setting-hint">A stranger is anyone who does not follow the author, local or remote.</span>
            </label>
          </div>
          <label class="check-setting">
            <input v-model="draft.new_account_block_links" type="checkbox" />
            <span>New accounts cannot post links</span>
          </label>
          <p class="setting-hint">Instance admins and moderators are never limited.</p>

          <h3 class="group-title">Federation mention spam</h3>
          <div class="settings-grid">
            <label class="setting">
              <span class="setting-label">When a remote post or DM looks like spam</span>
              <select v-model="draft.federation_spam_mode" class="cyber-select">
                <option value="off">Do nothing</option>
                <option value="flag">Deliver it and add it to the review queue</option>
                <option value="hold">Hold it in the review queue until released</option>
                <option value="reject">Reject it and add it to the review queue</option>
              </select>
            </label>
            <label class="setting">
              <span class="setting-label">Mentions in one post that count as a mass mention</span>
              <input v-model.number="draft.federation_max_mentions" type="number" min="2" max="500" class="cyber-input" />
            </label>
            <label class="setting">
              <span class="setting-label">Remote accounts younger than (days) count as new</span>
              <input v-model.number="draft.federation_new_actor_days" type="number" min="0" max="365" class="cyber-input" />
            </label>
          </div>
          <p class="setting-hint">
            Looks like spam: it mentions at least the mass-mention count of people, or it comes from a new remote
            account that no local user follows and that none of the mentioned users has talked to before.
          </p>
        </template>
      </div>
    </div>

    <!-- Review queue -->
    <div class="admin-module">
      <div class="module-header">
        <Icon name="flag" :size="20" />
        <h2>Suspicious activity</h2>
        <div class="module-actions">
          <select v-model="statusFilter" class="cyber-select compact" aria-label="Filter by status">
            <option value="open">Open</option>
            <option value="all">All</option>
            <option value="released">Released</option>
            <option value="confirmed">Confirmed</option>
            <option value="dismissed">Dismissed</option>
          </select>
          <button class="action-btn" :disabled="queueLoading" @click="loadQueue">
            <Icon :name="queueLoading ? 'loader' : 'refresh-cw'" :size="16" :class="{ spin: queueLoading }" />
            Refresh
          </button>
        </div>
      </div>
      <div class="module-body">
        <p class="module-hint">Inbound federation activity the spam heuristics matched. Held items are delivered only when released.</p>

        <div v-if="queueLoading && items.length === 0" class="loading-state"><LoadingSpinner :size="20" /></div>
        <div v-else-if="items.length === 0" class="empty-state">Nothing to review.</div>
        <ul v-else class="queue-list">
          <li v-for="item in items" :key="item.id" class="queue-item">
            <div class="queue-head">
              <span class="queue-actor">{{ item.actor_display_name || item.actor_username || item.actor_uri }}</span>
              <span class="queue-domain">{{ item.actor_domain }}</span>
              <span class="badge" :class="item.action">{{ item.action }}</span>
              <span class="badge kind">{{ item.kind === 'federation_dm' ? 'DM' : 'mention' }}</span>
              <span v-if="item.status !== 'open'" class="badge status">{{ item.status }}</span>
              <span class="queue-time">{{ formatTime(item.created_at) }}</span>
            </div>
            <div class="queue-reasons">
              <span v-for="r in item.reasons" :key="r" class="reason">{{ reasonLabel(r) }}</span>
              <span v-if="item.targets.length" class="queue-targets">to {{ item.targets.map(t => '@' + t.username).join(', ') }}</span>
            </div>
            <div v-if="item.summary" class="queue-summary">{{ item.summary }}</div>
            <div v-if="item.status === 'open'" class="queue-actions">
              <button
                v-if="item.action === 'held' && item.has_activity"
                class="primary-btn-sm"
                :disabled="reviewing.has(item.id)"
                @click="review(item, 'release')"
              >Release</button>
              <button class="action-btn" :disabled="reviewing.has(item.id)" @click="review(item, 'confirm')">Confirm spam</button>
              <button class="action-btn" :disabled="reviewing.has(item.id)" @click="review(item, 'dismiss')">Dismiss</button>
            </div>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
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

const toast = useToast()

const saved = ref<InstanceAntiSpamSettings | null>(null)
const draft = ref<InstanceAntiSpamSettings | null>(null)
const saving = ref(false)
const dirty = computed(() => JSON.stringify(saved.value) !== JSON.stringify(draft.value))

const items = ref<SuspiciousActivity[]>([])
const queueLoading = ref(false)
const statusFilter = ref<'open' | 'all' | SuspiciousActivity['status']>('open')
const reviewing = ref(new Set<string>())

const REASONS: Record<string, string> = {
  mass_mention: 'mass mention',
  new_actor: 'new account',
  no_followers: 'no local followers',
  no_relationship: 'no prior contact',
  unknown_age: 'account age unknown',
}
function reasonLabel(r: string) {
  return REASONS[r] ?? r
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
    toast.error(err?.message || 'Failed to load anti-spam settings')
  }
}

async function save() {
  if (!draft.value) return
  saving.value = true
  try {
    const s = await updateInstanceAntiSpamSettings(draft.value)
    saved.value = { ...s }
    draft.value = { ...s }
    toast.success('Anti-spam settings saved')
  } catch (err: any) {
    toast.error(cleanDbMessage(err?.message || 'Failed to save'))
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
    toast.error(err?.message || 'Failed to load the review queue')
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
    toast.success(decision === 'release' ? 'Released for delivery' : 'Reviewed')
  } catch (err: any) {
    toast.error(err?.message || 'Review failed')
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
