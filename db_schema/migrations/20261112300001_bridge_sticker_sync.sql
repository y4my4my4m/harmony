-- Discord bridge: import, update, restore and retire server stickers.
--
-- Adds stickers.discord_sticker_id (the Discord sticker a row was imported from) and
-- stickers.removed_at (NULL = active), and two RPCs for the bot of a server's Discord bridge,
-- called through bot-gateway (service_role). Neither column is granted to clients.
--
-- Retired stickers. The bridge never deletes a sticker; it retires it by setting removed_at.
-- A retired row
--   * is hidden from clients (stickers_select_visible), so it leaves the picker and settings;
--   * cannot be put in a new or changed message (check_message_sticker_parts raises
--     STICKER_UNKNOWN; a part unchanged from OLD on an edit stays accepted, as before, and
--     keeps the stored part's fields when the edit resends only some of them);
--   * does not count toward the cap (enforce_sticker_limit) and does not hold its name (the
--     name indexes are partial on removed_at IS NULL);
--   * does not fill the upload folder (sticker_folder_has_room allows one more object per
--     retired row);
--   * still answers existing_sticker_ids, so old messages keep rendering it;
--   * keeps its file; delete_sticker is unchanged and still removes it for good;
--   * cannot be updated by update_sticker (P0002).
-- The server audit log writes sticker.delete when removed_at is set and sticker.create when it
-- is cleared (a restore that renames at the same time writes sticker.create only, as emoji do).
--
-- bridge_import_server_sticker(p_bot_id, p_server_id, p_discord_sticker_id, p_name,
--                              p_description, p_update, p_path, p_url, p_width, p_height,
--                              p_duration_ms)
-- Outcomes (status):
--   existing  the Discord sticker is already imported into this server and nothing changed (or
--             p_update is false: a linked row is then never touched, retired or not); removed
--             tells whether the row is retired
--   updated   p_update: name and/or description differed (case-sensitive) and/or the row was
--             retired; the row now carries them and is active again
--   created   new server sticker from the file at p_path in bucket stickers (bot-gateway has
--             stored it); uploader stays NULL
-- A sticker is never linked by name. A NULL p_path on a Discord sticker with no row raises
-- 22023 'invalid sticker file': the caller downloads the image and calls again.
-- Errors: 42501 the bot does not bridge the server; 22023 invalid Discord id, name,
-- description or file (the checks of create_sticker); 23505 STICKER_NAME_TAKEN another active
-- sticker of the server holds the name (update, restore or create), or STICKER_FILE_TAKEN;
-- 23514 STICKER_LIMIT the server cap (0 is off), counting active stickers, on restore and
-- create, under the advisory lock the cap trigger takes.
--
-- bridge_retire_server_sticker(p_bot_id, p_server_id, p_sticker_id)
-- Sets removed_at and updated_at. Returns removed, or existing when it already was retired.
-- 42501 as above; P0002 when the sticker is not a server sticker of this server.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Columns and name indexes
-- ---------------------------------------------------------------------------
ALTER TABLE public.stickers
    ADD COLUMN IF NOT EXISTS discord_sticker_id text
        CONSTRAINT stickers_discord_sticker_id_check CHECK (discord_sticker_id ~ '^[0-9]{1,20}$'),
    ADD COLUMN IF NOT EXISTS removed_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS stickers_server_discord_sticker_key
    ON public.stickers (server_id, discord_sticker_id) WHERE discord_sticker_id IS NOT NULL;

DROP INDEX IF EXISTS public.stickers_server_name_key;
CREATE UNIQUE INDEX stickers_server_name_key
    ON public.stickers (server_id, lower(name)) WHERE scope = 'server' AND removed_at IS NULL;
DROP INDEX IF EXISTS public.stickers_instance_name_key;
CREATE UNIQUE INDEX stickers_instance_name_key
    ON public.stickers (lower(name)) WHERE scope = 'instance' AND removed_at IS NULL;
DROP INDEX IF EXISTS public.stickers_owner_name_key;
CREATE UNIQUE INDEX stickers_owner_name_key
    ON public.stickers (owner_id, lower(name)) WHERE scope = 'user' AND removed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS stickers_select_visible ON public.stickers;
CREATE POLICY stickers_select_visible ON public.stickers
    FOR SELECT TO anon, authenticated
    USING (removed_at IS NULL AND public.can_see_sticker(scope, server_id, owner_id));

-- ---------------------------------------------------------------------------
-- Cap and upload folder: retired stickers do not count
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
       AND s.owner_id IS NOT DISTINCT FROM NEW.owner_id
       AND s.removed_at IS NULL;

    IF v_held < v_limit THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'STICKER_LIMIT: at most % % stickers', v_limit, NEW.scope
        USING ERRCODE = '23514';
END;
$$;

-- The folder of object p_name (everything up to its last '/') holds fewer than the scope's
-- cap + 2 + its retired stickers' objects, and the cap is above 0. A retired sticker keeps its
-- file but not its place under the cap.
CREATE OR REPLACE FUNCTION public.sticker_folder_has_room(p_name text, p_scope text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_cap integer := public.sticker_limit(p_scope);
    v_folder text := substring(p_name from '^(.*/)');
    v_held bigint;
    v_retired bigint;
BEGIN
    IF v_cap <= 0 OR v_folder IS NULL THEN
        RETURN false;
    END IF;
    SELECT count(*) INTO v_held
      FROM storage.objects o
     WHERE o.bucket_id = 'stickers'
       AND starts_with(o.name, v_folder);
    SELECT count(*) INTO v_retired
      FROM public.stickers s
     WHERE s.removed_at IS NOT NULL
       AND starts_with(s.path, v_folder);
    RETURN v_held < v_cap + 2 + v_retired;
END;
$$;

-- ---------------------------------------------------------------------------
-- update_sticker refuses a retired sticker
-- ---------------------------------------------------------------------------
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
    IF NOT FOUND OR v_row.removed_at IS NOT NULL OR NOT public.can_manage_sticker(v_row) THEN
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

-- ---------------------------------------------------------------------------
-- Message parts: a new or changed part cannot name a retired sticker
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_message_sticker_parts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_count integer;
    v_bad boolean;
    v_part jsonb;
    v_at integer;
    v_row public.stickers;
BEGIN
    SELECT count(*),
           bool_or(NOT COALESCE(
               jsonb_typeof(e -> 'id') = 'string' AND char_length(e ->> 'id') BETWEEN 1 AND 200
               AND jsonb_typeof(e -> 'url') = 'string' AND char_length(e ->> 'url') <= 2048
               AND e ->> 'url' ~* '^https?://'
               AND jsonb_typeof(e -> 'name') = 'string' AND char_length(btrim(e ->> 'name')) BETWEEN 1 AND 30
               AND jsonb_typeof(e -> 'description') = 'string'
               AND char_length(btrim(e ->> 'description')) BETWEEN 1 AND 300
               AND (NOT e ? 'domain' OR jsonb_typeof(e -> 'domain') = 'string'), false))
      INTO v_count, v_bad
      FROM jsonb_array_elements(NEW.content) e
     WHERE e ->> 'type' = 'sticker';

    IF v_count > 1 THEN
        RAISE EXCEPTION 'STICKER_PARTS: a message holds at most one sticker' USING ERRCODE = '23514';
    END IF;
    IF v_bad THEN
        RAISE EXCEPTION 'STICKER_PART: a sticker part has id, url, name and description' USING ERRCODE = '22023';
    END IF;

    SELECT a.e, a.n::integer INTO v_part, v_at
      FROM jsonb_array_elements(NEW.content) WITH ORDINALITY a(e, n)
     WHERE a.e ->> 'type' = 'sticker';

    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.content) f
         WHERE f ->> 'type' = 'file'
           AND f ->> 'stickerId' = v_part ->> 'id'
           AND (f ->> 'url' IS DISTINCT FROM v_part ->> 'url' OR f ->> 'fileType' IS DISTINCT FROM 'image')) THEN
        RAISE EXCEPTION 'STICKER_FALLBACK: the file part of a sticker is an image at its url' USING ERRCODE = '22023';
    END IF;

    IF TG_OP = 'UPDATE' AND jsonb_typeof(OLD.content) = 'array' AND OLD.content @> jsonb_build_array(v_part) THEN
        -- Unchanged on an edit: keep the stored part, so an edit that resends only some of its
        -- fields (the Discord bridge sends id, url, name, description) keeps width, height, mimeType.
        NEW.content := jsonb_set(NEW.content, ARRAY[(v_at - 1)::text],
            (SELECT o FROM jsonb_array_elements(OLD.content) o WHERE o @> v_part LIMIT 1) || v_part);
        RETURN NEW;
    END IF;

    IF NULLIF(btrim(v_part ->> 'domain'), '') IS NOT NULL THEN
        IF COALESCE(current_setting('role', true), '') IN ('anon', 'authenticated') THEN
            RAISE EXCEPTION 'STICKER_DOMAIN: a sticker of another instance arrives by federation only'
                USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
    END IF;

    IF v_part ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT * INTO v_row FROM public.stickers s WHERE s.id = (v_part ->> 'id')::uuid;
    END IF;
    IF v_row.id IS NULL OR v_row.url IS DISTINCT FROM v_part ->> 'url' OR v_row.removed_at IS NOT NULL THEN
        RAISE EXCEPTION 'STICKER_UNKNOWN: a sticker part names a sticker of this instance by id and url'
            USING ERRCODE = '22023';
    END IF;

    NEW.content := jsonb_set(NEW.content, ARRAY[(v_at - 1)::text],
        v_part || jsonb_build_object('id', v_row.id::text, 'name', v_row.name, 'description', v_row.description,
                                     'width', v_row.width, 'height', v_row.height,
                                     'mimeType', v_row.mime_type));
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Server audit log: retire is a delete, restore is a create
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
    v_action text;
    v_has_old boolean := TG_OP <> 'INSERT';
    v_has_new boolean := TG_OP <> 'DELETE';
