/**
 * Activity types the shared and personal inboxes store and process: the
 * ap_activities_valid_type check of public.ap_activities, as
 * 20261017100005_voice_moderation_followups.sql last defines it, plus
 * EmojiReact, stored as EmojiReaction. Any other type (GoToSocial LikeRequest
 * and ReplyRequest, PeerTube View, Lemmy Dislike, Pleroma ChatMessage) is
 * answered 202 and dropped, as Mastodon drops types it does not implement.
 */
export const STORED_ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  'Create', 'Update', 'Delete', 'Follow', 'Accept', 'Reject', 'Undo',
  'Like', 'EmojiReaction', 'Announce', 'Add', 'Remove', 'Invite',
  'Join', 'Leave', 'Block', 'Flag', 'Move', 'Tombstone', 'QuoteRequest',
  'VoiceJoin', 'VoiceLeave', 'VoiceUpdate',
  'harmony:VoiceCallInvite', 'harmony:VoiceCallAccept',
  'harmony:VoiceCallReject', 'harmony:VoiceCallEnd',
  'harmony:VoiceChannelJoin', 'harmony:VoiceChannelLeave',
  'harmony:VoiceChannelJoinAccept', 'harmony:VoiceChannelJoinReject',
  'harmony:VoiceMemberMove', 'harmony:VoiceMemberDisconnect', 'harmony:VoiceMemberState',
  'EmojiReact',
]);

export function isStoredActivityType(type: unknown): boolean {
  return typeof type === 'string' && STORED_ACTIVITY_TYPES.has(type);
}
