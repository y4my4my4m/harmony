<template>
  <div class="color-picker" :class="{ 'color-picker--wide': layout === 'wide' }">
    <div class="color-picker-content">
      <!-- Saturation / Value gradient field -->
      <div
        ref="svFieldRef"
        class="sv-field"
        :style="{ backgroundColor: hueHex }"
        @pointerdown="onSvPointerDown"
      >
        <div class="sv-white"></div>
        <div class="sv-black"></div>
        <div
          class="sv-thumb"
          :style="{ left: `${sat * 100}%`, top: `${(1 - val) * 100}%`, backgroundColor: localColor }"
        ></div>
      </div>

      <!-- Hue slider -->
      <div
        ref="hueTrackRef"
        class="hue-track"
        @pointerdown="onHuePointerDown"
      >
        <div class="hue-thumb" :style="{ left: `${(hue / 360) * 100}%` }"></div>
      </div>

      <!-- Hex input -->
      <div class="color-section">
        <div class="custom-color-input">
          <input
            v-model="hexInput"
            type="text"
            class="hex-input"
            placeholder="#0EA5E9"
            @input="onHexInput"
            @blur="commitHexInput"
            @keydown.enter="commitHexInput"
          />
        </div>
      </div>

      <!-- Preset swatches -->
      <div class="color-section">
        <div class="preset-colors">
          <div
            v-for="presetColor in presetColors"
            :key="presetColor"
            class="preset-color"
            :class="{ active: sameColor(localColor, presetColor) }"
            :style="{ backgroundColor: presetColor }"
            data-testid="color-preset"
            @click="selectColor(presetColor)"
          ></div>
        </div>
      </div>

      <!-- Preview -->
      <div class="color-preview-large" :style="{ backgroundColor: localColor }">
        <span class="preview-text">Sample Text</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'

interface Props {
  color?: string
  /** compact: narrow panels (8-col grid). wide: full-width settings with more swatches. */
  layout?: 'compact' | 'wide'
}

const props = withDefaults(defineProps<Props>(), {
  color: '#0EA5E9',
  layout: 'compact',
})

const emit = defineEmits<{
  'update:color': [color: string]
  'change': [color: string]
}>()

const PRESET_COLORS_COMPACT = [
  '#0EA5E9', '#57f287', '#fee75c', '#eb459e', '#ed4245',
  '#f1c40f', '#e67e22', '#9b59b6', '#3498db', '#2ecc71',
  '#e91e63', '#00bcd4', '#795548', '#607d8b', '#ffffff', '#000000',
]

const PRESET_COLORS_WIDE = [
  ...PRESET_COLORS_COMPACT,
  '#38bdf8', '#4ade80', '#a3e635', '#fb7185', '#f97316',
  '#f59e0b', '#d946ef', '#6366f1', '#14b8a6', '#84cc16',
  '#ec4899', '#8b5cf6', '#22d3ee', '#a78bfa', '#78716c', '#a8a29e',
]

const presetColors = computed(() =>
  props.layout === 'wide' ? PRESET_COLORS_WIDE : PRESET_COLORS_COMPACT,
)

// HSV state (hue 0-360, sat 0-1, val 0-1)
const hue = ref(0)
const sat = ref(0)
const val = ref(0)

const svFieldRef = ref<HTMLElement | null>(null)
const hueTrackRef = ref<HTMLElement | null>(null)

const hueHex = computed(() => hsvToHex(hue.value, 1, 1))
const localColor = computed(() => hsvToHex(hue.value, sat.value, val.value))
const hexInput = ref(props.color)

// ---- color math -------------------------------------------------------------
function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

function normalizeHex(input: string): string | null {
  if (!input) return null
  let h = input.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(h)) {
    h = h.split('').map((c) => c + c).join('')
  }
  if (/^[0-9a-fA-F]{6}$/.test(h)) return `#${h.toLowerCase()}`
  return null
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const n = normalizeHex(hex)
  if (!n) return null
  return {
    r: parseInt(n.slice(1, 3), 16),
    g: parseInt(n.slice(3, 5), 16),
    b: parseInt(n.slice(5, 7), 16),
  }
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0, g = 0, b = 0
  if (h < 60) { r = c; g = x; b = 0 }
  else if (h < 120) { r = x; g = c; b = 0 }
  else if (h < 180) { r = 0; g = c; b = x }
  else if (h < 240) { r = 0; g = x; b = c }
  else if (h < 300) { r = x; g = 0; b = c }
  else { r = c; g = 0; b = x }
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255)
}

function hexToHsv(hex: string): { h: number; s: number; v: number } | null {
  const rgb = hexToRgb(hex)
  if (!rgb) return null
  const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  const s = max === 0 ? 0 : d / max
  return { h, s, v: max }
}

function sameColor(a: string, b: string): boolean {
  return normalizeHex(a) === normalizeHex(b)
}

// ---- syncing ----------------------------------------------------------------
function setFromHex(hex: string, silent = false) {
  const hsv = hexToHsv(hex)
  if (!hsv) return
  // Preserve the current hue for achromatic colors (greys/black/white) so the
  // hue slider doesn't snap back to red when the user drags into a corner.
  if (hsv.s !== 0) hue.value = hsv.h
  sat.value = hsv.s
  val.value = hsv.v
  hexInput.value = normalizeHex(hex) || hex
  if (!silent) emitColor()
}

