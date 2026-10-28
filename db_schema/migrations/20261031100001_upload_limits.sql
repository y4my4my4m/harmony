-- Upload limits: the largest file an account may store in message_media or user_media
-- (channels, threads, direct and group conversations, posts, Drive).
--
-- Effective limit (upload_limit_bytes): the account's row in upload_limit_overrides, else its
-- tier from instance_config: instance admins upload_limit_admin_mb, instance moderators
-- upload_limit_moderator_mb, everyone else upload_limit_user_mb; never above the ceiling.
-- MB is 1048576 bytes, as in Drive.
--
-- Ceiling (upload_ceiling_bytes): storage-api's FILE_SIZE_LIMIT, which refuses a larger object
-- in every bucket, TUS included. The operator writes it together with the environment
-- (self-host: harmony config --upload-ceiling); an end-user session, admins included, cannot
-- write that key. Absent: 52428800, FILE_SIZE_LIMIT of the Supabase Docker stack.
--
-- message_media and user_media carry no bucket limit, so storage-api applies FILE_SIZE_LIMIT
-- to them. Avatars, banners, icons, emoji and soundboard keep their fixed bucket limits and
-- are not subject to these limits.
--
-- Enforcement (storage_upload_limit, BEFORE INSERT OR UPDATE on storage.objects). storage-api
-- v1.25-v1.29 (src/storage/uploader.ts, src/http/routes/tus/lifecycle.ts) writes an object row
-- in two places:
--   canUpload: an INSERT as the caller, rolled back, owner set and metadata NULL; before a
--     standard upload reads its body, and on every TUS request but HEAD and OPTIONS. The
--     transaction carries the HTTP request headers as request.headers (lower-case names); a TUS
--     creation's upload-length is the declared size.
--   completeUpload: INSERT ... ON CONFLICT of the stored object as the service role, owner and
--     metadata.size set, after the bytes reach the backend.
-- The trigger refuses with SQLSTATE 42501 when metadata.size, else the declared upload-length,
-- exceeds the owner's effective limit. storage-api renders 42501 as AccessDenied ("new row
-- violates row-level security policy"; HTTP 400 with statusCode "403" for a standard upload,
-- 403 for TUS) and, at completion, deletes the stored version (ObjectAdminDelete; synchronous
-- without PG_QUEUE_ENABLE). A TUS upload over the limit is refused at creation, before a byte
-- is sent; a standard upload once its body is stored. Same path as drive_track_object's
-- blocked-hash refusal.
-- An object without an owner (service role: bridges, the federation backend) has no
-- per-account limit. An UPDATE that keeps bucket and size is not checked: a rename, and the
-- ON CONFLICT branch of an upsert, whose proposed row the INSERT trigger already checked
-- (canUpload's upsert test carries the existing row's size under a new version).

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

-- Seeds: every tier at the lower of the two buckets' present limits, the ceiling at the higher
-- one or 52428800, so the largest upload an account could make before stays the same.
DO $$
DECLARE
    v_low bigint;
    v_high bigint;
BEGIN
    IF to_regclass('storage.buckets') IS NOT NULL THEN
        BEGIN
            SELECT min(b.file_size_limit), max(b.file_size_limit) INTO v_low, v_high
              FROM storage.buckets b
             WHERE b.id IN ('message_media', 'user_media') AND b.file_size_limit > 0;
        EXCEPTION WHEN insufficient_privilege THEN
            NULL;
        END;
    END IF;
    v_low := coalesce(v_low, 52428800);
    v_high := greatest(coalesce(v_high, 52428800), 52428800);

    INSERT INTO public.instance_config (config_key, config_value, description)
    SELECT k, to_jsonb(trim_scale(round(v_low / 1048576.0, 2))), d
      FROM (VALUES
              ('upload_limit_user_mb', 'Largest file an account uploads, MB'),
              ('upload_limit_moderator_mb', 'Largest file an instance moderator uploads, MB'),
              ('upload_limit_admin_mb', 'Largest file an instance admin uploads, MB')) s (k, d)
    ON CONFLICT (config_key) DO NOTHING;

    INSERT INTO public.instance_config (config_key, config_value, description)
    VALUES ('upload_ceiling_bytes', to_jsonb(v_high),
            'storage-api FILE_SIZE_LIMIT, bytes; set by the instance operator')
    ON CONFLICT (config_key) DO NOTHING;
