-- check_dm_call(conversation): the refusals start_dm_call_message raises before it posts the call
-- notice, with nothing posted and nothing rung. A caller already in another call asks before it
-- leaves that call; the answer is the one placing the call gives (DM_UNDELIVERABLE for a block),
-- so it tells nothing the call attempt does not.
--
-- Raises as start_dm_call_message (20261111500001_dm_blocks.sql): 42501 without a profile, P0002
-- for a conversation the caller is not an active participant of, P0001 DM_UNDELIVERABLE for a
-- direct conversation blocked between its two accounts.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

CREATE OR REPLACE FUNCTION public.check_dm_call(p_conversation_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
            SELECT 1 FROM public.conversation_participants cp
             WHERE cp.conversation_id = p_conversation_id
               AND cp.user_id = v_caller
               AND cp.left_at IS NULL) THEN
        RAISE EXCEPTION 'Conversation not found' USING ERRCODE = 'P0002';
    END IF;
    IF public.dm_conversation_blocked(p_conversation_id, v_caller) THEN
        RAISE EXCEPTION 'DM_UNDELIVERABLE'
            USING ERRCODE = 'P0001', HINT = 'This message could not be delivered.';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.check_dm_call(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_dm_call(uuid) TO authenticated, service_role;

-- Prod definers have mixed owners, postgres and supabase_admin. A definer runs as its owner, and a
-- non-superuser owner has no EXECUTE on a helper with PUBLIC revoked.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT DISTINCT pg_get_userbyid(p.proowner) AS owner
          FROM pg_proc p
         WHERE p.proname = 'check_dm_call' AND p.pronamespace = 'public'::regnamespace
    LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.dm_conversation_blocked(uuid, uuid) TO %I', r.owner);
    END LOOP;
END
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
