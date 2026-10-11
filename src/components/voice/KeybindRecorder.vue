<!--
  KeybindRecorder - records a shortcut for one keybind action. A readonly text
  input holds the current binding: screen readers enter focus mode on it, so the
  keys pressed reach the page. Enter, Space or a click starts recording; the
  next combination is the new binding. Escape cancels, Tab leaves. Plain Enter,
  Space and arrow keys are not recordable (they operate the page); with a
  modifier they are. Extra mouse buttons, or any button with a modifier held,
  record as mouse bindings.

  A combination already bound elsewhere is not applied: the conflict is shown
  in an alert region with "Assign anyway" and "Cancel".

    <KeybindRecorder action="toggle-mute" :name="t('...toggleMute.name')" />
-->
<template>
  <div class="keybind-recorder">
    <input
      ref="inputEl"
      type="text"
      readonly
      class="keybind-recorder__input"
      :class="{ recording, inactive }"
      :value="recording ? t('settings.keybinds.pressKeys') : display"
      :aria-label="t('settings.keybinds.shortcutFor', { name })"
      :aria-describedby="describedBy"
      :aria-invalid="conflict ? 'true' : undefined"
      :data-testid="`keybind-recorder-${action}`"
      @click="toggle"
      @keydown="onKeydown"
      @blur="onBlur"
    />
    <span :id="hintId" class="sr-only">{{ recording ? t('settings.keybinds.recordingHint') : t('settings.keybinds.recorderHint') }}</span>
    <div role="alert" class="keybind-recorder__alert">
      <div v-if="conflict" class="keybind-recorder__conflict" :data-testid="`keybind-conflict-${action}`">
        <Icon name="alert-triangle" aria-hidden="true" />
        <span class="keybind-recorder__conflict-text">{{ t('settings.keybinds.conflict', { keys: conflict.display, other: conflict.otherName }) }}</span>
        <span class="keybind-recorder__conflict-actions">
          <button type="button" class="keybind-recorder__btn" @click="assignAnyway">{{ t('settings.keybinds.assignAnyway') }}</button>
          <button type="button" class="keybind-recorder__btn" @click="dismissConflict">{{ t('common.cancel') }}</button>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useT } from '@/composables/useT'
import { useAnnouncer } from '@/composables/useAnnouncer'
import { useKeybinds, type KeybindAction, type KeybindModifiers } from '@/composables/useKeybinds'
import { uid } from '@/utils/a11y/focus'
import Icon from '@/components/common/Icon.vue'
import { keybindName } from './keybindLabels'

const props = defineProps<{
  action: KeybindAction
  /** Translated action name, e.g. "Toggle mute". */
  name: string
  /** Extra description ids. */
  describedby?: string
  /** Shown dimmed: the binding exists but does not fire in the current mode. */
  inactive?: boolean
}>()

const emit = defineEmits<{ change: [payload: { action: KeybindAction; key: string; modifiers: KeybindModifiers }] }>()

const { t } = useT()
const { polite } = useAnnouncer()
const keybinds = useKeybinds()

const inputEl = ref<HTMLInputElement | null>(null)
const hintId = uid('keybind-hint')
const recording = ref(false)
const conflict = ref<{ key: string; modifiers: KeybindModifiers; display: string; otherName: string } | null>(null)
let release: (() => void) | null = null

const display = computed(() => {
  const kb = keybinds.getKeybind(props.action)
  return kb ? keybinds.formatKeybind(kb.key, kb.modifiers) : t('settings.keybinds.notSet')
})
const describedBy = computed(() => [hintId, props.describedby].filter(Boolean).join(' '))

