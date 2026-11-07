-- Emoji lifecycle: removal, purge, re-hosted imports, and emoji parts clients may write.
--
-- Removal. remove_emoji(id) sets emojis.deleted_at and deleted_by: server emoji by the owner or a
-- member holding MANAGE_EMOJIS on the local server, personal emoji by their owner, any emoji by an
-- instance admin. The row, its file, its reactions and every message part naming it stay, so old
-- content renders. A removed row leaves the picker and :name: resolution (clients filter
-- deleted_at), name uniqueness, the personal cap and the per-server cap. RLS still returns it:
-- get_message_page and get_batch_message_reactions join emojis for reaction names and urls.
-- restore_emoji(id) clears the removal under the same authority, refused (23505) while another
-- active emoji holds the name.
--
-- Purge. admin_purge_emoji(id), instance admins only, deletes the row and returns the object path
-- of its file in bucket emojis (NULL for a file elsewhere or one another row shares); the caller
-- removes the object. reactions.emoji_id is ON DELETE SET NULL: prepare_emoji_deletion leaves
-- custom_emoji_content ':<name>:' and metadata.emoji_removed on each reaction and post reaction,
-- and metadata.remote_emoji_url (the purged url) on post reactions.
--
-- Writes. Clients write emojis rows through RPCs only: create_server_emoji, create_my_emoji,
-- create_instance_emoji, rename_emoji, rename_my_emoji, admin_rename_instance_emoji,
-- remove_emoji, restore_emoji, admin_purge_emoji. Every create pins the url to the public URL of
-- the uploaded object (is_storage_public_url). The client INSERT, UPDATE and DELETE policies on
-- emojis are dropped. A client delete of an emojis-bucket object that a row references is refused
-- for anyone but an instance admin (trigger on storage.objects).
-- max_custom_emojis_per_server (default 50, 0 is no limit) caps active server emoji.
--
-- Imports. import_remote_emoji takes the object the federation backend downloaded into
-- 00000000-0000-0000-0000-000000000000/<uuid>.<ext>; the remote URL goes to
-- emojis.imported_from. rehost_emoji moves an instance emoji that still points off-instance
-- onto such an object. Both are service_role only; the backend checks the admin. Bots create
-- federated emoji with a domain only (create_federated_emoji).
--
-- Parts. check_content_emoji_parts, BEFORE INSERT OR UPDATE OF content on messages and posts for
-- roles anon and authenticated, unencrypted rows. A part already in OLD passes unchanged. A
-- malformed part raises EMOJI_PART (22023): emoji not an object; name not a string of 1-64
-- characters without whitespace, control characters, : < > " ' ` or \; id, url, server_id or
-- domain neither string nor null; id over 200 characters; url not http(s) or over 2048. A part
-- naming by uuid a row the author may use (emoji_usable) is rewritten to that row's id, name,
-- url, server_id and domain. A Discord part (a cdn.discordapp.com or media.discordapp.net
-- /emojis/<snowflake>.png|gif|webp url, with domain discord.com and a 2-32 [A-Za-z0-9_] name, or
-- the id discord:[a:]<name>:<the same snowflake>) keeps its url and becomes domain discord.com. Anything else becomes the text :<name>:. Boosts carry the original's content and
-- are not checked. The trigger names sort before a_messages_content_permissions, which then sees
-- the rewritten parts.
--
-- Listing. admin_list_emojis(search, kind, status, sort, limit, offset) pages every emojis row
-- and, as kind not_imported, remote_emojis_cache rows not imported. admin_list_instance_emojis
-- and admin_delete_instance_emoji are dropped.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.emojis
    ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
    ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS imported_from text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.emojis'::regclass AND conname = 'emojis_imported_from_check') THEN
        ALTER TABLE public.emojis ADD CONSTRAINT emojis_imported_from_check
            CHECK (imported_from IS NULL OR (char_length(imported_from) <= 2048 AND imported_from ~* '^https?://'));
    END IF;
END;
$$;

COMMENT ON COLUMN public.emojis.deleted_at IS
'Set by remove_emoji. A removed emoji keeps its row, file and reactions and is offered nowhere.';
COMMENT ON COLUMN public.emojis.imported_from IS
'Remote image URL an imported or re-hosted instance emoji was copied from.';

