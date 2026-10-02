<template>
  <div class="server-welcome-settings">
    <div class="settings-section">
      <h2 class="section-title">{{ t('serverWelcome.settings.title') }}</h2>
      <p class="section-description">{{ t('serverWelcome.settings.description') }}</p>
    </div>

    <div v-if="loading" class="loading-state"><LoadingSpinner :size="40" /></div>

    <p v-else-if="loadError" class="error-state" role="alert">{{ loadError }}</p>

    <template v-else>
      <div class="settings-card">
        <div class="setting-row">
          <div class="setting-info">
            <h3 :id="`${uid}-enabled`">{{ t('serverWelcome.settings.enabled') }}</h3>
            <p>{{ t('serverWelcome.settings.enabledHint') }}</p>
          </div>
          <ToggleSwitch
            v-model="form.enabled"
            :aria-labelledby="`${uid}-enabled`"
            data-testid="welcome-enabled"
          />
        </div>

        <div class="form-group">
          <label class="form-label" :for="`${uid}-message`">{{ t('serverWelcome.settings.message') }}</label>
          <textarea
            :id="`${uid}-message`"
            v-model="form.message"
            class="form-textarea"
            rows="5"
            :maxlength="WELCOME_LIMITS.message"
            :placeholder="t('serverWelcome.settings.messagePlaceholder')"
            data-testid="welcome-message"
          ></textarea>
          <div class="form-hint">
            {{ t('serverWelcome.settings.messageHint') }}
            <span class="counter">{{ form.message.length }}/{{ WELCOME_LIMITS.message }}</span>
          </div>
        </div>
      </div>

      <div class="settings-card">
        <div class="rules-card-header">
          <h3>{{ t('serverWelcome.settings.rules') }}</h3>
          <span class="counter">{{ form.rules.length }}/{{ WELCOME_LIMITS.rules }}</span>
        </div>
        <p class="card-hint">{{ t('serverWelcome.settings.rulesHint') }}</p>

        <ol v-if="form.rules.length > 0" class="rule-editor">
          <li v-for="(rule, index) in form.rules" :key="rule.key" class="rule-row">
            <span class="rule-number" aria-hidden="true">{{ index + 1 }}</span>
            <div class="rule-fields">
              <input
                v-model="rule.title"
                type="text"
                class="form-input"
                :class="{ invalid: !rule.title.trim() && !!rule.description.trim() }"
                :maxlength="WELCOME_LIMITS.ruleTitle"
                :placeholder="t('serverWelcome.settings.ruleTitlePlaceholder')"
                :aria-label="t('serverWelcome.settings.ruleTitleLabel', { n: index + 1 })"
                data-testid="welcome-rule-title"
              />
              <textarea
                v-model="rule.description"
                class="form-textarea"
                rows="2"
                :maxlength="WELCOME_LIMITS.ruleDescription"
                :placeholder="t('serverWelcome.settings.ruleDescriptionPlaceholder')"
                :aria-label="t('serverWelcome.settings.ruleDescriptionLabel', { n: index + 1 })"
              ></textarea>
            </div>
            <div class="rule-actions">
              <button
                type="button"
                class="icon-btn"
                :disabled="index === 0"
                :aria-label="t('serverWelcome.settings.moveUp', { n: index + 1 })"
                @click="moveRule(index, -1)"
              >
                <Icon name="chevron-up" :size="16" />
              </button>
              <button
                type="button"
                class="icon-btn"
                :disabled="index === form.rules.length - 1"
                :aria-label="t('serverWelcome.settings.moveDown', { n: index + 1 })"
                @click="moveRule(index, 1)"
              >
                <Icon name="chevron-down" :size="16" />
              </button>
              <button
                type="button"
                class="icon-btn danger"
                :aria-label="t('serverWelcome.settings.removeRule', { n: index + 1 })"
                @click="removeRule(index)"
              >
                <Icon name="trash" :size="16" />
              </button>
            </div>
          </li>
        </ol>
        <p v-else class="empty-rules">{{ t('serverWelcome.settings.noRules') }}</p>

        <button
          v-if="form.rules.length < WELCOME_LIMITS.rules"
          type="button"
          class="btn btn-secondary btn-sm add-rule"
          data-testid="welcome-add-rule"
          @click="addRule"
        >
          <Icon name="plus" :size="14" />
          {{ t('serverWelcome.settings.addRule') }}
        </button>
      </div>

      <div class="settings-card">
        <div class="setting-row">
          <div class="setting-info">
            <h3 :id="`${uid}-require`">{{ t('serverWelcome.settings.requireAcceptance') }}</h3>
            <p>{{ t('serverWelcome.settings.requireAcceptanceHint') }}</p>
          </div>
          <ToggleSwitch
            v-model="form.requireAcceptance"
            :disabled="!hasRules"
            :aria-labelledby="`${uid}-require`"
            data-testid="welcome-require-acceptance"
          />
        </div>
        <p v-if="!hasRules" class="card-note">{{ t('serverWelcome.settings.requireAcceptanceNeedsRules') }}</p>
        <p v-else-if="form.requireAcceptance && !saved.requireAcceptance" class="card-note">
          {{ t('serverWelcome.settings.grandfatherNote') }}
        </p>
      </div>

      <p v-if="validationError" class="error-state" role="alert">{{ validationError }}</p>

      <div class="actions">
        <button type="button" class="btn btn-secondary" data-testid="welcome-preview" @click="showPreview = true">
          {{ t('serverWelcome.settings.preview') }}
        </button>
        <button
          type="button"
          class="btn btn-primary"
          :disabled="saving || !dirty || !!validationError"
          data-testid="welcome-save"
          @click="save"
        >
          {{ saving ? t('serverWelcome.settings.saving') : t('serverWelcome.settings.save') }}
        </button>
      </div>

      <BaseModal
        :show="showPreview"
        :show-header="false"
        overlay-class="server-welcome-overlay"
        @close="showPreview = false"
      >
        <ServerWelcomeScreen
          :server="serverInfo"
          :message="form.message"
          :rules="cleanRules"
          :action="form.requireAcceptance && hasRules ? 'accept' : 'ok'"
          @accept="showPreview = false"
          @close="showPreview = false"
        />
      </BaseModal>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import BaseModal from '@/components/common/BaseModal.vue'
