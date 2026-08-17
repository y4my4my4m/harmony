-- Add a BEFORE UPDATE trigger on posts to set updated_at when content changes.
-- Without this, edited posts keep their original updated_at = created_at,
-- so the "(edited)" label never appears.
-- Only fires on content/CW/sensitive edits - not on federation_status or count changes.

BEGIN;

CREATE OR REPLACE FUNCTION public.handle_posts_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.content IS DISTINCT FROM NEW.content
       OR OLD.content_warning IS DISTINCT FROM NEW.content_warning
       OR OLD.is_sensitive IS DISTINCT FROM NEW.is_sensitive THEN
        NEW.updated_at := NOW();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS handle_posts_updated_at ON public.posts;
CREATE TRIGGER handle_posts_updated_at
    BEFORE UPDATE ON public.posts
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_posts_updated_at();

COMMIT;

NOTIFY pgrst, 'reload schema';