CREATE INDEX IF NOT EXISTS idx_emojis_server_active ON public.emojis (server_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_remote_emojis_cache_imported_as ON public.remote_emojis_cache (imported_as)
    WHERE imported_as IS NOT NULL;

-- ---------------------------------------------------------------------------
-- instance_config
-- ---------------------------------------------------------------------------
INSERT INTO public.instance_config (config_key, config_value, description)
VALUES ('max_custom_emojis_per_server', '50'::jsonb,
        'Custom emojis one server can hold (0-1000). 0 is no limit.')
ON CONFLICT (config_key) DO NOTHING;

-- 0 is no limit; absent or unreadable reads 50.
CREATE OR REPLACE FUNCTION public.server_emoji_limit()
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN (SELECT ic.config_value #>> '{}' FROM public.instance_config ic
               WHERE ic.config_key = 'max_custom_emojis_per_server') ~ '^\s*0+\s*$' THEN 0
        ELSE public.get_instance_config_int('max_custom_emojis_per_server', 50, 1000)
    END
$$;

-- ---------------------------------------------------------------------------
-- Authority and usability
-- ---------------------------------------------------------------------------

-- The signed-in caller may rename, remove and restore the emoji.
CREATE OR REPLACE FUNCTION public.can_manage_emoji(p_emoji public.emojis)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL THEN
        RETURN false;
    END IF;
    IF public.is_current_user_admin() THEN
        RETURN true;
    END IF;
    IF p_emoji.scope = 'user' THEN
        RETURN p_emoji.uploader = v_me;
    END IF;
    IF p_emoji.server_id IS NOT NULL THEN
        RETURN EXISTS (
            SELECT 1 FROM public.servers s
             WHERE s.id = p_emoji.server_id
               AND s.is_local_server
               AND (s.owner = v_me OR public.has_permission(v_me, s.id, 'MANAGE_EMOJIS', NULL)));
    END IF;
    RETURN false;
END;
$$;

-- p_profile may put the emoji in content: an active row with a url that is the profile's own
-- personal emoji, an instance emoji of this instance, or an emoji of a server (local or a copy)
-- the profile is an accepted member of. Outside that server (p_server another server, or NULL
-- for direct messages and posts) the server's allow_cross_server_emojis must not be false.
-- Federated emoji cached from other instances (domain set, no server) are not usable.
CREATE OR REPLACE FUNCTION public.emoji_usable(p_emoji public.emojis, p_profile uuid, p_server uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_emoji.id IS NULL OR p_profile IS NULL OR p_emoji.deleted_at IS NOT NULL
       OR NULLIF(btrim(p_emoji.url), '') IS NULL THEN
        RETURN false;
    END IF;
    IF p_emoji.scope = 'user' THEN
        RETURN p_emoji.uploader = p_profile;
    END IF;
    IF p_emoji.server_id IS NULL THEN
        RETURN NULLIF(btrim(p_emoji.domain), '') IS NULL;
    END IF;
    RETURN EXISTS (
        SELECT 1
          FROM public.user_servers us
          JOIN public.servers s ON s.id = us.server_id
         WHERE us.server_id = p_emoji.server_id
           AND us.user_id = p_profile
           AND us.status = 'accepted'
           AND (s.id = p_server OR s.allow_cross_server_emojis IS NOT FALSE));
END;
$$;

-- Another active emoji in the same namespace holds p_name (case-insensitive): the same server,
-- the same owner's personal emoji, or this instance's own instance-level emoji. Federated
-- emoji (domain set, no server) share no namespace.
CREATE OR REPLACE FUNCTION public.emoji_name_taken(p_emoji public.emojis, p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.emojis e
         WHERE e.id IS DISTINCT FROM p_emoji.id
           AND e.deleted_at IS NULL
           AND lower(e.name::text) = lower(p_name)
           AND CASE
                   WHEN p_emoji.server_id IS NOT NULL THEN e.server_id = p_emoji.server_id
                   WHEN p_emoji.scope = 'user' THEN e.scope = 'user' AND e.uploader = p_emoji.uploader
                   WHEN NULLIF(btrim(p_emoji.domain), '') IS NULL THEN
                       e.server_id IS NULL AND e.scope <> 'user' AND NULLIF(btrim(e.domain), '') IS NULL
                   ELSE false
               END)
$$;

-- Object path of the emoji's file in bucket emojis: the url is the public URL of an object of
-- this instance's bucket. NULL otherwise; with storage_origin empty an origin is checked for
-- shape only, so another instance's storage URL needs the object test. plpgsql: storage.objects
-- may be absent at creation.
CREATE OR REPLACE FUNCTION public.emoji_object_path(p_url text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_path text := substring(p_url FROM '/storage/v1/object/public/emojis/([^?#]+)$');
BEGIN
    IF v_path IS NULL OR NOT public.is_storage_public_url(p_url, 'emojis', v_path) THEN
        RETURN NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'emojis' AND o.name = v_path) THEN
        RETURN NULL;
    END IF;
    RETURN v_path;
END;
$$;

-- ---------------------------------------------------------------------------
-- Client policies
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS emojis_delete_instance_admin ON public.emojis;
DROP POLICY IF EXISTS emojis_delete_server_manager ON public.emojis;
DROP POLICY IF EXISTS emojis_delete_user_scope ON public.emojis;
DROP POLICY IF EXISTS emojis_insert_instance_admin ON public.emojis;
DROP POLICY IF EXISTS emojis_insert_server_manager ON public.emojis;
DROP POLICY IF EXISTS emojis_update_instance_admin ON public.emojis;
DROP POLICY IF EXISTS emojis_update_server_manager ON public.emojis;

-- ---------------------------------------------------------------------------
-- Reactions survive a purge
-- ---------------------------------------------------------------------------
ALTER TABLE public.reactions DROP CONSTRAINT IF EXISTS reactions_emoji_id_fkey;
ALTER TABLE public.reactions
    ADD CONSTRAINT reactions_emoji_id_fkey FOREIGN KEY (emoji_id) REFERENCES public.emojis(id) ON DELETE SET NULL;

-- A reaction that would collide with one already holding ':<name>:' for the same reactor is
-- dropped: reactions_message_user_emoji_unique and idx_post_interactions_emoji_unique key on
-- (emoji_id, custom_emoji_content), and the FK action nulls emoji_id after this runs.
CREATE OR REPLACE FUNCTION public.prepare_emoji_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_content text := CASE WHEN OLD.url IS NOT NULL THEN ':' || OLD.name || ':' ELSE OLD.name END;
    v_mark jsonb := jsonb_build_object('emoji_removed', true, 'remote_emoji_name', OLD.name);
BEGIN
    IF v_content IS NULL THEN
        v_content := ':emoji:';
    END IF;

    DELETE FROM public.reactions r
     WHERE r.emoji_id = OLD.id
       AND EXISTS (SELECT 1 FROM public.reactions d
                    WHERE d.message_id = r.message_id
                      AND d.user_id IS NOT DISTINCT FROM r.user_id
                      AND d.bot_id IS NOT DISTINCT FROM r.bot_id
                      AND d.emoji_id IS NULL
                      AND d.custom_emoji_content = v_content);
    UPDATE public.reactions r
       SET custom_emoji_content = v_content,
           metadata = COALESCE(CASE WHEN jsonb_typeof(r.metadata) = 'object' THEN r.metadata END, '{}'::jsonb) || v_mark
     WHERE r.emoji_id = OLD.id;

    DELETE FROM public.post_interactions pi
     WHERE pi.emoji_id = OLD.id
       AND pi.interaction_type = 'emoji_reaction'
       AND EXISTS (SELECT 1 FROM public.post_interactions d
                    WHERE d.user_id = pi.user_id
                      AND d.post_id = pi.post_id
                      AND d.interaction_type = 'emoji_reaction'
                      AND d.emoji_id IS NULL
                      AND d.custom_emoji_content = COALESCE(pi.custom_emoji_content, v_content));
    -- Post reaction chips draw metadata.remote_emoji_url; the purged file fails to load and the
    -- chip shows its broken-image icon.
    UPDATE public.post_interactions pi
       SET custom_emoji_content = COALESCE(pi.custom_emoji_content, v_content),
           metadata = COALESCE(CASE WHEN jsonb_typeof(pi.metadata) = 'object' THEN pi.metadata END, '{}'::jsonb)
                      || v_mark
                      || CASE WHEN OLD.url IS NOT NULL THEN jsonb_build_object('remote_emoji_url', OLD.url) ELSE '{}'::jsonb END
     WHERE pi.emoji_id = OLD.id;

    RETURN OLD;
END;
$$;

-- ---------------------------------------------------------------------------
-- Server audit: removal and restore are emoji.delete and emoji.create
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.server_audit_emojis()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.emojis := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    v_action text;
    v_changes jsonb;
BEGIN
    IF pg_trigger_depth() > 1 OR v_row.scope IS DISTINCT FROM 'server' OR v_row.server_id IS NULL THEN
        RETURN NULL;
    END IF;

    v_action := CASE
        WHEN TG_OP = 'INSERT' THEN 'emoji.create'
        WHEN TG_OP = 'DELETE' THEN 'emoji.delete'
        WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN 'emoji.delete'
        WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN 'emoji.create'
        ELSE 'emoji.update'
    END;
    IF TG_OP = 'DELETE' AND OLD.deleted_at IS NOT NULL THEN
        RETURN NULL;
    END IF;

    v_changes := public.server_audit_diff(
        CASE WHEN v_action <> 'emoji.create' THEN public.server_audit_pick(to_jsonb(OLD), ARRAY['name']) END,
        CASE WHEN v_action <> 'emoji.delete' THEN public.server_audit_pick(to_jsonb(NEW), ARRAY['name']) END);

    PERFORM public.server_audit_write(
        v_row.server_id, v_action, 'emoji', v_row.id::text, v_row.name,
        v_changes,
        jsonb_build_object('url', v_row.url));
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_emojis_audit_update ON public.emojis;
CREATE TRIGGER z_emojis_audit_update
    AFTER UPDATE ON public.emojis
    FOR EACH ROW
    WHEN (OLD.name::text IS DISTINCT FROM NEW.name::text OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
    EXECUTE FUNCTION public.server_audit_emojis();

-- ---------------------------------------------------------------------------
-- Removal, restore, rename, purge
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.remove_emoji(p_emoji_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_row public.emojis;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_row FROM public.emojis e WHERE e.id = p_emoji_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Emoji not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.can_manage_emoji(v_row) THEN
        RAISE EXCEPTION 'Not allowed to remove this emoji' USING ERRCODE = '42501';
    END IF;
    IF v_row.deleted_at IS NOT NULL THEN
        RETURN;
    END IF;

    UPDATE public.emojis
       SET deleted_at = now(), deleted_by = v_me, updated_at = now()
     WHERE id = p_emoji_id;
    DELETE FROM public.emoji_favorites f WHERE f.emoji_id = p_emoji_id::text;

    IF v_row.server_id IS NULL AND public.is_current_user_admin() THEN
        PERFORM public.log_admin_action(v_me, 'emoji_remove', 'emoji', v_row.id::text,
                                        jsonb_build_object('name', v_row.name, 'url', v_row.url,
                                                           'scope', v_row.scope, 'domain', v_row.domain));
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_emoji(p_emoji_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_row public.emojis;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_row FROM public.emojis e WHERE e.id = p_emoji_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Emoji not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.can_manage_emoji(v_row) THEN
        RAISE EXCEPTION 'Not allowed to restore this emoji' USING ERRCODE = '42501';
    END IF;
    IF v_row.deleted_at IS NULL THEN
        RETURN;
    END IF;
    IF public.emoji_name_taken(v_row, v_row.name) THEN
        RAISE EXCEPTION 'An emoji named % exists', v_row.name USING ERRCODE = '23505';
    END IF;
    IF v_row.server_id IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('server_emojis:' || v_row.server_id::text, 0));
        IF public.server_emoji_limit() > 0
           AND (SELECT count(*) FROM public.emojis e
                 WHERE e.server_id = v_row.server_id AND e.deleted_at IS NULL) >= public.server_emoji_limit() THEN
            RAISE EXCEPTION 'SERVER_EMOJI_LIMIT: at most % emojis per server', public.server_emoji_limit()
                USING ERRCODE = '23514';
        END IF;
    ELSIF v_row.scope = 'user' AND v_row.uploader IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('user_emojis:' || v_row.uploader::text, 0));
        IF (SELECT count(*) FROM public.emojis e
             WHERE e.scope = 'user' AND e.uploader = v_row.uploader AND e.deleted_at IS NULL)
           >= public.personal_emoji_limit() THEN
            RAISE EXCEPTION 'PERSONAL_EMOJI_LIMIT: at most % personal emojis per user', public.personal_emoji_limit()
                USING ERRCODE = '23514';
        END IF;
    END IF;

    UPDATE public.emojis
       SET deleted_at = NULL, deleted_by = NULL, updated_at = now()
     WHERE id = p_emoji_id;

    IF v_row.server_id IS NULL AND public.is_current_user_admin() THEN
        PERFORM public.log_admin_action(v_me, 'emoji_restore', 'emoji', v_row.id::text,
                                        jsonb_build_object('name', v_row.name, 'scope', v_row.scope));
    END IF;
END;
$$;

-- 22023 invalid name, 23505 name taken, P0002 absent, 42501 not allowed.
CREATE OR REPLACE FUNCTION public.rename_emoji(p_emoji_id uuid, p_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_name text := btrim(p_name);
    v_row public.emojis;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
    END IF;
    IF v_name IS NULL OR v_name !~ '^[A-Za-z0-9_-]{2,64}$' THEN
        RAISE EXCEPTION 'Emoji names are 2 to 64 letters, digits, _ or -' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_row FROM public.emojis e WHERE e.id = p_emoji_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Emoji not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.can_manage_emoji(v_row) THEN
        RAISE EXCEPTION 'Not allowed to rename this emoji' USING ERRCODE = '42501';
    END IF;
    IF v_row.name::text = v_name THEN
        RETURN;
    END IF;
    IF v_row.server_id IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('server_emojis:' || v_row.server_id::text, 0));
    ELSIF v_row.scope = 'user' AND v_row.uploader IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('user_emojis:' || v_row.uploader::text, 0));
    ELSE
        PERFORM pg_advisory_xact_lock(hashtextextended('instance_emojis', 0));
    END IF;
    IF v_row.deleted_at IS NULL AND public.emoji_name_taken(v_row, v_name) THEN
        RAISE EXCEPTION 'An emoji named % exists', v_name USING ERRCODE = '23505';
    END IF;

    UPDATE public.emojis SET name = v_name, updated_at = now() WHERE id = p_emoji_id;

    IF v_row.server_id IS NULL AND public.is_current_user_admin() THEN
        PERFORM public.log_admin_action(v_me, 'emoji_rename', 'emoji', v_row.id::text,
                                        jsonb_build_object('from', v_row.name, 'to', v_name, 'scope', v_row.scope));
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_purge_emoji(p_emoji_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_row public.emojis;
    v_path text;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND (v_me IS NULL OR NOT public.is_current_user_admin()) THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_row FROM public.emojis e WHERE e.id = p_emoji_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Emoji not found' USING ERRCODE = 'P0002';
    END IF;

    v_path := public.emoji_object_path(v_row.url);
    IF v_path IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.emojis e
         WHERE e.id <> v_row.id
           AND right(e.url::text, char_length('/storage/v1/object/public/emojis/' || v_path))
               = '/storage/v1/object/public/emojis/' || v_path) THEN
        v_path := NULL;
    END IF;

    DELETE FROM public.emojis e WHERE e.id = p_emoji_id;
    DELETE FROM public.emoji_favorites f WHERE f.emoji_id = p_emoji_id::text;

    IF v_me IS NOT NULL THEN
        PERFORM public.log_admin_action(v_me, 'emoji_purge', 'emoji', v_row.id::text,
                                        jsonb_build_object('name', v_row.name, 'url', v_row.url,
                                                           'scope', v_row.scope, 'server_id', v_row.server_id));
    END IF;
    RETURN v_path;
END;
$$;

DROP FUNCTION IF EXISTS public.admin_delete_instance_emoji(uuid);

-- ---------------------------------------------------------------------------
-- Creation
-- ---------------------------------------------------------------------------

-- Server upload: the object is <server>/<caller>/<uuid>.<ext> in bucket emojis and p_url its
-- public URL. 42501 not a manager, 22023 a bad path or url or a missing object, 23505 a file
-- already recorded, 23514 SERVER_EMOJI_LIMIT. The name is p_name reduced to [A-Za-z0-9_-]
-- (at most 32, 'emoji' below 2) with _<n> appended while an active server emoji holds it.
CREATE OR REPLACE FUNCTION public.create_server_emoji(p_server_id uuid, p_name text, p_path text, p_url text)
RETURNS public.emojis
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_suffix text;
    v_size text;
    v_base text;
    v_name text;
    v_n integer := 0;
    v_cap integer;
    v_row public.emojis;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.servers s
         WHERE s.id = p_server_id
           AND s.is_local_server
           AND (s.owner = v_me OR public.has_permission(v_me, s.id, 'MANAGE_EMOJIS', NULL))) THEN
        RAISE EXCEPTION 'MANAGE_EMOJIS on a server of this instance is required' USING ERRCODE = '42501';
    END IF;

    IF p_path IS NULL OR p_path !~ ('^' || p_server_id::text || '/' || v_me::text
        || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|apng|gif|webp|jpg|jpeg)$') THEN
        RAISE EXCEPTION 'EMOJI_PATH: a server emoji file is <server id>/<your profile id>/<uuid>.<png|apng|gif|webp|jpg|jpeg>'
            USING ERRCODE = '22023';
    END IF;
    IF NOT public.is_storage_public_url(p_url, 'emojis', p_path) THEN
        RAISE EXCEPTION 'EMOJI_URL: the url is not the public URL of %', p_path USING ERRCODE = '22023';
    END IF;
    v_suffix := '/storage/v1/object/public/emojis/' || p_path;

    SELECT o.metadata ->> 'size' INTO v_size
      FROM storage.objects o
     WHERE o.bucket_id = 'emojis'
       AND o.name = p_path;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'EMOJI_FILE_MISSING: % is not in the emojis bucket', p_path USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('server_emojis:' || p_server_id::text, 0));

    v_cap := public.server_emoji_limit();
    IF v_cap > 0 AND (SELECT count(*) FROM public.emojis e
                       WHERE e.server_id = p_server_id AND e.deleted_at IS NULL) >= v_cap THEN
        RAISE EXCEPTION 'SERVER_EMOJI_LIMIT: at most % emojis per server', v_cap USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.emojis e
         WHERE e.server_id = p_server_id
           AND right(e.url::text, char_length(v_suffix)) = v_suffix) THEN
        RAISE EXCEPTION 'That file is an emoji of this server' USING ERRCODE = '23505';
    END IF;

    v_base := left(regexp_replace(COALESCE(p_name, ''), '[^A-Za-z0-9_-]', '', 'g'), 32);
    IF char_length(v_base) < 2 THEN
        v_base := 'emoji';
    END IF;
    v_name := v_base;
    WHILE EXISTS (
        SELECT 1 FROM public.emojis e
         WHERE e.server_id = p_server_id
           AND e.deleted_at IS NULL
           AND lower(e.name::text) = lower(v_name)) LOOP
        v_n := v_n + 1;
        v_name := v_base || '_' || v_n;
    END LOOP;

    INSERT INTO public.emojis (name, url, server_id, uploader, domain, scope, is_ai_generated, file_size)
    VALUES (v_name, p_url, p_server_id, v_me, NULL, 'server', false,
            CASE WHEN v_size ~ '^[0-9]{1,9}$' THEN v_size::integer END)
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_my_emoji(p_name text, p_path text, p_url text)
RETURNS public.emojis
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_suffix text;
    v_size text;
    v_base text;
    v_name text;
    v_n integer := 0;
    v_row public.emojis;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
    END IF;

    IF p_path IS NULL OR p_path !~ ('^' || v_me::text
        || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|apng|gif|webp|jpg|jpeg)$') THEN
        RAISE EXCEPTION 'EMOJI_PATH: an emoji file is <your profile id>/<uuid>.<png|apng|gif|webp|jpg|jpeg>'
            USING ERRCODE = '22023';
    END IF;

    IF NOT public.is_storage_public_url(p_url, 'emojis', p_path) THEN
        RAISE EXCEPTION 'EMOJI_URL: the url is not the public URL of %', p_path USING ERRCODE = '22023';
    END IF;
    v_suffix := '/storage/v1/object/public/emojis/' || p_path;

    SELECT o.metadata ->> 'size' INTO v_size
      FROM storage.objects o
     WHERE o.bucket_id = 'emojis'
       AND o.name = p_path;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'EMOJI_FILE_MISSING: % is not in the emojis bucket', p_path USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('user_emojis:' || v_me::text, 0));

    IF EXISTS (
        SELECT 1 FROM public.emojis e
         WHERE e.scope = 'user'
           AND e.uploader = v_me
           AND right(e.url::text, char_length(v_suffix)) = v_suffix) THEN
        RAISE EXCEPTION 'That file is one of your emojis' USING ERRCODE = '23505';
    END IF;

    v_base := left(regexp_replace(COALESCE(p_name, ''), '[^A-Za-z0-9_-]', '', 'g'), 32);
    IF char_length(v_base) < 2 THEN
        v_base := 'emoji';
    END IF;
    v_name := v_base;
    WHILE EXISTS (
        SELECT 1 FROM public.emojis e
         WHERE e.scope = 'user'
           AND e.uploader = v_me
           AND e.deleted_at IS NULL
           AND lower(e.name::text) = lower(v_name)) LOOP
        v_n := v_n + 1;
        v_name := v_base || '_' || v_n;
    END LOOP;

    INSERT INTO public.emojis (name, url, server_id, uploader, domain, scope, is_ai_generated, file_size)
    VALUES (v_name, p_url, NULL, v_me, NULL, 'user', false,
            CASE WHEN v_size ~ '^[0-9]{1,9}$' THEN v_size::integer END)
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_instance_emoji(p_name text, p_path text, p_url text)
RETURNS public.emojis
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_suffix text;
    v_size text;
    v_base text;
    v_name text;
    v_n integer := 0;
    v_row public.emojis;
