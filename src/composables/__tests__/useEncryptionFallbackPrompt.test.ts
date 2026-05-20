import { describe, it, expect, vi } from 'vitest'
import { useEncryptionFallbackPrompt } from '../useEncryptionFallbackPrompt'

describe('useEncryptionFallbackPrompt', () => {
  it('returns ok when send succeeds on first try', async () => {
    const { runWithEncryptionFallback } = useEncryptionFallbackPrompt()
    const send = vi.fn().mockResolvedValue('msg-1')

    const res = await runWithEncryptionFallback(send, { scope: 'channel' })

    expect(res).toEqual({ result: 'msg-1', status: 'ok' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ allowPlaintextFallback: false })
  })

  it('does not prompt when error is non-encryption', async () => {
    const { runWithEncryptionFallback } = useEncryptionFallbackPrompt()
    const confirm = vi.fn().mockReturnValue(true)
    const send = vi.fn().mockRejectedValue(new Error('network broken'))

    const res = await runWithEncryptionFallback(send, { scope: 'channel', confirm })

    expect(res.status).toBe('error')
    expect(confirm).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not prompt when ENCRYPTION_REQUIRED is raised', async () => {
    const { runWithEncryptionFallback } = useEncryptionFallbackPrompt()
    const confirm = vi.fn().mockReturnValue(true)
    const send = vi.fn().mockRejectedValue({ code: 'ENCRYPTION_REQUIRED', message: 'server requires' })

    const res = await runWithEncryptionFallback(send, { scope: 'channel', confirm })

    expect(res.status).toBe('error')
    expect(confirm).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('prompts and retries with override when user accepts', async () => {
    const { runWithEncryptionFallback } = useEncryptionFallbackPrompt()
    const confirm = vi.fn().mockReturnValue(true)
    const send = vi
      .fn()
      .mockRejectedValueOnce({ code: 'ENCRYPTION_LOCKED', message: 'locked' })
      .mockResolvedValueOnce('msg-2')

    const res = await runWithEncryptionFallback(send, { scope: 'dm', confirm })

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).toContain('UNENCRYPTED')
    expect(confirm.mock.calls[0][0]).toContain('DM')
    expect(send).toHaveBeenNthCalledWith(1, { allowPlaintextFallback: false })
    expect(send).toHaveBeenNthCalledWith(2, { allowPlaintextFallback: true })
    expect(res).toEqual({ result: 'msg-2', status: 'ok' })
  })

  it('returns declined when user rejects the prompt', async () => {
    const { runWithEncryptionFallback } = useEncryptionFallbackPrompt()
    const confirm = vi.fn().mockReturnValue(false)
    const send = vi.fn().mockRejectedValue({ code: 'ENCRYPTION_UNAVAILABLE' })

    const res = await runWithEncryptionFallback(send, { scope: 'thread', confirm })

    expect(res).toEqual({ status: 'declined' })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('propagates retry error as { status: error }', async () => {
    const { runWithEncryptionFallback } = useEncryptionFallbackPrompt()
    const confirm = vi.fn().mockReturnValue(true)
    const send = vi
      .fn()
      .mockRejectedValueOnce({ code: 'ENCRYPTION_FAILED_NO_FALLBACK' })
      .mockRejectedValueOnce(new Error('database down'))

    const res = await runWithEncryptionFallback(send, { scope: 'channel', confirm })

    expect(res.status).toBe('error')
    expect((res.error as Error).message).toBe('database down')
  })
})
