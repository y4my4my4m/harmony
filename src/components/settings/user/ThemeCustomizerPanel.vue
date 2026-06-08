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

            <div class="tp-color-field">
              <span class="tp-color-name">Background tone</span>
              <ColorPicker
                :color="working.customBackgroundColor"
                @update:color="onColor('customBackgroundColor', $event)"
                @change="onColor('customBackgroundColor', $event)"
              />
            </div>

            <div class="tp-color-field">
              <span class="tp-color-name">Primary color</span>
              <ColorPicker
                :color="working.customPrimaryColor"
                @update:color="onColor('customPrimaryColor', $event)"
                @change="onColor('customPrimaryColor', $event)"
              />
            </div>

            <div class="tp-color-field">
              <span class="tp-color-name">Accent color</span>
              <ColorPicker
                :color="working.customAccentColor"
                @update:color="onColor('customAccentColor', $event)"
                @change="onColor('customAccentColor', $event)"
              />
            </div>
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
              <div class="tp-color-field">
                <span class="tp-color-name">Sidebar tone</span>
                <ColorPicker
                  :color="working.customSidebarColor"
                  @update:color="onColor('customSidebarColor', $event)"
                  @change="onColor('customSidebarColor', $event)"
                />
              </div>
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

          <!-- Advanced CSS variable overrides -->
          <div class="tp-section tp-advanced-section">
            <button type="button" class="tp-advanced-toggle" @click="showAdvancedCss = !showAdvancedCss">
              {{ showAdvancedCss ? 'Hide' : 'Show' }} Advanced CSS Variables
              <span v-if="overrideCount > 0" class="tp-override-badge">{{ overrideCount }}</span>
              <span class="tp-toggle-arrow" :class="{ open: showAdvancedCss }">&#9660;</span>
            </button>

            <div v-if="showAdvancedCss" class="tp-css-panel">
              <p class="tp-css-hint">
                Override individual CSS variables. Changes preview live on top of your theme.
              </p>

              <div v-if="overrideCount > 0" class="tp-overrides-toolbar">
                <span>{{ overrideCount }} override{{ overrideCount !== 1 ? 's' : '' }}</span>
                <button type="button" class="tp-reset-overrides-btn" @click="resetAllOverrides">
                  Reset all
                </button>
              </div>

              <div
                v-for="group in themableVariables"
                :key="group.category"
                class="tp-var-group"
              >
                <h4 class="tp-var-group-title">{{ group.category }}</h4>
                <div
                  v-for="varName in group.vars"
                  :key="varName"
                  class="tp-var-item"
                  :class="{ 'has-override': working.customCssOverrides[varName] }"
                >
                  <label class="tp-var-name">{{ varName }}</label>
                  <div class="tp-var-controls">
                    <div
                      v-if="isHexCompatible(varName)"
                      class="tp-var-swatch tp-var-swatch-clickable"
                      :style="{ backgroundColor: getCssVarValue(varName) || 'transparent' }"
                      :title="getCssVarValue(varName)"
                    >
                      <input
                        type="color"
                        class="tp-var-color-input-hidden"
                        :value="getHexForPicker(varName)"
                        @input="setCssOverrideFromInput(varName, ($event.target as HTMLInputElement).value)"
                      />
                    </div>
                    <div
                      v-else
                      class="tp-var-swatch"
                      :style="{ backgroundColor: getCssVarValue(varName) || 'transparent' }"
                      :title="getCssVarValue(varName)"
                    ></div>
                    <input
                      type="text"
                      class="tp-var-text-input"
                      :value="working.customCssOverrides[varName] || ''"
                      :placeholder="getComputedVar(varName)"
                      @change="setCssOverrideFromInput(varName, ($event.target as HTMLInputElement).value)"
                    />
                    <button
                      v-if="working.customCssOverrides[varName]"
                      type="button"
                      class="tp-var-reset-btn"
                      title="Reset to default"
                      @click="removeCssOverrideVar(varName)"
                    >
                      &#10005;
                    </button>
                  </div>
                </div>
              </div>
            </div>
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
import { reactive, ref, watch, computed } from 'vue'
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
  customCssOverrides: Record<string, string>
}

