import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { THROTTLE_MS, WRITE_DELAY_MS, announcerRegions, resetAnnouncer } from '../useAnnouncer'
import {
  NEW_MESSAGE_BATCH_MS,
  NEW_MESSAGE_SETTING_KEY,
  createNewMessageAnnouncer,
  useNewMessageAnnouncementSetting,
} from '../useNewMessageAnnouncer'

const { politeText, assertiveText } = announcerRegions()
const t = (key: string, params?: Record<string, unknown>) =>
  key === 'messageA11y.announce.one' ? `${params?.name}: ${params?.text}` : `${params?.count} new messages from ${params?.names}`

/** Past the batch window, the announcer's flush and its clear-then-write. */
function settle() {
  vi.advanceTimersByTime(NEW_MESSAGE_BATCH_MS + THROTTLE_MS + WRITE_DELAY_MS + 1)
}

beforeEach(() => {
  vi.useFakeTimers()
  resetAnnouncer()
  useNewMessageAnnouncementSetting().setEnabled(true)
})

afterEach(() => {
  resetAnnouncer()
  vi.useRealTimers()
  localStorage.removeItem(NEW_MESSAGE_SETTING_KEY)
})

describe('createNewMessageAnnouncer', () => {
  it('speaks one arrival politely with its author', () => {
    const announcer = createNewMessageAnnouncer(t)
    announcer.push([{ authorName: 'Alice', text: 'hello' }])
    expect(politeText.value).toBe('')
    settle()
    expect(politeText.value).toBe('Alice: hello')
    expect(assertiveText.value).toBe('')
  })

  it('folds a burst inside the window into one summary', () => {
    const announcer = createNewMessageAnnouncer(t)
    announcer.push([{ authorName: 'Alice', text: 'a' }])
    vi.advanceTimersByTime(NEW_MESSAGE_BATCH_MS / 2)
    announcer.push([{ authorName: 'Bob', text: 'b' }, { authorName: 'Alice', text: 'c' }])
    settle()
    expect(politeText.value).toBe('3 new messages from Alice, Bob')
  })

  it('stays silent while the setting is off, and remembers it', () => {
    const setting = useNewMessageAnnouncementSetting()
    setting.setEnabled(false)
    expect(localStorage.getItem(NEW_MESSAGE_SETTING_KEY)).toBe('false')
    const announcer = createNewMessageAnnouncer(t)
    announcer.push([{ authorName: 'Alice', text: 'hello' }])
    settle()
    expect(politeText.value).toBe('')
  })

  it('drops what it collected on cancel', () => {
    const announcer = createNewMessageAnnouncer(t)
    announcer.push([{ authorName: 'Alice', text: 'hello' }])
    announcer.cancel()
    settle()
    expect(politeText.value).toBe('')
  })
})
