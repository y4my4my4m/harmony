-- Custom stickers: server, instance and personal, in bucket stickers.
--
-- public.stickers holds one row per sticker. scope 'server' rows belong to a local server
-- (server_id), 'instance' rows to the instance, 'user' rows to one account (owner_id).
-- Objects live in bucket stickers at
--   server/<server id>/<uuid>.<ext>
--   instance/<uuid>.<ext>
--   user/<profile id>/<uuid>.<ext>
-- with ext png, apng, webp or gif.
--
-- Limits, tighter than emoji:
--   bucket      file_size_limit 524288 (512 KB); image/png, image/apng, image/webp, image/gif.
--   create_sticker  re-reads the object's metadata size (at most 524288) and mimetype (one of
--               the four, matching the extension); width and height 1-320; duration_ms NULL for
--               a still image, else 1-5000; name 2-30 characters after trimming, no control
--               characters; description (alt text) 1-300 characters, required. Width, height
--               and duration are the uploader's decoded values: the database holds no image
--               bytes to measure.
--   caps        instance_config max_stickers_per_server (15), max_instance_stickers (50),
--               max_personal_stickers_per_user (0); 0 turns that scope off. Ceilings 100, 500
--               and 100. enforce_sticker_limit, a BEFORE INSERT trigger for every writer,
--               raises STICKER_LIMIT (23514) under the advisory lock
--               'stickers:<scope>:<server or owner>'. Rows past a lowered cap stay.
--
-- Writers. Server stickers: can_manage_server_stickers (the soundboard rule: owner, instance
-- admin, or a member holding MANAGE_EMOJIS on a local server). Instance stickers: instance
-- admins. Personal stickers: the owner, while the personal cap is above 0. Clients write rows
-- through create_sticker, update_sticker and delete_sticker only; delete_sticker also accepts
-- instance moderators, for any scope, and returns the object path for the caller to remove.
--
-- Messages. A sticker travels as one {type:'sticker', id, url, name, description, width,
-- height, mimeType} part beside an image {type:'file', stickerId, ...} part with the same url,
-- which clients before 1.9.2 and non-Harmony software render. check_message_sticker_parts
-- refuses a second sticker part and malformed ones.
--
-- Reports. report_type 'sticker' names reported_sticker_id; content_snapshot.sticker keeps
-- the sticker as reported. reported_user_id is the owner of a personal sticker, else NULL.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- instance_config caps
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
    v_keys text[] := public.public_instance_config_keys();
    v_key text;
BEGIN
    FOREACH v_key IN ARRAY ARRAY['max_stickers_per_server', 'max_instance_stickers',
                                 'max_personal_stickers_per_user'] LOOP
        IF NOT (v_key = ANY (v_keys)) THEN
            v_keys := v_keys || v_key;
        END IF;
    END LOOP;
    EXECUTE format(
        'CREATE OR REPLACE FUNCTION public.public_instance_config_keys() RETURNS text[] '
        'LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS %L',
        format('SELECT %L::text[]', v_keys));
END;
$do$;

INSERT INTO public.instance_config (config_key, config_value, description)
VALUES
    ('max_stickers_per_server', '15'::jsonb,
     'Stickers one server can hold (0-100). 0 turns server stickers off.'),
    ('max_instance_stickers', '50'::jsonb,
     'Instance stickers, available to every local account (0-500). 0 turns them off.'),
    ('max_personal_stickers_per_user', '0'::jsonb,
     'Personal stickers one account can hold (0-100). 0 turns personal stickers off.')
ON CONFLICT (config_key) DO NOTHING;

-- 'server' | 'instance' | 'user': the cap for that scope; 0 is off; unknown scopes read 0.
CREATE OR REPLACE FUNCTION public.sticker_limit(p_scope text)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN c.config_key IS NULL THEN 0
        WHEN (SELECT ic.config_value #>> '{}' FROM public.instance_config ic
               WHERE ic.config_key = c.config_key) ~ '^\s*0+\s*$' THEN 0
        ELSE public.get_instance_config_int(c.config_key, c.fallback, c.ceiling)
    END
      FROM (SELECT CASE p_scope
                       WHEN 'server' THEN 'max_stickers_per_server'
                       WHEN 'instance' THEN 'max_instance_stickers'
                       WHEN 'user' THEN 'max_personal_stickers_per_user'
                   END AS config_key,
                   CASE p_scope WHEN 'server' THEN 15 WHEN 'instance' THEN 50 ELSE 0 END AS fallback,
                   CASE p_scope WHEN 'instance' THEN 500 ELSE 100 END AS ceiling) c;
$$;

