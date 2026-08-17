-- =============================================================================
-- Dismiss / hide DM conversations (per-user, non-destructive)
-- =============================================================================
-- Adds a per-participant `hidden_at` flag so a user can remove a conversation
-- from their own DM list without deleting it or leaving. The conversation (and
-- its messages) stay intact; it simply stops showing in the sidebar until it's
-- reopened or a newer message arrives.
--
-- The frontend treats a conversation as hidden only while its latest activity
-- is older than `hidden_at`, so any new message naturally brings it back.
-- =============================================================================

BEGIN;

-- 1. Column ------------------------------------------------------------------
ALTER TABLE public.conversation_participants
    ADD COLUMN IF NOT EXISTS hidden_at timestamp with time zone;

-- 2. RPC: set/clear the hidden flag for the calling user ---------------------
CREATE OR REPLACE FUNCTION public.set_conversation_hidden(
    p_conversation_id uuid,
    p_hidden boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_profile_id uuid;
BEGIN
    v_profile_id := public.get_current_profile_id();
    IF v_profile_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    UPDATE public.conversation_participants
    SET hidden_at = CASE WHEN p_hidden THEN NOW() ELSE NULL END
    WHERE conversation_id = p_conversation_id
      AND user_id = v_profile_id
      AND left_at IS NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_conversation_hidden(uuid, boolean) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
