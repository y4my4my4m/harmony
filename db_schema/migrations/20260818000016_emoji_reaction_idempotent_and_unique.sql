-- The same reaction from the same user is stored twice and favorites_count counts both.
--
-- add_post_emoji_reaction did a bare INSERT: no existence check, no ON CONFLICT. It could
-- not have used ON CONFLICT, because idx_post_interactions_unique is partial
-- (WHERE interaction_type != 'emoji_reaction') and emoji-reaction rows were covered by no
-- unique index at all, so any conflict target raised 42P10. update_post_reaction_counts adds
-- 1 to favorites_count per row, so each duplicate inflated the like count, and
-- remove_post_emoji_reaction - which deletes every matching row in one statement - dropped
-- the count by the whole duplicate run on the way out. The only guard was client-side: a
-- 100 ms pendingToggleKeys window plus a 30 s cached current_user_reacted, which does not
-- survive two tabs, two devices, or a stale cache.
--
-- Both halves land here: the function returns the existing row's id, and a unique index
-- backs it against the concurrent case the check alone cannot see.
--
-- NULLS NOT DISTINCT rather than COALESCE sentinels. emoji_id is null on a unicode or remote
-- reaction and custom_emoji_content is null on an emoji_id-only row, so the key must treat
-- null as a value. The nil uuid and the empty string are both legal column values, so a
-- sentinel can collide with real data; NULLS NOT DISTINCT cannot. It requires PostgreSQL 15:
-- prod and staging both dump as 15.8 and every Postgres image in this repo is
-- supabase/postgres:15.8.x.
--
-- EXISTING DUPLICATES. Building the index over them raises 23505, so they are removed rather
-- than refused: an instance that cannot migrate keeps producing more of them, and the rows
-- removed are equal on (user_id, post_id, emoji_id, custom_emoji_content) - nothing a reader
-- or the API can tell apart. The earliest of each run survives, by (created_at, id). The
-- count of rows removed, keys collapsed and posts touched is reported with RAISE NOTICE
-- before the DELETE. Discarded rows differ from the survivor only in id, created_at, ap_id,
-- is_local, federation_status and metadata; the survivor's ap_id is filled from the earliest
-- non-null in its run first, so the federation identity of the reaction is not lost.
--
-- The DELETE runs with three triggers off. trigger_federate_post_interaction_delete queues a
-- 'federate-reaction'/'delete' job keyed on (post_id, user_id) with no emoji discrimination,
-- which would send remote instances an Undo for a reaction the user still holds.
-- trg_broadcast_post_interaction would push a realtime removal to connected clients.
-- trigger_update_post_reaction_counts is off because favorites_count is recomputed below
-- from the surviving rows, which also repairs whatever the duplicates had already inflated.
-- Disabling them needs table ownership; self-host/bootstrap.sh pick_db_role() selects it.
--
-- The whole survey/dedupe/index sequence is one transaction so a failure anywhere restores
-- the triggers.

BEGIN;

