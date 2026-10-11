<template>
  <button
    type="button"
    class="ptt-hold-btn"
    :class="{ transmitting, disabled }"
    :aria-disabled="disabled ? 'true' : undefined"
    :aria-pressed="transmitting"
    :aria-describedby="hintId"
    data-testid="ptt-button"
    @pointerdown="onPointerDown"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @click="onClick"
    @keydown="onKeydown"
    @keyup="onKeyup"
    @blur="onBlur"
    @contextmenu.prevent
  >
    <Icon name="mic" aria-hidden="true" />
    <span>{{ disabled ? t('voice.statusMuted') : latched ? t('voice.pttLatched') : transmitting ? t('voice.pttTransmittingShort') : t('voice.pttHold') }}</span>
    <span :id="hintId" class="sr-only">{{ t('voice.pttButtonHint') }}</span>
  </button>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { useKeybinds } from '@/composables/useKeybinds';
import { useT } from '@/composables/useT';
import { uid } from '@/utils/a11y/focus';
import Icon from '@/components/common/Icon.vue';

const props = defineProps<{ disabled?: boolean }>();

// Hold transmits while held. A press shorter than TAP_MS, or a click with no
// pointer behind it (screen-reader activation), latches transmission on until
// the next tap or click. Space or Enter held on the focused button is a hold.
const TAP_MS = 300;

const { t } = useT();
const keybinds = useKeybinds();
const transmitting = keybinds.isPTTActive;
const hintId = uid('ptt-hint');
const latched = ref(false);

let downAt = 0;
let pointerHolding = false;
let unlatchOnUp = false;
let pointerHandled = false;
let keyHolding = false;

function press() {
  keybinds.pressHold('push-to-talk');
}

function release() {
  keybinds.releaseHold('push-to-talk');
}

function onPointerDown(event: PointerEvent) {
  if (props.disabled) return;
  event.preventDefault();
  // Keeps pointerup even when the finger slides off the button.
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  pointerHandled = false;
  if (latched.value) {
    unlatchOnUp = true;
    return;
  }
  pointerHolding = true;
  downAt = Date.now();
  press();
}

function onPointerUp(event: PointerEvent) {
  event.preventDefault();
  if (unlatchOnUp) {
    unlatchOnUp = false;
    latched.value = false;
    pointerHandled = true;
    release();
    return;
  }
  if (!pointerHolding) return;
  pointerHolding = false;
  pointerHandled = true;
  if (Date.now() - downAt < TAP_MS) latched.value = true;
  else release();
}

function onPointerCancel() {
  unlatchOnUp = false;
  if (!pointerHolding) return;
  pointerHolding = false;
  release();
}

function onClick() {
  if (pointerHandled) {
    pointerHandled = false;
    return;
  }
  if (props.disabled) return;
  if (latched.value) {
    latched.value = false;
    release();
  } else {
    latched.value = true;
    press();
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== ' ' && event.key !== 'Enter') return;
  // No click: the key itself is the hold.
  event.preventDefault();
  if (props.disabled || event.repeat || keyHolding || latched.value) return;
  keyHolding = true;
  press();
}

function onKeyup(event: KeyboardEvent) {
  if (event.key !== ' ' && event.key !== 'Enter') return;
  event.preventDefault();
  if (!keyHolding) return;
  keyHolding = false;
  release();
}

function onBlur() {
  if (!keyHolding) return;
  keyHolding = false;
  release();
}

onBeforeUnmount(() => {
  if (latched.value || pointerHolding || keyHolding) release();
});
</script>

<style scoped>
.ptt-hold-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 12px 16px;
  border-radius: var(--radius-full);
  border: 1px solid var(--border-primary);
  background: var(--background-modifier-hover);
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  transition: all 0.15s ease;
}

.ptt-hold-btn.transmitting {
  background: var(--success);
  color: var(--text-on-primary);
  border-color: var(--success);
}

.ptt-hold-btn.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ptt-hold-btn:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}
</style>