BEGIN
    IF pg_trigger_depth() > 1 OR v_row.scope <> 'server' THEN
        RETURN NULL;
    END IF;

    v_action := CASE
        WHEN TG_OP = 'INSERT' THEN 'sticker.create'
        WHEN TG_OP = 'DELETE' THEN 'sticker.delete'
        WHEN OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL THEN 'sticker.delete'
        WHEN OLD.removed_at IS NOT NULL AND NEW.removed_at IS NULL THEN 'sticker.create'
        WHEN OLD.name IS DISTINCT FROM NEW.name OR OLD.description IS DISTINCT FROM NEW.description
            THEN 'sticker.update'
    END;
    IF v_action IS NULL THEN
        RETURN NULL;
    END IF;

    -- A retirement reads as a delete and a restore as a create.
    IF TG_OP = 'UPDATE' AND v_action = 'sticker.delete' THEN
        v_has_new := false;
    ELSIF TG_OP = 'UPDATE' AND v_action = 'sticker.create' THEN
        v_has_old := false;
    END IF;

    PERFORM public.server_audit_write(
        v_row.server_id, v_action, 'sticker', v_row.id::text, v_row.name,
        public.server_audit_diff(
            CASE WHEN v_has_old THEN public.server_audit_pick(to_jsonb(OLD), v_keys) END,
            CASE WHEN v_has_new THEN public.server_audit_pick(to_jsonb(NEW), v_keys) END));
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_stickers_audit_update ON public.stickers;
CREATE TRIGGER z_stickers_audit_update
    AFTER UPDATE ON public.stickers
    FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name
                       OR OLD.description IS DISTINCT FROM NEW.description
                       OR OLD.removed_at IS DISTINCT FROM NEW.removed_at)
    EXECUTE FUNCTION public.server_audit_stickers();

