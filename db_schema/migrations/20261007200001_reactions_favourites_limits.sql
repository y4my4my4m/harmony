-- A reaction is also a favourite; reaction limits.
--
-- Posts. A person's emoji reactions on a post imply their favourite: one `favorite` row per
-- (user, post), as before, with implied_by_reaction set when a reaction created it.
--
--   trg_reaction_implies_favourite   AFTER INSERT of an emoji_reaction: inserts the implied
--                                    favourite unless the person holds one.
--   trg_favourite_follows_reactions  AFTER DELETE. The last emoji_reaction takes an implied
--                                    favourite with it; an explicit one stays. Deleting a
--                                    favourite deletes the person's emoji reactions on the
--                                    post: one engagement, as Mastodon counts it.
--   add_post_emoji_reaction          a heart on an implied favourite makes it explicit.
--   trigger_unified_notification_interactions
--                                    skips an implied favourite; the reaction notifies.
--   trigger_queue_interaction_federation
--                                    the job payload carries `implied`.
--
-- Both paths of sync_reaction_favourite() and the post limit below take the advisory lock
-- post_reactions:<user>:<post>, so the existence checks see each other's commits.
--
-- favorites_count counts favourite rows, so distinct people, through
-- update_post_reaction_counts as before.
--
-- Limits.
--   Post: at most instance_config max_post_reactions_per_user (default 10, clamped to
--   1..100) emoji reactions per person per post. A local row over the limit raises
--   REACTION_LIMIT (23514); a remote row (is_local false) is dropped without error.
--   Message: at most 20 distinct (emoji_id, custom_emoji_content) per message, any number
--   per person. A new emoji past 20 raises REACTION_LIMIT; a federated row
--   (metadata.federated) is dropped. Advisory lock message_reactions:<message>.
--
-- Instance config writers converge in 20261006750001_instance_config_writers.sql.
--
-- federated_instances.software. record_instance_software(domain, software, version,
-- source) writes what the federation backend learned from NodeInfo or from an actor or
-- object document, with metadata.software_source. A value without software_source, other
-- than 'unknown', was set by an admin and is kept. A document never replaces a NodeInfo
-- answer. metadata.software_checked_at is the last NodeInfo attempt; a failed one keeps
-- the stored value. A missing row is created.
--
-- Existing rows converge by state. Every (user, post) holding an emoji_reaction and no
-- favourite gets an implied favourite, created_at of its first reaction, federation_status
-- skipped. User triggers on post_interactions are disabled for the statement and restored
-- to their prior state: nothing federates, notifies or broadcasts. Local posts recount
-- favorites_count from favourite rows; remote posts add the favourites inserted, so the
-- trigger's later decrement for each balances. A rerun inserts nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- post_interactions.implied_by_reaction
-- ---------------------------------------------------------------------------
ALTER TABLE public.post_interactions
    ADD COLUMN IF NOT EXISTS implied_by_reaction boolean NOT NULL DEFAULT false;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.post_interactions'::regclass
           AND conname = 'post_interactions_implied_is_favourite'
    ) THEN
        ALTER TABLE public.post_interactions
            ADD CONSTRAINT post_interactions_implied_is_favourite
            CHECK (NOT implied_by_reaction OR interaction_type = 'favorite');
    END IF;
END;
$$;

COMMENT ON COLUMN public.post_interactions.implied_by_reaction IS
'Favourite created by the person''s first emoji reaction; removed with their last.';

-- ---------------------------------------------------------------------------
-- instance_config max_post_reactions_per_user
-- ---------------------------------------------------------------------------
-- The key is appended to whatever list the instance carries; the picker reads it.
DO $do$
DECLARE
    v_keys text[] := public.public_instance_config_keys();
BEGIN
    IF NOT ('max_post_reactions_per_user' = ANY (v_keys)) THEN
        EXECUTE format(
            'CREATE OR REPLACE FUNCTION public.public_instance_config_keys() RETURNS text[] '
            'LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS %L',
            format('SELECT %L::text[]', v_keys || 'max_post_reactions_per_user'::text));
    END IF;
END;
$do$;

