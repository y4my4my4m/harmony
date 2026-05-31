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

  it('falls back to the global modal state when no confirm is provided', async () => {
    // Default path (no `confirm` option) opens the shared modal state that
    // `EncryptionFallbackModal.vue` reads from. We simulate the user pressing
    // Cancel by reading the resolver and calling
    // `resolveEncryptionFallbackPrompt(false)`.
    const {
      runWithEncryptionFallback,
    } = useEncryptionFallbackPrompt()
    const {
      encryptionFallbackPromptState,
      resolveEncryptionFallbackPrompt,
    } = await import('../useEncryptionFallbackPrompt')

    const send = vi.fn().mockRejectedValue({ code: 'ENCRYPTION_LOCKED' })

    const runPromise = runWithEncryptionFallback(send, { scope: 'dm' })

    // Give the microtask queue a tick so the send rejects and the modal opens.
    await Promise.resolve()
    await Promise.resolve()

    expect(encryptionFallbackPromptState.value.open).toBe(true)
    expect(encryptionFallbackPromptState.value.scope).toBe('dm')
    expect(encryptionFallbackPromptState.value.reason).toContain('locked')

    resolveEncryptionFallbackPrompt(false)

    const res = await runPromise
    expect(res).toEqual({ status: 'declined' })

    // State should be reset after resolve so a subsequent prompt can open.
    expect(encryptionFallbackPromptState.value.open).toBe(false)
    expect(encryptionFallbackPromptState.value.scope).toBeNull()
    expect(encryptionFallbackPromptState.value.resolver).toBeNull()
  })

  it('auto-declines concurrent prompts so resolvers cannot be lost', async () => {
    const {
      runWithEncryptionFallback,
    } = useEncryptionFallbackPrompt()
    const {
      resolveEncryptionFallbackPrompt,
    } = await import('../useEncryptionFallbackPrompt')

    const send = vi.fn().mockRejectedValue({ code: 'ENCRYPTION_UNAVAILABLE' })

    const first = runWithEncryptionFallback(send, { scope: 'channel' })
    await Promise.resolve()
    await Promise.resolve()

    // Now a second send tries to prompt while the first prompt is still open.
    const second = runWithEncryptionFallback(send, { scope: 'channel' })

    // Second resolves immediately as declined without touching the open prompt.
    const secondResult = await second
    expect(secondResult).toEqual({ status: 'declined' })

    // First is still pending - resolve it now.
    resolveEncryptionFallbackPrompt(true)
    // The retry inside `runWithEncryptionFallback` will reject again
    // (mockRejectedValue), so we expect status 'error' for the first.
    const firstResult = await first
    expect(firstResult.status).toBe('error')
  })

  it('prompts only once per contextKey when user accepts', async () => {
    const { runWithEncryptionFallback } = useEncryptionFallbackPrompt()
    const confirm = vi.fn().mockReturnValue(true)
    const send = vi
      .fn()
      .mockRejectedValueOnce({ code: 'ENCRYPTION_LOCKED' })
      .mockResolvedValueOnce('msg-a')
      .mockRejectedValueOnce({ code: 'ENCRYPTION_LOCKED' })
      .mockResolvedValueOnce('msg-b')

    const opts = { scope: 'channel' as const, contextKey: 'channel:test-once' }

    const first = await runWithEncryptionFallback(send, { ...opts, confirm })
    const second = await runWithEncryptionFallback(send, { ...opts, confirm })

    expect(first).toEqual({ result: 'msg-a', status: 'ok' })
    expect(second).toEqual({ result: 'msg-b', status: 'ok' })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenNthCalledWith(1, { allowPlaintextFallback: false })
    expect(send).toHaveBeenNthCalledWith(2, { allowPlaintextFallback: true })
    // Second send still tries encrypted first, then auto-fallbacks without prompting.
    expect(send).toHaveBeenNthCalledWith(3, { allowPlaintextFallback: false })
    expect(send).toHaveBeenNthCalledWith(4, { allowPlaintextFallback: true })
  })

  it('prompts again for a different contextKey', async () => {
    const { runWithEncryptionFallback } = useEncryptionFallbackPrompt()
    const confirm = vi.fn().mockReturnValue(true)
    const send = vi
      .fn()
      .mockRejectedValueOnce({ code: 'ENCRYPTION_LOCKED' })
      .mockResolvedValueOnce('msg-a')
      .mockRejectedValueOnce({ code: 'ENCRYPTION_LOCKED' })
      .mockResolvedValueOnce('msg-b')

    await runWithEncryptionFallback(send, {
      scope: 'channel',
      contextKey: 'channel:alpha',
      confirm,
    })
    await runWithEncryptionFallback(send, {
      scope: 'channel',
      contextKey: 'channel:beta',
      confirm,
    })

    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('does not remember context when user declines the prompt', async () => {
    const { runWithEncryptionFallback } = useEncryptionFallbackPrompt()
    const confirm = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    const send = vi
      .fn()
      .mockRejectedValueOnce({ code: 'ENCRYPTION_LOCKED' })
      .mockRejectedValueOnce({ code: 'ENCRYPTION_LOCKED' })
      .mockResolvedValueOnce('msg-after-retry')

    const opts = { scope: 'dm' as const, contextKey: 'dm:decline-test', confirm }

    const declined = await runWithEncryptionFallback(send, opts)
    expect(declined).toEqual({ status: 'declined' })

    const accepted = await runWithEncryptionFallback(send, opts)
    expect(accepted).toEqual({ result: 'msg-after-retry', status: 'ok' })
    expect(confirm).toHaveBeenCalledTimes(2)
  })
})
