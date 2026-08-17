BEGIN;

-- Fix: Federated messages/posts were all showing "(edited)" because the
-- handle_messages_updated_at trigger unconditionally set updated_at := NOW()
-- on INSERT, creating a gap with the ActivityPub-sourced created_at timestamp.
--
-- Messages trigger: on INSERT default updated_at to created_at; on UPDATE
-- only bump when content changes.
CREATE OR REPLACE FUNCTION public.handle_messages_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.updated_at := COALESCE(NEW.created_at, NOW());
        RETURN NEW;
    END IF;

    -- UPDATE: only bump when message content is actually edited
    IF OLD.content IS DISTINCT FROM NEW.content THEN
        NEW.updated_at := NOW();
    END IF;
    RETURN NEW;
END;
$$;

-- Posts: add a BEFORE INSERT trigger to default updated_at to created_at
-- (the existing handle_posts_updated_at only fires on UPDATE)
CREATE OR REPLACE FUNCTION public.handle_posts_insert_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := COALESCE(NEW.created_at, NOW());
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS handle_posts_insert_updated_at ON public.posts;
CREATE TRIGGER handle_posts_insert_updated_at
    BEFORE INSERT ON public.posts
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_posts_insert_updated_at();

-- Backfill: fix already-imported federated messages/posts that wrongly appear edited
UPDATE public.messages
SET updated_at = created_at
WHERE metadata->>'federated' = 'true'
  AND updated_at - created_at > interval '2 seconds'
  AND NOT EXISTS (
    SELECT 1 FROM public.messages m2
    WHERE m2.id = messages.id
    AND m2.metadata->>'ap_updated' IS NOT NULL
  );

UPDATE public.posts
SET updated_at = created_at
WHERE is_local = false
  AND updated_at - created_at > interval '2 seconds';

-- Add update_post_embeds RPC for link preview enrichment on posts
CREATE OR REPLACE FUNCTION public.update_post_embeds(p_post_id uuid, p_embeds jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public' AS $$
begin
  update public.posts
  set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('embeds',
    coalesce(metadata->'embeds', '{}'::jsonb) || p_embeds
  )
  where id = p_post_id;
end;
$$;

GRANT EXECUTE ON FUNCTION public.update_post_embeds(uuid, jsonb) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
