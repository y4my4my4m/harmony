-- What a server's home instance says of its channels, kept on its copies, and voice encryption
-- closed to accounts from other instances.
--
-- channels.host_flags          {"messages": true, "voice": true, "private": true}
-- channel_categories.host_flags  {"private": true}
--   A key is absent when false; '{}' on every local row. Set by the service role from
--   harmony:encryption and harmony:private of the Group's documents and activities. A client
--   write is discarded by guard_channel_client_write and guard_category_client_write.
--   Not mirrored into channel_encryption_settings, where a client would encrypt to local members
--   only, nor into overrides, where an @everyone deny on a copy hides the channel.
--
-- channel_voice_encrypted(channel)
--   effective_channel_encryption's voice_encrypted, with no caller.
-- channel_host_flags(channels[]) -> (channel_id, messages, voice, is_private)
-- category_host_flags(categories[]) -> (category_id, is_private)
--   The values a document carries. messages is channel_messages_encrypted; voice holds for a voice
--   channel (type 1) alone; is_private is an @everyone override denying VIEW_CHANNEL (bit 1), the
--   test useServerChannel applies to a local server.
--
-- voice_participant_grants: a remote profile in a voice-encrypted channel is refused, reason
--   'voice is end-to-end encrypted', after the checks that name no channel state: no key reaches
--   another instance (no Megolm session, no key envelope), so its audio crosses the SFU in
--   plaintext. The string equals VOICE_ENCRYPTED_REFUSAL in federation-backend voiceAccess.ts.
--
-- Voice grants. A channel row turning voice_encrypted on, or a server's voice_encryption_mode
--   changing, queues voice_grants_changed: the worker removes remote participants.
--
-- Signalling. The settings and override tables are outside the supabase_realtime publication, so
--   each change queues federate-channel-crud or federate-category-crud, type update, for a local
--   federated server:
--     channel_encryption_settings            messages_encrypted or voice_encrypted changed
--     server_encryption_settings             encryption_mode or voice_encryption_mode changed:
--                                            one job per channel of the server
--     channel_permission_overrides           @everyone's VIEW_CHANNEL deny changed
--     channel_category_permission_overrides  same, for the category
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

ALTER TABLE public.channels
    ADD COLUMN IF NOT EXISTS host_flags jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.channel_categories
    ADD COLUMN IF NOT EXISTS host_flags jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.channels.host_flags IS
    'A copy''s channel as its home instance describes it: messages, voice, private; a key is absent when false.';
COMMENT ON COLUMN public.channel_categories.host_flags IS
    'A copy''s category as its home instance describes it: private; absent when false.';

-- As 20261005650001; host_flags is fixed, and '{}' on a client's new row.
CREATE OR REPLACE FUNCTION public.guard_channel_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_fixed CONSTANT text[] := ARRAY['ap_id', 'is_remote', 'federation_status', 'created_at', 'host_flags'];
    v_old jsonb;
    v_keep jsonb;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.ap_id IS NOT NULL OR NEW.is_remote IS TRUE THEN
            RAISE EXCEPTION 'remote channels arrive through federation' USING ERRCODE = '42501';
        END IF;
        NEW.created_at := now();
        NEW.host_flags := '{}'::jsonb;
        RETURN NEW;
    END IF;

    IF NEW.server_id IS DISTINCT FROM OLD.server_id THEN
        RAISE EXCEPTION 'a channel stays in its server' USING ERRCODE = '42501';
    END IF;

    v_old := to_jsonb(OLD);
    SELECT jsonb_object_agg(k, v_old -> k) INTO v_keep
      FROM unnest(v_fixed) k
     WHERE v_old ? k;
    IF v_keep IS NOT NULL THEN
        NEW := jsonb_populate_record(NEW, v_keep);
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_channel_client_write() FROM PUBLIC, anon, authenticated;

-- As 20261005650001; host_flags is fixed, and '{}' on a client's new row, so the guard also runs
-- on INSERT.
CREATE OR REPLACE FUNCTION public.guard_category_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        NEW.host_flags := '{}'::jsonb;
        RETURN NEW;
    END IF;
    IF NEW.server_id IS DISTINCT FROM OLD.server_id THEN
        RAISE EXCEPTION 'a category stays in its server' USING ERRCODE = '42501';
    END IF;
    NEW.host_flags := OLD.host_flags;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_category_client_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_channel_categories_client_write_guard ON public.channel_categories;