INSERT INTO public.instance_config (config_key, config_value, description)
VALUES ('max_post_reactions_per_user', '10'::jsonb,
        'Different emoji one person can react with on a post (1-100).')
ON CONFLICT (config_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Post reaction limit
-- ---------------------------------------------------------------------------
-- BEFORE INSERT, after trg_fold_heart_reaction: a heart is the favourite by then and is
-- not counted.
CREATE OR REPLACE FUNCTION public.check_emoji_reaction_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_raw text;
    v_limit integer;
    v_held integer;
BEGIN
    IF NEW.interaction_type IS DISTINCT FROM 'emoji_reaction' THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended('post_reactions:' || NEW.user_id::text || ':' || NEW.post_id::text, 0));

    SELECT ic.config_value #>> '{}' INTO v_raw
      FROM public.instance_config ic
     WHERE ic.config_key = 'max_post_reactions_per_user';
    v_limit := CASE WHEN v_raw ~ '^\s*\d{1,6}\s*$'
                    THEN LEAST(GREATEST(btrim(v_raw)::integer, 1), 100)
                    ELSE 10 END;

    SELECT count(*) INTO v_held
      FROM public.post_interactions pi
     WHERE pi.user_id = NEW.user_id
       AND pi.post_id = NEW.post_id
       AND pi.interaction_type = 'emoji_reaction';

    IF v_held < v_limit THEN
        RETURN NEW;
    END IF;

    IF NEW.is_local IS FALSE THEN
        RETURN NULL;
    END IF;

    RAISE EXCEPTION 'REACTION_LIMIT: % reactions per person on a post', v_limit
        USING ERRCODE = '23514';
END;
$$;

-- ---------------------------------------------------------------------------
-- Message reaction limit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_message_emoji_reaction_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_kinds integer;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('message_reactions:' || NEW.message_id::text, 0));

    -- Same grouping as get_message_reactions: one chip per (emoji_id, custom_emoji_content).
    IF EXISTS (
        SELECT 1 FROM public.reactions r
         WHERE r.message_id = NEW.message_id
           AND r.emoji_id IS NOT DISTINCT FROM NEW.emoji_id
           AND r.custom_emoji_content IS NOT DISTINCT FROM NEW.custom_emoji_content
    ) THEN
        RETURN NEW;
    END IF;

    SELECT count(*) INTO v_kinds
      FROM (SELECT DISTINCT r.emoji_id, r.custom_emoji_content
              FROM public.reactions r
             WHERE r.message_id = NEW.message_id) k;

    IF v_kinds < 20 THEN
        RETURN NEW;
    END IF;

    IF NEW.metadata->>'federated' = 'true' THEN
        RETURN NULL;
    END IF;

    RAISE EXCEPTION 'REACTION_LIMIT: 20 different emoji per message' USING ERRCODE = '23514';
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger t
         WHERE t.tgrelid = 'public.post_interactions'::regclass AND NOT t.tgisinternal
           AND t.tgfoid = 'public.check_emoji_reaction_limit()'::regprocedure
    ) THEN
        RAISE NOTICE 'no trigger calls check_emoji_reaction_limit; creating trigger_check_emoji_reaction_limit';
        CREATE TRIGGER trigger_check_emoji_reaction_limit
            BEFORE INSERT ON public.post_interactions
            FOR EACH ROW EXECUTE FUNCTION public.check_emoji_reaction_limit();
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger t
         WHERE t.tgrelid = 'public.reactions'::regclass AND NOT t.tgisinternal
           AND t.tgfoid = 'public.check_message_emoji_reaction_limit()'::regprocedure
    ) THEN
        RAISE NOTICE 'no trigger calls check_message_emoji_reaction_limit; creating trigger_check_message_emoji_reaction_limit';
        CREATE TRIGGER trigger_check_message_emoji_reaction_limit
            BEFORE INSERT ON public.reactions
            FOR EACH ROW EXECUTE FUNCTION public.check_message_emoji_reaction_limit();
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- sync_reaction_favourite
-- ---------------------------------------------------------------------------
-- ON CONFLICT without a target: production and fresh installs name the one-favourite index
-- differently (idx_post_interactions_non_emoji_unique, idx_post_interactions_unique).
CREATE OR REPLACE FUNCTION public.sync_reaction_favourite()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO public.post_interactions (user_id, post_id, interaction_type, is_local, implied_by_reaction)
        SELECT NEW.user_id, NEW.post_id, 'favorite', NEW.is_local, true
         WHERE NOT EXISTS (
             SELECT 1 FROM public.post_interactions f
              WHERE f.user_id = NEW.user_id
                AND f.post_id = NEW.post_id
                AND f.interaction_type = 'favorite')
        ON CONFLICT DO NOTHING;
        RETURN NULL;
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended('post_reactions:' || OLD.user_id::text || ':' || OLD.post_id::text, 0));

    IF OLD.interaction_type = 'favorite' THEN
        DELETE FROM public.post_interactions
         WHERE user_id = OLD.user_id
           AND post_id = OLD.post_id
           AND interaction_type = 'emoji_reaction';
    ELSIF NOT EXISTS (
        SELECT 1 FROM public.post_interactions r
         WHERE r.user_id = OLD.user_id
           AND r.post_id = OLD.post_id
           AND r.interaction_type = 'emoji_reaction'
    ) THEN
        DELETE FROM public.post_interactions
         WHERE user_id = OLD.user_id
           AND post_id = OLD.post_id
           AND interaction_type = 'favorite'
           AND implied_by_reaction;
    END IF;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_reaction_implies_favourite ON public.post_interactions;
