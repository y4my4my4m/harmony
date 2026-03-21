BEGIN;

-- Bookmarks are private/local-only and must never be federated.
-- Previously the trigger queued all post_interactions (including bookmarks)
-- which caused them to be sent as Like activities to remote instances.

CREATE OR REPLACE FUNCTION public.trigger_queue_interaction_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Bookmarks are private/local-only; never federate them
    IF TG_OP = 'INSERT' AND NEW.interaction_type = 'bookmark' THEN
        NEW.federation_status := 'skipped';
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' AND OLD.interaction_type = 'bookmark' THEN
        RETURN OLD;
    END IF;

    IF TG_OP = 'INSERT' THEN
        NEW.federation_status := 'queued';
        PERFORM public.queue_federation_job(
            'federate-reaction',
            jsonb_build_object(
                'type', 'create',
                'interaction_id', NEW.id,
                'interaction_type', NEW.interaction_type,
                'post_id', NEW.post_id,
                'user_id', NEW.user_id,
                'emoji_id', NEW.emoji_id,
                'custom_emoji_content', NEW.custom_emoji_content
            ), 5, 3, 1800
        );
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM public.queue_federation_job(
            'federate-reaction',
            jsonb_build_object(
                'type', 'delete',
                'interaction_id', OLD.id,
                'interaction_type', OLD.interaction_type,
                'post_id', OLD.post_id,
                'user_id', OLD.user_id
            ), 5, 3, 1800
        );
        RETURN OLD;
    END IF;

    RETURN NEW;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
