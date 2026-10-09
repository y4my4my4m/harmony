import { describe, it, expect } from 'vitest'
import { useConfirmDialog } from '../useConfirmDialog'

describe('useConfirmDialog', () => {
  it('resolves confirm() true on confirm and false on close', async () => {
    const d = useConfirmDialog()
    const yes = d.confirm({ title: 't', message: 'm' })
    expect(d.confirmDialogInput.value).toBeNull()
    d.handleConfirm()
    await expect(yes).resolves.toBe(true)

    const no = d.confirm({ title: 't', message: 'm' })
    d.handleClose()
    await expect(no).resolves.toBe(false)
  })

  it('resolves prompt() with the text, an empty answer, or null when cancelled', async () => {
    const d = useConfirmDialog()
    const text = d.prompt({ title: 't', message: 'm', label: 'Reason', initialValue: 'x' })
    expect(d.confirmDialogInput.value).toEqual({ label: 'Reason', placeholder: '', initialValue: 'x' })
    d.handleConfirm('spam')
    await expect(text).resolves.toBe('spam')

    const empty = d.prompt({ title: 't', message: 'm' })
    d.handleConfirm()
    await expect(empty).resolves.toBe('')

    const cancelled = d.prompt({ title: 't', message: 'm' })
    d.handleClose()
    await expect(cancelled).resolves.toBeNull()
  })

  it('cancels a dialog still open when another opens', async () => {
    const d = useConfirmDialog()
    const first = d.prompt({ title: 'a', message: 'm' })
    const second = d.confirm({ title: 'b', message: 'm' })
    await expect(first).resolves.toBeNull()
    d.handleConfirm()
    await expect(second).resolves.toBe(true)
  })
})
