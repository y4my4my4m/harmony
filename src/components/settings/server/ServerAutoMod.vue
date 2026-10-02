<template>
  <div class="server-automod">
    <div class="settings-section">
      <h2 class="section-title">{{ t('automod.title') }}</h2>
      <p class="section-description">{{ t('automod.description') }}</p>
    </div>

    <div v-if="loading" class="loading-state"><LoadingSpinner :size="40" /></div>

    <p v-else-if="loadError" class="error-state" role="alert">{{ loadError }}</p>

    <template v-else-if="state">
      <!-- Unconfigured: opt-in ----------------------------------------------------- -->
      <div v-if="state.status === 'unconfigured' || (state.rules.length === 0 && !state.settings?.enabled)" class="settings-card setup-card">
        <div class="setup-icon" aria-hidden="true"><Icon name="shield-check" :size="32" /></div>
        <div class="setup-text">
          <h3>{{ t('automod.setup.title') }}</h3>
          <p>{{ t('automod.setup.body') }}</p>
          <ul class="setup-list">
            <li>{{ t('automod.setup.mention') }}</li>
            <li>{{ t('automod.setup.flood') }}</li>
            <li>{{ t('automod.setup.duplicate') }}</li>
            <li>{{ t('automod.setup.raid') }}</li>
          </ul>
          <p class="setup-note">{{ t('automod.setup.note') }}</p>
          <div class="setup-actions">
            <button type="button" class="btn btn-primary" :disabled="busy" @click="enablePreset">
              {{ t('automod.setup.enable') }}
            </button>
          </div>
        </div>
      </div>

      <template v-else>
        <!-- Master switch ------------------------------------------------------------ -->
        <div class="settings-card">
          <div class="setting-row">
            <div class="setting-info">
              <h3>{{ t('automod.enabled') }}</h3>
              <p>{{ state.settings?.enabled ? t('automod.enabledOn') : t('automod.enabledOff') }}</p>
            </div>
            <ToggleSwitch
              :model-value="!!state.settings?.enabled"
              :disabled="busy"
              :aria-label="t('automod.enabled')"
              @update:model-value="(v: boolean) => patchSettings({ enabled: v })"
            />
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <label :for="`automod-alert-${serverId}`"><h3>{{ t('automod.alertChannel') }}</h3></label>
              <p>{{ t('automod.alertChannelHint') }}</p>
            </div>
            <select
              :id="`automod-alert-${serverId}`"
              class="select-input"
              :value="state.settings?.alert_channel_id ?? ''"
              :disabled="busy"
              @change="patchSettings({ alert_channel_id: ($event.target as HTMLSelectElement).value || null })"
            >
              <option value="">{{ t('automod.noAlertChannel') }}</option>
              <option v-for="ch in textChannels" :key="ch.id" :value="ch.id"># {{ ch.name }}</option>
            </select>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <h3>{{ t('automod.exemptBots') }}</h3>
              <p>{{ t('automod.exemptBotsHint') }}</p>
            </div>
            <ToggleSwitch
              :model-value="!!state.settings?.exempt_bots"
              :disabled="busy"
              :aria-label="t('automod.exemptBots')"
              @update:model-value="(v: boolean) => patchSettings({ exempt_bots: v })"
            />
          </div>
        </div>

        <!-- Rules ------------------------------------------------------------------- -->
        <div class="settings-card">
          <div class="am-card-header">
            <h3>{{ t('automod.rules') }}</h3>
            <div class="add-rule">
              <button
                type="button"
                class="btn btn-secondary btn-sm"
                :disabled="busy || state.rules.length >= 25"
                aria-haspopup="menu"
                :aria-expanded="addMenuOpen"
                @click="addMenuOpen = !addMenuOpen"
              >
                <Icon name="plus" :size="14" /> {{ t('automod.addRule') }}
              </button>
              <div v-if="addMenuOpen" class="add-menu" role="menu">
                <button
                  v-for="type in ruleTypes"
                  :key="type"
                  type="button"
                  role="menuitem"
                  class="add-menu-item"
                  @click="startNewRule(type)"
                >
                  <span class="add-menu-title">{{ t(`automod.types.${type}.name`) }}</span>
                  <span class="add-menu-hint">{{ t(`automod.types.${type}.description`) }}</span>
                </button>
              </div>
            </div>
          </div>
          <p class="card-hint">{{ t('automod.rulesHint') }}</p>

          <AutoModRuleCard
            v-if="pendingRule"
            :key="'new'"
            :rule="pendingRule"
            :roles="roles"
            :channel-choices="channelChoices"
            :has-alert-channel="!!state.settings?.alert_channel_id"
            :busy="busy"
            start-expanded
            @save="saveRule"
            @cancel="pendingRule = null"
          />
          <AutoModRuleCard
            v-for="rule in state.rules"
            :key="rule.id"
            :rule="rule"
            :roles="roles"
            :channel-choices="channelChoices"
            :has-alert-channel="!!state.settings?.alert_channel_id"
            :busy="busy"
            @save="saveRule"
            @delete="removeRule"
            @toggle="toggleRule"
          />
          <p v-if="state.rules.length === 0 && !pendingRule" class="empty-state">{{ t('automod.noRules') }}</p>
        </div>

        <!-- Raid protection --------------------------------------------------------- -->
        <div class="settings-card">
          <div class="am-card-header">
            <h3>{{ t('automod.raid.title') }}</h3>
            <ToggleSwitch
              :model-value="!!raid.enabled"
              :disabled="busy"
              :aria-label="t('automod.raid.title')"
              @update:model-value="(v: boolean) => saveRaid({ enabled: v })"
            />
          </div>
          <p class="card-hint">{{ t('automod.raid.hint') }}</p>
          <div v-if="state.settings?.raid_state?.active" class="raid-banner" role="status">
            <Icon name="alert-triangle" :size="18" />
            <span>{{ t('automod.raid.active', { seconds: state.settings.raid_state.slowmode_seconds, since: formatTime(state.settings.raid_state.since) }) }}</span>
            <button type="button" class="btn btn-secondary btn-sm" :disabled="busy" @click="lockdown(false)">
              {{ t('automod.raid.lift') }}
            </button>
          </div>
          <div class="raid-fields">
            <label class="field">
              <span class="field-label">{{ t('automod.raid.threshold') }}</span>
              <input v-model.number="raidDraft.join_threshold" type="number" min="3" max="1000" class="num-input" />
            </label>
            <label class="field">
              <span class="field-label">{{ t('automod.common.windowSeconds') }}</span>
              <input v-model.number="raidDraft.window_seconds" type="number" min="10" max="3600" class="num-input" />
            </label>
            <label class="field">
              <span class="field-label">{{ t('automod.raid.action') }}</span>
              <select v-model="raidDraft.action" class="select-input">
                <option value="alert">{{ t('automod.raid.actionAlert') }}</option>
                <option value="slowmode">{{ t('automod.raid.actionSlowmode') }}</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">{{ t('automod.raid.slowmode') }}</span>
              <input v-model.number="raidDraft.slowmode_seconds" type="number" min="5" max="21600" class="num-input" />
            </label>
          </div>
          <div class="raid-footer">
            <button
              v-if="!state.settings?.raid_state?.active"
              type="button"
              class="btn btn-secondary btn-sm"
              :disabled="busy"
              @click="lockdown(true)"
            >
              <Icon name="lock" :size="14" /> {{ t('automod.raid.lockNow') }}
            </button>
            <span class="spacer"></span>
            <button type="button" class="btn btn-primary btn-sm" :disabled="busy || !raidDirty" @click="saveRaid(raidDraft)">
              {{ t('automod.rule.save') }}
            </button>
          </div>
        </div>
      </template>

      <!-- Active timeouts ------------------------------------------------------------ -->
      <div v-if="timeouts.length > 0" class="settings-card">
        <div class="am-card-header"><h3>{{ t('automod.timeouts.title') }}</h3></div>
        <ul class="timeout-list">
          <li v-for="to in timeouts" :key="to.user_id" class="timeout-item">
            <Avatar :src="to.avatar_url" :alt="to.display_name || to.username" size="xs" />
            <div class="timeout-info">
              <span class="timeout-name">{{ to.display_name || to.username }}</span>
              <span class="timeout-meta">
                {{ t('automod.timeouts.until', { time: formatTime(to.until) }) }}
                <template v-if="to.reason"> · {{ to.reason }}</template>
              </span>
            </div>
            <button type="button" class="btn btn-secondary btn-sm" :disabled="busy" @click="liftTimeout(to.user_id)">
              {{ t('automod.timeouts.remove') }}
            </button>
          </li>
        </ul>
      </div>

      <!-- Activity log --------------------------------------------------------------- -->
      <div class="settings-card">
        <div class="am-card-header">
          <h3>{{ t('automod.log.title') }}</h3>
          <button type="button" class="btn btn-secondary btn-sm" :disabled="eventsLoading" @click="loadEvents(true)">
            {{ t('automod.log.refresh') }}
          </button>
        </div>
        <p v-if="events.length === 0 && !eventsLoading" class="empty-state">{{ t('automod.log.empty') }}</p>
        <ul v-else class="event-list">
          <li v-for="ev in events" :key="ev.id" class="event-item">
            <div class="event-head">
              <span class="event-who">
                <template v-if="ev.event_type === 'raid'">{{ t('automod.log.raid', { n: ev.details?.joins, s: ev.details?.window_seconds }) }}</template>
                <template v-else>{{ ev.display_name || ev.username || ev.bot_name || t('automod.alert.aBot') }}<span v-if="ev.is_local === false" class="event-domain">@{{ ev.domain }}</span></template>
              </span>
              <span v-if="ev.channel_name" class="event-channel">#{{ ev.channel_name }}</span>
              <span class="event-rule">{{ ev.rule_name }}</span>
              <span v-for="a in ev.actions" :key="a" class="event-action" :class="a">{{ t(`automod.log.action.${a}`) }}</span>
              <span v-if="ev.hits > 1" class="event-hits">×{{ ev.hits }}</span>
              <span class="event-time">{{ formatTime(ev.last_hit_at) }}</span>
            </div>
            <div v-if="ev.content_excerpt" class="event-excerpt">{{ ev.content_excerpt }}</div>
            <div v-if="ev.matched && ev.event_type !== 'raid'" class="event-matched">{{ t('automod.log.matched', { text: ev.matched }) }}</div>
            <div v-if="ev.timeout_until && ev.user_id" class="event-timeout">
              {{ t('automod.timeouts.until', { time: formatTime(ev.timeout_until) }) }}
              <button type="button" class="link-btn" :disabled="busy" @click="liftTimeout(ev.user_id!)">{{ t('automod.timeouts.remove') }}</button>
            </div>
          </li>
        </ul>
        <div v-if="eventsHasMore" class="load-more">
          <button type="button" class="btn btn-secondary btn-sm" :disabled="eventsLoading" @click="loadEvents(false)">
            {{ t('automod.log.more') }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import Icon from '@/components/common/Icon.vue'
import Avatar from '@/components/common/Avatar.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import AutoModRuleCard, { type ChannelChoice, type RoleChoice } from './AutoModRuleCard.vue'
import { roleService } from '@/services/RoleService'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import {
  AUTOMOD_RULE_TYPES,
  deleteAutoModRule,
  enableAutoModPreset,
  getAutoModEvents,
  getMemberTimeouts,
  getServerAutoMod,
  newRule,
  saveAutoModRule,
  setMemberTimeout,
  setRaidLockdown,
  updateAutoModSettings,
  type AutoModEvent,
  type AutoModRaidSettings,
  type AutoModRule,
  type AutoModRuleType,
  type AutoModSettings,
  type AutoModState,
  type AutoModTimeout,
} from '@/services/AutoModService'

const props = defineProps<{ serverId: string }>()
const emit = defineEmits<{ 'status-change': [status: AutoModState['status']] }>()

const { t } = useI18n()
const toast = useToast()
const { confirm } = useConfirmDialog()

const loading = ref(true)
const loadError = ref<string | null>(null)
const busy = ref(false)
const state = ref<AutoModState | null>(null)
const roles = ref<RoleChoice[]>([])
const channels = ref<{ id: string; name: string; type: number; category: string | null }[]>([])
const categories = ref<{ id: string; name: string }[]>([])
const pendingRule = ref<AutoModRule | null>(null)
const addMenuOpen = ref(false)
const events = ref<AutoModEvent[]>([])
const eventsLoading = ref(false)
const eventsHasMore = ref(false)
const timeouts = ref<AutoModTimeout[]>([])

const ruleTypes = AUTOMOD_RULE_TYPES

const defaultRaid: AutoModRaidSettings = {
  enabled: true, join_threshold: 10, window_seconds: 60, action: 'alert', slowmode_seconds: 30,
}
const raid = computed<AutoModRaidSettings>(() => ({ ...defaultRaid, ...(state.value?.settings?.raid_settings ?? {}) }))
const raidDraft = ref<AutoModRaidSettings>({ ...defaultRaid })
watch(raid, (r) => { raidDraft.value = { ...r } }, { immediate: true })
const raidDirty = computed(() => JSON.stringify(raidDraft.value) !== JSON.stringify(raid.value))

const textChannels = computed(() => channels.value.filter((c) => c.type === 0))
const channelChoices = computed<ChannelChoice[]>(() => [
  ...categories.value.map((c) => ({ id: c.id, label: `${c.name} (${t('automod.rule.category')})` })),
  ...textChannels.value.map((c) => ({ id: c.id, label: `# ${c.name}` })),
])

function formatTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

function setState(next: AutoModState) {
  state.value = next
  emit('status-change', next.status)
}

async function run<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined> {
  busy.value = true
  try {
    const result = await fn()
    if (success) toast.success(success)
    return result
  } catch (err: any) {
    debug.error('AutoMod request failed:', err)
    toast.error(err?.message || t('automod.errors.generic'))
    return undefined
  } finally {
    busy.value = false
  }
}

async function loadAll() {
  loading.value = true
  loadError.value = null
  try {
    const [automod, roleRows, channelRows, categoryRows] = await Promise.all([
      getServerAutoMod(props.serverId),
      roleService.getServerRoles(props.serverId),
      supabase.from('channels').select('id, name, type, category').eq('server_id', props.serverId).order('order'),
      supabase.from('channel_categories').select('id, name').eq('server_id', props.serverId).order('order'),
    ])
    setState(automod)
    roles.value = roleRows.map((r) => ({ id: r.id, name: r.name, color: r.color, is_default: r.is_default }))
    channels.value = (channelRows.data ?? []) as any[]
    categories.value = (categoryRows.data ?? []) as any[]
  } catch (err: any) {
    debug.error('Failed to load AutoMod:', err)
    loadError.value = err?.message || t('automod.errors.load')
  } finally {
    loading.value = false
  }
  void loadEvents(true)
  void loadTimeouts()
}

async function loadEvents(reset: boolean) {
  eventsLoading.value = true
  try {
    const before = reset ? undefined : events.value[events.value.length - 1]?.last_hit_at
    const page = await getAutoModEvents(props.serverId, before, 30)
    events.value = reset ? page : [...events.value, ...page]
    eventsHasMore.value = page.length === 30
  } catch (err) {
    debug.warn('AutoMod events unavailable:', err)
  } finally {
    eventsLoading.value = false
  }
}

async function loadTimeouts() {
  try {
    timeouts.value = await getMemberTimeouts(props.serverId)
  } catch (err) {
    // TIMEOUT_MEMBERS or MANAGE_SERVER is required; the list stays hidden without it.
    timeouts.value = []
  }
}

async function enablePreset() {
  const next = await run(() => enableAutoModPreset(props.serverId), t('automod.setup.enabled'))
  if (next) setState(next)
}

async function patchSettings(patch: Partial<Pick<AutoModSettings, 'enabled' | 'alert_channel_id' | 'exempt_bots' | 'raid_settings'>>) {
  const next = await run(() => updateAutoModSettings(props.serverId, patch), t('automod.saved'))
  if (next) setState(next)
}

function saveRaid(patch: Partial<AutoModRaidSettings>) {
  return patchSettings({ raid_settings: { ...raid.value, ...raidDraft.value, ...patch } })
}

async function lockdown(active: boolean) {
  if (active) {
    const ok = await confirm({
      title: t('automod.raid.lockNow'),
      message: t('automod.raid.lockConfirm', { seconds: raid.value.slowmode_seconds }),
      confirmButtonText: t('automod.raid.lockNow'),
    })
    if (!ok) return
  }
  const next = await run(() => setRaidLockdown(props.serverId, active),
    active ? t('automod.raid.locked') : t('automod.raid.lifted'))
  if (next) setState(next)
}

function startNewRule(type: AutoModRuleType) {
  addMenuOpen.value = false
  pendingRule.value = newRule(type, t(`automod.types.${type}.name`))
}

async function saveRule(rule: AutoModRule) {
  const next = await run(() => saveAutoModRule(props.serverId, rule), t('automod.ruleSaved'))
  if (next) {
    setState(next)
    if (!rule.id) pendingRule.value = null
  }
}

async function toggleRule(rule: AutoModRule, enabled: boolean) {
  const next = await run(() => saveAutoModRule(props.serverId, { ...rule, enabled }))
  if (next) setState(next)
}

async function removeRule(rule: AutoModRule) {
  if (!rule.id) return
  const ok = await confirm({
    title: t('automod.rule.delete'),
    message: t('automod.rule.deleteConfirm', { name: rule.name }),
    confirmButtonText: t('automod.rule.delete'),
    dangerAction: true,
  })
  if (!ok) return
  const next = await run(() => deleteAutoModRule(rule.id!), t('automod.ruleDeleted'))
  if (next) setState(next)
}

async function liftTimeout(userId: string) {
  const done = await run(() => setMemberTimeout(props.serverId, userId, 0), t('automod.timeouts.removed'))
  if (done) {
    timeouts.value = timeouts.value.filter((x) => x.user_id !== userId)
    events.value = events.value.map((e) => (e.user_id === userId ? { ...e, timeout_until: null } : e))
  }
}

onMounted(loadAll)
watch(() => props.serverId, loadAll)
</script>

<style scoped>
.server-automod {
  max-width: 860px;
}

.server-automod .btn-sm {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  min-height: 32px;
  font-size: 13px;
}

.settings-section {
  margin-bottom: 24px;
}

.section-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.section-description,
.card-hint {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.card-hint {
  margin: -8px 0 12px;
  font-size: 13px;
}

.settings-card {
  background-color: var(--background-secondary);
  border-radius: 8px;
  border: 1px solid var(--background-quaternary);
  padding: 20px;
  margin-bottom: 16px;
}

.am-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.am-card-header h3,
.setting-info h3,
.setup-text h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 1px solid var(--background-quaternary);
}

.setting-row:first-child {
  padding-top: 0;
}

.setting-row:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.setting-info {
  min-width: 0;
}

.setting-info p {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 4px 0 0;
}

.setting-info label {
  cursor: pointer;
}

.setup-card {
  display: flex;
  gap: 20px;
  align-items: flex-start;
}

.setup-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  flex-shrink: 0;
  border-radius: 50%;
  background: color-mix(in srgb, var(--harmony-primary) 18%, transparent);
  color: var(--harmony-primary);
}