const MODIFIER_KEYS = ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock', 'Fn']
const NAVIGATION_CODES = ['Enter', 'NumpadEnter', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']

const modifiersOf = (e: KeyboardEvent | MouseEvent): KeybindModifiers => ({
  ctrl: e.ctrlKey,
  alt: e.altKey,
  shift: e.shiftKey,
  meta: e.metaKey,
})
const hasModifier = (m: KeybindModifiers) => m.ctrl || m.alt || m.shift || m.meta

function start() {
  if (recording.value) return
  conflict.value = null
  recording.value = true
  release = keybinds.beginRecording()
  window.addEventListener('mousedown', onMouseDown, true)
  polite(t('settings.keybinds.recordingStarted', { name: props.name }), { dedupeMs: 0 })
}

function stop() {
  if (!recording.value) return
  recording.value = false
  release?.()
  release = null
  window.removeEventListener('mousedown', onMouseDown, true)
}

function cancel(announce = true) {
  stop()
  if (announce) polite(t('settings.keybinds.unchanged', { name: props.name }), { dedupeMs: 0 })
}

function toggle() {
  if (recording.value) cancel()
  else start()
}

function apply(key: string, modifiers: KeybindModifiers) {
  keybinds.setKeybind(props.action, key, modifiers)
  conflict.value = null
  polite(t('settings.keybinds.set', { name: props.name, keys: keybinds.formatKeybind(key, modifiers) }), { dedupeMs: 0 })
  emit('change', { action: props.action, key, modifiers })
}

function record(key: string, modifiers: KeybindModifiers) {
  stop()
  const other = keybinds.findConflict(props.action, key, modifiers)
  if (other) {
    conflict.value = {
      key,
      modifiers,
      display: keybinds.formatKeybind(key, modifiers),
      otherName: keybindName(t, other.id as KeybindAction),
    }
    return
  }
  apply(key, modifiers)
}

function onKeydown(e: KeyboardEvent) {
  if (!recording.value) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      start()
    }
    return
  }
  if (e.key === 'Tab') return
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') {
    cancel()
    return
  }
  if (MODIFIER_KEYS.includes(e.key)) return
  const modifiers = modifiersOf(e)
  if (NAVIGATION_CODES.includes(e.code) && !hasModifier(modifiers)) {
    polite(t('settings.keybinds.reservedKey'), { key: 'keybind-reserved' })
    return
  }
  record(e.code, modifiers)
}

function onMouseDown(e: MouseEvent) {
  if (!recording.value) return
  if (e.button < 3 && !hasModifier(modifiersOf(e))) return
  e.preventDefault()
  e.stopPropagation()
  record(`Mouse${e.button}`, modifiersOf(e))
}

function onBlur() {
  if (recording.value) cancel(false)
}

function assignAnyway() {
  const pending = conflict.value
  if (!pending) return
  apply(pending.key, pending.modifiers)
  inputEl.value?.focus()
}

function dismissConflict() {
  conflict.value = null
  polite(t('settings.keybinds.unchanged', { name: props.name }), { dedupeMs: 0 })
  inputEl.value?.focus()
}

onBeforeUnmount(() => stop())

defineExpose({ start, cancel, recording, conflict })
</script>

<style scoped>
.keybind-recorder {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}

.keybind-recorder__input {
  min-width: 140px;
  padding: 6px 12px;
  background-color: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 12px;
  font-family: monospace;
  text-align: center;
  cursor: pointer;
  caret-color: transparent;
}

.keybind-recorder__input:hover {
  border-color: var(--harmony-primary);
}

.keybind-recorder__input:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

.keybind-recorder__input.recording {
  background-color: color-mix(in srgb, var(--harmony-primary) 20%, var(--input-bg));
  border-color: var(--harmony-primary);
}

.keybind-recorder__input.inactive:not(.recording) {
  color: var(--text-secondary);
}

.keybind-recorder__conflict {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px 8px;
  max-width: 320px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--warning) 12%, transparent);
  color: var(--text-primary);
  font-size: 12px;
}

.keybind-recorder__conflict :deep(svg) {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--warning);
}

.keybind-recorder__conflict-text {
  flex: 1;
  min-width: 0;
}

.keybind-recorder__conflict-actions {
  display: inline-flex;
  gap: 6px;
}

.keybind-recorder__btn {
  padding: 4px 10px;
  border: 1px solid var(--border-primary);
  border-radius: 4px;
  background: var(--background-tertiary);
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
}

.keybind-recorder__btn:hover {
  background: var(--background-modifier-hover);
}

.keybind-recorder__btn:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}
</style>
