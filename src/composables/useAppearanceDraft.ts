import { computed, ref, watch } from 'vue'
import {
  cloneSettings,
  resolveSkin,
  settingsEqual,
  useVisualTheme,
  withPreset,
  type ThemePreset,
  type VisualThemeSettings,
} from '@/composables/useVisualTheme'

/**
 * Staged edits for the Appearance page. Every edit lands in `draft` and is
 * previewed on the DOM; nothing is stored until `save()`, and `discard()`
 * restores the stored look. One edit never re-applies the stored settings
 * over another unsaved one.
 */
export function useAppearanceDraft() {
  const visualTheme = useVisualTheme()

  const saved = ref<VisualThemeSettings>(cloneSettings(visualTheme.currentSettings.value))
  const draft = ref<VisualThemeSettings>(cloneSettings(saved.value))

  const isDirty = computed(() => !settingsEqual(draft.value, saved.value))

  function preview() {
    visualTheme.previewSettings(draft.value)
  }

  // Covers v-model bindings straight onto draft fields.
  watch(draft, preview, { deep: true })

  function update(patch: Partial<VisualThemeSettings>) {
    Object.assign(draft.value, patch)
  }

  /**
   * Switching between themes drops variable overrides, except into custom,
   * where they are part of the theme being built.
   */
  function setTheme(theme: VisualThemeSettings['theme']) {
    if (theme !== 'custom' && theme !== draft.value.theme) draft.value.customCssOverrides = {}
    update({ theme })
  }

  function setCssOverride(varName: string, value: string) {
    draft.value.customCssOverrides = { ...(draft.value.customCssOverrides ?? {}), [varName]: value }
  }

  function removeCssOverride(varName: string) {
    const next = { ...(draft.value.customCssOverrides ?? {}) }
    delete next[varName]
    draft.value.customCssOverrides = next
  }

  function clearCssOverrides() {
    draft.value.customCssOverrides = {}
  }

  function applySkin(skinId: string | null) {
    draft.value = resolveSkin(draft.value, skinId)
  }

  function setSkinOption(skinId: string, optionId: string, value: boolean) {
    const options = { ...(draft.value.skinOptions ?? {}) }
    options[skinId] = { ...(options[skinId] ?? {}), [optionId]: value }
    draft.value.skinOptions = options
  }

  function applyPreset(preset: ThemePreset) {
    draft.value = withPreset(draft.value, preset)
  }

  function save() {
    visualTheme.commitSettings(draft.value)
    saved.value = cloneSettings(draft.value)
  }

  function discard() {
    draft.value = cloneSettings(saved.value)
    visualTheme.reapplySettings()
  }

  /** Re-reads the stored settings, dropping any draft. */
  function reload() {
    saved.value = cloneSettings(visualTheme.currentSettings.value)
    draft.value = cloneSettings(saved.value)
  }

  return {
    draft,
    isDirty,
    update,
    setTheme,
    setCssOverride,
    removeCssOverride,
    clearCssOverrides,
    applySkin,
    setSkinOption,
    applyPreset,
    save,
    discard,
    reload,
  }
}