BEGIN
    IF v_me IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;

    IF p_path IS NULL OR p_path !~ ('^00000000-0000-0000-0000-000000000000'
        || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|apng|gif|webp|jpg|jpeg)$') THEN
        RAISE EXCEPTION 'EMOJI_PATH: an instance emoji file is 00000000-0000-0000-0000-000000000000/<uuid>.<png|apng|gif|webp|jpg|jpeg>'
            USING ERRCODE = '22023';
    END IF;

    IF NOT public.is_storage_public_url(p_url, 'emojis', p_path) THEN
        RAISE EXCEPTION 'EMOJI_URL: the url is not the public URL of %', p_path USING ERRCODE = '22023';
    END IF;
    v_suffix := '/storage/v1/object/public/emojis/' || p_path;

    SELECT o.metadata ->> 'size' INTO v_size
      FROM storage.objects o
     WHERE o.bucket_id = 'emojis'
       AND o.name = p_path;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'EMOJI_FILE_MISSING: % is not in the emojis bucket', p_path USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('instance_emojis', 0));

    IF EXISTS (
        SELECT 1 FROM public.emojis e
         WHERE e.scope = 'instance'
           AND right(e.url::text, char_length(v_suffix)) = v_suffix) THEN
        RAISE EXCEPTION 'That file is an instance emoji' USING ERRCODE = '23505';
    END IF;

    v_base := left(regexp_replace(COALESCE(p_name, ''), '[^A-Za-z0-9_-]', '', 'g'), 32);
    IF char_length(v_base) < 2 THEN
        v_base := 'emoji';
    END IF;
    v_name := v_base;
    WHILE EXISTS (
        SELECT 1 FROM public.emojis e
         WHERE (e.scope = 'instance' OR (e.server_id IS NULL AND e.scope <> 'user'))
           AND e.domain IS NULL
           AND e.deleted_at IS NULL
           AND lower(e.name::text) = lower(v_name)) LOOP
        v_n := v_n + 1;
        v_name := v_base || '_' || v_n;
    END LOOP;

    INSERT INTO public.emojis (name, url, server_id, uploader, domain, scope, is_ai_generated, file_size)
    VALUES (v_name, p_url, NULL, v_me, NULL, 'instance', false,
            CASE WHEN v_size ~ '^[0-9]{1,9}$' THEN v_size::integer END)
    RETURNING * INTO v_row;

    PERFORM public.log_admin_action(v_me, 'instance_emoji_create', 'emoji', v_row.id::text,
                                    jsonb_build_object('name', v_row.name, 'url', v_row.url));
    RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_personal_emoji_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_limit integer;
    v_held integer;
