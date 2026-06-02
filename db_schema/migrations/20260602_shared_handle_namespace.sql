-- =============================================================================
-- Shared local actor-handle namespace (users + servers)
-- =============================================================================
-- On a single instance every WebFinger handle (acct:{localpart}@domain) must
-- resolve to exactly ONE actor. Users (Person) and chat servers (Group) share
-- that localpart namespace, so a username and a server slug can never be allowed
-- to collide — the same rule Mastodon enforces (a user and a group can't share a
-- handle on one instance).
--
-- We enforce this atomically with a single registry table whose unique index is
-- the source of truth, kept in sync by triggers on `profiles` and `servers`.
-- This is race-safe (two concurrent inserts can't both win — the index rejects
-- the loser) where a pair of cross-checking triggers would not be, and it scales
-- to future local actor types (bots, group-DM Groups, …) without reworking the
-- discovery path.
--
-- WebFinger keeps reading the source tables (profiles, then servers); because
-- collisions are now impossible, that lookup is unambiguous.
--
-- Runs after 20260602_server_handles_webfinger.sql (slugs already generated).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Registry table — one row per local actor, unique on lower(handle)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.local_actor_handles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    handle text NOT NULL,
    actor_type text NOT NULL CHECK (actor_type IN ('user', 'server')),
    actor_id uuid NOT NULL,
    created_at timestamptz DEFAULT now(),
    CONSTRAINT local_actor_handles_actor_key UNIQUE (actor_type, actor_id)
);

-- Case-insensitive uniqueness across the WHOLE namespace (users + servers).
CREATE UNIQUE INDEX IF NOT EXISTS uq_local_actor_handles_lower
    ON public.local_actor_handles (lower(handle));

COMMENT ON TABLE public.local_actor_handles IS
'Single shared handle namespace for local actors (users + chat servers). The unique index on lower(handle) guarantees a WebFinger localpart maps to exactly one actor. Maintained by triggers on profiles/servers; never written directly by the app.';

ALTER TABLE public.local_actor_handles ENABLE ROW LEVEL SECURITY;
-- No policies: only the table owner (SECURITY DEFINER trigger functions) and
-- service_role touch it. The app never queries it directly.

-- ---------------------------------------------------------------------------
-- 2. Sync trigger functions (SECURITY DEFINER so they can write under RLS)
-- ---------------------------------------------------------------------------
-- Local users occupy the namespace by username. Remote users / null usernames
-- release any handle they held.
CREATE OR REPLACE FUNCTION public.sync_actor_handle_for_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        DELETE FROM public.local_actor_handles
        WHERE actor_type = 'user' AND actor_id = OLD.id;
        RETURN OLD;
    END IF;

    IF NEW.is_local IS NOT TRUE OR NEW.username IS NULL OR NEW.username = '' THEN
        DELETE FROM public.local_actor_handles
        WHERE actor_type = 'user' AND actor_id = NEW.id;
        RETURN NEW;
    END IF;

    BEGIN
        INSERT INTO public.local_actor_handles (handle, actor_type, actor_id)
        VALUES (NEW.username, 'user', NEW.id)
        ON CONFLICT (actor_type, actor_id) DO UPDATE SET handle = EXCLUDED.handle;
    EXCEPTION WHEN unique_violation THEN
        -- Collides with another local actor's handle (user or server slug).
        -- Message contains 'username' so the app surfaces USERNAME_TAKEN.
        RAISE EXCEPTION 'username "%" is already in use on this instance', NEW.username
            USING ERRCODE = '23505';
    END;
    RETURN NEW;
END;
$$;

-- Local servers occupy the namespace by slug. Remote servers / null slugs
-- release any handle they held.
CREATE OR REPLACE FUNCTION public.sync_actor_handle_for_server()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        DELETE FROM public.local_actor_handles
        WHERE actor_type = 'server' AND actor_id = OLD.id;
        RETURN OLD;
    END IF;

    IF NEW.is_local_server IS NOT TRUE OR NEW.slug IS NULL OR NEW.slug = '' THEN
        DELETE FROM public.local_actor_handles
        WHERE actor_type = 'server' AND actor_id = NEW.id;
        RETURN NEW;
    END IF;

    BEGIN
        INSERT INTO public.local_actor_handles (handle, actor_type, actor_id)
        VALUES (NEW.slug, 'server', NEW.id)
        ON CONFLICT (actor_type, actor_id) DO UPDATE SET handle = EXCLUDED.handle;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'server handle "%" is already in use on this instance', NEW.slug
            USING ERRCODE = '23505';
    END;
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Slug generator now consults the registry (single source of truth)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_unique_server_slug(p_name text, p_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    base text;
    candidate text;
    n integer := 0;
BEGIN
    base := left(coalesce(public.slugify_server_name(p_name), left(p_id::text, 8)), 60);
    candidate := base;
    -- Avoid ANY existing handle in the shared namespace (users + servers),
    -- except this server's own row (so re-generation is stable).
    WHILE EXISTS (
        SELECT 1 FROM public.local_actor_handles h
        WHERE lower(h.handle) = lower(candidate)
          AND NOT (h.actor_type = 'server' AND h.actor_id = p_id)
    ) LOOP
        n := n + 1;
        candidate := base || '-' || n;
    END LOOP;
    RETURN candidate;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Backfill (users first as the authoritative namespace holders, then
--    servers; re-slug any server whose slug somehow still collides)
-- ---------------------------------------------------------------------------
INSERT INTO public.local_actor_handles (handle, actor_type, actor_id)
SELECT username, 'user', id
FROM public.profiles
WHERE is_local = true AND username IS NOT NULL AND username <> ''
ON CONFLICT DO NOTHING;

INSERT INTO public.local_actor_handles (handle, actor_type, actor_id)
SELECT slug, 'server', id
FROM public.servers
WHERE is_local_server = true AND slug IS NOT NULL AND slug <> ''
ON CONFLICT DO NOTHING;

-- Defensive: any local server that failed to register (pre-existing collision)
-- gets a fresh, namespace-unique slug. The UPDATE fires the sync trigger below
-- once it's installed — so do this AFTER creating triggers. (Handled in step 6.)

-- ---------------------------------------------------------------------------
-- 5. Triggers (AFTER, so they see finalized/sanitized values)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_sync_profile_handle ON public.profiles;
CREATE TRIGGER trg_sync_profile_handle
    AFTER INSERT OR DELETE OR UPDATE OF username, is_local ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.sync_actor_handle_for_profile();

DROP TRIGGER IF EXISTS trg_sync_server_handle ON public.servers;
CREATE TRIGGER trg_sync_server_handle
    AFTER INSERT OR DELETE OR UPDATE OF slug, is_local_server ON public.servers
    FOR EACH ROW EXECUTE FUNCTION public.sync_actor_handle_for_server();

-- ---------------------------------------------------------------------------
-- 6. Re-slug any still-unregistered local servers (collision repair)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT s.id, s.name FROM public.servers s
        WHERE s.is_local_server = true AND s.slug IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM public.local_actor_handles h
              WHERE h.actor_type = 'server' AND h.actor_id = s.id
          )
        ORDER BY s.created_at
    LOOP
        UPDATE public.servers
        SET slug = public.generate_unique_server_slug(r.name, r.id)
        WHERE id = r.id;  -- fires trg_sync_server_handle, which registers it
    END LOOP;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