END;
$$;

-- upload_ceiling_bytes follows the storage environment; no end-user session writes it.
CREATE OR REPLACE FUNCTION public.guard_instance_config_operator_keys()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF ((TG_OP <> 'DELETE' AND NEW.config_key = 'upload_ceiling_bytes')
        OR (TG_OP <> 'INSERT' AND OLD.config_key = 'upload_ceiling_bytes'))
       AND auth.uid() IS NOT NULL THEN
        RAISE EXCEPTION 'upload_ceiling_bytes is set by the instance operator with the storage FILE_SIZE_LIMIT'
            USING ERRCODE = '42501';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS a_instance_config_operator_keys ON public.instance_config;
CREATE TRIGGER a_instance_config_operator_keys
    BEFORE INSERT OR UPDATE OR DELETE ON public.instance_config
    FOR EACH ROW EXECUTE FUNCTION public.guard_instance_config_operator_keys();

-- ---------------------------------------------------------------------------
-- Overrides
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.upload_limit_overrides (
    profile_id uuid NOT NULL PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    limit_bytes bigint NOT NULL,
    set_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT upload_limit_overrides_bytes_check CHECK (limit_bytes >= 0)
);

CREATE INDEX IF NOT EXISTS idx_upload_limit_overrides_set_by ON public.upload_limit_overrides (set_by);

ALTER TABLE public.upload_limit_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS upload_limit_overrides_select_staff ON public.upload_limit_overrides;
CREATE POLICY upload_limit_overrides_select_staff ON public.upload_limit_overrides
    FOR SELECT TO authenticated
    USING ((SELECT public.is_current_user_admin_or_mod()));

REVOKE ALL ON public.upload_limit_overrides FROM anon, authenticated;
GRANT SELECT ON public.upload_limit_overrides TO authenticated;
GRANT ALL ON public.upload_limit_overrides TO service_role;

-- ---------------------------------------------------------------------------
-- Limits
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.upload_ceiling_bytes()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT least(greatest(public.drive_setting('upload_ceiling_bytes', 52428800), 0),
                 9223372036854775807)::bigint;
$$;

