/**
 * useEncryptionFallbackPrompt
 *
 * Helper for callers that want to honor the fail-closed encryption policy
 * from CoreMessageService / ThreadService. When a send rejects with an
 * encryption policy error code, this prompts the user for explicit consent
 * and re-runs the send with `allowPlaintextFallback = true`.
 *
 * Usage:
 * ```ts
 * const { runWithEncryptionFallback } = useEncryptionFallbackPrompt()
 * await runWithEncryptionFallback(
 *   ({ allowPlaintextFallback }) =>
 *     threadService.sendThreadMessage(threadId, parts, replyTo, undefined, {
 *       allowPlaintextFallback,
 *     }),
 *   { scope: 'thread' },
 * )
 * ```
 *
 * `scope` controls the prompt copy ('channel' | 'dm' | 'thread').
 */

import { debug } from '@/utils/debug'

export type EncryptionFallbackScope = 'channel' | 'dm' | 'thread'

interface FallbackOptions {
  scope: EncryptionFallbackScope
  /**
   * Optional override for the prompt(). Defaults to `window.confirm`.
   * Tests should inject a stub.
   */
  confirm?: (message: string) => boolean
}

interface RunArgs {
  allowPlaintextFallback: boolean
}

const isEncryptionPolicyError = (error: any) => {
  const code = (error?.code || error?.message || '').toString()
  return (
    code.includes('ENCRYPTION_REQUIRED') ||
    code.includes('ENCRYPTION_LOCKED') ||
    code.includes('ENCRYPTION_UNAVAILABLE') ||
    code.includes('ENCRYPTION_FAILED_NO_FALLBACK')
  )
}

const isFallbackEligible = (error: any) => {
  const code = (error?.code || error?.message || '').toString()
  // ENCRYPTION_REQUIRED is server-enforced; user cannot override.
  return (
    code.includes('ENCRYPTION_LOCKED') ||
    code.includes('ENCRYPTION_UNAVAILABLE') ||
    code.includes('ENCRYPTION_FAILED_NO_FALLBACK')
  )
}

const promptCopy = (scope: EncryptionFallbackScope, error: any): string => {
  const code = (error?.code || error?.message || '').toString()
  const human = code.includes('LOCKED')
    ? 'Your encryption keys are locked.'
    : code.includes('UNAVAILABLE')
      ? 'Encryption is not set up for this account.'
      : 'Encryption failed.'

  const audience =
    scope === 'dm'
      ? 'The recipient will see plaintext.'
      : scope === 'thread'
        ? 'Other thread participants will see plaintext.'
        : 'Other channel members will see plaintext.'

  const noun = scope === 'dm' ? 'DM' : scope === 'thread' ? 'thread reply' : 'message'

  return `${human}\n\nSend this ${noun} UNENCRYPTED? ${audience}`
}

export function useEncryptionFallbackPrompt() {
  /**
   * Run `send` with the fail-closed policy. If it rejects with a recoverable
   * encryption error, prompt the user once and re-run with the override.
   * Re-throws non-encryption errors and `ENCRYPTION_REQUIRED` errors.
   */
  async function runWithEncryptionFallback<T>(
    send: (args: RunArgs) => Promise<T>,
    options: FallbackOptions,
  ): Promise<{ result?: T; status: 'ok' | 'declined' | 'error'; error?: unknown }> {
    const doConfirm =
      options.confirm ??
      ((message: string) =>
        typeof window !== 'undefined' && typeof window.confirm === 'function'
          ? window.confirm(message)
          : false)

    try {
      const result = await send({ allowPlaintextFallback: false })
      return { result, status: 'ok' }
    } catch (error) {
      if (!isEncryptionPolicyError(error)) {
        return { status: 'error', error }
      }
      if (!isFallbackEligible(error)) {
        // ENCRYPTION_REQUIRED — server policy, no override allowed.
        return { status: 'error', error }
      }

      const accepted = doConfirm(promptCopy(options.scope, error))
      if (!accepted) {
        debug.warn('🔒 User declined plaintext fallback')
        return { status: 'declined' }
      }

      try {
        const result = await send({ allowPlaintextFallback: true })
        return { result, status: 'ok' }
      } catch (retryError) {
        return { status: 'error', error: retryError }
      }
    }
  }

  return { runWithEncryptionFallback }
}