-- ---------------------------------------------------------------------------
-- Bot attribution
-- ---------------------------------------------------------------------------
-- bot-gateway logs sticker_imported, sticker_updated and sticker_removed in bot_audit_log, and
-- emoji_updated and emoji_removed next to emoji_imported.
-- server_audit_stickers writes a creation as sticker.create, a rename or new description as
-- sticker.update, a restore as sticker.create (also when the name changes with it) and a
-- retirement as sticker.delete. server_audit_emojis writes a rename as emoji.update, a restore as
-- emoji.create (also when the name changes with it) and a soft removal as emoji.delete. Each is
-- attributed to the bot.
CREATE OR REPLACE FUNCTION public.server_audit_attribute_bot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_meta jsonb := COALESCE(NEW.metadata, '{}'::jsonb);
    v_actions text[];
    v_target text;
    v_server text;
BEGIN
    v_actions := CASE NEW.action_type
        WHEN 'channel_created' THEN ARRAY['channel.create']
        WHEN 'category_created' THEN ARRAY['category.create']
        WHEN 'role_created' THEN ARRAY['role.create']
        WHEN 'role_updated' THEN ARRAY['role.update']
        WHEN 'role_deleted' THEN ARRAY['role.delete']
        WHEN 'emoji_imported' THEN ARRAY['emoji.create']
        WHEN 'emoji_updated' THEN ARRAY['emoji.update', 'emoji.create']
        WHEN 'emoji_removed' THEN ARRAY['emoji.delete']
        WHEN 'sticker_imported' THEN ARRAY['sticker.create']
        WHEN 'sticker_updated' THEN ARRAY['sticker.update', 'sticker.create']
        WHEN 'sticker_removed' THEN ARRAY['sticker.delete']
    END;
    v_target := COALESCE(v_meta ->> 'channel_id', v_meta ->> 'category_id', v_meta ->> 'role_id',
                         v_meta ->> 'emojiId', v_meta ->> 'stickerId');
    v_server := COALESCE(NEW.server_id::text, v_meta ->> 'server_id', v_meta ->> 'serverId');
    IF v_actions IS NULL OR v_target IS NULL OR v_server IS NULL
       OR v_server !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN NULL;
    END IF;

    UPDATE public.server_audit_log l
       SET source = 'bot', actor_bot_id = NEW.bot_id
     WHERE l.server_id = v_server::uuid
       AND l.action = ANY (v_actions)
       AND l.target_id = v_target
       AND l.source = 'system'
       AND l.actor_id IS NULL
       AND l.created_at > clock_timestamp() - interval '5 minutes';
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_bot_audit_log_server_audit ON public.bot_audit_log;
CREATE TRIGGER z_bot_audit_log_server_audit
    AFTER INSERT ON public.bot_audit_log
    FOR EACH ROW
    WHEN (NEW.success IS NOT FALSE AND NEW.bot_id IS NOT NULL
          AND NEW.action_type IN ('channel_created', 'category_created', 'role_created',
                                  'role_updated', 'role_deleted', 'emoji_imported',
                                  'emoji_updated', 'emoji_removed', 'sticker_imported',
                                  'sticker_updated', 'sticker_removed'))
    EXECUTE FUNCTION public.server_audit_attribute_bot();