import ServerWelcomeScreen from '@/components/welcome/ServerWelcomeScreen.vue'
import {
  getServerWelcome,
  setServerWelcome,
  WELCOME_LIMITS,
  type ServerWelcome,
  type WelcomeRule,
} from '@/services/ServerWelcomeService'
import { useServerWelcomeStore } from '@/stores/useServerWelcome'

const props = defineProps<{ serverId: string }>()

const emit = defineEmits<{
  /** Rule titles as copied to servers.rules. */
  'rules-saved': [titles: string[]]
}>()

const { t } = useI18n()
const toast = useToast()
const welcomeStore = useServerWelcomeStore()
const uid = `sws-${useId()}`

interface EditableRule extends WelcomeRule {
  key: number
}

let nextKey = 0

const loading = ref(true)
const loadError = ref('')
const saving = ref(false)
const showPreview = ref(false)
const serverInfo = ref<{ name: string; icon: string | null; banner: string | null }>({ name: '', icon: null, banner: null })

const form = reactive({
  enabled: false,
  message: '',
  rules: [] as EditableRule[],
  requireAcceptance: false,
})

const saved = reactive({ snapshot: '', requireAcceptance: false })

const cleanRules = computed<WelcomeRule[]>(() =>
  form.rules
    .map((r) => ({ title: r.title.trim(), description: r.description.trim() }))
    .filter((r) => r.title.length > 0),
)

const hasRules = computed(() => cleanRules.value.length > 0)

function snapshot(): string {
  return JSON.stringify({
    enabled: form.enabled,
    message: form.message.trim(),
    rules: cleanRules.value,
    requireAcceptance: form.requireAcceptance && hasRules.value,
  })
}

const dirty = computed(() => snapshot() !== saved.snapshot)

