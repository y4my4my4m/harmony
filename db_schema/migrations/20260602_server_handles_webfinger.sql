-- =============================================================================
-- Server handles for WebFinger discovery
-- =============================================================================
-- Chat servers are already ActivityPub Group actors. To make them discoverable
-- the standard way (an `acct:` handle like `myserver@instance.com`, the same
-- pattern Lemmy uses for communities) every local server gets a stable `slug`.
-- WebFinger resolves `acct:{slug}@domain` to the server's Group actor, which
-- replaces the bespoke `harmony://server@…` scheme the discovery code used to
-- assume (and which was never actually served).
--
-- Remote servers keep slug NULL — they are addressed by their own ap_id/domain.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Column + format constraint
-- ---------------------------------------------------------------------------
ALTER TABLE public.servers
    ADD COLUMN IF NOT EXISTS slug text;

COMMENT ON COLUMN public.servers.slug IS
'Local handle for WebFinger/federation discovery (acct:{slug}@domain). Unique among local servers; NULL for remote servers.';

-- Format: start alphanumeric, then [a-z0-9_-], max 64. Enforced for non-null.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'servers_slug_format'
    ) THEN
        ALTER TABLE public.servers
            ADD CONSTRAINT servers_slug_format
            CHECK (slug IS NULL OR slug ~ '^[a-z0-9][a-z0-9_-]{0,63}$');
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Slug helpers (shared by the trigger and the backfill — DRY)
-- ---------------------------------------------------------------------------
-- Turn a display name into a slug-safe base, or NULL when nothing usable
-- remains (e.g. an all-CJK name), so callers can fall back to the id prefix.
CREATE OR REPLACE FUNCTION public.slugify_server_name(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT NULLIF(
        regexp_replace(
            regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g'),
            '(^-+|-+$)', '', 'g'
        ),
    '');
$$;

-- Produce a slug for a local server that is unique among local servers.
CREATE OR REPLACE FUNCTION public.generate_unique_server_slug(p_name text, p_id uuid)
RETURNS text
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    base text;
    candidate text;
    n integer := 0;
BEGIN
    base := left(coalesce(public.slugify_server_name(p_name), left(p_id::text, 8)), 60);
    candidate := base;
    -- Unique among local SERVERS only. Users (Person) and servers (Group) are
    -- distinct actor types and may share a handle; WebFinger disambiguates by
    -- AS type (Lemmy-style), so server slugs don't need to dodge usernames.
    WHILE EXISTS (
        SELECT 1 FROM public.servers s
        WHERE s.is_local_server = true
          AND lower(s.slug) = lower(candidate)
          AND s.id <> p_id
    ) LOOP
        n := n + 1;
        candidate := base || '-' || n;
    END LOOP;
    RETURN candidate;
END;
$$;

-- BEFORE INSERT: auto-assign a handle to local servers that don't supply one.
CREATE OR REPLACE FUNCTION public.assign_server_slug()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.is_local_server IS DISTINCT FROM true THEN
        RETURN NEW; -- remote servers keep NULL
    END IF;
    IF NEW.slug IS NOT NULL AND NEW.slug <> '' THEN
        RETURN NEW; -- explicit slug respected (format enforced by constraint)
    END IF;
    NEW.slug := public.generate_unique_server_slug(NEW.name, NEW.id);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_server_slug ON public.servers;
CREATE TRIGGER trg_assign_server_slug
    BEFORE INSERT ON public.servers
    FOR EACH ROW
    EXECUTE FUNCTION public.assign_server_slug();

-- ---------------------------------------------------------------------------
-- 3. Backfill existing local servers (deterministic order for stable suffixes)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT id, name FROM public.servers
        WHERE is_local_server = true AND (slug IS NULL OR slug = '')
        ORDER BY created_at
    LOOP
        UPDATE public.servers
        SET slug = public.generate_unique_server_slug(r.name, r.id)
        WHERE id = r.id;
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Uniqueness (case-insensitive, local servers only)
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_slug_local
    ON public.servers (lower(slug))
    WHERE is_local_server = true AND slug IS NOT NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';
