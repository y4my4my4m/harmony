<template>
  <div class="rule-card" :class="{ open: expanded, off: !draft.enabled }">
    <div class="rule-header">
      <button
        type="button"
        class="rule-toggle-area"
        :aria-expanded="expanded"
        :aria-controls="`automod-rule-${uid}`"
        @click="expanded = !expanded"
      >
        <span class="rule-icon" aria-hidden="true">
          <Icon :name="ruleIcon" :size="18" />
        </span>
        <span class="rule-titles">
          <span class="rule-name">{{ draft.name || t(`automod.types.${draft.rule_type}.name`) }}</span>
          <span class="rule-summary">{{ summary }}</span>
        </span>
        <Icon :name="expanded ? 'chevron-up' : 'chevron-down'" :size="16" class="rule-chevron" />
      </button>
      <ToggleSwitch
        :model-value="draft.enabled"
        :disabled="busy || isNew"
        :aria-label="t('automod.rule.enabled')"
        @update:model-value="toggleEnabled"
      />
    </div>

    <div v-if="expanded" :id="`automod-rule-${uid}`" class="rule-body">
      <label class="field">
        <span class="field-label">{{ t('automod.rule.name') }}</span>
        <input v-model="draft.name" class="text-input" maxlength="100" />
      </label>

      <!-- Trigger ------------------------------------------------------------------- -->
      <fieldset class="field-group">
        <legend>{{ t('automod.rule.trigger') }}</legend>
        <p class="field-hint">{{ t(`automod.types.${draft.rule_type}.description`) }}</p>

        <template v-if="draft.rule_type === 'keyword'">
          <label class="field">
            <span class="field-label">{{ t('automod.keyword.keywords') }}</span>
            <textarea v-model="keywordsText" class="text-area" rows="4" :placeholder="t('automod.keyword.keywordsPlaceholder')" />
            <span class="field-hint">{{ t('automod.keyword.keywordsHint') }}</span>
          </label>
          <label class="field">
            <span class="field-label">{{ t('automod.keyword.regex') }}</span>
            <textarea v-model="regexText" class="text-area mono" rows="2" :placeholder="t('automod.keyword.regexPlaceholder')" />
            <span class="field-hint">{{ t('automod.keyword.regexHint') }}</span>
          </label>
          <label class="field">
            <span class="field-label">{{ t('automod.keyword.allowList') }}</span>
            <textarea v-model="allowText" class="text-area" rows="2" />
            <span class="field-hint">{{ t('automod.keyword.allowListHint') }}</span>
          </label>
        </template>

        <template v-else-if="draft.rule_type === 'keyword_preset'">
          <div class="check-list">
            <label v-for="preset in presets" :key="preset" class="check-row">
              <input type="checkbox" :checked="draft.config.presets?.includes(preset)" @change="togglePreset(preset)" />
              <span>
                <span class="check-title">{{ t(`automod.presets.${preset}.name`) }}</span>
                <span class="check-hint">{{ t(`automod.presets.${preset}.description`) }}</span>
              </span>
            </label>
          </div>
          <label class="field">
            <span class="field-label">{{ t('automod.keyword.allowList') }}</span>
            <textarea v-model="allowText" class="text-area" rows="2" />
            <span class="field-hint">{{ t('automod.keyword.allowListHint') }}</span>
          </label>
        </template>

        <template v-else-if="draft.rule_type === 'mention_spam'">
          <div class="field-row">
            <label class="field">
              <span class="field-label">{{ t('automod.mention.maxMentions') }}</span>
              <input v-model.number="draft.config.max_mentions" type="number" min="1" max="50" class="num-input" />
            </label>
            <label class="field">
              <span class="field-label">{{ t('automod.mention.windowMentions') }}</span>
              <input v-model.number="draft.config.window_mentions" type="number" min="0" max="1000" class="num-input" />
            </label>
            <label class="field">
              <span class="field-label">{{ t('automod.common.windowSeconds') }}</span>
              <input v-model.number="draft.config.window_seconds" type="number" min="10" max="3600" class="num-input" />
            </label>
          </div>
          <label class="check-row">
            <input v-model="draft.config.block_everyone_without_permission" type="checkbox" />
            <span>{{ t('automod.mention.everyone') }}</span>
          </label>
        </template>

        <template v-else-if="draft.rule_type === 'message_flood'">
          <div class="field-row">
            <label class="field">
              <span class="field-label">{{ t('automod.flood.maxMessages') }}</span>
              <input v-model.number="draft.config.max_messages" type="number" min="2" max="100" class="num-input" />
            </label>
            <label class="field">
              <span class="field-label">{{ t('automod.common.windowSeconds') }}</span>
              <input v-model.number="draft.config.window_seconds" type="number" min="2" max="300" class="num-input" />
            </label>
          </div>
        </template>

        <template v-else-if="draft.rule_type === 'duplicate_spam'">
          <div class="field-row">
            <label class="field">
              <span class="field-label">{{ t('automod.duplicate.maxChannels') }}</span>
              <input v-model.number="draft.config.max_channels" type="number" min="1" max="20" class="num-input" />
            </label>
            <label class="field">
              <span class="field-label">{{ t('automod.common.windowSeconds') }}</span>
              <input v-model.number="draft.config.window_seconds" type="number" min="10" max="3600" class="num-input" />
            </label>
            <label class="field">
              <span class="field-label">{{ t('automod.duplicate.minLength') }}</span>
              <input v-model.number="draft.config.min_length" type="number" min="1" max="500" class="num-input" />
            </label>
          </div>
        </template>

        <template v-else-if="draft.rule_type === 'links'">
          <label class="field">
            <span class="field-label">{{ t('automod.links.mode') }}</span>
            <select v-model="draft.config.mode" class="select-input">
              <option value="allow_list">{{ t('automod.links.allowList') }}</option>
              <option value="block_list">{{ t('automod.links.blockList') }}</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">{{ t('automod.links.domains') }}</span>
            <textarea v-model="domainsText" class="text-area" rows="3" placeholder="example.com" />
            <span class="field-hint">{{ t('automod.links.domainsHint') }}</span>
          </label>
        </template>

        <template v-else-if="draft.rule_type === 'new_member'">
          <div class="field-row">
            <label class="field">
              <span class="field-label">{{ t('automod.newMember.accountAge') }}</span>
              <select v-model.number="draft.config.min_account_age_minutes" class="select-input">
                <option v-for="opt in accountAgeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">{{ t('automod.newMember.membership') }}</span>
              <select v-model.number="draft.config.min_membership_minutes" class="select-input">
                <option v-for="opt in membershipOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              </select>
            </label>
          </div>
          <div class="check-list inline">
            <label class="check-row"><input v-model="draft.config.restrict_links" type="checkbox" /><span>{{ t('automod.newMember.links') }}</span></label>
            <label class="check-row"><input v-model="draft.config.restrict_attachments" type="checkbox" /><span>{{ t('automod.newMember.attachments') }}</span></label>
            <label class="check-row"><input v-model="draft.config.restrict_mentions" type="checkbox" /><span>{{ t('automod.newMember.mentions') }}</span></label>
          </div>
        </template>
      </fieldset>

      <!-- Actions ------------------------------------------------------------------- -->
      <fieldset class="field-group">
        <legend>{{ t('automod.rule.actions') }}</legend>
        <label class="check-row">
          <input v-model="draft.actions.block" type="checkbox" />
          <span>
            <span class="check-title">{{ t('automod.actions.block') }}</span>
            <span class="check-hint">{{ t('automod.actions.blockHint') }}</span>
          </span>
        </label>
        <label v-if="draft.actions.block" class="field indented">
          <span class="field-label">{{ t('automod.actions.blockMessage') }}</span>
          <input
            v-model="blockMessage"
            class="text-input"
            maxlength="150"
            :placeholder="t('automod.actions.blockMessagePlaceholder')"
          />
        </label>
        <label class="check-row">
          <input v-model="draft.actions.alert" type="checkbox" />
          <span>
            <span class="check-title">{{ t('automod.actions.alert') }}</span>
            <span class="check-hint">{{ alertHint }}</span>
          </span>
        </label>
        <label class="field">
          <span class="field-label">{{ t('automod.actions.timeout') }}</span>
          <select v-model.number="draft.actions.timeout_seconds" class="select-input">
            <option :value="0">{{ t('automod.actions.noTimeout') }}</option>
            <option v-for="secs in timeoutChoices" :key="secs" :value="secs">{{ formatDuration(secs) }}</option>
          </select>
        </label>
      </fieldset>

      <!-- Exemptions ---------------------------------------------------------------- -->
      <fieldset class="field-group">
        <legend>{{ t('automod.rule.exemptions') }}</legend>
        <p class="field-hint">{{ t('automod.rule.exemptionsHint') }}</p>
        <div class="exempt-columns">
          <div>
            <span class="field-label">{{ t('automod.rule.exemptRoles') }}</span>
            <div class="chip-list" role="group" :aria-label="t('automod.rule.exemptRoles')">
              <button
                v-for="role in roles"
                :key="role.id"
                type="button"
                class="chip"
                :class="{ selected: draft.exempt_role_ids.includes(role.id) }"
                :aria-pressed="draft.exempt_role_ids.includes(role.id)"
                @click="toggleId(draft.exempt_role_ids, role.id)"
              >
                <span class="role-dot" :style="{ background: role.color || 'var(--text-muted)' }"></span>
                {{ role.is_default ? '@everyone' : role.name }}
              </button>
            </div>
          </div>
          <div>
            <span class="field-label">{{ t('automod.rule.exemptChannels') }}</span>
            <div class="chip-list" role="group" :aria-label="t('automod.rule.exemptChannels')">
              <button
                v-for="ch in channelChoices"
                :key="ch.id"
                type="button"
                class="chip"
                :class="{ selected: draft.exempt_channel_ids.includes(ch.id) }"
                :aria-pressed="draft.exempt_channel_ids.includes(ch.id)"
                @click="toggleId(draft.exempt_channel_ids, ch.id)"
              >
                {{ ch.label }}
              </button>
            </div>
          </div>
        </div>
      </fieldset>

      <div class="rule-footer">
        <button v-if="!isNew" type="button" class="btn btn-danger btn-sm" :disabled="busy" @click="emit('delete', rule)">
          {{ t('automod.rule.delete') }}
        </button>
        <span class="spacer"></span>
        <button type="button" class="btn btn-secondary btn-sm" :disabled="busy" @click="reset">
          {{ isNew ? t('common.cancel') : t('automod.rule.revert') }}
        </button>
        <button type="button" class="btn btn-primary btn-sm" :disabled="busy || !dirty" @click="save">
          {{ t('automod.rule.save') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { TIMEOUT_CHOICES, type AutoModPreset, type AutoModRule } from '@/services/AutoModService'

export interface RoleChoice { id: string; name: string; color: string | null; is_default?: boolean }
export interface ChannelChoice { id: string; label: string }

const props = defineProps<{
  rule: AutoModRule
  roles: RoleChoice[]
  channelChoices: ChannelChoice[]
  hasAlertChannel: boolean
  busy: boolean
  startExpanded?: boolean
}>()

const emit = defineEmits<{
  save: [rule: AutoModRule]
  delete: [rule: AutoModRule]
  cancel: [rule: AutoModRule]
  toggle: [rule: AutoModRule, enabled: boolean]
}>()

const { t } = useI18n()
const uid = Math.random().toString(36).slice(2, 9)
const expanded = ref(!!props.startExpanded)
const presets: AutoModPreset[] = ['profanity', 'sexual', 'slurs']
const timeoutChoices = TIMEOUT_CHOICES

function clone(rule: AutoModRule): AutoModRule {
  return JSON.parse(JSON.stringify(rule))
}

const draft = ref<AutoModRule>(clone(props.rule))
watch(() => props.rule, (r) => { draft.value = clone(r) }, { deep: true })

const isNew = computed(() => !props.rule.id)
const dirty = computed(() => isNew.value || JSON.stringify(draft.value) !== JSON.stringify(props.rule))

function listText(key: string) {
  return computed({
    get: () => ((draft.value.config[key] as string[] | undefined) ?? []).join('\n'),
    set: (v: string) => {
      draft.value.config[key] = v.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)
    },
  })
}
const keywordsText = listText('keywords')
const allowText = listText('allow_list')
const domainsText = listText('domains')
// Regular expressions may contain commas; one per line.
const regexText = computed({
  get: () => ((draft.value.config.regex_patterns as string[] | undefined) ?? []).join('\n'),
  set: (v: string) => {
    draft.value.config.regex_patterns = v.split('\n').map((x) => x.trim()).filter(Boolean)
  },
})
const blockMessage = computed({
  get: () => draft.value.actions.block_message ?? '',
  set: (v: string) => { draft.value.actions.block_message = v.trim() ? v : null },
})

function togglePreset(preset: AutoModPreset) {
  const list: string[] = [...(draft.value.config.presets ?? [])]
  const i = list.indexOf(preset)
  if (i >= 0) list.splice(i, 1)
  else list.push(preset)
  draft.value.config.presets = list
}

function toggleId(list: string[], id: string) {
  const i = list.indexOf(id)
  if (i >= 0) list.splice(i, 1)
  else list.push(id)
}

function formatDuration(seconds: number): string {
  if (seconds % 604800 === 0) return t('automod.duration.weeks', { n: seconds / 604800 }, seconds / 604800)
  if (seconds % 86400 === 0) return t('automod.duration.days', { n: seconds / 86400 }, seconds / 86400)
  if (seconds % 3600 === 0) return t('automod.duration.hours', { n: seconds / 3600 }, seconds / 3600)
  if (seconds % 60 === 0) return t('automod.duration.minutes', { n: seconds / 60 }, seconds / 60)
  return t('automod.duration.seconds', { n: seconds }, seconds)
}

const accountAgeOptions = computed(() =>
  [0, 60, 1440, 10080, 43200].map((m) => ({
    value: m,
    label: m === 0 ? t('automod.newMember.any') : formatDuration(m * 60),
  })),
)
const membershipOptions = computed(() =>
  [0, 5, 10, 30, 60, 1440].map((m) => ({
    value: m,
    label: m === 0 ? t('automod.newMember.any') : formatDuration(m * 60),
  })),
)

const ruleIcon = computed(() => {
  switch (draft.value.rule_type) {
    case 'keyword':
    case 'keyword_preset':
      return 'message-square'
    case 'mention_spam':
      return 'at-sign'
    case 'message_flood':
    case 'duplicate_spam':
      return 'zap'
    case 'invites':
    case 'links':
      return 'link'
    case 'new_member':
      return 'user-plus'
    default:
      return 'shield'
  }
})

const summary = computed(() => {
  const c = draft.value.config
  const type = draft.value.rule_type
  const parts: string[] = []
  switch (type) {
    case 'keyword':
      parts.push(t('automod.summary.keyword', { n: (c.keywords?.length ?? 0) + (c.regex_patterns?.length ?? 0) }))
      break
    case 'keyword_preset':
      parts.push((c.presets ?? []).map((p: string) => t(`automod.presets.${p}.name`)).join(', ') || t('automod.summary.noPresets'))
      break
    case 'mention_spam':
      parts.push(t('automod.summary.mention', { n: c.max_mentions }))
      break
    case 'message_flood':
      parts.push(t('automod.summary.flood', { n: c.max_messages, s: c.window_seconds }))
      break
    case 'duplicate_spam':
      parts.push(t('automod.summary.duplicate', { n: c.max_channels, s: c.window_seconds }))
      break
    case 'invites':
      parts.push(t('automod.summary.invites'))
      break
    case 'links':
      parts.push(t(c.mode === 'block_list' ? 'automod.summary.linksBlock' : 'automod.summary.linksAllow', { n: c.domains?.length ?? 0 }))
      break
    case 'new_member':
      parts.push(t('automod.summary.newMember'))
      break
  }
  const actions: string[] = []
  if (draft.value.actions.block) actions.push(t('automod.actions.blockShort'))
  if (draft.value.actions.alert) actions.push(t('automod.actions.alertShort'))
  if (draft.value.actions.timeout_seconds > 0) actions.push(formatDuration(draft.value.actions.timeout_seconds))
  return `${parts.join(' ')} · ${actions.join(', ')}`
})

const alertHint = computed(() =>
  props.hasAlertChannel ? t('automod.actions.alertHint') : t('automod.actions.alertHintNoChannel'),
)

function reset() {
  if (isNew.value) {
    emit('cancel', props.rule)
    return
  }
  draft.value = clone(props.rule)
}

function save() {
  emit('save', clone(draft.value))
}

function toggleEnabled(value: boolean) {
  emit('toggle', props.rule, value)
}
</script>

<style scoped>
.rule-card {
  border: 1px solid var(--background-quaternary);
  border-radius: 8px;
  background: var(--background-tertiary);
  margin-bottom: 8px;
  transition: border-color 0.15s;
}

.rule-card.open {
  border-color: var(--harmony-primary);
}

.rule-card.off .rule-name,
.rule-card.off .rule-icon {
  opacity: 0.6;
}

.rule-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
}

