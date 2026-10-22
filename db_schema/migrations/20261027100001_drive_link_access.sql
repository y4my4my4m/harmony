-- Drive link access: one address per file, /d/<drive_files.link_token>.
--
-- drive_files.link_token: base64url of 18 random bytes, fixed per file. The address opens the
-- file for whoever reads it (drive_file_readable). A live link share (scope 'link',
-- unexpired, file drive or ephemeral, drive_link_sharing on) opens it for anyone: "Anyone with
-- the link". Removing or expiring the link share leaves the address working for readers.
-- drive_link_reset is the only change of token.
--
-- drive_shares 'link' rows carry the file's link_token in token (composite foreign key,
-- cascades on reset): 1.8.11 clients build /d/ addresses from it. show_owner puts the owner's
-- name on the public page and in drive_link_resolve; otherwise neither names the owner.
--
-- Owner objects (drive_owner_json) carry emojis [{name, url}] for the display name:
-- federation_metadata.display_name_emojis, then for every :shortcode: of the display name not
-- covered there the public.emojis row fetchEmojiFromDb (src/services/emojiShortcodeResolver.ts)
-- picks: rows of the base name ordered by server_id, id; offset N for name~N, else the first.
--
-- drive_link_state(file) -> {token, public, link_expires_at, show_owner}
--   public           a live link share exists
--   link_expires_at  expiry of the link share, also once passed; NULL without one
--
-- drive_file_card(p_file, p_token):
--   a reader, by id or by token  {access, via 'file', id, bucket, path, name, mime_type, kind,
--                                 size_bytes, state, gone_reason, expires_at, created_at, own,
--                                 owner, token, public, link_expires_at, show_owner}
--   anyone else, by a token whose link share is live
--                                {access, via 'link', token, name, mime_type, kind, size_bytes,
--                                 created_at, expires_at (of the link share), owner | null}
--   otherwise                    {access: false}

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

ALTER TABLE public.drive_files ADD COLUMN IF NOT EXISTS link_token text;

-- A file with a link share keeps that share's token: posted /d/ addresses stay valid.
UPDATE public.drive_files f
   SET link_token = s.token
  FROM public.drive_shares s
 WHERE s.file_id = f.id
   AND s.scope = 'link'
   AND f.link_token IS NULL;

UPDATE public.drive_files
   SET link_token = translate(encode(extensions.gen_random_bytes(18), 'base64'), '+/', '-_')
 WHERE link_token IS NULL;

ALTER TABLE public.drive_files
    ALTER COLUMN link_token SET DEFAULT translate(encode(extensions.gen_random_bytes(18), 'base64'), '+/', '-_'),
    ALTER COLUMN link_token SET NOT NULL;

ALTER TABLE public.drive_shares ADD COLUMN IF NOT EXISTS show_owner boolean DEFAULT false NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.drive_files'::regclass AND conname = 'drive_files_link_token_key') THEN
        ALTER TABLE public.drive_files ADD CONSTRAINT drive_files_link_token_key UNIQUE (link_token);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.drive_files'::regclass AND conname = 'drive_files_id_link_token_key') THEN
        ALTER TABLE public.drive_files ADD CONSTRAINT drive_files_id_link_token_key UNIQUE (id, link_token);
    END IF;
    -- MATCH SIMPLE: rows without a token (user, server, channel shares) are not checked.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.drive_shares'::regclass AND conname = 'drive_shares_link_token_fkey') THEN
        ALTER TABLE public.drive_shares ADD CONSTRAINT drive_shares_link_token_fkey
            FOREIGN KEY (file_id, token) REFERENCES public.drive_files (id, link_token)
            ON UPDATE CASCADE ON DELETE CASCADE;
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Display of a file row for clients. Every caller returns rows to their owner or a reader.
CREATE OR REPLACE FUNCTION public.drive_file_json(f public.drive_files)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'id', f.id, 'owner_id', f.owner_id, 'bucket', f.bucket, 'path', f.path, 'name', f.name,
        'mime_type', f.mime_type, 'kind', public.drive_mime_kind(f.mime_type),
        'size_bytes', f.size_bytes, 'sha256', f.sha256, 'folder_id', f.folder_id, 'state', f.state,
        'gone_reason', f.gone_reason, 'expires_at', f.expires_at, 'trashed_at', f.trashed_at,
        'created_at', f.created_at, 'updated_at', f.updated_at, 'link_token', f.link_token);
