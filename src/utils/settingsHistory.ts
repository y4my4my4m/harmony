// History of the full-screen User settings view.
//
// Every entry Settings shows carries SETTINGS_STATE_KEY in history.state: `base` is the
// history.state.position of the first Settings entry, `inApp` whether an entry of this app
// lies under it (vue-router's state.back is null in a tab that opened on Settings).
// Leaving Settings goes back past every Settings entry, overlay entries above them
// included; with nothing of the app under them it replaces the base entry with a chat route.

import type { InjectionKey } from 'vue'
import type { Router } from 'vue-router'
import { overlayHistorySettled } from '@/utils/overlayHistory'

export const SETTINGS_STATE_KEY = 'harmonySettings'

export interface SettingsEntry {
  base: number
  inApp: boolean
}

function asRecord(state: unknown): Record<string, unknown> | null {
  return state && typeof state === 'object' ? (state as Record<string, unknown>) : null
}

function positionOf(state: unknown): number | null {
  const position = asRecord(state)?.position
  return typeof position === 'number' ? position : null
}

/** The Settings stack an entry belongs to; an unmarked entry is the first one. */
export function settingsEntryOf(state: unknown): SettingsEntry {
  const record = asRecord(state)
  const kept = asRecord(record?.[SETTINGS_STATE_KEY])
  if (kept && typeof kept.base === 'number' && typeof kept.inApp === 'boolean') {
    return { base: kept.base, inApp: kept.inApp }
  }
  return { base: positionOf(state) ?? 0, inApp: typeof record?.back === 'string' }
}

/** `state` with `entry` recorded, or null when it already carries it. */
export function markedState(state: unknown, entry: SettingsEntry): Record<string, unknown> | null {
  const record = asRecord(state)
  if (!record) return null
  const kept = asRecord(record[SETTINGS_STATE_KEY])
  if (kept && kept.base === entry.base && kept.inApp === entry.inApp) return null
  return { ...record, [SETTINGS_STATE_KEY]: { ...entry } }
}

export type SettingsExit =
  /** history.go(delta) lands on the entry under Settings. */
  | { kind: 'back'; delta: number }
  /** history.go(delta) (none when 0) lands on the base entry, which is then replaced. */
  | { kind: 'replace'; delta: number }

/** How to leave Settings from the entry whose history.state is `state`. */
export function settingsExit(entry: SettingsEntry, state: unknown): SettingsExit {
  const position = positionOf(state)
  const above = position === null || position < entry.base ? 0 : position - entry.base
  return entry.inApp ? { kind: 'back', delta: -(above + 1) } : { kind: 'replace', delta: -above }
}

/**
 * Goes back past every Settings entry; a tab that opened on Settings lands on chat. The
 * position is read once closed overlays (a discard prompt) have dropped their entries: a
 * go() issued before that popstate lands applies on top of it.
 */
export async function leaveSettings(router: Router, entry: SettingsEntry): Promise<void> {
  await overlayHistorySettled()
  const exit = settingsExit(entry, window.history.state)
  if (exit.kind === 'back') {
    router.go(exit.delta)
    return
  }
  if (exit.delta === 0) {
    void router.replace({ name: 'Chat' })
    return
  }
  // A traversal that lands elsewhere, or never lands, leaves the next navigation alone.
  const stop = router.afterEach(() => {
    stop()
    if (positionOf(window.history.state) === entry.base) void router.replace({ name: 'Chat' })
  })
  router.go(exit.delta)
}

/** Leaves User settings; resolves false when the user chose to stay (unsaved edits). */
export const CLOSE_USER_SETTINGS: InjectionKey<() => Promise<boolean>> = Symbol('closeUserSettings')