.rule-toggle-area {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  background: none;
  border: none;
  padding: 0;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.rule-toggle-area:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 4px;
  border-radius: 4px;
}

.rule-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--background-secondary);
  color: var(--harmony-primary);
}

.rule-titles {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.rule-name {
  font-weight: 600;
  color: var(--text-primary);
  font-size: 15px;
}

.rule-summary {
  font-size: 13px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rule-chevron {
  margin-left: auto;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.rule-body {
  padding: 4px 16px 16px;
  border-top: 1px solid var(--background-quaternary);
}

.field-group {
  border: none;
  margin: 16px 0 0;
  padding: 0;
}

.field-group legend {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--text-secondary);
  margin-bottom: 6px;
  padding: 0;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 10px;
}

.field.indented {
  margin-left: 26px;
}

.field-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.field-row .field {
  flex: 1 1 140px;
}

.field-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.field-hint,
.check-hint {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0;
}

.text-input,
.text-area,
.num-input,
.select-input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 14px;
  font-family: inherit;
}

.text-area {
  resize: vertical;
}

.text-area.mono {
  font-family: var(--font-mono, monospace);
  font-size: 13px;
}

.text-input:focus,
.text-area:focus,
.num-input:focus,
.select-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.check-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}

.check-list.inline {
  flex-direction: row;
  flex-wrap: wrap;
  gap: 16px;
}

.check-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 10px;
  font-size: 14px;
  color: var(--text-primary);
  cursor: pointer;
}

.check-row input {
  margin-top: 3px;
  accent-color: var(--harmony-primary);
}

.check-row > span {
  display: flex;
  flex-direction: column;
}

.check-title {
  font-weight: 600;
}

.exempt-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-top: 8px;
}

.chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
  max-height: 160px;
  overflow-y: auto;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--background-quaternary);
  background: var(--background-secondary);
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
}

.chip.selected {
  border-color: var(--harmony-primary);
  color: var(--text-primary);
  background: color-mix(in srgb, var(--harmony-primary) 18%, transparent);
}

.chip:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.role-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.rule-footer .btn-sm {
  padding: 6px 12px;
  min-height: 32px;
  font-size: 13px;
}

.rule-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 20px;
}

.spacer {
  flex: 1;
}

@media (max-width: 640px) {
  .exempt-columns {
    grid-template-columns: 1fr;
  }

  .rule-summary {
    white-space: normal;
  }
}
</style>
