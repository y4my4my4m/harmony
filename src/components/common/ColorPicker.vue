<template>
  <div
    class="color-picker"
    :class="{ 'color-picker--wide': layout === 'wide' }"
    role="group"
    :aria-label="label || t('colorPicker.label')"
  >
    <div class="color-picker-content">
      <!-- Saturation / Value gradient field: Left/Right saturation, Up/Down brightness. -->
      <div
        ref="svFieldRef"
        class="sv-field"
        role="slider"
        tabindex="0"
        :aria-label="t('colorPicker.saturationBrightness')"
        :aria-describedby="`${baseId}-sv-help`"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="satPercent"
        :aria-valuetext="t('colorPicker.saturationBrightnessValue', { saturation: satPercent, brightness: valPercent })"
        data-testid="color-sv"
        :style="{ backgroundColor: hueHex }"
        @pointerdown="onSvPointerDown"
        @keydown="onSvKeydown"
      >
        <div class="sv-white"></div>
        <div class="sv-black"></div>
        <div
          class="sv-thumb"
          :style="{ left: `${sat * 100}%`, top: `${(1 - val) * 100}%`, backgroundColor: localColor }"
        ></div>
      </div>
      <span :id="`${baseId}-sv-help`" class="sr-only">{{ t('colorPicker.saturationBrightnessHelp') }}</span>

      <!-- Hue slider -->
      <div
        ref="hueTrackRef"
        class="hue-track"
        role="slider"
        tabindex="0"
        :aria-label="t('colorPicker.hue')"
        aria-valuemin="0"
        aria-valuemax="360"
        :aria-valuenow="hueDegrees"
        :aria-valuetext="t('colorPicker.hueValue', { degrees: hueDegrees }, hueDegrees)"
        data-testid="color-hue"
        @pointerdown="onHuePointerDown"
        @keydown="onHueKeydown"
      >
        <div class="hue-thumb" :style="{ left: `${(hue / 360) * 100}%` }"></div>
      </div>

      <!-- Hex input -->
      <div class="color-section">
        <div class="custom-color-input">
          <label :for="`${baseId}-hex`" class="hex-label">{{ t('colorPicker.hex') }}</label>
          <input
            :id="`${baseId}-hex`"
            v-model="hexInput"
            type="text"
            class="hex-input"
            placeholder="#0EA5E9"
            spellcheck="false"
            autocomplete="off"
            data-testid="color-hex"
            @input="onHexInput"
            @blur="commitHexInput"
            @keydown.enter="commitHexInput"
          />
        </div>
      </div>

      <!-- Preset swatches: one Tab stop, arrows move and select. -->
      <div class="color-section">
        <div
          ref="presetsRef"
          class="preset-colors"
          role="radiogroup"
          :aria-label="t('colorPicker.presets')"
          @keydown="onPresetKeydown"
        >
          <button
            v-for="(presetColor, i) in presetColors"
            :key="presetColor"
            type="button"
            role="radio"
            class="preset-color"
            :class="{ active: sameColor(localColor, presetColor) }"
            :style="{ backgroundColor: presetColor }"
            :aria-checked="sameColor(localColor, presetColor) ? 'true' : 'false'"
            :aria-label="t('colorPicker.swatch', { name: t(`colorPicker.names.${colorName(presetColor)}`), hex: presetColor.toUpperCase() })"
            :tabindex="i === presetTabStop ? 0 : -1"
            :data-color="presetColor"
            data-testid="color-preset"
            @click="selectColor(presetColor)"
          ></button>
        </div>
      </div>

      <!-- Preview -->
      <div class="color-preview-large" :style="{ backgroundColor: localColor }" aria-hidden="true">
        <span class="preview-text">{{ t('colorPicker.sampleText') }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useT } from '@/composables/useT'
import { useRovingTabindex } from '@/composables/useRovingTabindex'
import { uid } from '@/utils/a11y/focus'

interface Props {
  color?: string
  /** compact: narrow panels (8-col grid). wide: full-width settings with more swatches. */
  layout?: 'compact' | 'wide'
  /** Accessible name of the picker group, e.g. "Role color". Default "Color picker". */
  label?: string
}

