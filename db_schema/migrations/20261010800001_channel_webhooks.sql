-- Channel webhooks: a secret URL per channel that external services post messages to.
--
-- channel_webhooks holds one row per webhook. The token is 32 random bytes as 64 hex
-- characters; the row keeps its SHA-256 hex digest (token_hash) and its last 4 characters
-- (token_hint). The plaintext is returned once, by create_channel_webhook and
-- regenerate_channel_webhook_token. The federation backend serves
-- POST /webhooks/channels/<id>/<token>[/github], hashes the token and calls
-- execute_channel_webhook as service_role.
--
-- Each webhook posts as a hidden backing bot: a bots row with bot_type 'integration',
-- private, owned by the creator, installed in the server with send_messages alone,
-- mention_everyone off and allowed_channel_ids the webhook's channel. Deleting a webhook,
-- directly or with its channel, deactivates the bot and its installs and keeps both:
-- messages.bot_id cascades on delete. Integration bots and their installs take no client
-- write, hold no token, are absent from get_server_bots and from client reads of
-- bot_server_permissions.
--
-- Management (owner, instance admin, or a member who sees the channel and holds
-- MANAGE_WEBHOOKS there): create_channel_webhook, list_channel_webhooks,
-- list_server_webhooks, update_channel_webhook, regenerate_channel_webhook_token,
-- delete_channel_webhook. Webhooks post to text channels of local servers whose messages are
-- not end-to-end encrypted; a channel holds at most 10 webhooks, a server 50.
--
-- execute_channel_webhook builds the content from text alone: text parts and url parts, split
-- as the client splits composed text (src/utils/urlSplitting.ts). No mention, role_mention,
-- system or embed part is produced, so "@everyone" in the text notifies no one. The first 5
-- url parts keep link previews; a URL in <...> keeps none. metadata is
-- {bot, created_via 'webhook', webhook {id, name, avatar_url}}, name and avatar_url being the
-- per-message overrides or the webhook's own; suppress_embeds is set on request. 'webhook'
-- joins the metadata keys reserved for the server.
--
-- Error messages begin with a stable code the backend and client read:
--   WEBHOOK_UNAUTHORIZED          28000  unknown or inactive webhook, wrong token
--   WEBHOOK_CHANNEL_ENCRYPTED     42501  the channel's messages are end-to-end encrypted
--   WEBHOOK_CHANNEL_UNSUPPORTED   22023  remote server or channel, or not a text channel
--   WEBHOOK_EMPTY_MESSAGE         22023  no text
--   WEBHOOK_CONTENT_TOO_LONG      22001  text parts past instance_config max_message_length
--   WEBHOOK_INVALID_NAME          22023  name or username not 1 to 80 characters, or reserved
--   WEBHOOK_INVALID_AVATAR_URL    22023  not an https URL of at most 2048 characters
--   WEBHOOK_LIMIT_CHANNEL/SERVER  54000  cap reached
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.channel_webhooks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    channel_id uuid NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
    bot_id uuid NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
    name text NOT NULL,
    avatar_url text,
    token_hash text NOT NULL,
    token_hint text NOT NULL,
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    use_count bigint NOT NULL DEFAULT 0,
    CONSTRAINT channel_webhooks_name_check CHECK (char_length(name) BETWEEN 1 AND 80),
    CONSTRAINT channel_webhooks_avatar_url_check
        CHECK (avatar_url IS NULL OR (avatar_url ~ '^https://' AND char_length(avatar_url) <= 2048)),
    CONSTRAINT channel_webhooks_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT channel_webhooks_token_hint_check CHECK (char_length(token_hint) = 4),
    CONSTRAINT channel_webhooks_bot_id_key UNIQUE (bot_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_webhooks_channel ON public.channel_webhooks (channel_id);
CREATE INDEX IF NOT EXISTS idx_channel_webhooks_server ON public.channel_webhooks (server_id);
CREATE INDEX IF NOT EXISTS idx_channel_webhooks_created_by ON public.channel_webhooks (created_by)
    WHERE created_by IS NOT NULL;

COMMENT ON TABLE public.channel_webhooks IS
'Incoming channel webhooks. Written and read only through the webhook RPCs; execute_channel_webhook posts as bot_id.';
COMMENT ON COLUMN public.channel_webhooks.token_hash IS
'SHA-256 hex digest of the token, a 64-character hex string.';
COMMENT ON COLUMN public.channel_webhooks.token_hint IS
'Last 4 characters of the token.';

-- Clients reach it through the webhook RPCs alone.
ALTER TABLE public.channel_webhooks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "channel_webhooks_service_role" ON public.channel_webhooks;
CREATE POLICY "channel_webhooks_service_role" ON public.channel_webhooks
    FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.channel_webhooks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.channel_webhooks TO service_role;

-- ---------------------------------------------------------------------------
-- Integration bots
-- ---------------------------------------------------------------------------

-- Executable by authenticated: the bot_server_permissions SELECT policy calls it as the reader.
CREATE OR REPLACE FUNCTION public.bot_is_integration(p_bot_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (SELECT 1 FROM public.bots b WHERE b.id = p_bot_id AND b.bot_type = 'integration');
$$;

REVOKE ALL ON FUNCTION public.bot_is_integration(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_is_integration(uuid) TO authenticated, service_role;

-- As the baseline policy, plus integration installs hidden. anon matched no row before.
DROP POLICY IF EXISTS "Server members can view bot permissions" ON public.bot_server_permissions;
CREATE POLICY "Server members can view bot permissions" ON public.bot_server_permissions
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.user_servers
              JOIN public.profiles ON profiles.id = user_servers.user_id
             WHERE user_servers.server_id = bot_server_permissions.server_id
               AND profiles.auth_user_id = ( SELECT auth.uid() )
        )
        AND NOT public.bot_is_integration(bot_server_permissions.bot_id)
    );

CREATE OR REPLACE FUNCTION public.guard_integration_bot_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF (TG_OP <> 'INSERT' AND OLD.bot_type = 'integration')
       OR (TG_OP <> 'DELETE' AND NEW.bot_type = 'integration') THEN
        RAISE EXCEPTION 'webhook bots are managed through the webhook RPCs' USING ERRCODE = '42501';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_integration_bot_client_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_bots_integration_guard ON public.bots;
CREATE TRIGGER a_bots_integration_guard
    BEFORE INSERT OR UPDATE OR DELETE ON public.bots
    FOR EACH ROW EXECUTE FUNCTION public.guard_integration_bot_client_write();

CREATE OR REPLACE FUNCTION public.guard_integration_install_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF (TG_OP <> 'INSERT' AND public.bot_is_integration(OLD.bot_id))
       OR (TG_OP <> 'DELETE' AND public.bot_is_integration(NEW.bot_id)) THEN
        RAISE EXCEPTION 'webhook bot installs are managed through the webhook RPCs' USING ERRCODE = '42501';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_integration_install_client_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_bot_server_permissions_integration_guard ON public.bot_server_permissions;
CREATE TRIGGER a_bot_server_permissions_integration_guard
    BEFORE INSERT OR UPDATE OR DELETE ON public.bot_server_permissions
    FOR EACH ROW EXECUTE FUNCTION public.guard_integration_install_client_write();

-- Every role: issue_bot_token and rotate_bot_token are definers.
CREATE OR REPLACE FUNCTION public.refuse_integration_bot_tokens()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.bot_is_integration(NEW.bot_id) THEN
        RAISE EXCEPTION 'webhook bots hold no API token' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.refuse_integration_bot_tokens() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_bot_tokens_integration_guard ON public.bot_tokens;
CREATE TRIGGER a_bot_tokens_integration_guard
    BEFORE INSERT OR UPDATE OF bot_id, is_active ON public.bot_tokens
    FOR EACH ROW EXECUTE FUNCTION public.refuse_integration_bot_tokens();

-- A webhook's bot and installs follow its active state; a deleted webhook leaves them inactive.
CREATE OR REPLACE FUNCTION public.sync_channel_webhook_bot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bot uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.bot_id ELSE NEW.bot_id END;
    v_active boolean := TG_OP = 'UPDATE' AND NEW.is_active;
BEGIN
    UPDATE public.bots SET is_active = v_active
     WHERE id = v_bot AND is_active IS DISTINCT FROM v_active;
    UPDATE public.bot_server_permissions SET is_active = v_active
     WHERE bot_id = v_bot AND is_active IS DISTINCT FROM v_active;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_channel_webhook_bot() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sync_channel_webhook_bot ON public.channel_webhooks;
CREATE TRIGGER sync_channel_webhook_bot
    AFTER DELETE OR UPDATE OF is_active ON public.channel_webhooks
    FOR EACH ROW EXECUTE FUNCTION public.sync_channel_webhook_bot();

-- As 20261006000001, without integration bots.
CREATE OR REPLACE FUNCTION public.get_server_bots(p_server_id uuid)
RETURNS TABLE (
    id uuid,
    username text,
    display_name text,
    avatar_url text,
    bot_type text,
    status text,
    custom_status text,
    activity_type text,
    activity_name text,
    last_heartbeat_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT b.id, b.username, b.display_name, b.avatar_url, b.bot_type,
           COALESCE(bp.status, 'offline'), bp.custom_status, bp.activity_type, bp.activity_name,
           bp.last_heartbeat_at
      FROM public.bot_server_permissions i
      JOIN public.bots b ON b.id = i.bot_id
      LEFT JOIN public.bot_presence bp ON bp.bot_id = b.id
     WHERE i.server_id = p_server_id
       AND i.is_active IS TRUE
       AND b.is_active IS TRUE
       AND b.bot_type IS DISTINCT FROM 'integration'
       AND (EXISTS (SELECT 1 FROM public.user_servers us
                     WHERE us.server_id = p_server_id
                       AND us.user_id = public.get_current_profile_id()
                       AND us.status = 'accepted')
            OR public.is_current_user_admin())
     ORDER BY lower(COALESCE(b.display_name, b.username)), b.id;
$$;

-- ---------------------------------------------------------------------------
-- Validation and content
-- ---------------------------------------------------------------------------

-- Whitespace runs become one space. Reserved: 'system', 'everyone', 'here' and the instance
-- name, compared on letters and digits alone, and any '@everyone' or '@here'.
CREATE OR REPLACE FUNCTION public.webhook_normalize_name(p_name text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_name text := btrim(regexp_replace(COALESCE(p_name, ''), '[[:space:]]+', ' ', 'g'));
    v_folded text;
    v_instance text;
BEGIN
    IF v_name = '' OR char_length(v_name) > 80 OR v_name ~ '[[:cntrl:]]' THEN
        RAISE EXCEPTION 'WEBHOOK_INVALID_NAME: a webhook name is 1 to 80 characters'
            USING ERRCODE = '22023';
    END IF;

    SELECT lower(regexp_replace(config_value #>> '{}', '[^[:alnum:]]', '', 'g')) INTO v_instance
      FROM public.instance_config WHERE config_key = 'instance_name';
    v_folded := lower(regexp_replace(v_name, '[^[:alnum:]]', '', 'g'));

    IF v_folded IN ('system', 'everyone', 'here')
       OR (COALESCE(v_instance, '') <> '' AND v_folded = v_instance)
       OR v_name ~* '@(everyone|here)' THEN
        RAISE EXCEPTION 'WEBHOOK_INVALID_NAME: "%" is reserved', v_name
            USING ERRCODE = '22023';
    END IF;
    RETURN v_name;
END;
$$;

REVOKE ALL ON FUNCTION public.webhook_normalize_name(text) FROM PUBLIC, anon, authenticated;

-- NULL for NULL or blank.
CREATE OR REPLACE FUNCTION public.webhook_normalize_avatar_url(p_url text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_url text := btrim(COALESCE(p_url, ''));
BEGIN
    IF v_url = '' THEN
        RETURN NULL;
    END IF;
    IF char_length(v_url) > 2048 OR v_url !~ '^https://[^[:space:][:cntrl:]"<>]+$' THEN
        RAISE EXCEPTION 'WEBHOOK_INVALID_AVATAR_URL: an avatar is an https URL of at most 2048 characters'
            USING ERRCODE = '22023';
    END IF;
    RETURN v_url;
END;
$$;

REVOKE ALL ON FUNCTION public.webhook_normalize_avatar_url(text) FROM PUBLIC, anon, authenticated;

-- splitTextForUrlParts (src/utils/urlSplitting.ts): an http(s) URL ends at whitespace, a
-- quote, '<' or '>' or the next glued scheme, less trailing punctuation; '<' before it keeps
-- no preview and the closing '>' is dropped. Deviation: url parts past the fifth keep no
-- preview, bounding link-preview fetches per message.
CREATE OR REPLACE FUNCTION public.webhook_message_parts(p_text text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_parts jsonb := '[]'::jsonb;
    v_rest text := COALESCE(p_text, '');
    v_text text := '';
    v_pos integer;
    v_scheme integer;
    v_url text;
    v_cut integer;
    v_suppressed boolean;
    v_end integer;
    v_previews integer := 0;
BEGIN
    LOOP
        v_pos := regexp_instr(v_rest, 'https?://');
        EXIT WHEN v_pos = 0;
        v_scheme := CASE WHEN substr(v_rest, v_pos, 5) = 'https' THEN 8 ELSE 7 END;
        v_url := substring(substr(v_rest, v_pos) FROM '^https?://[^[:space:]<>"'']*');
        v_cut := regexp_instr(substr(v_url, v_scheme + 1), 'https?://');
        IF v_cut > 0 THEN
            v_url := left(v_url, v_scheme + v_cut - 1);
        END IF;
        v_url := regexp_replace(v_url, '[.,;:!?)>\]}]+$', '');

        IF char_length(v_url) <= v_scheme THEN
            v_text := v_text || left(v_rest, v_pos - 1 + v_scheme);
            v_rest := substr(v_rest, v_pos + v_scheme);
            CONTINUE;
        END IF;

        v_suppressed := v_pos > 1 AND substr(v_rest, v_pos - 1, 1) = '<';
        v_text := v_text || left(v_rest, v_pos - CASE WHEN v_suppressed THEN 2 ELSE 1 END);
        IF v_text <> '' THEN
            v_parts := v_parts || jsonb_build_array(jsonb_build_object('type', 'text', 'text', v_text));
            v_text := '';
        END IF;

        v_parts := v_parts || jsonb_build_array(jsonb_build_object(
            'type', 'url', 'url', v_url, 'preview', NOT v_suppressed AND v_previews < 5));
        IF NOT v_suppressed THEN
            v_previews := v_previews + 1;
        END IF;

        v_end := v_pos + char_length(v_url);
        IF v_suppressed AND substr(v_rest, v_end, 1) = '>' THEN
            v_end := v_end + 1;
        END IF;
        v_rest := substr(v_rest, v_end);
    END LOOP;

    v_text := v_text || v_rest;
    IF v_text <> '' THEN
        v_parts := v_parts || jsonb_build_array(jsonb_build_object('type', 'text', 'text', v_text));
    END IF;
    RETURN v_parts;
END;
$$;

REVOKE ALL ON FUNCTION public.webhook_message_parts(text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Management
-- ---------------------------------------------------------------------------

-- The caller is the server owner, an instance admin, or sees the channel and holds
-- MANAGE_WEBHOOKS there. has_permission alone admits non-members through @everyone.
CREATE OR REPLACE FUNCTION public.can_manage_channel_webhooks(p_channel_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.channels c
          JOIN public.servers s ON s.id = c.server_id
         WHERE c.id = p_channel_id
           AND public.get_current_profile_id() IS NOT NULL
           AND (s.owner = public.get_current_profile_id()
                OR public.is_current_user_admin()
                OR (public.can_view_channel(public.get_current_profile_id(), c.id)
                    AND public.has_permission(public.get_current_profile_id(), c.server_id,
                                              'MANAGE_WEBHOOKS', c.id)))
    );
$$;

REVOKE ALL ON FUNCTION public.can_manage_channel_webhooks(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.channel_webhook_json(p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'id', w.id,
        'server_id', w.server_id,
        'channel_id', w.channel_id,
        'channel_name', c.name,
        'name', w.name,
        'avatar_url', w.avatar_url,
        'token_hint', w.token_hint,
        'is_active', w.is_active,
        'created_by', w.created_by,
        'created_by_username', p.username,
        'created_by_display_name', p.display_name,
        'created_at', w.created_at,
        'last_used_at', w.last_used_at,
        'use_count', w.use_count)
      FROM public.channel_webhooks w
      JOIN public.channels c ON c.id = w.channel_id
      LEFT JOIN public.profiles p ON p.id = w.created_by
     WHERE w.id = p_id;
$$;

REVOKE ALL ON FUNCTION public.channel_webhook_json(uuid) FROM PUBLIC, anon, authenticated;

-- The channel a webhook may be created in or posted to, or the WEBHOOK_CHANNEL_* error.
CREATE OR REPLACE FUNCTION public.assert_webhook_channel(p_channel_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_channel record;
BEGIN
    SELECT c.server_id, c.type, c.is_remote, s.is_local_server INTO v_channel
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id
     WHERE c.id = p_channel_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Channel not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_channel.is_remote IS TRUE OR v_channel.is_local_server IS FALSE
       OR COALESCE(v_channel.type, 0) <> 0 THEN
        RAISE EXCEPTION 'WEBHOOK_CHANNEL_UNSUPPORTED: webhooks post to text channels of this instance''s servers'
            USING ERRCODE = '22023';
    END IF;
    IF public.channel_messages_encrypted(p_channel_id) THEN
        RAISE EXCEPTION 'WEBHOOK_CHANNEL_ENCRYPTED: this channel is end-to-end encrypted'
            USING ERRCODE = '42501';
    END IF;
    RETURN v_channel.server_id;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_webhook_channel(uuid) FROM PUBLIC, anon, authenticated;

-- Returns the webhook as list_channel_webhooks does, plus 'token'.
CREATE OR REPLACE FUNCTION public.create_channel_webhook(
    p_channel_id uuid,
    p_name text,
    p_avatar_url text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_server uuid;
    v_name text;
    v_avatar text;
    v_bot uuid;
    v_token text;
    v_id uuid;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.channels WHERE id = p_channel_id) THEN
        RAISE EXCEPTION 'Channel not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.can_manage_channel_webhooks(p_channel_id) THEN
        RAISE EXCEPTION 'Permission denied: MANAGE_WEBHOOKS required' USING ERRCODE = '42501';
    END IF;

    v_server := public.assert_webhook_channel(p_channel_id);
    v_name := public.webhook_normalize_name(p_name);
    v_avatar := public.webhook_normalize_avatar_url(p_avatar_url);

    PERFORM pg_advisory_xact_lock(hashtextextended('channel_webhooks:' || v_server::text, 0));
    IF (SELECT count(*) FROM public.channel_webhooks WHERE channel_id = p_channel_id) >= 10 THEN
        RAISE EXCEPTION 'WEBHOOK_LIMIT_CHANNEL: a channel holds at most 10 webhooks'
            USING ERRCODE = '54000';
    END IF;
    IF (SELECT count(*) FROM public.channel_webhooks WHERE server_id = v_server) >= 50 THEN
        RAISE EXCEPTION 'WEBHOOK_LIMIT_SERVER: a server holds at most 50 webhooks'
            USING ERRCODE = '54000';
    END IF;

    INSERT INTO public.bots (username, display_name, bio, avatar_url, bot_type, is_public, owner_id)
    VALUES ('webhook-' || encode(extensions.gen_random_bytes(6), 'hex'),
            v_name,
            'Channel webhook.',
            COALESCE(v_avatar, '/default_avatar.webp'),
            'integration',
            false,
            v_caller)
    RETURNING id INTO v_bot;

    INSERT INTO public.bot_server_permissions
        (bot_id, server_id, installed_by, is_active, read_messages, send_messages, manage_messages,
         embed_links, attach_files, mention_everyone, add_reactions, manage_channels, kick_members,
         ban_members, manage_roles, allowed_channel_ids)
    VALUES (v_bot, v_server, v_caller, true, false, true, false,
            false, false, false, false, false, false,
            false, false, ARRAY[p_channel_id]);

    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    INSERT INTO public.channel_webhooks
        (server_id, channel_id, bot_id, name, avatar_url, token_hash, token_hint, created_by)
    VALUES (v_server, p_channel_id, v_bot, v_name, v_avatar,
            encode(extensions.digest(convert_to(v_token, 'UTF8'), 'sha256'), 'hex'),
            right(v_token, 4), v_caller)
    RETURNING id INTO v_id;

    RETURN public.channel_webhook_json(v_id) || jsonb_build_object('token', v_token);
END;
$$;

COMMENT ON FUNCTION public.create_channel_webhook(uuid, text, text) IS
    'Create a channel webhook; the token is returned once.';

REVOKE ALL ON FUNCTION public.create_channel_webhook(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_channel_webhook(uuid, text, text) TO authenticated, service_role;

-- A jsonb array, oldest first.
CREATE OR REPLACE FUNCTION public.list_channel_webhooks(p_channel_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.get_current_profile_id() IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF NOT public.can_manage_channel_webhooks(p_channel_id) THEN
        RAISE EXCEPTION 'Permission denied: MANAGE_WEBHOOKS required' USING ERRCODE = '42501';
    END IF;

    RETURN COALESCE((
        SELECT jsonb_agg(public.channel_webhook_json(w.id) ORDER BY w.created_at, w.id)
          FROM public.channel_webhooks w
         WHERE w.channel_id = p_channel_id
    ), '[]'::jsonb);
END;
$$;

COMMENT ON FUNCTION public.list_channel_webhooks(uuid) IS
    'Webhooks of a channel, for its webhook managers.';

REVOKE ALL ON FUNCTION public.list_channel_webhooks(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_channel_webhooks(uuid) TO authenticated, service_role;

-- Webhooks of the server's channels the caller manages, as a jsonb array by channel and age.
CREATE OR REPLACE FUNCTION public.list_server_webhooks(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.get_current_profile_id() IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    RETURN COALESCE((
        SELECT jsonb_agg(public.channel_webhook_json(w.id) ORDER BY c.name, w.created_at, w.id)
          FROM public.channel_webhooks w
          JOIN public.channels c ON c.id = w.channel_id
         WHERE w.server_id = p_server_id
           AND public.can_manage_channel_webhooks(w.channel_id)
    ), '[]'::jsonb);
END;
$$;

COMMENT ON FUNCTION public.list_server_webhooks(uuid) IS
    'Webhooks of a server''s channels whose webhooks the caller manages.';

REVOKE ALL ON FUNCTION public.list_server_webhooks(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_server_webhooks(uuid) TO authenticated, service_role;

-- The webhook's channel after the manager check, locking the row.
CREATE OR REPLACE FUNCTION public.lock_managed_channel_webhook(p_id uuid)
RETURNS public.channel_webhooks
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_hook public.channel_webhooks;
BEGIN
    IF public.get_current_profile_id() IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_hook FROM public.channel_webhooks WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Webhook not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.can_manage_channel_webhooks(v_hook.channel_id) THEN
        RAISE EXCEPTION 'Permission denied: MANAGE_WEBHOOKS required' USING ERRCODE = '42501';
    END IF;
    RETURN v_hook;
END;
$$;

REVOKE ALL ON FUNCTION public.lock_managed_channel_webhook(uuid) FROM PUBLIC, anon, authenticated;

-- NULL leaves a field unchanged; a blank avatar URL clears the avatar.
CREATE OR REPLACE FUNCTION public.update_channel_webhook(
    p_id uuid,
    p_name text DEFAULT NULL,
    p_avatar_url text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_hook public.channel_webhooks := public.lock_managed_channel_webhook(p_id);
    v_name text := v_hook.name;
    v_avatar text := v_hook.avatar_url;
BEGIN
    IF p_name IS NOT NULL THEN
        v_name := public.webhook_normalize_name(p_name);
    END IF;
    IF p_avatar_url IS NOT NULL THEN
        v_avatar := public.webhook_normalize_avatar_url(p_avatar_url);
    END IF;

    UPDATE public.channel_webhooks SET name = v_name, avatar_url = v_avatar WHERE id = p_id;
    UPDATE public.bots
       SET display_name = v_name, avatar_url = COALESCE(v_avatar, '/default_avatar.webp')
     WHERE id = v_hook.bot_id;

    RETURN public.channel_webhook_json(p_id);
END;
$$;

COMMENT ON FUNCTION public.update_channel_webhook(uuid, text, text) IS
    'Rename a channel webhook or change its avatar.';

REVOKE ALL ON FUNCTION public.update_channel_webhook(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_channel_webhook(uuid, text, text) TO authenticated, service_role;

-- The previous token stops working; the new one is returned once.
CREATE OR REPLACE FUNCTION public.regenerate_channel_webhook_token(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_hook public.channel_webhooks := public.lock_managed_channel_webhook(p_id);
    v_token text := encode(extensions.gen_random_bytes(32), 'hex');
BEGIN
    UPDATE public.channel_webhooks
       SET token_hash = encode(extensions.digest(convert_to(v_token, 'UTF8'), 'sha256'), 'hex'),
           token_hint = right(v_token, 4)
     WHERE id = v_hook.id;

    RETURN public.channel_webhook_json(v_hook.id) || jsonb_build_object('token', v_token);
END;
$$;

COMMENT ON FUNCTION public.regenerate_channel_webhook_token(uuid) IS
    'Replace a channel webhook''s token; the new token is returned once.';

REVOKE ALL ON FUNCTION public.regenerate_channel_webhook_token(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.regenerate_channel_webhook_token(uuid) TO authenticated, service_role;

-- sync_channel_webhook_bot deactivates the bot; its messages stay.
CREATE OR REPLACE FUNCTION public.delete_channel_webhook(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_hook public.channel_webhooks := public.lock_managed_channel_webhook(p_id);
BEGIN
    DELETE FROM public.channel_webhooks WHERE id = v_hook.id;
    RETURN true;
END;
$$;

COMMENT ON FUNCTION public.delete_channel_webhook(uuid) IS
    'Delete a channel webhook; its messages stay.';

REVOKE ALL ON FUNCTION public.delete_channel_webhook(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_channel_webhook(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Execution
-- ---------------------------------------------------------------------------

-- p_token_hash: SHA-256 hex of the URL token. p_username and p_avatar_url override the
-- webhook's name and avatar for this message; blank keeps them. Returns {id, channel_id,
-- created_at, name, avatar_url, content}, or NULL when AutoMod drops the message.
CREATE OR REPLACE FUNCTION public.execute_channel_webhook(
    p_webhook_id uuid,
    p_token_hash text,
    p_content text,
    p_username text DEFAULT NULL,
    p_avatar_url text DEFAULT NULL,
    p_suppress_embeds boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_hook public.channel_webhooks;
    v_name text;
    v_avatar text;
    v_parts jsonb;
    v_metadata jsonb;
    v_id uuid;
    v_created timestamptz;
BEGIN
    SELECT * INTO v_hook FROM public.channel_webhooks WHERE id = p_webhook_id;
    IF NOT FOUND OR NOT v_hook.is_active OR p_token_hash IS NULL
       OR v_hook.token_hash IS DISTINCT FROM lower(p_token_hash) THEN
        RAISE EXCEPTION 'WEBHOOK_UNAUTHORIZED: invalid webhook token' USING ERRCODE = '28000';
    END IF;

    PERFORM public.assert_webhook_channel(v_hook.channel_id);

    v_name := CASE WHEN NULLIF(btrim(p_username), '') IS NULL THEN v_hook.name
                   ELSE public.webhook_normalize_name(p_username) END;
    v_avatar := COALESCE(public.webhook_normalize_avatar_url(p_avatar_url), v_hook.avatar_url);

    IF p_content IS NULL OR p_content !~ '[^[:space:]]' THEN
        RAISE EXCEPTION 'WEBHOOK_EMPTY_MESSAGE: a webhook message needs text' USING ERRCODE = '22023';
    END IF;
    IF char_length(p_content) > 50000 THEN
        RAISE EXCEPTION 'WEBHOOK_CONTENT_TOO_LONG: text exceeds 50000 characters' USING ERRCODE = '22001';
    END IF;
    v_parts := public.webhook_message_parts(p_content);
    IF public.jsonb_text_content_length(v_parts)
       > public.get_instance_config_int('max_message_length', 2000, 50000) THEN
        RAISE EXCEPTION 'WEBHOOK_CONTENT_TOO_LONG: text exceeds the instance limit of % characters',
            public.get_instance_config_int('max_message_length', 2000, 50000)
            USING ERRCODE = '22001';
    END IF;

    v_metadata := jsonb_build_object(
        'bot', true,
        'created_via', 'webhook',
        'webhook', jsonb_build_object('id', v_hook.id, 'name', v_name, 'avatar_url', v_avatar));
    IF p_suppress_embeds IS TRUE THEN
        v_metadata := v_metadata || jsonb_build_object('suppress_embeds', true);
    END IF;

    INSERT INTO public.messages (channel_id, bot_id, content, metadata)
    VALUES (v_hook.channel_id, v_hook.bot_id, v_parts, v_metadata)
    RETURNING id, created_at INTO v_id, v_created;

    IF v_id IS NULL THEN
        RETURN NULL;
    END IF;

    UPDATE public.channel_webhooks
       SET last_used_at = now(), use_count = use_count + 1
     WHERE id = v_hook.id;

    RETURN jsonb_build_object('id', v_id, 'channel_id', v_hook.channel_id, 'created_at', v_created,
                              'name', v_name, 'avatar_url', v_avatar, 'content', v_parts);
END;
$$;

COMMENT ON FUNCTION public.execute_channel_webhook(uuid, text, text, text, text, boolean) IS
    'Post a webhook message; service_role only (federation backend).';

REVOKE ALL ON FUNCTION public.execute_channel_webhook(uuid, text, text, text, text, boolean)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.execute_channel_webhook(uuid, text, text, text, text, boolean)
    TO service_role;

-- ---------------------------------------------------------------------------
-- Reserved metadata
-- ---------------------------------------------------------------------------

-- As 20261010200001, plus 'webhook' among the reserved keys.
CREATE OR REPLACE FUNCTION public.guard_message_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_reserved CONSTANT text[] := ARRAY[
        'type', 'federated', 'ap_id', 'from_domain', 'original_url', 'published',
        'conversation', 'in_reply_to_ap', 'pending_thread_ap_id', 'federated_at',
        'federated_to', 'embeds', 'bot', 'discord_user', 'discord_message_id', 'automod',
        'suppress_embeds', 'webhook'];
    v_new_meta jsonb;
    v_old_meta jsonb;
    v_key text;
    v_caller uuid;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    v_new_meta := CASE WHEN jsonb_typeof(NEW.metadata) = 'object' THEN NEW.metadata ELSE '{}'::jsonb END;

    IF TG_OP = 'INSERT' THEN
        IF NEW.is_system IS TRUE THEN
            RAISE EXCEPTION 'SYSTEM_MESSAGE_FORBIDDEN: system messages are server-generated'
                USING ERRCODE = '42501';
        END IF;
        IF NEW.bot_id IS NOT NULL THEN
            RAISE EXCEPTION 'bot_id is set by the bot API' USING ERRCODE = '42501';
        END IF;
        IF NEW.is_pinned IS TRUE OR NEW.pinned_at IS NOT NULL OR NEW.pinned_by IS NOT NULL THEN
            RAISE EXCEPTION 'pin fields are set by the server' USING ERRCODE = '42501';
        END IF;
        IF NEW.federation_status IS NOT NULL AND NEW.federation_status <> 'pending' THEN
            RAISE EXCEPTION 'federation_status is set by the server' USING ERRCODE = '42501';
        END IF;
        IF v_new_meta ?| v_reserved THEN
            RAISE EXCEPTION 'metadata key reserved for the server: %',
                (SELECT string_agg(k, ', ') FROM unnest(v_reserved) k WHERE v_new_meta ? k)
                USING ERRCODE = '42501';
        END IF;
        NEW.created_at := now();
        RETURN NEW;
    END IF;

    IF NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.bot_id IS DISTINCT FROM OLD.bot_id
       OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
       OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
       OR NEW.thread_id IS DISTINCT FROM OLD.thread_id
       OR NEW.reply_to IS DISTINCT FROM OLD.reply_to
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.is_system IS DISTINCT FROM OLD.is_system
       OR NEW.federation_status IS DISTINCT FROM OLD.federation_status
       OR NEW.is_pinned IS DISTINCT FROM OLD.is_pinned
       OR NEW.pinned_at IS DISTINCT FROM OLD.pinned_at
       OR NEW.pinned_by IS DISTINCT FROM OLD.pinned_by THEN
        RAISE EXCEPTION 'message author, placement, system, pin and federation fields are fixed'
            USING ERRCODE = '42501';
    END IF;

    v_old_meta := CASE WHEN jsonb_typeof(OLD.metadata) = 'object' THEN OLD.metadata ELSE '{}'::jsonb END;
    FOREACH v_key IN ARRAY v_reserved LOOP
        IF v_new_meta -> v_key IS DISTINCT FROM v_old_meta -> v_key THEN
            RAISE EXCEPTION 'metadata key reserved for the server: %', v_key USING ERRCODE = '42501';
        END IF;
    END LOOP;

    IF OLD.is_deleted IS TRUE
       AND (NEW.is_deleted IS NOT TRUE OR NEW.content IS DISTINCT FROM OLD.content) THEN
        RAISE EXCEPTION 'MESSAGE_DELETED: a deleted message cannot be restored or edited'
            USING ERRCODE = '42501';
    END IF;

    v_caller := public.get_current_profile_id();
    IF OLD.is_system IS TRUE OR OLD.user_id IS DISTINCT FROM v_caller THEN
        IF NOT (OLD.is_deleted IS NOT TRUE AND NEW.is_deleted IS TRUE)
           OR NEW.metadata IS DISTINCT FROM OLD.metadata
           OR NEW.encrypted IS DISTINCT FROM OLD.encrypted
           OR NEW.encryption_metadata IS DISTINCT FROM OLD.encryption_metadata
           OR NEW.megolm_session_id IS DISTINCT FROM OLD.megolm_session_id
           OR NEW.megolm_message_index IS DISTINCT FROM OLD.megolm_message_index THEN
            RAISE EXCEPTION 'only the author edits a message; others may soft-delete it'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    IF NEW.content IS NOT DISTINCT FROM OLD.content THEN
        NEW.updated_at := OLD.updated_at;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_message_client_write() FROM PUBLIC, anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