const validationError = computed(() =>
  form.rules.some((r) => !r.title.trim() && r.description.trim())
    ? t('serverWelcome.settings.ruleNeedsTitle')
    : '',
)

watch(hasRules, (has) => {
  if (!has) form.requireAcceptance = false
})

function applyState(state: ServerWelcome) {
  serverInfo.value = { name: state.name, icon: state.icon, banner: state.banner }
  form.enabled = state.enabled
  form.message = state.message
  form.rules = state.rules.map((r) => ({ ...r, key: nextKey++ }))
  form.requireAcceptance = state.require_acceptance
  saved.snapshot = snapshot()
  saved.requireAcceptance = state.require_acceptance
}

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    applyState(await getServerWelcome(props.serverId))
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : t('serverWelcome.settings.loadFailed')
  } finally {
    loading.value = false
  }
}

function addRule() {
  if (form.rules.length >= WELCOME_LIMITS.rules) return
  form.rules.push({ title: '', description: '', key: nextKey++ })
}

function removeRule(index: number) {
  form.rules.splice(index, 1)
}

function moveRule(index: number, delta: -1 | 1) {
  const target = index + delta
  if (target < 0 || target >= form.rules.length) return
  const [rule] = form.rules.splice(index, 1)
  form.rules.splice(target, 0, rule)
}

async function save() {
  if (validationError.value) return
  saving.value = true
  try {
    const state = await setServerWelcome(props.serverId, {
      enabled: form.enabled,
      message: form.message,
      rules: cleanRules.value,
      requireAcceptance: form.requireAcceptance && hasRules.value,
    })
    applyState(state)
    welcomeStore.byServer[props.serverId] = state
    emit('rules-saved', state.rules.map((r) => r.title))
    toast.success(t('serverWelcome.settings.saved'))
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t('serverWelcome.settings.saveFailed'))
  } finally {
    saving.value = false
  }
}

watch(() => props.serverId, load, { immediate: true })
</script>

<style scoped>
.server-welcome-settings {
  max-width: 860px;
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

.rules-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.rules-card-header h3,
.setting-info h3 {
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
}

.setting-row + .form-group {
  margin-top: 20px;
}

.setting-info {
  min-width: 0;
}

.setting-info p {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 4px 0 0;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.form-input,
.form-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  background: var(--input-bg, var(--background-tertiary));
  border: 1px solid var(--input-border, var(--border-primary));
  border-radius: 6px;
  color: var(--text-primary);
  font: inherit;
  font-size: 14px;
}

.form-textarea {
  resize: vertical;
}

.form-input:focus,
.form-textarea:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.form-input.invalid {
  border-color: var(--error);
}

.form-hint {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: var(--text-muted);
}

.counter {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.rule-editor {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.rule-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--background-quaternary);
  border-radius: 8px;
  background: var(--background-primary);
}

.rule-number {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  margin-top: 6px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  background: color-mix(in srgb, var(--harmony-primary) 18%, transparent);
  color: var(--harmony-primary);
}

.rule-fields {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rule-actions {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.icon-btn {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
}

.icon-btn:hover:not(:disabled) {
  background: var(--background-tertiary);
  color: var(--text-primary);
}

.icon-btn.danger:hover:not(:disabled) {
  color: var(--error);
}

.icon-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.icon-btn:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 1px;
}

.empty-rules {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--text-muted);
}

.add-rule {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.card-note {
  margin: 12px 0 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.loading-state {
  display: flex;
  justify-content: center;
  padding: 40px 0;
}

.error-state {
  margin: 0 0 12px;
  color: var(--error);
  font-size: 14px;
}

@media (max-width: 600px) {
  .settings-card {
    padding: 16px;
  }

  .setting-row {
    align-items: flex-start;
  }

  .rule-row {
    flex-wrap: wrap;
  }

  .rule-actions {
    flex-direction: row;
    width: 100%;
    justify-content: flex-end;
  }

  .actions {
    flex-direction: column-reverse;
  }

  .actions .btn {
    width: 100%;
    justify-content: center;
  }
}
</style>
