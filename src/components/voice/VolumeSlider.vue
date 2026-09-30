<template>
  <div class="volume-slider" :class="{ 'is-muted': muted, compact }">
    <div v-if="!compact" class="volume-slider__head">
      <span class="volume-slider__label">{{ label }}</span>
      <span class="volume-slider__value" aria-hidden="true">{{ modelValue }}%</span>
    </div>
    <div class="volume-slider__track-wrap" :style="{ '--fill': `${fillPercent}%`, '--unity': `${unityPercent}%` }">
      <input
        type="range"
        class="volume-slider__input"
        :min="min"
        :max="max"
        step="1"
        :value="modelValue"
        :aria-label="label"
        :aria-valuetext="`${modelValue}%`"
        @input="onInput"
        @dblclick="emit('update:modelValue', unity)"
        @keydown="onKeydown"
      />
      <span class="volume-slider__unity" aria-hidden="true" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

// Percent slider, 0-200 with a mark at 100 (unity). Double-click resets to
// unity.
const props = withDefaults(defineProps<{
  modelValue: number;
  label: string;
  min?: number;
  max?: number;
  unity?: number;
  muted?: boolean;
  compact?: boolean;
}>(), {
  min: 0,
  max: 200,
  unity: 100,
  muted: false,
  compact: false,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: number): void;
}>();

const span = computed(() => Math.max(1, props.max - props.min));
const fillPercent = computed(() => ((props.modelValue - props.min) / span.value) * 100);
const unityPercent = computed(() => ((props.unity - props.min) / span.value) * 100);

function onInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (Number.isFinite(value)) emit('update:modelValue', value);
}

// Slider navigation keys stay with the slider; call keybinds must not see them.
const SLIDER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

function onKeydown(event: KeyboardEvent): void {
  if (SLIDER_KEYS.has(event.key)) event.stopPropagation();
}
</script>

<style scoped>
.volume-slider {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.volume-slider__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.volume-slider__label {
  font-weight: 600;
}

.volume-slider__value {
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
  font-weight: 600;
}

.volume-slider__track-wrap {
  position: relative;
  display: flex;
  align-items: center;
  height: 18px;
}

.volume-slider__input {
  --track: var(--background-modifier-active);
  --accent-fill: var(--harmony-primary);
  width: 100%;
  height: 6px;
  margin: 0;
  appearance: none;
  -webkit-appearance: none;
  border-radius: var(--radius-full);
  background: linear-gradient(
    to right,
    var(--accent-fill) 0,
    var(--accent-fill) var(--fill),
    var(--track) var(--fill),
    var(--track) 100%
  );
  cursor: pointer;
  outline: none;
}

.volume-slider.is-muted .volume-slider__input {
  --accent-fill: var(--text-muted);
}

.volume-slider__input:focus-visible {
  box-shadow: 0 0 0 2px var(--border-focus, var(--harmony-primary));
}

.volume-slider__input::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--text-primary);
  border: 2px solid var(--accent-fill);
  cursor: grab;
}

.volume-slider__input::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--text-primary);
  border: 2px solid var(--accent-fill);
  cursor: grab;
}

.volume-slider__unity {
  position: absolute;
  left: var(--unity);
  top: 1px;
  bottom: 1px;
  width: 2px;
  margin-left: -1px;
  border-radius: 1px;
  background: var(--text-muted);
  opacity: 0.7;
  pointer-events: none;
}

.volume-slider.compact .volume-slider__track-wrap {
  height: 16px;
}
</style>