const props = withDefaults(defineProps<Props>(), {
  color: '#0EA5E9',
  layout: 'compact',
  label: '',
})

const { t } = useT()
const baseId = uid('color-picker')

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
const presetsRef = ref<HTMLElement | null>(null)

const hueHex = computed(() => hsvToHex(hue.value, 1, 1))
const localColor = computed(() => hsvToHex(hue.value, sat.value, val.value))
const hexInput = ref(props.color)

const satPercent = computed(() => Math.round(sat.value * 100))
const valPercent = computed(() => Math.round(val.value * 100))
const hueDegrees = computed(() => Math.round(hue.value))

// The checked swatch holds the Tab stop; with none checked, the first.
const presetTabStop = computed(() => {
  const i = presetColors.value.findIndex((c) => sameColor(localColor.value, c))
  return i < 0 ? 0 : i
})

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

/** Basic colour term for a swatch's accessible name; a key under colorPicker.names. */
function colorName(hex: string): string {
  const hsv = hexToHsv(hex)
  if (!hsv) return 'grey'
  const { h, s, v } = hsv
  if (v < 0.15) return 'black'
  if (s < 0.15) return v > 0.9 ? 'white' : 'grey'
  if (h >= 15 && h < 45 && v < 0.6) return 'brown'
  if (h < 15 || h >= 345) return 'red'
  if (h < 40) return 'orange'
  if (h < 65) return 'yellow'
  if (h < 165) return 'green'
  if (h < 195) return 'cyan'
  if (h < 255) return 'blue'
  if (h < 290) return 'purple'
  return 'pink'
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

setFromHex(props.color || '#0EA5E9', true)

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

// ---- keyboard -----------------------------------------------------------------
// Slider steps: 1 % / 1 degree, Shift or PageUp/PageDown 10.
const SMALL_STEP = 1
const LARGE_STEP = 10

const onSvKeydown = (e: KeyboardEvent) => {
  const step = e.shiftKey ? LARGE_STEP : SMALL_STEP
  let s = satPercent.value
  let v = valPercent.value
  switch (e.key) {
    case 'ArrowLeft': s -= step; break
    case 'ArrowRight': s += step; break
    case 'ArrowDown': v -= step; break
    case 'ArrowUp': v += step; break
    case 'PageDown': v -= LARGE_STEP; break
    case 'PageUp': v += LARGE_STEP; break
    case 'Home': s = 0; break
    case 'End': s = 100; break
    default: return
  }
  e.preventDefault()
  sat.value = clamp(s, 0, 100) / 100
  val.value = clamp(v, 0, 100) / 100
  emitColor()
}

const onHueKeydown = (e: KeyboardEvent) => {
  const step = e.shiftKey ? LARGE_STEP : SMALL_STEP
  let h = hueDegrees.value
  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowDown': h -= step; break
    case 'ArrowRight':
    case 'ArrowUp': h += step; break
    case 'PageDown': h -= LARGE_STEP; break
    case 'PageUp': h += LARGE_STEP; break
    case 'Home': h = 0; break
    case 'End': h = 360; break
    default: return
  }
  e.preventDefault()
  hue.value = clamp(h, 0, 360)
  emitColor()
}

// Radio group: moving focus selects (APG radio group).
const { onKeydown: onPresetKeydown } = useRovingTabindex(presetsRef, {
  itemSelector: '[role="radio"]',
  orientation: 'both',
  onActivate: (item) => {
    const color = item.dataset.color
    if (color) selectColor(color)
  },
})

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
  padding: 0;
  border-radius: 50%;
  cursor: pointer;
  border: 2px solid transparent;
  transition: all 0.15s ease;
  position: relative;
}

.preset-color:hover {
  border-color: var(--border-hover);
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

.hex-label {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--text-secondary);
}

.hex-input {
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  background-color: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  font-family: 'Courier New', monospace;
}

.hex-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.color-preview-large {
  height: 56px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--background-quaternary);
  position: relative;
  overflow: hidden;
}

.preview-text {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--text-on-primary, #ffffff);
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
