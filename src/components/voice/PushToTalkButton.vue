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
  border-radius: 24px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(0, 0, 0, 0.3);
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  backdrop-filter: blur(10px);
  transition: all 0.15s ease;
}

.ptt-hold-btn.transmitting {
  background: linear-gradient(145deg, #00d4aa, #00b894);
  color: var(--text-primary);
  border-color: rgba(0, 212, 170, 0.6);
  box-shadow: 0 4px 12px rgba(0, 212, 170, 0.4), 0 0 20px rgba(0, 212, 170, 0.3);
}

.ptt-hold-btn.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