-- 'admin', 'moderator' or 'user'; 'user' for an unknown profile.
CREATE OR REPLACE FUNCTION public.upload_tier(p_profile uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT coalesce((SELECT CASE WHEN p.is_admin THEN 'admin'
                                 WHEN p.is_moderator THEN 'moderator'
                                 ELSE 'user' END
                       FROM public.profiles p
                      WHERE p.id = p_profile), 'user');
$$;

-- A tier's configured limit, bytes, before the ceiling.
CREATE OR REPLACE FUNCTION public.upload_tier_limit_bytes(p_tier text)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT (least(greatest(public.drive_setting(
                CASE p_tier WHEN 'admin' THEN 'upload_limit_admin_mb'
                            WHEN 'moderator' THEN 'upload_limit_moderator_mb'
                            ELSE 'upload_limit_user_mb' END, 50), 0),
                  8796093022207) * 1048576)::bigint;
$$;

CREATE OR REPLACE FUNCTION public.upload_limit_bytes(p_profile uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT least(coalesce((SELECT o.limit_bytes FROM public.upload_limit_overrides o
                            WHERE o.profile_id = p_profile),
                          public.upload_tier_limit_bytes(public.upload_tier(p_profile))),
                 public.upload_ceiling_bytes());
$$;

-- The caller's effective limit, bytes; NULL without a profile.
CREATE OR REPLACE FUNCTION public.get_my_upload_limit()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE WHEN s.me IS NULL THEN NULL ELSE public.upload_limit_bytes(s.me) END
      FROM (SELECT public.get_current_profile_id() AS me) s;
$$;

-- ---------------------------------------------------------------------------
-- Admin
-- ---------------------------------------------------------------------------

-- Tiers as configured (MB) and the ceiling (bytes). Instance admins and moderators.
CREATE OR REPLACE FUNCTION public.admin_upload_limits()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.is_current_user_admin_or_mod() THEN
        RAISE EXCEPTION 'Instance staff only' USING ERRCODE = '42501';
    END IF;
    RETURN jsonb_build_object(
        'user_mb', public.drive_setting('upload_limit_user_mb', 50),
        'moderator_mb', public.drive_setting('upload_limit_moderator_mb', 50),
        'admin_mb', public.drive_setting('upload_limit_admin_mb', 50),
        'ceiling_bytes', public.upload_ceiling_bytes(),
        'can_edit', public.is_current_user_admin());
END;
$$;

-- Sets the three tiers, MB. Instance admins; no tier above the ceiling.
CREATE OR REPLACE FUNCTION public.admin_set_upload_limits(p_user_mb numeric, p_moderator_mb numeric, p_admin_mb numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_ceiling bigint := public.upload_ceiling_bytes();
    v_key text;
    v_mb numeric;
    v_old jsonb;
BEGIN
    IF v_me IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;
    FOR v_key, v_mb IN
        SELECT * FROM (VALUES ('upload_limit_user_mb', p_user_mb),
                              ('upload_limit_moderator_mb', p_moderator_mb),
                              ('upload_limit_admin_mb', p_admin_mb)) s (k, mb)
    LOOP
        IF v_mb IS NULL OR v_mb < 0 THEN
            RAISE EXCEPTION '% must be 0 or more', v_key USING ERRCODE = '22023';
        END IF;
        IF v_mb * 1048576 > v_ceiling THEN
            RAISE EXCEPTION '% is above the ceiling of % bytes', v_key, v_ceiling USING ERRCODE = '22023';
        END IF;
    END LOOP;

    FOR v_key, v_mb IN
        SELECT * FROM (VALUES ('upload_limit_user_mb', p_user_mb),
                              ('upload_limit_moderator_mb', p_moderator_mb),
                              ('upload_limit_admin_mb', p_admin_mb)) s (k, mb)
    LOOP
        SELECT ic.config_value INTO v_old FROM public.instance_config ic WHERE ic.config_key = v_key;
        INSERT INTO public.instance_config (config_key, config_value, updated_at, updated_by)
        VALUES (v_key, to_jsonb(v_mb), now(), v_me)
        ON CONFLICT (config_key) DO UPDATE
           SET config_value = EXCLUDED.config_value, updated_at = now(), updated_by = EXCLUDED.updated_by;
        IF v_old IS DISTINCT FROM to_jsonb(v_mb) THEN
            PERFORM public.log_admin_action(v_me, 'config_change', 'config', v_key,
                jsonb_build_object('key', v_key, 'old_value', v_old, 'new_value', to_jsonb(v_mb)));
        END IF;
    END LOOP;
    RETURN public.admin_upload_limits();
END;
$$;

-- One account's limit: override, tier, effective and ceiling, bytes. Instance admins and
-- moderators.
CREATE OR REPLACE FUNCTION public.admin_get_upload_limit(p_profile uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tier text := public.upload_tier(p_profile);
BEGIN
    IF NOT public.is_current_user_admin_or_mod() THEN
        RAISE EXCEPTION 'Instance staff only' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_profile) THEN
        RAISE EXCEPTION 'No such profile' USING ERRCODE = 'P0002';
    END IF;
    RETURN jsonb_build_object(
        'override_bytes', (SELECT o.limit_bytes FROM public.upload_limit_overrides o WHERE o.profile_id = p_profile),
        'tier', v_tier,
        'tier_bytes', public.upload_tier_limit_bytes(v_tier),
        'effective_bytes', public.upload_limit_bytes(p_profile),
        'ceiling_bytes', public.upload_ceiling_bytes(),
        'can_edit', public.is_current_user_admin());
END;
$$;

-- Sets one local account's limit, bytes; NULL returns it to its tier. Instance admins; never
-- above the ceiling.
CREATE OR REPLACE FUNCTION public.admin_set_upload_limit(p_profile uuid, p_limit_bytes bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_profile AND p.is_local IS NOT FALSE) THEN
        RAISE EXCEPTION 'No such local profile' USING ERRCODE = 'P0002';
    END IF;
    IF p_limit_bytes IS NULL THEN
        DELETE FROM public.upload_limit_overrides WHERE profile_id = p_profile;
    ELSE
        IF p_limit_bytes < 0 THEN
            RAISE EXCEPTION 'An upload limit is not negative' USING ERRCODE = '22023';
        END IF;
        IF p_limit_bytes > public.upload_ceiling_bytes() THEN
            RAISE EXCEPTION 'Upload limit above the ceiling of % bytes', public.upload_ceiling_bytes()
                USING ERRCODE = '22023';
        END IF;
        INSERT INTO public.upload_limit_overrides (profile_id, limit_bytes, set_by, updated_at)
        VALUES (p_profile, p_limit_bytes, v_me, now())
        ON CONFLICT (profile_id) DO UPDATE
           SET limit_bytes = EXCLUDED.limit_bytes, set_by = EXCLUDED.set_by, updated_at = now();
    END IF;
    PERFORM public.log_admin_action(v_me, 'upload_limit', 'profile', p_profile::text,
                                    jsonb_build_object('limit_bytes', p_limit_bytes));
    RETURN public.admin_get_upload_limit(p_profile);
END;
$$;

-- ---------------------------------------------------------------------------
-- storage.objects
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.storage_upload_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_new jsonb := to_jsonb(NEW);
    v_owner text;
    v_profile uuid;
    v_size bigint;
    v_declared text;
    v_limit bigint;
BEGIN
    IF NEW.bucket_id NOT IN ('message_media', 'user_media') THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND NEW.bucket_id = OLD.bucket_id
       AND NEW.metadata ->> 'size' IS NOT DISTINCT FROM OLD.metadata ->> 'size' THEN
        RETURN NEW;
    END IF;

    -- owner_id (text) from storage-api v0.40 on; owner (uuid) before it.
    v_owner := coalesce(v_new ->> 'owner_id', v_new ->> 'owner');
    IF v_owner IS NULL
       OR v_owner !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN NEW;
    END IF;

    IF NEW.metadata ->> 'size' ~ '^\d{1,18}$' THEN
        v_size := (NEW.metadata ->> 'size')::bigint;
    ELSIF TG_OP = 'INSERT' THEN
        BEGIN
            v_declared := nullif(current_setting('request.headers', true), '')::jsonb ->> 'upload-length';
        EXCEPTION WHEN others THEN
            v_declared := NULL;
        END;
        IF v_declared ~ '^\d{1,18}$' THEN
            v_size := v_declared::bigint;
        END IF;
    END IF;
    IF v_size IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT p.id INTO v_profile FROM public.profiles p
     WHERE p.auth_user_id = v_owner::uuid AND p.is_local IS NOT FALSE;
    v_limit := public.upload_limit_bytes(v_profile);
    IF v_size > v_limit THEN
        RAISE EXCEPTION 'upload_limit_exceeded: % bytes, limit % bytes', v_size, v_limit
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DO $$
DECLARE
    r record;
BEGIN
    IF to_regclass('storage.objects') IS NULL OR to_regclass('storage.buckets') IS NULL THEN
        RAISE NOTICE 'storage schema absent, upload limit trigger and bucket limits skipped';
        RETURN;
    END IF;
    DROP TRIGGER IF EXISTS storage_upload_limit ON storage.objects;
    CREATE TRIGGER storage_upload_limit
        BEFORE INSERT OR UPDATE ON storage.objects
        FOR EACH ROW EXECUTE FUNCTION public.storage_upload_limit();

    FOR r IN
        UPDATE storage.buckets b SET file_size_limit = NULL
          FROM storage.buckets o
         WHERE b.id = o.id AND b.id IN ('message_media', 'user_media') AND b.file_size_limit IS NOT NULL
        RETURNING b.id, o.file_size_limit AS was
    LOOP
        RAISE NOTICE 'bucket % file_size_limit % removed: per-account upload limits apply', r.id, r.was;
    END LOOP;
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'storage.objects not writable by %, upload limit trigger and bucket limits skipped: %',
        current_user, SQLERRM;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.get_my_upload_limit()'::regprocedure,
        'public.admin_upload_limits()'::regprocedure,
        'public.admin_set_upload_limits(numeric, numeric, numeric)'::regprocedure,
        'public.admin_get_upload_limit(uuid)'::regprocedure,
        'public.admin_set_upload_limit(uuid, bigint)'::regprocedure]
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
    END LOOP;

    FOREACH fn IN ARRAY ARRAY[
        'public.upload_ceiling_bytes()'::regprocedure,
        'public.upload_tier(uuid)'::regprocedure,
        'public.upload_tier_limit_bytes(text)'::regprocedure,
        'public.upload_limit_bytes(uuid)'::regprocedure,
        'public.storage_upload_limit()'::regprocedure,
        'public.guard_instance_config_operator_keys()'::regprocedure]
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, grantee);
            END IF;
        END LOOP;
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
