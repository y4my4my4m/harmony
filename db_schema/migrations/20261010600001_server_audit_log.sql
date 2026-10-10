-- Per-server audit log.
--
-- Server history existed only as server_membership_events (joins, leaves, kicks, bans) and
-- automod_events. Changes to channels, categories, roles, role assignments, permission
-- overrides, emojis, server settings, invites and bot installations, timeouts and moderator
-- message deletions left no record a server's moderators could read. VIEW_AUDIT_LOG
-- (bit 5) gated nothing but the AutoMod log.
--
-- server_audit_log records them. AFTER row triggers on the written tables capture client
-- writes (supabase-js under RLS), definer RPCs and service-role writes alike. The instance
-- admin log (admin_audit_log) is separate and unchanged.
--
--   actor     get_current_profile_id(): the caller for client writes and for definer RPCs
--             they call. Service-role writes (bot-gateway, federation-backend, the Discord
--             bridge) and pg_cron carry no profile and are recorded as source 'system'.
--             A bot_audit_log row naming one of those writes re-attributes it to the bot
--             (source 'bot'). Kicks, bans and unbans take the actor from the event payload;
--             AutoMod timeouts have none.
--   scope     local servers (is_local_server) only.
--   skipped   writes at pg_trigger_depth() > 1 on structure tables: server creation
--             defaults (role, channels, category, settings, AutoMod preset), join-time role
--             assignment, FK cascades of a deleted server, channel, category or role. A role
--             removal after the member has left (ban, kick, leave cleanup). Invite usage,
--             invite purges with no actor, expired timeouts purged by automod_purge(), emoji
--             usage counters, a member's deletion of their own message, message deletions
--             with no actor (a federated author's own deletion arrives that way).
--   changes   {column: {old, new}} for the columns that changed; creates carry new only,
--             deletes old only. Ids that name a row (category, default role, system channel,
--             owner) are stored as that row's name. Strings past 512 characters are cut,
--             objects and arrays past 2048 characters are replaced by "…".
--   folding   position-only edits (drag reordering) fold into one '<kind>.reorder' row per
--             actor and server for 60 s; moderator message deletions fold into one row per
--             actor, author and channel for 5 minutes (details.count, details.message_ids,
--             at most 50 ids). Message content is never stored.
--   time      created_at is clock_timestamp(), so rows written in one transaction stay
--             distinct and ordered for paging on created_at.
--
-- Rows are read through get_server_audit_log(), which admits the server owner, instance
-- admins and VIEW_AUDIT_LOG holders (ADMINISTRATOR implies it). Retention is 90 days.
--
-- server_membership_events: kick, ban and unban rows carry the reason and the moderator.
-- They were readable by every user_servers row of the server, pending and banned included.
-- They are now readable by the owner, instance admins and holders of KICK_MEMBERS,
-- BAN_MEMBERS or VIEW_AUDIT_LOG; other event types stay readable by members.
--
-- user_roles.assigned_by is set to the caller on client inserts and, when unset, on
-- top-level definer inserts.
--
-- Converges by state.

BEGIN;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.server_audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    actor_bot_id uuid REFERENCES public.bots(id) ON DELETE SET NULL,
    source text NOT NULL,
    action text NOT NULL,
    target_type text,
    target_id text,
    target_name text,
    changes jsonb,
    details jsonb,
    reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT server_audit_log_source_check CHECK (source IN ('user', 'bot', 'federation', 'system')),
    CONSTRAINT server_audit_log_reason_length CHECK (reason IS NULL OR char_length(reason) <= 512),
    CONSTRAINT server_audit_log_target_name_length CHECK (target_name IS NULL OR char_length(target_name) <= 200)
);

