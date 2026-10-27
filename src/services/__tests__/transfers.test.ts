import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

// Sign-out ends the account's transfers: running ones are cancelled, every entry is dropped.

import { registerTransfer, resetTransfers, settleTransfer, transfers, type TransferStatus } from '@/services/transfers'

const progress = (status: TransferStatus) => reactive({ loaded: 1, total: 2, status, error: null, reconnecting: false })

beforeEach(() => resetTransfers())

describe('resetTransfers', () => {
  it('cancels each running transfer, leaves settled ones alone, and empties the list', () => {
    const upload = vi.fn(() => { throw new Error('owner gone') })
    const download = vi.fn()
    const failed = vi.fn()
    registerTransfer({ id: 'u', direction: 'upload', name: 'clip.mp4', progress: progress('running'), cancel: upload })
    registerTransfer({ id: 'd', direction: 'download', name: 'a.zip', progress: progress('running'), cancel: download })
    const done = registerTransfer({ id: 'f', direction: 'upload', name: 'b.png', progress: progress('error'), cancel: failed })
    settleTransfer(done)

    resetTransfers()
    expect(upload).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledTimes(1)
    expect(failed).not.toHaveBeenCalled()
    expect(transfers()).toHaveLength(0)
  })
})