COMMENT ON FUNCTION public.sticker_limit(text) IS
'Sticker cap for a scope: max_stickers_per_server (15, at most 100), max_instance_stickers (50, at most 500), max_personal_stickers_per_user (0, at most 100). 0 is off.';

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stickers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    scope text NOT NULL,
    server_id uuid REFERENCES public.servers(id) ON DELETE CASCADE,
    owner_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
    uploader uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    name text NOT NULL,
    description text NOT NULL,
    path text NOT NULL,
    url text NOT NULL,
    mime_type text NOT NULL,
    file_size integer NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    duration_ms integer,
    CONSTRAINT stickers_scope_check CHECK (scope IN ('server', 'instance', 'user')),
    CONSTRAINT stickers_scope_server_check CHECK ((scope = 'server') = (server_id IS NOT NULL)),
    CONSTRAINT stickers_scope_owner_check CHECK ((scope = 'user') = (owner_id IS NOT NULL)),
    CONSTRAINT stickers_name_check CHECK (
        name = btrim(name) AND char_length(name) BETWEEN 2 AND 30 AND name !~ '[[:cntrl:]]'),
    CONSTRAINT stickers_description_check CHECK (
        description = btrim(description) AND char_length(description) BETWEEN 1 AND 300),
    CONSTRAINT stickers_path_check CHECK (
        path ~ '^(server/[0-9a-f-]{36}/|instance/|user/[0-9a-f-]{36}/)[0-9a-f-]{36}\.(png|apng|webp|gif)$'),
    CONSTRAINT stickers_url_check CHECK (char_length(url) <= 2048 AND url ~ '^https?://'),
    CONSTRAINT stickers_mime_type_check CHECK (
        mime_type IN ('image/png', 'image/apng', 'image/webp', 'image/gif')),
    CONSTRAINT stickers_file_size_check CHECK (file_size BETWEEN 1 AND 524288),
    CONSTRAINT stickers_dimensions_check CHECK (width BETWEEN 1 AND 320 AND height BETWEEN 1 AND 320),
    CONSTRAINT stickers_duration_check CHECK (duration_ms IS NULL OR duration_ms BETWEEN 1 AND 5000)
);

CREATE UNIQUE INDEX IF NOT EXISTS stickers_path_key ON public.stickers (path);
CREATE UNIQUE INDEX IF NOT EXISTS stickers_server_name_key
    ON public.stickers (server_id, lower(name)) WHERE scope = 'server';
CREATE UNIQUE INDEX IF NOT EXISTS stickers_instance_name_key
    ON public.stickers (lower(name)) WHERE scope = 'instance';
CREATE UNIQUE INDEX IF NOT EXISTS stickers_owner_name_key
    ON public.stickers (owner_id, lower(name)) WHERE scope = 'user';
CREATE INDEX IF NOT EXISTS idx_stickers_uploader ON public.stickers (uploader);

COMMENT ON TABLE public.stickers IS
    'Custom stickers of a local server, the instance or one account; files in bucket stickers.';

ALTER TABLE public.stickers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stickers_select_all ON public.stickers;
CREATE POLICY stickers_select_all ON public.stickers
    FOR SELECT TO anon, authenticated
    USING (true);

REVOKE ALL ON public.stickers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.stickers TO anon, authenticated;
GRANT ALL ON public.stickers TO service_role;

-- ---------------------------------------------------------------------------
-- Writers
-- ---------------------------------------------------------------------------

-- MANAGE_EMOJIS is Manage Expressions: the soundboard rule.
CREATE OR REPLACE FUNCTION public.can_manage_server_stickers(p_server_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(public.can_manage_server_sounds(p_server_id), false);
$$;

-- The caller may write (p_create) or remove the object p_name of bucket stickers.
CREATE OR REPLACE FUNCTION public.can_write_sticker_object(p_name text, p_create boolean)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN p_name ~ ('^server/' || c.re || '/' || c.re || c.ext) THEN
            public.can_manage_server_stickers(split_part(p_name, '/', 2)::uuid)
            AND (NOT p_create OR public.sticker_limit('server') > 0)
        WHEN p_name ~ ('^instance/' || c.re || c.ext) THEN
            public.is_current_user_admin()
            AND (NOT p_create OR public.sticker_limit('instance') > 0)
        WHEN p_name ~ ('^user/' || c.re || '/' || c.re || c.ext) THEN
            split_part(p_name, '/', 2) = public.get_current_profile_id()::text
            AND (NOT p_create OR public.sticker_limit('user') > 0)
        ELSE false
    END
      FROM (SELECT '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'::text AS re,
                   '\.(png|apng|webp|gif)$'::text AS ext) c;
$$;

-- The caller may rename, describe and remove p_sticker: the writers of its scope.
CREATE OR REPLACE FUNCTION public.can_manage_sticker(p_sticker public.stickers)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE p_sticker.scope
        WHEN 'server' THEN public.can_manage_server_stickers(p_sticker.server_id)
        WHEN 'instance' THEN public.is_current_user_admin()
        WHEN 'user' THEN p_sticker.owner_id = public.get_current_profile_id()
        ELSE false
    END;
$$;

-- ---------------------------------------------------------------------------
-- Caps
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_sticker_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_key uuid := COALESCE(NEW.server_id, NEW.owner_id);
    v_limit integer;
    v_held integer;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(
        'stickers:' || NEW.scope || ':' || COALESCE(v_key::text, ''), 0));

    v_limit := public.sticker_limit(NEW.scope);
    SELECT count(*) INTO v_held
      FROM public.stickers s
     WHERE s.scope = NEW.scope
       AND s.server_id IS NOT DISTINCT FROM NEW.server_id
       AND s.owner_id IS NOT DISTINCT FROM NEW.owner_id;

    IF v_held < v_limit THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'STICKER_LIMIT: at most % % stickers', v_limit, NEW.scope
        USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS enforce_sticker_limit ON public.stickers;
