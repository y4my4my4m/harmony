-- Rows cached from activities that duplicate a copy's emoji are merged into it.
--
-- merge_copy_emoji_duplicates(p_server_id)
--   For each mirrored emoji of the copy (ap_id set), the rows of the same image without a server
--   or a Group id, of scope server, cached from the Group's instance: domain the copy row's domain
--   with or without its port, or the image's host (rows cached before 1.9.4). The copy sync takes
--   over the oldest such row (CopyMirrorService.applyGroupEmojis); the others kept the reactions
--   that named them, and the copy's pills of one emoji split in two.
--   Re-pointed to the copy's row: reactions, post reactions, emoji usage and favourites. A row
--   whose reactor already holds the copy's row on the same message or post stays where it is,
--   as do the duplicate it names, so every unique index holds and nothing is deleted that would
--   federate an Undo. A duplicate nothing names any more is deleted, unless it carries an
--   instance admin's removal (deleted_at without a matching ap_removed_at, 20261123400002): the
--   sync reads that removal for the image. Sounds and imports naming a duplicate keep it.
--   Returns the duplicates deleted. Service role only; a local server answers 0.
-- Once on existing instances: every copy is merged here. The sync calls it again after it takes
-- over or inserts a row.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.merge_copy_emoji_duplicates(p_server_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_deleted integer := 0;
    v_n integer;
    r record;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.is_local_server IS FALSE) THEN
        RETURN 0;
    END IF;

    -- The oldest copy row of an image takes its duplicates.
    FOR r IN
        SELECT DISTINCT ON (d.id) d.id AS dup_id, k.id AS keep_id,
               (d.deleted_at IS NOT NULL AND d.ap_removed_at IS DISTINCT FROM d.deleted_at) AS removed_by_person
          FROM public.emojis k
          JOIN public.emojis d
            ON d.url = k.url
           AND d.id <> k.id
           AND d.server_id IS NULL
           AND d.ap_id IS NULL
           AND d.scope = 'server'
           AND (lower(d.domain) = lower(k.domain)
                OR lower(d.domain) = regexp_replace(lower(k.domain), ':[0-9]+$', '')
                OR lower(d.domain) = lower(substring(d.url FROM '^[A-Za-z][A-Za-z0-9+.-]*://([^/?#]+)')))
         WHERE k.server_id = p_server_id
           AND k.ap_id IS NOT NULL
           AND k.url IS NOT NULL
         ORDER BY d.id, k.created_at, k.id
    LOOP
        -- reactions_message_user_emoji_unique, and reactions_message_id_user_id_emoji_id_key
        -- (message_id, user_id, emoji_id) where an instance still holds that older constraint:
        -- one row per person and emoji, whatever its content. A bot's row (no user_id) moves
        -- unless the same bot already holds the copy's row there.
        UPDATE public.reactions x
           SET emoji_id = r.keep_id
         WHERE x.emoji_id = r.dup_id
           AND NOT EXISTS (SELECT 1 FROM public.reactions y
                            WHERE y.message_id = x.message_id
                              AND y.emoji_id = r.keep_id
                              AND (y.user_id = x.user_id
                                   OR (x.user_id IS NULL AND y.user_id IS NULL
                                       AND y.bot_id IS NOT DISTINCT FROM x.bot_id)));

        -- idx_post_interactions_emoji_unique, and idx_post_interactions_unique_emoji_by_id
        -- (user_id, post_id, interaction_type, emoji_id) where an instance still holds it.
        UPDATE public.post_interactions x
           SET emoji_id = r.keep_id
         WHERE x.emoji_id = r.dup_id
           AND NOT EXISTS (SELECT 1 FROM public.post_interactions y
                            WHERE y.post_id = x.post_id
                              AND y.user_id IS NOT DISTINCT FROM x.user_id
                              AND y.interaction_type = x.interaction_type
                              AND y.emoji_id = r.keep_id);

        -- emoji_usage_unique_per_context.
        UPDATE public.emoji_usage x
           SET emoji_id = r.keep_id
         WHERE x.emoji_id = r.dup_id
           AND NOT EXISTS (SELECT 1 FROM public.emoji_usage y
                            WHERE y.emoji_id = r.keep_id
                              AND y.user_id = x.user_id
                              AND y.context_type = x.context_type
                              AND y.context_id IS NOT DISTINCT FROM x.context_id);

        -- emoji_favorites holds the id as text, unique per user.
        UPDATE public.emoji_favorites x
           SET emoji_id = r.keep_id::text
         WHERE x.emoji_id = r.dup_id::text
           AND NOT EXISTS (SELECT 1 FROM public.emoji_favorites y
                            WHERE y.user_id = x.user_id AND y.emoji_id = r.keep_id::text);

        CONTINUE WHEN r.removed_by_person
            OR EXISTS (SELECT 1 FROM public.reactions x WHERE x.emoji_id = r.dup_id)
            OR EXISTS (SELECT 1 FROM public.post_interactions x WHERE x.emoji_id = r.dup_id)
            OR EXISTS (SELECT 1 FROM public.emoji_usage x WHERE x.emoji_id = r.dup_id)
            OR EXISTS (SELECT 1 FROM public.server_sounds x WHERE x.emoji_id = r.dup_id)
            OR EXISTS (SELECT 1 FROM public.remote_emojis_cache x WHERE x.imported_as = r.dup_id);

        DELETE FROM public.emoji_favorites x WHERE x.emoji_id = r.dup_id::text;
        DELETE FROM public.emojis e WHERE e.id = r.dup_id;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_deleted := v_deleted + v_n;
    END LOOP;
    RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.merge_copy_emoji_duplicates(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_copy_emoji_duplicates(uuid) TO service_role;

DO $$
DECLARE
    v_server uuid;
    v_total integer := 0;
BEGIN
    FOR v_server IN
        SELECT DISTINCT e.server_id
          FROM public.emojis e
          JOIN public.servers s ON s.id = e.server_id AND s.is_local_server IS FALSE
         WHERE e.ap_id IS NOT NULL
    LOOP
        v_total := v_total + public.merge_copy_emoji_duplicates(v_server);
    END LOOP;
    RAISE NOTICE 'merge_copy_emoji_duplicates: % duplicate rows merged', v_total;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
