-- Fix ap_activities check constraint to allow Harmony voice activity types
-- The constraint was missing the harmony: prefixed activity types

ALTER TABLE public.ap_activities 
DROP CONSTRAINT IF EXISTS ap_activities_valid_type;

ALTER TABLE public.ap_activities 
ADD CONSTRAINT ap_activities_valid_type CHECK (
    ap_type = ANY (ARRAY[
        -- Standard ActivityPub types
        'Create'::text, 
        'Update'::text, 
        'Delete'::text, 
        'Follow'::text, 
        'Accept'::text, 
        'Reject'::text, 
        'Undo'::text, 
        'Like'::text,
        'EmojiReaction'::text,
        'Announce'::text, 
        'Add'::text, 
        'Remove'::text, 
        'Invite'::text, 
        'Join'::text, 
        'Leave'::text, 
        'Block'::text, 
        'Flag'::text, 
        'Move'::text, 
        'Tombstone'::text,
        -- Short voice types (legacy)
        'VoiceJoin'::text, 
        'VoiceLeave'::text, 
        'VoiceUpdate'::text,
        -- Harmony voice extension types (full prefixed names)
        'harmony:VoiceCallInvite'::text,
        'harmony:VoiceCallAccept'::text,
        'harmony:VoiceCallReject'::text,
        'harmony:VoiceCallEnd'::text,
        'harmony:VoiceChannelJoin'::text,
        'harmony:VoiceChannelLeave'::text,
        'harmony:VoiceChannelJoinAccept'::text,
        'harmony:VoiceChannelJoinReject'::text
    ])
);