BEGIN
    IF NEW.uploader IS NULL THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('user_emojis:' || NEW.uploader::text, 0));

    v_limit := public.personal_emoji_limit();
    SELECT count(*) INTO v_held
      FROM public.emojis e
     WHERE e.scope = 'user'
       AND e.uploader = NEW.uploader
       AND e.deleted_at IS NULL;

    IF v_held < v_limit THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'PERSONAL_EMOJI_LIMIT: at most % personal emojis per user', v_limit
        USING ERRCODE = '23514';
END;
$$;

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
        AND e.deleted_at IS NULL
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
           AND e.deleted_at IS NULL
           AND lower(e.name::text) = lower(v_name)) THEN
        RAISE EXCEPTION 'You have an emoji named %', v_name USING ERRCODE = '23505';
    END IF;

    UPDATE public.emojis SET name = v_name, updated_at = now() WHERE id = p_emoji_id;
END;
$$;

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
               AND e.deleted_at IS NULL
               AND lower(e.name::text) = lower(v_name)) THEN
            RAISE EXCEPTION 'The owner has an emoji named %', v_name USING ERRCODE = '23505';
        END IF;
    ELSIF EXISTS (
        SELECT 1 FROM public.emojis e
         WHERE e.id <> p_emoji_id
           AND (e.scope = 'instance' OR (e.server_id IS NULL AND e.scope <> 'user'))
           AND e.deleted_at IS NULL
           AND lower(e.name::text) = lower(v_name)
           AND e.domain IS NOT DISTINCT FROM v_domain) THEN
        RAISE EXCEPTION 'An instance emoji named % exists', v_name USING ERRCODE = '23505';
    END IF;

    UPDATE public.emojis SET name = v_name, updated_at = now() WHERE id = p_emoji_id;
END;
$$;

