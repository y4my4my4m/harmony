/**
 * The app's one emoji info card (components/emoji/EmojiInfoHost.vue).
 *
 *   hover    desktop pointer rest on an emoji: no focus move, closes when the
 *            pointer leaves both the emoji and the card
 *   pinned   click or keyboard: a non-modal dialog that takes focus; Escape or
 *            an outside click closes it and focus returns to the emoji
 *   sheet    the same on the mobile layout or a long-press, as a modal bottom sheet
 */
import { computed, shallowRef } from 'vue'
import type { EmojiInfoTarget } from '@/utils/emojiInfoTarget'
import type { ReactionUser } from '@/utils/reactionUsers'
import { isMobileLayout } from '@/composables/useLayoutState'

export type EmojiInfoMode = 'hover' | 'pinned' | 'sheet'

export interface EmojiInfoReactions {
  /** Reaction count and reactors; read reactive state, so the card follows updates and profile loads. */
  count: () => number
  users: () => ReactionUser[]
  /** Opens the full list of who reacted. */
  onShowAll?: () => void
}

export interface EmojiInfoRequest {
  id: number
  target: EmojiInfoTarget
  anchor: HTMLElement
  mode: EmojiInfoMode
  reactions?: EmojiInfoReactions
}

/** How a reaction pill's card was asked for: pointer rest, right-click, keyboard, long-press. */
export type ReactionInfoVia = 'hover' | EmojiInfoOpenOptions['via']

export interface EmojiInfoOpenOptions {
  /** 'press' is a touch long-press: a sheet on every layout. */
  via: 'click' | 'keyboard' | 'press'
  reactions?: EmojiInfoReactions
}

/** Pointer rest before a hover card opens, ms. */
export const EMOJI_INFO_HOVER_DELAY_MS = 400
/** Time to move the pointer from the emoji into its card, ms. */
export const EMOJI_INFO_HOVER_GRACE_MS = 250

const request = shallowRef<EmojiInfoRequest | null>(null)
let nextId = 1
let openTimer: ReturnType<typeof setTimeout> | null = null
let closeTimer: ReturnType<typeof setTimeout> | null = null

function clearTimers(): void {
  if (openTimer) clearTimeout(openTimer)
  if (closeTimer) clearTimeout(closeTimer)
  openTimer = null
  closeTimer = null
}

/** True where a pointer hovers (a mouse or trackpad), not on touch screens. */
export function canHover(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches
}

export function openEmojiInfo(anchor: HTMLElement, target: EmojiInfoTarget, options: EmojiInfoOpenOptions): void {
  clearTimers()
  const current = request.value
  if (current && current.mode !== 'hover' && current.anchor === anchor && options.via === 'click') {
    request.value = null
    return
  }
  const mode: EmojiInfoMode = options.via === 'press' || isMobileLayout() ? 'sheet' : 'pinned'
  request.value = { id: nextId++, target, anchor, mode, reactions: options.reactions }
}

/** Pointer entered an emoji: a hover card after EMOJI_INFO_HOVER_DELAY_MS, unless a pinned card is open. */
export function hoverEmojiInfo(anchor: HTMLElement, target: EmojiInfoTarget, reactions?: EmojiInfoReactions): void {
  if (!canHover()) return
  const current = request.value
  if (current && current.mode !== 'hover') return
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = null
  if (current?.anchor === anchor) return
  if (openTimer) clearTimeout(openTimer)
  openTimer = setTimeout(() => {
    openTimer = null
    if (!anchor.isConnected) return
    const now = request.value
    if (now && now.mode !== 'hover') return
    request.value = { id: nextId++, target, anchor, mode: 'hover', reactions }
  }, current ? 0 : EMOJI_INFO_HOVER_DELAY_MS)
}

/** Pointer left an emoji or the hover card. */
export function leaveEmojiInfo(): void {
  if (openTimer) clearTimeout(openTimer)
  openTimer = null
  if (request.value?.mode !== 'hover' || closeTimer) return
  closeTimer = setTimeout(() => {
    closeTimer = null
    if (request.value?.mode === 'hover') request.value = null
  }, EMOJI_INFO_HOVER_GRACE_MS)
}

/** Pointer entered the hover card. */
export function holdEmojiInfo(): void {
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = null
}

/** Closes a hover card; a pinned card or sheet stays. */
export function dismissHoverEmojiInfo(): void {
  if (openTimer) clearTimeout(openTimer)
  openTimer = null
  if (request.value?.mode === 'hover') closeEmojiInfo()
}

export function closeEmojiInfo(): void {
  clearTimers()
  request.value = null
}

const current = computed(() => request.value)

export function useEmojiInfo() {
  return {
    request: current,
    open: openEmojiInfo,
    hover: hoverEmojiInfo,
    leave: leaveEmojiInfo,
    hold: holdEmojiInfo,
    close: closeEmojiInfo,
  }
}
