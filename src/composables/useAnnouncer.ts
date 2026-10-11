/**
 * Screen-reader announcements through two persistent live regions (polite and
 * assertive) rendered once by components/a11y/LiveAnnouncer.vue in App.vue.
 * Live regions that appear together with their text are announced unreliably
 * (VoiceOver, TalkBack); these regions exist from app start and only their text
 * changes.
 *
 *   const { polite, assertive, announce } = useAnnouncer()
 *   polite(t('chat.messageSent'))
 *   assertive(t('voice.disconnected'))
 *   announce(t('voice.speaking', { name }), { verbose: true, key: 'speaking' })
 *
 * Options:
 *   politeness  'polite' (default) | 'assertive'
 *   verbose     dropped unless the "Screen reader support" appearance setting
 *               is on (setVerboseAnnouncements): typing, speakers, presence.
 *   key         a pending announcement with the same key is replaced, so a
 *               burst of updates speaks the latest only.
 *   dedupeMs    identical text within this window is dropped. Default 1000.
 *
 * Throttle: announcements are collected for THROTTLE_MS and spoken together,
 * joined by ". "; at most MAX_JOINED per flush, the rest summarised by count.
 * Text is cleared CLEAR_MS after it is written so browse mode does not find
 * stale text and the next identical message is spoken again.
 */

import { ref } from 'vue'

export type Politeness = 'polite' | 'assertive'

export interface AnnounceOptions {
  politeness?: Politeness
  verbose?: boolean
  key?: string
  dedupeMs?: number
}

/** Collection window before a flush, ms. */
export const THROTTLE_MS = 150
/** Gap between clearing a region and writing it, ms; same-text repeats need the change. */
export const WRITE_DELAY_MS = 50
/** Region text lifetime, ms. */
export const CLEAR_MS = 7000
export const MAX_JOINED = 4

interface Pending {
  text: string
  key?: string
}

const politeText = ref('')
const assertiveText = ref('')
const verboseEnabled = ref(false)

const pending: Record<Politeness, Pending[]> = { polite: [], assertive: [] }
const recent = new Map<string, number>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
const writeTimers: Record<Politeness, ReturnType<typeof setTimeout> | null> = { polite: null, assertive: null }
const clearTimers: Record<Politeness, ReturnType<typeof setTimeout> | null> = { polite: null, assertive: null }
let moreLabel: (count: number) => string = (count) => `${count} more`

const regionFor = (politeness: Politeness) => (politeness === 'assertive' ? assertiveText : politeText)

function write(politeness: Politeness, text: string) {
  const region = regionFor(politeness)
  if (writeTimers[politeness]) clearTimeout(writeTimers[politeness]!)
  if (clearTimers[politeness]) clearTimeout(clearTimers[politeness]!)
  region.value = ''
  writeTimers[politeness] = setTimeout(() => {
    writeTimers[politeness] = null
    region.value = text
    clearTimers[politeness] = setTimeout(() => {
      clearTimers[politeness] = null
      region.value = ''
    }, CLEAR_MS)
  }, WRITE_DELAY_MS)
}

function flush() {
  flushTimer = null
  for (const politeness of ['assertive', 'polite'] as const) {
    const items = pending[politeness]
    if (items.length === 0) continue
    pending[politeness] = []
    const head = items.slice(0, MAX_JOINED).map((p) => p.text)
    const rest = items.length - head.length
    if (rest > 0) head.push(moreLabel(rest))
    write(politeness, head.join('. '))
  }
}

export function announce(text: string, options: AnnounceOptions = {}): void {
  const message = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!message) return
  if (options.verbose && !verboseEnabled.value) return
  const now = Date.now()
  const dedupeMs = options.dedupeMs ?? 1000
  for (const [key, at] of recent) if (now - at > 10_000) recent.delete(key)
  const last = recent.get(message)
  if (dedupeMs > 0 && last !== undefined && now - last < dedupeMs) return
  recent.set(message, now)

  const politeness = options.politeness ?? 'polite'
  const queue = pending[politeness]
  const same = options.key ? queue.findIndex((p) => p.key === options.key) : -1
  if (same >= 0) queue.splice(same, 1, { text: message, key: options.key })
  else queue.push({ text: message, key: options.key })
  if (!flushTimer) flushTimer = setTimeout(flush, THROTTLE_MS)
}

/** Gates `verbose` announcements; driven by the appearance setting. */
export function setVerboseAnnouncements(enabled: boolean): void {
  verboseEnabled.value = enabled
}

/** Localised "N more" for overflowing flushes; set once i18n is ready. */
export function setAnnouncerMoreLabel(label: (count: number) => string): void {
  moreLabel = label
}

/** Region state for LiveAnnouncer.vue. */
export function announcerRegions() {
  return { politeText, assertiveText }
}

/** Drops pending and visible text; for tests and sign-out. */
export function resetAnnouncer(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  for (const politeness of ['polite', 'assertive'] as const) {
    pending[politeness] = []
    if (writeTimers[politeness]) clearTimeout(writeTimers[politeness]!)
    if (clearTimers[politeness]) clearTimeout(clearTimers[politeness]!)
    writeTimers[politeness] = null
    clearTimers[politeness] = null
  }
  recent.clear()
  politeText.value = ''
  assertiveText.value = ''
}

export function useAnnouncer() {
  return {
    announce,
    polite: (text: string, options: Omit<AnnounceOptions, 'politeness'> = {}) => announce(text, { ...options, politeness: 'polite' }),
    assertive: (text: string, options: Omit<AnnounceOptions, 'politeness'> = {}) => announce(text, { ...options, politeness: 'assertive' }),
    verboseEnabled,
  }
}