function emitColor() {
  const hex = localColor.value
  hexInput.value = hex
  emit('update:color', hex)
  emit('change', hex)
}

watch(() => props.color, (c) => {
  if (c && !sameColor(c, localColor.value)) {
    setFromHex(c, true)
  }
})

onMounted(() => {
  setFromHex(props.color || '#0EA5E9', true)
})

// ---- interactions -----------------------------------------------------------
const selectColor = (color: string) => {
  setFromHex(color)
}

const onHexInput = () => {
  if (hexInput.value && !hexInput.value.startsWith('#')) {
    hexInput.value = '#' + hexInput.value
  }
}

const commitHexInput = () => {
  const n = normalizeHex(hexInput.value)
  if (n) {
    setFromHex(n)
  } else {
    hexInput.value = localColor.value
  }
}

// SV field drag
let svDragging = false
function updateSvFromEvent(e: PointerEvent) {
  const el = svFieldRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  sat.value = clamp((e.clientX - rect.left) / rect.width, 0, 1)
  val.value = clamp(1 - (e.clientY - rect.top) / rect.height, 0, 1)
  emitColor()
}
const onSvPointerDown = (e: PointerEvent) => {
  svDragging = true
  updateSvFromEvent(e)
  window.addEventListener('pointermove', onSvPointerMove)
  window.addEventListener('pointerup', onSvPointerUp)
}
const onSvPointerMove = (e: PointerEvent) => { if (svDragging) updateSvFromEvent(e) }
const onSvPointerUp = () => {
  svDragging = false
  window.removeEventListener('pointermove', onSvPointerMove)
  window.removeEventListener('pointerup', onSvPointerUp)
}

// Hue track drag
let hueDragging = false
function updateHueFromEvent(e: PointerEvent) {
  const el = hueTrackRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  hue.value = clamp((e.clientX - rect.left) / rect.width, 0, 1) * 360
  emitColor()
}
const onHuePointerDown = (e: PointerEvent) => {
  hueDragging = true
  updateHueFromEvent(e)
  window.addEventListener('pointermove', onHuePointerMove)
  window.addEventListener('pointerup', onHuePointerUp)
}
const onHuePointerMove = (e: PointerEvent) => { if (hueDragging) updateHueFromEvent(e) }
const onHuePointerUp = () => {
  hueDragging = false
  window.removeEventListener('pointermove', onHuePointerMove)
  window.removeEventListener('pointerup', onHuePointerUp)
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onSvPointerMove)
  window.removeEventListener('pointerup', onSvPointerUp)
  window.removeEventListener('pointermove', onHuePointerMove)
  window.removeEventListener('pointerup', onHuePointerUp)
})
</script>

<style scoped>
.color-picker {
  width: 280px;
  user-select: none;
}

.color-picker-content {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* Saturation / Value field */
.sv-field {
  position: relative;
  width: 100%;
  height: 150px;
  border-radius: 8px;
  overflow: hidden;
  cursor: crosshair;
  touch-action: none;
}

.sv-white {
  position: absolute;
  inset: 0;
  background: linear-gradient(to right, #fff, rgba(255, 255, 255, 0));
  pointer-events: none;
}

.sv-black {
  position: absolute;
  inset: 0;
  background: linear-gradient(to top, #000, rgba(0, 0, 0, 0));
  pointer-events: none;
}

.sv-thumb {
  position: absolute;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
  transform: translate(-50%, -50%);
  pointer-events: none;
}

/* Hue slider */
.hue-track {
  position: relative;
  width: 100%;
  height: 14px;
  border-radius: 7px;
  cursor: pointer;
  touch-action: none;
  background: linear-gradient(
    to right,
    #ff0000 0%, #ffff00 17%, #00ff00 33%,
    #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%
  );
}

.hue-thumb {
  position: absolute;
  top: 50%;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
  transform: translate(-50%, -50%);
  pointer-events: none;
}

.color-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.preset-colors {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 8px;
  justify-items: center;
}

.color-picker--wide .preset-colors {
  grid-template-columns: repeat(auto-fill, minmax(26px, 1fr));
  gap: 10px 8px;
}

.preset-color {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  cursor: pointer;
  border: 2px solid transparent;
  transition: all 0.15s ease;
  position: relative;
}

.preset-color:hover {
  transform: scale(1.1);
}

.preset-color.active {
  border-color: var(--text-primary);
  box-shadow: 0 0 0 2px var(--background-quaternary);
}

.custom-color-input {
  display: flex;
  gap: 8px;
  align-items: center;
}

.hex-input {
  flex: 1;
  padding: 8px 12px;
  background-color: var(--background-senary);
  border: 1px solid var(--background-quaternary);
  border-radius: 4px;
  color: var(--text-primary, #ffffff);
  font-size: 14px;
  font-family: 'Courier New', monospace;
}

.hex-input:focus {
  outline: none;
  border-color: var(--harmony-primary, #0EA5E9);
}

.color-preview-large {
  height: 56px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--background-quaternary);
  position: relative;
  overflow: hidden;
}

.preview-text {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6), 0 0 8px rgba(0, 0, 0, 0.4);
}

@media (max-width: 480px) {
  .color-picker {
    width: 240px;
  }

  .preset-colors {
    grid-template-columns: repeat(6, 1fr);
  }
}
</style>