CREATE TRIGGER enforce_sticker_limit
    BEFORE INSERT ON public.stickers
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_sticker_limit();

-- ---------------------------------------------------------------------------
-- Client paths
-- ---------------------------------------------------------------------------

-- name and description of a sticker, trimmed and checked; raises STICKER_NAME or
-- STICKER_DESCRIPTION (22023).
CREATE OR REPLACE FUNCTION public.sticker_check_text(p_name text, p_description text)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 2 AND 30 OR p_name ~ '[[:cntrl:]]' THEN
        RAISE EXCEPTION 'STICKER_NAME: a sticker name is 2 to 30 characters' USING ERRCODE = '22023';
    END IF;
    IF p_description IS NULL OR char_length(btrim(p_description)) NOT BETWEEN 1 AND 300 THEN
        RAISE EXCEPTION 'STICKER_DESCRIPTION: a sticker description is 1 to 300 characters'
            USING ERRCODE = '22023';
    END IF;
END;
$$;

-- p_scope 'server' takes p_server_id; 'instance' and 'user' take NULL. p_path is the caller's
-- upload in bucket stickers under the scope's folder; p_url is
-- <origin>/storage/v1/object/public/stickers/<path>, its origin checked for shape as in
-- create_my_emoji. p_duration_ms is NULL for a still image.
CREATE OR REPLACE FUNCTION public.create_sticker(
    p_scope text,
    p_server_id uuid,
    p_path text,
    p_url text,
    p_name text,
    p_description text,
    p_width integer,
    p_height integer,
    p_duration_ms integer DEFAULT NULL
)
RETURNS public.stickers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_prefix text;
    v_suffix text;
    v_origin text;
    v_meta jsonb;
    v_size text;
    v_mime text;
    v_ext text;
    v_name text := btrim(COALESCE(p_name, ''));
    v_description text := btrim(COALESCE(p_description, ''));
    v_constraint text;
    v_row public.stickers;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
    END IF;

    IF p_scope = 'server' THEN
        IF p_server_id IS NULL OR NOT public.can_manage_server_stickers(p_server_id) THEN
            RAISE EXCEPTION 'STICKER_FORBIDDEN: managing this server''s stickers takes Manage Expressions'
                USING ERRCODE = '42501';
        END IF;
        v_prefix := 'server/' || p_server_id::text || '/';
    ELSIF p_scope = 'instance' THEN
        IF p_server_id IS NOT NULL OR NOT public.is_current_user_admin() THEN
            RAISE EXCEPTION 'STICKER_FORBIDDEN: instance stickers are for instance admins'
                USING ERRCODE = '42501';
        END IF;
        v_prefix := 'instance/';
    ELSIF p_scope = 'user' AND p_server_id IS NULL THEN
        v_prefix := 'user/' || v_me::text || '/';
    ELSE
        RAISE EXCEPTION 'STICKER_SCOPE: scope is server, instance or user' USING ERRCODE = '22023';
    END IF;

    IF p_path IS NULL OR p_path !~ ('^' || v_prefix
        || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|apng|webp|gif)$') THEN
        RAISE EXCEPTION 'STICKER_PATH: a sticker file is %<uuid>.<png|apng|webp|gif>', v_prefix
            USING ERRCODE = '22023';
    END IF;

    v_suffix := '/storage/v1/object/public/stickers/' || p_path;
    IF p_url IS NULL OR char_length(p_url) > 2048 OR right(p_url, char_length(v_suffix)) <> v_suffix THEN
        RAISE EXCEPTION 'STICKER_URL: the url is not the public URL of %', p_path USING ERRCODE = '22023';
    END IF;
    v_origin := left(p_url, char_length(p_url) - char_length(v_suffix));
    IF v_origin !~ '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)*$' THEN
        RAISE EXCEPTION 'STICKER_URL: the url is not the public URL of %', p_path USING ERRCODE = '22023';
    END IF;

    PERFORM public.sticker_check_text(v_name, v_description);

    IF p_width IS NULL OR p_height IS NULL OR p_width NOT BETWEEN 1 AND 320 OR p_height NOT BETWEEN 1 AND 320 THEN
        RAISE EXCEPTION 'STICKER_DIMENSIONS: a sticker is at most 320x320 pixels' USING ERRCODE = '22023';
    END IF;
    IF p_duration_ms IS NOT NULL AND p_duration_ms NOT BETWEEN 1 AND 5000 THEN
        RAISE EXCEPTION 'STICKER_DURATION: an animated sticker runs at most 5 seconds' USING ERRCODE = '22023';
    END IF;

    SELECT o.metadata INTO v_meta
      FROM storage.objects o
     WHERE o.bucket_id = 'stickers'
       AND o.name = p_path;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'STICKER_FILE_MISSING: % is not in the stickers bucket', p_path USING ERRCODE = '22023';
    END IF;

    v_size := v_meta ->> 'size';
    IF v_size IS NULL OR v_size !~ '^[0-9]{1,12}$' OR v_size::bigint NOT BETWEEN 1 AND 524288 THEN
        RAISE EXCEPTION 'STICKER_FILE_SIZE: a sticker file is at most 512 KB' USING ERRCODE = '22023';
    END IF;

    v_mime := lower(v_meta ->> 'mimetype');
    v_ext := substring(p_path from '\.([a-z]+)$');
    IF NOT ((v_ext IN ('png', 'apng') AND v_mime IN ('image/png', 'image/apng'))
            OR (v_ext = 'webp' AND v_mime = 'image/webp')
            OR (v_ext = 'gif' AND v_mime = 'image/gif')) THEN
        RAISE EXCEPTION 'STICKER_FILE_TYPE: a sticker is PNG, APNG, WebP or GIF' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.stickers (scope, server_id, owner_id, uploader, name, description, path, url,
                                 mime_type, file_size, width, height, duration_ms)
    VALUES (p_scope, p_server_id, CASE WHEN p_scope = 'user' THEN v_me END, v_me, v_name,
            v_description, p_path, p_url, v_mime, v_size::integer, p_width, p_height, p_duration_ms)
    RETURNING * INTO v_row;

    RETURN v_row;
