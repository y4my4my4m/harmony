-- Bot slash commands: a bot registers commands through the gateway, a member invokes one in a
-- server channel or thread, the gateway delivers it as INTERACTION_CREATE and the bot answers.
--
-- bot_commands
--   The gateway (service role) is the only writer. The bot's owner reads its rows; members read
--   slash rows through get_channel_bot_commands; anon reads nothing. required_permissions is a
--   mask in permission_bit_names() order, 0 = everyone. A text[] column left by an older lineage
--   becomes that mask. PUT /commands replaces rows of every command_type; lists and invocation
--   read command_type 'slash'.
--
-- bot_interactions, one row per invocation
--   pending -> delivered (claim) -> deferred | responding | responded (ack)
--   responding -> responded (message recorded) | failed (insert refused)
--   failed: error 'offline', 'bot_cannot_post', 'automod_blocked', 'thread_locked' or 'failed'
--   expired: unacknowledged past respond_by (created_at + 5 s)
--   expires_at (created_at + 15 min) bounds edits and follow-ups. replies holds the private
--   original at index 0 once posted, then private follow-ups; followup_count <= 10.
--   Rows go 24 h past expires_at (purge_bot_interactions, pg_cron, and on invoke and claim).
--   A refused ack rolls back with its error, so a late ack leaves the row to the next claim,
--   which expires delivered rows past respond_by.
--
-- bot_channel_access(bot, channel) -> 'none' | 'view' | 'post'
--   Mirrors botCanSeeChannel and botCanWriteChannel(..., 'send_messages') with loadEveryoneLayer
--   in bot-gateway/src/auth/botPermissions.ts, plus bots.is_active and the install's is_active.
--
-- Member checks (get_channel_bot_commands, invoke_bot_command): a text channel (type 0) of a
-- local server, accepted membership or ownership, VIEW_CHANNEL, not channel_messages_encrypted,
-- a thread of that channel not locked (archived ones take messages), SEND_MESSAGES (SEND_MESSAGES_IN_THREADS
-- in a thread), the command's mask, all per get_user_permissions. Invocation adds timeouts as
-- automod_check_message, slowmode as enforce_channel_slowmode counting invocations with messages,
-- option values against the stored options, 5 invocations per 10 s per account, and a bot
-- online by src/utils/botUtils.ts botMemberStatus (status online, idle or dnd, heartbeat within
-- 90 s). Refusals are P0001 'BOT_COMMAND_*'.
--
-- Option values: STRING at most 6000 characters (Discord's limit); INTEGER and NUMBER within
-- +-2^53; an empty string is no value. USER an accepted member or the owner, CHANNEL a channel
-- of the server the caller views, ROLE a role of the server.
--
-- Push: AFTER UPDATE of status, replies or error, user_event 'bot_interaction:update' on
-- user:<invoker>.
--
-- Messages: metadata.interaction is reserved in guard_message_client_write. automod_check_message
-- judges a bot row whose metadata.interaction.user_id names a profile as that profile's message:
-- timeouts, role exemptions, rules and antispam_check_local_author's new-account link limit.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- bot_commands
-- ---------------------------------------------------------------------------

ALTER TABLE public.bot_commands
    ADD COLUMN IF NOT EXISTS options jsonb DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS command_type text DEFAULT 'prefix'::text,
    ADD COLUMN IF NOT EXISTS usage_count integer DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_used_at timestamptz,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

DO $$
DECLARE
    v_type regtype;
BEGIN
    SELECT a.atttypid::regtype INTO v_type
      FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = 'public.bot_commands'::regclass
       AND a.attname = 'required_permissions'
       AND a.attnum > 0
       AND NOT a.attisdropped;
    IF v_type IS NULL THEN
        ALTER TABLE public.bot_commands ADD COLUMN required_permissions bigint DEFAULT 0;
    ELSIF v_type <> 'bigint'::regtype THEN
        ALTER TABLE public.bot_commands ADD COLUMN IF NOT EXISTS required_permissions_mask bigint DEFAULT 0;
        IF v_type = 'text[]'::regtype THEN
            EXECUTE $q$
                UPDATE public.bot_commands bc
                   SET required_permissions_mask = COALESCE((
                       SELECT bit_or(1::bigint << (array_position(public.permission_bit_names(), upper(n)) - 1))
                         FROM unnest(bc.required_permissions) n
                        WHERE array_position(public.permission_bit_names(), upper(n)) IS NOT NULL), 0)$q$;
        END IF;
        ALTER TABLE public.bot_commands DROP COLUMN required_permissions;
        ALTER TABLE public.bot_commands RENAME COLUMN required_permissions_mask TO required_permissions;
        RAISE NOTICE 'bot_commands.required_permissions: % converted to a bigint mask', v_type;
    END IF;
END;
$$;

ALTER TABLE public.bot_commands ALTER COLUMN required_permissions SET DEFAULT 0;

-- ON CONFLICT (bot_id, name) target.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_index i
         WHERE i.indrelid = 'public.bot_commands'::regclass
           AND i.indisunique
           AND i.indpred IS NULL
           AND i.indnkeyatts = 2
           AND ARRAY(SELECT a.attname::text FROM pg_catalog.pg_attribute a
                      WHERE a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
                      ORDER BY a.attname) = ARRAY['bot_id', 'name']
    ) THEN
        ALTER TABLE public.bot_commands ADD CONSTRAINT bot_commands_bot_id_name_key UNIQUE (bot_id, name);
        RAISE NOTICE 'bot_commands: unique (bot_id, name) added';
    END IF;
END;
$$;

ALTER TABLE public.bot_commands ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    v_policy name;
BEGIN
    FOR v_policy IN
        SELECT p.polname FROM pg_catalog.pg_policy p
         WHERE p.polrelid = 'public.bot_commands'::regclass
           AND p.polname NOT IN ('bot_commands_select_owner', 'bot_commands_service_role')
    LOOP
        EXECUTE format('DROP POLICY %I ON public.bot_commands', v_policy);
        RAISE NOTICE 'bot_commands: policy % dropped', v_policy;
    END LOOP;
END;
$$;

DROP POLICY IF EXISTS bot_commands_select_owner ON public.bot_commands;
CREATE POLICY bot_commands_select_owner ON public.bot_commands
    AS PERMISSIVE FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.bots b
                    WHERE b.id = bot_commands.bot_id
                      AND b.owner_id = (SELECT public.get_current_profile_id())));
DROP POLICY IF EXISTS bot_commands_service_role ON public.bot_commands;
CREATE POLICY bot_commands_service_role ON public.bot_commands
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.bot_commands FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.bot_commands TO authenticated;
GRANT ALL ON public.bot_commands TO service_role;

-- ---------------------------------------------------------------------------
-- bot_interactions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.bot_interactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    bot_id uuid NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
    command_id uuid REFERENCES public.bot_commands(id) ON DELETE SET NULL,
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    channel_id uuid NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
    thread_id uuid REFERENCES public.threads(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    command_name text NOT NULL,
    data jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'pending',
    error text,
    acknowledged_at timestamptz,
    ephemeral boolean NOT NULL DEFAULT false,
    response_message_id uuid,
    replies jsonb NOT NULL DEFAULT '[]'::jsonb,
    followup_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    respond_by timestamptz NOT NULL DEFAULT now() + interval '5 seconds',
    expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
    CONSTRAINT bot_interactions_status_check
        CHECK (status IN ('pending', 'delivered', 'deferred', 'responding', 'responded', 'failed', 'expired')),
    CONSTRAINT bot_interactions_error_check
        CHECK (error IS NULL OR error IN ('offline', 'bot_cannot_post', 'automod_blocked', 'thread_locked', 'failed')),
    CONSTRAINT bot_interactions_replies_check
        CHECK (jsonb_typeof(replies) = 'array' AND jsonb_array_length(replies) <= 11),
    CONSTRAINT bot_interactions_followup_count_check CHECK (followup_count BETWEEN 0 AND 10),
    CONSTRAINT bot_interactions_command_name_length CHECK (char_length(command_name) <= 100)
);

