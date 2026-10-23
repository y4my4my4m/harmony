/**
 * A Drive link draws what drive_file_card answers as a message attachment: an image or video
 * inline with the attachment markup, opening in the media viewer; audio in a player; any other
 * file as a file row with its size and a download. A reader without access gets one line naming
 * nothing of the file. /drive/file/<id> and /d/<token> links draw alike.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import type { DriveFileCard } from '@/services/drive/driveService'
import DriveLinkAttachment, { forgetDriveCards } from '../DriveLinkAttachment.vue'

const { getDriveFileCard, driveDownloadUrl, push, openLightbox, nativeControls, ensureMediaPartSources } = vi.hoisted(() => ({
  getDriveFileCard: vi.fn(),
  driveDownloadUrl: vi.fn(async () => 'https://storage.test/download'),
  push: vi.fn(),
  openLightbox: vi.fn(),
  nativeControls: { value: true },
  ensureMediaPartSources: vi.fn(async () => {}),
}))

vi.mock('@/services/drive/driveService', () => ({
  getDriveFileCard,
  driveDownloadUrl,
  driveLinkContentUrl: (token: string, download = false) =>
    `/api/federation/drive/link/${token}${download ? '?download=1' : ''}`,
  postMediaPublicUrl: (path: string) => `https://storage.test/public/user_media/${path}`,
}))
vi.mock('@/services/privateMedia', () => ({
  mediaPartSource: (part: { url?: string; path?: string } | null, variant = 'original') => {
    if (!part) return undefined
    if (part.path) return `https://storage.test/${variant === 'thumbnail' ? 'thumb' : 'sign'}/${part.path}`
    return part.url
  },
  ensureMediaPartSources,
  mediaPartGone: () => null,
  reportMediaPartError: vi.fn(),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'reader-1' } } }) }))
vi.mock('@/composables/useVideoPlayerPreference', () => ({ useNativeVideoControls: () => ref(nativeControls.value) }))
vi.mock('@/composables/useFloatingVideo', () => ({ useFloatingVideo: () => ({ notifyPlaybackStarted: vi.fn() }) }))
vi.mock('@/composables/useLightbox', () => {
  const open = (...args: unknown[]) => openLightbox(...args)
  return { openLightbox: open, useLightbox: () => ({ open }) }
})
vi.mock('@/components/common/Icon.vue', () => ({ default: defineComponent({ name: 'IconStub', render: () => h('i') }) }))
vi.mock('@/components/common/VideoControls.vue', () => ({
  default: defineComponent({
    name: 'VideoControls',
    emits: ['expand'],
    setup: (_, { emit }) => () => h('button', {
      class: 'video-controls-stub',
      onClick: (event: MouseEvent) => emit('expand', (event.currentTarget as HTMLElement).parentElement!.querySelector('video')),
    }),
  }),
}))
vi.mock('@/components/drive/DriveGoneFile.vue', () => ({
  default: defineComponent({ name: 'DriveGoneFile', props: ['reason', 'name', 'fileType'], render: () => h('div', { class: 'gone-stub' }) }),
}))

const FILE_ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b'
const TOKEN = 'h5KAj-hPSm5hwCpMfeKM8aZl'
type Link = { kind: 'file'; id: string } | { kind: 'token'; token: string }
const BY_ID: Link = { kind: 'file', id: FILE_ID }
const BY_TOKEN: Link = { kind: 'token', token: TOKEN }

function fileCard(extra: Record<string, unknown> = {}): DriveFileCard {
  return {
    access: true, via: 'file', id: FILE_ID, bucket: 'message_media', path: `u/owner/${FILE_ID}.png`,
    name: 'holiday.png', mime_type: 'image/png', kind: 'image', size_bytes: 2048, state: 'drive',
    gone_reason: null, expires_at: null, created_at: '2026-10-20T00:00:00Z', own: false,
    owner: { id: 'owner', username: 'alice', display_name: 'Alice', avatar_url: null, domain: null },
    ...extra,
  } as DriveFileCard
}

function linkCard(extra: Record<string, unknown> = {}): DriveFileCard {
  return {
    access: true, via: 'link', name: 'clip.webm', mime_type: 'video/webm', kind: 'video', size_bytes: 10,
    created_at: '2026-10-20T00:00:00Z', expires_at: null, owner: null,
    ...extra,
  } as DriveFileCard
}

async function render(answer: DriveFileCard, link: Link = BY_ID) {
  getDriveFileCard.mockResolvedValue(answer)
  const wrapper = mount(DriveLinkAttachment, { props: { link, url: 'https://harmony.test/x' }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  forgetDriveCards()
  getDriveFileCard.mockReset()
  driveDownloadUrl.mockClear()
  push.mockReset()
  openLightbox.mockReset()
  ensureMediaPartSources.mockClear()
  nativeControls.value = true
  document.body.innerHTML = ''
})

describe('DriveLinkAttachment', () => {
  it('asks drive_file_card by id for a /drive/file/ link and by token for a /d/ link', async () => {
    await render(fileCard())
    expect(getDriveFileCard).toHaveBeenLastCalledWith({ fileId: FILE_ID })
    forgetDriveCards()
    await render({ access: false }, BY_TOKEN)
    expect(getDriveFileCard).toHaveBeenLastCalledWith({ token: TOKEN })
  })

  it('draws an image as an image attachment: its thumbnail in the attachment frame, no card', async () => {
    const wrapper = await render(fileCard())
    const root = wrapper.find('[data-testid="drive-attachment"]')
    expect(root.attributes('data-state')).toBe('ready')
    expect(root.classes()).toEqual(expect.arrayContaining(['media-container', 'image-container']))
    const img = wrapper.find('.media-frame img.content-image')
    expect(img.attributes('src')).toBe(`https://storage.test/thumb/u/owner/${FILE_ID}.png`)
    expect(img.attributes('alt')).toBe('holiday.png')
    expect(wrapper.find('.media-frame button.media-open').exists()).toBe(true)
    expect(wrapper.find('.drive-card').exists()).toBe(false)
  })

  it('marks the attachment as a Drive file named in its tooltip, and opens it in Drive', async () => {
    const wrapper = await render(fileCard())
    const mark = wrapper.find('[data-testid="drive-attachment-mark"]')
    expect(mark.text()).toBe('drive.title')
    expect(mark.attributes('title')).toBe('holiday.png')
    await wrapper.find('[data-testid="drive-attachment-open"]').trigger('click')
    expect(push).toHaveBeenCalledWith(`/drive/file/${FILE_ID}`)
  })

  it('opens an image in the media viewer at its full source', async () => {
    const wrapper = await render(fileCard())
    await wrapper.find('img.content-image').trigger('click')
    await flushPromises()
    expect(ensureMediaPartSources).toHaveBeenCalledWith([{ path: `u/owner/${FILE_ID}.png` }])
    expect(openLightbox).toHaveBeenCalledWith(
      [{ url: `https://storage.test/sign/u/owner/${FILE_ID}.png`, type: 'image', name: 'holiday.png', alt: 'holiday.png' }],
      0,
      { origin: null },
    )
    openLightbox.mockReset()
    await wrapper.find('button.media-open').trigger('click')
    await flushPromises()
    expect(openLightbox).toHaveBeenCalledTimes(1)
  })

  it('plays a video inline and hands its player to the viewer', async () => {
    nativeControls.value = false
    const wrapper = await render(fileCard({ kind: 'video', mime_type: 'video/mp4', name: 'clip.mp4', path: 'u/owner/clip.mp4' }))
    expect(wrapper.find('[data-testid="drive-attachment"]').classes()).toContain('video-container')
    const video = wrapper.find('.media-frame video.content-video')
    expect(video.attributes('src')).toBe('https://storage.test/sign/u/owner/clip.mp4')
    await wrapper.find('.video-controls-stub').trigger('click')
    await flushPromises()
    expect(openLightbox).toHaveBeenCalledWith(
      [{ url: 'https://storage.test/sign/u/owner/clip.mp4', type: 'video', name: 'clip.mp4' }],
      0,
      { origin: video.element },
    )
  })

  it('plays audio in the attachment audio player under its name', async () => {
    const wrapper = await render(fileCard({ kind: 'audio', mime_type: 'audio/mpeg', name: 'song.mp3', path: 'u/owner/song.mp3' }))
    expect(wrapper.find('[data-testid="drive-attachment"]').classes()).toContain('audio-container')
    expect(wrapper.find('.audio-filename').text()).toContain('song.mp3')
    expect(wrapper.find('audio.content-audio').attributes('src')).toBe('https://storage.test/sign/u/owner/song.mp3')
  })

  it('draws any other file as the attachment file row: icon, name, size and download', async () => {
    const wrapper = await render(fileCard({ kind: 'document', mime_type: 'application/pdf', name: 'plan.pdf', path: 'u/owner/plan.pdf' }))
    const row = wrapper.find('[data-testid="drive-attachment"]')
    expect(row.classes()).toContain('file-attachment')
    expect(row.attributes('data-kind')).toBe('file')
    expect(wrapper.find('img').exists()).toBe(false)
    const name = wrapper.find('a.file-name')
    expect(name.text()).toBe('plan.pdf')
    expect(name.attributes('href')).toBe('https://storage.test/sign/u/owner/plan.pdf')
    expect(wrapper.find('.file-size').text()).toBe('2 KB')
    await wrapper.find('[data-testid="drive-attachment-download"]').trigger('click')
    await flushPromises()
    expect(driveDownloadUrl).toHaveBeenCalledTimes(1)
  })

  it('draws a /d/ link the same way, with bytes from the backend link route', async () => {
    const wrapper = await render(linkCard(), BY_TOKEN)
    expect(wrapper.find('[data-testid="drive-attachment"]').attributes('data-kind')).toBe('video')
    expect(wrapper.find('video.content-video').attributes('src')).toBe(`/api/federation/drive/link/${TOKEN}`)
    await wrapper.find('[data-testid="drive-attachment-open"]').trigger('click')
    expect(push).toHaveBeenCalledWith(`/d/${TOKEN}`)
  })

  it('serves a link card under the token the card names, for a /drive/file/ link too', async () => {
    const wrapper = await render(linkCard({ kind: 'other', mime_type: 'text/plain', name: 'notes.txt', token: 'Zz9-other-token-123' }))
    expect(wrapper.find('a.file-name').attributes('href')).toBe('/api/federation/drive/link/Zz9-other-token-123')
  })

  it('downloads a link-shared file through the link route', async () => {
    const clicks: string[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.getAttribute('href') ?? '')
    })
    const wrapper = await render(linkCard({ kind: 'document', mime_type: 'application/pdf', name: 'plan.pdf' }), BY_TOKEN)
    await wrapper.find('[data-testid="drive-attachment-download"]').trigger('click')
    await flushPromises()
    expect(clicks).toEqual([`/api/federation/drive/link/${TOKEN}?download=1`])
    click.mockRestore()
  })

  it('tells a reader without access only that the file is restricted, in one line', async () => {
    const wrapper = await render({ access: false })
    const line = wrapper.find('[data-testid="drive-attachment"]')
    expect(line.attributes('data-state')).toBe('restricted')
    expect(line.text()).toBe('drive.card.restrictedTitle')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('shows a restricted line when the lookup fails, and asks again on the next mount', async () => {
    getDriveFileCard.mockRejectedValueOnce(new Error('offline'))
    const failed = mount(DriveLinkAttachment, { props: { link: BY_ID, url: 'x' } })
    await flushPromises()
    expect(failed.find('[data-testid="drive-attachment"]').attributes('data-state')).toBe('restricted')
    await render(fileCard())
    expect(getDriveFileCard).toHaveBeenCalledTimes(2)
  })

  it('asks once for a link drawn twice at the same time', async () => {
    getDriveFileCard.mockResolvedValue(fileCard())
    mount(DriveLinkAttachment, { props: { link: BY_ID, url: 'x' } })
    mount(DriveLinkAttachment, { props: { link: BY_ID, url: 'x' } })
    await flushPromises()
    expect(getDriveFileCard).toHaveBeenCalledTimes(1)
  })

  it('tells the owner a deleted file is gone', async () => {
    const wrapper = await render(fileCard({ state: 'gone', gone_reason: 'deleted', own: true }))
    expect(wrapper.find('[data-testid="drive-attachment"]').attributes('data-state')).toBe('gone')
    expect(wrapper.findComponent({ name: 'DriveGoneFile' }).props('reason')).toBe('deleted')
    expect(wrapper.find('img').exists()).toBe(false)
  })
})
