// Previews of system rows (messages.is_system). metadata.type is a server-only key
// (guard_message_client_write), so a known type marks a notice even where a preview row
// carries no is_system.

/** i18n key of a notice's one-line preview, or null for a type without one. */
export function systemEventPreviewKey(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null
  const meta = metadata as Record<string, unknown>
  const video = meta.call_type === 'video'
  switch (meta.type) {
    case 'call_started':
      return video ? 'systemEvents.preview.videoCall' : 'systemEvents.preview.voiceCall'
    case 'call_ended':
      // participants lists everyone who joined, the caller included.
      if (!Array.isArray(meta.participants) || meta.participants.length < 2) return 'dm.missedCall'
      return video ? 'systemEvents.preview.videoCall' : 'systemEvents.preview.voiceCall'
    case 'group_created':
      return meta.event === 'members_added' ? 'systemEvents.preview.membersAdded' : 'systemEvents.preview.groupCreated'
    default:
      return null
  }
}
