<template>
  <UnifiedModal
    :model-value="!!serverId"
    :title="t('notificationSettings.title')"
    :subtitle="serverName"
    size="md"
    container-class="notification-settings-modal"
    @update:model-value="(open: boolean) => { if (!open) store.closeModal() }"
  >
    <div v-if="!settings" class="ns-loading" data-testid="notification-settings-loading">
      <LoadingSpinner />
    </div>

    <div v-else class="ns-body" data-testid="notification-settings-modal">
      <section class="ns-section ns-row">
        <div class="ns-text">
          <span class="ns-label" id="ns-mute-label">{{ t('notificationSettings.muteServer', { name: serverName }) }}</span>
          <span class="ns-hint">{{ t('notificationSettings.muteServerHint') }}</span>
          <span v-if="settings.muted && mutedUntilLabel" class="ns-hint ns-until" data-testid="ns-muted-until">{{ mutedUntilLabel }}</span>
        </div>
        <div class="ns-controls">
          <select
            v-if="!settings.muted"
            v-model="muteDuration"
            class="ns-select"
            :aria-label="t('notificationSettings.muteFor')"
            data-testid="ns-mute-duration"
          >
            <option v-for="d in MUTE_DURATIONS" :key="d.key" :value="d.key">{{ t(`serverRail.mute.${d.key}`) }}</option>
          </select>
          <ToggleSwitch
            :model-value="settings.muted"
            aria-labelledby="ns-mute-label"
            data-testid="ns-mute-toggle"
            @update:model-value="toggleMute"
          />
        </div>
      </section>

      <section class="ns-section ns-levels" :class="{ dimmed: settings.muted }" role="radiogroup" aria-labelledby="ns-level-label">
        <span id="ns-level-label" class="ns-label">{{ t('notificationSettings.serverLevel') }}</span>
        <label
          v-for="level in NOTIFICATION_LEVELS"
          :key="level"
          class="ns-radio"
          :class="{ checked: serverLevel === level }"
        >
          <input
            type="radio"
            name="ns-server-level"
            :value="level"
            :checked="serverLevel === level"
            :data-testid="`ns-level-${level}`"
            @change="store.updateServer(settings.server_id, { level })"
          />
          <span>{{ t(`notificationSettings.levels.${level}`) }}</span>
          <span v-if="level === settings.server_default" class="ns-default-tag">{{ t('notificationSettings.serverDefaultTag') }}</span>
        </label>
        <button
          v-if="settings.level"
          type="button"
          class="ns-link"
          data-testid="ns-level-reset"
          @click="store.updateServer(settings.server_id, { level: null })"
        >
          {{ t('notificationSettings.useServerDefault') }}
        </button>
      </section>

      <section class="ns-section ns-toggles">
        <div v-for="flag in FLAGS" :key="flag.key" class="ns-row">
          <div class="ns-text">
            <span class="ns-label" :id="`ns-${flag.key}-label`">{{ t(flag.label) }}</span>
            <span class="ns-hint">{{ t(flag.hint) }}</span>
          </div>
          <ToggleSwitch
            :model-value="settings[flag.key]"
            :aria-labelledby="`ns-${flag.key}-label`"
            :data-testid="flag.testid"
            @update:model-value="(value: boolean) => store.updateServer(settings!.server_id, { [flag.key]: value })"
          />
        </div>
      </section>

      <section class="ns-section">
        <h3 class="ns-label">{{ t('notificationSettings.overrides') }}</h3>
        <p class="ns-hint">{{ t('notificationSettings.overridesHint') }}</p>
        <select
          class="ns-select ns-picker"
          :value="''"
          :aria-label="t('notificationSettings.addOverride')"
          data-testid="ns-override-picker"
          @change="pick(($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).value = ''"
        >
          <option value="" disabled>{{ t('notificationSettings.addOverride') }}</option>
          <optgroup v-if="pickableCategories.length" :label="t('notificationSettings.categoriesGroup')">
            <option v-for="k in pickableCategories" :key="k.id" :value="`category:${k.id}`">{{ k.name }}</option>
          </optgroup>
          <optgroup v-if="pickableChannels.length" :label="t('notificationSettings.channelsGroup')">
            <option v-for="c in pickableChannels" :key="c.id" :value="`channel:${c.id}`">#{{ c.name }}</option>
          </optgroup>
        </select>

        <table v-if="rows.length" class="ns-table" data-testid="ns-override-table">
          <thead>
            <tr>
              <th scope="col" class="ns-target-col">{{ t('notificationSettings.columns.target') }}</th>
              <th v-for="level in NOTIFICATION_LEVELS" :key="level" scope="col">{{ t(`notificationSettings.levels.${level}`) }}</th>
              <th scope="col">{{ t('notificationSettings.columns.mute') }}</th>
              <th scope="col"><span class="sr-only">{{ t('notificationSettings.remove') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in rows"
              :key="row.key"
              data-testid="ns-override-row"
              :data-target-id="row.id"
            >
              <th scope="row" class="ns-target">
                <span class="ns-target-name">{{ row.kind === 'channel' ? `#${row.name}` : row.name }}</span>
                <span v-if="row.kind === 'category'" class="ns-target-kind">{{ t('notificationSettings.categoryTag') }}</span>
              </th>
              <td v-for="level in NOTIFICATION_LEVELS" :key="level">
                <input
                  type="radio"
                  :name="`ns-override-${row.key}`"
                  :value="level"
                  :checked="row.level === level"
                  :class="{ inherited: !row.level && row.inherited === level }"
                  :aria-label="`${row.name}: ${t(`notificationSettings.levels.${level}`)}`"
                  :data-testid="`ns-override-${level}`"
                  @change="store.updateOverride(settings!.server_id, row.target, { level })"
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  :checked="row.muted"
                  :aria-label="`${row.name}: ${t('notificationSettings.columns.mute')}`"
                  data-testid="ns-override-mute"
                  @change="store.updateOverride(settings!.server_id, row.target, { muted: ($event.target as HTMLInputElement).checked })"
                />
              </td>
              <td>
                <button
                  type="button"
                  class="ns-remove"
                  :aria-label="t('notificationSettings.removeNamed', { name: row.name })"
                  data-testid="ns-override-remove"
                  @click="remove(row)"
                >
                  <Icon name="x" :size="14" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="ns-empty">{{ t('notificationSettings.noOverrides') }}</p>
      </section>
    </div>

    <template #footer>
      <div class="ns-footer">
        <UnifiedButton variant="primary" :text="t('notificationSettings.done')" data-testid="ns-done" @click="store.closeModal()" />
      </div>
    </template>
  </UnifiedModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import UnifiedModal from '@/components/shared/UnifiedModal.vue'
import UnifiedButton from '@/components/shared/UnifiedButton.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import Icon from '@/components/common/Icon.vue'
import { useServerNotificationSettingsStore } from '@/stores/useServerNotificationSettings'
import { useServerChannelStore } from '@/stores/useServerChannel'
import {
  MUTE_DURATIONS,
  NOTIFICATION_LEVELS,
  inheritedLevel,
  isMuteActive,
  muteUntil,
  type MuteDurationKey,
  type NotificationLevel,
  type OverrideTarget,
} from '@/services/notificationSettings'

type FlagKey = 'suppress_everyone' | 'suppress_roles' | 'push_notifications'

const FLAGS: readonly { key: FlagKey; label: string; hint: string; testid: string }[] = [
  { key: 'suppress_everyone', label: 'notificationSettings.suppressEveryone', hint: 'notificationSettings.suppressEveryoneHint', testid: 'ns-suppress-everyone' },
  { key: 'suppress_roles', label: 'notificationSettings.suppressRoles', hint: 'notificationSettings.suppressRolesHint', testid: 'ns-suppress-roles' },
  { key: 'push_notifications', label: 'notificationSettings.push', hint: 'notificationSettings.pushHint', testid: 'ns-push' },
]

interface OverrideRow {
  key: string
  id: string
  kind: 'channel' | 'category'
  name: string
  target: OverrideTarget
  level: NotificationLevel | null
  /** Level the row falls back to with no level of its own. */
  inherited: NotificationLevel
  muted: boolean
  sort: string
}

const { t, locale } = useI18n()
const store = useServerNotificationSettingsStore()
const serverChannelStore = useServerChannelStore()

const serverId = computed(() => store.modalServerId)
const settings = computed(() => store.settingsFor(serverId.value))
const serverName = computed(() => serverChannelStore.servers.find((s) => s.id === serverId.value)?.name ?? '')

const muteDuration = ref<MuteDurationKey>('forever')

/** Targets picked in this session that carry no setting yet; never persisted. */
const pending = ref<OverrideTarget[]>([])

watch(serverId, () => {
  pending.value = []
  muteDuration.value = 'forever'
})

const serverLevel = computed<NotificationLevel | null>(() =>
  settings.value ? settings.value.level ?? settings.value.server_default : null,
)

const mutedUntilLabel = computed(() => {
  const until = settings.value?.muted_until
  if (!until) return ''
  return t('serverRail.mute.until', {
    time: new Date(until).toLocaleString(locale.value, { dateStyle: 'short', timeStyle: 'short' }),
  })
})

const toggleMute = (on: boolean) => {
  if (!settings.value) return
  void store.setServerMute(settings.value.server_id, on ? muteUntil(muteDuration.value) : false)
}

const targetKey = (target: OverrideTarget) =>
  'channelId' in target ? `channel:${target.channelId}` : `category:${target.categoryId}`

const rows = computed<OverrideRow[]>(() => {
  const s = settings.value
  if (!s) return []
  const channels = new Map(s.channels.map((c) => [c.id, c]))
  const categories = new Map(s.categories.map((k) => [k.id, k]))
  const out = new Map<string, OverrideRow>()

  const add = (target: OverrideTarget, level: NotificationLevel | null, muted: boolean) => {
    const key = targetKey(target)
    if ('channelId' in target) {
      const channel = channels.get(target.channelId)
      if (!channel) return
      out.set(key, {
        key, id: channel.id, kind: 'channel', name: channel.name, target, level, muted,
        inherited: inheritedLevel(s, channel.category_id),
        sort: `1:${channel.name}`,
      })
    } else {
      const category = categories.get(target.categoryId)
      if (!category) return
      out.set(key, {
        key, id: category.id, kind: 'category', name: category.name, target, level, muted,
        inherited: s.level ?? s.server_default,
        sort: `0:${category.name}`,
      })
    }
  }

  for (const target of pending.value) add(target, null, false)
  for (const o of s.overrides) {
    const target: OverrideTarget = o.channel_id ? { channelId: o.channel_id } : { categoryId: o.category_id! }
    add(target, o.level, isMuteActive(o))
  }
  return [...out.values()].sort((a, b) => a.sort.localeCompare(b.sort))
})

const listed = computed(() => new Set(rows.value.map((r) => r.key)))

const pickableCategories = computed(() =>
  (settings.value?.categories ?? []).filter((k) => !listed.value.has(`category:${k.id}`)),
)
const pickableChannels = computed(() =>
  (settings.value?.channels ?? []).filter((c) => !listed.value.has(`channel:${c.id}`)),
)

const pick = (value: string) => {
  const [kind, id] = value.split(':')
  if (!id) return
  const target: OverrideTarget = kind === 'category' ? { categoryId: id } : { channelId: id }
  if (!listed.value.has(targetKey(target))) pending.value = [...pending.value, target]
}

const remove = (row: OverrideRow) => {
  pending.value = pending.value.filter((p) => targetKey(p) !== row.key)
  if (settings.value && (row.level || row.muted)) {
    void store.removeOverride(settings.value.server_id, row.target)
  }
}
</script>

<style scoped>
.ns-loading {
  display: flex;
  justify-content: center;
  padding: 48px 0;
}

.ns-body {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.ns-section {
  margin: 0;
  padding: 0;
  border: none;
  min-width: 0;
}

.ns-section + .ns-section {
  border-top: 1px solid var(--border-primary);
  padding-top: 20px;
}

.ns-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px 16px;
}

.ns-toggles {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.ns-text {
  display: flex;
  flex: 1 1 220px;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.ns-label {
  font-weight: 600;
  color: var(--text-primary);
  font-size: var(--font-size-base, 15px);
  margin: 0;
  padding: 0;
}

.ns-hint {
  font-size: var(--font-size-sm, 13px);
  color: var(--text-secondary);
}

.ns-until {
  color: var(--text-muted);
}

.ns-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.ns-select {
  padding: 6px 10px;
  background: var(--bg-tertiary, var(--background-tertiary));
  border: 1px solid var(--border-color, var(--border-primary));
  border-radius: var(--radius-sm, 4px);
  color: var(--text-primary);
  font-size: var(--font-size-sm, 13px);
}

.ns-picker {
  width: 100%;
  margin: 10px 0 12px;
}

.ns-levels {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ns-levels > .ns-label {
  margin-bottom: 4px;
}

.ns-levels.dimmed {
  opacity: 0.6;
}

.ns-radio {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-base, 6px);
  background: var(--background-secondary);
  color: var(--text-primary);
  cursor: pointer;
}

.ns-radio.checked {
  background: color-mix(in srgb, var(--harmony-primary) 14%, var(--background-secondary));
}

.ns-radio input {
  accent-color: var(--harmony-primary);
  margin: 0;
}

.ns-default-tag,
.ns-target-kind {
  margin-left: auto;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--text-muted);
}

.ns-target-kind {
  margin-left: 8px;
}

.ns-link {
  align-self: flex-start;
  background: none;
  border: none;
  padding: 2px 0;
  color: var(--text-link, var(--harmony-primary));
  font: inherit;
  font-size: var(--font-size-sm, 13px);
  cursor: pointer;
}

.ns-link:hover {
  text-decoration: underline;
}

.ns-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-size-sm, 13px);
}

.ns-table th,
.ns-table td {
  padding: 8px 6px;
  text-align: center;
  border-bottom: 1px solid var(--border-primary);
}

.ns-table thead th {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-muted);
}

.ns-table .ns-target-col,
.ns-table .ns-target {
  text-align: left;
  width: 40%;
}

.ns-target {
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 0;
}

.ns-table input {
  accent-color: var(--harmony-primary);
  cursor: pointer;
}

/* The level a row falls back to while it sets none of its own. */
.ns-table input[type='radio'].inherited {
  border-radius: 50%;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--harmony-primary) 30%, transparent);
}

.ns-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 50%;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
}

.ns-remove:hover,
.ns-remove:focus-visible {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.ns-empty {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--font-size-sm, 13px);
}

.ns-footer {
  display: flex;
  justify-content: flex-end;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

@media (max-width: 520px) {
  .ns-table th,
  .ns-table td {
    padding: 6px 3px;
  }
}
</style>
