<template>
  <div class="keybind-settings">
    <div class="settings-header">
      <h2 class="settings-title">{{ t('settings.keybinds.title') }}</h2>
      <p class="settings-description">
        {{ t('settings.keybinds.description') }}
      </p>
    </div>

    <KeyboardNavigationHelp />

    <section class="settings-section" :aria-labelledby="sectionTitleId">
      <div class="section-header">
        <h3 :id="sectionTitleId" class="section-title">{{ t('settings.keybinds.voiceSection') }}</h3>
        <button type="button" class="reset-btn" data-testid="keybinds-reset-all" @click="resetAllKeybinds">
          <Icon name="refresh" aria-hidden="true" />
          {{ t('settings.keybinds.resetAll') }}
        </button>
      </div>
      <p class="section-description">{{ t('settings.keybinds.voiceSectionDescription') }}</p>

      <div v-if="singleKeyVoiceShortcuts" class="single-key-note" data-testid="keybinds-single-key-note">
        <p>{{ t('settings.keybinds.singleKeyNote') }}</p>
        <button type="button" class="reset-btn" data-testid="keybinds-use-chorded" @click="useChordedDefaults">
          {{ t('settings.keybinds.useChorded', { mute: chordedDisplay.mute, deafen: chordedDisplay.deafen }) }}
        </button>
      </div>

      <ul class="keybind-list">
        <li
          v-for="action in LISTED_KEYBINDS"
          :key="action"
          class="keybind-item"
          :data-testid="`keybind-row-${action}`"
        >
          <div class="keybind-info">
            <h4 :id="`${idBase}-${action}-label`" class="keybind-label">{{ keybindName(t, action) }}</h4>
            <p :id="`${idBase}-${action}-desc`" class="keybind-description">
              {{ keybindDescription(t, action) }}
              <span v-if="action === 'push-to-talk' && !isPTTMode" class="mode-note">{{ t('settings.keybinds.pttInactive') }}</span>
            </p>
          </div>
          <div class="keybind-control">
            <ToggleSwitch
              :model-value="isEnabled(action)"
              :label="t('settings.keybinds.enabledFor', { name: keybindName(t, action) })"
              :describedby="`${idBase}-${action}-desc`"
              :data-testid="`keybind-toggle-${action}`"
              @update:model-value="setEnabled(action, $event)"
            />
            <KeybindRecorder
              :action="action"
              :name="keybindName(t, action)"
              :describedby="`${idBase}-${action}-desc`"
              :inactive="!isEnabled(action) || (action === 'push-to-talk' && !isPTTMode)"
              @change="onRecorded"
            />
            <IconButton
              class="reset-single-btn"
              icon="x"
              :size="14"
              :label="t('settings.keybinds.resetOne', { name: keybindName(t, action) })"
              :data-testid="`keybind-reset-${action}`"
              @click="resetKeybind(action)"
            />
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import KeyboardNavigationHelp from '@/components/a11y/KeyboardNavigationHelp.vue'
import IconButton from '@/components/a11y/IconButton.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import KeybindRecorder from '@/components/voice/KeybindRecorder.vue'
import { keybindDescription, keybindName, LISTED_KEYBINDS } from '@/components/voice/keybindLabels'
import { useKeybinds, type KeybindAction, type KeybindModifiers } from '@/composables/useKeybinds'
import { useAnnouncer } from '@/composables/useAnnouncer'
import { useT } from '@/composables/useT'
import { uid } from '@/utils/a11y/focus'
import Icon from '@/components/common/Icon.vue'

interface Props {
  loading: boolean
}

// eslint-disable-next-line unused-imports/no-unused-vars
const props = defineProps<Props>()

const emit = defineEmits<{
  'update-keybinds': [settings: any]
}>()

const { t } = useT()
const { polite } = useAnnouncer()
const keybinds = useKeybinds()
const idBase = uid('keybind')
const sectionTitleId = `${idBase}-section`

const isPTTMode = keybinds.isPTTMode