CREATE INDEX IF NOT EXISTS idx_bot_interactions_user_created ON public.bot_interactions (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bot_interactions_status_created ON public.bot_interactions (status, created_at);
CREATE INDEX IF NOT EXISTS idx_bot_interactions_channel_user ON public.bot_interactions (channel_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bot_interactions_bot ON public.bot_interactions (bot_id);
CREATE INDEX IF NOT EXISTS idx_bot_interactions_expires ON public.bot_interactions (expires_at);
CREATE INDEX IF NOT EXISTS idx_bot_interactions_command ON public.bot_interactions (command_id)
    WHERE command_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bot_interactions_thread ON public.bot_interactions (thread_id)
    WHERE thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bot_interactions_server ON public.bot_interactions (server_id);

COMMENT ON TABLE public.bot_interactions IS
    'One slash command invocation and its answer. Written by definer functions only; the invoker reads own rows.';

ALTER TABLE public.bot_interactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bot_interactions_select_own ON public.bot_interactions;
CREATE POLICY bot_interactions_select_own ON public.bot_interactions
    AS PERMISSIVE FOR SELECT TO authenticated
    USING (user_id = (SELECT public.get_current_profile_id()));
DROP POLICY IF EXISTS bot_interactions_service_role ON public.bot_interactions;
CREATE POLICY bot_interactions_service_role ON public.bot_interactions
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.bot_interactions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.bot_interactions TO authenticated;
GRANT ALL ON public.bot_interactions TO service_role;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Names in permission_bit_names() to a mask; index i is bit i - 1. Case-insensitive.
CREATE OR REPLACE FUNCTION public.bot_permission_mask(p_names jsonb)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bits text[] := public.permission_bit_names();
    v_mask bigint := 0;
    v_name jsonb;
    v_pos integer;
BEGIN
    IF p_names IS NULL OR jsonb_typeof(p_names) = 'null' THEN
        RETURN 0;
    END IF;
    IF jsonb_typeof(p_names) <> 'array' THEN
        RAISE EXCEPTION 'BOT_COMMAND_UNKNOWN_PERMISSION:%', p_names #>> '{}' USING ERRCODE = 'P0001';
    END IF;
    FOR v_name IN SELECT e FROM jsonb_array_elements(p_names) e LOOP
        v_pos := CASE WHEN jsonb_typeof(v_name) = 'string'
                      THEN array_position(v_bits, upper(v_name #>> '{}')) END;
        IF v_pos IS NULL THEN
            RAISE EXCEPTION 'BOT_COMMAND_UNKNOWN_PERMISSION:%', v_name #>> '{}' USING ERRCODE = 'P0001';
        END IF;
        v_mask := v_mask | (1::bigint << (v_pos - 1));
    END LOOP;
    RETURN v_mask;
END;
$$;

CREATE OR REPLACE FUNCTION public.bot_permission_names(p_mask bigint)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(jsonb_agg(t.n ORDER BY t.i), '[]'::jsonb)
      FROM unnest(public.permission_bit_names()) WITH ORDINALITY AS t(n, i)
     WHERE (COALESCE(p_mask, 0) & (1::bigint << (t.i::integer - 1))) <> 0
$$;

-- Mirrors INSTALL_FLAG_BITS and installMask in bot-gateway/src/auth/botPermissions.ts. A flag
-- column the row lacks reads as false.
CREATE OR REPLACE FUNCTION public.bot_install_mask(p_install jsonb)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(bit_or(public.bot_permission_mask(f.bits)), 0)
      FROM jsonb_each('{
              "read_messages": ["VIEW_CHANNEL", "READ_MESSAGE_HISTORY"],
              "view_channels": ["VIEW_CHANNEL"],
              "read_message_history": ["READ_MESSAGE_HISTORY"],
              "send_messages": ["SEND_MESSAGES"],
              "manage_messages": ["MANAGE_MESSAGES"],
              "embed_links": ["EMBED_LINKS"],
              "attach_files": ["ATTACH_FILES"],
              "mention_everyone": ["MENTION_EVERYONE"],
              "use_external_emojis": ["USE_EXTERNAL_EMOJIS"],
              "add_reactions": ["ADD_REACTIONS"],
              "manage_channels": ["MANAGE_CHANNELS"],
              "manage_roles": ["MANAGE_ROLES"],
              "manage_webhooks": ["MANAGE_WEBHOOKS"],
              "create_instant_invite": ["CREATE_INVITE"],
              "kick_members": ["KICK_MEMBERS"],
              "ban_members": ["BAN_MEMBERS"],
              "connect_voice": ["CONNECT"],
              "speak": ["SPEAK"],
              "mute_members": ["MUTE_MEMBERS"],
              "deafen_members": ["DEAFEN_MEMBERS"],
              "move_members": ["MOVE_MEMBERS"]
           }'::jsonb) AS f(flag, bits)
     WHERE p_install -> f.flag = 'true'::jsonb
$$;

CREATE OR REPLACE FUNCTION public.bot_command_number(p_value jsonb)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE WHEN jsonb_typeof(p_value) = 'number' THEN (p_value #>> '{}')::numeric END
$$;

-- Milliseconds from now() to p_at, never negative.
CREATE OR REPLACE FUNCTION public.bot_interaction_ms(p_at timestamptz)
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT GREATEST(0, floor(extract(epoch FROM (p_at - now())) * 1000))::bigint
$$;

CREATE OR REPLACE FUNCTION public.bot_interaction_error(p_error text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE WHEN p_error IN ('offline', 'bot_cannot_post', 'automod_blocked', 'thread_locked')
                THEN p_error ELSE 'failed' END
$$;

-- Message parts of a reply: the array itself, or the content array of an object. Text over
-- max_message_length (enforce_message_length's limit) raises INTERACTION_REPLY_TOO_LONG:<limit>.
CREATE OR REPLACE FUNCTION public.bot_interaction_content(p_reply jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_parts jsonb := CASE WHEN jsonb_typeof(p_reply) = 'array' THEN p_reply
                          WHEN jsonb_typeof(p_reply) = 'object' AND jsonb_typeof(p_reply -> 'content') = 'array'
                          THEN p_reply -> 'content'
                          ELSE '[]'::jsonb END;
    v_limit integer := public.get_instance_config_int('max_message_length', 2000, 50000);
BEGIN
    IF public.jsonb_text_content_length(v_parts) > v_limit THEN
        RAISE EXCEPTION 'INTERACTION_REPLY_TOO_LONG:%', v_limit USING ERRCODE = 'P0001';
    END IF;
    RETURN v_parts;
END;
$$;

CREATE OR REPLACE FUNCTION public.bot_command_json(p_command public.bot_commands)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'id', p_command.id,
        'name', p_command.name,
        'description', p_command.description,
        'options', COALESCE(p_command.options, '[]'::jsonb),
        'required_permissions', public.bot_permission_names(p_command.required_permissions),
        'created_at', p_command.created_at,
        'updated_at', p_command.updated_at)
$$;

-- Mirrors botCanSeeChannel and botCanWriteChannel(install, layer, channel, 'send_messages') in
-- bot-gateway/src/auth/botPermissions.ts. The install row is read through to_jsonb, so a flag
-- column a lineage lacks reads as false and a missing allowed_channel_ids as unrestricted.
CREATE OR REPLACE FUNCTION public.bot_channel_access(p_bot_id uuid, p_channel_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server_id uuid;
    v_install jsonb;
    v_ids jsonb;
    v_listed boolean;
    v_everyone uuid;
    v_permissions bigint;
    v_allow bigint;
    v_deny bigint;
    v_base bigint;
    v_mask bigint;
BEGIN
    SELECT c.server_id INTO v_server_id FROM public.channels c WHERE c.id = p_channel_id;
    IF v_server_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.bots b WHERE b.id = p_bot_id AND b.is_active IS TRUE) THEN
        RETURN 'none';
    END IF;

    SELECT to_jsonb(i) INTO v_install
      FROM public.bot_server_permissions i
     WHERE i.bot_id = p_bot_id AND i.server_id = v_server_id AND i.is_active IS TRUE
     LIMIT 1;
    IF v_install IS NULL THEN
        RETURN 'none';
    END IF;

    -- installAllowsChannel / installGrantsChannel.
    v_ids := v_install -> 'allowed_channel_ids';
    v_listed := jsonb_typeof(v_ids) = 'array' AND v_ids @> jsonb_build_array(p_channel_id::text);
    IF v_ids IS NOT NULL AND jsonb_typeof(v_ids) <> 'null' AND NOT v_listed THEN
        RETURN 'none';
    END IF;

    -- loadEveryoneLayer: no @everyone row is a zero layer.
    SELECT r.id, r.permissions INTO v_everyone, v_permissions
      FROM public.server_roles r
     WHERE r.server_id = v_server_id AND r.is_default = true
     LIMIT 1;
    IF v_everyone IS NOT NULL THEN
        SELECT bit_or(COALESCE(o.allow_permissions, 0)), bit_or(COALESCE(o.deny_permissions, 0))
          INTO v_allow, v_deny
          FROM public.channel_permission_overrides o
         WHERE o.channel_id = p_channel_id AND o.role_id = v_everyone AND o.user_id IS NULL;
    END IF;
    v_permissions := COALESCE(v_permissions, 0);
    v_allow := COALESCE(v_allow, 0);
    v_deny := COALESCE(v_deny, 0);

    -- botChannelMask. ADMINISTRATOR is bit 0.
    v_base := v_permissions | public.bot_install_mask(v_install);
    v_mask := CASE WHEN (v_base & 1) <> 0 THEN -1 ELSE (v_base & ~v_deny) | v_allow END;

    -- VIEW_CHANNEL is bit 1, SEND_MESSAGES bit 12.
    IF NOT v_listed AND (v_mask & 2) = 0 THEN
        RETURN 'none';
    END IF;
    IF v_install -> 'send_messages' = 'true'::jsonb AND (v_listed OR (v_mask & 4096) <> 0) THEN
        RETURN 'post';
    END IF;
    RETURN 'view';
END;
$$;

-- The caller's standing for commands in a channel or thread. o_error is the refusal code, NULL
-- when every member check passes; o_mask holds get_user_permissions in the channel.
CREATE OR REPLACE FUNCTION public.bot_command_caller_state(
    p_user_id uuid, p_channel_id uuid, p_thread_id uuid,
    OUT o_error text, OUT o_server_id uuid, OUT o_mask bigint, OUT o_slowmode integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bits text[] := public.permission_bit_names();
    v_type smallint;
    v_local boolean;
    v_owner uuid;
    v_perms jsonb;
    v_thread_channel uuid;
    v_locked boolean;
    v_i integer;
BEGIN
    o_mask := 0;
    SELECT c.server_id, c.type, COALESCE(c.slowmode_seconds, 0), s.is_local_server, s.owner
      INTO o_server_id, v_type, o_slowmode, v_local, v_owner
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id
     WHERE c.id = p_channel_id;
    IF NOT FOUND OR v_type IS DISTINCT FROM 0 THEN
        o_error := 'BOT_COMMAND_UNAVAILABLE';
        RETURN;
    END IF;

    IF p_user_id IS NULL
       OR (v_owner IS DISTINCT FROM p_user_id AND NOT EXISTS (
               SELECT 1 FROM public.user_servers us
                WHERE us.user_id = p_user_id AND us.server_id = o_server_id AND us.status = 'accepted')) THEN
        o_error := 'BOT_COMMAND_FORBIDDEN';
        RETURN;
    END IF;

    v_perms := public.get_user_permissions(p_user_id, o_server_id, p_channel_id);
    FOR v_i IN 1..array_length(v_bits, 1) LOOP
        IF v_perms -> v_bits[v_i] = 'true'::jsonb THEN
            o_mask := o_mask | (1::bigint << (v_i - 1));
        END IF;
    END LOOP;

    IF v_perms -> 'VIEW_CHANNEL' IS DISTINCT FROM 'true'::jsonb THEN
        o_error := 'BOT_COMMAND_FORBIDDEN';
        RETURN;
    END IF;
    IF v_local IS NOT TRUE OR public.channel_messages_encrypted(p_channel_id) THEN
        o_error := 'BOT_COMMAND_UNAVAILABLE';
        RETURN;
    END IF;

    IF p_thread_id IS NOT NULL THEN
        SELECT t.channel_id, t.locked INTO v_thread_channel, v_locked
          FROM public.threads t WHERE t.id = p_thread_id;
        IF v_thread_channel IS DISTINCT FROM p_channel_id THEN
            o_error := 'BOT_COMMAND_UNAVAILABLE';
            RETURN;
        END IF;
        IF v_locked IS TRUE THEN
            o_error := 'BOT_COMMAND_THREAD_LOCKED';
            RETURN;
        END IF;
        IF v_perms -> 'SEND_MESSAGES_IN_THREADS' IS DISTINCT FROM 'true'::jsonb THEN
            o_error := 'BOT_COMMAND_FORBIDDEN';
            RETURN;
        END IF;
    ELSIF v_perms -> 'SEND_MESSAGES' IS DISTINCT FROM 'true'::jsonb THEN
        o_error := 'BOT_COMMAND_FORBIDDEN';
        RETURN;
    END IF;
END;
$$;

-- Validates p_values against the stored options of the path's leaf and returns data.options,
-- nested under the subcommand and group as Discord sends them.
CREATE OR REPLACE FUNCTION public.bot_command_options(
    p_defs jsonb, p_path text[], p_values jsonb, p_server_id uuid, p_user_id uuid, p_command_name text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_defs jsonb := CASE WHEN jsonb_typeof(p_defs) = 'array' THEN p_defs ELSE '[]'::jsonb END;
    v_path text[] := COALESCE(p_path, '{}'::text[]);
    v_values jsonb := COALESCE(p_values, '{}'::jsonb);
    v_group jsonb;
    v_sub jsonb;
    v_leaf jsonb;
    v_def jsonb;
    v_key text;
    v_name text;
    v_type text;
    v_value jsonb;
    v_choices jsonb;
    v_num numeric;
    v_text text;
    v_id uuid;
    v_out jsonb := '[]'::jsonb;
BEGIN
    IF jsonb_typeof(v_values) = 'null' THEN
        v_values := '{}'::jsonb;
    END IF;
    IF jsonb_typeof(v_values) <> 'object' THEN
        RAISE EXCEPTION 'BOT_COMMAND_INVALID_OPTION' USING ERRCODE = 'P0001';
    END IF;

    -- Option types: 1 SUB_COMMAND, 2 SUB_COMMAND_GROUP, 3 STRING, 4 INTEGER, 5 BOOLEAN, 6 USER,
    -- 7 CHANNEL, 8 ROLE, 10 NUMBER.
    IF cardinality(v_path) = 0 THEN
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_defs) d WHERE d ->> 'type' IN ('1', '2')) THEN
            RAISE EXCEPTION 'BOT_COMMAND_INVALID_OPTION:%', p_command_name USING ERRCODE = 'P0001';
        END IF;
        v_leaf := v_defs;
    ELSIF cardinality(v_path) = 1 THEN
        SELECT d INTO v_sub FROM jsonb_array_elements(v_defs) d
         WHERE d ->> 'type' = '1' AND d ->> 'name' = v_path[1]
         LIMIT 1;
        IF v_sub IS NULL THEN
            RAISE EXCEPTION 'BOT_COMMAND_INVALID_OPTION:%', v_path[1] USING ERRCODE = 'P0001';
        END IF;
        v_leaf := v_sub -> 'options';
    ELSIF cardinality(v_path) = 2 THEN
        SELECT d INTO v_group FROM jsonb_array_elements(v_defs) d
         WHERE d ->> 'type' = '2' AND d ->> 'name' = v_path[1]
         LIMIT 1;
        IF v_group IS NULL THEN
            RAISE EXCEPTION 'BOT_COMMAND_INVALID_OPTION:%', v_path[1] USING ERRCODE = 'P0001';
        END IF;
        SELECT d INTO v_sub
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_group -> 'options') = 'array'
                                         THEN v_group -> 'options' ELSE '[]'::jsonb END) d
         WHERE d ->> 'type' = '1' AND d ->> 'name' = v_path[2]
         LIMIT 1;
        IF v_sub IS NULL THEN
            RAISE EXCEPTION 'BOT_COMMAND_INVALID_OPTION:%', v_path[2] USING ERRCODE = 'P0001';
        END IF;
        v_leaf := v_sub -> 'options';
    ELSE
        RAISE EXCEPTION 'BOT_COMMAND_INVALID_OPTION:%', v_path[3] USING ERRCODE = 'P0001';
    END IF;
    v_leaf := CASE WHEN jsonb_typeof(v_leaf) = 'array' THEN v_leaf ELSE '[]'::jsonb END;

    FOR v_key IN SELECT k FROM jsonb_object_keys(v_values) k LOOP
        IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_leaf) d
                        WHERE d ->> 'name' = v_key AND d ->> 'type' NOT IN ('1', '2')) THEN
            RAISE EXCEPTION 'BOT_COMMAND_INVALID_OPTION:%', v_key USING ERRCODE = 'P0001';
        END IF;
    END LOOP;

    FOR v_def IN SELECT d FROM jsonb_array_elements(v_leaf) d LOOP
        v_name := v_def ->> 'name';
        v_type := v_def ->> 'type';
        v_value := v_values -> v_name;
        IF v_value IS NULL OR jsonb_typeof(v_value) = 'null'
           OR (jsonb_typeof(v_value) = 'string' AND v_value #>> '{}' = '') THEN
            IF v_def -> 'required' = 'true'::jsonb THEN
                RAISE EXCEPTION 'BOT_COMMAND_INVALID_OPTION:%', v_name USING ERRCODE = 'P0001';
            END IF;
            CONTINUE;
        END IF;

        IF v_type = '3' THEN
            IF jsonb_typeof(v_value) <> 'string' THEN
                RAISE EXCEPTION 'BOT_COMMAND_INVALID_OPTION:%', v_name USING ERRCODE = 'P0001';
            END IF;
            v_text := v_value #>> '{}';
            IF char_length(v_text) > LEAST(COALESCE(public.bot_command_number(v_def -> 'max_length'), 6000), 6000)
               OR char_length(v_text) < COALESCE(public.bot_command_number(v_def -> 'min_length'), 0) THEN
                RAISE EXCEPTION 'BOT_COMMAND_INVALID_OPTION:%', v_name USING ERRCODE = 'P0001';
            END IF;
        ELSIF v_type IN ('4', '10') THEN
            v_num := public.bot_command_number(v_value);
            IF v_num IS NULL OR abs(v_num) > 9007199254740992
               OR (v_type = '4' AND v_num <> trunc(v_num))
               OR v_num < public.bot_command_number(v_def -> 'min_value')
               OR v_num > public.bot_command_number(v_def -> 'max_value') THEN
                RAISE EXCEPTION 'BOT_COMMAND_INVALID_OPTION:%', v_name USING ERRCODE = 'P0001';
            END IF;
            IF v_type = '4' THEN
                v_value := to_jsonb(v_num::bigint);
            END IF;
        ELSIF v_type = '5' THEN
            IF jsonb_typeof(v_value) <> 'boolean' THEN
                RAISE EXCEPTION 'BOT_COMMAND_INVALID_OPTION:%', v_name USING ERRCODE = 'P0001';
            END IF;
        ELSIF v_type IN ('6', '7', '8') THEN
            v_text := CASE WHEN jsonb_typeof(v_value) = 'string' THEN v_value #>> '{}' END;
            IF v_text IS NULL
               OR v_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                RAISE EXCEPTION 'BOT_COMMAND_INVALID_OPTION:%', v_name USING ERRCODE = 'P0001';
            END IF;
            v_id := v_text::uuid;
            IF (v_type = '6' AND NOT EXISTS (
                    SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.owner = v_id
                    UNION ALL
                    SELECT 1 FROM public.user_servers us
                     WHERE us.server_id = p_server_id AND us.user_id = v_id AND us.status = 'accepted'))
               OR (v_type = '7' AND NOT (
                    EXISTS (SELECT 1 FROM public.channels c WHERE c.id = v_id AND c.server_id = p_server_id)
                    AND public.can_view_channel(p_user_id, v_id)))
               OR (v_type = '8' AND NOT EXISTS (
                    SELECT 1 FROM public.server_roles r WHERE r.id = v_id AND r.server_id = p_server_id)) THEN
                RAISE EXCEPTION 'BOT_COMMAND_INVALID_OPTION:%', v_name USING ERRCODE = 'P0001';
            END IF;
            v_value := to_jsonb(v_id::text);
        ELSE
            RAISE EXCEPTION 'BOT_COMMAND_INVALID_OPTION:%', v_name USING ERRCODE = 'P0001';
        END IF;

        v_choices := v_def -> 'choices';
        IF v_type IN ('3', '4', '10') AND jsonb_typeof(v_choices) = 'array' AND jsonb_array_length(v_choices) > 0
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_choices) c WHERE c -> 'value' = v_value) THEN
            RAISE EXCEPTION 'BOT_COMMAND_INVALID_OPTION:%', v_name USING ERRCODE = 'P0001';
        END IF;

        v_out := v_out || jsonb_build_array(jsonb_build_object('name', v_name, 'type', v_type::integer, 'value', v_value));
    END LOOP;

    IF cardinality(v_path) = 1 THEN
        RETURN jsonb_build_array(jsonb_build_object('name', v_path[1], 'type', 1, 'options', v_out));
    ELSIF cardinality(v_path) = 2 THEN
        RETURN jsonb_build_array(jsonb_build_object(
            'name', v_path[1], 'type', 2,
            'options', jsonb_build_array(jsonb_build_object('name', v_path[2], 'type', 1, 'options', v_out))));
    END IF;
    RETURN v_out;
END;
$$;

-- data.resolved of a delivered interaction: a key per kind the option values use.
CREATE OR REPLACE FUNCTION public.bot_interaction_resolved(p_bot_id uuid, p_server_id uuid, p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_users uuid[];
    v_channels uuid[];
    v_roles uuid[];
    v_out jsonb := '{}'::jsonb;
BEGIN
    WITH RECURSIVE o(opt) AS (
        SELECT e FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_data -> 'options') = 'array'
                                                THEN p_data -> 'options' ELSE '[]'::jsonb END) e
        UNION ALL
        SELECT e FROM o, jsonb_array_elements(CASE WHEN jsonb_typeof(o.opt -> 'options') = 'array'
                                                   THEN o.opt -> 'options' ELSE '[]'::jsonb END) e
    )
    SELECT array_agg(DISTINCT (o.opt ->> 'value')::uuid) FILTER (WHERE o.opt ->> 'type' = '6'),
           array_agg(DISTINCT (o.opt ->> 'value')::uuid) FILTER (WHERE o.opt ->> 'type' = '7'),
           array_agg(DISTINCT (o.opt ->> 'value')::uuid) FILTER (WHERE o.opt ->> 'type' = '8')
      INTO v_users, v_channels, v_roles
      FROM o
     WHERE o.opt ->> 'type' IN ('6', '7', '8')
       AND (o.opt ->> 'value') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

    IF v_users IS NOT NULL THEN
        v_out := v_out || jsonb_build_object(
            'users', COALESCE((
                SELECT jsonb_object_agg(p.id::text, jsonb_build_object(
                           'id', p.id, 'username', p.username, 'display_name', p.display_name,
                           'avatar_url', p.avatar_url, 'bot', false))
                  FROM public.profiles p WHERE p.id = ANY (v_users)), '{}'::jsonb),
            'members', COALESCE((
                SELECT jsonb_object_agg(us.user_id::text, jsonb_build_object(
                           'nickname', us.nickname,
                           'roles', COALESCE((SELECT jsonb_agg(ur.role_id ORDER BY sr.position DESC, ur.role_id)
                                                FROM public.user_roles ur
                                                JOIN public.server_roles sr ON sr.id = ur.role_id
                                               WHERE ur.user_id = us.user_id AND ur.server_id = p_server_id
                                                 AND sr.is_default IS NOT TRUE), '[]'::jsonb)))
                  FROM public.user_servers us
                 WHERE us.server_id = p_server_id AND us.user_id = ANY (v_users) AND us.status = 'accepted'),
                '{}'::jsonb));
    END IF;
    IF v_channels IS NOT NULL THEN
        v_out := v_out || jsonb_build_object(
            'channels', COALESCE((
                SELECT jsonb_object_agg(c.id::text,
                           CASE WHEN public.bot_channel_access(p_bot_id, c.id) <> 'none'
                                THEN jsonb_strip_nulls(jsonb_build_object('id', c.id, 'name', c.name, 'type', c.type,
                                                                          'parent_id', c.category))
                                ELSE jsonb_build_object('id', c.id, 'type', c.type) END)
                  FROM public.channels c WHERE c.id = ANY (v_channels) AND c.server_id = p_server_id), '{}'::jsonb));
    END IF;
    IF v_roles IS NOT NULL THEN
        v_out := v_out || jsonb_build_object(
            'roles', COALESCE((
                SELECT jsonb_object_agg(r.id::text, jsonb_build_object(
                           'id', r.id, 'name', r.name, 'color', r.color, 'position', r.position))
                  FROM public.server_roles r WHERE r.id = ANY (v_roles) AND r.server_id = p_server_id), '{}'::jsonb));
    END IF;
    RETURN v_out;
END;
$$;

-- INTERACTION_CREATE body of a claimed row.
CREATE OR REPLACE FUNCTION public.bot_interaction_event(p_row public.bot_interactions)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_perms jsonb := public.get_user_permissions(p_row.user_id, p_row.server_id, p_row.channel_id);
BEGIN
    RETURN jsonb_build_object(
        'id', p_row.id,
        'bot_id', p_row.bot_id,
        'type', 2,
        'server_id', p_row.server_id,
        'channel_id', p_row.channel_id,
        'thread_id', p_row.thread_id,
        'user', (SELECT jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name,
                                           'avatar_url', p.avatar_url, 'bot', false)
                   FROM public.profiles p WHERE p.id = p_row.user_id),
        'member', jsonb_build_object(
            'nickname', (SELECT us.nickname FROM public.user_servers us
                          WHERE us.user_id = p_row.user_id AND us.server_id = p_row.server_id),
            'roles', COALESCE((SELECT jsonb_agg(ur.role_id ORDER BY sr.position DESC, ur.role_id)
                                 FROM public.user_roles ur
                                 JOIN public.server_roles sr ON sr.id = ur.role_id
                                WHERE ur.user_id = p_row.user_id AND ur.server_id = p_row.server_id
                                  AND sr.is_default IS NOT TRUE), '[]'::jsonb),
            'permissions', COALESCE((SELECT jsonb_agg(t.n ORDER BY t.i)
                                       FROM unnest(public.permission_bit_names()) WITH ORDINALITY AS t(n, i)
                                      WHERE v_perms -> t.n = 'true'::jsonb), '[]'::jsonb)),
        'data', COALESCE(p_row.data, '{}'::jsonb)
                || jsonb_build_object('resolved', public.bot_interaction_resolved(p_row.bot_id, p_row.server_id, p_row.data)),
        'created_at', p_row.created_at,
        'respond_by', p_row.respond_by,
        'expires_at', p_row.expires_at);
