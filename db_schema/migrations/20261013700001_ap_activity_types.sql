-- ap_activities accepts QuoteRequest (FEP-044f; Mastodon 4.5 quote approval). The inbox
-- stores every activity before processing it, and a type outside the list fails that
-- insert with 500. EmojiReact is stored as EmojiReaction by the inbox.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE public.ap_activities DROP CONSTRAINT IF EXISTS ap_activities_valid_type;
ALTER TABLE public.ap_activities ADD CONSTRAINT ap_activities_valid_type CHECK (ap_type IN (
    'Create', 'Update', 'Delete', 'Follow', 'Accept', 'Reject', 'Undo',
    'Like', 'EmojiReaction', 'Announce', 'Add', 'Remove', 'Invite',
    'Join', 'Leave', 'Block', 'Flag', 'Move', 'Tombstone', 'QuoteRequest',
    'VoiceJoin', 'VoiceLeave', 'VoiceUpdate',
    'harmony:VoiceCallInvite', 'harmony:VoiceCallAccept',
    'harmony:VoiceCallReject', 'harmony:VoiceCallEnd',
    'harmony:VoiceChannelJoin', 'harmony:VoiceChannelLeave',
    'harmony:VoiceChannelJoinAccept', 'harmony:VoiceChannelJoinReject'
));

COMMIT;
