-- Generic bridge registration and native-member consent. Discord v2/legacy stays in its own tables.
-- Fresh installs replay migrations too; there is no separate init/ schema.
BEGIN;

ALTER TABLE public.user_servers ADD COLUMN bridge_opt_out boolean NOT NULL DEFAULT false;
-- Keep protocol identity even after every Matrix channel has been unpaired/deleted.
ALTER TABLE public.bots ADD COLUMN bridge_platform text CHECK (bridge_platform IN ('matrix'));

CREATE TABLE public.bridge_channels (
    bot_id uuid NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
    channel_id uuid NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
    platform text NOT NULL CHECK (platform = 'matrix'),
    PRIMARY KEY (bot_id, channel_id)
);
ALTER TABLE public.bridge_channels ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bridge_channels FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.bridge_channels TO service_role;
CREATE POLICY bridge_channels_service ON public.bridge_channels TO service_role USING (true) WITH CHECK (true);
GRANT SELECT ON public.bridge_channels TO authenticated;
CREATE POLICY bridge_channels_manager ON public.bridge_channels FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.channels c WHERE c.id = channel_id
                   AND public.can_manage_discord_bridge(c.server_id)));

CREATE FUNCTION public.guard_bridge_preferences()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME = 'user_servers' THEN
        IF (TG_OP = 'INSERT' AND NEW.bridge_opt_out)
           OR (TG_OP = 'UPDATE' AND NEW.bridge_opt_out IS DISTINCT FROM OLD.bridge_opt_out) THEN
            RAISE EXCEPTION 'bridge_opt_out is set through set_server_bridge_opt_out' USING ERRCODE = '42501';
        END IF;
    ELSE
        IF (TG_OP = 'INSERT' AND NEW.bridge_platform IS NOT NULL)
           OR (TG_OP = 'UPDATE' AND (NEW.bridge_platform IS DISTINCT FROM OLD.bridge_platform
               OR (OLD.bridge_platform = 'matrix' AND NEW.bot_type IS DISTINCT FROM 'bridge'))) THEN
            RAISE EXCEPTION 'bridge_platform is set through configure_matrix_bridge' USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER a_bridge_preference_guard BEFORE INSERT OR UPDATE ON public.user_servers
    FOR EACH ROW EXECUTE FUNCTION public.guard_bridge_preferences();
CREATE TRIGGER a_bridge_platform_guard BEFORE INSERT OR UPDATE ON public.bots
    FOR EACH ROW EXECUTE FUNCTION public.guard_bridge_preferences();
