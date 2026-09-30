-- Per-channel end-to-end encryption.
--
-- channel_encryption_settings holds one row per channel. server_encryption_settings is the floor
-- the row is resolved against; a server with no row resolves as 'disabled':
--   disabled                        messages off; voice off unless voice_encryption_mode = 'required'
--   optional                        the channel row decides; new channels start off
--   required, required_local_only   messages on; new channels start on and cannot turn off
--   voice_encryption_mode required  voice on in every channel
-- A server moving to a required mode writes its floor into every channel row, so relaxing the
-- server back to 'optional' leaves those channels on.
--
-- Encrypted channel content is validated structurally, not cryptographically:
--   content[0]    {"type":"text","text":<base64>}: the Megolm ciphertext, at least 40 characters
--                 (12-byte IV, 16-byte GCM tag, 2-byte minimum payload), length a multiple of 4
--   content[1..]  plaintext mention parts, at most 100:
--                   {"type":"mention","userId","username","domain","isLocal"}
--                   {"type":"role_mention","roleId"}
--                 No other key is accepted. The server reads these for mention notifications and
--                 unread_mentions; clients render mentions from the decrypted payload only.
--   encryption_metadata.algorithm  megolm_v2_signed or megolm_v3, with a string session_id
-- Base64 plaintext claimed as ciphertext passes this check; clients fail to decrypt it and show
-- it as undecryptable, never as text.
--
-- Plaintext rejection exempts:
--   soft-deleted rows (tombstones)
--   system messages inserted by a server-side role; a client role may insert only the
--   thread_created announcement, content [{"type":"text","text":"started a thread"}]
--   server-side updates to rows that were plaintext before the channel was encrypted
-- A client role is current_user authenticated or anon. enforce_channel_message_encryption() is
-- SECURITY INVOKER for that reason; channel_messages_encrypted() carries the privileged read.
--
-- Federation: rows in an encrypted channel, and encrypted rows anywhere, are stamped
-- federation_status = 'skipped' and never queued, which also keeps them out of the
-- federation-backend 'pending' sweeps. Edits, reactions and reaction removals on them are not
-- queued. A delete is queued only for a row that was federated.
--
-- Notification previews: every notification whose data names an encrypted message has its
-- preview fields replaced with 'Encrypted message' before insert. One BEFORE INSERT trigger on
-- notifications covers mentions, role mentions, thread replies, reactions and DMs, and the push
-- job reads the row after it.
--
-- Backfill: required servers on, optional servers on where the channel already holds an
-- encrypted message, everything else off. voice_encrypted follows voice_encryption_mode.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.channel_encryption_settings (
    channel_id uuid PRIMARY KEY REFERENCES public.channels(id) ON DELETE CASCADE,
    messages_encrypted boolean NOT NULL DEFAULT false,
    voice_encrypted boolean NOT NULL DEFAULT false,
    history_visibility text NOT NULL DEFAULT 'joined',
    enabled_at timestamptz,
    enabled_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT channel_encryption_settings_history_visibility_check
        CHECK (history_visibility IN ('joined', 'shared'))
);

CREATE INDEX IF NOT EXISTS idx_channel_encryption_settings_enabled_by
    ON public.channel_encryption_settings (enabled_by)
    WHERE enabled_by IS NOT NULL;

COMMENT ON TABLE public.channel_encryption_settings IS
'Per-channel E2EE state, resolved against server_encryption_settings by channel_messages_encrypted() and effective_channel_encryption(). Written only by set_channel_encryption() and triggers.';
COMMENT ON COLUMN public.channel_encryption_settings.history_visibility IS
'joined: a member reads sessions created after they joined. shared: any member reads all history. Stored only; key-request fulfilment does not consult it.';
COMMENT ON COLUMN public.channel_encryption_settings.enabled_at IS
'When messages_encrypted last turned on; NULL while off.';

ALTER TABLE public.channel_encryption_settings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.channel_encryption_settings FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.channel_encryption_settings FROM authenticated;
GRANT SELECT ON public.channel_encryption_settings TO authenticated;

DROP POLICY IF EXISTS "channel_encryption_settings_select" ON public.channel_encryption_settings;
CREATE POLICY "channel_encryption_settings_select" ON public.channel_encryption_settings
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1
              FROM public.channels c
              JOIN public.user_servers us ON us.server_id = c.server_id
             WHERE c.id = channel_encryption_settings.channel_id
               AND us.user_id = ( SELECT public.get_current_profile_id() )
               AND us.status = 'accepted'
        )
        OR EXISTS (
            SELECT 1
              FROM public.channels c
              JOIN public.servers s ON s.id = c.server_id
             WHERE c.id = channel_encryption_settings.channel_id
               AND s.owner = ( SELECT public.get_current_profile_id() )
        )
        OR ( SELECT public.is_current_user_admin() )
    );

