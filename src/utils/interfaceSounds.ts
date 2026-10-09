/**
 * Interface sounds: the active audio theme's `ui_click` on clicks of
 * buttons, links and list rows, while <html data-skin-ui-sounds="on">, the
 * attribute of a skin option with id `ui-sounds`. Without that skin option
 * nothing plays.
 *
 * Controls whose action already plays its own sound (voice toggles,
 * reactions, call buttons) are skipped so one click never yields two sounds.
 */
import { audioThemeService } from '@/services/AudioThemeService'

const CLICKABLE = [
  'button',
  'a[href]',
  '[role="button"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="radio"]',
  '[role="switch"]',
  '.channel-item',
  '.server-item',
  '.nav-item',
  '.user-item',
].join(', ')

const OWN_SOUND = [
  '[data-action="mic"]',
  '[data-action="deafen"]',
  '.control-btn',
  '.control-button',
  '.mini-control-btn',
  '.reaction',
  '.add-reaction-btn',
  '.message-actions [data-testid="msg-action-react"]',
  '.incoming-call-modal',
  // AudioThemeManager: pack cards and test buttons play the pack itself.
  '.theme-card',
  '.test-btn',
  '[data-no-ui-sound]',
].join(', ')

export function interfaceSoundsEnabled(root: HTMLElement = document.documentElement): boolean {
  return root.getAttribute('data-skin-ui-sounds') === 'on'
}

/** Whether a click on `target` should play `ui_click`. */
export function shouldPlayClick(target: Element | null): boolean {
  const hit = target?.closest?.(CLICKABLE)
  if (!hit) return false
  if (hit.closest(OWN_SOUND)) return false
  if (hit instanceof HTMLButtonElement && hit.disabled) return false
  if (hit.getAttribute('aria-disabled') === 'true') return false
  return true
}

/** Installs the delegated listener; returns the uninstaller. */
export function installInterfaceSounds(): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.button !== 0 || !interfaceSoundsEnabled()) return
    if (!shouldPlayClick(event.target as Element | null)) return
    void audioThemeService.playAudio('ui_click')
  }
  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}
