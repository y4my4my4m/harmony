/**
 * Build a shareable deep link for a chat/DM/thread message.
 */
export function getMessageShareUrl(options: {
  messageId: string
  serverId?: string
  channelId?: string
  conversationId?: string
  threadId?: string
  domain?: string
}): string | null {
  const { messageId, serverId, channelId, conversationId, threadId } = options
  if (!messageId) return null

  const domain =
    options.domain ||
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_DOMAIN) ||
    (typeof window !== 'undefined' ? window.location.host : '')

  if (!domain) return null

  const base = `https://${domain}`

  if (threadId && serverId) {
    return `${base}/chat/${serverId}/thread/${threadId}?messageId=${messageId}`
  }
  if (serverId && channelId) {
    return `${base}/chat/${serverId}/${channelId}?messageId=${messageId}`
  }
  if (conversationId) {
    return `${base}/dm/${conversationId}?messageId=${messageId}`
  }
  return null
}