REVOKE ALL ON FUNCTION public.guard_bridge_preferences() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.get_server_bridge_opt_out(p_server_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_value boolean;
BEGIN
    SELECT us.bridge_opt_out INTO v_value FROM public.user_servers us
     WHERE us.server_id = p_server_id AND us.user_id = public.get_current_profile_id() AND us.status = 'accepted';
    IF NOT FOUND THEN RAISE EXCEPTION 'Accepted membership required' USING ERRCODE = '42501'; END IF;
    RETURN v_value;
END;
$$;

CREATE FUNCTION public.set_server_bridge_opt_out(p_server_id uuid, p_opt_out boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF p_opt_out IS NULL THEN RAISE EXCEPTION 'p_opt_out must be boolean' USING ERRCODE = '22023'; END IF;
    UPDATE public.user_servers SET bridge_opt_out = p_opt_out
     WHERE server_id = p_server_id AND user_id = public.get_current_profile_id() AND status = 'accepted';
    IF NOT FOUND THEN RAISE EXCEPTION 'Accepted membership required' USING ERRCODE = '42501'; END IF;
    RETURN p_opt_out;
END;
$$;

-- Replace the requested server's bindings; installs and bindings are both checked at delivery.
CREATE FUNCTION public.configure_matrix_bridge(p_bot_id uuid, p_server_id uuid, p_channel_ids uuid[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_install public.bot_server_permissions; v_bot public.bots;
BEGIN
    IF NOT public.can_manage_discord_bridge(p_server_id) THEN
        RAISE EXCEPTION 'MANAGE_SERVER required' USING ERRCODE = '42501';
    END IF;
    IF p_channel_ids IS NULL OR array_position(p_channel_ids, NULL) IS NOT NULL THEN
        RAISE EXCEPTION 'Channel IDs must be a nonnull array without null entries' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_bot FROM public.bots WHERE id = p_bot_id FOR UPDATE;
    IF NOT FOUND OR v_bot.is_active IS NOT TRUE THEN RAISE EXCEPTION 'Active bot required' USING ERRCODE = '22023'; END IF;
    IF EXISTS (SELECT 1 FROM public.discord_bridges WHERE bot_id = p_bot_id)
       OR (v_bot.bot_type = 'bridge' AND v_bot.bridge_platform IS NULL) THEN
        RAISE EXCEPTION 'Discord bridge cannot be converted to Matrix' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_install FROM public.bot_server_permissions
     WHERE bot_id = p_bot_id AND server_id = p_server_id AND is_active FOR UPDATE;
    IF NOT FOUND OR v_install.read_messages IS NOT TRUE OR v_install.send_messages IS NOT TRUE
       OR v_install.allowed_channel_ids IS NULL THEN
        RAISE EXCEPTION 'Active scoped read/send install required' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_channel_ids) input(channel_id)
                WHERE NOT COALESCE(input.channel_id = ANY(v_install.allowed_channel_ids), false)
                   OR NOT EXISTS (SELECT 1 FROM public.channels c WHERE c.id = input.channel_id AND c.server_id = p_server_id AND c.type = 0)) THEN
        RAISE EXCEPTION 'Channels must belong to the server and install allowlist' USING ERRCODE = '22023';
    END IF;
    UPDATE public.bots SET bot_type = 'bridge', bridge_platform = 'matrix' WHERE id = p_bot_id;
    DELETE FROM public.bridge_channels bc USING public.channels c
     WHERE bc.bot_id = p_bot_id AND c.id = bc.channel_id AND c.server_id = p_server_id;
    INSERT INTO public.bridge_channels(bot_id, channel_id, platform)
      SELECT p_bot_id, id, 'matrix' FROM unnest(p_channel_ids) id ON CONFLICT DO NOTHING;
    RETURN true;
END;
$$;

CREATE FUNCTION public.bridge_channel_platform(p_bot_id uuid, p_channel_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT CASE
      WHEN b.bridge_platform = 'matrix' THEN
        CASE WHEN EXISTS (SELECT 1 FROM public.bridge_channels bc
                           WHERE bc.bot_id = b.id AND bc.channel_id = c.id AND bc.platform = 'matrix') THEN 'matrix' END
      WHEN EXISTS (SELECT 1 FROM public.discord_bridges db WHERE db.bot_id = b.id) THEN
        CASE WHEN EXISTS (SELECT 1 FROM public.discord_bridges db
                           JOIN public.discord_bridge_channels dc ON dc.bridge_id = db.id
                          WHERE db.bot_id = b.id AND db.server_id = c.server_id AND dc.harmony_channel_id = c.id)
             THEN 'discord' END
      WHEN EXISTS (SELECT 1 FROM public.discord_bridge_pairings dp WHERE dp.server_id = c.server_id) THEN 'discord'
    END
    FROM public.bots b JOIN public.bot_server_permissions p ON p.bot_id = b.id
    JOIN public.channels c ON c.server_id = p.server_id
    WHERE b.id = p_bot_id AND c.id = p_channel_id AND b.is_active AND b.bot_type = 'bridge'
      AND p.is_active AND p.read_messages AND p.send_messages
      AND (p.allowed_channel_ids IS NULL OR c.id = ANY(p.allowed_channel_ids));
$$;

CREATE FUNCTION public.can_bridge_member_messages(p_bot_id uuid, p_channel_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT public.bridge_channel_platform(p_bot_id, p_channel_id) IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.user_servers us JOIN public.channels c ON c.server_id = us.server_id
                    WHERE c.id = p_channel_id AND us.user_id = p_user_id AND us.status = 'accepted' AND NOT us.bridge_opt_out);
$$;

-- Trusted interaction replies speak for their native invoker, not for their bot.
-- Pure extraction only: membership and consent are always queried by the recipient filters.
-- CASE protects the UUID cast even if SQL predicates are reordered by the planner.
CREATE FUNCTION public.bridge_native_source_user_id(p_user_id uuid, p_bot_id uuid, p_metadata jsonb)
RETURNS uuid LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
    SELECT CASE
      WHEN p_user_id IS NOT NULL THEN p_user_id
      WHEN p_bot_id IS NOT NULL
       AND jsonb_typeof(p_metadata->'interaction') = 'object'
       AND jsonb_typeof(p_metadata #> '{interaction,user_id}') = 'string'
       AND (p_metadata #>> '{interaction,user_id}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (p_metadata #>> '{interaction,user_id}')::uuid
    END;
$$;
REVOKE ALL ON FUNCTION public.bridge_native_source_user_id(uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- Return only IDs; these are additional consent filters, not substitutes for channel permissions.
-- Preserve input order, deduplicate, ignore missing bots/messages. Ordinary bots are unaffected.
CREATE FUNCTION public.bridge_visible_message_ids(p_bot_id uuid, p_message_ids uuid[])
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT COALESCE(array_agg(id ORDER BY first_position), '{}'::uuid[]) FROM (
      SELECT m.id, min(input.position) AS first_position
        FROM unnest(p_message_ids) WITH ORDINALITY input(id, position)
        JOIN public.messages m ON m.id = input.id JOIN public.bots b ON b.id = p_bot_id
       WHERE (b.bot_type <> 'bridge' AND b.bridge_platform IS NULL)
          OR (m.user_id IS NULL AND (m.bot_id IS NULL OR NOT (COALESCE(m.metadata, '{}'::jsonb) ? 'interaction')))
          OR public.can_bridge_member_messages(b.id, COALESCE(m.channel_id,
                (SELECT t.channel_id FROM public.threads t WHERE t.id = m.thread_id)),
                public.bridge_native_source_user_id(m.user_id, m.bot_id, m.metadata))
       GROUP BY m.id
    ) visible;
$$;

CREATE FUNCTION public.bridge_message_recipients(p_bot_ids uuid[], p_message_id uuid)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT COALESCE(array_agg(id ORDER BY first_position), '{}'::uuid[]) FROM (
      SELECT b.id, min(input.position) AS first_position
        FROM unnest(p_bot_ids) WITH ORDINALITY input(id, position)
        JOIN public.bots b ON b.id = input.id JOIN public.messages m ON m.id = p_message_id
       WHERE (b.bot_type <> 'bridge' AND b.bridge_platform IS NULL)
          OR (m.user_id IS NULL AND (m.bot_id IS NULL OR NOT (COALESCE(m.metadata, '{}'::jsonb) ? 'interaction')))
          OR public.can_bridge_member_messages(b.id, COALESCE(m.channel_id,
                (SELECT t.channel_id FROM public.threads t WHERE t.id = m.thread_id)),
                public.bridge_native_source_user_id(m.user_id, m.bot_id, m.metadata))
       GROUP BY b.id
    ) visible;
$$;

-- Source snapshots let deletion/reaction dispatch enforce consent without loading message content.
CREATE FUNCTION public.bridge_member_recipients(p_bot_ids uuid[], p_channel_id uuid, p_user_id uuid)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT COALESCE(array_agg(id ORDER BY first_position), '{}'::uuid[]) FROM (
      SELECT b.id, min(input.position) AS first_position
        FROM unnest(p_bot_ids) WITH ORDINALITY input(id, position)
        JOIN public.bots b ON b.id = input.id
       WHERE (b.bot_type <> 'bridge' AND b.bridge_platform IS NULL) OR p_user_id IS NULL
          OR public.can_bridge_member_messages(b.id, p_channel_id, p_user_id)
       GROUP BY b.id
    ) visible;
$$;

-- A complete bounded source survives parent deletion. Missing/unavailable source is not
-- equivalent to a known system/bot row with no native author. Only ordinary bots bypass it.
CREATE FUNCTION public.bridge_source_recipients(p_bot_ids uuid[], p_channel_id uuid, p_source jsonb)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH source AS (
      SELECT jsonb_typeof(p_source) = 'object'
         AND p_source ?& ARRAY['user_id', 'bot_id', 'metadata']
         AND (jsonb_typeof(p_source->'user_id') = 'null' OR
              (jsonb_typeof(p_source->'user_id') = 'string' AND p_source->>'user_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
         AND (jsonb_typeof(p_source->'bot_id') = 'null' OR
              (jsonb_typeof(p_source->'bot_id') = 'string' AND p_source->>'bot_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
         AND jsonb_typeof(p_source->'metadata') IN ('null', 'object') AS valid,
         CASE WHEN jsonb_typeof(p_source->'user_id') = 'string'
                   AND p_source->>'user_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN (p_source->>'user_id')::uuid END AS user_id,
         CASE WHEN jsonb_typeof(p_source->'bot_id') = 'string'
                   AND p_source->>'bot_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN (p_source->>'bot_id')::uuid END AS bot_id,
         p_source->'metadata' AS metadata
    )
    SELECT COALESCE(array_agg(id ORDER BY first_position), '{}'::uuid[]) FROM (
      SELECT b.id, min(input.position) AS first_position
        FROM unnest(p_bot_ids) WITH ORDINALITY input(id, position)
        JOIN public.bots b ON b.id = input.id CROSS JOIN source s
       WHERE (b.bot_type <> 'bridge' AND b.bridge_platform IS NULL)
          OR (s.valid AND (
               (s.user_id IS NULL AND (s.bot_id IS NULL OR NOT (COALESCE(s.metadata, '{}'::jsonb) ? 'interaction')))
               OR public.can_bridge_member_messages(b.id, p_channel_id,
                    public.bridge_native_source_user_id(s.user_id, s.bot_id, s.metadata))))
       GROUP BY b.id
    ) visible;
$$;

CREATE FUNCTION public.guard_bridge_author()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE a jsonb := NEW.metadata->'bridge_author'; platform text; v_channel uuid;
BEGIN
    IF current_user IN ('authenticated', 'anon') THEN
        IF (TG_OP = 'INSERT' AND NEW.metadata ? 'bridge_author')
           OR (TG_OP = 'UPDATE' AND a IS DISTINCT FROM OLD.metadata->'bridge_author') THEN
            RAISE EXCEPTION 'metadata key reserved for the server: bridge_author' USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
    END IF;
    IF NOT (COALESCE(NEW.metadata, '{}'::jsonb) ? 'bridge_author') THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME = 'messages' THEN
        -- Unchanged metadata on soft deletion must not prevent cleanup after unpairing.
        IF TG_OP = 'UPDATE' AND NEW.is_deleted AND a IS NOT DISTINCT FROM OLD.metadata->'bridge_author' THEN RETURN NEW; END IF;
        v_channel := COALESCE(NEW.channel_id, (SELECT t.channel_id FROM public.threads t WHERE t.id = NEW.thread_id));
    ELSE
        -- The reaction's denormalized channel may not be populated yet (or may be forged).
        SELECT COALESCE(m.channel_id, t.channel_id) INTO v_channel
          FROM public.messages m LEFT JOIN public.threads t ON t.id = m.thread_id WHERE m.id = NEW.message_id;
    END IF;
    platform := public.bridge_channel_platform(NEW.bot_id, v_channel);
    IF platform IS NULL OR jsonb_typeof(a) IS DISTINCT FROM 'object' OR NEW.user_id IS NOT NULL
       OR a->>'platform' IS DISTINCT FROM platform
       OR jsonb_typeof(a->'id') IS DISTINCT FROM 'string' OR char_length(a->>'id') NOT BETWEEN 1 AND 512
       OR jsonb_typeof(a->'username') IS DISTINCT FROM 'string' OR char_length(btrim(a->>'username')) NOT BETWEEN 1 AND 100
       OR (a ? 'display_name' AND (jsonb_typeof(a->'display_name') IS DISTINCT FROM 'string' OR char_length(a->>'display_name') > 100))
       OR (a ? 'avatar_url' AND (jsonb_typeof(a->'avatar_url') IS DISTINCT FROM 'string'
                               OR char_length(a->>'avatar_url') > 2048 OR a->>'avatar_url' !~ '^https?://'))
       OR (platform = 'matrix' AND (a->>'id' !~ '^@[^:[:space:]]+:[^[:space:]]+$' OR NEW.metadata ? 'discord_user'))
       OR (platform = 'discord' AND a->>'id' !~ '^[0-9]{1,20}$') THEN
        RAISE EXCEPTION 'Invalid or unauthorized bridge_author' USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
END;
$$;
-- Runs before AutoMod so malformed or cross-protocol authors cannot become bot-exempt.
CREATE TRIGGER a_bridge_author_guard BEFORE INSERT OR UPDATE ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.guard_bridge_author();
CREATE TRIGGER a_bridge_author_guard BEFORE INSERT OR UPDATE ON public.reactions
    FOR EACH ROW EXECUTE FUNCTION public.guard_bridge_author();
REVOKE ALL ON FUNCTION public.guard_bridge_author() FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE fn regprocedure;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
      'public.get_server_bridge_opt_out(uuid)', 'public.set_server_bridge_opt_out(uuid,boolean)',
      'public.configure_matrix_bridge(uuid,uuid,uuid[])']::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    END LOOP;
    FOREACH fn IN ARRAY ARRAY[
      'public.bridge_channel_platform(uuid,uuid)', 'public.can_bridge_member_messages(uuid,uuid,uuid)',
      'public.bridge_visible_message_ids(uuid,uuid[])', 'public.bridge_message_recipients(uuid[],uuid)',
      'public.bridge_member_recipients(uuid[],uuid,uuid)',
      'public.bridge_source_recipients(uuid[],uuid,jsonb)']::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;
END;
$$;

-- Surgical changes to the latest AutoMod definition preserve the Discord and native paths.
-- Assert every anchor so a reordered migration fails loudly instead of silently losing checks.
DO $patch$
DECLARE body text := pg_get_functiondef('public.automod_check_message(public.messages,text,text)'::regprocedure);
        anchor text; replacement text;
BEGIN
    anchor := '    IF pg_trigger_depth() < 1 THEN';
    replacement := $code$    -- Generic Discord authors retain the legacy AutoMod policy and counter namespace.
    IF p_msg.metadata #>> '{bridge_author,platform}' = 'discord' THEN
        p_msg.metadata := p_msg.metadata || jsonb_build_object('discord_user',
            (CASE WHEN jsonb_typeof(p_msg.metadata->'discord_user') = 'object'
                  THEN p_msg.metadata->'discord_user' ELSE '{}'::jsonb END) || (p_msg.metadata->'bridge_author'));
    END IF;
    IF pg_trigger_depth() < 1 THEN$code$;
    IF strpos(body, anchor) = 0 THEN RAISE EXCEPTION 'AutoMod entry anchor missing'; END IF;
    body := replace(body, anchor, replacement);
    anchor := $code$            IF NOT v_internal
               AND jsonb_typeof(p_msg.metadata -> 'discord_user') = 'object'$code$;
    replacement := $code$            IF NOT v_internal AND p_msg.metadata #>> '{bridge_author,platform}' = 'matrix'
               AND public.bridge_channel_platform(p_msg.bot_id, v_channel_id) = 'matrix' THEN
                v_relayed := 'matrix:' || (p_msg.metadata #>> '{bridge_author,id}');
                v_relayed_name := left(regexp_replace(p_msg.metadata #>> '{bridge_author,username}', '[[:cntrl:]]', ' ', 'g'), 100);
                v_counted := md5(v_relayed)::uuid;
                -- Matrix people meet content rules too, regardless of the bot exemption.
                v_bots_exempt := false;
            ELSIF NOT v_internal
               AND jsonb_typeof(p_msg.metadata -> 'discord_user') = 'object'$code$;
    IF strpos(body, anchor) = 0 THEN RAISE EXCEPTION 'AutoMod author anchor missing'; END IF;
    body := replace(body, anchor, replacement);
    anchor := $code$            ELSIF v_type = 'new_member' THEN$code$;
    replacement := $code$            ELSIF v_type = 'new_member' THEN
                -- Matrix exposes no trustworthy account/join age; never parse its ID as a snowflake.
                CONTINUE WHEN p_msg.metadata #>> '{bridge_author,platform}' = 'matrix';$code$;
    IF strpos(body, anchor) = 0 THEN RAISE EXCEPTION 'AutoMod age anchor missing'; END IF;
    EXECUTE replace(body, anchor, replacement);
END;
$patch$;

COMMIT;