CREATE TRIGGER trg_reaction_implies_favourite
    AFTER INSERT ON public.post_interactions
    FOR EACH ROW
    WHEN (NEW.interaction_type = 'emoji_reaction')
    EXECUTE FUNCTION public.sync_reaction_favourite();

DROP TRIGGER IF EXISTS trg_favourite_follows_reactions ON public.post_interactions;
CREATE TRIGGER trg_favourite_follows_reactions
    AFTER DELETE ON public.post_interactions
    FOR EACH ROW
    WHEN (OLD.interaction_type IN ('emoji_reaction', 'favorite'))
    EXECUTE FUNCTION public.sync_reaction_favourite();

-- ---------------------------------------------------------------------------
-- Notifications: an implied favourite is announced by its reaction
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_state "char";
BEGIN
    SELECT t.tgenabled INTO v_state
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.post_interactions'::regclass
       AND t.tgname = 'trigger_unified_notification_interactions';

    IF v_state IS NULL THEN
        RAISE NOTICE 'trigger_unified_notification_interactions absent; implied favourites notify through no trigger';
        RETURN;
    END IF;

    DROP TRIGGER trigger_unified_notification_interactions ON public.post_interactions;
    CREATE TRIGGER trigger_unified_notification_interactions
        AFTER INSERT ON public.post_interactions
        FOR EACH ROW
        WHEN (NOT NEW.implied_by_reaction)
        EXECUTE FUNCTION public.handle_unified_notification_processing();

    CASE v_state
        WHEN 'D' THEN ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_unified_notification_interactions;
        WHEN 'A' THEN ALTER TABLE public.post_interactions ENABLE ALWAYS TRIGGER trigger_unified_notification_interactions;
        WHEN 'R' THEN ALTER TABLE public.post_interactions ENABLE REPLICA TRIGGER trigger_unified_notification_interactions;
        ELSE NULL;
    END CASE;
END;
$$;