CREATE TRIGGER a_channel_categories_client_write_guard
    BEFORE INSERT OR UPDATE ON public.channel_categories
    FOR EACH ROW EXECUTE FUNCTION public.guard_category_client_write();

-- ---------------------------------------------------------------------------
-- The values a document carries
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.channel_voice_encrypted(p_channel_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE((
        SELECT COALESCE(ses.voice_encryption_mode, 'disabled') = 'required'
               OR COALESCE(ces.voice_encrypted, false)
          FROM public.channels c
          LEFT JOIN public.server_encryption_settings ses ON ses.server_id = c.server_id
          LEFT JOIN public.channel_encryption_settings ces ON ces.channel_id = c.id
         WHERE c.id = p_channel_id
    ), false);
$$;

REVOKE ALL ON FUNCTION public.channel_voice_encrypted(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.channel_voice_encrypted(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.channel_host_flags(p_channel_ids uuid[])
RETURNS TABLE (channel_id uuid, messages boolean, voice boolean, is_private boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT c.id,
           public.channel_messages_encrypted(c.id),
           c.type = 1 AND public.channel_voice_encrypted(c.id),
           EXISTS (SELECT 1
                     FROM public.channel_permission_overrides o
                     JOIN public.server_roles r ON r.id = o.role_id AND r.is_default
                    WHERE o.channel_id = c.id
                      AND (o.deny_permissions & 2) <> 0)
      FROM public.channels c
     WHERE c.id = ANY (p_channel_ids);
$$;

REVOKE ALL ON FUNCTION public.channel_host_flags(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.channel_host_flags(uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public.category_host_flags(p_category_ids uuid[])
RETURNS TABLE (category_id uuid, is_private boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT cc.id,
           EXISTS (SELECT 1
                     FROM public.channel_category_permission_overrides o
                     JOIN public.server_roles r ON r.id = o.role_id AND r.is_default
                    WHERE o.category_id = cc.id
                      AND (o.deny_permissions & 2) <> 0)
      FROM public.channel_categories cc
     WHERE cc.id = ANY (p_category_ids);
$$;

REVOKE ALL ON FUNCTION public.category_host_flags(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.category_host_flags(uuid[]) TO service_role;

-- ---------------------------------------------------------------------------
-- Voice grants
-- ---------------------------------------------------------------------------

-- As 20261017100005, with the encryption refusal. Mirrors federation-backend
-- authorizeVoiceChannel (voiceAccess.ts) for many pairs: reason is its refusal, NULL when
-- admitted. A profile with is_local false is a remote actor.
CREATE OR REPLACE FUNCTION public.voice_participant_grants(p_channels uuid[], p_users uuid[])
RETURNS TABLE (
    channel_id uuid,
    user_id uuid,
    reason text,
    can_speak boolean,
    can_stream boolean,
    can_soundboard boolean,
    can_external_sounds boolean,
    server_muted boolean,
    server_deafened boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH pairs AS (
        SELECT DISTINCT t.c AS channel_id, t.u AS user_id
          FROM unnest(p_channels, p_users) AS t(c, u)
         WHERE t.c IS NOT NULL AND t.u IS NOT NULL
    ), facts AS (
        SELECT p.channel_id, p.user_id, ch.server_id, s.id AS found_server,
               s.is_local_server, s.federation_enabled,
               pr.is_local IS FALSE AS remote,
               s.owner IS NOT DISTINCT FROM p.user_id AS is_owner,
               EXISTS (SELECT 1 FROM public.user_servers us
                        WHERE us.server_id = ch.server_id AND us.user_id = p.user_id AND us.status = 'accepted') AS accepted,
               EXISTS (SELECT 1 FROM public.server_bans b
                        WHERE b.server_id = ch.server_id AND b.user_id = p.user_id) AS banned,
               EXISTS (SELECT 1 FROM public.server_member_timeouts t
                        WHERE t.server_id = ch.server_id AND t.user_id = p.user_id AND t.until > now()) AS timed_out,
               EXISTS (SELECT 1 FROM public.voice_move_grants g
                        WHERE g.server_id = ch.server_id AND g.user_id = p.user_id
                          AND g.channel_id = p.channel_id AND g.expires_at > now()) AS moved_here,
               COALESCE(m.muted, false) AS muted,
               COALESCE(m.deafened, false) AS deafened,
               COALESCE(ses.voice_encryption_mode, 'disabled') = 'required'
                   OR COALESCE(ces.voice_encrypted, false) AS voice_encrypted,
               CASE WHEN s.id IS NULL THEN '{}'::jsonb
                    ELSE public.get_user_permissions(p.user_id, ch.server_id, p.channel_id) END AS perms
          FROM pairs p
          LEFT JOIN public.channels ch ON ch.id = p.channel_id
          LEFT JOIN public.servers s ON s.id = ch.server_id
          LEFT JOIN public.profiles pr ON pr.id = p.user_id
          LEFT JOIN public.server_voice_moderation m ON m.server_id = ch.server_id AND m.user_id = p.user_id
          LEFT JOIN public.server_encryption_settings ses ON ses.server_id = ch.server_id
          LEFT JOIN public.channel_encryption_settings ces ON ces.channel_id = p.channel_id
    ), decided AS (
        SELECT f.*,
               CASE
                   WHEN f.server_id IS NULL THEN 'channel not found'
                   WHEN f.found_server IS NULL THEN 'server not found'
                   WHEN f.remote AND f.is_local_server IS FALSE THEN 'server is not hosted here'
                   WHEN f.remote AND f.federation_enabled IS NOT TRUE THEN 'federation is disabled on the server'
                   WHEN NOT f.is_owner AND NOT f.accepted THEN 'not an accepted member'
                   WHEN NOT f.is_owner AND f.banned THEN 'banned'
                   WHEN NOT f.is_owner AND f.timed_out THEN 'timed out'
                   WHEN (f.perms ->> 'VIEW_CHANNEL') IS DISTINCT FROM 'true' THEN 'missing VIEW_CHANNEL'
                   WHEN (f.perms ->> 'CONNECT') IS DISTINCT FROM 'true' AND NOT f.moved_here THEN 'missing CONNECT'
                   WHEN f.remote AND f.voice_encrypted THEN 'voice is end-to-end encrypted'
               END AS refusal,
               (f.perms ->> 'SPEAK') = 'true' AND NOT f.muted AND NOT f.deafened AS speak
          FROM facts f
    )
    SELECT d.channel_id, d.user_id, d.refusal,
           d.refusal IS NULL AND d.speak,
           d.refusal IS NULL AND (d.perms ->> 'STREAM') = 'true',
           d.refusal IS NULL AND d.speak AND (d.perms ->> 'USE_SOUNDBOARD') = 'true',
           d.refusal IS NULL AND d.speak AND (d.perms ->> 'USE_SOUNDBOARD') = 'true'
               AND (d.perms ->> 'USE_EXTERNAL_SOUNDS') = 'true',
           d.muted, d.deafened
      FROM decided d;
$$;

REVOKE ALL ON FUNCTION public.voice_participant_grants(uuid[], uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voice_participant_grants(uuid[], uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public.voice_grants_on_channel_encryption()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server uuid;
BEGIN
    IF NOT COALESCE(NEW.voice_encrypted, false)
       OR (TG_OP = 'UPDATE' AND OLD.voice_encrypted IS NOT DISTINCT FROM NEW.voice_encrypted) THEN
        RETURN NULL;
    END IF;
    SELECT c.server_id INTO v_server FROM public.channels c WHERE c.id = NEW.channel_id;
    PERFORM public.voice_grants_changed(v_server, NEW.channel_id, NULL);
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.voice_grants_on_channel_encryption() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS z_channel_encryption_voice_grants ON public.channel_encryption_settings;
CREATE TRIGGER z_channel_encryption_voice_grants
    AFTER INSERT OR UPDATE ON public.channel_encryption_settings
    FOR EACH ROW EXECUTE FUNCTION public.voice_grants_on_channel_encryption();

CREATE OR REPLACE FUNCTION public.voice_grants_on_server_encryption()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.voice_encryption_mode IS DISTINCT FROM 'required'
       OR (TG_OP = 'UPDATE' AND OLD.voice_encryption_mode IS NOT DISTINCT FROM NEW.voice_encryption_mode) THEN
        RETURN NULL;
    END IF;
    PERFORM public.voice_grants_changed(NEW.server_id, NULL, NULL);
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.voice_grants_on_server_encryption() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS z_server_encryption_voice_grants ON public.server_encryption_settings;
CREATE TRIGGER z_server_encryption_voice_grants
    AFTER INSERT OR UPDATE ON public.server_encryption_settings
    FOR EACH ROW EXECUTE FUNCTION public.voice_grants_on_server_encryption();

-- ---------------------------------------------------------------------------
-- Signalling
-- ---------------------------------------------------------------------------

-- A row with both off says nothing new on INSERT: a channel's own Add carries its state.
CREATE OR REPLACE FUNCTION public.federate_channel_encryption()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_channel record;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NOT (COALESCE(NEW.messages_encrypted, false) OR COALESCE(NEW.voice_encrypted, false)) THEN
            RETURN NULL;
        END IF;
    ELSIF OLD.messages_encrypted IS NOT DISTINCT FROM NEW.messages_encrypted
          AND OLD.voice_encrypted IS NOT DISTINCT FROM NEW.voice_encrypted THEN
        RETURN NULL;
    END IF;

    SELECT c.id, c.server_id INTO v_channel
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id
     WHERE c.id = NEW.channel_id
       AND c.is_remote IS NOT TRUE
       AND s.is_local_server IS TRUE
       AND s.federation_enabled IS TRUE;
    IF FOUND THEN
        PERFORM public.queue_federation_job('federate-channel-crud', jsonb_build_object(
            'type', 'update', 'channel_id', v_channel.id, 'server_id', v_channel.server_id), 5, 5, 900);
    END IF;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.federate_channel_encryption() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trigger_federate_channel_encryption ON public.channel_encryption_settings;
CREATE TRIGGER trigger_federate_channel_encryption
    AFTER INSERT OR UPDATE ON public.channel_encryption_settings
    FOR EACH ROW EXECUTE FUNCTION public.federate_channel_encryption();

CREATE OR REPLACE FUNCTION public.federate_server_encryption()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_channel uuid;
BEGIN
    IF TG_OP = 'UPDATE'
       AND OLD.encryption_mode IS NOT DISTINCT FROM NEW.encryption_mode
       AND OLD.voice_encryption_mode IS NOT DISTINCT FROM NEW.voice_encryption_mode THEN
        RETURN NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.servers s
                    WHERE s.id = NEW.server_id AND s.is_local_server IS TRUE AND s.federation_enabled IS TRUE) THEN
        RETURN NULL;
    END IF;

    FOR v_channel IN
        SELECT c.id FROM public.channels c WHERE c.server_id = NEW.server_id AND c.is_remote IS NOT TRUE
    LOOP
        PERFORM public.queue_federation_job('federate-channel-crud', jsonb_build_object(
            'type', 'update', 'channel_id', v_channel, 'server_id', NEW.server_id), 5, 5, 900);
    END LOOP;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.federate_server_encryption() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trigger_federate_server_encryption ON public.server_encryption_settings;
CREATE TRIGGER trigger_federate_server_encryption
    AFTER INSERT OR UPDATE ON public.server_encryption_settings
    FOR EACH ROW EXECUTE FUNCTION public.federate_server_encryption();

-- A cascade from the channel or the role finds neither: nothing is left to describe.
CREATE OR REPLACE FUNCTION public.federate_channel_private()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_was boolean := TG_OP <> 'INSERT' AND (OLD.deny_permissions & 2) <> 0;
    v_is boolean := TG_OP <> 'DELETE' AND (NEW.deny_permissions & 2) <> 0;
    v_role uuid;
    v_channel uuid;
    v_server uuid;
BEGIN
    IF v_was = v_is THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'DELETE' THEN
        v_role := OLD.role_id;
        v_channel := OLD.channel_id;
    ELSE
        v_role := NEW.role_id;
        v_channel := NEW.channel_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.server_roles r WHERE r.id = v_role AND r.is_default) THEN
        RETURN NULL;
    END IF;

    SELECT c.server_id INTO v_server
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id
     WHERE c.id = v_channel
       AND c.is_remote IS NOT TRUE
       AND s.is_local_server IS TRUE
       AND s.federation_enabled IS TRUE;
    IF FOUND THEN
        PERFORM public.queue_federation_job('federate-channel-crud', jsonb_build_object(
            'type', 'update', 'channel_id', v_channel, 'server_id', v_server), 5, 5, 900);
    END IF;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.federate_channel_private() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trigger_federate_channel_private ON public.channel_permission_overrides;
CREATE TRIGGER trigger_federate_channel_private
    AFTER INSERT OR UPDATE OR DELETE ON public.channel_permission_overrides
    FOR EACH ROW EXECUTE FUNCTION public.federate_channel_private();

CREATE OR REPLACE FUNCTION public.federate_category_private()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_was boolean := TG_OP <> 'INSERT' AND (OLD.deny_permissions & 2) <> 0;
    v_is boolean := TG_OP <> 'DELETE' AND (NEW.deny_permissions & 2) <> 0;
    v_role uuid;
    v_category uuid;
    v_server uuid;
BEGIN
    IF v_was = v_is THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'DELETE' THEN
        v_role := OLD.role_id;
        v_category := OLD.category_id;
    ELSE
        v_role := NEW.role_id;
        v_category := NEW.category_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.server_roles r WHERE r.id = v_role AND r.is_default) THEN
        RETURN NULL;
    END IF;

    SELECT cc.server_id INTO v_server
      FROM public.channel_categories cc
      JOIN public.servers s ON s.id = cc.server_id
     WHERE cc.id = v_category
       AND s.is_local_server IS TRUE
       AND s.federation_enabled IS TRUE;
    IF FOUND THEN
        PERFORM public.queue_federation_job('federate-category-crud', jsonb_build_object(
            'type', 'update', 'category_id', v_category, 'server_id', v_server), 5, 5, 900);
    END IF;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.federate_category_private() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trigger_federate_category_private ON public.channel_category_permission_overrides;
CREATE TRIGGER trigger_federate_category_private
    AFTER INSERT OR UPDATE OR DELETE ON public.channel_category_permission_overrides
    FOR EACH ROW EXECUTE FUNCTION public.federate_category_private();

-- As 20261106200001, with the four triggers above.
CREATE OR REPLACE FUNCTION public.enable_federation_triggers()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    ALTER TABLE public.posts ENABLE TRIGGER trigger_federate_post;
    ALTER TABLE public.post_interactions ENABLE TRIGGER trigger_federate_post_interaction;
    ALTER TABLE public.post_interactions ENABLE TRIGGER trigger_federate_post_interaction_delete;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow_delete;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow_response;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_dm;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message_edit;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message_delete;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_message_reaction;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_message_reaction_delete;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_channel_reaction;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_channel_reaction_delete;
    ALTER TABLE public.user_blocks ENABLE TRIGGER trigger_federate_block;
    ALTER TABLE public.user_blocks ENABLE TRIGGER trigger_federate_block_delete;
    ALTER TABLE public.reports ENABLE TRIGGER trigger_federate_report;
    ALTER TABLE public.reports ENABLE TRIGGER trigger_federate_report_resolution;
    ALTER TABLE public.profiles ENABLE TRIGGER trigger_federate_profile;
    ALTER TABLE public.threads ENABLE TRIGGER trigger_federate_thread;
    ALTER TABLE public.threads ENABLE TRIGGER trigger_federate_thread_delete;
    ALTER TABLE public.voice_channel_participants ENABLE TRIGGER trigger_federate_voice_channel_join;
    ALTER TABLE public.voice_channel_participants ENABLE TRIGGER trigger_federate_voice_channel_leave;
    ALTER TABLE public.channels ENABLE TRIGGER trigger_federate_channel;
    ALTER TABLE public.channels ENABLE TRIGGER trigger_federate_channel_delete;
    ALTER TABLE public.channel_categories ENABLE TRIGGER trigger_federate_category;
    ALTER TABLE public.channel_categories ENABLE TRIGGER trigger_federate_category_delete;
    ALTER TABLE public.servers ENABLE TRIGGER trigger_federate_server_update;
    ALTER TABLE public.conversation_participants ENABLE TRIGGER trg_group_participant_left;
    ALTER TABLE public.conversation_participants ENABLE TRIGGER trg_conversation_participant_added;
    ALTER TABLE public.server_voice_moderation ENABLE TRIGGER z_server_voice_moderation_federate;
    ALTER TABLE public.federation_member_removals ENABLE TRIGGER trigger_federate_member_removal;
    ALTER TABLE public.messages ENABLE TRIGGER z_messages_pin_federation;
    ALTER TABLE public.server_roles ENABLE TRIGGER z_server_roles_federation;
    ALTER TABLE public.user_roles ENABLE TRIGGER z_user_roles_federation;
    ALTER TABLE public.channel_encryption_settings ENABLE TRIGGER trigger_federate_channel_encryption;
    ALTER TABLE public.server_encryption_settings ENABLE TRIGGER trigger_federate_server_encryption;
    ALTER TABLE public.channel_permission_overrides ENABLE TRIGGER trigger_federate_channel_private;
    ALTER TABLE public.channel_category_permission_overrides ENABLE TRIGGER trigger_federate_category_private;
    RAISE NOTICE 'All federation triggers enabled';
END;
$$;

REVOKE ALL ON FUNCTION public.enable_federation_triggers() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.disable_federation_triggers()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    ALTER TABLE public.posts DISABLE TRIGGER trigger_federate_post;
    ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_federate_post_interaction;
    ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_federate_post_interaction_delete;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow_delete;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow_response;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_dm;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message_edit;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message_delete;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_message_reaction;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_message_reaction_delete;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_channel_reaction;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_channel_reaction_delete;
    ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block;
    ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block_delete;
    ALTER TABLE public.reports DISABLE TRIGGER trigger_federate_report;
    ALTER TABLE public.reports DISABLE TRIGGER trigger_federate_report_resolution;
    ALTER TABLE public.profiles DISABLE TRIGGER trigger_federate_profile;
    ALTER TABLE public.threads DISABLE TRIGGER trigger_federate_thread;
    ALTER TABLE public.threads DISABLE TRIGGER trigger_federate_thread_delete;
    ALTER TABLE public.voice_channel_participants DISABLE TRIGGER trigger_federate_voice_channel_join;
    ALTER TABLE public.voice_channel_participants DISABLE TRIGGER trigger_federate_voice_channel_leave;
    ALTER TABLE public.channels DISABLE TRIGGER trigger_federate_channel;
    ALTER TABLE public.channels DISABLE TRIGGER trigger_federate_channel_delete;
    ALTER TABLE public.channel_categories DISABLE TRIGGER trigger_federate_category;
    ALTER TABLE public.channel_categories DISABLE TRIGGER trigger_federate_category_delete;
    ALTER TABLE public.servers DISABLE TRIGGER trigger_federate_server_update;
    ALTER TABLE public.conversation_participants DISABLE TRIGGER trg_group_participant_left;
    ALTER TABLE public.conversation_participants DISABLE TRIGGER trg_conversation_participant_added;
    ALTER TABLE public.server_voice_moderation DISABLE TRIGGER z_server_voice_moderation_federate;
    ALTER TABLE public.federation_member_removals DISABLE TRIGGER trigger_federate_member_removal;
    ALTER TABLE public.messages DISABLE TRIGGER z_messages_pin_federation;
    ALTER TABLE public.server_roles DISABLE TRIGGER z_server_roles_federation;
    ALTER TABLE public.user_roles DISABLE TRIGGER z_user_roles_federation;
    ALTER TABLE public.channel_encryption_settings DISABLE TRIGGER trigger_federate_channel_encryption;
    ALTER TABLE public.server_encryption_settings DISABLE TRIGGER trigger_federate_server_encryption;
    ALTER TABLE public.channel_permission_overrides DISABLE TRIGGER trigger_federate_channel_private;
    ALTER TABLE public.channel_category_permission_overrides DISABLE TRIGGER trigger_federate_category_private;
    RAISE NOTICE 'All federation triggers disabled';
END;
$$;

REVOKE ALL ON FUNCTION public.disable_federation_triggers() FROM PUBLIC, anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