-- ---------------------------------------------------------------------------
-- Resolution
-- ---------------------------------------------------------------------------

-- Executable by every role that inserts messages: enforce_channel_message_encryption() runs as
-- the inserting role and calls it.
CREATE OR REPLACE FUNCTION public.channel_messages_encrypted(p_channel_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
    SELECT COALESCE((
        SELECT CASE
                 WHEN ses.encryption_mode IN ('required', 'required_local_only') THEN true
                 WHEN ses.encryption_mode = 'optional' THEN COALESCE(ces.messages_encrypted, false)
                 ELSE false
               END
          FROM public.channels c
          LEFT JOIN public.server_encryption_settings ses ON ses.server_id = c.server_id
          LEFT JOIN public.channel_encryption_settings ces ON ces.channel_id = c.id
         WHERE c.id = p_channel_id
    ), false);
$$;

REVOKE ALL ON FUNCTION public.channel_messages_encrypted(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.channel_messages_encrypted(uuid) TO authenticated, service_role;

-- Inserts the initial row for each listed channel that has none. Initial state is the floor
-- plus, under 'optional', whether the channel already holds an encrypted message; a new channel
-- holds none.
CREATE OR REPLACE FUNCTION public.seed_channel_encryption_settings(p_channel_ids uuid[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
    INSERT INTO public.channel_encryption_settings
        (channel_id, messages_encrypted, voice_encrypted, enabled_at)
    SELECT c.id,
           s.messages_on,
           COALESCE(ses.voice_encryption_mode = 'required', false),
           CASE WHEN s.messages_on THEN now() END
      FROM public.channels c
      LEFT JOIN public.server_encryption_settings ses ON ses.server_id = c.server_id
     CROSS JOIN LATERAL (
        SELECT CASE
                 WHEN ses.encryption_mode IN ('required', 'required_local_only') THEN true
                 WHEN ses.encryption_mode = 'optional' THEN EXISTS (
                     SELECT 1 FROM public.messages m
                      WHERE m.channel_id = c.id AND m.encrypted IS TRUE)
                 ELSE false
               END AS messages_on
     ) s
     WHERE c.id = ANY (p_channel_ids)
    ON CONFLICT (channel_id) DO NOTHING;
$$;

REVOKE ALL ON FUNCTION public.seed_channel_encryption_settings(uuid[]) FROM PUBLIC, anon, authenticated;

-- NULL when the channel does not exist or the caller is neither an accepted member of its
-- server, its owner, nor an instance admin.
--   messages_locked  the server floor fixes messages_encrypted
--   voice_locked     the server floor fixes voice_encrypted
--   bot_count        active non-bridge bot installs in the server
--   bridge_count     active bridge installs, or 1 for a Discord bridge pairing with none
CREATE OR REPLACE FUNCTION public.effective_channel_encryption(p_channel_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_server_id uuid;
    v_owner uuid;
    v_mode text;
    v_voice_mode text;
    v_row public.channel_encryption_settings;
    v_messages boolean;
    v_bots integer;
    v_bridges integer;
BEGIN
    IF v_caller IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT c.server_id, s.owner INTO v_server_id, v_owner
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id
     WHERE c.id = p_channel_id;

    IF v_server_id IS NULL THEN
        RETURN NULL;
    END IF;

    IF v_owner IS DISTINCT FROM v_caller
       AND NOT public.is_current_user_admin()
       AND NOT EXISTS (
           SELECT 1 FROM public.user_servers us
            WHERE us.server_id = v_server_id
              AND us.user_id = v_caller
              AND us.status = 'accepted')
    THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(ses.encryption_mode, 'disabled'), COALESCE(ses.voice_encryption_mode, 'disabled')
      INTO v_mode, v_voice_mode
      FROM (SELECT 1) one
      LEFT JOIN public.server_encryption_settings ses ON ses.server_id = v_server_id;

    SELECT * INTO v_row FROM public.channel_encryption_settings WHERE channel_id = p_channel_id;

    v_messages := public.channel_messages_encrypted(p_channel_id);

    SELECT count(*) FILTER (WHERE b.bot_type IS DISTINCT FROM 'bridge'),
           count(*) FILTER (WHERE b.bot_type = 'bridge')
      INTO v_bots, v_bridges
      FROM public.bot_server_permissions p
      JOIN public.bots b ON b.id = p.bot_id
     WHERE p.server_id = v_server_id
       AND p.is_active IS TRUE;

    IF v_bridges = 0 AND EXISTS (SELECT 1 FROM public.discord_bridge_pairings WHERE server_id = v_server_id) THEN
        v_bridges := 1;
    END IF;

    RETURN jsonb_build_object(
        'channel_id', p_channel_id,
        'server_id', v_server_id,
        'server_mode', v_mode,
        'voice_mode', v_voice_mode,
        'messages_encrypted', v_messages,
        'voice_encrypted', v_voice_mode = 'required'
                           OR (v_mode <> 'disabled' AND COALESCE(v_row.voice_encrypted, false)),
        'messages_locked', v_mode <> 'optional',
        'voice_locked', v_voice_mode = 'required' OR v_mode = 'disabled',
        'history_visibility', COALESCE(v_row.history_visibility, 'joined'),
        'enabled_at', CASE WHEN v_messages THEN v_row.enabled_at END,
        'enabled_by', CASE WHEN v_messages THEN v_row.enabled_by END,
        'bot_count', v_bots,
        'bridge_count', v_bridges
    );
END;
$$;

REVOKE ALL ON FUNCTION public.effective_channel_encryption(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.effective_channel_encryption(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Toggle
-- ---------------------------------------------------------------------------

-- NULL arguments leave that setting unchanged. Permitted: instance admins, the server owner, and
-- accepted members holding MANAGE_CHANNELS for the channel (ADMINISTRATOR included), on local
-- servers only. Each change to the effective messages or voice state posts a system message
-- attributed to the caller; turning messages on bumps the room epoch so the next send opens a
-- fresh Megolm session.
--
-- Errors: 42501 unauthenticated or not permitted, P0002 no such channel, 22023 floor violation,
-- remote server or unknown history_visibility.
CREATE OR REPLACE FUNCTION public.set_channel_encryption(
    p_channel_id uuid,
    p_messages_encrypted boolean DEFAULT NULL,
    p_voice_encrypted boolean DEFAULT NULL,
    p_history_visibility text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_server_id uuid;
    v_owner uuid;
    v_is_local boolean;
    v_mode text;
    v_voice_mode text;
    v_row public.channel_encryption_settings;
    v_messages_before boolean;
    v_messages_after boolean;
    v_voice_before boolean;
    v_voice_after boolean;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    SELECT c.server_id, s.owner, s.is_local_server
      INTO v_server_id, v_owner, v_is_local
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id
     WHERE c.id = p_channel_id;

    IF v_server_id IS NULL THEN
        RAISE EXCEPTION 'Channel not found' USING ERRCODE = 'P0002';
    END IF;

    IF NOT (
        public.is_current_user_admin()
        OR v_owner = v_caller
        OR (
            EXISTS (SELECT 1 FROM public.user_servers us
                     WHERE us.server_id = v_server_id
                       AND us.user_id = v_caller
                       AND us.status = 'accepted')
            AND public.has_permission(v_caller, v_server_id, 'MANAGE_CHANNELS', p_channel_id)
        )
    ) THEN
        RAISE EXCEPTION 'Missing MANAGE_CHANNELS permission for this channel' USING ERRCODE = '42501';
    END IF;

    IF v_is_local IS NOT TRUE THEN
        RAISE EXCEPTION 'Encryption settings apply to channels of local servers only' USING ERRCODE = '22023';
    END IF;

    IF p_history_visibility IS NOT NULL AND p_history_visibility NOT IN ('joined', 'shared') THEN
        RAISE EXCEPTION 'Unknown history visibility: %', p_history_visibility USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(ses.encryption_mode, 'disabled'), COALESCE(ses.voice_encryption_mode, 'disabled')
      INTO v_mode, v_voice_mode
      FROM (SELECT 1) one
      LEFT JOIN public.server_encryption_settings ses ON ses.server_id = v_server_id;

    IF p_messages_encrypted IS TRUE AND v_mode = 'disabled' THEN
        RAISE EXCEPTION 'End-to-end encryption is disabled for this server' USING ERRCODE = '22023';
    END IF;
    IF p_messages_encrypted IS FALSE AND v_mode IN ('required', 'required_local_only') THEN
        RAISE EXCEPTION 'This server requires end-to-end encryption in every channel' USING ERRCODE = '22023';
    END IF;
    IF p_voice_encrypted IS TRUE AND v_mode = 'disabled' AND v_voice_mode <> 'required' THEN
        RAISE EXCEPTION 'End-to-end encryption is disabled for this server' USING ERRCODE = '22023';
    END IF;
    IF p_voice_encrypted IS FALSE AND v_voice_mode = 'required' THEN
        RAISE EXCEPTION 'This server requires end-to-end encrypted voice in every channel' USING ERRCODE = '22023';
    END IF;

    PERFORM public.seed_channel_encryption_settings(ARRAY[p_channel_id]);

    SELECT * INTO v_row
      FROM public.channel_encryption_settings
     WHERE channel_id = p_channel_id
       FOR UPDATE;

    v_messages_before := public.channel_messages_encrypted(p_channel_id);
    v_voice_before := v_voice_mode = 'required' OR (v_mode <> 'disabled' AND v_row.voice_encrypted);

    UPDATE public.channel_encryption_settings
       SET messages_encrypted = COALESCE(p_messages_encrypted, messages_encrypted),
           voice_encrypted = COALESCE(p_voice_encrypted, voice_encrypted),
           history_visibility = COALESCE(p_history_visibility, history_visibility),
           enabled_at = CASE
                          WHEN p_messages_encrypted IS TRUE AND NOT messages_encrypted THEN now()
                          WHEN p_messages_encrypted IS FALSE THEN NULL
                          ELSE enabled_at
                        END,
           enabled_by = CASE
                          WHEN p_messages_encrypted IS TRUE AND NOT messages_encrypted THEN v_caller
                          WHEN p_messages_encrypted IS FALSE THEN NULL
                          ELSE enabled_by
                        END,
           updated_at = now()
     WHERE channel_id = p_channel_id
    RETURNING * INTO v_row;

    v_messages_after := public.channel_messages_encrypted(p_channel_id);
    v_voice_after := v_voice_mode = 'required' OR (v_mode <> 'disabled' AND v_row.voice_encrypted);

    IF v_messages_after AND NOT v_messages_before THEN
        PERFORM public.bump_room_epoch(p_channel_id::text, 'encryption_enabled');
    END IF;

    IF v_messages_after IS DISTINCT FROM v_messages_before THEN
        INSERT INTO public.messages (channel_id, user_id, content, is_system, metadata)
        VALUES (
            p_channel_id,
            v_caller,
            jsonb_build_array(jsonb_build_object(
                'type', 'text',
                'text', CASE WHEN v_messages_after THEN 'turned on end-to-end encryption'
                             ELSE 'turned off end-to-end encryption' END)),
            true,
            jsonb_build_object('type', CASE WHEN v_messages_after THEN 'channel_encryption_enabled'
                                            ELSE 'channel_encryption_disabled' END)
        );
    END IF;

    IF v_voice_after IS DISTINCT FROM v_voice_before THEN
        INSERT INTO public.messages (channel_id, user_id, content, is_system, metadata)
        VALUES (
            p_channel_id,
            v_caller,
            jsonb_build_array(jsonb_build_object(
                'type', 'text',
                'text', CASE WHEN v_voice_after THEN 'turned on end-to-end encryption for voice and video'
                             ELSE 'turned off end-to-end encryption for voice and video' END)),
            true,
            jsonb_build_object('type', CASE WHEN v_voice_after THEN 'channel_voice_encryption_enabled'
                                            ELSE 'channel_voice_encryption_disabled' END)
        );
    END IF;

    RETURN public.effective_channel_encryption(p_channel_id);
END;
$$;

REVOKE ALL ON FUNCTION public.set_channel_encryption(uuid, boolean, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_channel_encryption(uuid, boolean, boolean, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Channel and server triggers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.seed_channel_encryption_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    PERFORM public.seed_channel_encryption_settings(ARRAY[NEW.id]);
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_channel_encryption_on_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_seed_channel_encryption ON public.channels;
CREATE TRIGGER trg_seed_channel_encryption
    AFTER INSERT ON public.channels
    FOR EACH ROW
    EXECUTE FUNCTION public.seed_channel_encryption_on_insert();

-- A server entering a required mode writes it into every channel row.
CREATE OR REPLACE FUNCTION public.apply_server_encryption_floor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_messages boolean := COALESCE(NEW.encryption_mode IN ('required', 'required_local_only'), false);
    v_voice boolean := COALESCE(NEW.voice_encryption_mode = 'required', false);
BEGIN
    IF TG_OP = 'UPDATE' THEN
        v_messages := v_messages AND OLD.encryption_mode IS DISTINCT FROM NEW.encryption_mode;
        v_voice := v_voice AND OLD.voice_encryption_mode IS DISTINCT FROM NEW.voice_encryption_mode;
    END IF;

    IF NOT (v_messages OR v_voice) THEN
        RETURN NEW;
    END IF;

    PERFORM public.seed_channel_encryption_settings(
        ARRAY(SELECT c.id FROM public.channels c WHERE c.server_id = NEW.server_id));

    UPDATE public.channel_encryption_settings ces
       SET messages_encrypted = ces.messages_encrypted OR v_messages,
           voice_encrypted = ces.voice_encrypted OR v_voice,
           enabled_at = CASE WHEN v_messages AND NOT ces.messages_encrypted THEN now() ELSE ces.enabled_at END,
           enabled_by = CASE WHEN v_messages AND NOT ces.messages_encrypted THEN NEW.updated_by ELSE ces.enabled_by END,
           updated_at = now()
      FROM public.channels c
     WHERE c.id = ces.channel_id
       AND c.server_id = NEW.server_id
       AND ((v_messages AND NOT ces.messages_encrypted) OR (v_voice AND NOT ces.voice_encrypted));

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_server_encryption_floor() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_apply_server_encryption_floor ON public.server_encryption_settings;
CREATE TRIGGER trg_apply_server_encryption_floor
    AFTER INSERT OR UPDATE OF encryption_mode, voice_encryption_mode ON public.server_encryption_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.apply_server_encryption_floor();

-- Same event shape as broadcast_server_settings_change(), on server-structure:{server_id}.
CREATE OR REPLACE FUNCTION public.broadcast_channel_encryption_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_server uuid;
BEGIN
    SELECT server_id INTO v_server FROM public.channels WHERE id = NEW.channel_id;
    IF v_server IS NULL THEN
        RETURN NEW;
    END IF;

    PERFORM realtime.send(
        jsonb_build_object(
            'type', 'settings:' || lower(TG_OP),
            'table', TG_TABLE_NAME,
            'new', to_jsonb(NEW),
            'old', CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END
        ),
        'server_event',
        'server-structure:' || v_server::text,
        true
    );
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'broadcast_channel_encryption_change failed: %', SQLERRM;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.broadcast_channel_encryption_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_broadcast_channel_encryption ON public.channel_encryption_settings;
CREATE TRIGGER trg_broadcast_channel_encryption
    AFTER INSERT OR UPDATE ON public.channel_encryption_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_channel_encryption_change();

-- ---------------------------------------------------------------------------
-- Plaintext rejection
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_plaintext_mention_part(p_part jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions, pg_temp
AS $$
    SELECT COALESCE(
        jsonb_typeof(p_part) = 'object'
        AND CASE p_part->>'type'
            WHEN 'mention' THEN
                NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_part) k
                             WHERE k NOT IN ('type', 'userId', 'username', 'domain', 'isLocal'))
                AND jsonb_typeof(p_part->'username') = 'string'
                AND char_length(p_part->>'username') BETWEEN 1 AND 100
                AND COALESCE(jsonb_typeof(p_part->'userId'), 'null') IN ('string', 'null')
                AND COALESCE(char_length(p_part->>'userId'), 0) <= 64
                AND COALESCE(jsonb_typeof(p_part->'domain'), 'null') IN ('string', 'null')
                AND COALESCE(char_length(p_part->>'domain'), 0) <= 253
                AND COALESCE(jsonb_typeof(p_part->'isLocal'), 'null') IN ('boolean', 'null')
            WHEN 'role_mention' THEN
                NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_part) k
                             WHERE k NOT IN ('type', 'roleId'))
                AND jsonb_typeof(p_part->'roleId') = 'string'
                AND (p_part->>'roleId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            ELSE false
        END,
        false);
$$;

REVOKE ALL ON FUNCTION public.is_plaintext_mention_part(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_plaintext_mention_part(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_encrypted_channel_content(p_content jsonb, p_metadata jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions, pg_temp
AS $$
    SELECT COALESCE(
        jsonb_typeof(p_content) = 'array'
        AND jsonb_array_length(p_content) BETWEEN 1 AND 101
        AND jsonb_typeof(p_metadata) = 'object'
        AND p_metadata->>'algorithm' IN ('megolm_v2_signed', 'megolm_v3')
        AND jsonb_typeof(p_metadata->'session_id') = 'string'
        AND jsonb_typeof(p_content->0) = 'object'
        AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_content->0) k WHERE k NOT IN ('type', 'text'))
        AND p_content->0->>'type' = 'text'
        AND jsonb_typeof(p_content->0->'text') = 'string'
        AND char_length(p_content->0->>'text') >= 40
        AND char_length(p_content->0->>'text') % 4 = 0
        AND (p_content->0->>'text') ~ '^[A-Za-z0-9+/]+={0,2}$'
        AND NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements(p_content) WITH ORDINALITY AS e(part, idx)
             WHERE e.idx > 1
               AND NOT public.is_plaintext_mention_part(e.part)
        ),
        false);
$$;

REVOKE ALL ON FUNCTION public.is_encrypted_channel_content(jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_encrypted_channel_content(jsonb, jsonb) TO authenticated, service_role;

-- SECURITY INVOKER: current_user separates client inserts from server-side ones.
CREATE OR REPLACE FUNCTION public.enforce_channel_message_encryption()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_channel_id uuid := NEW.channel_id;
    v_client boolean := current_user IN ('authenticated', 'anon');
BEGIN
    IF v_channel_id IS NULL AND NEW.thread_id IS NOT NULL THEN
        SELECT t.channel_id INTO v_channel_id FROM public.threads t WHERE t.id = NEW.thread_id;
    END IF;

    IF v_channel_id IS NULL OR NEW.is_deleted IS TRUE THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE'
       AND NEW.content IS NOT DISTINCT FROM OLD.content
       AND NEW.encrypted IS NOT DISTINCT FROM OLD.encrypted
       AND NEW.is_system IS NOT DISTINCT FROM OLD.is_system
       AND NEW.is_deleted IS NOT DISTINCT FROM OLD.is_deleted
       AND NEW.channel_id IS NOT DISTINCT FROM OLD.channel_id THEN
        RETURN NEW;
    END IF;

    IF NOT public.channel_messages_encrypted(v_channel_id) THEN
        RETURN NEW;
    END IF;

    IF NEW.is_system IS TRUE THEN
        IF NOT v_client THEN
            RETURN NEW;
        END IF;
        IF NEW.metadata->>'type' = 'thread_created'
           AND NEW.content = '[{"type": "text", "text": "started a thread"}]'::jsonb THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'CHANNEL_ENCRYPTED: system messages in an end-to-end encrypted channel are server-generated'
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'UPDATE' AND NOT v_client
       AND OLD.encrypted IS NOT TRUE AND NEW.encrypted IS NOT TRUE THEN
        RETURN NEW;
    END IF;

    IF NEW.encrypted IS TRUE AND public.is_encrypted_channel_content(NEW.content, NEW.encryption_metadata) THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'CHANNEL_ENCRYPTED: this channel is end-to-end encrypted and rejects plaintext messages'
        USING ERRCODE = 'check_violation',
              HINT = 'Encrypt the message: content[0] is the ciphertext, followed only by mention parts.';
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_channel_message_encryption() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_enforce_channel_encryption ON public.messages;
CREATE TRIGGER trg_enforce_channel_encryption
    BEFORE INSERT OR UPDATE OF content, encrypted, encryption_metadata, is_system, is_deleted, channel_id, thread_id
    ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_channel_message_encryption();

-- ---------------------------------------------------------------------------
-- Notification previews
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.redact_encrypted_notification_preview()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_label constant jsonb := to_jsonb('Encrypted message'::text);
    v_ref text;
    v_encrypted boolean;
    v_key text;
BEGIN
    IF jsonb_typeof(NEW.data) IS DISTINCT FROM 'object' THEN
        RETURN NEW;
    END IF;

    v_ref := COALESCE(NEW.data->>'message_id', NEW.data->'message'->>'id');
    IF v_ref IS NULL
       OR v_ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN NEW;
    END IF;

    SELECT m.encrypted INTO v_encrypted FROM public.messages m WHERE m.id = v_ref::uuid;
    IF v_encrypted IS NOT TRUE THEN
        RETURN NEW;
    END IF;

    NEW.data := NEW.data || jsonb_build_object('encrypted', true);
    FOREACH v_key IN ARRAY ARRAY['preview', 'content_preview', 'message_preview'] LOOP
        IF NEW.data ? v_key THEN
            NEW.data := jsonb_set(NEW.data, ARRAY[v_key], v_label);
        END IF;
    END LOOP;
    IF jsonb_typeof(NEW.data->'message') = 'object' THEN
        NEW.data := jsonb_set(
            NEW.data, '{message}',
            ((NEW.data->'message') - 'content')
                || jsonb_build_object('content_preview', v_label, 'encrypted', true));
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.redact_encrypted_notification_preview() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_redact_encrypted_notification_preview ON public.notifications;
CREATE TRIGGER trg_redact_encrypted_notification_preview
    BEFORE INSERT ON public.notifications
    FOR EACH ROW
    EXECUTE FUNCTION public.redact_encrypted_notification_preview();

-- get_user_conversations(): baseline body plus last_message.encrypted.
CREATE OR REPLACE FUNCTION public.get_user_conversations()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
WITH me AS (
    SELECT public.get_current_profile_id() AS id
),
parts AS (
    SELECT
        cp.conversation_id,
        cp.role,
        cp.joined_at,
        cp.hidden_at,
        c.created_at,
        c.updated_at,
        c.type,
        c.name,
        c.created_by,
        c.is_active,
        c.metadata
    FROM public.conversation_participants cp
    JOIN public.conversations c ON c.id = cp.conversation_id
    WHERE cp.user_id = (SELECT id FROM me)
      AND cp.left_at IS NULL
)
SELECT COALESCE(
    jsonb_agg(
        jsonb_build_object(
            'conversation_id', p.conversation_id,
            'created_at', p.created_at,
            'updated_at', p.updated_at,
            'type', COALESCE(p.type, 'direct'),
            'name', p.name,
            'created_by', p.created_by,
            'is_active', p.is_active,
            'metadata', p.metadata,
            'hidden_at', p.hidden_at,
            'user_role', p.role,
            'user_joined_at', p.joined_at,
            'other_participants', COALESCE(op.others, '[]'::jsonb),
            'last_message', CASE WHEN lm.id IS NULL THEN NULL ELSE
                jsonb_build_object(
                    'id', lm.id,
                    'user_id', lm.user_id,
                    'content', lm.content,
                    'encrypted', COALESCE(lm.encrypted, false),
                    'created_at', lm.created_at,
                    'metadata', lm.metadata
                ) END,
            'unread_messages', COALESCE(uc.unread_messages, 0),
            'unread_mentions', COALESCE(uc.unread_mentions, 0),
            'is_muted', COALESCE(nc.muted, false)
        )
        ORDER BY COALESCE(lm.created_at, p.updated_at, p.created_at) DESC
    ),
    '[]'::jsonb
)
FROM parts p
LEFT JOIN LATERAL (
    SELECT m.id, m.user_id, m.content, m.encrypted, m.created_at, m.metadata
    FROM public.messages m
    WHERE m.conversation_id = p.conversation_id
    ORDER BY m.created_at DESC
    LIMIT 1
) lm ON true
LEFT JOIN LATERAL (
    SELECT jsonb_agg(
        jsonb_build_object(
            'user_id', cp2.user_id,
            'role', cp2.role,
            'joined_at', cp2.joined_at,
            'profile', jsonb_build_object(
                'id', pr.id,
                'username', pr.username,
                'display_name', pr.display_name,
                'avatar_url', pr.avatar_url,
                'domain', pr.domain,
                'is_local', pr.is_local,
                'federated_id', pr.federated_id
            )
        )
        ORDER BY cp2.joined_at ASC
    ) AS others
    FROM public.conversation_participants cp2
    JOIN public.profiles pr ON pr.id = cp2.user_id
    WHERE cp2.conversation_id = p.conversation_id
      AND cp2.user_id <> (SELECT id FROM me)
      AND cp2.left_at IS NULL
) op ON true
LEFT JOIN LATERAL (
    SELECT u.unread_messages, u.unread_mentions
    FROM public.unread_counts u
    WHERE u.conversation_id = p.conversation_id
      AND u.user_id = (SELECT id FROM me)
    LIMIT 1
) uc ON true
LEFT JOIN LATERAL (
    SELECT n.muted
    FROM public.notification_channels n
    WHERE n.conversation_id = p.conversation_id
      AND n.user_id = (SELECT id FROM me)
      AND n.channel_id IS NULL
    LIMIT 1
) nc ON true
$$;

-- ---------------------------------------------------------------------------
-- Federation
-- ---------------------------------------------------------------------------

-- Baseline body plus the encrypted-channel skip.
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_author_is_local BOOLEAN;
BEGIN
    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        IF NEW.metadata ? 'federated' THEN
            NEW.federation_status := 'skipped';
            RETURN NEW;
        END IF;

        IF NEW.encrypted IS TRUE OR public.channel_messages_encrypted(NEW.channel_id) THEN
            NEW.federation_status := 'skipped';
            RETURN NEW;
        END IF;

        SELECT is_local INTO v_author_is_local
        FROM public.profiles
        WHERE id = NEW.user_id;

        IF v_author_is_local IS NOT TRUE THEN
            NEW.federation_status := 'skipped';
            RETURN NEW;
        END IF;

        SELECT c.server_id, s.is_local_server
        INTO v_server_id, v_server_is_local
        FROM public.channels c
        JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;

        NEW.federation_status := 'queued';

        PERFORM public.queue_federation_job(
            'federate-channel-message',
            jsonb_build_object(
                'type', 'create',
                'message_id', NEW.id,
                'channel_id', NEW.channel_id,
                'user_id', NEW.user_id,
                'server_id', v_server_id,
                'server_is_local', COALESCE(v_server_is_local, true),
                'created_at', NEW.created_at
            ),
            5, 5, 900
        );
    END IF;

    RETURN NEW;
END;
$$;

-- Baseline body plus the encrypted-channel skip.
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_edit_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_federation_enabled BOOLEAN;
    v_author_is_local BOOLEAN;
BEGIN
    IF current_setting('harmony.silent_content_update', true) = 'true' THEN
        RETURN NEW;
    END IF;

    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        IF OLD.content IS NOT DISTINCT FROM NEW.content THEN RETURN NEW; END IF;

        IF NEW.encrypted IS TRUE OR OLD.encrypted IS TRUE
           OR public.channel_messages_encrypted(NEW.channel_id) THEN
            RETURN NEW;
        END IF;

        SELECT c.server_id, s.is_local_server, s.federation_enabled
        INTO v_server_id, v_server_is_local, v_federation_enabled
        FROM public.channels c JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;

        IF v_server_is_local IS TRUE THEN
            IF v_federation_enabled IS NOT TRUE THEN RETURN NEW; END IF;
        ELSE
            IF NEW.metadata ? 'federated' THEN RETURN NEW; END IF;
            SELECT is_local INTO v_author_is_local FROM public.profiles WHERE id = NEW.user_id;
            IF v_author_is_local IS NOT TRUE THEN RETURN NEW; END IF;
        END IF;

        PERFORM public.queue_federation_job(
            'federate-channel-message-edit',
            jsonb_build_object(
                'type', 'update',
                'message_id', NEW.id,
                'channel_id', NEW.channel_id,
                'user_id', NEW.user_id,
                'server_id', v_server_id,
                'server_is_local', COALESCE(v_server_is_local, true)
            ), 5, 5, 900
        );
    END IF;
    RETURN NEW;
END;
$$;

-- Baseline body plus the skip for rows that never left the instance.
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_delete_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_federation_enabled BOOLEAN;
    v_author_is_local BOOLEAN;
BEGIN
    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        IF OLD.is_deleted = TRUE OR NEW.is_deleted = FALSE THEN RETURN NEW; END IF;

        IF NEW.federation_status = 'skipped'
           AND NOT (NEW.metadata ? 'federated')
           AND (NEW.encrypted IS TRUE OR public.channel_messages_encrypted(NEW.channel_id)) THEN
            RETURN NEW;
        END IF;

        SELECT c.server_id, s.is_local_server, s.federation_enabled
        INTO v_server_id, v_server_is_local, v_federation_enabled
        FROM public.channels c JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;

        IF v_server_is_local IS TRUE THEN
            IF v_federation_enabled IS NOT TRUE THEN RETURN NEW; END IF;
        ELSE
            IF NEW.metadata ? 'federated' THEN RETURN NEW; END IF;
            SELECT is_local INTO v_author_is_local FROM public.profiles WHERE id = NEW.user_id;
            IF v_author_is_local IS NOT TRUE THEN RETURN NEW; END IF;
        END IF;

        PERFORM public.queue_federation_job(
            'federate-channel-message-delete',
            jsonb_build_object(
                'type', 'delete',
                'message_id', NEW.id,
                'channel_id', NEW.channel_id,
                'user_id', NEW.user_id,
                'ap_id', NEW.metadata->>'ap_id',
                'server_id', v_server_id,
                'server_is_local', COALESCE(v_server_is_local, true)
            ), 5, 5, 900
        );
    END IF;
    RETURN NEW;
END;
$$;

-- Baseline body plus the skip for reactions on withheld messages. 'skipped' keeps the row out
-- of the pending-reaction sweep.
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_reaction_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_user_is_local BOOLEAN;
    v_is_channel_message BOOLEAN;
    v_withheld BOOLEAN;
BEGIN
    SELECT (channel_id IS NOT NULL AND conversation_id IS NULL),
           (encrypted IS TRUE OR public.channel_messages_encrypted(channel_id))
      INTO v_is_channel_message, v_withheld
      FROM public.messages WHERE id = NEW.message_id;

    IF v_is_channel_message IS TRUE AND v_withheld IS TRUE THEN
        NEW.federation_status := 'skipped';
        RETURN NEW;
    END IF;

    SELECT is_local INTO v_user_is_local FROM public.profiles WHERE id = NEW.user_id;
    IF v_user_is_local IS NOT TRUE THEN RETURN NEW; END IF;

    IF v_is_channel_message IS NOT TRUE THEN RETURN NEW; END IF;

    IF NEW.metadata ? 'federated' THEN RETURN NEW; END IF;

    NEW.federation_status := 'queued';
    PERFORM public.queue_federation_job(
        'federate-channel-reaction',
        jsonb_build_object(
            'type', 'create',
            'reaction_id', NEW.id,
            'message_id', NEW.message_id,
            'user_id', NEW.user_id,
            'emoji_id', NEW.emoji_id,
            'custom_emoji_content', NEW.custom_emoji_content
        ), 5, 3, 1800
    );
    RETURN NEW;
END;
$$;

-- Baseline body plus the skip for reactions on withheld messages.
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_reaction_delete_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_user_is_local BOOLEAN;
    v_is_channel_message BOOLEAN;
    v_withheld BOOLEAN;
BEGIN
    SELECT is_local INTO v_user_is_local FROM public.profiles WHERE id = OLD.user_id;
    IF v_user_is_local IS NOT TRUE THEN RETURN OLD; END IF;

    SELECT (channel_id IS NOT NULL AND conversation_id IS NULL),
           (encrypted IS TRUE OR public.channel_messages_encrypted(channel_id))
      INTO v_is_channel_message, v_withheld
      FROM public.messages WHERE id = OLD.message_id;
    IF v_is_channel_message IS NOT TRUE THEN RETURN OLD; END IF;
    IF v_withheld IS TRUE THEN RETURN OLD; END IF;

    IF OLD.metadata ? 'federated' THEN RETURN OLD; END IF;

    PERFORM public.queue_federation_job(
        'federate-channel-reaction',
        jsonb_build_object(
            'type', 'delete',
            'reaction_id', OLD.id,
            'message_id', OLD.message_id,
            'user_id', OLD.user_id,
            'emoji_id', OLD.emoji_id,
            'custom_emoji_content', OLD.custom_emoji_content
        ), 5, 3, 1800
    );
    RETURN OLD;
END;
$$;

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------

SELECT public.seed_channel_encryption_settings(ARRAY(SELECT id FROM public.channels));

COMMIT;

NOTIFY pgrst, 'reload schema';
