import { ref, watch } from 'vue'
import { getDriveShareGap, shareDriveFile, type DriveShareGap } from '@/services/drive/driveService'
import { driveFileIdsIn } from '@/services/drive/driveLinks'

export type DriveShareRoom = { channelId: string } | { conversationId: string }

export interface DriveShareOffer {
  fileId: string
  room: DriveShareRoom
  gap: DriveShareGap
}

/** Files offered per room this session; each file is offered once per room. */
const offered = new Set<string>()

function roomKey(room: DriveShareRoom | null): string {
  if (!room) return ''
  return 'channelId' in room ? `c:${room.channelId}` : `d:${room.conversationId}`
}

function offerKey(room: DriveShareRoom, fileId: string): string {
  return `${roomKey(room)}:${fileId}`
}

/** Forgets what was offered; tests. */
export function resetDriveShareOffers(): void {
  offered.clear()
}

/**
 * The composer's offer to share a pasted /drive/file/<id> link with the room, when the caller
 * owns the file and local members of the room cannot read it (drive_share_gap). A channel takes
 * a channel share; a conversation takes a share with each participant who lacks access.
 * An offer belongs to the room it was checked for: leaving the room withdraws it and drops
 * checks still in flight.
 */
export function useDriveShareOffer(room: () => DriveShareRoom | null) {
  const offer = ref<DriveShareOffer | null>(null)
  const busy = ref(false)
  let checkSeq = 0

  async function checkText(text: string): Promise<void> {
    const target = room()
    if (!target) return
    const seq = ++checkSeq
    for (const fileId of driveFileIdsIn(text)) {
      const key = offerKey(target, fileId)
      if (offered.has(key)) continue
      let gap: DriveShareGap | null
      try {
        gap = await getDriveShareGap(fileId, target)
      } catch {
        continue
      }
      if (seq !== checkSeq || roomKey(room()) !== roomKey(target)) return
      if (!gap?.missing) continue
      offered.add(key)
      offer.value = { fileId, room: target, gap }
      return
    }
  }

  /** Shares the offered file with the room. Throws what the share call threw. */
  async function share(): Promise<void> {
    const current = offer.value
    if (!current || busy.value) return
    busy.value = true
    try {
      if (current.gap.scope === 'channel') {
        await shareDriveFile(current.fileId, 'channel', current.gap.target)
      } else {
        for (const target of current.gap.targets) await shareDriveFile(current.fileId, 'user', target)
      }
      offer.value = null
    } finally {
      busy.value = false
    }
  }

  function dismiss(): void {
    checkSeq++
    offer.value = null
  }

  watch(() => roomKey(room()), dismiss, { flush: 'sync' })

  return { offer, busy, checkText, share, dismiss }
}
