/**
 * Live announcements of messages arriving in the open channel, conversation or
 * thread.
 *
 *   const announcer = createNewMessageAnnouncer(t)
 *   announcer.push([{ authorName: 'Alice', text: 'hi' }])
 *
 * Messages pushed within NEW_MESSAGE_BATCH_MS are spoken as one polite
 * announcement: "Alice: hi" for one, "3 new messages from Alice, Bob" for a
 * burst. The caller leaves out its own messages. The per-device setting
 * (useNewMessageAnnouncementSetting) turns it off; it is on by default, not
 * gated by "Screen reader support", because the live region is silent unless a
 * screen reader is listening.
 */

import { ref } from 'vue'
import { announce } from '@/composables/useAnnouncer'
import { summarizeIncoming, type IncomingMessage, type Translate } from '@/utils/a11y/messageSpeech'

export const NEW_MESSAGE_SETTING_KEY = 'harmony.a11y.announceNewMessages'

/** Collection window for one announcement, ms. */
export const NEW_MESSAGE_BATCH_MS = 800

function readSetting(): boolean {
  try {
    return localStorage.getItem(NEW_MESSAGE_SETTING_KEY) !== 'false'
  } catch {
    return true
  }
}

const enabled = ref(readSetting())

export function useNewMessageAnnouncementSetting() {
  const setEnabled = (value: boolean) => {
    enabled.value = value
    try {
      localStorage.setItem(NEW_MESSAGE_SETTING_KEY, value ? 'true' : 'false')
    } catch {
      /* private mode: the setting lasts for the session */
    }
  }
  return { enabled, setEnabled }
}

let instances = 0

export function createNewMessageAnnouncer(t: Translate, batchMs = NEW_MESSAGE_BATCH_MS) {
  const key = `new-messages-${++instances}`
  let pending: IncomingMessage[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    timer = null
    const items = pending
    pending = []
    if (!enabled.value) return
    const text = summarizeIncoming(items, t)
    if (text) announce(text, { politeness: 'polite', key, dedupeMs: 0 })
  }

  return {
    push(items: IncomingMessage[]) {
      if (!enabled.value || items.length === 0) return
      pending.push(...items)
      if (!timer) timer = setTimeout(flush, batchMs)
    },
    /** Drops what is collected; for a context switch or unmount. */
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
      pending = []
    },
  }
}