END;
$$;

-- Rows 24 h past expires_at, at most p_limit of them; NULL is no bound.
CREATE OR REPLACE FUNCTION public.purge_bot_interactions(p_limit integer DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_removed integer;
BEGIN
    DELETE FROM public.bot_interactions bi
     WHERE bi.id IN (SELECT x.id FROM public.bot_interactions x
                      WHERE x.expires_at < now() - interval '24 hours'
                      ORDER BY x.expires_at
                      LIMIT p_limit
                      FOR UPDATE SKIP LOCKED);
    GET DIAGNOSTICS v_removed = ROW_COUNT;
    RETURN v_removed;
END;
$$;

-- ---------------------------------------------------------------------------
-- Registration (service role)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_bot_commands(p_bot_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(jsonb_agg(public.bot_command_json(bc) ORDER BY bc.name), '[]'::jsonb)
      FROM public.bot_commands bc
     WHERE bc.bot_id = p_bot_id AND bc.command_type = 'slash'
$$;

-- A command's name: 1-32 characters without whitespace.
CREATE OR REPLACE FUNCTION public.bot_command_name(p_command jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_name text := CASE WHEN jsonb_typeof(p_command -> 'name') = 'string' THEN p_command ->> 'name' END;
BEGIN
    IF v_name IS NULL OR char_length(v_name) NOT BETWEEN 1 AND 32 OR v_name ~ '[[:space:]]' THEN
        RAISE EXCEPTION 'command name is 1-32 characters without whitespace' USING ERRCODE = '22023';
    END IF;
    RETURN v_name;
END;
$$;

-- Upsert by (bot_id, name); a kept name keeps its id. xmax is 0 on an inserted row.
CREATE OR REPLACE FUNCTION public.bot_command_upsert_row(
    p_bot_id uuid, p_command jsonb, OUT o_created boolean, OUT o_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO public.bot_commands AS bc (bot_id, name, description, options, required_permissions, command_type)
    VALUES (p_bot_id,
            public.bot_command_name(p_command),
            CASE WHEN jsonb_typeof(p_command -> 'description') = 'string' THEN p_command ->> 'description' END,
            CASE WHEN jsonb_typeof(p_command -> 'options') = 'array' THEN p_command -> 'options' ELSE '[]'::jsonb END,
            public.bot_permission_mask(p_command -> 'required_permissions'),
            'slash')
    ON CONFLICT (bot_id, name) DO UPDATE
       SET description = EXCLUDED.description,
           options = EXCLUDED.options,
           required_permissions = EXCLUDED.required_permissions,
           command_type = 'slash',
           updated_at = now()
    RETURNING (bc.xmax = 0), bc.id INTO o_created, o_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.bot_commands_replace(p_bot_id uuid, p_commands jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_command jsonb;
    v_name text;
    v_names text[] := '{}'::text[];
BEGIN
    IF jsonb_typeof(p_commands) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'commands are an array' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(p_commands) > 100 THEN
        RAISE EXCEPTION 'BOT_COMMAND_LIMIT' USING ERRCODE = 'P0001';
    END IF;
    FOR v_command IN SELECT e FROM jsonb_array_elements(p_commands) e LOOP
        v_name := public.bot_command_name(v_command);
        IF v_name = ANY (v_names) THEN
            RAISE EXCEPTION 'BOT_COMMAND_DUPLICATE:%', v_name USING ERRCODE = 'P0001';
        END IF;
        v_names := v_names || v_name;
        PERFORM public.bot_permission_mask(v_command -> 'required_permissions');
    END LOOP;

    PERFORM 1 FROM public.bots b WHERE b.id = p_bot_id FOR UPDATE;
    DELETE FROM public.bot_commands bc WHERE bc.bot_id = p_bot_id AND NOT (bc.name = ANY (v_names));
    FOR v_command IN SELECT e FROM jsonb_array_elements(p_commands) e LOOP
        PERFORM public.bot_command_upsert_row(p_bot_id, v_command);
    END LOOP;
    RETURN public.get_bot_commands(p_bot_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.bot_command_upsert(p_bot_id uuid, p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_name text := public.bot_command_name(p_command);
    v_result record;
BEGIN
    PERFORM 1 FROM public.bots b WHERE b.id = p_bot_id FOR UPDATE;
    IF (SELECT count(*) FROM public.bot_commands bc
         WHERE bc.bot_id = p_bot_id AND bc.name <> v_name) >= 100 THEN
        RAISE EXCEPTION 'BOT_COMMAND_LIMIT' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_result FROM public.bot_command_upsert_row(p_bot_id, p_command);
    RETURN jsonb_build_object('created', v_result.o_created,
                              'command', (SELECT public.bot_command_json(bc) FROM public.bot_commands bc
                                           WHERE bc.id = v_result.o_id));
END;
$$;

-- ---------------------------------------------------------------------------
-- Members
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_channel_bot_commands(p_channel_id uuid, p_thread_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_state record;
    v_result jsonb;
BEGIN
    SELECT * INTO v_state
      FROM public.bot_command_caller_state(public.get_current_profile_id(), p_channel_id, p_thread_id);
    IF v_state.o_error IS NOT NULL THEN
        RETURN '[]'::jsonb;
    END IF;

    WITH posting AS MATERIALIZED (
        SELECT b.id, b.username, b.display_name, b.avatar_url
          FROM public.bot_server_permissions i
          JOIN public.bots b ON b.id = i.bot_id
         WHERE i.server_id = v_state.o_server_id
           AND i.is_active IS TRUE
           AND b.is_active IS TRUE
           AND public.bot_channel_access(b.id, p_channel_id) = 'post'
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', bc.id,
               'name', bc.name,
               'description', bc.description,
               'options', COALESCE(bc.options, '[]'::jsonb),
               'bot', jsonb_build_object('id', p.id, 'username', p.username,
                                         'display_name', p.display_name, 'avatar_url', p.avatar_url))
             ORDER BY lower(COALESCE(NULLIF(btrim(p.display_name), ''), p.username)), p.id, bc.name), '[]'::jsonb)
      INTO v_result
      FROM posting p
      JOIN public.bot_commands bc ON bc.bot_id = p.id
     WHERE bc.command_type = 'slash'
       AND (COALESCE(bc.required_permissions, 0) & ~v_state.o_mask) = 0;
    RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_bot_command(
    p_channel_id uuid, p_thread_id uuid, p_command_id uuid, p_path text[], p_options jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_path text[] := COALESCE(p_path, '{}'::text[]);
    v_state record;
    v_command public.bot_commands%ROWTYPE;
    v_options jsonb;
    v_last timestamptz;
    v_count integer;
    v_oldest timestamptz;
    v_row public.bot_interactions%ROWTYPE;
BEGIN
    PERFORM public.purge_bot_interactions(100);

    SELECT * INTO v_state FROM public.bot_command_caller_state(v_caller, p_channel_id, p_thread_id);
    IF v_state.o_error IS NOT NULL THEN
        RAISE EXCEPTION '%', v_state.o_error USING ERRCODE = 'P0001';
    END IF;

    SELECT bc.* INTO v_command
      FROM public.bot_commands bc
     WHERE bc.id = p_command_id AND bc.command_type = 'slash';
    IF NOT FOUND OR public.bot_channel_access(v_command.bot_id, p_channel_id) <> 'post' THEN
        RAISE EXCEPTION 'BOT_COMMAND_UNAVAILABLE' USING ERRCODE = 'P0001';
    END IF;
    IF (COALESCE(v_command.required_permissions, 0) & ~v_state.o_mask) <> 0 THEN
        RAISE EXCEPTION 'BOT_COMMAND_FORBIDDEN' USING ERRCODE = 'P0001';
    END IF;

    -- As automod_check_message: a server_member_timeouts row in force refuses the member.
    IF EXISTS (SELECT 1 FROM public.server_member_timeouts t
                WHERE t.server_id = v_state.o_server_id AND t.user_id = v_caller AND t.until > now()) THEN
        RAISE EXCEPTION 'BOT_COMMAND_TIMED_OUT' USING ERRCODE = 'P0001';
    END IF;

    -- As enforce_channel_slowmode, counting the caller's invocations in the channel with its
    -- messages. MANAGE_MESSAGES (bit 21) is exempt.
    IF v_state.o_slowmode > 0 AND (v_state.o_mask & 2097152) = 0 THEN
        SELECT max(x.at) INTO v_last
          FROM (SELECT max(m.created_at) AS at
                  FROM public.messages m
                 WHERE m.channel_id = p_channel_id AND m.user_id = v_caller
                   AND m.created_at > now() - make_interval(secs => v_state.o_slowmode)
                UNION ALL
                SELECT max(bi.created_at)
                  FROM public.bot_interactions bi
                 WHERE bi.channel_id = p_channel_id AND bi.user_id = v_caller
                   AND bi.created_at > now() - make_interval(secs => v_state.o_slowmode)) x;
        IF v_last IS NOT NULL THEN
            RAISE EXCEPTION 'BOT_COMMAND_SLOWMODE:%',
                GREATEST(1, ceil(v_state.o_slowmode - extract(epoch FROM (now() - v_last))))::integer
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    v_options := public.bot_command_options(v_command.options, v_path, p_options, v_state.o_server_id,
                                            v_caller, v_command.name);

    IF NOT EXISTS (SELECT 1 FROM public.bot_presence bp
                    WHERE bp.bot_id = v_command.bot_id
                      AND COALESCE(bp.status, 'offline') IN ('online', 'idle', 'dnd')
                      AND bp.last_heartbeat_at >= now() - interval '90 seconds') THEN
        RAISE EXCEPTION 'BOT_COMMAND_BOT_OFFLINE' USING ERRCODE = 'P0001';
    END IF;

    -- 5 per 10 s per account. The lock orders concurrent invocations of one account.
    PERFORM pg_advisory_xact_lock(hashtextextended('bot_interactions:' || v_caller::text, 0));
    SELECT count(*), min(x.created_at) INTO v_count, v_oldest
      FROM (SELECT bi.created_at
              FROM public.bot_interactions bi
             WHERE bi.user_id = v_caller AND bi.created_at > now() - interval '10 seconds'
             ORDER BY bi.created_at DESC
             LIMIT 5) x;
    IF v_count >= 5 THEN
        RAISE EXCEPTION 'BOT_COMMAND_RATE_LIMITED:%',
            GREATEST(1, ceil(extract(epoch FROM (v_oldest + interval '10 seconds' - now()))))::integer
            USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.bot_interactions (bot_id, command_id, server_id, channel_id, thread_id, user_id,
                                         command_name, data)
    VALUES (v_command.bot_id, v_command.id, v_state.o_server_id, p_channel_id, p_thread_id, v_caller,
            array_to_string(ARRAY[v_command.name] || v_path, ' '),
            jsonb_build_object('id', v_command.id, 'name', v_command.name, 'type', 1, 'options', v_options))
    RETURNING * INTO v_row;

    UPDATE public.bot_commands bc
       SET usage_count = COALESCE(bc.usage_count, 0) + 1, last_used_at = now()
     WHERE bc.id = v_command.id;

    RETURN jsonb_build_object('id', v_row.id,
                              'respond_in_ms', public.bot_interaction_ms(v_row.respond_by),
                              'expires_in_ms', public.bot_interaction_ms(v_row.expires_at));
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_bot_interactions(p_ids uuid[])
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', bi.id,
               'bot_id', bi.bot_id,
               'channel_id', bi.channel_id,
               'thread_id', bi.thread_id,
               'command_name', bi.command_name,
               'status', bi.status,
               'error', bi.error,
               'ephemeral', bi.ephemeral,
               'response_message_id', bi.response_message_id,
               'replies', bi.replies,
               'respond_in_ms', public.bot_interaction_ms(bi.respond_by),
               'expires_in_ms', public.bot_interaction_ms(bi.expires_at))
             ORDER BY bi.created_at, bi.id), '[]'::jsonb)
      FROM public.bot_interactions bi
     WHERE bi.user_id = public.get_current_profile_id()
       AND bi.id = ANY ((p_ids)[1:50])
$$;

-- ---------------------------------------------------------------------------
-- Delivery and answers (service role)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.claim_bot_interactions(p_bot_ids uuid[], p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.bot_interactions%ROWTYPE;
    v_out jsonb := '[]'::jsonb;
BEGIN
    IF p_bot_ids IS NULL OR cardinality(p_bot_ids) = 0 THEN
        RETURN v_out;
    END IF;
    PERFORM public.purge_bot_interactions(100);

    UPDATE public.bot_interactions bi
       SET status = 'expired'
     WHERE bi.id IN (SELECT x.id FROM public.bot_interactions x
                      WHERE x.status = 'delivered'
                        AND x.bot_id = ANY (p_bot_ids)
                        AND x.acknowledged_at IS NULL
                        AND x.respond_by < now()
                      FOR UPDATE SKIP LOCKED);

    FOR v_row IN
        SELECT bi.*
          FROM public.bot_interactions bi
         WHERE bi.status = 'pending' AND bi.bot_id = ANY (p_bot_ids)
         ORDER BY bi.created_at, bi.id
         LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 500))
         FOR UPDATE SKIP LOCKED
    LOOP
        IF now() > v_row.respond_by THEN
            UPDATE public.bot_interactions SET status = 'expired' WHERE id = v_row.id;
        ELSIF public.bot_channel_access(v_row.bot_id, v_row.channel_id) <> 'post' THEN
            UPDATE public.bot_interactions SET status = 'failed', error = 'bot_cannot_post' WHERE id = v_row.id;
        ELSE
            UPDATE public.bot_interactions SET status = 'delivered' WHERE id = v_row.id;
            v_out := v_out || jsonb_build_array(public.bot_interaction_event(v_row));
        END IF;
    END LOOP;
    RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.bot_interaction_fail(p_bot_id uuid, p_id uuid, p_error text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.bot_interactions bi
       SET status = 'failed', error = public.bot_interaction_error(p_error)
     WHERE bi.id = p_id AND bi.bot_id = p_bot_id AND bi.status IN ('pending', 'delivered');
    IF NOT FOUND AND NOT EXISTS (SELECT 1 FROM public.bot_interactions bi
                                  WHERE bi.id = p_id AND bi.bot_id = p_bot_id) THEN
        RAISE EXCEPTION 'INTERACTION_UNKNOWN' USING ERRCODE = 'P0001';
    END IF;
END;
$$;

-- One conditional UPDATE: of two concurrent acks, the second waits on the row lock, rereads
-- acknowledged_at and updates nothing.
CREATE OR REPLACE FUNCTION public.bot_interaction_ack(
    p_bot_id uuid, p_id uuid, p_defer boolean, p_ephemeral boolean, p_reply jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_defer boolean := COALESCE(p_defer, false);
    v_ephemeral boolean := COALESCE(p_ephemeral, false);
    v_content jsonb := public.bot_interaction_content(p_reply);
    v_row public.bot_interactions%ROWTYPE;
BEGIN
    UPDATE public.bot_interactions bi
       SET acknowledged_at = now(),
           ephemeral = v_ephemeral,
           status = CASE WHEN v_defer THEN 'deferred' WHEN v_ephemeral THEN 'responded' ELSE 'responding' END,
           replies = CASE WHEN NOT v_defer AND v_ephemeral
                          THEN jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'content', v_content,
                                                                    'created_at', now(), 'edited_at', NULL))
                          ELSE bi.replies END
     WHERE bi.id = p_id
       AND bi.bot_id = p_bot_id
       AND bi.acknowledged_at IS NULL
       AND bi.status IN ('pending', 'delivered')
       AND now() <= bi.respond_by
    RETURNING bi.* INTO v_row;

    IF NOT FOUND THEN
        SELECT bi.* INTO v_row FROM public.bot_interactions bi WHERE bi.id = p_id AND bi.bot_id = p_bot_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'INTERACTION_UNKNOWN' USING ERRCODE = 'P0001';
        ELSIF v_row.acknowledged_at IS NOT NULL THEN
            RAISE EXCEPTION 'INTERACTION_ACKNOWLEDGED' USING ERRCODE = 'P0001';
        END IF;
        RAISE EXCEPTION 'INTERACTION_EXPIRED' USING ERRCODE = 'P0001';
    END IF;

    RETURN jsonb_build_object('id', v_row.id, 'status', v_row.status, 'ephemeral', v_row.ephemeral,
                              'channel_id', v_row.channel_id, 'thread_id', v_row.thread_id,
                              'user_id', v_row.user_id, 'command_name', v_row.command_name,
                              'expires_at', v_row.expires_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.bot_interaction_reply(
    p_bot_id uuid, p_id uuid, p_kind text, p_ephemeral boolean, p_reply jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.bot_interactions%ROWTYPE;
    v_content jsonb;
    v_reply jsonb;
BEGIN
    IF p_kind IS NULL OR p_kind NOT IN ('original', 'followup') THEN
        RAISE EXCEPTION 'p_kind is original or followup' USING ERRCODE = '22023';
    END IF;

    SELECT bi.* INTO v_row FROM public.bot_interactions bi
     WHERE bi.id = p_id AND bi.bot_id = p_bot_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'INTERACTION_UNKNOWN' USING ERRCODE = 'P0001';
    END IF;
    IF v_row.acknowledged_at IS NULL THEN
        RAISE EXCEPTION 'INTERACTION_NOT_ACKNOWLEDGED' USING ERRCODE = 'P0001';
    END IF;
    IF now() > v_row.expires_at THEN
        RAISE EXCEPTION 'INTERACTION_EXPIRED' USING ERRCODE = 'P0001';
    END IF;
    v_content := public.bot_interaction_content(p_reply);

    IF p_kind = 'original' THEN
        IF v_row.ephemeral THEN
            -- An ephemeral row is 'responded' exactly when its original sits at index 0.
            IF v_row.status = 'responded' AND jsonb_array_length(v_row.replies) > 0 THEN
                v_reply := (v_row.replies -> 0) || jsonb_build_object('content', v_content, 'edited_at', now());
                UPDATE public.bot_interactions SET replies = jsonb_set(replies, '{0}', v_reply) WHERE id = v_row.id;
            ELSE
                v_reply := jsonb_build_object('id', gen_random_uuid(), 'content', v_content,
                                              'created_at', now(), 'edited_at', NULL);
                UPDATE public.bot_interactions
                   SET replies = jsonb_build_array(v_reply) || replies, status = 'responded'
                 WHERE id = v_row.id;
            END IF;
            RETURN jsonb_build_object('action', 'stored', 'reply', v_reply);
        END IF;
        IF v_row.response_message_id IS NOT NULL THEN
            RETURN jsonb_build_object('action', 'edit_message', 'message_id', v_row.response_message_id);
        END IF;
        IF v_row.status = 'responding' THEN
            RAISE EXCEPTION 'INTERACTION_RESPONSE_IN_PROGRESS' USING ERRCODE = 'P0001';
        END IF;
        UPDATE public.bot_interactions SET status = 'responding', error = NULL WHERE id = v_row.id;
        RETURN jsonb_build_object('action', 'create_message');
    END IF;

    IF v_row.followup_count >= 10 THEN
        RAISE EXCEPTION 'INTERACTION_FOLLOWUP_LIMIT' USING ERRCODE = 'P0001';
    END IF;
    IF COALESCE(p_ephemeral, false) THEN
        v_reply := jsonb_build_object('id', gen_random_uuid(), 'content', v_content,
                                      'created_at', now(), 'edited_at', NULL);
        UPDATE public.bot_interactions
           SET followup_count = followup_count + 1, replies = replies || jsonb_build_array(v_reply)
         WHERE id = v_row.id;
        RETURN jsonb_build_object('action', 'stored', 'reply', v_reply);
    END IF;
    UPDATE public.bot_interactions SET followup_count = followup_count + 1 WHERE id = v_row.id;
    RETURN jsonb_build_object('action', 'create_message');
END;
$$;

CREATE OR REPLACE FUNCTION public.bot_interaction_record(p_bot_id uuid, p_id uuid, p_message_id uuid, p_error text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.bot_interactions bi
       SET response_message_id = COALESCE(p_message_id, bi.response_message_id),
           status = CASE WHEN p_message_id IS NOT NULL THEN 'responded' ELSE 'failed' END,
           error = CASE WHEN p_message_id IS NOT NULL THEN NULL ELSE public.bot_interaction_error(p_error) END
     WHERE bi.id = p_id AND bi.bot_id = p_bot_id AND bi.status = 'responding';
    IF NOT FOUND AND NOT EXISTS (SELECT 1 FROM public.bot_interactions bi
                                  WHERE bi.id = p_id AND bi.bot_id = p_bot_id) THEN
        RAISE EXCEPTION 'INTERACTION_UNKNOWN' USING ERRCODE = 'P0001';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Push
-- ---------------------------------------------------------------------------

-- reply is the element last created or edited.
CREATE OR REPLACE FUNCTION public.bot_interaction_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- A failed broadcast never blocks the update.
    BEGIN
        PERFORM realtime.send(
            jsonb_build_object(
                'type', 'bot_interaction:update',
                'id', NEW.id,
                'bot_id', NEW.bot_id,
                'channel_id', NEW.channel_id,
                'thread_id', NEW.thread_id,
                'command_name', NEW.command_name,
                'status', NEW.status,
                'error', NEW.error,
                'ephemeral', NEW.ephemeral,
                'response_message_id', NEW.response_message_id,
                'reply', (SELECT r.e
                            FROM jsonb_array_elements(NEW.replies) WITH ORDINALITY AS r(e, i)
                           ORDER BY COALESCE((r.e ->> 'edited_at')::timestamptz, (r.e ->> 'created_at')::timestamptz) DESC NULLS LAST,
                                    r.i DESC
                           LIMIT 1),
                'reply_count', jsonb_array_length(NEW.replies),
                'expires_in_ms', public.bot_interaction_ms(NEW.expires_at)
            ),
            'user_event',
            'user:' || NEW.user_id::text,
            true
        );
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'bot_interaction_push: %', SQLERRM;
    END;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_bot_interactions_push ON public.bot_interactions;
CREATE TRIGGER z_bot_interactions_push
    AFTER UPDATE ON public.bot_interactions
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status
          OR OLD.replies IS DISTINCT FROM NEW.replies
          OR OLD.error IS DISTINCT FROM NEW.error)
    EXECUTE FUNCTION public.bot_interaction_push();

-- ---------------------------------------------------------------------------
-- Messages: interaction is reserved
-- ---------------------------------------------------------------------------

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
        'suppress_embeds', 'webhook', 'remote_author', 'host_ap_id', 'interaction'];
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

-- ---------------------------------------------------------------------------
-- AutoMod: a slash command reply is the invoker's message
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.automod_check_message(p_msg public.messages, p_op text, p_invoker text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_internal boolean := p_invoker IN ('postgres', 'supabase_admin');
    v_client boolean := p_invoker IN ('authenticated', 'anon');
    v_author uuid := p_msg.user_id;
    v_channel_id uuid;
    v_server_id uuid;
    v_category uuid;
    v_owner uuid;
    v_is_local_server boolean;
    v_enabled boolean;
    v_compiled jsonb;
    v_alert_channel uuid;
    v_timeout_until timestamptz;
    v_mask bigint := 0;
    v_role_ids uuid[] := '{}'::uuid[];
    v_default_role uuid;
    v_encrypted boolean := p_msg.encrypted IS TRUE;
    v_content jsonb := CASE WHEN jsonb_typeof(p_msg.content) = 'array' THEN p_msg.content ELSE '[]'::jsonb END;
    v_raw text;
    v_urls text[];
    v_files integer;
    v_mention_users text[];
    v_mention_roles text[];
    v_norm text;
    v_subject text;
    v_hosts text[];
    v_hosts_done boolean := false;
    v_new_member boolean;
    v_account_created timestamptz;
    v_joined timestamptz;
    v_rule jsonb;
    v_cfg jsonb;
    v_type text;
    v_hit text;
    v_re text;
    v_count integer;
    v_matches jsonb := '[]'::jsonb;
    v_block jsonb;
    v_event_type text := CASE WHEN p_op = 'UPDATE' THEN 'edit' ELSE 'message' END;
    v_mentions integer;
    v_window integer;
    v_limit integer;
    v_host text;
    v_domain text;
    v_listed boolean;
    v_fp bigint;
    v_track_antispam boolean := false;
    v_track_server boolean := false;
    v_bots_exempt boolean;
    -- 'discord:<id>' and its name when a bridge bot relays a Discord author.
    v_relayed text;
    v_relayed_name text;
    -- automod_recent_activity.user_id of the author: the profile, or md5(v_relayed) as a uuid.
    v_counted uuid := p_msg.user_id;
    -- A slash command follow-up: judged as the invoker's, not counted as a new message of theirs.
    v_followup boolean := false;
    v_discord_created timestamptz;
    m jsonb;
BEGIN
    IF pg_trigger_depth() < 1 THEN
        RAISE EXCEPTION 'automod_check_message runs only from the messages trigger'
            USING ERRCODE = '42501';
    END IF;

    IF v_internal AND p_msg.is_system IS TRUE THEN
        RETURN true;
    END IF;
    IF v_author IS NULL AND p_msg.bot_id IS NULL THEN
        RETURN true;
    END IF;
    IF p_op = 'UPDATE' THEN
        IF p_msg.is_deleted IS TRUE
           OR current_setting('harmony.silent_content_update', true) = 'true' THEN
            RETURN true;
        END IF;
        -- Moderators editing someone else's row are not evaluated.
        IF v_client AND v_author IS DISTINCT FROM public.get_current_profile_id() THEN
            RETURN true;
        END IF;
    END IF;

    -- A bot's answer to a slash command is the invoker's message (20261110400001).
    IF v_author IS NULL AND p_msg.bot_id IS NOT NULL AND NOT v_internal
       AND (p_msg.metadata #>> '{interaction,user_id}')
           ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT p.id INTO v_author
          FROM public.profiles p
         WHERE p.id = (p_msg.metadata #>> '{interaction,user_id}')::uuid;
        v_counted := v_author;
        v_followup := (p_msg.metadata #>> '{interaction,followup}') IS NOT DISTINCT FROM 'true';
    END IF;

    IF v_author IS NOT NULL AND NOT v_internal THEN
        v_track_antispam := public.antispam_check_local_author(v_author, 'message', v_content, p_op);
    END IF;

    -- EXIT evaluation allows the row; the recent-activity row is written after it.
    <<evaluation>>
    BEGIN
        v_channel_id := p_msg.channel_id;
        IF v_channel_id IS NULL AND p_msg.thread_id IS NOT NULL THEN
            SELECT t.channel_id INTO v_channel_id FROM public.threads t WHERE t.id = p_msg.thread_id;
        END IF;
        IF v_channel_id IS NULL THEN
            EXIT evaluation;
        END IF;

        SELECT c.server_id, c.category, s.owner, s.is_local_server,
               st.enabled, st.compiled, st.alert_channel_id, t.until
          INTO v_server_id, v_category, v_owner, v_is_local_server,
               v_enabled, v_compiled, v_alert_channel, v_timeout_until
          FROM public.channels c
          JOIN public.servers s ON s.id = c.server_id
          LEFT JOIN public.server_automod_settings st ON st.server_id = c.server_id
          LEFT JOIN public.server_member_timeouts t
                 ON t.server_id = c.server_id AND t.user_id = v_author AND t.until > now()
         WHERE c.id = v_channel_id;

        IF NOT FOUND OR v_is_local_server IS NOT TRUE THEN
            v_server_id := NULL;
            EXIT evaluation;
        END IF;

        IF v_timeout_until IS NOT NULL
           AND (NOT v_client OR v_author = public.get_current_profile_id()) THEN
            RAISE EXCEPTION 'MEMBER_TIMED_OUT:%', floor(extract(epoch FROM v_timeout_until))::bigint
                USING ERRCODE = 'P0001',
                      HINT = format('You are timed out in this server until %s.', v_timeout_until);
        END IF;

        IF v_enabled IS NOT TRUE OR jsonb_array_length(COALESCE(v_compiled -> 'rules', '[]'::jsonb)) = 0 THEN
            EXIT evaluation;
        END IF;

        IF v_author IS NULL THEN
            v_bots_exempt := COALESCE((v_compiled ->> 'exempt_bots')::boolean, true);
            IF NOT v_internal
               AND jsonb_typeof(p_msg.metadata -> 'discord_user') = 'object'
               AND (p_msg.metadata #>> '{discord_user,id}') ~ '^[0-9]{1,20}$'
               AND EXISTS (SELECT 1 FROM public.bots b WHERE b.id = p_msg.bot_id AND b.bot_type = 'bridge') THEN
                v_relayed := 'discord:' || (p_msg.metadata #>> '{discord_user,id}');
                v_relayed_name := left(regexp_replace(
                    COALESCE(NULLIF(btrim(p_msg.metadata #>> '{discord_user,username}'), ''),
                             NULLIF(btrim(p_msg.metadata #>> '{discord_user,display_name}'), ''),
                             p_msg.metadata #>> '{discord_user,id}'),
                    '[[:cntrl:]]', ' ', 'g'), 100);
                v_counted := md5(v_relayed)::uuid;
            ELSIF v_bots_exempt THEN
                EXIT evaluation;
            END IF;
        ELSE
            IF v_author = v_owner THEN
                EXIT evaluation;
            END IF;
            SELECT COALESCE(bit_or(sr.permissions), 0),
                   COALESCE(array_agg(sr.id), '{}'),
                   (array_agg(sr.id) FILTER (WHERE sr.is_default))[1]
              INTO v_mask, v_role_ids, v_default_role
              FROM public.server_roles sr
             WHERE sr.server_id = v_server_id
               AND (sr.is_default
                    OR sr.id IN (SELECT ur.role_id FROM public.user_roles ur
                                  WHERE ur.user_id = v_author AND ur.server_id = v_server_id));
            -- ADMINISTRATOR (bit 0) or MANAGE_SERVER (bit 7).
            IF (v_mask & 129) <> 0 THEN
                EXIT evaluation;
            END IF;
        END IF;

        v_track_server := p_op = 'INSERT' AND v_counted IS NOT NULL AND NOT v_internal AND NOT v_followup
                          AND COALESCE((v_compiled ->> 'track')::boolean, false);

        -- A masked link's label is text (20261030900001).
        SELECT string_agg(CASE WHEN e ->> 'type' = 'text' THEN e ->> 'text' ELSE e ->> 'label' END, E'\n')
                   FILTER (WHERE (e ->> 'type' = 'text' AND e ->> 'text' IS NOT NULL)
                              OR (e ->> 'type' = 'url' AND jsonb_typeof(e -> 'label') = 'string')),
               array_agg(e ->> 'url') FILTER (WHERE e ->> 'type' IN ('url', 'embed') AND e ->> 'url' IS NOT NULL),
               count(*) FILTER (WHERE e ->> 'type' = 'file'),
               array_agg(DISTINCT COALESCE(e ->> 'userId', (e ->> 'username') || '@' || COALESCE(e ->> 'domain', '')))
                   FILTER (WHERE e ->> 'type' = 'mention'),
               array_agg(DISTINCT e ->> 'roleId') FILTER (WHERE e ->> 'type' = 'role_mention' AND e ->> 'roleId' IS NOT NULL)
          INTO v_raw, v_urls, v_files, v_mention_users, v_mention_roles
          FROM jsonb_array_elements(v_content) e;

        v_mentions := COALESCE(cardinality(v_mention_users), 0) + COALESCE(cardinality(v_mention_roles), 0);

        FOR v_rule IN SELECT r FROM jsonb_array_elements(v_compiled -> 'rules') r LOOP
            v_type := v_rule ->> 'type';
            v_cfg := v_rule -> 'c';
            v_hit := NULL;

            IF (v_rule -> 'xc') ? v_channel_id::text
               OR (v_category IS NOT NULL AND (v_rule -> 'xc') ? v_category::text) THEN
                CONTINUE;
            END IF;
            IF v_author IS NOT NULL AND jsonb_array_length(v_rule -> 'xr') > 0
               AND (v_rule -> 'xr') ?| v_role_ids::text[] THEN
                CONTINUE;
            END IF;
            IF v_author IS NULL AND v_relayed IS NULL AND v_type IN ('message_flood', 'duplicate_spam', 'new_member') THEN
                CONTINUE;
            END IF;
            -- Under exempt_bots a relayed author meets the author rules alone.
            IF v_relayed IS NOT NULL AND v_bots_exempt
               AND v_type NOT IN ('mention_spam', 'message_flood', 'duplicate_spam', 'new_member') THEN
                CONTINUE;
            END IF;

            IF v_type IN ('keyword', 'keyword_preset') THEN
                CONTINUE WHEN v_encrypted OR v_raw IS NULL;
                IF v_norm IS NULL THEN
                    v_norm := public.automod_normalize(v_raw);
                END IF;
                v_subject := v_norm;
                IF v_cfg ? 'allow' THEN
                    v_subject := regexp_replace(v_subject, v_cfg ->> 'allow', ' ', 'g');
                END IF;
                IF v_cfg ? 'pattern' AND v_subject ~ (v_cfg ->> 'pattern') THEN
                    v_hit := (regexp_match(v_subject, v_cfg ->> 'pattern'))[1];
                    v_hit := COALESCE(v_hit, 'keyword');
                END IF;
                IF v_hit IS NULL AND v_cfg ? 'regex' THEN
                    FOR v_re IN SELECT jsonb_array_elements_text(v_cfg -> 'regex') LOOP
                        IF v_raw ~* v_re THEN
                            v_hit := COALESCE((regexp_match(v_raw, v_re, 'i'))[1], 'regex');
                        ELSIF v_subject ~* v_re THEN
                            v_hit := COALESCE((regexp_match(v_subject, v_re, 'i'))[1], 'regex');
                        END IF;
                        EXIT WHEN v_hit IS NOT NULL;
                    END LOOP;
                END IF;

            ELSIF v_type = 'mention_spam' THEN
                CONTINUE WHEN v_mentions = 0;
                IF v_mentions > (v_cfg ->> 'max_mentions')::integer THEN
                    v_hit := v_mentions || ' mentions';
                ELSIF (v_cfg ->> 'block_everyone_without_permission')::boolean
                      AND (v_default_role::text = ANY (COALESCE(v_mention_roles, '{}'))
                           OR 'here' = ANY (COALESCE(v_mention_roles, '{}')))
                      AND v_author IS NOT NULL
                      AND NOT public.has_permission(v_author, v_server_id, 'MENTION_EVERYONE', v_channel_id) THEN
                    v_hit := CASE WHEN v_default_role::text = ANY (COALESCE(v_mention_roles, '{}'))
                                  THEN '@everyone' ELSE '@here' END;
                ELSIF p_op = 'INSERT' AND v_counted IS NOT NULL AND NOT v_internal
                      AND (v_cfg ->> 'window_mentions')::integer > 0 THEN
                    v_window := (v_cfg ->> 'window_seconds')::integer;
                    SELECT COALESCE(sum(ra.mentions), 0) INTO v_count
                      FROM public.automod_recent_activity ra
                     WHERE ra.user_id = v_counted
                       AND ra.created_at > now() - make_interval(secs => v_window)
                       AND ra.server_id = v_server_id;
                    IF v_count + v_mentions > (v_cfg ->> 'window_mentions')::integer THEN
                        v_hit := (v_count + v_mentions) || ' mentions in ' || v_window || ' s';
                    END IF;
                END IF;

            ELSIF v_type = 'message_flood' THEN
                CONTINUE WHEN p_op <> 'INSERT' OR v_internal OR v_followup;
                v_limit := (v_cfg ->> 'max_messages')::integer;
                v_window := (v_cfg ->> 'window_seconds')::integer;
                SELECT count(*) INTO v_count
                  FROM (SELECT 1
                          FROM public.automod_recent_activity ra
                         WHERE ra.user_id = v_counted
                           AND ra.created_at > now() - make_interval(secs => v_window)
                           AND ra.server_id = v_server_id
                         LIMIT v_limit) r;
                IF v_count >= v_limit THEN
                    v_hit := v_limit || ' messages in ' || v_window || ' s';
                END IF;

            ELSIF v_type = 'duplicate_spam' THEN
                CONTINUE WHEN p_op <> 'INSERT' OR v_internal OR v_followup OR v_encrypted OR v_raw IS NULL
                           OR char_length(btrim(v_raw)) < (v_cfg ->> 'min_length')::integer;
                IF v_norm IS NULL THEN
                    v_norm := public.automod_normalize(v_raw);
                END IF;
                v_fp := hashtextextended(v_norm, 0);
                SELECT count(DISTINCT f.channel_id) INTO v_count
                  FROM (SELECT ra.channel_id
                          FROM public.automod_recent_activity ra
                         WHERE ra.user_id = v_counted
                           AND ra.created_at > now() - make_interval(secs => (v_cfg ->> 'window_seconds')::integer)
                           AND ra.server_id = v_server_id
                           AND ra.fp = v_fp
                           AND ra.channel_id <> v_channel_id
                         LIMIT 100) f;
                IF v_count >= (v_cfg ->> 'max_channels')::integer THEN
                    v_hit := 'same message in ' || (v_count + 1) || ' channels';
                END IF;

            ELSIF v_type = 'invites' THEN
                CONTINUE WHEN v_encrypted OR (v_raw IS NULL AND v_urls IS NULL);
                v_hit := public.automod_foreign_invite(v_raw, v_urls, v_server_id);

            ELSIF v_type = 'links' THEN
                CONTINUE WHEN v_encrypted OR (v_raw IS NULL AND v_urls IS NULL);
                IF NOT v_hosts_done THEN
                    v_hosts := public.automod_link_hosts(v_raw, v_urls);
                    v_hosts_done := true;
                END IF;
                FOREACH v_host IN ARRAY v_hosts LOOP
                    v_listed := false;
                    FOR v_domain IN SELECT jsonb_array_elements_text(v_cfg -> 'domains') LOOP
                        IF v_host = v_domain OR right(v_host, char_length(v_domain) + 1) = '.' || v_domain THEN
                            v_listed := true;
                            EXIT;
                        END IF;
                    END LOOP;
                    IF (v_cfg ->> 'mode' = 'allow_list' AND NOT v_listed)
                       OR (v_cfg ->> 'mode' = 'block_list' AND v_listed) THEN
                        v_hit := v_host;
                        EXIT;
                    END IF;
                END LOOP;

            ELSIF v_type = 'new_member' THEN
                IF v_new_member IS NULL AND v_relayed IS NOT NULL THEN
                    -- Membership age from discord_user.joined_at; without one the rule does
                    -- not apply. Account age from the Discord id: snowflake bits 63..22 are
                    -- milliseconds since 2015-01-01T00:00:00Z (1420070400000 Unix ms).
                    BEGIN
                        v_joined := (p_msg.metadata #>> '{discord_user,joined_at}')::timestamptz;
                    EXCEPTION WHEN data_exception THEN
                        v_joined := NULL;
                    END;
                    v_discord_created := to_timestamp(((floor(
                        (p_msg.metadata #>> '{discord_user,id}')::numeric / 4194304) + 1420070400000) / 1000)::double precision);
                    v_new_member := COALESCE(v_joined IS NOT NULL AND (
                        ((v_cfg ->> 'min_account_age_minutes')::integer > 0
                         AND v_discord_created > now() - make_interval(mins => (v_cfg ->> 'min_account_age_minutes')::integer))
                        OR ((v_cfg ->> 'min_membership_minutes')::integer > 0
                            AND v_joined > now() - make_interval(mins => (v_cfg ->> 'min_membership_minutes')::integer))), false);
                ELSIF v_new_member IS NULL THEN
                    SELECT p.created_at INTO v_account_created FROM public.profiles p WHERE p.id = v_author;
                    SELECT us.created_at INTO v_joined
                      FROM public.user_servers us
                     WHERE us.user_id = v_author AND us.server_id = v_server_id;
                    v_new_member :=
                        ((v_cfg ->> 'min_account_age_minutes')::integer > 0
                         AND v_account_created > now() - make_interval(mins => (v_cfg ->> 'min_account_age_minutes')::integer))
                        OR ((v_cfg ->> 'min_membership_minutes')::integer > 0
                            AND v_joined > now() - make_interval(mins => (v_cfg ->> 'min_membership_minutes')::integer));
                    v_new_member := COALESCE(v_new_member, false);
                END IF;
                CONTINUE WHEN NOT v_new_member;
                IF (v_cfg ->> 'restrict_attachments')::boolean AND v_files > 0 THEN
                    v_hit := 'attachment';
                ELSIF (v_cfg ->> 'restrict_mentions')::boolean AND v_mentions > 0 THEN
                    v_hit := 'mention';
                ELSIF (v_cfg ->> 'restrict_links')::boolean AND NOT v_encrypted
                      AND (v_raw IS NOT NULL OR v_urls IS NOT NULL) THEN
                    IF NOT v_hosts_done THEN
                        v_hosts := public.automod_link_hosts(v_raw, v_urls);
                        v_hosts_done := true;
                    END IF;
                    IF cardinality(v_hosts) > 0 THEN
                        v_hit := v_hosts[1];
                    END IF;
                END IF;
            END IF;

            CONTINUE WHEN v_hit IS NULL;

            v_matches := v_matches || jsonb_build_array(jsonb_build_object('rule', v_rule, 'hit', v_hit));
            IF COALESCE((v_rule -> 'a' ->> 'block')::boolean, false) THEN
                v_block := v_rule;
                EXIT;
            END IF;
        END LOOP;

        IF jsonb_array_length(v_matches) = 0 THEN
            EXIT evaluation;
        END IF;

        IF v_block IS NOT NULL THEN
            -- The row must pass messages_insert_member before anything persists for it.
            IF v_client THEN
                IF v_author IS NULL OR v_author IS DISTINCT FROM public.get_current_profile_id() THEN
                    RETURN true;
                END IF;
                IF p_op = 'INSERT' AND NOT (
                       p_msg.channel_id IS NOT NULL
                       AND v_channel_id IN (SELECT public.current_user_viewable_channel_ids())
                       AND public.has_permission(v_author, v_server_id,
                               CASE WHEN p_msg.thread_id IS NULL THEN 'SEND_MESSAGES' ELSE 'SEND_MESSAGES_IN_THREADS' END,
                               v_channel_id)) THEN
                    RETURN true;
                END IF;
            END IF;

            IF public.automod_singular_request() THEN
                RAISE EXCEPTION 'AUTOMOD_BLOCKED:%', v_block ->> 'type'
                    USING ERRCODE = 'P0001',
                          DETAIL = jsonb_build_object('rule_type', v_block ->> 'type',
                                                      'rule_name', v_block ->> 'name',
                                                      'message', v_block -> 'a' ->> 'block_message')::text,
                          HINT = COALESCE(v_block -> 'a' ->> 'block_message',
                                          'This message was blocked by the server''s AutoMod.');
            END IF;
        END IF;

        FOR m IN SELECT x FROM jsonb_array_elements(v_matches) x LOOP
            PERFORM public.automod_record_match(
                v_server_id, v_channel_id, v_author, p_msg.bot_id,
                CASE WHEN v_block IS NULL OR p_op = 'UPDATE' THEN p_msg.id END,
                v_event_type, m -> 'rule', m ->> 'hit',
                v_block IS NOT NULL AND (m -> 'rule' ->> 'id') = (v_block ->> 'id'),
                v_content, v_alert_channel, v_relayed, v_relayed_name);
        END LOOP;

        IF v_block IS NOT NULL THEN
            RETURN false;
        END IF;
    END evaluation;

    IF p_op = 'INSERT' AND (v_track_antispam OR v_track_server) THEN
        INSERT INTO public.automod_recent_activity (user_id, kind, server_id, channel_id, fp, mentions)
        VALUES (v_counted, 'message', v_server_id, v_channel_id, v_fp, COALESCE(v_mentions, 0));
    END IF;
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.automod_check_message(public.messages, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.automod_check_message(public.messages, text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------

DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        BEGIN PERFORM cron.unschedule('purge-bot-interactions'); EXCEPTION WHEN OTHERS THEN NULL; END;
        PERFORM cron.schedule('purge-bot-interactions', '23 * * * *', 'SELECT public.purge_bot_interactions()');
        RAISE NOTICE 'purge-bot-interactions scheduled';
    ELSE
        RAISE NOTICE 'pg_cron not available; purge_bot_interactions() runs on invoke and claim only';
    END IF;
END
$do$;

-- ---------------------------------------------------------------------------
-- Privileges and ownership
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure FROM pg_catalog.pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('bot_permission_mask', 'bot_permission_names', 'bot_install_mask',
                             'bot_command_number', 'bot_interaction_ms', 'bot_interaction_error',
                             'bot_interaction_content', 'bot_command_json', 'bot_command_caller_state',
                             'bot_command_options', 'bot_interaction_resolved', 'bot_interaction_event',
                             'bot_command_name', 'bot_command_upsert_row', 'bot_interaction_push')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
    END LOOP;

    FOR fn IN
        SELECT p.oid::regprocedure FROM pg_catalog.pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('bot_channel_access', 'purge_bot_interactions', 'get_bot_commands',
                             'bot_commands_replace', 'bot_command_upsert', 'claim_bot_interactions',
                             'bot_interaction_fail', 'bot_interaction_ack', 'bot_interaction_reply',
                             'bot_interaction_record')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;

    FOR fn IN
        SELECT p.oid::regprocedure FROM pg_catalog.pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('get_channel_bot_commands', 'invoke_bot_command', 'get_my_bot_interactions')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
    END LOOP;
END;
$$;

-- As in 20261005400001_account_security.sql: a definer created by supabase_admin would call
-- postgres-owned helpers whose PUBLIC grant is revoked. As 20261006000001_server_member_bots.sql,
-- postgres needs the bot tables' privileges and their owner or BYPASSRLS.
DO $$
DECLARE
    fn regprocedure;
    v_tbl text;
    v_missing text[] := '{}';
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
        RAISE NOTICE 'postgres role absent, ownership left with %', current_user;
        RETURN;
    END IF;
    FOR fn IN
        SELECT p.oid::regprocedure FROM pg_catalog.pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('bot_permission_mask', 'bot_permission_names', 'bot_install_mask',
                             'bot_command_number', 'bot_interaction_ms', 'bot_interaction_error',
                             'bot_interaction_content', 'bot_command_json', 'bot_channel_access',
                             'bot_command_caller_state', 'bot_command_options', 'bot_interaction_resolved',
                             'bot_interaction_event', 'purge_bot_interactions', 'get_bot_commands',
                             'bot_command_name', 'bot_command_upsert_row', 'bot_commands_replace',
                             'bot_command_upsert',
                             'get_channel_bot_commands', 'invoke_bot_command', 'get_my_bot_interactions',
                             'claim_bot_interactions', 'bot_interaction_fail', 'bot_interaction_ack',
                             'bot_interaction_reply', 'bot_interaction_record', 'bot_interaction_push')
           AND pg_get_userbyid(p.proowner) <> 'postgres'
    LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', fn);
    END LOOP;
    IF pg_get_userbyid((SELECT c.relowner FROM pg_class c WHERE c.oid = 'public.bot_interactions'::regclass)) <> 'postgres' THEN
        ALTER TABLE public.bot_interactions OWNER TO postgres;
    END IF;

    IF NOT (has_table_privilege('postgres', 'public.bot_commands', 'INSERT')
            AND has_table_privilege('postgres', 'public.bot_commands', 'UPDATE')
            AND has_table_privilege('postgres', 'public.bot_commands', 'DELETE')) THEN
        BEGIN
            GRANT SELECT, INSERT, UPDATE, DELETE ON public.bot_commands TO postgres;
        EXCEPTION WHEN insufficient_privilege THEN
            NULL;
        END;
    END IF;
    FOREACH v_tbl IN ARRAY ARRAY['public.bot_commands', 'public.bots', 'public.bot_server_permissions',
                                 'public.bot_presence'] LOOP
        IF NOT has_table_privilege('postgres', v_tbl, 'SELECT') THEN
            v_missing := v_missing || format('SELECT on %s', v_tbl);
        END IF;
        IF NOT (SELECT r.rolbypassrls FROM pg_roles r WHERE r.rolname = 'postgres')
           AND (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = v_tbl::regclass) <> 'postgres' THEN
            v_missing := v_missing || format('owner or BYPASSRLS for %s', v_tbl);
        END IF;
    END LOOP;
    IF NOT (has_table_privilege('postgres', 'public.bot_commands', 'INSERT')
            AND has_table_privilege('postgres', 'public.bot_commands', 'UPDATE')
            AND has_table_privilege('postgres', 'public.bot_commands', 'DELETE')) THEN
        v_missing := v_missing || 'INSERT, UPDATE, DELETE on public.bot_commands'::text;
    END IF;
    IF cardinality(v_missing) > 0 THEN
        RAISE EXCEPTION 'postgres lacks what the bot command functions use: %', array_to_string(v_missing, ', ')
            USING HINT = 'Apply this migration as supabase_admin.';
    END IF;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
