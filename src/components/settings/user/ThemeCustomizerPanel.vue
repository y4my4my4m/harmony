<template>
  <Teleport to="body">
    <Transition name="theme-panel">
      <div v-if="isOpen" class="theme-panel" role="dialog" aria-label="Customize theme">
        <div class="theme-panel-header">
          <h3 class="theme-panel-title">Customize your theme</h3>
          <button class="theme-panel-close" title="Close" @click="cancelAndClose">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div class="theme-panel-body">
          <p class="theme-panel-hint">
            Changes preview live on the app behind this panel. Click Apply to keep them.
          </p>

          <!-- Mode -->
          <div class="tp-section">
            <label class="tp-label">Appearance</label>
            <div class="tp-mode-toggle">
              <button
                class="tp-mode-btn"
                :class="{ active: working.customThemeMode === 'dark' }"
                @click="setMode('dark')"
              >🌙 Dark</button>
              <button
                class="tp-mode-btn"
                :class="{ active: working.customThemeMode === 'light' }"
                @click="setMode('light')"
              >☀️ Light</button>
            </div>
          </div>

          <!-- Colors -->
          <div class="tp-section">
            <label class="tp-label">Colors</label>

            <div class="tp-color-row" @click="toggle('bg')">
              <span class="tp-color-swatch" :style="{ background: working.customBackgroundColor }"></span>
              <span class="tp-color-name">Background tone</span>
              <span class="tp-color-hex">{{ working.customBackgroundColor }}</span>
            </div>
            <ColorPicker
              v-if="openPicker === 'bg'"
              :color="working.customBackgroundColor"
              @update:color="onColor('customBackgroundColor', $event)"
              @change="onColor('customBackgroundColor', $event)"
            />

            <div class="tp-color-row" @click="toggle('primary')">
              <span class="tp-color-swatch" :style="{ background: working.customPrimaryColor }"></span>
              <span class="tp-color-name">Primary color</span>
              <span class="tp-color-hex">{{ working.customPrimaryColor }}</span>
            </div>
            <ColorPicker
              v-if="openPicker === 'primary'"
              :color="working.customPrimaryColor"
              @update:color="onColor('customPrimaryColor', $event)"
              @change="onColor('customPrimaryColor', $event)"
            />

            <div class="tp-color-row" @click="toggle('accent')">
              <span class="tp-color-swatch" :style="{ background: working.customAccentColor }"></span>
              <span class="tp-color-name">Accent color</span>
              <span class="tp-color-hex">{{ working.customAccentColor }}</span>
            </div>
            <ColorPicker
              v-if="openPicker === 'accent'"
              :color="working.customAccentColor"
              @update:color="onColor('customAccentColor', $event)"
              @change="onColor('customAccentColor', $event)"
            />
          </div>

          <!-- Optional separate sidebar tone -->
          <div class="tp-section">
            <label class="tp-toggle-row">
              <span>
                <span class="tp-label-inline">Separate sidebar color</span>
                <span class="tp-toggle-hint">Tint the server rail &amp; sidebars with a second hue.</span>
              </span>
              <input type="checkbox" v-model="sidebarEnabled" @change="onSidebarToggle" />
            </label>

            <template v-if="sidebarEnabled">
              <div class="tp-color-row" @click="toggle('sidebar')">
                <span class="tp-color-swatch" :style="{ background: working.customSidebarColor }"></span>
                <span class="tp-color-name">Sidebar tone</span>
                <span class="tp-color-hex">{{ working.customSidebarColor }}</span>
              </div>
              <ColorPicker
                v-if="openPicker === 'sidebar'"
                :color="working.customSidebarColor"
                @update:color="onColor('customSidebarColor', $event)"
                @change="onColor('customSidebarColor', $event)"
              />
            </template>
          </div>

          <!-- Controls -->
          <div class="tp-section">
            <label class="tp-label">Background lightness</label>
            <div class="tp-slider-row">
              <span class="tp-slider-end">Darker</span>
              <input
                type="range" min="-50" max="50" step="1"
                v-model.number="working.customBackgroundLightness"
                @input="applyPreview"
              />
              <span class="tp-slider-end">Lighter</span>
            </div>
            <div class="tp-slider-value">{{ working.customBackgroundLightness > 0 ? '+' : '' }}{{ working.customBackgroundLightness }}</div>
          </div>

          <div class="tp-section">
            <label class="tp-label">Background saturation</label>
            <div class="tp-slider-row">
              <span class="tp-slider-end">Muted</span>
              <input
                type="range" min="-30" max="30" step="1"
                v-model.number="working.customBackgroundChroma"
                @input="applyPreview"
              />
              <span class="tp-slider-end">Vivid</span>
            </div>
            <div class="tp-slider-value">{{ working.customBackgroundChroma > 0 ? '+' : '' }}{{ working.customBackgroundChroma }}</div>
          </div>
        </div>

        <div class="theme-panel-footer">
          <button class="tp-btn tp-btn-ghost" @click="resetWorking">Reset</button>
          <button class="tp-btn tp-btn-primary" @click="applyAndPersist">Apply</button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import ColorPicker from '@/components/common/ColorPicker.vue'
