import { ref } from 'vue'

/**
 * Global open/close state for the floating "live" theme editor panel.
 *
 * Unlike the full-screen Appearance settings, this panel is a right-side drawer
 * rendered over the live app, so the user can tweak colors and immediately see
 * the effect on the real chat/sidebars (Discord-style).
 */
const isOpen = ref(false)

export function useThemeEditorPanel() {
  const open = () => { isOpen.value = true }
  const close = () => { isOpen.value = false }
  const toggle = () => { isOpen.value = !isOpen.value }
  return { isOpen, open, close, toggle }
}
