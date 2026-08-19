-- Reconciles handle_group_participant_left between init/ and migrations/.
--
-- The migrated body declares v_leaving_profile and loads it:
--
--   SELECT * INTO v_leaving_profile FROM profiles WHERE id = NEW.user_id;
--
-- and then never reads it. The queue_federation_job payload is identical on
-- both sides -- conversation_id, user_id, change_type -- so the row fetch is a
-- query per participant leave whose result is discarded.
--
-- init/ carried over: same behaviour, without the read.

BEGIN;

CREATE OR REPLACE FUNCTION public.handle_group_participant_left()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_conversation conversations%ROWTYPE;
BEGIN
    IF OLD.left_at IS NOT NULL OR NEW.left_at IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT * INTO v_conversation FROM conversations WHERE id = NEW.conversation_id;

    IF v_conversation.type != 'group' THEN
        RETURN NEW;
    END IF;

    PERFORM public.queue_federation_job(
        'federate-group-participant-change',
        jsonb_build_object(
            'conversation_id', NEW.conversation_id,
            'user_id', NEW.user_id,
            'change_type', 'left'
        ),
        5, 5, 3600
    );

    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Group participant left federation failed: %', SQLERRM;
        RETURN NEW;
END;
$$;

COMMIT;