EXCEPTION
    WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        IF v_constraint = 'stickers_path_key' THEN
            RAISE EXCEPTION 'STICKER_FILE_TAKEN: % is another sticker''s file', p_path USING ERRCODE = '23505';
        END IF;
        RAISE EXCEPTION 'STICKER_NAME_TAKEN: % is taken', v_name USING ERRCODE = '23505';
END;
$$;

COMMENT ON FUNCTION public.create_sticker(text, uuid, text, text, text, text, integer, integer, integer) IS
'Creates a server, instance or personal sticker from the caller''s upload in bucket stickers.';

-- NULL leaves a field as it is.
CREATE OR REPLACE FUNCTION public.update_sticker(
    p_sticker_id uuid,
    p_name text DEFAULT NULL,
    p_description text DEFAULT NULL
)
RETURNS public.stickers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.stickers;
BEGIN
    IF public.get_current_profile_id() IS NULL THEN
        RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_row FROM public.stickers s WHERE s.id = p_sticker_id FOR UPDATE;
    IF NOT FOUND OR NOT public.can_manage_sticker(v_row) THEN
        RAISE EXCEPTION 'Sticker not found' USING ERRCODE = 'P0002';
    END IF;

    v_row.name := btrim(COALESCE(p_name, v_row.name));
    v_row.description := btrim(COALESCE(p_description, v_row.description));
    PERFORM public.sticker_check_text(v_row.name, v_row.description);

    UPDATE public.stickers s
       SET name = v_row.name,
           description = v_row.description,
           updated_at = now()
     WHERE s.id = p_sticker_id
    RETURNING * INTO v_row;

    RETURN v_row;
EXCEPTION
    WHEN unique_violation THEN
        RAISE EXCEPTION 'STICKER_NAME_TAKEN: % is taken', v_row.name USING ERRCODE = '23505';
END;
$$;

