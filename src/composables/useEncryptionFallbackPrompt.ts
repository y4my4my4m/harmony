/**
 * useEncryptionFallbackPrompt
 *
 * Helper for callers that want to honor the fail-closed encryption policy
 * from CoreMessageService / ThreadService. When a send rejects with an
 * encryption policy error code, this prompts the user for explicit consent
 * (via a styled in-app modal - see `EncryptionFallbackModal.vue`) and
 * re-runs the send with `allowPlaintextFallback = true`.
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

import { ref } from 'vue'
import { debug } from '@/utils/debug'

export type EncryptionFallbackScope = 'channel' | 'dm' | 'thread'

interface FallbackOptions {
  scope: EncryptionFallbackScope
  /**
   * Stable id for the conversation surface (e.g. `channel:${id}`,
   * `dm:${conversationId}`, `thread:${threadId}`). When set, the user is
   * prompted at most once per context per page load; subsequent sends in the
   * same channel/DM/thread auto-fallback to plaintext without re-prompting.
   * Switching context or refreshing resets the prompt.
   */
  contextKey?: string
  /**
   * Optional override for the prompt. May return a boolean synchronously or
   * a Promise<boolean>. Tests inject a stub here; production code lets the
   * default (the styled modal below) handle it.
   */
  confirm?: (message: string) => boolean | Promise<boolean>
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

const getReasonText = (error: any): string => {
  const code = (error?.code || error?.message || '').toString()
  if (code.includes('LOCKED')) return 'Your encryption keys are locked.'
  if (code.includes('UNAVAILABLE')) return 'Encryption is not set up for this account.'
  return 'Encryption failed.'
}

const getAudienceText = (scope: EncryptionFallbackScope): string => {
  if (scope === 'dm') return 'The recipient will see plaintext.'
  if (scope === 'thread') return 'Other thread participants will see plaintext.'
  return 'Other channel members will see plaintext.'
}

const getNounText = (scope: EncryptionFallbackScope): string => {
  if (scope === 'dm') return 'DM'
  if (scope === 'thread') return 'thread reply'
  return 'message'
}

const promptCopy = (scope: EncryptionFallbackScope, error: any): string => {
  return `${getReasonText(error)}\n\nSend this ${getNounText(scope)} UNENCRYPTED? ${getAudienceText(scope)}`
}

// ===========================================================================
// Singleton modal state - read by `EncryptionFallbackModal.vue`.
// The composable is the only writer; the modal is the only consumer (besides
// `resolveEncryptionFallbackPrompt`).
// ===========================================================================

export interface EncryptionFallbackPromptState {
  open: boolean
  scope: EncryptionFallbackScope | null
  reason: string
  audience: string
  noun: string
  resolver: ((accepted: boolean) => void) | null
}

const initialState = (): EncryptionFallbackPromptState => ({
  open: false,
  scope: null,
  reason: '',
  audience: '',
  noun: 'message',
  resolver: null,
})

export const encryptionFallbackPromptState = ref<EncryptionFallbackPromptState>(initialState())

/** Contexts where the user already confirmed a plaintext send this session. */
const plaintextFallbackAcceptedContexts = new Set<string>()

/**
 * Called by `EncryptionFallbackModal.vue` when the user clicks the confirm
 * or cancel button. Resolves the pending Promise and closes the modal.
 */
export function resolveEncryptionFallbackPrompt(accepted: boolean): void {
  const r = encryptionFallbackPromptState.value.resolver
  encryptionFallbackPromptState.value = initialState()
  if (r) r(accepted)
}

/**
 * Default confirm path: open the styled modal and wait for the user.
 * Concurrent prompts are not supported (the UI prevents two send actions
 * overlapping in practice); a second call while a prompt is open
 * auto-declines to avoid leaking resolvers.
 */
function defaultConfirm(scope: EncryptionFallbackScope, error: any): Promise<boolean> {
  if (encryptionFallbackPromptState.value.open) {
    debug.warn('🔒 Encryption fallback prompt already open - auto-declining new prompt')
    return Promise.resolve(false)
  }
  return new Promise<boolean>(resolve => {
    encryptionFallbackPromptState.value = {
      open: true,
      scope,
      reason: getReasonText(error),
      audience: getAudienceText(scope),
      noun: getNounText(scope),
      resolver: resolve,
    }
  })
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
    try {
      const result = await send({ allowPlaintextFallback: false })
      return { result, status: 'ok' }
    } catch (error) {
      if (!isEncryptionPolicyError(error)) {
        return { status: 'error', error }
      }
      if (!isFallbackEligible(error)) {
        // ENCRYPTION_REQUIRED - server policy, no override allowed.
        return { status: 'error', error }
      }

      // User already accepted plaintext for this channel/DM/thread this session.
      if (options.contextKey && plaintextFallbackAcceptedContexts.has(options.contextKey)) {
        try {
          const result = await send({ allowPlaintextFallback: true })
          return { result, status: 'ok' }
        } catch (retryError) {
          return { status: 'error', error: retryError }
        }
      }

      // Use the injected confirm if provided (tests), else the styled modal.
      // Both can return either `boolean` or `Promise<boolean>`; `await
      // Promise.resolve(x)` handles both shapes uniformly.
      const accepted = options.confirm
        ? await Promise.resolve(options.confirm(promptCopy(options.scope, error)))
        : await defaultConfirm(options.scope, error)

      if (!accepted) {
        debug.warn('🔒 User declined plaintext fallback')
        return { status: 'declined' }
      }

      if (options.contextKey) {
        plaintextFallbackAcceptedContexts.add(options.contextKey)
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
