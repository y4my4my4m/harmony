import type { Message } from '@/types'

export interface PinScope {
  inConversation: boolean
  /** The server is hosted by this instance; a copy's pins are the host's. */
  isLocalServer: boolean
  /** PIN_MESSAGES or MANAGE_MESSAGES in the message's channel. */
  canPinInChannel: boolean
}

/** As pin_message decides it: any participant in a conversation; a system notice never. */
export function canPinMessage(message: Message | null | undefined, scope: PinScope): boolean {
  if (!message || message.is_system) return false
  return scope.inConversation || (scope.isLocalServer && scope.canPinInChannel)
}