-- Bots and other service-role writers record federated emoji only: a domain is required.
CREATE OR REPLACE FUNCTION public.create_federated_emoji(p_name text, p_url text, p_created_by uuid, p_domain text DEFAULT NULL::text)
RETURNS TABLE(id uuid, created_at timestamp with time zone, name text, url text, server_id uuid, uploader uuid, domain text, scope text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NULLIF(btrim(p_domain), '') IS NULL THEN
        RAISE EXCEPTION 'EMOJI_DOMAIN: a federated emoji names the instance it comes from' USING ERRCODE = '22023';
    END IF;
    IF p_url IS NULL OR char_length(p_url) > 2048 OR p_url !~* '^https?://' THEN
        RAISE EXCEPTION 'EMOJI_URL: an http(s) url of at most 2048 characters' USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    INSERT INTO emojis (name, url, uploader, domain, scope, server_id)
    VALUES (
        p_name,
        p_url,
        -- Qualified. RETURNS TABLE declares an OUT parameter named id, which otherwise
        -- shadows the table column: 42702, on every call.
        COALESCE(
            (SELECT owner_id FROM bots WHERE bots.id = p_created_by),
            CASE
                WHEN EXISTS (SELECT 1 FROM profiles WHERE profiles.id = p_created_by) THEN p_created_by
                ELSE NULL
            END
        ),
        lower(btrim(p_domain)),
        'instance',
        NULL
    )
    RETURNING emojis.id, emojis.created_at, emojis.name::text, emojis.url::text, emojis.server_id,
              emojis.uploader, emojis.domain, emojis.scope;
END;
$$;

-- ---------------------------------------------------------------------------
-- Imports and re-hosting (service_role; the federation backend checks the admin)
-- ---------------------------------------------------------------------------

-- p_path is 00000000-0000-0000-0000-000000000000/<uuid>.<ext>, p_url its public URL.
CREATE OR REPLACE FUNCTION public.instance_emoji_object_ok(p_path text, p_url text)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_size text;
BEGIN
    IF p_path IS NULL OR p_path !~ ('^00000000-0000-0000-0000-000000000000'
        || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|apng|gif|webp|jpg|jpeg)$') THEN
        RAISE EXCEPTION 'EMOJI_PATH: an instance emoji file is 00000000-0000-0000-0000-000000000000/<uuid>.<png|apng|gif|webp|jpg|jpeg>'
            USING ERRCODE = '22023';
    END IF;
    IF NOT public.is_storage_public_url(p_url, 'emojis', p_path) THEN
        RAISE EXCEPTION 'EMOJI_URL: the url is not the public URL of %', p_path USING ERRCODE = '22023';
    END IF;
    SELECT o.metadata ->> 'size' INTO v_size
      FROM storage.objects o
     WHERE o.bucket_id = 'emojis'
       AND o.name = p_path;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'EMOJI_FILE_MISSING: % is not in the emojis bucket', p_path USING ERRCODE = '22023';
    END IF;
    RETURN CASE WHEN v_size ~ '^[0-9]{1,9}$' THEN v_size::integer END;
END;
$$;

DROP FUNCTION IF EXISTS public.import_remote_emoji(uuid, text, uuid);

-- 42501 for client roles, P0002 no cache row, 23505 already imported or p_name taken, 22023 a
-- bad p_name, path, url or missing object. Without p_name the name is the shortcode before any
-- @host, reduced to [A-Za-z0-9_-] (at most 32, 'emoji' below 2), with _<n> appended while an
-- active instance emoji holds it.
CREATE OR REPLACE FUNCTION public.import_remote_emoji(p_remote_emoji_id uuid, p_name text, p_path text, p_url text, p_actor uuid)
RETURNS public.emojis
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_remote public.remote_emojis_cache%ROWTYPE;
    v_name text := NULLIF(btrim(p_name), '');
    v_base text;
    v_n integer := 0;
    v_size integer;
    v_row public.emojis;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'Imports go through the federation backend' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_remote FROM public.remote_emojis_cache c WHERE c.id = p_remote_emoji_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Remote emoji not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_remote.imported_as IS NOT NULL THEN
        RAISE EXCEPTION 'Emoji already imported' USING ERRCODE = '23505';
    END IF;
    IF v_name IS NOT NULL AND v_name !~ '^[A-Za-z0-9_-]{2,64}$' THEN
        RAISE EXCEPTION 'Emoji names are 2 to 64 letters, digits, _ or -' USING ERRCODE = '22023';
    END IF;

    v_size := public.instance_emoji_object_ok(p_path, p_url);

    PERFORM pg_advisory_xact_lock(hashtextextended('instance_emojis', 0));
    IF v_name IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM public.emojis e
             WHERE e.server_id IS NULL AND e.scope <> 'user'
               AND NULLIF(btrim(e.domain), '') IS NULL
               AND e.deleted_at IS NULL
               AND lower(e.name::text) = lower(v_name)) THEN
            RAISE EXCEPTION 'Emoji name already exists locally: %', v_name USING ERRCODE = '23505';
        END IF;
    ELSE
        v_base := left(regexp_replace(split_part(v_remote.shortcode, '@', 1), '[^A-Za-z0-9_-]', '', 'g'), 32);
        IF char_length(v_base) < 2 THEN
            v_base := 'emoji';
        END IF;
        v_name := v_base;
        WHILE EXISTS (
            SELECT 1 FROM public.emojis e
             WHERE e.server_id IS NULL AND e.scope <> 'user'
               AND NULLIF(btrim(e.domain), '') IS NULL
               AND e.deleted_at IS NULL
               AND lower(e.name::text) = lower(v_name)) LOOP
            v_n := v_n + 1;
            v_name := v_base || '_' || v_n;
        END LOOP;
    END IF;

    INSERT INTO public.emojis (name, url, server_id, uploader, scope, domain, file_size, imported_from)
    VALUES (v_name, p_url, NULL,
            CASE WHEN EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_actor) THEN p_actor END,
            'instance', NULL, v_size,
            CASE WHEN char_length(v_remote.url) <= 2048 AND v_remote.url ~* '^https?://' THEN v_remote.url END)
    RETURNING * INTO v_row;

    UPDATE public.remote_emojis_cache
       SET imported_as = v_row.id, imported_at = now()
     WHERE id = p_remote_emoji_id;

    IF p_actor IS NOT NULL THEN
        PERFORM public.log_admin_action(p_actor, 'instance_emoji_import', 'emoji', v_row.id::text,
                                        jsonb_build_object('name', v_row.name, 'from', v_remote.url,
                                                           'domain', v_remote.origin_domain));
    END IF;
    RETURN v_row;
END;
$$;

-- An instance-level emoji (no server, not personal, no domain) pointing off-instance moves onto
-- the re-hosted object; imported_from keeps the URL it had.
CREATE OR REPLACE FUNCTION public.rehost_emoji(p_emoji_id uuid, p_path text, p_url text, p_actor uuid)
RETURNS public.emojis
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.emojis;
    v_size integer;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'Re-hosting goes through the federation backend' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_row FROM public.emojis e WHERE e.id = p_emoji_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Emoji not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_row.server_id IS NOT NULL OR v_row.scope = 'user' OR NULLIF(btrim(v_row.domain), '') IS NOT NULL THEN
        RAISE EXCEPTION 'Only instance emojis are re-hosted' USING ERRCODE = '22023';
    END IF;
    IF public.emoji_object_path(v_row.url) IS NOT NULL THEN
        RAISE EXCEPTION 'The emoji is already hosted here' USING ERRCODE = '23505';
    END IF;

    v_size := public.instance_emoji_object_ok(p_path, p_url);

    UPDATE public.emojis
       SET url = p_url,
           file_size = v_size,
           imported_from = COALESCE(imported_from,
                                    CASE WHEN char_length(v_row.url) <= 2048 AND v_row.url ~* '^https?://'
                                         THEN v_row.url::text END),
           updated_at = now()
     WHERE id = p_emoji_id
    RETURNING * INTO v_row;

    IF p_actor IS NOT NULL THEN
        PERFORM public.log_admin_action(p_actor, 'instance_emoji_rehost', 'emoji', v_row.id::text,
                                        jsonb_build_object('name', v_row.name, 'from', v_row.imported_from, 'url', v_row.url));
    END IF;
    RETURN v_row;
END;
$$;

