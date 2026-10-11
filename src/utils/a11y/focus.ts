// Focus queries shared by the dialog, drawer, menu and region helpers.
//
// Visibility is decided from attributes and computed style, not layout: happy-dom
// computes no boxes, and an element in a closed transform-offscreen drawer has a
// box but is inert.

import { resolveFocusOrigin } from './layers'

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[tabindex]',
].join(',')

/** Text-entry controls: the default initial focus of a dialog. */
export const FIELD_SELECTOR = [
  'input:not([disabled]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="range"]):not([type="file"]):not([readonly])',
  'textarea:not([disabled]):not([readonly])',
  'select:not([disabled])',
  '[contenteditable="true"]',
].join(',')

/** False for elements under [hidden], [inert], aria-hidden="true", display:none or visibility:hidden. */
export function isVisibleForFocus(el: Element): boolean {
  if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  let node: Element | null = el
  while (node) {
    const style = node.ownerDocument?.defaultView?.getComputedStyle(node)
    if (style && (style.display === 'none' || (node === el && style.visibility === 'hidden'))) return false
    node = node.parentElement
  }
  return true
}

/**
 * Tabbable descendants of `root` in DOM order. tabindex="-1" is excluded; a
 * named radio group contributes its checked radio, or its first one when none
 * is checked, as the Tab sequence does.
 */
export function tabbables(root: Element | null | undefined): HTMLElement[] {
  if (!root) return []
  const all = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    const tabindex = el.getAttribute('tabindex')
    if (tabindex !== null && Number(tabindex) < 0) return false
    return isVisibleForFocus(el)
  })
  const groups = new Map<string, HTMLInputElement[]>()
  for (const el of all) {
    if (el instanceof HTMLInputElement && el.type === 'radio' && el.name) {
      const list = groups.get(el.name) ?? []
      list.push(el)
      groups.set(el.name, list)
    }
  }
  if (groups.size === 0) return all
  return all.filter((el) => {
    if (!(el instanceof HTMLInputElement) || el.type !== 'radio' || !el.name) return true
    const group = groups.get(el.name) ?? []
    const checked = group.find((r) => r.checked)
    return checked ? el === checked : el === group[0]
  })
}

let uidCounter = 0

/** Document-unique id for aria-labelledby/aria-controls wiring. */
export function uid(prefix: string): string {
  uidCounter += 1
  return `${prefix}-${uidCounter.toString(36)}`
}

/** Focuses `el` without scrolling; false when it did not take focus. */
export function focusElement(el: HTMLElement | null | undefined): boolean {
  if (!el || !el.isConnected) return false
  el.focus({ preventScroll: true })
  return el.ownerDocument.activeElement === el
}

/**
 * Focuses `el`, giving it tabindex="-1" first when it is not focusable on its
 * own (landmarks, headings, dialog containers).
 */
export function focusProgrammatically(el: HTMLElement | null | undefined): boolean {
  if (!el) return false
  if (!el.matches(FOCUSABLE_SELECTOR)) el.setAttribute('tabindex', '-1')
  return focusElement(el)
}

// Last element that held focus other than <body>, and the control it resolves
// to (a menu item's trigger) while its popup was still open. A click in WebKit
// focuses no button, and a menu item unmounts before the dialog it opened
// reads the opener, so document.activeElement at that point can be <body>.
let lastFocused: HTMLElement | null = null
let lastResolved: HTMLElement | null = null
let tracking = false

export function trackLastFocused(): void {
  if (tracking || typeof document === 'undefined') return
  tracking = true
  document.addEventListener(
    'focusin',
    (event) => {
      if (event.target instanceof HTMLElement && event.target !== document.body) {
        lastFocused = event.target
        lastResolved = resolveFocusOrigin(event.target)
      }
    },
    true,
  )
}

/**
 * document.activeElement; when focus sits on <body>, the last focused element,
 * or the control it resolved to once it has unmounted.
 */
export function currentFocusOrigin(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  const active = document.activeElement
  if (active instanceof HTMLElement && active !== document.body && active !== document.documentElement) return active
  if (lastFocused?.isConnected) return lastFocused
  return lastResolved?.isConnected ? lastResolved : null
}
