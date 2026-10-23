import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick, ref } from 'vue'
import { resetDriveShareOffers, useDriveShareOffer, type DriveShareRoom } from '@/composables/useDriveShareOffer'

// The composer's share offer for a pasted Drive link: drive_share_gap decides, each file is
// offered once per room, and Share takes the channel scope or a share per participant. A
// /d/<token> link resolves to its file through drive_file_card, which names the id to a reader.

const { getDriveFileCard, getDriveShareGap, shareDriveFile } = vi.hoisted(() => ({
  getDriveFileCard: vi.fn(),
  getDriveShareGap: vi.fn(),
  shareDriveFile: vi.fn(),
}))
vi.mock('@/services/drive/driveService', () => ({ getDriveFileCard, getDriveShareGap, shareDriveFile }))

const ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b'
const TOKEN = 'h5KAj-hPSm5hwCpMfeKM8aZl'
const link = () => `${window.location.protocol}//${window.location.host}/drive/file/${ID}`
const tokenLink = () => `${window.location.protocol}//${window.location.host}/d/${TOKEN}`
const ownCard = (extra: Record<string, unknown> = {}) => ({ access: true, via: 'file', id: ID, own: true, ...extra })
const CHANNEL = { channelId: 'channel-1' }
const DM = { conversationId: 'dm-1' }

beforeEach(() => {
  resetDriveShareOffers()
  getDriveFileCard.mockReset()
  getDriveShareGap.mockReset()
  shareDriveFile.mockReset()
  shareDriveFile.mockResolvedValue({})
})

describe('useDriveShareOffer', () => {
  it('offers to share with a channel whose members cannot read the file', async () => {
    getDriveShareGap.mockResolvedValue({ scope: 'channel', target: 'channel-1', missing: true })
    const offer = useDriveShareOffer(() => CHANNEL)
    await offer.checkText(`look ${link()}`)
    expect(getDriveShareGap).toHaveBeenCalledWith(ID, CHANNEL)
    expect(offer.offer.value?.fileId).toBe(ID)

    await offer.share()
    expect(shareDriveFile).toHaveBeenCalledWith(ID, 'channel', 'channel-1')
    expect(offer.offer.value).toBeNull()
  })

  it('offers nothing when everyone can read it, or the caller cannot share it', async () => {
    const offer = useDriveShareOffer(() => CHANNEL)
    getDriveShareGap.mockResolvedValueOnce({ scope: 'channel', target: 'channel-1', missing: false })
    await offer.checkText(link())
    expect(offer.offer.value).toBeNull()
    getDriveShareGap.mockResolvedValueOnce(null)
    await offer.checkText(link())
    expect(offer.offer.value).toBeNull()
  })

  it('offers a file once per room', async () => {
    getDriveShareGap.mockResolvedValue({ scope: 'channel', target: 'channel-1', missing: true })
    const offer = useDriveShareOffer(() => CHANNEL)
    await offer.checkText(link())
    offer.dismiss()
    await offer.checkText(link())
    expect(offer.offer.value).toBeNull()
    expect(getDriveShareGap).toHaveBeenCalledTimes(1)
  })

  it('shares with each participant of a conversation who lacks access', async () => {
    getDriveShareGap.mockResolvedValue({ scope: 'user', targets: ['bob', 'carol'], missing: true })
    const offer = useDriveShareOffer(() => DM)
    await offer.checkText(link())
    await offer.share()
    expect(shareDriveFile.mock.calls).toEqual([[ID, 'user', 'bob'], [ID, 'user', 'carol']])
  })

  it('drops a check in flight when the room changes before it answers', async () => {
    let answer!: (gap: unknown) => void
    getDriveShareGap.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    const current = ref<DriveShareRoom>({ channelId: 'private' })
    const offer = useDriveShareOffer(() => current.value)
    const check = offer.checkText(link())
    current.value = { channelId: 'general' }
    answer({ scope: 'channel', target: 'private', missing: true })
    await check
    expect(offer.offer.value).toBeNull()
    await offer.share()
    expect(shareDriveFile).not.toHaveBeenCalled()
  })

  it('drops a check in flight when the offer is dismissed', async () => {
    let answer!: (gap: unknown) => void
    getDriveShareGap.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    const offer = useDriveShareOffer(() => CHANNEL)
    const check = offer.checkText(link())
    offer.dismiss()
    answer({ scope: 'channel', target: 'channel-1', missing: true })
    await check
    expect(offer.offer.value).toBeNull()
  })

  it('withdraws a shown offer when the room changes', async () => {
    getDriveShareGap.mockResolvedValue({ scope: 'channel', target: 'private', missing: true })
    const current = ref<DriveShareRoom>({ channelId: 'private' })
    const offer = useDriveShareOffer(() => current.value)
    await offer.checkText(link())
    expect(offer.offer.value?.room).toEqual({ channelId: 'private' })
    current.value = { channelId: 'general' }
    await nextTick()
    expect(offer.offer.value).toBeNull()
  })

  it('offers a /d/ link of a file of the caller, by the id its card names', async () => {
    getDriveFileCard.mockResolvedValue(ownCard())
    getDriveShareGap.mockResolvedValue({ scope: 'channel', target: 'channel-1', missing: true })
    const offer = useDriveShareOffer(() => CHANNEL)
    await offer.checkText(`slides ${tokenLink()}`)
    expect(getDriveFileCard).toHaveBeenCalledWith({ token: TOKEN })
    expect(getDriveShareGap).toHaveBeenCalledWith(ID, CHANNEL)
    expect(offer.offer.value?.fileId).toBe(ID)
    await offer.share()
    expect(shareDriveFile).toHaveBeenCalledWith(ID, 'channel', 'channel-1')
  })

  it('offers a file once per room whichever link form named it', async () => {
    getDriveFileCard.mockResolvedValue(ownCard())
    getDriveShareGap.mockResolvedValue({ scope: 'channel', target: 'channel-1', missing: true })
    const offer = useDriveShareOffer(() => CHANNEL)
    await offer.checkText(link())
    offer.dismiss()
    await offer.checkText(tokenLink())
    expect(offer.offer.value).toBeNull()
    expect(getDriveShareGap).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['opens for anyone', ownCard({ public: true })],
    ['is someone else\'s', ownCard({ own: false })],
    ['is a link share without an id', { access: true, via: 'link', name: 'a.png' }],
    ['is dead', { access: false }],
  ])('offers nothing for a /d/ link that %s', async (_, card) => {
    getDriveFileCard.mockResolvedValue(card)
    const offer = useDriveShareOffer(() => CHANNEL)
    await offer.checkText(tokenLink())
    expect(getDriveShareGap).not.toHaveBeenCalled()
    expect(offer.offer.value).toBeNull()
  })

  it('drops a /d/ check in flight when the room changes before its card answers', async () => {
    let answer!: (card: unknown) => void
    getDriveFileCard.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    const current = ref<DriveShareRoom>({ channelId: 'private' })
    const offer = useDriveShareOffer(() => current.value)
    const check = offer.checkText(tokenLink())
    current.value = { channelId: 'general' }
    answer(ownCard())
    await check
    expect(getDriveShareGap).not.toHaveBeenCalled()
    expect(offer.offer.value).toBeNull()
  })

  it('ignores text without a link of this instance, and composers outside a room', async () => {
    const offer = useDriveShareOffer(() => CHANNEL)
    await offer.checkText(`https://elsewhere.example/drive/file/${ID}`)
    const roomless = useDriveShareOffer(() => null)
    await roomless.checkText(link())
    expect(getDriveShareGap).not.toHaveBeenCalled()
  })
})