CREATE INDEX IF NOT EXISTS idx_server_audit_log_server_created
    ON public.server_audit_log (server_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_server_audit_log_server_action
    ON public.server_audit_log (server_id, action, created_at DESC);

COMMENT ON TABLE public.server_audit_log IS
    'Per-server audit log, written by AFTER triggers. Read through get_server_audit_log(); kept 90 days.';

ALTER TABLE public.server_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS server_audit_log_service_role ON public.server_audit_log;
CREATE POLICY server_audit_log_service_role ON public.server_audit_log
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.server_audit_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.server_audit_log TO service_role;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- p_row restricted to p_keys.
CREATE OR REPLACE FUNCTION public.server_audit_pick(p_row jsonb, p_keys text[])
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
      FROM jsonb_each(COALESCE(p_row, '{}'::jsonb)) e
     WHERE e.key = ANY (p_keys)
$$;

-- JSON null reads as absent. Long strings are cut to 512 characters; objects and arrays
-- longer than 2048 characters become "…".
CREATE OR REPLACE FUNCTION public.server_audit_value(p_value jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN p_value IS NULL OR p_value = 'null'::jsonb THEN NULL
        WHEN jsonb_typeof(p_value) = 'string' AND char_length(p_value #>> '{}') > 512
            THEN to_jsonb(left(p_value #>> '{}', 512) || '…')
        WHEN jsonb_typeof(p_value) IN ('object', 'array') AND char_length(p_value::text) > 2048
            THEN to_jsonb('…'::text)
        ELSE p_value
    END
$$;

-- {key: {old, new}} for every key whose value differs between p_old and p_new. A side that
-- lacks the key (or holds JSON null) is omitted from the pair.
CREATE OR REPLACE FUNCTION public.server_audit_diff(p_old jsonb, p_new jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(jsonb_object_agg(d.k, jsonb_strip_nulls(jsonb_build_object(
               'old', public.server_audit_value(d.o), 'new', public.server_audit_value(d.n)))),
           '{}'::jsonb)
      FROM (SELECT k.k, p_old -> k.k AS o, p_new -> k.k AS n
              FROM (SELECT jsonb_object_keys(COALESCE(p_old, '{}'::jsonb) || COALESCE(p_new, '{}'::jsonb)) AS k) k) d
     WHERE NULLIF(d.o, 'null'::jsonb) IS DISTINCT FROM NULLIF(d.n, 'null'::jsonb)
$$;

-- Inserts one row. With p_source NULL the actor is p_actor_id, else the caller's profile, and
-- the source follows from it. With p_source given, p_actor_id is taken as is. An actor id
-- naming no profile is dropped. Remote and absent servers are skipped.
CREATE OR REPLACE FUNCTION public.server_audit_write(
    p_server_id uuid,
    p_action text,
    p_target_type text,
    p_target_id text,
    p_target_name text,
    p_changes jsonb DEFAULT NULL,
    p_details jsonb DEFAULT NULL,
    p_reason text DEFAULT NULL,
    p_actor_id uuid DEFAULT NULL,
    p_source text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_actor uuid;
    v_source text := p_source;
    v_id uuid;
BEGIN
    IF p_server_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.is_local_server) THEN
        RETURN NULL;
    END IF;

    IF p_actor_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_actor_id) THEN
        v_actor := p_actor_id;
    END IF;
    IF v_source IS NULL THEN
        v_actor := COALESCE(v_actor, public.get_current_profile_id());
        v_source := CASE WHEN v_actor IS NULL THEN 'system' ELSE 'user' END;
    END IF;

    INSERT INTO public.server_audit_log
        (server_id, actor_id, source, action, target_type, target_id, target_name,
         changes, details, reason, created_at)
    VALUES
        (p_server_id, v_actor, v_source, p_action, p_target_type, p_target_id, left(p_target_name, 200),
         NULLIF(p_changes, '{}'::jsonb), NULLIF(jsonb_strip_nulls(p_details), '{}'::jsonb),
         left(NULLIF(btrim(p_reason), ''), 512), clock_timestamp())
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

-- Position-only edits. One '<kind>.reorder' row per actor and server within 60 s;
-- details.items maps each moved row id to {name, old, new}, old kept from the first move.
CREATE OR REPLACE FUNCTION public.server_audit_fold_reorder(
    p_server_id uuid, p_action text, p_item_id text, p_name text, p_old integer, p_new integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_actor uuid := public.get_current_profile_id();
    v_row public.server_audit_log;
BEGIN
    SELECT l.* INTO v_row
      FROM public.server_audit_log l
     WHERE l.server_id = p_server_id
       AND l.action = p_action
       AND l.actor_id IS NOT DISTINCT FROM v_actor
       AND l.created_at > clock_timestamp() - interval '60 seconds'
     ORDER BY l.created_at DESC
     LIMIT 1
       FOR UPDATE;

    IF NOT FOUND THEN
        PERFORM public.server_audit_write(p_server_id, p_action, NULL, NULL, NULL, NULL,
            jsonb_build_object('items', jsonb_build_object(p_item_id,
                jsonb_build_object('name', p_name, 'old', p_old, 'new', p_new))));
        RETURN;
    END IF;

    UPDATE public.server_audit_log l
       SET details = jsonb_set(COALESCE(l.details, '{}'::jsonb), ARRAY['items', p_item_id],
               jsonb_build_object('name', p_name,
                                  'old', COALESCE(l.details -> 'items' -> p_item_id -> 'old', to_jsonb(p_old)),
                                  'new', p_new))
     WHERE l.id = v_row.id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Channels and categories
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.server_audit_channels()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_keys constant text[] := ARRAY['name', 'description', 'type', 'category', 'slowmode_seconds'];
    v_old jsonb;
    v_new jsonb;
    v_changes jsonb;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;

    IF TG_OP <> 'INSERT' THEN
        v_old := public.server_audit_pick(to_jsonb(OLD), v_keys)
              || jsonb_build_object('category', (SELECT cc.name FROM public.channel_categories cc WHERE cc.id = OLD.category));
    END IF;
    IF TG_OP <> 'DELETE' THEN
        v_new := public.server_audit_pick(to_jsonb(NEW), v_keys)
              || jsonb_build_object('category', (SELECT cc.name FROM public.channel_categories cc WHERE cc.id = NEW.category));
    END IF;
    v_changes := public.server_audit_diff(v_old, v_new);

    IF TG_OP = 'INSERT' THEN
        PERFORM public.server_audit_write(NEW.server_id, 'channel.create', 'channel', NEW.id::text, NEW.name, v_changes);
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM public.server_audit_write(OLD.server_id, 'channel.delete', 'channel', OLD.id::text, OLD.name, v_changes);
    ELSIF v_changes <> '{}'::jsonb THEN
        PERFORM public.server_audit_write(NEW.server_id, 'channel.update', 'channel', NEW.id::text, NEW.name, v_changes);
    ELSIF NEW."order" IS DISTINCT FROM OLD."order" THEN
        PERFORM public.server_audit_fold_reorder(NEW.server_id, 'channel.reorder', NEW.id::text, NEW.name,
                                                 OLD."order", NEW."order");
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_channels_audit ON public.channels;
CREATE TRIGGER z_channels_audit
    AFTER INSERT OR DELETE ON public.channels
    FOR EACH ROW EXECUTE FUNCTION public.server_audit_channels();
DROP TRIGGER IF EXISTS z_channels_audit_update ON public.channels;
CREATE TRIGGER z_channels_audit_update
    AFTER UPDATE ON public.channels
    FOR EACH ROW
    WHEN ((OLD.name, OLD.description, OLD.type, OLD.category, OLD.slowmode_seconds, OLD."order")
          IS DISTINCT FROM (NEW.name, NEW.description, NEW.type, NEW.category, NEW.slowmode_seconds, NEW."order"))
    EXECUTE FUNCTION public.server_audit_channels();

CREATE OR REPLACE FUNCTION public.server_audit_categories()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_changes jsonb;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;

    v_changes := public.server_audit_diff(
        CASE WHEN TG_OP <> 'INSERT' THEN public.server_audit_pick(to_jsonb(OLD), ARRAY['name']) END,
        CASE WHEN TG_OP <> 'DELETE' THEN public.server_audit_pick(to_jsonb(NEW), ARRAY['name']) END);

    IF TG_OP = 'INSERT' THEN
        PERFORM public.server_audit_write(NEW.server_id, 'category.create', 'category', NEW.id::text, NEW.name, v_changes);
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM public.server_audit_write(OLD.server_id, 'category.delete', 'category', OLD.id::text, OLD.name, v_changes);
    ELSIF v_changes <> '{}'::jsonb THEN
        PERFORM public.server_audit_write(NEW.server_id, 'category.update', 'category', NEW.id::text, NEW.name, v_changes);
    ELSIF NEW."order" IS DISTINCT FROM OLD."order" THEN
        PERFORM public.server_audit_fold_reorder(NEW.server_id, 'category.reorder', NEW.id::text, NEW.name,
                                                 OLD."order", NEW."order");
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_channel_categories_audit ON public.channel_categories;
CREATE TRIGGER z_channel_categories_audit
    AFTER INSERT OR DELETE ON public.channel_categories
    FOR EACH ROW EXECUTE FUNCTION public.server_audit_categories();
DROP TRIGGER IF EXISTS z_channel_categories_audit_update ON public.channel_categories;
CREATE TRIGGER z_channel_categories_audit_update
    AFTER UPDATE ON public.channel_categories
    FOR EACH ROW
    WHEN ((OLD.name, OLD."order") IS DISTINCT FROM (NEW.name, NEW."order"))
    EXECUTE FUNCTION public.server_audit_categories();

-- ---------------------------------------------------------------------------
-- Roles and role assignments
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.server_audit_roles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_keys constant text[] := ARRAY['name', 'color', 'permissions', 'mentionable', 'hoist',
                                    'icon_url', 'unicode_emoji', 'is_admin'];
    v_changes jsonb;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;

    v_changes := public.server_audit_diff(
        CASE WHEN TG_OP <> 'INSERT' THEN public.server_audit_pick(to_jsonb(OLD), v_keys) END,
        CASE WHEN TG_OP <> 'DELETE' THEN public.server_audit_pick(to_jsonb(NEW), v_keys) END);

    IF TG_OP = 'INSERT' THEN
        PERFORM public.server_audit_write(NEW.server_id, 'role.create', 'role', NEW.id::text, NEW.name, v_changes);
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM public.server_audit_write(OLD.server_id, 'role.delete', 'role', OLD.id::text, OLD.name, v_changes);
    ELSIF v_changes <> '{}'::jsonb THEN
        PERFORM public.server_audit_write(NEW.server_id, 'role.update', 'role', NEW.id::text, NEW.name, v_changes);
    ELSIF NEW.position IS DISTINCT FROM OLD.position THEN
        PERFORM public.server_audit_fold_reorder(NEW.server_id, 'role.reorder', NEW.id::text, NEW.name,
                                                 OLD.position, NEW.position);
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_server_roles_audit ON public.server_roles;
CREATE TRIGGER z_server_roles_audit
    AFTER INSERT OR DELETE ON public.server_roles
    FOR EACH ROW EXECUTE FUNCTION public.server_audit_roles();
DROP TRIGGER IF EXISTS z_server_roles_audit_update ON public.server_roles;
CREATE TRIGGER z_server_roles_audit_update
    AFTER UPDATE ON public.server_roles
    FOR EACH ROW
    WHEN ((OLD.name, OLD.color, OLD.permissions, OLD.mentionable, OLD.hoist, OLD.icon_url,
           OLD.unicode_emoji, OLD.is_admin, OLD.position)
          IS DISTINCT FROM (NEW.name, NEW.color, NEW.permissions, NEW.mentionable, NEW.hoist, NEW.icon_url,
                            NEW.unicode_emoji, NEW.is_admin, NEW.position))
    EXECUTE FUNCTION public.server_audit_roles();

CREATE OR REPLACE FUNCTION public.server_audit_user_roles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.user_roles := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    v_role text;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'DELETE' AND NOT EXISTS (
        SELECT 1 FROM public.user_servers us
         WHERE us.server_id = v_row.server_id AND us.user_id = v_row.user_id) THEN
        RETURN NULL;
    END IF;

    SELECT sr.name INTO v_role FROM public.server_roles sr WHERE sr.id = v_row.role_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    PERFORM public.server_audit_write(
        v_row.server_id,
        CASE WHEN TG_OP = 'DELETE' THEN 'member.role_remove' ELSE 'member.role_add' END,
        'user', v_row.user_id::text,
        (SELECT p.username FROM public.profiles p WHERE p.id = v_row.user_id),
        NULL,
        jsonb_build_object('role_id', v_row.role_id, 'role_name', v_role));
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_user_roles_audit ON public.user_roles;
CREATE TRIGGER z_user_roles_audit
    AFTER INSERT OR DELETE ON public.user_roles
    FOR EACH ROW EXECUTE FUNCTION public.server_audit_user_roles();

-- SECURITY INVOKER: current_user distinguishes a client write from a definer one.
CREATE OR REPLACE FUNCTION public.set_user_role_assigned_by()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    IF current_user IN ('authenticated', 'anon') THEN
        NEW.assigned_by := public.get_current_profile_id();
    ELSIF NEW.assigned_by IS NULL THEN
        NEW.assigned_by := public.get_current_profile_id();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS b_user_roles_assigned_by ON public.user_roles;
CREATE TRIGGER b_user_roles_assigned_by
    BEFORE INSERT ON public.user_roles
    FOR EACH ROW EXECUTE FUNCTION public.set_user_role_assigned_by();

-- ---------------------------------------------------------------------------
-- Channel permission overrides
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.server_audit_overrides()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_keys constant text[] := ARRAY['allow_permissions', 'deny_permissions'];
    v_row public.channel_permission_overrides := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    v_channel public.channels;
    v_changes jsonb;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;
    SELECT c.* INTO v_channel FROM public.channels c WHERE c.id = v_row.channel_id;
    IF NOT FOUND OR v_channel.server_id IS NULL THEN
        RETURN NULL;
    END IF;

    v_changes := public.server_audit_diff(
        CASE WHEN TG_OP <> 'INSERT' THEN public.server_audit_pick(to_jsonb(OLD), v_keys) END,
        CASE WHEN TG_OP <> 'DELETE' THEN public.server_audit_pick(to_jsonb(NEW), v_keys) END);
    IF TG_OP = 'UPDATE' AND v_changes = '{}'::jsonb THEN
        RETURN NULL;
    END IF;

    PERFORM public.server_audit_write(
        v_channel.server_id,
        CASE TG_OP WHEN 'INSERT' THEN 'override.create' WHEN 'UPDATE' THEN 'override.update' ELSE 'override.delete' END,
        'channel', v_channel.id::text, v_channel.name,
        v_changes,
        jsonb_build_object(
            'override_type', v_row.target_type,
            'role_id', v_row.role_id,
            'role_name', (SELECT sr.name FROM public.server_roles sr WHERE sr.id = v_row.role_id),
            'user_id', v_row.user_id,
            'user_name', (SELECT p.username FROM public.profiles p WHERE p.id = v_row.user_id)));
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_channel_overrides_audit ON public.channel_permission_overrides;
CREATE TRIGGER z_channel_overrides_audit
    AFTER INSERT OR UPDATE OR DELETE ON public.channel_permission_overrides
    FOR EACH ROW EXECUTE FUNCTION public.server_audit_overrides();

-- ---------------------------------------------------------------------------
-- Server emojis
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.server_audit_emojis()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.emojis := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    v_changes jsonb;
BEGIN
    IF pg_trigger_depth() > 1 OR v_row.scope IS DISTINCT FROM 'server' OR v_row.server_id IS NULL THEN
        RETURN NULL;
    END IF;

    v_changes := public.server_audit_diff(
        CASE WHEN TG_OP <> 'INSERT' THEN public.server_audit_pick(to_jsonb(OLD), ARRAY['name']) END,
        CASE WHEN TG_OP <> 'DELETE' THEN public.server_audit_pick(to_jsonb(NEW), ARRAY['name']) END);

    PERFORM public.server_audit_write(
        v_row.server_id,
        CASE TG_OP WHEN 'INSERT' THEN 'emoji.create' WHEN 'UPDATE' THEN 'emoji.update' ELSE 'emoji.delete' END,
        'emoji', v_row.id::text, v_row.name,
        v_changes,
        jsonb_build_object('url', v_row.url));
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_emojis_audit ON public.emojis;
CREATE TRIGGER z_emojis_audit
    AFTER INSERT OR DELETE ON public.emojis
    FOR EACH ROW EXECUTE FUNCTION public.server_audit_emojis();
DROP TRIGGER IF EXISTS z_emojis_audit_update ON public.emojis;
CREATE TRIGGER z_emojis_audit_update
    AFTER UPDATE ON public.emojis
    FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
    EXECUTE FUNCTION public.server_audit_emojis();

-- ---------------------------------------------------------------------------
-- Server row and server_settings
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.server_audit_servers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_keys constant text[] := ARRAY['name', 'description', 'icon', 'banner', 'public', 'category',
                                    'allow_cross_server_emojis', 'federation_enabled', 'invite_code', 'rules'];
    v_changes jsonb;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;

    v_changes := public.server_audit_diff(
        public.server_audit_pick(to_jsonb(OLD), v_keys)
            || jsonb_build_object('owner', (SELECT p.username FROM public.profiles p WHERE p.id = OLD.owner)),
        public.server_audit_pick(to_jsonb(NEW), v_keys)
            || jsonb_build_object('owner', (SELECT p.username FROM public.profiles p WHERE p.id = NEW.owner)));
    IF v_changes <> '{}'::jsonb THEN
        PERFORM public.server_audit_write(NEW.id, 'server.update', 'server', NEW.id::text, NEW.name, v_changes);
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_servers_audit ON public.servers;
CREATE TRIGGER z_servers_audit
    AFTER UPDATE ON public.servers
    FOR EACH ROW
    WHEN ((OLD.name, OLD.description, OLD.icon, OLD.banner, OLD.public, OLD.category,
           OLD.allow_cross_server_emojis, OLD.federation_enabled, OLD.invite_code, OLD.rules, OLD.owner)
          IS DISTINCT FROM (NEW.name, NEW.description, NEW.icon, NEW.banner, NEW.public, NEW.category,
                            NEW.allow_cross_server_emojis, NEW.federation_enabled, NEW.invite_code, NEW.rules, NEW.owner))
    EXECUTE FUNCTION public.server_audit_servers();

CREATE OR REPLACE FUNCTION public.server_audit_settings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_keys constant text[] := ARRAY['invite_permissions', 'moderation_settings', 'default_message_notifications',
                                    'newcomer_alerts', 'system_messages_enabled'];
    v_old jsonb;
    v_changes jsonb;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        v_old := public.server_audit_pick(to_jsonb(OLD), v_keys)
              || jsonb_build_object(
                     'default_role', (SELECT sr.name FROM public.server_roles sr WHERE sr.id = OLD.default_role_id),
                     'system_channel', (SELECT c.name FROM public.channels c WHERE c.id = OLD.system_channel_id));
    END IF;
    v_changes := public.server_audit_diff(v_old,
        public.server_audit_pick(to_jsonb(NEW), v_keys)
            || jsonb_build_object(
                   'default_role', (SELECT sr.name FROM public.server_roles sr WHERE sr.id = NEW.default_role_id),
                   'system_channel', (SELECT c.name FROM public.channels c WHERE c.id = NEW.system_channel_id)));
    IF v_changes <> '{}'::jsonb THEN
        PERFORM public.server_audit_write(NEW.server_id, 'settings.update', 'server', NEW.server_id::text,
                                          (SELECT s.name FROM public.servers s WHERE s.id = NEW.server_id), v_changes);
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_server_settings_audit ON public.server_settings;
CREATE TRIGGER z_server_settings_audit
    AFTER INSERT OR UPDATE ON public.server_settings
    FOR EACH ROW EXECUTE FUNCTION public.server_audit_settings();

-- ---------------------------------------------------------------------------
-- Invites
-- ---------------------------------------------------------------------------

-- Revocation is used set with uses unchanged; consume_invite sets used as it counts a use.
-- Deletions without an actor are purge_stale_invites().
CREATE OR REPLACE FUNCTION public.server_audit_invites()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.invites := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'UPDATE' AND NOT (NEW.used IS TRUE AND OLD.used IS NOT TRUE
                                 AND NEW.uses IS NOT DISTINCT FROM OLD.uses) THEN
        RETURN NULL;
    END IF;
    IF TG_OP <> 'INSERT' AND (public.get_current_profile_id() IS NULL OR OLD.used IS TRUE) THEN
        RETURN NULL;
    END IF;

    PERFORM public.server_audit_write(
        v_row.server_id,
        CASE WHEN TG_OP = 'INSERT' THEN 'invite.create' ELSE 'invite.delete' END,
        'invite', v_row.id::text, v_row.code,
        NULL,
        jsonb_build_object(
            'channel_id', v_row.channel_id,
            'max_uses', v_row.max_uses,
            'uses', CASE WHEN TG_OP <> 'INSERT' THEN v_row.uses END,
            'expires_at', v_row.expires_at,
            'temporary', v_row.temporary,
            'created_by', v_row.created_by));
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_invites_audit ON public.invites;
CREATE TRIGGER z_invites_audit
    AFTER INSERT OR UPDATE OF used OR DELETE ON public.invites
    FOR EACH ROW EXECUTE FUNCTION public.server_audit_invites();

-- ---------------------------------------------------------------------------
-- Bot installations
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.server_audit_bots()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_keys constant text[] := ARRAY['read_messages', 'send_messages', 'manage_messages', 'embed_links',
                                    'attach_files', 'mention_everyone', 'add_reactions', 'manage_channels',
                                    'kick_members', 'ban_members', 'manage_roles', 'allowed_channel_ids'];
    v_row public.bot_server_permissions := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    v_action text;
    v_changes jsonb;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.is_active IS FALSE THEN
            RETURN NULL;
        END IF;
        v_action := 'bot.add';
        v_changes := public.server_audit_diff(NULL, public.server_audit_pick(to_jsonb(NEW), v_keys));
    ELSIF TG_OP = 'DELETE' THEN
        IF OLD.is_active IS FALSE THEN
            RETURN NULL;
        END IF;
        v_action := 'bot.remove';
    ELSIF NEW.is_active IS NOT FALSE AND OLD.is_active IS FALSE THEN
        v_action := 'bot.add';
        v_changes := public.server_audit_diff(NULL, public.server_audit_pick(to_jsonb(NEW), v_keys));
    ELSIF NEW.is_active IS FALSE AND OLD.is_active IS NOT FALSE THEN
        v_action := 'bot.remove';
    ELSE
        v_changes := public.server_audit_diff(public.server_audit_pick(to_jsonb(OLD), v_keys),
                                              public.server_audit_pick(to_jsonb(NEW), v_keys));
        IF v_changes = '{}'::jsonb THEN
            RETURN NULL;
        END IF;
        v_action := 'bot.update';
    END IF;

    PERFORM public.server_audit_write(
        v_row.server_id, v_action, 'bot', v_row.bot_id::text,
        (SELECT COALESCE(b.display_name, b.username) FROM public.bots b WHERE b.id = v_row.bot_id),
        v_changes);
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_bot_server_permissions_audit ON public.bot_server_permissions;
CREATE TRIGGER z_bot_server_permissions_audit
    AFTER INSERT OR UPDATE OR DELETE ON public.bot_server_permissions
    FOR EACH ROW EXECUTE FUNCTION public.server_audit_bots();

-- bot-gateway writes as service_role and records the acting bot in bot_audit_log after the
-- write. The matching 'system' row of the last 5 minutes is re-attributed to that bot.
CREATE OR REPLACE FUNCTION public.server_audit_attribute_bot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_meta jsonb := COALESCE(NEW.metadata, '{}'::jsonb);
    v_action text;
    v_target text;
    v_server text;
BEGIN
    v_action := CASE NEW.action_type
        WHEN 'channel_created' THEN 'channel.create'
        WHEN 'category_created' THEN 'category.create'
        WHEN 'role_created' THEN 'role.create'
        WHEN 'role_updated' THEN 'role.update'
        WHEN 'role_deleted' THEN 'role.delete'
        WHEN 'emoji_imported' THEN 'emoji.create'
    END;
    v_target := COALESCE(v_meta ->> 'channel_id', v_meta ->> 'category_id', v_meta ->> 'role_id', v_meta ->> 'emojiId');
    v_server := COALESCE(NEW.server_id::text, v_meta ->> 'server_id', v_meta ->> 'serverId');
    IF v_action IS NULL OR v_target IS NULL OR v_server IS NULL
       OR v_server !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN NULL;
    END IF;

    UPDATE public.server_audit_log l
       SET source = 'bot', actor_bot_id = NEW.bot_id
     WHERE l.server_id = v_server::uuid
       AND l.action = v_action
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
                                  'role_updated', 'role_deleted', 'emoji_imported'))
    EXECUTE FUNCTION public.server_audit_attribute_bot();

-- ---------------------------------------------------------------------------
-- Kicks, bans, timeouts
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.server_audit_membership_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_payload jsonb := COALESCE(NEW.payload, '{}'::jsonb);
    v_by text;
    v_actor uuid;
    v_deleted integer;
BEGIN
    v_by := COALESCE(v_payload ->> 'kicked_by', v_payload ->> 'banned_by', v_payload ->> 'unbanned_by');
    IF v_by ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_actor := v_by::uuid;
    END IF;
    IF v_payload ->> 'messages_deleted' ~ '^[0-9]+$' THEN
        v_deleted := NULLIF((v_payload ->> 'messages_deleted')::integer, 0);
    END IF;

    PERFORM public.server_audit_write(
        NEW.server_id, 'member.' || NEW.event_type, 'user', NEW.user_id::text,
        (SELECT p.username FROM public.profiles p WHERE p.id = NEW.user_id),
        NULL,
        jsonb_build_object('messages_deleted', v_deleted),
        v_payload ->> 'reason',
        COALESCE(v_actor, NEW.initiated_by));
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_membership_events_audit ON public.server_membership_events;
CREATE TRIGGER z_membership_events_audit
    AFTER INSERT ON public.server_membership_events
    FOR EACH ROW WHEN (NEW.event_type IN ('kick', 'ban', 'unban'))
    EXECUTE FUNCTION public.server_audit_membership_events();

-- AutoMod timeouts have no actor. Deleting or ending an expired timeout is not recorded.
CREATE OR REPLACE FUNCTION public.server_audit_timeouts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.server_member_timeouts := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    v_action text;
    v_automod boolean := v_row.source = 'automod';
BEGIN
    IF TG_OP <> 'DELETE' AND NEW.until > now()
       AND (TG_OP = 'INSERT' OR NEW.until IS DISTINCT FROM OLD.until OR OLD.until <= now()) THEN
        v_action := 'member.timeout';
    ELSIF TG_OP <> 'INSERT' AND OLD.until > now() AND (TG_OP = 'DELETE' OR NEW.until <= now()) THEN
        v_action := 'member.timeout_remove';
        v_automod := false;
    ELSE
        RETURN NULL;
    END IF;

    PERFORM public.server_audit_write(
        v_row.server_id, v_action, 'user', v_row.user_id::text,
        (SELECT p.username FROM public.profiles p WHERE p.id = v_row.user_id),
        NULL,
        CASE WHEN v_action = 'member.timeout'
             THEN jsonb_build_object('until', NEW.until, 'automod', CASE WHEN v_automod THEN true END) END,
        CASE WHEN v_action = 'member.timeout' THEN NEW.reason END,
        CASE WHEN v_automod THEN NULL WHEN TG_OP <> 'DELETE' AND v_action = 'member.timeout' THEN NEW.created_by END,
        CASE WHEN v_automod THEN 'system' END);
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_server_member_timeouts_audit ON public.server_member_timeouts;
CREATE TRIGGER z_server_member_timeouts_audit
    AFTER INSERT OR UPDATE OR DELETE ON public.server_member_timeouts
    FOR EACH ROW EXECUTE FUNCTION public.server_audit_timeouts();

-- ---------------------------------------------------------------------------
-- Moderator message deletion
-- ---------------------------------------------------------------------------

-- A soft delete (is_deleted false -> true) of another author's channel message by a profile.
-- Service-role deletions carry no actor and are not recorded: a federated author's own
-- deletion arrives that way.
CREATE OR REPLACE FUNCTION public.server_audit_message_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_actor uuid;
    v_channel public.channels;
    v_author text := COALESCE(NEW.user_id, NEW.bot_id)::text;
    v_row public.server_audit_log;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;
    v_actor := public.get_current_profile_id();
    IF v_actor IS NULL OR v_actor = NEW.user_id THEN
        RETURN NULL;
    END IF;
    SELECT c.* INTO v_channel FROM public.channels c WHERE c.id = NEW.channel_id;
    IF NOT FOUND OR v_channel.server_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT l.* INTO v_row
      FROM public.server_audit_log l
     WHERE l.server_id = v_channel.server_id
       AND l.action = 'message.delete'
       AND l.actor_id = v_actor
       AND l.target_id IS NOT DISTINCT FROM v_author
       AND l.details ->> 'channel_id' = v_channel.id::text
       AND l.created_at > clock_timestamp() - interval '5 minutes'
     ORDER BY l.created_at DESC
     LIMIT 1
       FOR UPDATE;

    IF FOUND THEN
        UPDATE public.server_audit_log l
           SET details = l.details
                   || jsonb_build_object('count', COALESCE((l.details ->> 'count')::integer, 1) + 1)
                   || CASE WHEN jsonb_array_length(COALESCE(l.details -> 'message_ids', '[]'::jsonb)) < 50
                           THEN jsonb_build_object('message_ids',
                                    COALESCE(l.details -> 'message_ids', '[]'::jsonb) || to_jsonb(NEW.id::text))
                           ELSE '{}'::jsonb END
         WHERE l.id = v_row.id;
        RETURN NULL;
    END IF;

    PERFORM public.server_audit_write(
        v_channel.server_id, 'message.delete',
        CASE WHEN NEW.user_id IS NOT NULL THEN 'user' WHEN NEW.bot_id IS NOT NULL THEN 'bot' END,
        v_author,
        COALESCE((SELECT p.username FROM public.profiles p WHERE p.id = NEW.user_id),
                 (SELECT b.username FROM public.bots b WHERE b.id = NEW.bot_id)),
        NULL,
        jsonb_build_object('channel_id', v_channel.id, 'channel_name', v_channel.name, 'count', 1,
                           'message_ids', jsonb_build_array(NEW.id::text)),
        NULL, v_actor);
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_messages_moderator_delete_audit ON public.messages;
CREATE TRIGGER z_messages_moderator_delete_audit
    AFTER UPDATE OF is_deleted ON public.messages
    FOR EACH ROW
    WHEN (NEW.is_deleted IS TRUE AND OLD.is_deleted IS NOT TRUE AND NEW.channel_id IS NOT NULL)
    EXECUTE FUNCTION public.server_audit_message_delete();

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------

-- Newest first. p_before pages on created_at; p_action is an action ('role.update') or a
-- kind ('role'). p_limit is clamped to 1..100.
CREATE OR REPLACE FUNCTION public.get_server_audit_log(
    p_server_id uuid,
    p_before timestamptz DEFAULT NULL,
    p_limit integer DEFAULT 50,
    p_action text DEFAULT NULL,
    p_actor_id uuid DEFAULT NULL)
RETURNS TABLE (
    id uuid,
    created_at timestamptz,
    action text,
    source text,
    actor_id uuid,
    actor_username text,
    actor_display_name text,
    actor_avatar_url text,
    actor_bot_id uuid,
    actor_bot_name text,
    actor_bot_avatar_url text,
    target_type text,
    target_id text,
    target_name text,
    target_display_name text,
    target_avatar_url text,
    changes jsonb,
    details jsonb,
    reason text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF NOT (public.is_current_user_admin()
            OR EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.owner = v_me)
            OR public.has_permission(v_me, p_server_id, 'VIEW_AUDIT_LOG')) THEN
        RAISE EXCEPTION 'VIEW_AUDIT_LOG required' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT l.id, l.created_at, l.action, l.source,
           l.actor_id, ap.username, ap.display_name, ap.avatar_url,
           l.actor_bot_id, COALESCE(b.display_name, b.username), b.avatar_url,
           l.target_type, l.target_id, COALESCE(tp.username, l.target_name), tp.display_name, tp.avatar_url,
           l.changes, l.details, l.reason
      FROM public.server_audit_log l
      LEFT JOIN public.profiles ap ON ap.id = l.actor_id
      LEFT JOIN public.bots b ON b.id = l.actor_bot_id
      LEFT JOIN public.profiles tp
             ON l.target_type = 'user'
            AND tp.id = CASE WHEN l.target_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                             THEN l.target_id::uuid END
     WHERE l.server_id = p_server_id
       AND (p_before IS NULL OR l.created_at < p_before)
       AND (p_action IS NULL OR l.action = p_action OR split_part(l.action, '.', 1) = p_action)
       AND (p_actor_id IS NULL OR l.actor_id = p_actor_id)
     ORDER BY l.created_at DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
END;
$$;

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.server_audit_log_purge()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    DELETE FROM public.server_audit_log WHERE created_at < now() - interval '90 days';
$$;

DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        BEGIN PERFORM cron.unschedule('purge-server-audit-log'); EXCEPTION WHEN OTHERS THEN NULL; END;
        PERFORM cron.schedule('purge-server-audit-log', '40 4 * * *', 'SELECT public.server_audit_log_purge()');
        RAISE NOTICE 'purge-server-audit-log scheduled';
    ELSE
        RAISE NOTICE 'pg_cron not available; server_audit_log_purge() is not scheduled';
    END IF;
END
$do$;

-- ---------------------------------------------------------------------------
-- server_membership_events: moderation rows for moderators
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT p.policyname
          FROM pg_policies p
         WHERE p.schemaname = 'public'
           AND p.tablename = 'server_membership_events'
           AND p.cmd = 'SELECT'
           AND p.policyname <> 'server_membership_events_select_member'
    LOOP
        EXECUTE format('DROP POLICY %I ON public.server_membership_events', r.policyname);
        RAISE NOTICE 'dropped policy % on server_membership_events', r.policyname;
    END LOOP;
END;
$$;

DROP POLICY IF EXISTS server_membership_events_select_member ON public.server_membership_events;
CREATE POLICY server_membership_events_select_member ON public.server_membership_events
    FOR SELECT TO authenticated
    USING (
        (SELECT public.is_current_user_admin())
        OR (server_id IN (SELECT us.server_id FROM public.user_servers us
                           WHERE us.user_id = (SELECT public.get_current_profile_id()))
            AND (event_type NOT IN ('kick', 'ban', 'unban')
                 OR EXISTS (SELECT 1 FROM public.servers s
                             WHERE s.id = server_membership_events.server_id
                               AND s.owner = (SELECT public.get_current_profile_id()))
                 OR public.has_permission((SELECT public.get_current_profile_id()), server_id, 'KICK_MEMBERS')
                 OR public.has_permission((SELECT public.get_current_profile_id()), server_id, 'BAN_MEMBERS')
                 OR public.has_permission((SELECT public.get_current_profile_id()), server_id, 'VIEW_AUDIT_LOG'))));

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('server_audit_pick', 'server_audit_value', 'server_audit_diff',
                             'server_audit_write', 'server_audit_fold_reorder', 'server_audit_channels',
                             'server_audit_categories', 'server_audit_roles', 'server_audit_user_roles',
                             'set_user_role_assigned_by', 'server_audit_overrides', 'server_audit_emojis',
                             'server_audit_servers', 'server_audit_settings', 'server_audit_invites',
                             'server_audit_bots', 'server_audit_attribute_bot', 'server_audit_membership_events',
                             'server_audit_timeouts', 'server_audit_message_delete', 'server_audit_log_purge')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.get_server_audit_log(uuid, timestamptz, integer, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_server_audit_log(uuid, timestamptz, integer, text, uuid) TO authenticated, service_role;

COMMIT;