-- ---------------------------------------------------------------------------
-- trigger_queue_interaction_federation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_queue_interaction_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    -- Bookmarks are private. A reblog federates as the Announce of its boost post.
    IF TG_OP = 'INSERT' AND NEW.interaction_type IN ('bookmark', 'reblog') THEN
        NEW.federation_status := 'skipped';
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' AND OLD.interaction_type IN ('bookmark', 'reblog') THEN
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
                'custom_emoji_content', NEW.custom_emoji_content,
                'implied', NEW.implied_by_reaction
            ), 5, 3, 1800
        );
    ELSIF TG_OP = 'DELETE' THEN
        -- The Undo embeds the activity it reverses, emoji included.
        PERFORM public.queue_federation_job(
            'federate-reaction',
            jsonb_build_object(
                'type', 'delete',
                'interaction_id', OLD.id,
                'interaction_type', OLD.interaction_type,
                'post_id', OLD.post_id,
                'user_id', OLD.user_id,
                'emoji_id', OLD.emoji_id,
                'custom_emoji_content', OLD.custom_emoji_content,
                'implied', OLD.implied_by_reaction
            ), 5, 3, 1800
        );
        RETURN OLD;
    END IF;

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- add_post_emoji_reaction
-- ---------------------------------------------------------------------------
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

    -- The heart is the caller's favourite (is_heart_reaction), made explicit when a reaction
    -- implied it. Idempotent, as below.
    IF public.is_heart_reaction(v_resolved_content) THEN
        UPDATE post_interactions
           SET implied_by_reaction = false
         WHERE user_id = p_user_id
           AND post_id = p_post_id
           AND interaction_type = 'favorite'
        RETURNING id INTO v_interaction_id;

        IF v_interaction_id IS NOT NULL THEN
            RETURN v_interaction_id;
        END IF;

        BEGIN
            INSERT INTO post_interactions (user_id, post_id, interaction_type, is_local)
            VALUES (p_user_id, p_post_id, 'favorite', true)
            RETURNING id INTO v_interaction_id;
        EXCEPTION WHEN unique_violation THEN
            SELECT id INTO v_interaction_id
            FROM post_interactions
            WHERE user_id = p_user_id
              AND post_id = p_post_id
              AND interaction_type = 'favorite';
        END;

        RETURN v_interaction_id;
    END IF;

    -- Idempotent: an existing reaction is returned, not duplicated. A second row is a
    -- second count on the chip, and remove_post_emoji_reaction deletes every matching row
    -- in one statement.
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

-- ---------------------------------------------------------------------------
-- record_instance_software
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_instance_software(
    p_domain text,
    p_software text,
    p_version text,
    p_source text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_domain text := lower(btrim(p_domain));
    v_software text := NULLIF(lower(btrim(p_software)), '');
    v_row public.federated_instances%ROWTYPE;
    v_stored text;
    v_stored_source text;
    v_meta jsonb;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'record_instance_software is internal' USING ERRCODE = '42501';
    END IF;
    IF NULLIF(v_domain, '') IS NULL OR p_source NOT IN ('nodeinfo', 'document') THEN
        RAISE EXCEPTION 'a domain and a source of nodeinfo or document are required' USING ERRCODE = '22023';
    END IF;
    IF char_length(v_domain) > 253 OR char_length(v_software) > 64 THEN
        RAISE EXCEPTION 'domain or software too long' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.federated_instances (domain) VALUES (v_domain) ON CONFLICT (domain) DO NOTHING;

    SELECT * INTO v_row FROM public.federated_instances WHERE domain = v_domain FOR UPDATE;

    v_meta := CASE WHEN jsonb_typeof(v_row.metadata) = 'object' THEN v_row.metadata ELSE '{}'::jsonb END;
    v_stored := NULLIF(lower(btrim(v_row.software)), '');
    v_stored_source := v_meta->>'software_source';

    IF v_stored IS NOT NULL AND v_stored <> 'unknown' AND v_stored_source IS NULL THEN
        RETURN v_stored;
    END IF;
    IF v_stored = 'unknown' THEN
        v_stored := NULL;
    END IF;

    -- software_checked_at is the last NodeInfo attempt, answered or not.
    IF p_source = 'nodeinfo' THEN
        UPDATE public.federated_instances
           SET software = COALESCE(v_software, software),
               version = CASE WHEN v_software IS NOT NULL THEN left(p_version, 64) ELSE version END,
               updated_at = now(),
               metadata = v_meta
                   || jsonb_build_object('software_checked_at', now())
                   || CASE WHEN v_software IS NOT NULL
                           THEN jsonb_build_object('software_source', 'nodeinfo')
                           ELSE '{}'::jsonb END
         WHERE domain = v_domain;
        RETURN COALESCE(v_software, v_stored);
    END IF;

    IF v_software IS NULL OR v_stored_source = 'nodeinfo' OR v_software IS NOT DISTINCT FROM v_stored THEN
        RETURN COALESCE(v_stored, v_software);
    END IF;

    UPDATE public.federated_instances
       SET software = v_software,
           updated_at = now(),
           metadata = v_meta || jsonb_build_object('software_source', 'document')
     WHERE domain = v_domain;
    RETURN v_software;
END;
$$;

COMMENT ON FUNCTION public.record_instance_software(text, text, text, text) IS
'Software of a remote instance learned by the federation backend; an admin-set value is kept.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    FOREACH fn IN ARRAY ARRAY['public.sync_reaction_favourite()'::regprocedure,
                              'public.check_emoji_reaction_limit()'::regprocedure,
                              'public.check_message_emoji_reaction_limit()'::regprocedure,
                              'public.record_instance_software(text, text, text, text)'::regprocedure] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, grantee);
            END IF;
        END LOOP;
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Existing rows
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_names text[];
    v_states text[];
    v_posts uuid[];
    v_counts integer[];
    v_local bigint;
    v_remote bigint;
    i integer;