-- Returns the removed sticker's object path. Instance moderators remove stickers of any scope.
CREATE OR REPLACE FUNCTION public.delete_sticker(p_sticker_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.stickers;
BEGIN
    IF public.get_current_profile_id() IS NULL THEN
        RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_row FROM public.stickers s WHERE s.id = p_sticker_id FOR UPDATE;
    IF NOT FOUND OR NOT (public.can_manage_sticker(v_row) OR public.is_current_user_admin_or_mod()) THEN
        RAISE EXCEPTION 'Sticker not found' USING ERRCODE = 'P0002';
    END IF;

    DELETE FROM public.stickers s WHERE s.id = p_sticker_id;
    RETURN v_row.path;
END;
$$;

-- ---------------------------------------------------------------------------
-- Message parts
-- ---------------------------------------------------------------------------

-- At most one sticker part; each with string id (1-200), http(s) url (at most 2048), name
-- (1-30) and description (1-300).
CREATE OR REPLACE FUNCTION public.check_message_sticker_parts()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_count integer;
    v_bad boolean;
BEGIN
    SELECT count(*),
           bool_or(NOT COALESCE(
               jsonb_typeof(e -> 'id') = 'string' AND char_length(e ->> 'id') BETWEEN 1 AND 200
               AND jsonb_typeof(e -> 'url') = 'string' AND char_length(e ->> 'url') <= 2048
               AND e ->> 'url' ~ '^https?://'
               AND jsonb_typeof(e -> 'name') = 'string' AND char_length(btrim(e ->> 'name')) BETWEEN 1 AND 30
               AND jsonb_typeof(e -> 'description') = 'string'
               AND char_length(btrim(e ->> 'description')) BETWEEN 1 AND 300, false))
      INTO v_count, v_bad
      FROM jsonb_array_elements(NEW.content) e
     WHERE e ->> 'type' = 'sticker';

    IF v_count > 1 THEN
        RAISE EXCEPTION 'STICKER_PARTS: a message holds at most one sticker' USING ERRCODE = '23514';
    END IF;
    IF v_bad THEN
        RAISE EXCEPTION 'STICKER_PART: a sticker part has id, url, name and description' USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS check_message_sticker_parts ON public.messages;
CREATE TRIGGER check_message_sticker_parts
    BEFORE INSERT OR UPDATE OF content ON public.messages
    FOR EACH ROW
    WHEN (jsonb_typeof(NEW.content) = 'array' AND NEW.content @> '[{"type": "sticker"}]'::jsonb)
    EXECUTE FUNCTION public.check_message_sticker_parts();

-- ---------------------------------------------------------------------------
-- Server audit log
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.server_audit_stickers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_keys constant text[] := ARRAY['name', 'description'];
    v_row public.stickers := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
BEGIN
    IF pg_trigger_depth() > 1 OR v_row.scope <> 'server' THEN
        RETURN NULL;
    END IF;

    PERFORM public.server_audit_write(
        v_row.server_id,
        CASE TG_OP WHEN 'INSERT' THEN 'sticker.create' WHEN 'UPDATE' THEN 'sticker.update' ELSE 'sticker.delete' END,
        'sticker', v_row.id::text, v_row.name,
        public.server_audit_diff(
            CASE WHEN TG_OP <> 'INSERT' THEN public.server_audit_pick(to_jsonb(OLD), v_keys) END,
            CASE WHEN TG_OP <> 'DELETE' THEN public.server_audit_pick(to_jsonb(NEW), v_keys) END));
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_stickers_audit ON public.stickers;
CREATE TRIGGER z_stickers_audit
    AFTER INSERT OR DELETE ON public.stickers
    FOR EACH ROW EXECUTE FUNCTION public.server_audit_stickers();
DROP TRIGGER IF EXISTS z_stickers_audit_update ON public.stickers;
CREATE TRIGGER z_stickers_audit_update
    AFTER UPDATE ON public.stickers
    FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name
                       OR OLD.description IS DISTINCT FROM NEW.description)
    EXECUTE FUNCTION public.server_audit_stickers();

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------
ALTER TABLE public.reports
    ADD COLUMN IF NOT EXISTS reported_sticker_id uuid REFERENCES public.stickers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_reports_reported_sticker
    ON public.reports (reported_sticker_id) WHERE reported_sticker_id IS NOT NULL;

ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_report_type_check;
ALTER TABLE public.reports ADD CONSTRAINT reports_report_type_check
    CHECK (report_type IN ('user', 'post', 'message', 'server', 'sticker'));

DROP FUNCTION IF EXISTS public.create_report(text, uuid, uuid, uuid, uuid, text, text, text, boolean, text, boolean);
DROP FUNCTION IF EXISTS public.create_report(text, uuid, uuid, uuid, uuid, text, text, text, boolean, text, boolean, uuid);

