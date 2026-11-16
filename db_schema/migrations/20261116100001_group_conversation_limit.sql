-- A group conversation holds at most 10 active participants, local and remote, as a Discord group
-- DM.
--
-- enforce_group_conversation_limit, BEFORE INSERT OR UPDATE OF left_at on conversation_participants,
-- covers every way into a group: create_group_conversation, add_user_to_conversation,
-- get_or_create_federated_group_conversation, and a rejoin, which is an INSERT ... ON CONFLICT DO
-- UPDATE SET left_at = NULL. A BEFORE INSERT trigger fires before the conflict is found, so a user
-- already active in the group passes: re-adding a member changes nothing. Anyone else is refused
-- once the group holds 10 active participants, with GROUP_CONVERSATION_FULL:10. A group already
-- larger keeps its members and admits nobody until it is below the limit.
--
-- The conversation row is locked before counting: two additions to a group of 9 cannot both pass.
-- Direct conversations are not counted here.

BEGIN;

CREATE OR REPLACE FUNCTION public.enforce_group_conversation_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_limit constant integer := 10;
BEGIN
    IF NEW.left_at IS NOT NULL OR (TG_OP = 'UPDATE' AND OLD.left_at IS NULL) THEN
        RETURN NEW;
    END IF;

    PERFORM 1 FROM public.conversations c
     WHERE c.id = NEW.conversation_id AND c.type = 'group'
       FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF EXISTS (SELECT 1 FROM public.conversation_participants cp
                WHERE cp.conversation_id = NEW.conversation_id
                  AND cp.user_id = NEW.user_id
                  AND cp.left_at IS NULL) THEN
        RETURN NEW;
    END IF;

    IF (SELECT count(*) FROM public.conversation_participants cp
         WHERE cp.conversation_id = NEW.conversation_id
           AND cp.left_at IS NULL) >= v_limit THEN
        RAISE EXCEPTION 'GROUP_CONVERSATION_FULL:%', v_limit
            USING ERRCODE = 'P0001', HINT = format('A group conversation holds at most %s people.', v_limit);
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_group_conversation_limit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_group_conversation_limit() TO service_role;

DROP TRIGGER IF EXISTS b_group_conversation_limit ON public.conversation_participants;
CREATE TRIGGER b_group_conversation_limit
    BEFORE INSERT OR UPDATE OF left_at ON public.conversation_participants
    FOR EACH ROW
    WHEN (NEW.left_at IS NULL)
    EXECUTE FUNCTION public.enforce_group_conversation_limit();

COMMIT;