BEGIN
    SELECT array_agg(t.tgname::text ORDER BY t.tgname), array_agg(t.tgenabled::text ORDER BY t.tgname)
      INTO v_names, v_states
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.post_interactions'::regclass
       AND NOT t.tgisinternal;

    ALTER TABLE public.post_interactions DISABLE TRIGGER USER;

    WITH ins AS (
        INSERT INTO public.post_interactions
               (user_id, post_id, interaction_type, is_local, implied_by_reaction,
                federation_status, created_at)
        SELECT r.user_id, r.post_id, 'favorite', bool_or(COALESCE(r.is_local, true)), true,
               'skipped', min(r.created_at)
          FROM public.post_interactions r
         WHERE r.interaction_type = 'emoji_reaction'
           AND NOT EXISTS (
               SELECT 1 FROM public.post_interactions f
                WHERE f.user_id = r.user_id
                  AND f.post_id = r.post_id
                  AND f.interaction_type = 'favorite')
         GROUP BY r.user_id, r.post_id
        ON CONFLICT DO NOTHING
        RETURNING post_id
    )
    SELECT array_agg(s.post_id), array_agg(s.n)
      INTO v_posts, v_counts
      FROM (SELECT ins.post_id, count(*)::integer AS n FROM ins GROUP BY ins.post_id) s;

    FOR i IN 1 .. COALESCE(array_length(v_names, 1), 0) LOOP
        EXECUTE format('ALTER TABLE public.post_interactions %s TRIGGER %I',
                       CASE v_states[i]
                           WHEN 'O' THEN 'ENABLE'
                           WHEN 'A' THEN 'ENABLE ALWAYS'
                           WHEN 'R' THEN 'ENABLE REPLICA'
                           ELSE 'DISABLE' END,
                       v_names[i]);
    END LOOP;

    UPDATE public.posts p
       SET favorites_count = (SELECT count(*)::integer FROM public.post_interactions f
                               WHERE f.post_id = p.id AND f.interaction_type = 'favorite')
     WHERE p.id = ANY (COALESCE(v_posts, '{}'))
       AND p.is_local IS TRUE;
    GET DIAGNOSTICS v_local = ROW_COUNT;

    UPDATE public.posts p
       SET favorites_count = COALESCE(p.favorites_count, 0) + u.n
      FROM unnest(COALESCE(v_posts, '{}'), COALESCE(v_counts, '{}')) AS u(post_id, n)
     WHERE p.id = u.post_id
       AND p.is_local IS NOT TRUE;
    GET DIAGNOSTICS v_remote = ROW_COUNT;

    RAISE NOTICE 'implied favourites: % inserted on % post(s); % local recounted, % remote raised',
                 COALESCE((SELECT sum(c) FROM unnest(v_counts) c), 0),
                 COALESCE(array_length(v_posts, 1), 0), v_local, v_remote;
END
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