-- p_category defaults from p_reason. p_forward applies when the reported account is remote.
-- p_forward_to_server applies to a message in a server hosted elsewhere; NULL is true.
-- p_evidence_text is kept only for an encrypted message, as the reporter's plaintext.
-- p_reported_sticker_id names the sticker of a 'sticker' report.
-- Returns the new report, or the caller's open report on the same target.
CREATE FUNCTION public.create_report(
    p_report_type text,
    p_reported_user_id uuid DEFAULT NULL,
    p_reported_post_id uuid DEFAULT NULL,
    p_reported_message_id uuid DEFAULT NULL,
    p_reported_server_id uuid DEFAULT NULL,
    p_reason text DEFAULT 'other',
    p_category text DEFAULT NULL,
    p_comment text DEFAULT NULL,
    p_forward boolean DEFAULT false,
    p_evidence_text text DEFAULT NULL,
    p_forward_to_server boolean DEFAULT NULL,
    p_reported_sticker_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_caller_name text;
    v_target uuid := p_reported_user_id;
    v_target_local boolean;
    v_target_domain text;
    v_post_id uuid;
    v_message_id uuid;
    v_server_id uuid;
    v_sticker public.stickers;
    v_sticker_id uuid;
    v_author uuid;
    v_visibility text;
    v_content jsonb;
    v_channel uuid;
    v_conversation uuid;
    v_encrypted boolean := false;
    v_scope uuid;
    v_copy public.servers%ROWTYPE;
    v_to_server boolean := false;
    v_forward boolean;
    v_category text;
    v_snapshot jsonb;
    v_id uuid;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    SELECT p.username INTO v_caller_name
      FROM public.profiles p
     WHERE p.id = v_caller AND NOT COALESCE(p.is_suspended, false);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Suspended accounts cannot report' USING ERRCODE = '42501';
    END IF;

    v_category := COALESCE(p_category,
        CASE p_reason
            WHEN 'spam' THEN 'spam'
            WHEN 'illegal_content' THEN 'legal'
            WHEN 'harassment' THEN 'violation'
            WHEN 'impersonation' THEN 'violation'
            WHEN 'nsfw' THEN 'violation'
            ELSE 'other'
        END);
    IF v_category NOT IN ('spam', 'legal', 'violation', 'other') THEN
        RAISE EXCEPTION 'Invalid report category: %', v_category USING ERRCODE = '22023';
    END IF;

    IF p_reported_sticker_id IS NOT NULL AND p_report_type IS DISTINCT FROM 'sticker' THEN
        RAISE EXCEPTION 'Only a sticker report names a sticker' USING ERRCODE = '22023';
    END IF;

    IF p_report_type = 'post' THEN
        IF p_reported_post_id IS NULL OR p_reported_message_id IS NOT NULL THEN
            RAISE EXCEPTION 'A post report names one post' USING ERRCODE = '22023';
        END IF;
        SELECT po.author_id, po.visibility, po.content
          INTO v_author, v_visibility, v_content
          FROM public.posts po
         WHERE po.id = p_reported_post_id
           AND NOT COALESCE(po.is_deleted, false);
        IF NOT FOUND OR (
            v_author <> v_caller
            AND NOT (
                v_visibility IN ('public', 'unlisted')
                OR (v_visibility = 'followers' AND EXISTS (
                        SELECT 1 FROM public.follows f
                         WHERE f.follower_id = v_caller AND f.following_id = v_author
                           AND f.status = 'accepted'))
                OR EXISTS (SELECT 1 FROM public.timeline_entries te
                            WHERE te.user_id = v_caller AND te.post_id = p_reported_post_id)
                OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_content) part
                            WHERE part->>'type' = 'mention'
                              AND (part->>'userId' = v_caller::text
                                   OR part->>'user_id' = v_caller::text
                                   OR lower(part->>'username') = lower(v_caller_name)))
            )
        ) THEN
            RAISE EXCEPTION 'Post not found' USING ERRCODE = 'P0002';
        END IF;
        IF v_target IS NOT NULL AND v_target <> v_author THEN
            RAISE EXCEPTION 'Reported account is not the post author' USING ERRCODE = '22023';
        END IF;
        v_target := v_author;
        v_post_id := p_reported_post_id;

    ELSIF p_report_type = 'message' THEN
        IF p_reported_message_id IS NULL OR p_reported_post_id IS NOT NULL THEN
            RAISE EXCEPTION 'A message report names one message' USING ERRCODE = '22023';
        END IF;
        SELECT m.user_id, m.channel_id, m.conversation_id, COALESCE(m.encrypted, false)
          INTO v_author, v_channel, v_conversation, v_encrypted
          FROM public.messages m
         WHERE m.id = p_reported_message_id
           AND NOT COALESCE(m.is_deleted, false);
        IF NOT FOUND OR NOT (
            (v_channel IS NOT NULL AND public.can_view_channel(v_caller, v_channel))
            OR (v_conversation IS NOT NULL AND EXISTS (
                    SELECT 1 FROM public.conversation_participants cp
                     WHERE cp.conversation_id = v_conversation AND cp.user_id = v_caller))
        ) THEN
            RAISE EXCEPTION 'Message not found' USING ERRCODE = 'P0002';
        END IF;
        IF v_target IS NOT NULL AND v_target IS DISTINCT FROM v_author THEN
            RAISE EXCEPTION 'Reported account is not the message author' USING ERRCODE = '22023';
        END IF;
        v_target := v_author;
        v_message_id := p_reported_message_id;
        IF v_channel IS NOT NULL THEN
            SELECT s.id INTO v_scope
              FROM public.channels c
              JOIN public.servers s ON s.id = c.server_id
             WHERE c.id = v_channel AND COALESCE(s.is_local_server, true);
            SELECT s.* INTO v_copy
              FROM public.channels c
              JOIN public.servers s ON s.id = c.server_id
             WHERE c.id = v_channel AND s.is_local_server IS FALSE AND s.ap_id IS NOT NULL;
            v_to_server := v_copy.id IS NOT NULL AND COALESCE(p_forward_to_server, true);
        END IF;

    ELSIF p_report_type = 'user' THEN
        IF v_target IS NULL OR p_reported_post_id IS NOT NULL OR p_reported_message_id IS NOT NULL THEN
            RAISE EXCEPTION 'A user report names one account' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_target) THEN
            RAISE EXCEPTION 'Account not found' USING ERRCODE = 'P0002';
        END IF;

    ELSIF p_report_type = 'server' THEN
        IF p_reported_server_id IS NULL OR p_reported_post_id IS NOT NULL OR p_reported_message_id IS NOT NULL THEN
            RAISE EXCEPTION 'A server report names one server' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_reported_server_id) THEN
            RAISE EXCEPTION 'Server not found' USING ERRCODE = 'P0002';
        END IF;
        v_server_id := p_reported_server_id;
        v_target := NULL;

    ELSIF p_report_type = 'sticker' THEN
        IF p_reported_sticker_id IS NULL OR p_reported_post_id IS NOT NULL
           OR p_reported_message_id IS NOT NULL OR p_reported_server_id IS NOT NULL THEN
            RAISE EXCEPTION 'A sticker report names one sticker' USING ERRCODE = '22023';
        END IF;
        SELECT st.* INTO v_sticker FROM public.stickers st WHERE st.id = p_reported_sticker_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Sticker not found' USING ERRCODE = 'P0002';
        END IF;
        IF v_target IS NOT NULL AND v_target IS DISTINCT FROM v_sticker.owner_id THEN
            RAISE EXCEPTION 'Reported account is not the sticker owner' USING ERRCODE = '22023';
        END IF;
        v_target := v_sticker.owner_id;
        v_sticker_id := v_sticker.id;

    ELSE
        RAISE EXCEPTION 'Invalid report type: %', p_report_type USING ERRCODE = '22023';
    END IF;

    IF v_target = v_caller THEN
        RAISE EXCEPTION 'Cannot report yourself' USING ERRCODE = '22023';
    END IF;

    SELECT r.id INTO v_id
      FROM public.reports r
     WHERE r.reporter_id = v_caller
       AND r.status IN ('pending', 'investigating')
       AND r.report_type = p_report_type
       AND r.reported_user_id IS NOT DISTINCT FROM v_target
       AND r.reported_post_id IS NOT DISTINCT FROM v_post_id
       AND r.reported_message_id IS NOT DISTINCT FROM v_message_id
       AND r.reported_server_id IS NOT DISTINCT FROM v_server_id
       AND r.reported_sticker_id IS NOT DISTINCT FROM v_sticker_id
     LIMIT 1;
    IF v_id IS NOT NULL THEN
        RETURN v_id;
    END IF;

    IF (SELECT count(*) FROM public.reports r
         WHERE r.reporter_id = v_caller AND r.created_at > now() - interval '1 hour') >= 20 THEN
        RAISE EXCEPTION 'Report rate limit exceeded' USING ERRCODE = 'PT429';
    END IF;

    SELECT COALESCE(p.is_local, true), lower(p.domain) INTO v_target_local, v_target_domain
      FROM public.profiles p WHERE p.id = v_target;

    v_forward := COALESCE(p_forward, false) AND v_target_local IS FALSE
                 AND NOT (v_to_server AND v_target_domain IS NOT DISTINCT FROM public.server_host_domain(v_copy));

    v_snapshot := public.report_content_snapshot(
        v_target,
        CASE WHEN v_post_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[v_post_id] END,
        v_message_id,
        v_server_id);
    IF v_encrypted AND NULLIF(btrim(COALESCE(p_evidence_text, '')), '') IS NOT NULL THEN
        v_snapshot := jsonb_set(v_snapshot, '{message}',
            (v_snapshot->'message') || jsonb_build_object(
                'evidence_text', left(p_evidence_text, 4000),
                'evidence_source', 'reporter'));
    END IF;
    IF v_sticker_id IS NOT NULL THEN
        v_snapshot := COALESCE(v_snapshot, '{}'::jsonb) || jsonb_build_object('sticker', jsonb_build_object(
            'id', v_sticker.id,
            'scope', v_sticker.scope,
            'server_id', v_sticker.server_id,
            'server_name', (SELECT s.name FROM public.servers s WHERE s.id = v_sticker.server_id),
            'owner_id', v_sticker.owner_id,
            'uploader', v_sticker.uploader,
            'name', v_sticker.name,
            'description', v_sticker.description,
            'url', v_sticker.url,
            'path', v_sticker.path));
    END IF;

    INSERT INTO public.reports (
        reporter_id, reported_user_id, reported_post_id, reported_message_id, reported_server_id,
        reported_sticker_id, report_type, reason, category, comment, status, source, forward,
        content_snapshot, scope_server_id, forward_to_server)
    VALUES (
        v_caller, v_target, v_post_id, v_message_id, v_server_id,
        v_sticker_id, p_report_type, left(COALESCE(NULLIF(btrim(p_reason), ''), 'other'), 200), v_category,
        NULLIF(left(btrim(COALESCE(p_comment, '')), 1000), ''), 'pending', 'local',
        v_forward, v_snapshot, v_scope, v_to_server)
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Bucket and storage policies
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF to_regclass('storage.objects') IS NULL OR to_regclass('storage.buckets') IS NULL THEN
        RAISE NOTICE 'storage schema absent, stickers bucket and policies skipped';
        RETURN;
    END IF;

    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('stickers', 'stickers', true, 524288,
            ARRAY['image/png', 'image/apng', 'image/webp', 'image/gif'])
    ON CONFLICT (id) DO UPDATE SET
        public = true,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

    DROP POLICY IF EXISTS "Sticker writers read stickers" ON storage.objects;
    CREATE POLICY "Sticker writers read stickers" ON storage.objects
        AS PERMISSIVE FOR SELECT TO authenticated
        USING (bucket_id = 'stickers' AND (
            owner = (SELECT auth.uid())
            OR public.can_write_sticker_object(name, false)
            OR (SELECT public.is_current_user_admin_or_mod())));

    DROP POLICY IF EXISTS "Sticker writers upload stickers" ON storage.objects;
    CREATE POLICY "Sticker writers upload stickers" ON storage.objects
        AS PERMISSIVE FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'stickers' AND public.can_write_sticker_object(name, true));

    DROP POLICY IF EXISTS "Sticker writers delete stickers" ON storage.objects;
    CREATE POLICY "Sticker writers delete stickers" ON storage.objects
        AS PERMISSIVE FOR DELETE TO authenticated
        USING (bucket_id = 'stickers' AND (
            public.can_write_sticker_object(name, false)
            OR (SELECT public.is_current_user_admin_or_mod())));
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.sticker_limit(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sticker_limit(text) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.can_manage_server_stickers(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_server_stickers(uuid) TO authenticated, service_role;

-- Storage policies evaluate it as the uploading role.
REVOKE ALL ON FUNCTION public.can_write_sticker_object(text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_write_sticker_object(text, boolean) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.can_manage_sticker(public.stickers) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_sticker(public.stickers) TO service_role;

REVOKE ALL ON FUNCTION public.sticker_check_text(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sticker_check_text(text, text) TO service_role;

REVOKE ALL ON FUNCTION public.create_sticker(text, uuid, text, text, text, text, integer, integer, integer)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_sticker(text, uuid, text, text, text, text, integer, integer, integer)
    TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.update_sticker(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_sticker(uuid, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.delete_sticker(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_sticker(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.create_report(text, uuid, uuid, uuid, uuid, text, text, text, boolean, text, boolean, uuid)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_report(text, uuid, uuid, uuid, uuid, text, text, text, boolean, text, boolean, uuid)
    TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.enforce_sticker_limit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_sticker_limit() TO service_role;

REVOKE ALL ON FUNCTION public.check_message_sticker_parts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_message_sticker_parts() TO service_role;

REVOKE ALL ON FUNCTION public.server_audit_stickers() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.server_audit_stickers() TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
