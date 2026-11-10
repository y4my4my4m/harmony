/**
 * Thread composer drafts: a created thread keys on its id, one not created yet on its starter
 * message. A thread with an empty draft takes over its starter's text and attachments; one with
 * its own draft, or with text typed before its starter is known, keeps what it has.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, reactive, type EffectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { FilePreviewData } from '@/components/FilePreview.vue'

vi.mock('@/services/messageMediaUpload', () => ({ forgetMessageMediaUpload: vi.fn() }))
vi.mock('@/services/privateMedia', () => ({
  compatUrlFor: vi.fn(async (path: string) => `https://signed/${path}`),
  messageMediaReferenceUrl: (path: string) => `https://ref/${path}`,
}))

import { userStorage } from '@/utils/userScopedStorage'
import { useDraftsStore } from '@/stores/drafts'
import { addDraftAttachments, draftAttachments, resetDraftAttachments } from '@/stores/draftAttachments'
import { useThreadDraft, type ThreadDraftSource } from '../useThreadDraft'

const STARTER = 'mmmmmmmm-0000-4000-8000-00000000000m'
const THREAD = 'tttttttt-0000-4000-8000-00000000000t'
const OTHER = 'oooooooo-0000-4000-8000-00000000000o'

const file = (name: string): FilePreviewData => ({
  file: new File(['x'], name, { type: 'text/plain' }),
  name,
  size: 1,
  type: 'text/plain',
  uploadStatus: 'completed',
  uploadProgress: 100,
  uploadedPath: `p/${name}`,
})

let scope: EffectScope

function mount(initial: ThreadDraftSource) {
  const source = reactive<ThreadDraftSource>({ ...initial })
  scope = effectScope()
  const draft = scope.run(() => useThreadDraft(() => source))!
  return { source, ...draft }
}

beforeEach(() => {
  localStorage.clear()
  userStorage.setCurrentUser('user-1')
  resetDraftAttachments()
  setActivePinia(createPinia())
})

afterEach(() => scope?.stop())

describe('useThreadDraft', () => {
  it('keys a created thread on its id and a new one on its starter', () => {
    expect(mount({ threadId: THREAD }).key.value).toBe(`thread:${THREAD}`)
    scope.stop()
    expect(mount({ parentMessageId: STARTER }).key.value).toBe(`thread:new:${STARTER}`)
    scope.stop()
    expect(mount({}).key.value).toBeNull()
  })

  it('keeps each thread its own text across a switch', async () => {
    const { source, text } = mount({ threadId: THREAD })
    text.value = 'for the first'
    await nextTick()
    source.threadId = OTHER
    await nextTick()
    expect(text.value).toBe('')
    source.threadId = THREAD
    await nextTick()
    expect(text.value).toBe('for the first')
    expect(useDraftsStore().getDraft(`thread:${OTHER}`)).toBe('')
  })

  it('keeps a new thread\'s text with its starter through a close', async () => {
    const { source, text } = mount({ parentMessageId: STARTER })
    text.value = 'opening'
    await nextTick()
    source.parentMessageId = null
    await nextTick()
    expect(text.value).toBe('')
    source.parentMessageId = STARTER
    await nextTick()
    expect(text.value).toBe('opening')
  })

  it('a created thread with an empty draft takes over its starter\'s draft', async () => {
    const drafts = useDraftsStore()
    const { source, text } = mount({ parentMessageId: STARTER })
    text.value = 'typed while it was created'
    addDraftAttachments(`thread:new:${STARTER}`, [file('a.txt')])
    await nextTick()

    source.threadId = THREAD
    await nextTick()
    expect(text.value).toBe('typed while it was created')
    expect(drafts.getDraft(`thread:${THREAD}`)).toBe('typed while it was created')
    expect(drafts.getDraft(`thread:new:${STARTER}`)).toBe('')
    expect(draftAttachments(`thread:${THREAD}`).map((f) => f.name)).toEqual(['a.txt'])
    expect(draftAttachments(`thread:new:${STARTER}`)).toHaveLength(0)
  })

  it('a thread with its own draft leaves the starter\'s draft alone', async () => {
    const drafts = useDraftsStore()
    drafts.saveDraft(`thread:new:${STARTER}`, 'old opening')
    drafts.saveDraft(`thread:${THREAD}`, 'reply in progress')
    const { text } = mount({ threadId: THREAD, parentMessageId: STARTER })
    await nextTick()
    expect(text.value).toBe('reply in progress')
    expect(drafts.getDraft(`thread:new:${STARTER}`)).toBe('old opening')
  })

  it('a starter learned after load is taken over only while nothing is typed', async () => {
    const drafts = useDraftsStore()
    drafts.saveDraft(`thread:new:${STARTER}`, 'from the panel')
    const typed = mount({ threadId: THREAD })
    typed.text.value = 'typed first'
    await nextTick()
    typed.source.parentMessageId = STARTER
    await nextTick()
    expect(typed.text.value).toBe('typed first')
    expect(drafts.getDraft(`thread:new:${STARTER}`)).toBe('from the panel')
    scope.stop()

    drafts.saveDraft(`thread:${THREAD}`, '')
    const empty = mount({ threadId: THREAD })
    await nextTick()
    empty.source.parentMessageId = STARTER
    await nextTick()
    expect(empty.text.value).toBe('from the panel')
    expect(drafts.getDraft(`thread:new:${STARTER}`)).toBe('')
  })
})