.setup-text p {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 8px 0;
}

.setup-list {
  margin: 8px 0;
  padding-left: 20px;
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.6;
}

.setup-note {
  font-size: 13px !important;
}

.setup-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.select-input,
.num-input {
  padding: 8px 10px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 14px;
  min-width: 180px;
  box-sizing: border-box;
}

.num-input {
  min-width: 0;
  width: 100%;
}

.select-input:focus,
.num-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.add-rule {
  position: relative;
}

.add-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 20;
  width: 320px;
  max-width: calc(100vw - 32px);
  max-height: 360px;
  overflow-y: auto;
  background: var(--background-floating, var(--background-secondary));
  border: 1px solid var(--background-quaternary);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  padding: 6px;
}

.add-menu-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}

.add-menu-item:hover,
.add-menu-item:focus-visible {
  background: var(--background-tertiary);
  outline: none;
}

.add-menu-title {
  font-weight: 600;
  font-size: 14px;
}

.add-menu-hint {
  font-size: 12px;
  color: var(--text-secondary);
}

.raid-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  margin-bottom: 12px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--warning, #f0b232) 18%, transparent);
  color: var(--text-primary);
  font-size: 14px;
}

.raid-banner span {
  flex: 1;
}

.raid-fields {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  align-items: end;
  gap: 12px;
}

