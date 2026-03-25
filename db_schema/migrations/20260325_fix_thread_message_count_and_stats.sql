BEGIN;

-- =============================================
-- Fix: Thread message_count always 0
-- The thread_message_handler trigger was missing from the init schema.
-- This trigger auto-adds thread members and maintains message_count,
-- last_message_id, last_message_at, and member_count on the threads table.
-- =============================================

-- 1. Create the thread message handler function
CREATE OR REPLACE FUNCTION public.thread_message_handler()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.thread_id IS NOT NULL THEN
        INSERT INTO public.thread_members (thread_id, user_id)
        VALUES (NEW.thread_id, NEW.user_id)
        ON CONFLICT (thread_id, user_id) DO NOTHING;

        UPDATE public.threads
        SET
            message_count = message_count + 1,
            last_message_id = NEW.id,
            last_message_at = NEW.created_at,
            updated_at = NOW(),
            archived = CASE WHEN locked THEN archived ELSE false END,
            archived_at = CASE WHEN locked THEN archived_at ELSE NULL END
        WHERE id = NEW.thread_id;

        UPDATE public.threads t
        SET member_count = (
            SELECT COUNT(*) FROM public.thread_members tm WHERE tm.thread_id = t.id
        )
        WHERE t.id = NEW.thread_id;
    END IF;
    RETURN NEW;
END;
$$;

-- 2. Create the thread message delete handler function
CREATE OR REPLACE FUNCTION public.thread_message_delete_handler()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF OLD.thread_id IS NOT NULL THEN
        UPDATE public.threads
        SET message_count = GREATEST(0, message_count - 1)
        WHERE id = OLD.thread_id;

        UPDATE public.threads t
        SET
            last_message_id = (
                SELECT id FROM public.messages
                WHERE thread_id = t.id AND NOT is_deleted
                ORDER BY created_at DESC LIMIT 1
            ),
            last_message_at = (
                SELECT created_at FROM public.messages
                WHERE thread_id = t.id AND NOT is_deleted
                ORDER BY created_at DESC LIMIT 1
            )
        WHERE t.id = OLD.thread_id;
    END IF;
    RETURN OLD;
END;
$$;

-- 3. Create the triggers
DROP TRIGGER IF EXISTS trigger_thread_message_insert ON public.messages;
CREATE TRIGGER trigger_thread_message_insert
    AFTER INSERT ON public.messages
    FOR EACH ROW
    WHEN (NEW.thread_id IS NOT NULL)
    EXECUTE FUNCTION public.thread_message_handler();

DROP TRIGGER IF EXISTS trigger_thread_message_delete ON public.messages;
CREATE TRIGGER trigger_thread_message_delete
    AFTER DELETE OR UPDATE OF is_deleted ON public.messages
    FOR EACH ROW
    WHEN (OLD.thread_id IS NOT NULL)
    EXECUTE FUNCTION public.thread_message_delete_handler();

-- 4. Backfill existing threads with correct counts
UPDATE public.threads t
SET
    message_count = COALESCE(stats.msg_count, 0),
    member_count = COALESCE(stats.mem_count, 0),
    last_message_id = stats.last_msg_id,
    last_message_at = stats.last_msg_at
FROM (
    SELECT
        t2.id AS thread_id,
        (SELECT COUNT(*) FROM public.messages m WHERE m.thread_id = t2.id AND NOT m.is_deleted) AS msg_count,
        (SELECT COUNT(*) FROM public.thread_members tm WHERE tm.thread_id = t2.id) AS mem_count,
        (SELECT m.id FROM public.messages m WHERE m.thread_id = t2.id AND NOT m.is_deleted ORDER BY m.created_at DESC LIMIT 1) AS last_msg_id,
        (SELECT m.created_at FROM public.messages m WHERE m.thread_id = t2.id AND NOT m.is_deleted ORDER BY m.created_at DESC LIMIT 1) AS last_msg_at
    FROM public.threads t2
) stats
WHERE t.id = stats.thread_id;

COMMIT;

NOTIFY pgrst, 'reload schema';