-- ---------------------------------------------------------------------------
-- Reads that skip removed rows
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_emoji_metadata_bulk(server_ids uuid[])
RETURNS TABLE(server_id uuid, last_modified timestamp with time zone, emoji_count integer)
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    RETURN QUERY
    SELECT
        e.server_id,
        MAX(GREATEST(e.created_at, COALESCE(e.updated_at, e.created_at))) AS last_modified,
        (COUNT(e.id) FILTER (WHERE e.deleted_at IS NULL))::integer AS emoji_count
    FROM emojis e
    WHERE e.server_id = ANY(server_ids)
    GROUP BY e.server_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.derive_display_name_emojis()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_base jsonb := '{}'::jsonb;
    v_allowed boolean;
    v_emojis jsonb := '[]'::jsonb;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.display_name IS NOT DISTINCT FROM OLD.display_name THEN
            NEW.federation_metadata := OLD.federation_metadata;
            RETURN NEW;
        END IF;
        IF jsonb_typeof(OLD.federation_metadata) = 'object' THEN
            v_base := OLD.federation_metadata;
        ELSIF jsonb_typeof(OLD.federation_metadata) = 'string' THEN
            -- Rows written as a JSON-encoded string by older federation code.
            BEGIN
                v_base := (OLD.federation_metadata #>> '{}')::jsonb;
                IF jsonb_typeof(v_base) IS DISTINCT FROM 'object' THEN
                    v_base := '{}'::jsonb;
                END IF;
            EXCEPTION WHEN invalid_text_representation THEN
                v_base := '{}'::jsonb;
            END;
        END IF;
    END IF;

    SELECT NOT (c.config_value IN ('false'::jsonb, '"false"'::jsonb)) INTO v_allowed
      FROM public.instance_config c
     WHERE c.config_key = 'allow_custom_emojis_in_display_names';

    IF COALESCE(v_allowed, true) AND NEW.display_name IS NOT NULL THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object('name', e.name, 'url', e.url, 'id', e.id)
                                  ORDER BY codes.first_at), '[]'::jsonb)
          INTO v_emojis
          FROM (SELECT r.match[1] AS code, min(r.at) AS first_at
                  FROM regexp_matches(NEW.display_name, ':([a-zA-Z0-9_+-]+):', 'g')
                       WITH ORDINALITY AS r(match, at)
                 GROUP BY r.match[1]) codes
          JOIN LATERAL (
                SELECT em.id, em.name, em.url
                  FROM public.emojis em
                 WHERE em.name = codes.code AND em.url IS NOT NULL AND em.url <> ''
                   AND em.deleted_at IS NULL
                 ORDER BY (em.scope = 'instance') DESC, (em.domain IS NULL) DESC, em.created_at, em.id
                 LIMIT 1) e ON true;
    END IF;

    NEW.federation_metadata := v_base || jsonb_build_object('display_name_emojis', v_emojis);
    RETURN NEW;
END;
$$;

-- kind 'removed' for a removed emoji; the server's other emoji are its active ones.
CREATE OR REPLACE FUNCTION public.get_emoji_source(p_emoji_id uuid, p_url text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_unavailable constant jsonb := '{"kind": "unavailable"}'::jsonb;
    v_emoji public.emojis%ROWTYPE;
    v_server public.servers%ROWTYPE;
    v_member boolean;
    v_owner jsonb;
    v_others jsonb;
    v_count bigint;
BEGIN
    IF p_emoji_id IS NULL OR p_url IS NULL THEN
        RETURN v_unavailable;
    END IF;

    SELECT * INTO v_emoji FROM public.emojis e WHERE e.id = p_emoji_id;
    IF NOT FOUND OR v_emoji.url::text IS DISTINCT FROM p_url THEN
        RETURN v_unavailable;
    END IF;

    IF v_emoji.deleted_at IS NOT NULL THEN
        RETURN jsonb_build_object('kind', 'removed');
    END IF;

    IF v_emoji.scope = 'user' THEN
        SELECT jsonb_build_object(
                   'id', p.id,
                   'username', p.username,
                   'display_name', p.display_name,
                   'avatar_url', p.avatar_url,
                   'domain', p.domain,
                   'is_local', p.is_local IS NOT FALSE)
          INTO v_owner
          FROM public.profiles p
         WHERE p.id = v_emoji.uploader
           AND p.username IS NOT NULL
           AND p.deleted_at IS NULL
           AND p.is_suspended IS NOT TRUE
           AND NOT EXISTS (
                   SELECT 1 FROM public.user_blocks b
                    WHERE (b.blocker_id = p.id AND b.blocked_user_id = v_me)
                       OR (b.blocker_id = v_me AND b.blocked_user_id = p.id));
        RETURN jsonb_build_object('kind', 'personal', 'owner', v_owner);
    END IF;

    IF v_emoji.server_id IS NULL THEN
        IF NULLIF(btrim(v_emoji.domain), '') IS NULL THEN
            RETURN jsonb_build_object('kind', 'instance');
        END IF;
        RETURN jsonb_build_object('kind', 'remote', 'domain', lower(btrim(v_emoji.domain)));
    END IF;

    SELECT * INTO v_server FROM public.servers s WHERE s.id = v_emoji.server_id;
    IF NOT FOUND THEN
        RETURN v_unavailable;
    END IF;

    v_member := v_me IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.user_servers us
         WHERE us.server_id = v_server.id
           AND us.user_id = v_me
           AND us.status = 'accepted');

    IF NOT v_member AND NOT (v_server.public IS TRUE AND v_server.suspended_at IS NULL) THEN
        RETURN v_unavailable;
    END IF;

    SELECT count(*) INTO v_count
      FROM public.user_servers us
     WHERE us.server_id = v_server.id AND us.status = 'accepted';

    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'url', o.url)
                              ORDER BY o.usage_count DESC NULLS LAST, o.created_at, o.id), '[]'::jsonb)
      INTO v_others
      FROM (SELECT e.id, e.name, e.url, e.usage_count, e.created_at
              FROM public.emojis e
             WHERE e.server_id = v_server.id
               AND e.id <> v_emoji.id
               AND e.url IS NOT NULL
               AND e.deleted_at IS NULL
             ORDER BY e.usage_count DESC NULLS LAST, e.created_at, e.id
             LIMIT 9) o;

    RETURN jsonb_build_object(
        'kind', 'server',
        'server', jsonb_build_object(
            'id', v_server.id,
            'name', v_server.name,
            'icon', v_server.icon,
            'public', v_server.public IS TRUE,
            'member_count', v_count,
            'is_member', v_member,
            'joinable', v_me IS NOT NULL
                        AND NOT v_member
                        AND v_server.public IS TRUE
                        AND v_server.is_local_server IS TRUE
                        AND v_server.suspended_at IS NULL,
            'domain', CASE WHEN v_server.is_local_server IS FALSE
                           THEN lower(NULLIF(btrim(v_server.host_domain), '')) END,
            'emojis', v_others));
END;
$$;

-- Emoji rows of p_names and p_ids the caller may put in content (emoji_usable), active only,
-- in the order clients disambiguate name~N: server_id ascending (NULL last), then id. At most
-- 200 names and 200 ids. p_server_id is the server the content goes to; NULL for direct
-- messages and posts.
CREATE OR REPLACE FUNCTION public.usable_emojis(p_names text[] DEFAULT NULL, p_ids uuid[] DEFAULT NULL,
                                                p_server_id uuid DEFAULT NULL)
