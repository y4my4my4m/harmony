import type { MessagePart } from '@/types'
import { mediaRoom } from '@/services/privateMedia'
import { useEncryptionFallbackPrompt } from '@/composables/useEncryptionFallbackPrompt'
import { useChatStore } from '@/stores/useChat'
import { useDMStore } from '@/stores/useDM'

/** Where a message goes, fixed when the user sends it. */
export type MessageTarget =
  | { kind: 'channel'; serverId: string; channelId: string }
  | { kind: 'dm'; conversationId: string }

/** `channel:<id>` or `dm:<id>`; also the encryption-fallback context key. */
export function targetKey(
  target: { kind: 'channel'; channelId: string } | { kind: 'dm'; conversationId: string },
): string {
  return target.kind === 'channel' ? `channel:${target.channelId}` : `dm:${target.conversationId}`
}

export function targetMediaRoom(target: MessageTarget): string | null {
  return target.kind === 'channel'
    ? mediaRoom({ channelId: target.channelId })
    : mediaRoom({ conversationId: target.conversationId })
}

export interface SendToTargetOptions {
  /** Id of the optimistic row; a fresh one when absent. */
  tempId?: string
  /** client_nonce of the optimistic row and of the persisted message. */
  clientNonce?: string
  extraMetadata?: Record<string, unknown>
}

/**
 * 'ok': sent. 'failed': the store kept its optimistic row, marked failed, after its
 * own retries. 'declined': the user refused the plaintext fallback; nothing was sent.
 */
export type SendToTargetOutcome = 'ok' | 'failed' | 'declined'

/**
 * Sends through the target's store under the fail-closed encryption policy: an
 * eligible encryption error prompts once for a plaintext fallback, then re-sends
 * with the same optimistic row id and nonce. Throws what the store throws
 * (ENCRYPTION_REQUIRED, moderation, slowmode, validation).
 */
export async function sendToTarget(
  target: MessageTarget,
  authorId: string,
  parts: MessagePart[],
  replyTo: string | undefined,
  options: SendToTargetOptions = {},
): Promise<SendToTargetOutcome> {
  const { runWithEncryptionFallback } = useEncryptionFallbackPrompt()
  let failed = false

  const trySend = async ({ allowPlaintextFallback }: { allowPlaintextFallback: boolean }) => {
    if (target.kind === 'dm') {
      const sent = await useDMStore().sendDMMessage(target.conversationId, authorId, parts, replyTo || undefined, {
        allowPlaintextFallback,
        tempId: options.tempId,
        clientNonce: options.clientNonce,
        extraMetadata: options.extraMetadata,
      })
      failed = !sent
      return
    }
    const sent = await useChatStore().sendMessage(
      target.serverId,
      target.channelId,
      authorId,
      parts,
      replyTo || '',
      options.extraMetadata,
      { allowPlaintextFallback, tempId: options.tempId, clientNonce: options.clientNonce },
    )
    failed = !sent
  }

  const outcome = await runWithEncryptionFallback(trySend, {
    scope: target.kind === 'dm' ? 'dm' : 'channel',
    contextKey: targetKey(target),
  })
  if (outcome.status === 'declined') return 'declined'
  if (outcome.status === 'error') throw outcome.error
  return failed ? 'failed' : 'ok'
}