const DEFAULTS: Working = {
  customThemeMode: 'dark',
  customBackgroundColor: '#0EA5E9',
  customBackgroundLightness: 0,
  customBackgroundChroma: 0,
  customPrimaryColor: '#0EA5E9',
  customAccentColor: '#0EA5E9',
  customSidebarColor: '#8B5CF6',
  customCssOverrides: {},
}

const ALPHA_VAR_NAMES = new Set([
  '--background-primary-alpha', '--background-secondary-alpha', '--background-tertiary-alpha',
  '--background-senary-alpha',
])

const working = reactive<Working>({
  ...DEFAULTS,
  customCssOverrides: {},
})
const sidebarEnabled = ref(false)
const showAdvancedCss = ref(false)
const themableVariables = visualTheme.getThemableVariables()

const overrideCount = computed(() => Object.keys(working.customCssOverrides).length)

// Snapshot of the persisted settings when the panel opened, used to revert the
// live preview if the user closes without applying.
let original: any = null

function seedFromCurrent() {
  const s = visualTheme.currentSettings.value
  original = structuredClone(s)
  working.customThemeMode = (s.customThemeMode as 'dark' | 'light') || 'dark'
  working.customBackgroundColor = s.customBackgroundColor || DEFAULTS.customBackgroundColor
  working.customBackgroundLightness = typeof s.customBackgroundLightness === 'number' ? s.customBackgroundLightness : 0
  working.customBackgroundChroma = typeof s.customBackgroundChroma === 'number' ? s.customBackgroundChroma : 0
  working.customPrimaryColor = s.customPrimaryColor || DEFAULTS.customPrimaryColor
  working.customAccentColor = s.customAccentColor || DEFAULTS.customAccentColor
  sidebarEnabled.value = !!s.customSidebarColor
  working.customSidebarColor = s.customSidebarColor || DEFAULTS.customSidebarColor
  working.customCssOverrides = { ...(s.customCssOverrides || {}) }
}

const getComputedVar = (varName: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || ''

const getCssVarValue = (varName: string): string =>
  working.customCssOverrides[varName] || getComputedVar(varName)

const isHexColor = (value: string): boolean => /^#[0-9a-fA-F]{3,8}$/.test(value.trim())

const isHexCompatible = (varName: string): boolean => {
  if (ALPHA_VAR_NAMES.has(varName)) return false
  const current = getCssVarValue(varName)
  if (!current) return true
  return isHexColor(current) || !current.includes('(')
}

const getHexForPicker = (varName: string): string => {
  const val = getCssVarValue(varName)
  if (isHexColor(val)) return val.substring(0, 7)
  return '#000000'
}

const setCssOverrideFromInput = (varName: string, value: string) => {
  if (!value) return
  working.customCssOverrides[varName] = value
  document.documentElement.style.setProperty(varName, value)
}

const removeCssOverrideVar = (varName: string) => {
  delete working.customCssOverrides[varName]
  document.documentElement.style.removeProperty(varName)
}

const resetAllOverrides = () => {
  for (const varName of Object.keys(working.customCssOverrides)) {
    document.documentElement.style.removeProperty(varName)
  }
  working.customCssOverrides = {}
}

function clearThemableOverrideStyles() {
  for (const group of themableVariables) {
    for (const varName of group.vars) {
      document.documentElement.style.removeProperty(varName)
    }
  }
}

function applyCssOverridesToDom() {
  for (const [varName, value] of Object.entries(working.customCssOverrides)) {
    if (varName.startsWith('--') && value) {
      document.documentElement.style.setProperty(varName, value)
    }
  }
}

watch(isOpen, (open) => {
  if (open) {
    seedFromCurrent()
    applyPreview()
  }
})

const setMode = (mode: 'dark' | 'light') => {
  working.customThemeMode = mode
  applyPreview()
}

const onSidebarToggle = () => {
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
    applyCssOverridesToDom()
  } catch (e) {
    debug.error('Theme panel preview failed:', e)
  }
}