RETURNS TABLE(id uuid, name text, url text, server_id uuid, scope text, domain text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT e.id, e.name::text, e.url::text, e.server_id, e.scope, e.domain
      FROM public.emojis e
     WHERE e.deleted_at IS NULL
       AND ((p_names IS NOT NULL AND e.name = ANY (p_names[1:200]))
            OR (p_ids IS NOT NULL AND e.id = ANY (p_ids[1:200])))
       AND public.emoji_usable(e, public.get_current_profile_id(), p_server_id)
     ORDER BY e.server_id, e.id
     LIMIT 1000
$$;

-- ---------------------------------------------------------------------------
-- Emoji parts written by clients
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_content_emoji_parts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_server uuid;
    v_old jsonb := '[]'::jsonb;
    v_out jsonb := '[]'::jsonb;
    v_part jsonb;
    v_e jsonb;
    v_name text;
    v_row public.emojis;
    v_bad boolean;
BEGIN
    IF TG_TABLE_NAME = 'messages' THEN
        IF NEW.channel_id IS NOT NULL THEN
            SELECT c.server_id INTO v_server FROM public.channels c WHERE c.id = NEW.channel_id;
        END IF;
    ELSIF jsonb_typeof(NEW.metadata) = 'object' AND NEW.metadata ? 'reblog_of'
          AND NOT COALESCE(NEW.metadata -> 'is_quote' IN ('true'::jsonb, '"true"'::jsonb), false) THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' AND jsonb_typeof(OLD.content) = 'array' THEN
        v_old := OLD.content;
    END IF;

    FOR v_part IN SELECT a.e FROM jsonb_array_elements(NEW.content) WITH ORDINALITY a(e, n) ORDER BY a.n LOOP
        IF jsonb_typeof(v_part) IS DISTINCT FROM 'object' OR v_part ->> 'type' IS DISTINCT FROM 'emoji'
           OR v_old @> jsonb_build_array(v_part) THEN
            v_out := v_out || jsonb_build_array(v_part);
            CONTINUE;
        END IF;

        v_e := v_part -> 'emoji';
        v_bad := jsonb_typeof(v_e) IS DISTINCT FROM 'object';
        IF NOT v_bad THEN
            v_name := v_e ->> 'name';
            v_bad := jsonb_typeof(v_e -> 'name') IS DISTINCT FROM 'string'
                OR v_name !~ '^[^[:space:][:cntrl:]:<>"''`\\]{1,64}$'
                OR COALESCE(jsonb_typeof(v_e -> 'id'), 'null') NOT IN ('string', 'null')
                OR char_length(COALESCE(v_e ->> 'id', '')) > 200
                OR COALESCE(jsonb_typeof(v_e -> 'url'), 'null') NOT IN ('string', 'null')
                OR char_length(COALESCE(v_e ->> 'url', '')) > 2048
                OR (jsonb_typeof(v_e -> 'url') = 'string' AND v_e ->> 'url' !~* '^https?://')
                OR COALESCE(jsonb_typeof(v_e -> 'server_id'), 'null') NOT IN ('string', 'null')
                OR COALESCE(jsonb_typeof(v_e -> 'domain'), 'null') NOT IN ('string', 'null');
        END IF;
        IF COALESCE(v_bad, true) THEN
            RAISE EXCEPTION 'EMOJI_PART: an emoji part is {type: emoji, emoji: {name, id?, url?, server_id?, domain?}}'
                USING ERRCODE = '22023';
        END IF;

        v_row := NULL;
        IF v_e ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            SELECT * INTO v_row FROM public.emojis e WHERE e.id = (v_e ->> 'id')::uuid;
        END IF;

        IF v_row.id IS NOT NULL AND public.emoji_usable(v_row, v_me, v_server) THEN
            v_part := v_part || jsonb_build_object('emoji', jsonb_strip_nulls(jsonb_build_object(
                'id', v_row.id::text,
                'name', v_row.name::text,
                'url', v_row.url::text,
                'server_id', v_row.server_id::text,
                'domain', NULLIF(btrim(v_row.domain), ''))));
        ELSIF v_e ->> 'url' ~ '^https://(cdn\.discordapp\.com|media\.discordapp\.net)/emojis/[0-9]{17,20}\.(png|gif|webp)([?#][^[:space:]]*)?$'
              AND ((v_e ->> 'domain' = 'discord.com' AND v_name ~ '^[A-Za-z0-9_]{2,32}$')
                   OR (v_e ->> 'id' ~ '^discord:(a:)?[A-Za-z0-9_]{2,32}:[0-9]{17,20}$'
                       AND substring(v_e ->> 'id' FROM '([0-9]{17,20})$')
                           = substring(v_e ->> 'url' FROM '/emojis/([0-9]{17,20})\.'))) THEN
            v_part := v_part || jsonb_build_object('emoji', jsonb_build_object(
                'id', CASE WHEN v_e ->> 'id' ~ '^discord:' THEN v_e ->> 'id' END,
                'name', COALESCE(substring(v_e ->> 'id' FROM '^discord:(?:a:)?([A-Za-z0-9_]{2,32}):'), v_name),
                'url', v_e ->> 'url', 'domain', 'discord.com', 'server_id', NULL));
        ELSE
            v_part := jsonb_build_object('type', 'text', 'text', ':' || v_name || ':');
        END IF;
        v_out := v_out || jsonb_build_array(v_part);
    END LOOP;

    IF v_out IS DISTINCT FROM NEW.content THEN
        NEW.content := v_out;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_messages_content_emoji_parts ON public.messages;
CREATE TRIGGER a_messages_content_emoji_parts
    BEFORE INSERT OR UPDATE OF content ON public.messages
    FOR EACH ROW
    WHEN (CURRENT_USER IN ('authenticated', 'anon')
          AND NEW.encrypted IS NOT TRUE
          AND jsonb_typeof(NEW.content) = 'array'
          AND NEW.content @> '[{"type": "emoji"}]'::jsonb)
    EXECUTE FUNCTION public.check_content_emoji_parts();

DROP TRIGGER IF EXISTS a_posts_content_emoji_parts ON public.posts;
CREATE TRIGGER a_posts_content_emoji_parts
    BEFORE INSERT OR UPDATE OF content ON public.posts
    FOR EACH ROW
    WHEN (CURRENT_USER IN ('authenticated', 'anon')
          AND jsonb_typeof(NEW.content) = 'array'
          AND NEW.content @> '[{"type": "emoji"}]'::jsonb)
    EXECUTE FUNCTION public.check_content_emoji_parts();

-- ---------------------------------------------------------------------------
-- Admin list
-- ---------------------------------------------------------------------------

-- server | personal | ai | federated | imported | instance
CREATE OR REPLACE FUNCTION public.emoji_kind(p_emoji public.emojis)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN p_emoji.server_id IS NOT NULL THEN 'server'
        WHEN p_emoji.scope = 'user' AND p_emoji.is_ai_generated THEN 'ai'
        WHEN p_emoji.scope = 'user' THEN 'personal'
        WHEN NULLIF(btrim(p_emoji.domain), '') IS NOT NULL THEN 'federated'
        WHEN p_emoji.imported_from IS NOT NULL
             OR EXISTS (SELECT 1 FROM public.remote_emojis_cache c WHERE c.imported_as = p_emoji.id) THEN 'imported'
        ELSE 'instance'
    END
$$;

DROP FUNCTION IF EXISTS public.admin_list_instance_emojis(text, text, text, integer, integer);

-- p_kind all | instance | imported | federated | server | personal | ai | not_imported;
-- p_status active | removed | all (ignored for not_imported); p_sort newest | oldest | name |
-- usage. not_imported rows are remote_emojis_cache rows with imported_as NULL: id is the cache
-- id, domain its origin, created_at its first sighting, usage_count its sightings. hotlinked:
-- an instance or imported emoji whose url is not an object of bucket emojis.
CREATE OR REPLACE FUNCTION public.admin_list_emojis(
    p_search text DEFAULT NULL,
    p_kind text DEFAULT 'all',
    p_status text DEFAULT 'active',
    p_sort text DEFAULT 'newest',
    p_limit integer DEFAULT 50,
    p_offset integer DEFAULT 0)
RETURNS TABLE(id uuid, kind text, name text, url text, domain text, scope text, server_id uuid,
              server_name text, uploader uuid, uploader_username text, created_at timestamptz,
              usage_count integer, reaction_count bigint, deleted_at timestamptz,
              deleted_by_username text, imported_from text, hotlinked boolean,
              is_ai_generated boolean, total_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_search text := lower(NULLIF(btrim(p_search), ''));
    v_kind text := COALESCE(p_kind, 'all');
    v_status text := COALESCE(p_status, 'active');
    v_sort text := COALESCE(p_sort, 'newest');
    v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 50), 200));
    v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;
    IF v_kind NOT IN ('all', 'instance', 'imported', 'federated', 'server', 'personal', 'ai', 'not_imported') THEN
        RAISE EXCEPTION 'Unknown kind: %', v_kind USING ERRCODE = '22023';
    END IF;
    IF v_status NOT IN ('active', 'removed', 'all') THEN
        RAISE EXCEPTION 'Unknown status: %', v_status USING ERRCODE = '22023';
    END IF;
    IF v_sort NOT IN ('newest', 'oldest', 'name', 'usage') THEN
        RAISE EXCEPTION 'Unknown sort: %', v_sort USING ERRCODE = '22023';
    END IF;

    IF v_kind = 'not_imported' THEN
        RETURN QUERY
        WITH matched AS (
            SELECT c.*, count(*) OVER () AS total
              FROM public.remote_emojis_cache c
             WHERE c.imported_as IS NULL
               AND (v_search IS NULL
                    OR strpos(lower(c.shortcode), v_search) > 0
                    OR strpos(lower(c.origin_domain), v_search) > 0)
             ORDER BY CASE WHEN v_sort = 'name' THEN lower(c.shortcode) END ASC NULLS LAST,
                      CASE WHEN v_sort = 'usage' THEN c.usage_count END DESC NULLS LAST,
                      CASE WHEN v_sort = 'oldest' THEN c.first_seen_at END ASC NULLS LAST,
                      c.first_seen_at DESC NULLS LAST, c.id DESC
             LIMIT v_limit OFFSET v_offset
        )
        SELECT m.id, 'not_imported'::text, m.shortcode, COALESCE(m.static_url, m.url), lower(m.origin_domain),
               NULL::text, NULL::uuid, NULL::text, NULL::uuid, NULL::text, m.first_seen_at,
               COALESCE(m.usage_count, 0), 0::bigint, NULL::timestamptz, NULL::text, m.url, false,
               false, m.total
          FROM matched m
         ORDER BY CASE WHEN v_sort = 'name' THEN lower(m.shortcode) END ASC NULLS LAST,
                  CASE WHEN v_sort = 'usage' THEN m.usage_count END DESC NULLS LAST,
                  CASE WHEN v_sort = 'oldest' THEN m.first_seen_at END ASC NULLS LAST,
                  m.first_seen_at DESC NULLS LAST, m.id DESC;
        RETURN;
    END IF;

    RETURN QUERY
    WITH typed AS (
        SELECT e.*, public.emoji_kind(e) AS e_kind
          FROM public.emojis e
         WHERE (v_status = 'all'
                OR (v_status = 'active' AND e.deleted_at IS NULL)
                OR (v_status = 'removed' AND e.deleted_at IS NOT NULL))
    ), matched AS (
        SELECT t.*, s.name::text AS s_name, p.username::text AS owner_username,
               d.username::text AS remover_username, count(*) OVER () AS total
          FROM typed t
          LEFT JOIN public.servers s ON s.id = t.server_id
          LEFT JOIN public.profiles p ON p.id = t.uploader
          LEFT JOIN public.profiles d ON d.id = t.deleted_by
         WHERE (v_kind = 'all' OR t.e_kind = v_kind)
           AND (v_search IS NULL
                OR strpos(lower(t.name::text), v_search) > 0
                OR strpos(lower(COALESCE(t.domain, '')), v_search) > 0
                OR strpos(lower(COALESCE(s.name::text, '')), v_search) > 0
                OR strpos(lower(COALESCE(p.username::text, '')), v_search) > 0)
         ORDER BY CASE WHEN v_sort = 'name' THEN lower(t.name::text) END ASC NULLS LAST,
                  CASE WHEN v_sort = 'usage' THEN COALESCE(t.usage_count, 0) END DESC NULLS LAST,
                  CASE WHEN v_sort = 'oldest' THEN t.created_at END ASC NULLS LAST,
                  t.created_at DESC, t.id DESC
         LIMIT v_limit OFFSET v_offset
    )
    SELECT m.id, m.e_kind, m.name::text, m.url::text, m.domain, m.scope, m.server_id, m.s_name,
           m.uploader, m.owner_username, m.created_at, COALESCE(m.usage_count, 0),
           (SELECT count(*) FROM public.reactions r WHERE r.emoji_id = m.id),
           m.deleted_at, m.remover_username, m.imported_from,
           m.e_kind IN ('instance', 'imported') AND public.emoji_object_path(m.url) IS NULL,
           m.is_ai_generated, m.total
      FROM matched m
     ORDER BY CASE WHEN v_sort = 'name' THEN lower(m.name::text) END ASC NULLS LAST,
              CASE WHEN v_sort = 'usage' THEN COALESCE(m.usage_count, 0) END DESC NULLS LAST,
              CASE WHEN v_sort = 'oldest' THEN m.created_at END ASC NULLS LAST,
              m.created_at DESC, m.id DESC;
