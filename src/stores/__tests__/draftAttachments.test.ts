/**
 * Draft attachments per account and draft key: lists of different drafts never mix, another
 * account's drafts are dropped and freed, completed uploads are stored for a reload and come
 * back signed, and expired or deleted objects do not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import type { FilePreviewData } from '@/components/FilePreview.vue'

const { forgetMessageMediaUpload, compatUrlFor } = vi.hoisted(() => ({
  forgetMessageMediaUpload: vi.fn(),
  compatUrlFor: vi.fn(async (path: string) => `https://signed/${path}`),
}))

vi.mock('@/services/messageMediaUpload', () => ({ forgetMessageMediaUpload }))
vi.mock('@/services/privateMedia', () => ({
  compatUrlFor,
  messageMediaReferenceUrl: (path: string) => `https://ref/${path}`,
}))

import { userStorage } from '@/utils/userScopedStorage'
import {
  RESTORE_MAX_AGE_MS,
  addDraftAttachments,
  discardDraftAttachments,
  draftAttachmentShown,
  draftAttachments,
  holdsDraftAttachment,
  localDraftKey,
  openDraftAttachments,
  removeDraftAttachment,
  resetDraftAttachments,
  setDraftAttachments,
} from '../draftAttachments'

const STORED = 'message-draft-attachments'
const A = 'channel:aaaaaaaa-0000-4000-8000-00000000000a'
const B = 'channel:bbbbbbbb-0000-4000-8000-00000000000b'

const attachment = (name: string, extra: Partial<FilePreviewData> = {}): FilePreviewData => ({
  file: new File(['x'], name, { type: 'image/png' }),
  name,
  size: 1,
  type: 'image/png',
  preview: `blob:${name}`,
  uploadStatus: 'pending',
  ...extra,
})

const completed = (name: string, path: string, extra: Partial<FilePreviewData> = {}) =>
  attachment(name, { uploadStatus: 'completed', uploadProgress: 100, uploadedPath: path, uploadedUrl: `https://signed/${path}`, ...extra })

const stored = () => JSON.parse(userStorage.getItem(STORED) || 'null')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  resetDraftAttachments()
  localStorage.clear()
  userStorage.setCurrentUser('user-1')
  URL.revokeObjectURL = vi.fn()
  forgetMessageMediaUpload.mockClear()
  compatUrlFor.mockClear()
  compatUrlFor.mockImplementation(async (path: string) => `https://signed/${path}`)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('draft attachment lists', () => {
  it('keeps one list per draft key', () => {
    addDraftAttachments(A, [attachment('a.png')])
    addDraftAttachments(B, [attachment('b.png')])
    addDraftAttachments(A, [attachment('a2.png')])

    expect(draftAttachments(A).map((f) => f.name)).toEqual(['a.png', 'a2.png'])
    expect(draftAttachments(B).map((f) => f.name)).toEqual(['b.png'])
    expect(draftAttachments('channel:none')).toEqual([])

    setDraftAttachments(A, [])
    expect(draftAttachments(A)).toEqual([])
    expect(draftAttachments(B)).toHaveLength(1)
  })

  it('writes through the list reach the stored file', () => {
    const file = attachment('a.png')
    addDraftAttachments(A, [file])
    draftAttachments(A)[0].altText = 'a cat'
    expect(file.altText).toBe('a cat')
  })

  it('knows which files a draft holds and whether a composer shows it', () => {
    const file = attachment('a.png')
    addDraftAttachments(A, [file])
    expect(holdsDraftAttachment(file)).toBe(true)
    expect(draftAttachmentShown(file)).toBe(false)

    const close = openDraftAttachments(A)
    expect(draftAttachmentShown(file)).toBe(true)
    const closeAgain = openDraftAttachments(A)
    close()
    close()
    expect(draftAttachmentShown(file)).toBe(true)
    closeAgain()
    expect(draftAttachmentShown(file)).toBe(false)

    setDraftAttachments(A, [])
    expect(holdsDraftAttachment(file)).toBe(false)
  })

  it('discarding a draft revokes its object URLs and aborts its uploads', () => {
    const abort = vi.fn()
    addDraftAttachments(A, [attachment('a.png', { upload: { path: 'c/a/u/1.png', abort } as never })])

    discardDraftAttachments(A)

    expect(draftAttachments(A)).toEqual([])
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:a.png')
    expect(abort).toHaveBeenCalled()
    expect(forgetMessageMediaUpload).toHaveBeenCalledWith('c/a/u/1.png')
  })

  it('takes one attachment out of the draft holding it, wherever that draft is', () => {
    const kept = attachment('kept.png')
    const cancelled = attachment('cancelled.png', { upload: { path: 'c/a/u/2.png', abort: vi.fn() } as never })
    addDraftAttachments(A, [kept, cancelled])
    addDraftAttachments(B, [attachment('other.png')])

    removeDraftAttachment(draftAttachments(A)[1])

    expect(draftAttachments(A).map((f) => f.name)).toEqual(['kept.png'])
    expect(draftAttachments(B).map((f) => f.name)).toEqual(['other.png'])
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:cancelled.png')
    expect(forgetMessageMediaUpload).toHaveBeenCalledWith('c/a/u/2.png')
    removeDraftAttachment(cancelled)
    expect(draftAttachments(A)).toHaveLength(1)
  })

  it('gives every composer without a draft a key of its own', () => {
    expect(localDraftKey()).not.toBe(localDraftKey())
  })
})

describe('accounts', () => {
  it('never shows one account the drafts of another, and frees them when another opens', () => {
    openDraftAttachments(A)()
    addDraftAttachments(A, [attachment('mine.png')])

    userStorage.setCurrentUser('user-2')
    expect(draftAttachments(A)).toEqual([])

    openDraftAttachments(A)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mine.png')
    userStorage.setCurrentUser('user-1')
    expect(draftAttachments(A)).toEqual([])
  })
})

describe('storage for a reload', () => {
  it('stores completed uploads of keyed drafts only', async () => {
    openDraftAttachments(A)
    addDraftAttachments(A, [
      completed('SPOILER_a.png', 'c/a/u/1.png', { altText: 'a cat', temporary: true }),
      attachment('running.png', { uploadStatus: 'uploading' }),
    ])
    addDraftAttachments(localDraftKey(), [completed('local.png', 'c/a/u/2.png')])
    await flushPromises()
    const savedAt = Date.now() + 500
    vi.advanceTimersByTime(600)

    expect(stored()).toEqual({
      [A]: [{
        name: 'SPOILER_a.png',
        type: 'image/png',
        size: 1,
        path: 'c/a/u/1.png',
        savedAt,
        altText: 'a cat',
        temporary: true,
      }],
    })

    setDraftAttachments(A, [])
    await flushPromises()
    vi.advanceTimersByTime(600)
    expect(stored()).toBeNull()
  })

  it('writes nothing before the account has opened a draft', async () => {
    userStorage.setItem(STORED, JSON.stringify({ [B]: [{ name: 'b.png', type: 'image/png', size: 1, path: 'c/b/u/1.png', savedAt: Date.now() }] }))
    addDraftAttachments(A, [completed('a.png', 'c/a/u/1.png')])
    await flushPromises()
    vi.advanceTimersByTime(600)

    expect(Object.keys(stored())).toEqual([B])
  })

  it('restores stored uploads on the first open, signed, and drops expired or deleted ones', async () => {
    const now = Date.now()
    userStorage.setItem(STORED, JSON.stringify({
      [A]: [
        { name: 'kept.png', type: 'image/png', size: 7, path: 'c/a/u/kept.png', savedAt: now - 1000, altText: 'alt' },
        { name: 'old.png', type: 'image/png', size: 7, path: 'c/a/u/old.png', savedAt: now - RESTORE_MAX_AGE_MS - 1 },
        { name: 'gone.png', type: 'image/png', size: 7, path: 'c/a/u/gone.png', savedAt: now - 1000 },
      ],
      [B]: [{ name: 'doc.pdf', type: 'application/pdf', size: 9, path: 'c/b/u/doc.pdf', savedAt: now - 1000, fromDrive: true }],
      junk: [{ name: 1 }],
    }))
    compatUrlFor.mockImplementation(async (path: string) =>
      path.endsWith('gone.png') ? `https://ref/${path}` : `https://signed/${path}`)

    openDraftAttachments(A)
    expect(draftAttachments(A).map((f) => f.name)).toEqual(['kept.png', 'gone.png'])
    expect(draftAttachments(A)[0]).toMatchObject({ uploadStatus: 'completed', uploadedUrl: 'https://ref/c/a/u/kept.png' })

    await flushPromises()

    expect(draftAttachments(A)).toHaveLength(1)
    expect(draftAttachments(A)[0]).toMatchObject({
      name: 'kept.png',
      size: 7,
      altText: 'alt',
      uploadStatus: 'completed',
      uploadedPath: 'c/a/u/kept.png',
      uploadedUrl: 'https://signed/c/a/u/kept.png',
      preview: 'https://signed/c/a/u/kept.png',
    })
    expect(draftAttachments(B)[0]).toMatchObject({ name: 'doc.pdf', fromDrive: true, uploadedUrl: 'https://signed/c/b/u/doc.pdf' })
    expect(draftAttachments(B)[0].preview).toBeUndefined()
    expect(draftAttachments('junk')).toEqual([])

    // The restore happens once per account and session.
    setDraftAttachments(A, [])
    openDraftAttachments(A)
    expect(draftAttachments(A)).toEqual([])
  })

  it('keeps the first save time of a restored upload', async () => {
    const savedAt = Date.now() - 5000
    userStorage.setItem(STORED, JSON.stringify({ [A]: [{ name: 'a.png', type: 'image/png', size: 1, path: 'c/a/u/a.png', savedAt }] }))
    openDraftAttachments(A)
    await flushPromises()
    vi.advanceTimersByTime(600)

    expect(stored()[A][0].savedAt).toBe(savedAt)
  })

  it('keeps what a photo carried, the keep choice and its Drive source across a reload', async () => {
    openDraftAttachments(A)
    addDraftAttachments(A, [
      completed('IMG.jpg', 'c/a/u/IMG.jpg', { photoDetails: { container: 'jpeg', location: true, details: true }, keepDetails: false }),
      completed('beach.jpg', 'u/u/beach.jpg', {
        fromDrive: true, driveSource: 'u/u/beach.jpg', photoDetails: { container: null, location: true, details: true }, keepDetails: true,
      }),
      completed('plain.png', 'c/a/u/plain.png'),
    ])
    await flushPromises()
    vi.advanceTimersByTime(600)
    expect(stored()[A].map((e: Record<string, unknown>) => [e.photo, e.keepDetails, e.driveSource])).toEqual([
      [{ location: true, details: true }, false, undefined],
      [{ location: true, details: true }, true, 'u/u/beach.jpg'],
      [undefined, undefined, undefined],
    ])

    resetDraftAttachments()
    userStorage.setItem(STORED, JSON.stringify({
      ...stored(),
      [B]: [{ name: 'odd.jpg', type: 'image/jpeg', size: 1, path: 'c/b/u/odd.jpg', savedAt: Date.now(), photo: { location: 'yes' }, keepDetails: 'no' }],
    }))
    openDraftAttachments(A)
    expect(draftAttachments(A).map((f) => [f.photoDetails, f.keepDetails, f.driveSource])).toEqual([
      [{ container: null, location: true, details: true }, false, undefined],
      [{ container: null, location: true, details: true }, true, 'u/u/beach.jpg'],
      [undefined, undefined, undefined],
    ])
    expect(draftAttachments(B)[0]).not.toHaveProperty('photoDetails')
    expect(draftAttachments(B)[0]).not.toHaveProperty('keepDetails')
  })
})