$$;

CREATE OR REPLACE FUNCTION public.drive_owner_json(p_profile uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile public.profiles;
    v_meta jsonb := '{}'::jsonb;
    v_emojis jsonb := '[]'::jsonb;
    v_pinned text[] := ARRAY[]::text[];
    v_code text;
    v_base text;
    v_offset integer;
    v_url text;
    e jsonb;
BEGIN
    SELECT p.* INTO v_profile FROM public.profiles p WHERE p.id = p_profile;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF jsonb_typeof(v_profile.federation_metadata) = 'object' THEN
        v_meta := v_profile.federation_metadata;
    ELSIF jsonb_typeof(v_profile.federation_metadata) = 'string' THEN
        -- Rows written as a JSON-encoded string by older federation code.
        BEGIN
            v_meta := (v_profile.federation_metadata #>> '{}')::jsonb;
            IF jsonb_typeof(v_meta) IS DISTINCT FROM 'object' THEN
                v_meta := '{}'::jsonb;
            END IF;
        EXCEPTION WHEN invalid_text_representation THEN
            v_meta := '{}'::jsonb;
        END;
    END IF;

    IF jsonb_typeof(v_meta -> 'display_name_emojis') = 'array' THEN
        FOR e IN SELECT x FROM jsonb_array_elements(v_meta -> 'display_name_emojis') x LOOP
            CONTINUE WHEN jsonb_typeof(e) IS DISTINCT FROM 'object';
            v_code := replace(coalesce(e ->> 'name', ''), ':', '');
            v_url := e ->> 'url';
            CONTINUE WHEN v_code = '' OR coalesce(v_url, '') = '' OR v_code = ANY (v_pinned);
            v_pinned := v_pinned || v_code;
            v_emojis := v_emojis || jsonb_build_array(jsonb_build_object('name', v_code, 'url', v_url));
        END LOOP;
    END IF;

    -- A pinned emoji covers its name and name~N: resolveDisplayNameParts looks up the token,
    -- then its base name.
    IF v_profile.display_name IS NOT NULL THEN
        FOR v_code IN
            SELECT r.match[1]
              FROM regexp_matches(v_profile.display_name, ':([a-zA-Z0-9_+~-]+):', 'g') WITH ORDINALITY AS r(match, at)
             GROUP BY r.match[1]
             ORDER BY min(r.at)
        LOOP
            v_base := coalesce(substring(v_code FROM '^(.+)~\d+$'), v_code);
            CONTINUE WHEN v_code = ANY (v_pinned) OR v_base = ANY (v_pinned);
            -- Six digits at most: a longer suffix overflows integer and would fail every card.
            v_offset := coalesce(substring(v_code FROM '~(\d{1,6})$')::integer, 0);
            SELECT em.url INTO v_url
              FROM (SELECT em.url, row_number() OVER (ORDER BY em.server_id, em.id) - 1 AS n
                      FROM public.emojis em WHERE em.name = v_base) em
             ORDER BY (em.n = v_offset) DESC, em.n
             LIMIT 1;
            CONTINUE WHEN coalesce(v_url, '') = '';
            v_emojis := v_emojis || jsonb_build_array(jsonb_build_object('name', v_code, 'url', v_url));
        END LOOP;
    END IF;

    RETURN jsonb_build_object(
        'id', v_profile.id, 'username', v_profile.username, 'display_name', v_profile.display_name,
        'avatar_url', v_profile.avatar_url, 'domain', v_profile.domain, 'emojis', v_emojis);
END;
$$;

CREATE OR REPLACE FUNCTION public.drive_link_state(f public.drive_files)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'token', f.link_token,
        'public', s.id IS NOT NULL
                  AND (s.expires_at IS NULL OR s.expires_at > now())
                  AND f.state IN ('drive', 'ephemeral')
                  AND public.drive_link_sharing_enabled(),
        'link_expires_at', s.expires_at,
        'show_owner', coalesce(s.show_owner, false))
      FROM (SELECT 1) one
      LEFT JOIN public.drive_shares s ON s.file_id = f.id AND s.scope = 'link';
$$;

-- The file behind a live link share of p_token, else no row.
CREATE OR REPLACE FUNCTION public.drive_link_public_file(p_token text)
RETURNS SETOF public.drive_files
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT f.*
      FROM public.drive_files f
      JOIN public.drive_shares s ON s.file_id = f.id AND s.scope = 'link'
     WHERE f.link_token = p_token
       AND (s.expires_at IS NULL OR s.expires_at > now())
       AND f.state IN ('drive', 'ephemeral')
       AND public.drive_link_sharing_enabled();
$$;

-- ---------------------------------------------------------------------------
-- Owner calls
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.drive_link_set(
    p_file uuid,
    p_public boolean,
    p_expires_at timestamptz DEFAULT NULL,
    p_show_owner boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.drive_caller();
    v_file public.drive_files;
BEGIN
    SELECT f.* INTO v_file FROM public.drive_files f WHERE f.id = p_file AND f.owner_id = v_profile;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'File not found' USING ERRCODE = 'P0002';
    END IF;

    IF NOT coalesce(p_public, false) THEN
        DELETE FROM public.drive_shares s WHERE s.file_id = p_file AND s.scope = 'link';
        RETURN public.drive_link_state(v_file);
    END IF;

    IF NOT public.drive_link_sharing_enabled() THEN
        RAISE EXCEPTION 'Link sharing is turned off on this instance' USING ERRCODE = '42501';
    END IF;
    IF v_file.state NOT IN ('drive', 'ephemeral') THEN
        RAISE EXCEPTION 'File not found' USING ERRCODE = 'P0002';
    END IF;
    IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
        RAISE EXCEPTION 'The expiry is in the past' USING ERRCODE = '22023';
    END IF;

    -- created_at restarts with every change: 1.8.11 clients read the expiry choice as
    -- expires_at - created_at.
    INSERT INTO public.drive_shares (file_id, scope, token, expires_at, show_owner)
    VALUES (p_file, 'link', v_file.link_token, p_expires_at, coalesce(p_show_owner, false))
    ON CONFLICT (file_id) WHERE scope = 'link'
    DO UPDATE SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at,
                  show_owner = EXCLUDED.show_owner, created_at = now();
    RETURN public.drive_link_state(v_file);
END;
$$;

CREATE OR REPLACE FUNCTION public.drive_link_reset(p_file uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.drive_caller();
    v_file public.drive_files;
BEGIN
    UPDATE public.drive_files f
       SET link_token = translate(encode(extensions.gen_random_bytes(18), 'base64'), '+/', '-_')
     WHERE f.id = p_file AND f.owner_id = v_profile
    RETURNING f.* INTO v_file;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'File not found' USING ERRCODE = 'P0002';
    END IF;
    RETURN public.drive_link_state(v_file);
END;
$$;

-- 1.8.11 signature and behaviour, for 1.8.11 clients only: a new token on every call (their share
-- dialog revokes a leaked link by turning it off and on), then public with this expiry;
-- show_owner is kept.
CREATE OR REPLACE FUNCTION public.drive_link_create(p_file uuid, p_expires_at timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_share public.drive_shares;
BEGIN
    PERFORM public.drive_link_reset(p_file);
    PERFORM public.drive_link_set(p_file, true, p_expires_at, coalesce(
        (SELECT s.show_owner FROM public.drive_shares s WHERE s.file_id = p_file AND s.scope = 'link'), false));
    SELECT s.* INTO v_share FROM public.drive_shares s WHERE s.file_id = p_file AND s.scope = 'link';
    RETURN to_jsonb(v_share);
END;
$$;

-- ---------------------------------------------------------------------------
-- Readers
-- ---------------------------------------------------------------------------

-- What the public page shows. Anyone holding the token of a live link share.
CREATE OR REPLACE FUNCTION public.drive_link_resolve(p_token text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'name', coalesce(f.name, 'file'), 'mime_type', f.mime_type, 'kind', public.drive_mime_kind(f.mime_type),
        'size_bytes', f.size_bytes, 'created_at', f.created_at, 'expires_at', s.expires_at,
        -- A hidden owner is an object of nulls: the 1.8.11 link page reads owner.display_name
        -- without a guard and throws on null.
        'owner', CASE WHEN s.show_owner THEN public.drive_owner_json(f.owner_id)
                      ELSE jsonb_build_object('id', NULL, 'username', NULL, 'display_name', NULL,
                                              'avatar_url', NULL, 'domain', NULL, 'emojis', '[]'::jsonb) END)
      FROM public.drive_link_public_file(p_token) f
      JOIN public.drive_shares s ON s.file_id = f.id AND s.scope = 'link';
$$;

-- Object behind a live link share, for the federation-backend link route. Service callers only.
CREATE OR REPLACE FUNCTION public.drive_link_target(p_token text)
RETURNS TABLE (bucket text, path text, name text, mime_type text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'drive_link_target is for service callers' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    SELECT f.bucket, f.path, f.name, f.mime_type FROM public.drive_link_public_file(p_token) f;
END;
$$;

CREATE OR REPLACE FUNCTION public.drive_file_card(p_file uuid DEFAULT NULL, p_token text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.get_current_profile_id();
    v_none constant jsonb := jsonb_build_object('access', false);
    v_file public.drive_files;
    v_link public.drive_shares;
BEGIN
    IF p_token IS NOT NULL THEN
        IF p_token !~ '^[A-Za-z0-9_-]{16,64}$' THEN
            RETURN v_none;
        END IF;
        SELECT f.* INTO v_file FROM public.drive_files f WHERE f.link_token = p_token;
        IF NOT FOUND THEN
            RETURN v_none;
        END IF;
        IF NOT public.drive_file_readable(v_file.id, v_profile) THEN
            SELECT s.* INTO v_link
              FROM public.drive_link_public_file(p_token) f
              JOIN public.drive_shares s ON s.file_id = f.id AND s.scope = 'link';
            IF NOT FOUND THEN
                RETURN v_none;
            END IF;
            RETURN jsonb_build_object(
                'access', true, 'via', 'link', 'token', v_file.link_token,
                'name', coalesce(v_file.name, 'file'), 'mime_type', v_file.mime_type,
                'kind', public.drive_mime_kind(v_file.mime_type), 'size_bytes', v_file.size_bytes,
                'created_at', v_file.created_at, 'expires_at', v_link.expires_at,
                'owner', CASE WHEN v_link.show_owner THEN public.drive_owner_json(v_file.owner_id) END);
        END IF;
    ELSE
        IF p_file IS NULL OR NOT public.drive_file_readable(p_file, v_profile) THEN
            RETURN v_none;
        END IF;
        SELECT f.* INTO v_file FROM public.drive_files f WHERE f.id = p_file;
    END IF;

    RETURN jsonb_build_object(
        'access', true, 'via', 'file',
        'id', v_file.id, 'bucket', v_file.bucket, 'path', v_file.path,
        'name', v_file.name, 'mime_type', v_file.mime_type,
        'kind', public.drive_mime_kind(v_file.mime_type), 'size_bytes', v_file.size_bytes,
        'state', v_file.state, 'gone_reason', v_file.gone_reason,
        'expires_at', v_file.expires_at, 'created_at', v_file.created_at,
        'own', v_file.owner_id = v_profile, 'owner', public.drive_owner_json(v_file.owner_id))
        || public.drive_link_state(v_file);
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
        'public.drive_link_set(uuid, boolean, timestamptz, boolean)'::regprocedure,
        'public.drive_link_reset(uuid)'::regprocedure,
        'public.drive_link_create(uuid, timestamptz)'::regprocedure,
        'public.drive_file_card(uuid, text)'::regprocedure]
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
    END LOOP;

    FOREACH fn IN ARRAY ARRAY[
        'public.drive_owner_json(uuid)'::regprocedure,
        'public.drive_link_state(public.drive_files)'::regprocedure,
        'public.drive_link_public_file(text)'::regprocedure,
        'public.drive_link_target(text)'::regprocedure,
        'public.drive_file_json(public.drive_files)'::regprocedure]
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

REVOKE ALL ON FUNCTION public.drive_link_resolve(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.drive_link_resolve(text) TO anon, authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
