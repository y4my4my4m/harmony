import { describe, it, expect, vi, afterEach } from 'vitest'
import { ENCRYPTION_ACTION_EVENT, reportChannelEncryptionError } from '@/composables/useEncryptionAction'
import { useEncryptionFallbackPrompt } from '@/composables/useEncryptionFallbackPrompt'
import { channelEncryptionError } from '@/services/core/channelMessageEncryption'

function listen() {
  const handler = vi.fn()
  window.addEventListener(ENCRYPTION_ACTION_EVENT, handler)
  return {
    handler,
    stop: () => window.removeEventListener(ENCRYPTION_ACTION_EVENT, handler),
  }
}

describe('reportChannelEncryptionError', () => {
  let stop: (() => void) | null = null
  afterEach(() => { stop?.(); stop = null })

  it('dispatches the reason and message of a channel refusal', () => {
    const l = listen()
    stop = l.stop
    expect(reportChannelEncryptionError(channelEncryptionError('setup'))).toBe(true)
    const detail = (l.handler.mock.calls[0][0] as CustomEvent).detail
    expect(detail.reason).toBe('setup')
    expect(detail.message).toMatch(/Set up encryption/)
  })

  it('ignores other errors, including a reasonless ENCRYPTION_REQUIRED', () => {
    const l = listen()
    stop = l.stop
    expect(reportChannelEncryptionError(new Error('boom'))).toBe(false)
    expect(reportChannelEncryptionError({ code: 'ENCRYPTION_REQUIRED', message: 'x' })).toBe(false)
    expect(reportChannelEncryptionError({ code: 'ENCRYPTION_LOCKED', reason: 'unlock' })).toBe(false)
    expect(l.handler).not.toHaveBeenCalled()
  })
})

describe('runWithEncryptionFallback with a channel refusal', () => {
  it('reports it once, never prompts for plaintext and never retries', async () => {
    const l = listen()
    const confirm = vi.fn(() => true)
    const send = vi.fn().mockRejectedValue(channelEncryptionError('unlock'))
    const { runWithEncryptionFallback } = useEncryptionFallbackPrompt()

    const outcome = await runWithEncryptionFallback(send, { scope: 'thread', confirm })

    expect(outcome.status).toBe('error')
    expect(send).toHaveBeenCalledTimes(1)
    expect(confirm).not.toHaveBeenCalled()
    expect(l.handler).toHaveBeenCalledTimes(1)
    expect((l.handler.mock.calls[0][0] as CustomEvent).detail.reason).toBe('unlock')
    l.stop()
  })
})
