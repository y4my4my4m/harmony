-- Post edits and deletes federate in full.
--
-- trigger_queue_post_federation queued Update(Note) only when content changed, so an edit
-- of the content warning, the sensitive flag or the media alone reached no remote instance.
-- Each of those now queues the update.
--
-- A delete blanks the content in the same UPDATE that sets is_deleted, and the delete job
-- read the mentioned recipients from the row after the blanking: a mentioned non-follower
-- never received the Delete. The delete job now carries the remote mentions of the content
-- the post held before the UPDATE (OLD.content), as {username, domain} pairs.
--
-- Converges by state: CREATE OR REPLACE of the baseline body with both changes.

BEGIN;

CREATE OR REPLACE FUNCTION public.trigger_queue_post_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_edited boolean;
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

    v_edited := NEW.content IS DISTINCT FROM OLD.content
        OR NEW.content_warning IS DISTINCT FROM OLD.content_warning
        OR NEW.is_sensitive IS DISTINCT FROM OLD.is_sensitive
        OR NEW.media_attachments IS DISTINCT FROM OLD.media_attachments;

    IF OLD.federation_status IS DISTINCT FROM NEW.federation_status
       AND NOT v_edited
       AND OLD.is_deleted IS NOT DISTINCT FROM NEW.is_deleted
       AND OLD.is_pinned IS NOT DISTINCT FROM NEW.is_pinned THEN
        RETURN NEW;
    END IF;

    IF NEW.is_deleted = true AND OLD.is_deleted = false THEN
        NEW.federation_status := 'queued';
        PERFORM public.queue_federation_job(
            'federate-post',
            jsonb_build_object(
                'type', 'delete',
                'post_id', NEW.id,
                'author_id', NEW.author_id,
                'mentions', COALESCE((
                    SELECT jsonb_agg(m.handle)
                      FROM (SELECT DISTINCT jsonb_build_object(
                                       'username', p ->> 'username',
                                       'domain', lower(p ->> 'domain')) AS handle
                              FROM jsonb_array_elements(
                                       CASE WHEN jsonb_typeof(OLD.content) = 'array'
                                            THEN OLD.content ELSE '[]'::jsonb END) p
                             WHERE p ->> 'type' = 'mention'
                               AND COALESCE(p ->> 'isLocal', 'false') <> 'true'
                               AND COALESCE(p ->> 'isBridged', 'false') <> 'true'
                               AND COALESCE(p ->> 'username', '') <> ''
                               AND COALESCE(p ->> 'domain', '') <> ''
                             LIMIT 50) m
                ), '[]'::jsonb)
            ),
            10, 5, 3600
        );
    ELSIF NEW.is_pinned IS DISTINCT FROM OLD.is_pinned THEN
        NEW.federation_status := 'queued';
        PERFORM public.queue_federation_job(
            'federate-post',
            jsonb_build_object('type', 'pin_change', 'post_id', NEW.id, 'author_id', NEW.author_id, 'is_pinned', NEW.is_pinned),
            5, 5, 3600
        );
    ELSIF v_edited THEN
        NEW.federation_status := 'queued';
        PERFORM public.queue_federation_job(
            'federate-post',
            jsonb_build_object('type', 'update', 'post_id', NEW.id, 'author_id', NEW.author_id, 'visibility', NEW.visibility),
            5, 5, 3600
        );
    END IF;

    RETURN NEW;
END;
$$;

COMMIT;
