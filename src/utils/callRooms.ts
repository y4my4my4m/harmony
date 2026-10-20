/**
 * Call room names.
 *
 *   {channelId}             server voice channel
 *   dm-{conversationId}     DM call on this instance's transport
 *   federated-dm-{…}        DM call with a participant on another instance
 */

const LOCAL_DM_ROOM = /^dm-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/** The conversation of a local DM call room; null for any other room. */
export function localDMCallConversationId(roomId: string | null | undefined): string | null {
  return roomId ? LOCAL_DM_ROOM.exec(roomId)?.[1] ?? null : null
}