END;
$$;

-- ---------------------------------------------------------------------------
-- Storage: a referenced emoji file is deleted by instance admins only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.emoji_object_referenced(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.emojis e
         WHERE right(e.url::text, char_length('/storage/v1/object/public/emojis/' || p_name))
               = '/storage/v1/object/public/emojis/' || p_name)
$$;

CREATE OR REPLACE FUNCTION public.guard_emoji_object_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.emoji_object_referenced(OLD.name) AND NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'EMOJI_FILE_IN_USE: % is the file of an emoji; instance admins purge it', OLD.name
            USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
END;
$$;

DO $$
BEGIN
    IF to_regclass('storage.objects') IS NULL THEN
        RAISE NOTICE 'storage schema absent, emoji file guard skipped';
        RETURN;
    END IF;
    DROP TRIGGER IF EXISTS emoji_object_delete_guard ON storage.objects;
    CREATE TRIGGER emoji_object_delete_guard
        BEFORE DELETE ON storage.objects
        FOR EACH ROW
        WHEN (OLD.bucket_id = 'emojis' AND CURRENT_USER IN ('authenticated', 'anon'))
        EXECUTE FUNCTION public.guard_emoji_object_delete();
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'no privilege on storage.objects, emoji file guard skipped';
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.server_emoji_limit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.server_emoji_limit() TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.can_manage_emoji(public.emojis) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_emoji(public.emojis) TO service_role;
REVOKE ALL ON FUNCTION public.emoji_usable(public.emojis, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.emoji_usable(public.emojis, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.emoji_name_taken(public.emojis, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.emoji_name_taken(public.emojis, text) TO service_role;
REVOKE ALL ON FUNCTION public.emoji_object_path(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.emoji_object_path(text) TO service_role;
REVOKE ALL ON FUNCTION public.emoji_kind(public.emojis) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.emoji_kind(public.emojis) TO service_role;
REVOKE ALL ON FUNCTION public.emoji_object_referenced(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.emoji_object_referenced(text) TO service_role;
REVOKE ALL ON FUNCTION public.guard_emoji_object_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_content_emoji_parts() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instance_emoji_object_ok(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.instance_emoji_object_ok(text, text) TO service_role;

REVOKE ALL ON FUNCTION public.remove_emoji(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_emoji(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.restore_emoji(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_emoji(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.rename_emoji(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rename_emoji(uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_purge_emoji(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_purge_emoji(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_server_emoji(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_server_emoji(uuid, text, text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.usable_emojis(text[], uuid[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.usable_emojis(text[], uuid[], uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_list_emojis(text, text, text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_emojis(text, text, text, text, integer, integer) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.import_remote_emoji(uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_remote_emoji(uuid, text, text, text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.rehost_emoji(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rehost_emoji(uuid, text, text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.create_my_emoji(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_my_emoji(text, text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_instance_emoji(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_instance_emoji(text, text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.rename_my_emoji(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rename_my_emoji(uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_rename_instance_emoji(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_rename_instance_emoji(uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_federated_emoji(text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_federated_emoji(text, text, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.get_emoji_source(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_emoji_source(uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.prepare_emoji_deletion() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_emoji_deletion() TO service_role;
REVOKE ALL ON FUNCTION public.server_audit_emojis() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.server_audit_emojis() TO service_role;
REVOKE ALL ON FUNCTION public.enforce_personal_emoji_limit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_personal_emoji_limit() TO service_role;
REVOKE ALL ON FUNCTION public.derive_display_name_emojis() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.derive_display_name_emojis() TO service_role;

COMMIT;