import { useThemeEditorPanel } from '@/composables/useThemeEditorPanel'
import { useVisualTheme } from '@/composables/useVisualTheme'
import { generateThemePalette, applyThemePalette } from '@/utils/colorUtils'
import { debug } from '@/utils/debug'

const { isOpen, close } = useThemeEditorPanel()
const visualTheme = useVisualTheme()

type Working = {
  customThemeMode: 'dark' | 'light'
  customBackgroundColor: string
  customBackgroundLightness: number
  customBackgroundChroma: number
  customPrimaryColor: string
  customAccentColor: string
  customSidebarColor: string
}

const DEFAULTS: Working = {
  customThemeMode: 'dark',
  customBackgroundColor: '#0EA5E9',
  customBackgroundLightness: 0,
  customBackgroundChroma: 0,
  customPrimaryColor: '#0EA5E9',
  customAccentColor: '#0EA5E9',
  customSidebarColor: '#8B5CF6',
}

const working = reactive<Working>({ ...DEFAULTS })
const openPicker = ref<'bg' | 'primary' | 'accent' | 'sidebar' | null>(null)
const sidebarEnabled = ref(false)

// Snapshot of the persisted settings when the panel opened, used to revert the
// live preview if the user closes without applying.
let original: any = null

function seedFromCurrent() {
  const s: any = visualTheme.currentSettings.value
  original = { ...s }
  working.customThemeMode = (s.customThemeMode as 'dark' | 'light') || 'dark'
  working.customBackgroundColor = s.customBackgroundColor || DEFAULTS.customBackgroundColor
  working.customBackgroundLightness = typeof s.customBackgroundLightness === 'number' ? s.customBackgroundLightness : 0
  working.customBackgroundChroma = typeof s.customBackgroundChroma === 'number' ? s.customBackgroundChroma : 0
  working.customPrimaryColor = s.customPrimaryColor || DEFAULTS.customPrimaryColor
  working.customAccentColor = s.customAccentColor || DEFAULTS.customAccentColor
  sidebarEnabled.value = !!s.customSidebarColor
  working.customSidebarColor = s.customSidebarColor || DEFAULTS.customSidebarColor
}

watch(isOpen, (open) => {
  if (open) {
    seedFromCurrent()
    applyPreview()
  }
})

const toggle = (which: 'bg' | 'primary' | 'accent' | 'sidebar') => {
  openPicker.value = openPicker.value === which ? null : which
}

const setMode = (mode: 'dark' | 'light') => {
  working.customThemeMode = mode
  applyPreview()
}

const onSidebarToggle = () => {
  if (!sidebarEnabled.value) openPicker.value = openPicker.value === 'sidebar' ? null : openPicker.value
  applyPreview()
}

const onColor = (key: keyof Working, hex: string) => {
  ;(working as any)[key] = hex
  applyPreview()
}

const applyPreview = () => {
  try {
    const palette = generateThemePalette(
      working.customAccentColor,
      working.customThemeMode,
      working.customBackgroundColor,
      working.customBackgroundLightness,
      working.customPrimaryColor,
      working.customBackgroundChroma,
      sidebarEnabled.value ? working.customSidebarColor : undefined,
    )
    applyThemePalette(palette)
  } catch (e) {
    debug.error('Theme panel preview failed:', e)
  }
}