.raid-fields .select-input {
  min-width: 0;
  width: 100%;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.raid-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
}

.spacer {
  flex: 1;
}

.timeout-list,
.event-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.timeout-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--background-quaternary);
}

.timeout-item:last-child {
  border-bottom: none;
}

.timeout-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.timeout-name {
  font-weight: 600;
  color: var(--text-primary);
}

.timeout-meta {
  font-size: 13px;
  color: var(--text-secondary);
}

.event-item {
  padding: 10px 0;
  border-bottom: 1px solid var(--background-quaternary);
}

.event-item:last-child {
  border-bottom: none;
}

.event-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  font-size: 13px;
}

.event-who {
  font-weight: 600;
  color: var(--text-primary);
}

.event-domain {
  font-weight: 400;
  color: var(--text-secondary);
}

.event-channel {
  color: var(--text-secondary);
}

.event-rule {
  padding: 0 6px;
  border-radius: 4px;
  background: var(--background-tertiary);
  color: var(--text-secondary);
}

.event-action {
  padding: 0 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  background: var(--background-tertiary);
  color: var(--text-secondary);
}

.event-action.block {
  background: color-mix(in srgb, var(--error) 22%, transparent);
  color: var(--text-primary);
}

.event-action.timeout {
  background: color-mix(in srgb, var(--warning, #f0b232) 25%, transparent);
  color: var(--text-primary);
}

.event-hits {
  color: var(--text-secondary);
}

.event-time {
  margin-left: auto;
  color: var(--text-muted, var(--text-secondary));
  font-size: 12px;
}

.event-excerpt {
  margin-top: 6px;
  padding: 6px 10px;
  border-left: 3px solid var(--background-quaternary);
  background: var(--background-tertiary);
  border-radius: 2px;
  color: var(--text-primary);
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
}

.event-matched,
.event-timeout {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}

.link-btn {
  margin-left: 8px;
  padding: 0;
  border: none;
  background: none;
  color: var(--harmony-primary);
  cursor: pointer;
  font-size: 12px;
}

.load-more {
  display: flex;
  justify-content: center;
  margin-top: 12px;
}

.loading-state {
  display: flex;
  justify-content: center;
  padding: 32px 0;
}

.empty-state,
.error-state {
  text-align: center;
  padding: 16px;
  margin: 0;
  color: var(--text-secondary);
  font-size: 14px;
}

.error-state {
  color: var(--error);
}

@media (max-width: 640px) {
  .setup-card {
    flex-direction: column;
  }

  .setting-row {
    flex-direction: column;
    align-items: flex-start;
  }

  .raid-fields {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .select-input {
    width: 100%;
  }
}
</style>
