BEGIN;

-- Allow direct and followers visibility posts to be federated.
-- Previously only public/unlisted were queued; direct posts were silently skipped.
CREATE OR REPLACE FUNCTION public.trigger_queue_post_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Skip remote posts (they came from federation, don't re-federate)
    IF NEW.is_local = false THEN
        NEW.federation_status := 'skipped';
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        NEW.federation_status := 'queued';
        PERFORM public.queue_federation_job(
            'federate-post',
            jsonb_build_object(
                'type', 'create',
                'post_id', NEW.id,
                'author_id', NEW.author_id,
                'visibility', NEW.visibility,
                'created_at', NEW.created_at
            ), 5, 5, 3600
        );
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD.federation_status IS DISTINCT FROM NEW.federation_status
           AND OLD.content = NEW.content
           AND OLD.is_deleted = NEW.is_deleted
           AND OLD.is_pinned = NEW.is_pinned THEN
            RETURN NEW;
        END IF;

        IF NEW.is_deleted = true AND OLD.is_deleted = false THEN
            NEW.federation_status := 'queued';
            PERFORM public.queue_federation_job(
                'federate-post',
                jsonb_build_object('type', 'delete', 'post_id', NEW.id, 'author_id', NEW.author_id),
                10, 5, 3600
            );
        ELSIF NEW.is_pinned IS DISTINCT FROM OLD.is_pinned THEN
            NEW.federation_status := 'queued';
            PERFORM public.queue_federation_job(
                'federate-post',
                jsonb_build_object('type', 'pin_change', 'post_id', NEW.id, 'author_id', NEW.author_id, 'is_pinned', NEW.is_pinned),
                5, 5, 3600
            );
        ELSIF NEW.content IS DISTINCT FROM OLD.content THEN
            NEW.federation_status := 'queued';
            PERFORM public.queue_federation_job(
                'federate-post',
                jsonb_build_object('type', 'update', 'post_id', NEW.id, 'author_id', NEW.author_id, 'visibility', NEW.visibility),
                5, 5, 3600
            );
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