const resetWorking = () => {
  Object.assign(working, DEFAULTS)
  sidebarEnabled.value = false
  applyPreview()
}

const restoreOriginal = () => {
  if (!original) return
  if (original.theme === 'custom' && original.customAccentColor) {
    try {
      applyThemePalette(generateThemePalette(
        original.customAccentColor,
        original.customThemeMode,
        original.customBackgroundColor,
        original.customBackgroundLightness || 0,
        original.customPrimaryColor,
        original.customBackgroundChroma || 0,
        original.customSidebarColor || undefined,
      ))
    } catch { /* noop */ }
  } else if (original.theme) {
    visualTheme.setTheme(original.theme)
  }
}

const applyAndPersist = () => {
  visualTheme.updateSettings({
    theme: 'custom',
    customThemeMode: working.customThemeMode,
    customPrimaryColor: working.customPrimaryColor,
    customAccentColor: working.customAccentColor,
    customBackgroundColor: working.customBackgroundColor,
    customBackgroundLightness: working.customBackgroundLightness,
    customBackgroundChroma: working.customBackgroundChroma,
    customSidebarColor: sidebarEnabled.value ? working.customSidebarColor : undefined,
  })
  close()
}

const cancelAndClose = () => {
  restoreOriginal()
  close()
}
</script>

<style scoped>
.theme-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 340px;
  max-width: 90vw;
  z-index: 4000;
  display: flex;
  flex-direction: column;
  background: var(--background-secondary);
  border-left: 1px solid var(--border-color);
  box-shadow: -8px 0 32px rgba(0, 0, 0, 0.4);
}

.theme-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
}

.theme-panel-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.theme-panel-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.theme-panel-close:hover {
  background: var(--background-quaternary);
  color: var(--text-primary);
}

.theme-panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.theme-panel-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.4;
}

.tp-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.tp-label {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--text-secondary);
}

.tp-mode-toggle {
  display: flex;
  gap: 8px;
}

.tp-mode-btn {
  flex: 1;
  padding: 10px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--background-tertiary);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.12s ease;
}

.tp-mode-btn.active {
  border-color: var(--harmony-primary);
  background: var(--harmony-primary-alpha, var(--background-quaternary));
  color: var(--text-primary);
}

.tp-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  cursor: pointer;
}

.tp-toggle-row input[type="checkbox"] {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  cursor: pointer;
  accent-color: var(--harmony-primary);
}

.tp-label-inline {
  display: block;
  font-size: 13px;
  color: var(--text-primary);
}

.tp-toggle-hint {
  display: block;
  font-size: 11px;
  color: var(--text-tertiary);
  margin-top: 2px;
}

.tp-color-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  cursor: pointer;
}

.tp-color-row:hover {
  background: var(--background-quaternary);
}

.tp-color-swatch {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1px solid var(--border-color);
  flex-shrink: 0;
}

.tp-color-name {
  flex: 1;
  font-size: 13px;
  color: var(--text-primary);
}

.tp-color-hex {
  font-family: 'Courier New', monospace;
  font-size: 12px;
  color: var(--text-secondary);
}

.tp-slider-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tp-slider-row input[type="range"] {
  flex: 1;
}

.tp-slider-end {
  font-size: 10px;
  text-transform: uppercase;
  color: var(--text-tertiary);
}

.tp-slider-value {
  text-align: center;
  font-size: 12px;
  color: var(--text-secondary);
}

.theme-panel-footer {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border-color);
}

.tp-btn {
  flex: 1;
  padding: 10px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
}

.tp-btn-ghost {
  background: var(--background-tertiary);
  color: var(--text-secondary);
}

.tp-btn-ghost:hover {
  background: var(--background-quaternary);
  color: var(--text-primary);
}

.tp-btn-primary {
  background: var(--harmony-primary);
  color: var(--text-on-primary, #fff);
}

.tp-btn-primary:hover {
  background: var(--harmony-primary-hover, var(--harmony-primary));
}

.theme-panel-enter-active,
.theme-panel-leave-active {
  transition: transform 0.22s ease, opacity 0.22s ease;
}

.theme-panel-enter-from,
.theme-panel-leave-to {
  transform: translateX(100%);
  opacity: 0;
}
</style>