const resetWorking = () => {
  resetAllOverrides()
  Object.assign(working, { ...DEFAULTS, customCssOverrides: {} })
  sidebarEnabled.value = false
  applyPreview()
}

const restoreOriginal = () => {
  if (!original) return
  clearThemableOverrideStyles()
  visualTheme.updateSettings(structuredClone(original))
}

const applyAndPersist = () => {
  // Clear inline override styles first so removed variables don't linger on :root.
  clearThemableOverrideStyles()
  visualTheme.updateSettings({
    theme: 'custom',
    customThemeMode: working.customThemeMode,
    customPrimaryColor: working.customPrimaryColor,
    customAccentColor: working.customAccentColor,
    customBackgroundColor: working.customBackgroundColor,
    customBackgroundLightness: working.customBackgroundLightness,
    customBackgroundChroma: working.customBackgroundChroma,
    customSidebarColor: sidebarEnabled.value ? working.customSidebarColor : undefined,
    customCssOverrides: { ...working.customCssOverrides },
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

.tp-color-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tp-color-name {
  font-size: 13px;
  color: var(--text-primary);
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

/* Advanced CSS variables */
.tp-advanced-section {
  padding-top: 4px;
  border-top: 1px solid var(--border-color);
}

.tp-advanced-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--background-tertiary);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}

.tp-advanced-toggle:hover {
  background: var(--background-quaternary);
  color: var(--text-primary);
}

.tp-override-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--harmony-primary);
  color: var(--text-on-primary, #fff);
  font-size: 10px;
  font-weight: 700;
}

.tp-toggle-arrow {
  margin-left: auto;
  font-size: 9px;
  transition: transform 0.2s ease;
}

.tp-toggle-arrow.open {
  transform: rotate(180deg);
}

.tp-css-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 10px;
}

.tp-css-hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-tertiary);
  line-height: 1.4;
}

.tp-overrides-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  font-size: 11px;
  color: var(--text-secondary);
}

.tp-reset-overrides-btn {
  padding: 3px 8px;
  border-radius: 4px;
  border: 1px solid var(--error, #ed4245);
  background: transparent;
  color: var(--error, #ed4245);
  font-size: 11px;
  cursor: pointer;
}

.tp-reset-overrides-btn:hover {
  background: var(--error, #ed4245);
  color: #fff;
}

.tp-var-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tp-var-group-title {
  margin: 0 0 4px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-tertiary);
}

.tp-var-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  border-radius: 6px;
  border-left: 2px solid transparent;
}

.tp-var-item:hover {
  background: var(--background-quaternary);
}

.tp-var-item.has-override {
  border-left-color: var(--harmony-primary);
  background: var(--harmony-primary-alpha, rgba(14, 165, 233, 0.06));
}

.tp-var-name {
  font-size: 10px;
  font-family: monospace;
  color: var(--text-secondary);
  word-break: break-all;
}

.tp-var-item.has-override .tp-var-name {
  color: var(--text-primary);
}

.tp-var-controls {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tp-var-swatch {
  width: 18px;
  height: 18px;
  border-radius: 3px;
  border: 1px solid var(--border-color);
  flex-shrink: 0;
}

.tp-var-swatch-clickable {
  position: relative;
  cursor: pointer;
}

.tp-var-color-input-hidden {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
  border: none;
  padding: 0;
  margin: 0;
}

.tp-var-text-input {
  flex: 1;
  min-width: 0;
  padding: 4px 6px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 10px;
  font-family: monospace;
}

.tp-var-text-input::placeholder {
  color: var(--text-muted);
}

.tp-var-reset-btn {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 4px;
  border-radius: 4px;
}

.tp-var-reset-btn:hover {
  color: var(--error, #ed4245);
  background: var(--background-modifier-hover);
}
</style>
