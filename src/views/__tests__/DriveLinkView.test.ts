/**
 * /d/<token> and /drive/file/<id>: a signed-in reader gets the file page, anyone else the public
 * page while the file is public, a signed-out visitor of a restricted file the sign-in with a way
 * back. /drive/file/<id> sends a reader on to the file's /d/ address.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import type { DriveFileCardFile } from '@/services/drive/driveService'

enableAutoUnmount(afterEach)

const { getDriveFileCard, resolveDriveLink, replace, remember, auth, route } = vi.hoisted(() => ({
  getDriveFileCard: vi.fn(),
  resolveDriveLink: vi.fn(),
  replace: vi.fn(),
  remember: vi.fn(),
  auth: { isLoggedIn: true },
  route: { params: {} as Record<string, string>, fullPath: '' },
}))

vi.mock('@/services/drive/driveService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/drive/driveService')>()
  return {
    getDriveFileCard,
    resolveDriveLink,
    primeDriveFileCard: actual.primeDriveFileCard,
    takePrimedDriveFileCard: actual.takePrimedDriveFileCard,
  }
})
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ replace }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }))
vi.mock('@/utils/postAuthRedirect', () => ({ rememberPostAuthRedirect: remember }))

const FilePage = defineComponent({
  name: 'DriveFilePage',
  props: ['state', 'card'],
  render() { return h('div', { 'data-state': this.state }) },
})
const PublicPage = defineComponent({
  name: 'DrivePublicPage',
  props: ['token', 'info'],
  render() { return h('section') },
})
vi.mock('@/components/drive/DriveFilePage.vue', () => ({ default: FilePage }))
vi.mock('@/components/drive/DrivePublicPage.vue', () => ({ default: PublicPage }))

const { default: DriveLinkView } = await import('../DriveLinkView.vue')
const { default: DriveFileView } = await import('../DriveFileView.vue')

const TOKEN = 'h5KAj-hPSm5hwCpMfeKM8aZl'
const FILE_ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b'
const OWNER = { id: 'o1', username: 'alice', display_name: 'Alice', avatar_url: null, domain: null, emojis: [] }

function fileCard(): DriveFileCardFile {
  return {
    access: true, via: 'file', id: FILE_ID, bucket: 'message_media', path: `u/o/${FILE_ID}.png`,
    name: 'harbor.png', mime_type: 'image/png', kind: 'image', size_bytes: 2048, state: 'drive',
    gone_reason: null, expires_at: null, created_at: '2026-10-20T00:00:00Z', own: false, owner: OWNER,
    token: TOKEN, public: false, link_expires_at: null, show_owner: false,
  }
}

async function open(token = TOKEN) {
  route.params = { token }
  route.fullPath = `/d/${token}`
  const wrapper = mount(DriveLinkView)
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  getDriveFileCard.mockReset()
  resolveDriveLink.mockReset()
  replace.mockReset()
  remember.mockReset()
  auth.isLoggedIn = true
})

describe('DriveLinkView', () => {
  it('opens the file for a signed-in reader', async () => {
    getDriveFileCard.mockResolvedValue(fileCard())
    const wrapper = await open()
    expect(getDriveFileCard).toHaveBeenCalledWith({ token: TOKEN })
    const page = wrapper.getComponent(FilePage)
    expect(page.props('state')).toBe('ready')
    expect(page.props('card')).toMatchObject({ id: FILE_ID, token: TOKEN })
    expect(wrapper.findComponent(PublicPage).exists()).toBe(false)
  })

  it('shows a signed-in member who does not read a public file the public page', async () => {
    getDriveFileCard.mockResolvedValue({
      access: true, via: 'link', token: TOKEN, name: 'harbor.png', mime_type: 'image/png', kind: 'image',
      size_bytes: 2048, created_at: '2026-10-20T00:00:00Z', expires_at: null, owner: null,
    })
    const wrapper = await open()
    const page = wrapper.getComponent(PublicPage)
    expect(page.props('token')).toBe(TOKEN)
    expect(page.props('info')).toEqual({
      name: 'harbor.png', mime_type: 'image/png', kind: 'image', size_bytes: 2048,
      created_at: '2026-10-20T00:00:00Z', expires_at: null, owner: null,
    })
  })

  it('shows a signed-in member without access the no-access page', async () => {
    getDriveFileCard.mockResolvedValue({ access: false })
    const wrapper = await open()
    expect(wrapper.getComponent(FilePage).props('state')).toBe('denied')
    expect(replace).not.toHaveBeenCalled()
  })

  it('shows a signed-out visitor a public file without an account', async () => {
    auth.isLoggedIn = false
    resolveDriveLink.mockResolvedValue({ name: 'harbor.png', owner: null })
    const wrapper = await open()
    expect(getDriveFileCard).not.toHaveBeenCalled()
    expect(wrapper.getComponent(PublicPage).props('info')).toMatchObject({ name: 'harbor.png' })
  })

  it('sends a signed-out visitor of a restricted file to sign in, and back', async () => {
    auth.isLoggedIn = false
    resolveDriveLink.mockResolvedValue(null)
    await open()
    expect(remember).toHaveBeenCalledWith(`/d/${TOKEN}`)
    expect(replace).toHaveBeenCalledWith({ name: 'Login', query: { redirect: `/d/${TOKEN}` } })
  })

  it('looks nothing up for a malformed token', async () => {
    const wrapper = await open('not a token')
    expect(getDriveFileCard).not.toHaveBeenCalled()
    expect(wrapper.getComponent(FilePage).props('state')).toBe('denied')
  })

  it('moves to the new address after Reset link', async () => {
    getDriveFileCard.mockResolvedValue(fileCard())
    const wrapper = await open()
    wrapper.getComponent(FilePage).vm.$emit('token', 'Nn9-new-token-0123456789')
    expect(replace).toHaveBeenCalledWith({ name: 'DriveLink', params: { token: 'Nn9-new-token-0123456789' } })
  })
})

describe('DriveFileView', () => {
  async function openFile(id = FILE_ID) {
    route.params = { fileId: id }
    route.fullPath = `/drive/file/${id}`
    const wrapper = mount(DriveFileView)
    await flushPromises()
    return wrapper
  }

  it('sends a reader on to the file\'s /d/ address, handing the card over', async () => {
    getDriveFileCard.mockResolvedValue(fileCard())
    await openFile()
    expect(getDriveFileCard).toHaveBeenCalledWith({ fileId: FILE_ID })
    expect(replace).toHaveBeenCalledWith({ name: 'DriveLink', params: { token: TOKEN } })

    getDriveFileCard.mockClear()
    const wrapper = await open()
    expect(getDriveFileCard).not.toHaveBeenCalled()
    expect(wrapper.getComponent(FilePage).props('state')).toBe('ready')
  })

  it('shows anyone else the no-access page, naming nothing', async () => {
    getDriveFileCard.mockResolvedValue({ access: false })
    const wrapper = await openFile()
    expect(replace).not.toHaveBeenCalled()
    expect(wrapper.getComponent(FilePage).props()).toMatchObject({ state: 'denied' })
  })
})