const CHORD: KeybindModifiers = { ctrl: true, alt: false, shift: true, meta: false }
const chordedDisplay = computed(() => ({
  mute: keybinds.formatKeybind('KeyM', CHORD),
  deafen: keybinds.formatKeybind('KeyD', CHORD),
}))

const noModifier = (action: KeybindAction): boolean => {
  const kb = keybinds.getKeybind(action)
  if (!kb || !kb.enabled || kb.key.startsWith('Mouse')) return false
  const m = kb.modifiers
  return !m.ctrl && !m.alt && !m.shift && !m.meta
}

// Mute and deafen on bare letters fire from any focused button and are taken
// by screen-reader browse mode; the note offers the chorded defaults.
const singleKeyVoiceShortcuts = computed(() => {
  void keybinds.allKeybinds.value
  return noModifier('toggle-mute') || noModifier('toggle-deafen')
})

const isEnabled = (action: KeybindAction): boolean => {
  void keybinds.allKeybinds.value
  return keybinds.getKeybind(action)?.enabled ?? false
}

const setEnabled = (action: KeybindAction, enabled: boolean) => {
  keybinds.setKeybindEnabled(action, enabled)
  emit('update-keybinds', { action, enabled })
}

const onRecorded = (payload: { action: KeybindAction; key: string; modifiers: KeybindModifiers }) => {
  emit('update-keybinds', payload)
}

const resetKeybind = (action: KeybindAction) => {
  keybinds.resetKeybind(action)
  polite(t('settings.keybinds.set', { name: keybindName(t, action), keys: keybinds.getKeybindDisplay(action) }), { dedupeMs: 0 })
}

const resetAllKeybinds = () => {
  keybinds.resetAllKeybinds()
  polite(t('settings.keybinds.resetAllDone'), { dedupeMs: 0 })
}

const useChordedDefaults = () => {
  keybinds.setKeybind('toggle-mute', 'KeyM', CHORD)
  keybinds.setKeybind('toggle-deafen', 'KeyD', CHORD)
  polite(t('settings.keybinds.chordedApplied', { mute: chordedDisplay.value.mute, deafen: chordedDisplay.value.deafen }), { dedupeMs: 0 })
}
</script>

<style scoped>
.keybind-settings {
  max-width: 700px;
}

.settings-header {
  margin-bottom: 32px;
}

.settings-title {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.settings-description {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.settings-section {
  margin-bottom: 32px;
  padding: 24px;
  background-color: var(--background-secondary);
  border-radius: 8px;
  border: 1px solid var(--background-quaternary);
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.section-description {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0 0 20px 0;
}

.reset-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background-color: transparent;
  border: 1px solid var(--background-quaternary);
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.reset-btn:hover {
  background-color: rgba(237, 66, 69, 0.1);
  border-color: #ed4245;
  color: #ed4245;
}

.reset-btn :deep(svg) {
  width: 14px;
  height: 14px;
}

.keybind-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.single-key-note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  margin: 0 0 20px 0;
  padding: 12px 16px;
  border: 1px solid var(--border-primary);
  border-radius: 8px;
  background: var(--background-tertiary);
  color: var(--text-primary);
  font-size: 13px;
}

.single-key-note p {
  margin: 0;
  flex: 1;
  min-width: 200px;
}

.keybind-item {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--background-quaternary);
}

.keybind-item:last-child {
  margin-bottom: 0;
  padding-bottom: 0;
  border-bottom: none;
}

.keybind-info {
  flex: 1;
  min-width: 200px;
}

.keybind-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.keybind-description {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.4;
}

.keybind-control {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex-shrink: 0;
}

.reset-single-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background-color: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  opacity: 0.7;
}

.reset-single-btn:hover {
  background-color: rgba(237, 66, 69, 0.1);
  border-color: #ed4245;
  color: #ed4245;
  opacity: 1;
}

.reset-single-btn :deep(svg) {
  width: 14px;
  height: 14px;
}

.mode-note {
  display: block;
  font-size: 11px;
  color: var(--text-muted);
  font-style: italic;
  margin-top: 4px;
}

</style>
