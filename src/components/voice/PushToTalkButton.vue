<template>
  <button
    class="ptt-hold-btn"
    :class="{ transmitting, disabled }"
    :disabled="disabled"
    @pointerdown.prevent="press"
    @pointerup.prevent="release"
    @pointercancel="release"
    @contextmenu.prevent
  >
    <Icon name="mic" />
    <span>{{ disabled ? 'Muted' : transmitting ? 'Transmitting' : 'Hold to talk' }}</span>
  </button>
</template>

<script setup lang="ts">
import { useKeybinds } from '@/composables/useKeybinds';
import Icon from '@/components/common/Icon.vue';

defineProps<{ disabled?: boolean }>();

const keybinds = useKeybinds();
const transmitting = keybinds.isPTTActive;

function press(event: PointerEvent) {
  // keep receiving pointerup even if the finger slides off the button
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  keybinds.pressHold('push-to-talk');
}

function release() {
  keybinds.releaseHold('push-to-talk');
}
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
</style>
