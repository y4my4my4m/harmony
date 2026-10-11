-- Owners rename and delete their personal (scope = 'user') emojis; instance admins list,
-- rename and delete them as moderation. AI-generated emojis are user-scope rows with
-- is_ai_generated, server_id NULL and domain NULL.
--
-- rename_my_emoji(id, name) renames one of the caller's user-scope emojis. name is 2..64 of
-- [A-Za-z0-9_-]. Another user-scope emoji of the same owner with the same lower(name) is a
-- 23505; a row the caller does not own, or not user-scope, is a P0002. Only name and
-- updated_at change. Renames of one owner's emojis serialize on a transaction advisory lock
-- keyed 'user_emojis:<owner>', shared with admin_rename_instance_emoji.
--
-- Owners delete through emojis_delete_user_scope (baseline). The storage object stays, as on
-- admin_delete_instance_emoji: federated copies of posts reference its URL. The emojis bucket
-- delete policy keys on a server id in the first path segment, which ai/<profile>/ lacks.
--
-- emojis_update_user_scope is dropped. It let an owner rewrite every column of a user-scope
-- row, server_id and url included, so a personal emoji could be moved into any server's
-- emoji list. emojis_insert_user_scope additionally requires server_id and domain NULL for
-- the same reason; user-scope rows with a server are read by the server emoji fetch.
--
-- admin_list_instance_emojis gains source 'user' (every scope = 'user' row; search also
-- matches the owner's username) and an is_ai_generated column; 'all', 'local' and
-- 'remote' list the instance-level set as before. The return type changes, so the
-- function is dropped and recreated. admin_rename_instance_emoji and
-- admin_delete_instance_emoji accept user-scope rows; a user-scope rename is unique within
-- the owner's user-scope emojis. Reach for both: scope IN ('instance', 'user') OR server_id
-- IS NULL, which is the instance-level set of 20261009300001 plus user scope.
--
-- ai_emoji_generations records one row per generated emoji at insert and keeps it after the
-- emoji is deleted. federation-backend counts today's rows for the per-user and instance
-- caps (routes/gifs.ts countGeneratedToday); counting emojis rows let a deletion return
-- quota. Existing AI emojis are backfilled.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- Policies. ---------------------------------------------------------------------------
DROP POLICY IF EXISTS emojis_update_user_scope ON public.emojis;

DROP POLICY IF EXISTS emojis_insert_user_scope ON public.emojis;
CREATE POLICY emojis_insert_user_scope ON public.emojis
    FOR INSERT WITH CHECK (
        scope = 'user'
        AND server_id IS NULL
        AND domain IS NULL
        AND uploader = ( SELECT public.get_current_profile_id() )
    );

-- Owner rename. -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rename_my_emoji(p_emoji_id uuid, p_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_name text := btrim(p_name);
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
    END IF;
    IF v_name IS NULL OR v_name !~ '^[A-Za-z0-9_-]{2,64}$' THEN
        RAISE EXCEPTION 'Emoji names are 2 to 64 letters, digits, _ or -' USING ERRCODE = '22023';
    END IF;

    PERFORM 1
       FROM public.emojis e
      WHERE e.id = p_emoji_id
        AND e.scope = 'user'
        AND e.uploader = v_me
        FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Not one of your emojis' USING ERRCODE = 'P0002';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('user_emojis:' || v_me::text, 0));

    IF EXISTS (
        SELECT 1 FROM public.emojis e
         WHERE e.id <> p_emoji_id
           AND e.scope = 'user'
           AND e.uploader = v_me
           AND lower(e.name::text) = lower(v_name)) THEN
        RAISE EXCEPTION 'You have an emoji named %', v_name USING ERRCODE = '23505';
    END IF;

    UPDATE public.emojis SET name = v_name, updated_at = now() WHERE id = p_emoji_id;
END;
$$;

REVOKE ALL ON FUNCTION public.rename_my_emoji(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rename_my_emoji(uuid, text) TO authenticated, service_role;

-- Admin listing. ----------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_list_instance_emojis(text, text, text, integer, integer);

CREATE FUNCTION public.admin_list_instance_emojis(
    p_search text DEFAULT NULL,
    p_source text DEFAULT 'all',
    p_sort text DEFAULT 'newest',
    p_limit integer DEFAULT 50,
    p_offset integer DEFAULT 0)
RETURNS TABLE(
    id uuid,
    name text,
    url text,
    domain text,
    scope text,
    uploader uuid,
    uploader_username text,
    created_at timestamptz,
    usage_count integer,
    reaction_count bigint,
    total_count bigint,
    is_ai_generated boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_search text := lower(NULLIF(btrim(p_search), ''));
    v_source text := COALESCE(p_source, 'all');
    v_sort text := COALESCE(p_sort, 'newest');
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;
    IF v_source NOT IN ('all', 'local', 'remote', 'user') THEN
        RAISE EXCEPTION 'Unknown source: %', v_source USING ERRCODE = '22023';
    END IF;
    IF v_sort NOT IN ('newest', 'name') THEN
        RAISE EXCEPTION 'Unknown sort: %', v_sort USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    WITH matched AS (
        SELECT e.*, p.username::text AS owner_username, count(*) OVER () AS total
          FROM public.emojis e
          LEFT JOIN public.profiles p ON p.id = e.uploader
         WHERE CASE WHEN v_source = 'user' THEN e.scope = 'user'
                    ELSE (e.scope = 'instance' OR (e.server_id IS NULL AND e.scope <> 'user'))
                         AND (v_source = 'all'
                              OR (v_source = 'local' AND e.domain IS NULL)
                              OR (v_source = 'remote' AND e.domain IS NOT NULL))
               END
           AND (v_search IS NULL
                OR strpos(lower(e.name::text), v_search) > 0
                OR strpos(lower(COALESCE(e.domain, '')), v_search) > 0
                OR (v_source = 'user' AND strpos(lower(COALESCE(p.username::text, '')), v_search) > 0))
         ORDER BY CASE WHEN v_sort = 'name' THEN lower(e.name::text) END ASC NULLS LAST,
                  e.created_at DESC, e.id DESC
         LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200))
        OFFSET GREATEST(COALESCE(p_offset, 0), 0)
    )
    SELECT m.id, m.name::text, m.url::text, m.domain, m.scope, m.uploader,
           m.owner_username, m.created_at, COALESCE(m.usage_count, 0),
           (SELECT count(*) FROM public.reactions r WHERE r.emoji_id = m.id),
           m.total, m.is_ai_generated
      FROM matched m
     ORDER BY CASE WHEN v_sort = 'name' THEN lower(m.name::text) END ASC NULLS LAST,
              m.created_at DESC, m.id DESC;
END;
$$;

-- Admin rename. -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_rename_instance_emoji(p_emoji_id uuid, p_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_name text := btrim(p_name);
    v_domain text;
    v_scope text;
    v_uploader uuid;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;
    IF v_name IS NULL OR v_name !~ '^[A-Za-z0-9_-]{2,64}$' THEN
        RAISE EXCEPTION 'Emoji names are 2 to 64 letters, digits, _ or -' USING ERRCODE = '22023';
    END IF;

    SELECT e.domain, e.scope, e.uploader INTO v_domain, v_scope, v_uploader
      FROM public.emojis e
     WHERE e.id = p_emoji_id
       AND (e.scope IN ('instance', 'user') OR e.server_id IS NULL)
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Not an instance or user emoji' USING ERRCODE = 'P0002';
    END IF;

    IF v_scope = 'user' THEN
        IF v_uploader IS NOT NULL THEN
            PERFORM pg_advisory_xact_lock(hashtextextended('user_emojis:' || v_uploader::text, 0));
        END IF;
        IF EXISTS (
            SELECT 1 FROM public.emojis e
             WHERE e.id <> p_emoji_id
               AND e.scope = 'user'
               AND e.uploader = v_uploader
               AND lower(e.name::text) = lower(v_name)) THEN
            RAISE EXCEPTION 'The owner has an emoji named %', v_name USING ERRCODE = '23505';
        END IF;
    ELSIF EXISTS (
        SELECT 1 FROM public.emojis e
         WHERE e.id <> p_emoji_id
           AND (e.scope = 'instance' OR (e.server_id IS NULL AND e.scope <> 'user'))
           AND lower(e.name::text) = lower(v_name)
           AND e.domain IS NOT DISTINCT FROM v_domain) THEN
        RAISE EXCEPTION 'An instance emoji named % exists', v_name USING ERRCODE = '23505';
    END IF;

    UPDATE public.emojis SET name = v_name, updated_at = now() WHERE id = p_emoji_id;
END;
$$;

-- Admin delete. -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_delete_instance_emoji(p_emoji_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;

    DELETE FROM public.emojis e
     WHERE e.id = p_emoji_id
       AND (e.scope IN ('instance', 'user') OR e.server_id IS NULL);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Not an instance or user emoji' USING ERRCODE = 'P0002';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_instance_emojis(text, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_instance_emojis(text, text, text, integer, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_rename_instance_emoji(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_rename_instance_emoji(uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_delete_instance_emoji(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_instance_emoji(uuid) TO authenticated, service_role;

-- AI generation ledger. ---------------------------------------------------------------
-- emoji_id carries no foreign key: the row outlives the emoji.
CREATE TABLE IF NOT EXISTS public.ai_emoji_generations (
    emoji_id uuid PRIMARY KEY,
    profile_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_emoji_generations_created
    ON public.ai_emoji_generations (created_at);
CREATE INDEX IF NOT EXISTS idx_ai_emoji_generations_profile_created
    ON public.ai_emoji_generations (profile_id, created_at);

ALTER TABLE public.ai_emoji_generations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_emoji_generations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.ai_emoji_generations TO service_role;

DROP POLICY IF EXISTS ai_emoji_generations_service_role ON public.ai_emoji_generations;
CREATE POLICY ai_emoji_generations_service_role ON public.ai_emoji_generations
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.record_ai_emoji_generation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO public.ai_emoji_generations (emoji_id, profile_id, created_at)
    VALUES (NEW.id, NEW.uploader, NEW.created_at)
    ON CONFLICT (emoji_id) DO NOTHING;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.record_ai_emoji_generation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_emoji_generation() TO service_role;

DROP TRIGGER IF EXISTS record_ai_emoji_generation ON public.emojis;
CREATE TRIGGER record_ai_emoji_generation
    AFTER INSERT ON public.emojis
    FOR EACH ROW
    WHEN (NEW.is_ai_generated)
    EXECUTE FUNCTION public.record_ai_emoji_generation();

INSERT INTO public.ai_emoji_generations (emoji_id, profile_id, created_at)
SELECT e.id, e.uploader, e.created_at
  FROM public.emojis e
 WHERE e.is_ai_generated
ON CONFLICT (emoji_id) DO NOTHING;

COMMIT;