CREATE OR REPLACE FUNCTION public.add_post_emoji_reaction(
    p_user_id uuid,
    p_post_id uuid,
    p_emoji_id uuid DEFAULT NULL,
    p_custom_emoji_content text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_interaction_id uuid;
    v_resolved_content text;
BEGIN
    -- SECURITY: Verify the caller owns this profile
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = p_user_id AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot create reactions as another user';
    END IF;

    IF p_emoji_id IS NULL AND p_custom_emoji_content IS NULL THEN
        RAISE EXCEPTION 'Must provide either emoji_id or custom_emoji_content';
    END IF;

    -- Auto-populate custom_emoji_content from emoji table when missing
    v_resolved_content := p_custom_emoji_content;
    IF p_emoji_id IS NOT NULL AND v_resolved_content IS NULL THEN
        SELECT CASE
            WHEN e.url IS NOT NULL THEN ':' || e.name || ':'
            ELSE e.name
        END INTO v_resolved_content
        FROM emojis e WHERE e.id = p_emoji_id;
    END IF;

    -- Idempotent: an existing reaction is returned, not duplicated.
    -- update_post_reaction_counts adds 1 to favorites_count per row, and
    -- remove_post_emoji_reaction deletes every matching row in one statement, so a second
    -- row inflates the count on the way in and drops it by two on the way out.
    -- IS NOT DISTINCT FROM matches idx_post_interactions_emoji_unique, which is
    -- NULLS NOT DISTINCT: emoji_id is null on a unicode reaction, custom_emoji_content is
    -- null on a row written without one.
    SELECT id INTO v_interaction_id
    FROM post_interactions
    WHERE user_id = p_user_id
      AND post_id = p_post_id
      AND interaction_type = 'emoji_reaction'
      AND emoji_id IS NOT DISTINCT FROM p_emoji_id
      AND custom_emoji_content IS NOT DISTINCT FROM v_resolved_content
    ORDER BY created_at, id
    LIMIT 1;

    IF v_interaction_id IS NOT NULL THEN
        RETURN v_interaction_id;
    END IF;

    BEGIN
        INSERT INTO post_interactions (
            user_id, post_id, interaction_type,
            emoji_id, custom_emoji_content, is_local
        ) VALUES (
            p_user_id, p_post_id, 'emoji_reaction',
            p_emoji_id, v_resolved_content, true
        ) RETURNING id INTO v_interaction_id;
    EXCEPTION WHEN unique_violation THEN
        -- Concurrent caller committed the same reaction between the check and the insert.
        -- READ COMMITTED gives the re-read a fresh snapshot, so the winning row is visible.
        SELECT id INTO v_interaction_id
        FROM post_interactions
        WHERE user_id = p_user_id
          AND post_id = p_post_id
          AND interaction_type = 'emoji_reaction'
          AND emoji_id IS NOT DISTINCT FROM p_emoji_id
          AND custom_emoji_content IS NOT DISTINCT FROM v_resolved_content
        ORDER BY created_at, id
        LIMIT 1;
    END;

    RETURN v_interaction_id;
END;
$$;

COMMIT;

-- Survey, dedupe, index. ------------------------------------------------------------------

BEGIN;

-- PARTITION BY groups nulls together, which is the key NULLS NOT DISTINCT enforces.
CREATE TEMP TABLE _emoji_reaction_dupes ON COMMIT DROP AS
WITH ranked AS (
    SELECT id, user_id, post_id, emoji_id, custom_emoji_content, ap_id,
           row_number() OVER (PARTITION BY user_id, post_id, emoji_id, custom_emoji_content
                              ORDER BY created_at, id) AS rn,
           count(*) OVER (PARTITION BY user_id, post_id, emoji_id, custom_emoji_content)
               AS run_length
      FROM public.post_interactions
     WHERE interaction_type = 'emoji_reaction'
)
SELECT * FROM ranked WHERE run_length > 1;

DO $$
DECLARE
    v_rows  bigint;
    v_keys  bigint;
    v_posts bigint;
BEGIN
    SELECT count(*) FILTER (WHERE rn > 1),
           count(*) FILTER (WHERE rn = 1),
           count(DISTINCT post_id)
      INTO v_rows, v_keys, v_posts
      FROM _emoji_reaction_dupes;

    IF v_rows = 0 THEN
        RAISE NOTICE 'post_interactions: no duplicate emoji reactions';
    ELSE
        RAISE NOTICE 'post_interactions: removing % duplicate emoji reaction row(s) across % reaction key(s) on % post(s); earliest of each kept',
            v_rows, v_keys, v_posts;
    END IF;
END;
$$;

-- No UPDATE trigger exists on post_interactions, so this fires nothing.
UPDATE public.post_interactions pi
   SET ap_id = src.ap_id
  FROM (SELECT DISTINCT ON (user_id, post_id, emoji_id, custom_emoji_content)
               user_id, post_id, emoji_id, custom_emoji_content, ap_id
          FROM _emoji_reaction_dupes
         WHERE ap_id IS NOT NULL
         ORDER BY user_id, post_id, emoji_id, custom_emoji_content, rn) src
 WHERE pi.id IN (SELECT id FROM _emoji_reaction_dupes WHERE rn = 1)
   AND pi.ap_id IS NULL
   AND pi.user_id = src.user_id
   AND pi.post_id = src.post_id
   AND pi.emoji_id IS NOT DISTINCT FROM src.emoji_id
   AND pi.custom_emoji_content IS NOT DISTINCT FROM src.custom_emoji_content;

-- tgenabled is recorded and restored rather than assumed 'O': a maintenance window that
-- called disable_federation_triggers() leaves trigger_federate_post_interaction_delete at
-- 'D', and a blanket ENABLE would turn federation back on under the operator.
CREATE TEMP TABLE _emoji_reaction_trigger_state ON COMMIT DROP AS
SELECT tgname, tgenabled
  FROM pg_trigger
 WHERE tgrelid = 'public.post_interactions'::regclass
   AND tgname IN ('trigger_federate_post_interaction_delete',
                  'trg_broadcast_post_interaction',
                  'trigger_update_post_reaction_counts');

ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_federate_post_interaction_delete;
ALTER TABLE public.post_interactions DISABLE TRIGGER trg_broadcast_post_interaction;
ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_update_post_reaction_counts;

DELETE FROM public.post_interactions
 WHERE id IN (SELECT id FROM _emoji_reaction_dupes WHERE rn > 1);

DO $$
DECLARE
    r record;
BEGIN
    FOR r IN SELECT tgname, tgenabled FROM _emoji_reaction_trigger_state LOOP
        EXECUTE format('ALTER TABLE public.post_interactions %s TRIGGER %I',
                       CASE r.tgenabled
                           WHEN 'D' THEN 'DISABLE'
                           WHEN 'R' THEN 'ENABLE REPLICA'
                           WHEN 'A' THEN 'ENABLE ALWAYS'
                           ELSE 'ENABLE'
                       END, r.tgname);
    END LOOP;
END;
$$;

-- favorites_count counts favorite and emoji_reaction rows together. Recomputed for the
-- touched posts only; every other post is whatever 20260818000010 left.
UPDATE public.posts p
   SET favorites_count = c.n
  FROM (SELECT t.post_id AS id,
               (SELECT count(*) FROM public.post_interactions i
                 WHERE i.post_id = t.post_id
                   AND i.interaction_type IN ('emoji_reaction', 'favorite')) AS n
          FROM (SELECT DISTINCT post_id FROM _emoji_reaction_dupes) t) c
 WHERE p.id = c.id
   AND p.favorites_count IS DISTINCT FROM c.n;

CREATE UNIQUE INDEX IF NOT EXISTS idx_post_interactions_emoji_unique
    ON public.post_interactions(user_id, post_id, emoji_id, custom_emoji_content)
    NULLS NOT DISTINCT
    WHERE interaction_type = 'emoji_reaction';

COMMIT;

NOTIFY pgrst, 'reload schema';
