/**
 * The chat card of a Drive link draws what drive_file_card answers: a reader with access sees
 * the file (a thumbnail for images, a player for video and audio, else an icon) with its name
 * and size; a reader without sees a restricted card naming nothing of the file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import type { DriveFileCard } from '@/services/drive/driveService'
import DriveLinkCard, { forgetDriveCards } from '../DriveLinkCard.vue'

const { getDriveFileCard, push } = vi.hoisted(() => ({ getDriveFileCard: vi.fn(), push: vi.fn() }))

vi.mock('@/services/drive/driveService', () => ({
  getDriveFileCard,
  driveDownloadUrl: vi.fn(async () => 'https://storage.test/download'),
  driveLinkContentUrl: (token: string, download = false) =>
    `/api/federation/drive/link/${token}${download ? '?download=1' : ''}`,
}))
vi.mock('@/components/drive/driveFormat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/drive/driveFormat')>()),
  driveMediaSource: (file: { path: string }) => `https://storage.test/sign/${file.path}`,
  driveThumbnail: (file: { path: string; kind: string }) =>
    (file.kind === 'image' ? `https://storage.test/thumb/${file.path}` : undefined),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'reader-1' } } }) }))
vi.mock('@/composables/useVideoPlayerPreference', () => ({ useNativeVideoControls: () => ref(true) }))
const openLightbox = vi.fn()
vi.mock('@/composables/useLightbox', () => {
  const open = (...args: unknown[]) => openLightbox(...args)
  return { openLightbox: open, useLightbox: () => ({ open }) }
})

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/VideoControls.vue', () => stub('VideoControls'))

const FILE_ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b'
const TOKEN = 'h5KAj-hPSm5hwCpMfeKM8aZl'

function fileCard(extra: Record<string, unknown> = {}): DriveFileCard {
  return {
    access: true, via: 'file', id: FILE_ID, bucket: 'message_media', path: `u/owner/${FILE_ID}.png`,
    name: 'holiday.png', mime_type: 'image/png', kind: 'image', size_bytes: 2048, state: 'drive',
    gone_reason: null, expires_at: null, created_at: '2026-10-20T00:00:00Z', own: false,
    owner: { id: 'owner', username: 'alice', display_name: 'Alice', avatar_url: null, domain: null },
    ...extra,
  } as DriveFileCard
}

async function render(answer: DriveFileCard, link: { kind: 'file'; id: string } | { kind: 'token'; token: string } = { kind: 'file', id: FILE_ID }) {
  getDriveFileCard.mockResolvedValue(answer)
  const wrapper = mount(DriveLinkCard, { props: { link, url: 'https://harmony.test/x' } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  forgetDriveCards()
  getDriveFileCard.mockReset()
  push.mockReset()
})

describe('DriveLinkCard', () => {
  it('asks drive_file_card by id for a /drive/file/ link and by token for a /d/ link', async () => {
    await render(fileCard())
    expect(getDriveFileCard).toHaveBeenLastCalledWith({ fileId: FILE_ID })
    forgetDriveCards()
    await render({ access: false }, { kind: 'token', token: TOKEN })
    expect(getDriveFileCard).toHaveBeenLastCalledWith({ token: TOKEN })
  })

  it('shows an image as its thumbnail, with name and size', async () => {
    const wrapper = await render(fileCard())
    expect(wrapper.attributes('data-state')).toBe('ready')
    expect(wrapper.find('[data-testid="drive-card-image"] img').attributes('src'))
      .toBe(`https://storage.test/thumb/u/owner/${FILE_ID}.png`)
    expect(wrapper.find('[data-testid="drive-card-name"]').text()).toBe('holiday.png')
    expect(wrapper.text()).toContain('2 KB')
  })

  it('opens an image in the lightbox at its full source', async () => {
    const wrapper = await render(fileCard())
    await wrapper.find('[data-testid="drive-card-image"]').trigger('click')
    expect(openLightbox).toHaveBeenCalledWith([
      { url: `https://storage.test/sign/u/owner/${FILE_ID}.png`, type: 'image', name: 'holiday.png', alt: 'holiday.png' },
    ])
  })

  it('plays video and audio inline', async () => {
    const video = await render(fileCard({ kind: 'video', mime_type: 'video/mp4', name: 'clip.mp4', path: 'u/owner/clip.mp4' }))
    expect(video.find('[data-testid="drive-card-video"] video').attributes('src')).toBe('https://storage.test/sign/u/owner/clip.mp4')
    forgetDriveCards()
    const audio = await render(fileCard({ kind: 'audio', mime_type: 'audio/mpeg', name: 'song.mp3', path: 'u/owner/song.mp3' }))
    expect(audio.find('audio[data-testid="drive-card-audio"]').attributes('src')).toBe('https://storage.test/sign/u/owner/song.mp3')
  })

  it('draws any other file as an icon with its name', async () => {
    const wrapper = await render(fileCard({ kind: 'document', mime_type: 'application/pdf', name: 'plan.pdf' }))
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('video').exists()).toBe(false)
    expect(wrapper.find('[data-testid="drive-card-name"]').text()).toBe('plan.pdf')
  })

  it('plays a link-shared file through the backend link route', async () => {
    const wrapper = await render({
      access: true, via: 'link', name: 'clip.webm', mime_type: 'video/webm', kind: 'video', size_bytes: 10,
      created_at: '2026-10-20T00:00:00Z', expires_at: null, owner: null,
    }, { kind: 'token', token: TOKEN })
    expect(wrapper.find('video').attributes('src')).toBe(`/api/federation/drive/link/${TOKEN}`)
  })

  it('shows a restricted card with nothing of the file to a reader without access', async () => {
    const wrapper = await render({ access: false })
    expect(wrapper.attributes('data-state')).toBe('restricted')
    expect(wrapper.find('[data-testid="drive-card-restricted"]').exists()).toBe(true)
    expect(wrapper.text()).toBe('drive.card.restrictedTitledrive.card.restrictedText')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('a').exists()).toBe(false)
  })

  it('shows a restricted card when the lookup fails, and asks again on the next mount', async () => {
    getDriveFileCard.mockRejectedValueOnce(new Error('offline'))
    const failed = mount(DriveLinkCard, { props: { link: { kind: 'file', id: FILE_ID }, url: 'x' } })
    await flushPromises()
    expect(failed.attributes('data-state')).toBe('restricted')
    await render(fileCard())
    expect(getDriveFileCard).toHaveBeenCalledTimes(2)
  })

  it('opens the file page in the app', async () => {
    const wrapper = await render(fileCard())
    await wrapper.find('[data-testid="drive-card-open"]').trigger('click')
    expect(push).toHaveBeenCalledWith(`/drive/file/${FILE_ID}`)
  })

  it('tells the owner a deleted file is gone', async () => {
    const wrapper = await render(fileCard({ state: 'gone', gone_reason: 'deleted', own: true }))
    expect(wrapper.attributes('data-state')).toBe('gone')
    expect(wrapper.find('img').exists()).toBe(false)
  })
})