-- ---------------------------------------------------------------------------
-- Bridge RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bridge_import_server_sticker(
    p_bot_id uuid,
    p_server_id uuid,
    p_discord_sticker_id text,
    p_name text,
    p_description text,
    p_update boolean DEFAULT false,
    p_path text DEFAULT NULL,
    p_url text DEFAULT NULL,
    p_width integer DEFAULT NULL,
    p_height integer DEFAULT NULL,
    p_duration_ms integer DEFAULT NULL
)
RETURNS TABLE(status text, id uuid, name text, description text, url text, discord_sticker_id text, removed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
-- Output columns share names with stickers columns; references mean the table.
#variable_conflict use_column
DECLARE
    v_name text;
    v_description text;
    v_row public.stickers%ROWTYPE;
    v_prefix text := 'server/' || p_server_id::text || '/';
    v_limit integer;
    v_meta jsonb;
    v_size text;
    v_mime text;
    v_ext text;
    v_constraint text;
BEGIN
    PERFORM public.bridge_require_server_bot(p_bot_id, p_server_id);
    IF p_discord_sticker_id IS NULL OR p_discord_sticker_id !~ '^[0-9]{1,20}$' THEN
        RAISE EXCEPTION 'invalid Discord sticker id' USING ERRCODE = '22023';
    END IF;
    v_name := btrim(p_name);
    v_description := btrim(p_description);
    PERFORM public.sticker_check_text(v_name, v_description);

    SELECT * INTO v_row FROM public.stickers s
     WHERE s.server_id = p_server_id AND s.discord_sticker_id = p_discord_sticker_id AND s.scope = 'server'
       FOR UPDATE;
    IF FOUND THEN
        IF NOT p_update
           OR (v_row.removed_at IS NULL AND v_row.name = v_name AND v_row.description = v_description) THEN
            RETURN QUERY SELECT 'existing'::text, v_row.id, v_row.name, v_row.description, v_row.url,
                                v_row.discord_sticker_id, (v_row.removed_at IS NOT NULL);
            RETURN;
        END IF;

        PERFORM pg_advisory_xact_lock(hashtextextended('stickers:server:' || p_server_id::text, 0));
        IF EXISTS (
            SELECT 1 FROM public.stickers s2
             WHERE s2.scope = 'server' AND s2.server_id = p_server_id AND s2.id <> v_row.id
               AND s2.removed_at IS NULL AND lower(s2.name) = lower(v_name)
        ) THEN
            RAISE EXCEPTION 'STICKER_NAME_TAKEN: % is taken', v_name USING ERRCODE = '23505';
        END IF;
        IF v_row.removed_at IS NOT NULL THEN
            v_limit := public.sticker_limit('server');
            IF (SELECT count(*) FROM public.stickers s3
                 WHERE s3.scope = 'server' AND s3.server_id = p_server_id AND s3.removed_at IS NULL) >= v_limit THEN
                RAISE EXCEPTION 'STICKER_LIMIT: at most % server stickers', v_limit USING ERRCODE = '23514';
            END IF;
        END IF;

        UPDATE public.stickers s
           SET name = v_name, description = v_description, removed_at = NULL, updated_at = now()
         WHERE s.id = v_row.id
        RETURNING * INTO v_row;
        RETURN QUERY SELECT 'updated'::text, v_row.id, v_row.name, v_row.description, v_row.url,
                            v_row.discord_sticker_id, false;
        RETURN;
    END IF;

    IF p_path IS NULL THEN
        RAISE EXCEPTION 'invalid sticker file' USING ERRCODE = '22023';
    END IF;

    -- The file checks of create_sticker for scope server.
    IF p_path !~ ('^' || v_prefix
        || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|apng|webp|gif)$') THEN
        RAISE EXCEPTION 'STICKER_PATH: a sticker file is %<uuid>.<png|apng|webp|gif>', v_prefix
            USING ERRCODE = '22023';
    END IF;
    IF NOT public.is_storage_public_url(p_url, 'stickers', p_path) THEN
        RAISE EXCEPTION 'STICKER_URL: the url is not the public URL of %', p_path USING ERRCODE = '22023';
    END IF;
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

    INSERT INTO public.stickers (scope, server_id, uploader, name, description, path, url, mime_type,
                                 file_size, width, height, duration_ms, discord_sticker_id)
    VALUES ('server', p_server_id, NULL, v_name, v_description, p_path, p_url, v_mime, v_size::integer,
            p_width, p_height, p_duration_ms, p_discord_sticker_id)
    ON CONFLICT (server_id, discord_sticker_id) WHERE discord_sticker_id IS NOT NULL DO NOTHING
    RETURNING * INTO v_row;
    IF NOT FOUND THEN
        SELECT * INTO v_row FROM public.stickers s
         WHERE s.server_id = p_server_id AND s.discord_sticker_id = p_discord_sticker_id;
        RETURN QUERY SELECT 'existing'::text, v_row.id, v_row.name, v_row.description, v_row.url,
                            v_row.discord_sticker_id, (v_row.removed_at IS NOT NULL);
        RETURN;
    END IF;
    RETURN QUERY SELECT 'created'::text, v_row.id, v_row.name, v_row.description, v_row.url,
                        v_row.discord_sticker_id, false;
EXCEPTION
    WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        IF v_constraint = 'stickers_path_key' THEN
            RAISE EXCEPTION 'STICKER_FILE_TAKEN: % is another sticker''s file', p_path USING ERRCODE = '23505';
        END IF;
        RAISE EXCEPTION 'STICKER_NAME_TAKEN: % is taken', v_name USING ERRCODE = '23505';
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_retire_server_sticker(
    p_bot_id uuid,
    p_server_id uuid,
    p_sticker_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.stickers%ROWTYPE;
BEGIN
    PERFORM public.bridge_require_server_bot(p_bot_id, p_server_id);

    SELECT * INTO v_row FROM public.stickers s
     WHERE s.id = p_sticker_id AND s.server_id = p_server_id AND s.scope = 'server'
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'sticker not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_row.removed_at IS NOT NULL THEN
        RETURN 'existing';
    END IF;

    UPDATE public.stickers s
       SET removed_at = now(), updated_at = now()
     WHERE s.id = v_row.id;
    RETURN 'removed';
END;
$$;

REVOKE ALL ON FUNCTION public.bridge_import_server_sticker(uuid, uuid, text, text, text, boolean, text, text, integer, integer, integer)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_import_server_sticker(uuid, uuid, text, text, text, boolean, text, text, integer, integer, integer)
    TO service_role;
REVOKE ALL ON FUNCTION public.bridge_retire_server_sticker(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_retire_server_sticker(uuid, uuid, uuid) TO service_role;

-- bot-gateway reads the cap for the sync list.
GRANT EXECUTE ON FUNCTION public.sticker_limit(text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
