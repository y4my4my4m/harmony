-- Instance staff (profiles.is_admin, is_moderator) act as Trust & Safety on servers hosted here,
-- from the admin dashboard. They are not server admins: each action is a fixed T&S step, taken
-- as staff and recorded as such.
--
--   staff_remove_member(server, profile, ban, reason)
--   staff_remove_message(message, reason)
--   staff_set_server_suspended(server, suspended, reason)
--   staff_delete_server(server, reason)
--       Admitted: instance admins and moderators that are not suspended; servers with
--       is_local_server only. A moderator does not act on instance staff; the server owner is
--       neither removed nor banned (the server is suspended or deleted instead).
--       A removal or ban writes what kick_server_member and ban_server_member write: the
--       membership goes, a ban adds server_bans and drops the member's roles, a
--       server_membership_events row (payload.staff true) whose triggers record the audit row
--       and, for a member of another instance, the federation_member_removals row of the
--       Group's Remove (staff true, sent as harmony:staff), and the system message
--       (metadata.staff true). A message removal is moderate_report's delete_message write,
--       federated by trigger_queue_channel_message_delete_federation as the Group's Delete.
--       A deletion is delete_server_with_cleanup's DELETE; it does not federate.
--       Every action is also written to admin_audit_log (log_admin_action): a deleted server's
--       own audit log goes with it.
--   harmony.staff_action
--       Transaction-local setting, '1' while one of the above or a suspension removal runs.
--       server_audit_write adds details.staff = true to every row written meanwhile;
--       server_audit_message_delete writes nothing (staff_remove_message writes its row, with
--       the reason).
--   staff_hosted_servers, staff_server_members, staff_server_channels, staff_server_messages
--       The dashboard's reads, same admission. Messages are listed per channel or per author;
--       content of an encrypted message is not returned.
--
-- Suspended server: servers.suspended_at, suspended_reason, suspended_by; a client statement
-- that writes them is refused (a_servers_suspension_guard).
--   a_messages_server_suspension_guard   no new message in its channels; system rows pass
--   a_user_servers_suspension_guard      no new membership, no pending -> accepted
--   server:updated                       carries suspended_at and suspended_reason to members
-- Both guards raise 'SERVER_SUSPENDED: ...' (42501). The federation backend refuses a Join
-- with a Reject and drops new channel messages before they reach the guard.
--
-- A remote account suspended here leaves every server hosted here:
--   profiles.is_suspended false -> true on a profile of another instance, and
--   federated_instances.is_blocked false -> true for its domain (a domain suspension). Each
--   accepted or pending membership in a local server gets a federation_member_removals row
--   (reason 'suspended', staff true) and an audit row 'member.kick' with details.cause
--   'account_suspended' or 'domain_suspended'. No system message, as
--   remove_members_from_other_instances. Delivery to a blocked domain is skipped by
--   DeliveryQueue.
--
-- Converges by state.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

ALTER TABLE public.servers ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE public.servers ADD COLUMN IF NOT EXISTS suspended_reason text;
ALTER TABLE public.servers ADD COLUMN IF NOT EXISTS suspended_by uuid
    REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.servers DROP CONSTRAINT IF EXISTS servers_suspended_reason_length;
ALTER TABLE public.servers ADD CONSTRAINT servers_suspended_reason_length
    CHECK (suspended_reason IS NULL OR char_length(suspended_reason) <= 512);

COMMENT ON COLUMN public.servers.suspended_at IS
    'Set by instance staff (staff_set_server_suspended): no new messages or members while set.';
COMMENT ON COLUMN public.servers.suspended_reason IS
    'Reason given by instance staff; shown to members in the suspension banner.';
COMMENT ON COLUMN public.servers.suspended_by IS
    'Profile of the instance staff member who suspended the server.';

ALTER TABLE public.federation_member_removals
    DROP CONSTRAINT IF EXISTS federation_member_removals_reason_check;
ALTER TABLE public.federation_member_removals
    ADD CONSTRAINT federation_member_removals_reason_check
    CHECK (reason IN ('federation_closed', 'kick', 'ban', 'suspended'));
ALTER TABLE public.federation_member_removals
    ADD COLUMN IF NOT EXISTS staff boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.federation_member_removals.staff IS
    'Removed by instance staff of this instance; the Remove carries harmony:staff.';

-- ---------------------------------------------------------------------------
-- Audit marker
-- ---------------------------------------------------------------------------

-- As 20261010600001, with details.staff under harmony.staff_action.
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
    v_details jsonb := p_details;
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

    IF current_setting('harmony.staff_action', true) = '1' THEN
        v_details := COALESCE(v_details, '{}'::jsonb) || jsonb_build_object('staff', true);
    END IF;

    INSERT INTO public.server_audit_log
        (server_id, actor_id, source, action, target_type, target_id, target_name,
         changes, details, reason, created_at)
    VALUES
        (p_server_id, v_actor, v_source, p_action, p_target_type, p_target_id, left(p_target_name, 200),
         NULLIF(p_changes, '{}'::jsonb), NULLIF(jsonb_strip_nulls(v_details), '{}'::jsonb),
         left(NULLIF(btrim(p_reason), ''), 512), clock_timestamp())
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

-- As 20261010600001; a staff removal writes its own row.
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
    IF pg_trigger_depth() > 1 OR current_setting('harmony.staff_action', true) = '1' THEN
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
       AND l.details ->> 'staff' IS NULL
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

-- As 20261025200001, with staff from the event payload.
CREATE OR REPLACE FUNCTION public.trigger_remote_member_removal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.user_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.servers s
                       WHERE s.id = NEW.server_id AND s.is_local_server IS NOT FALSE)
       OR NOT EXISTS (SELECT 1 FROM public.profiles p
                       WHERE p.id = NEW.user_id AND p.is_local IS FALSE AND p.federated_id IS NOT NULL)
    THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.federation_member_removals (server_id, profile_id, reason, summary, staff)
    VALUES (NEW.server_id, NEW.user_id, NEW.event_type,
            left(nullif(btrim(NEW.payload->>'reason'), ''), 300),
            COALESCE(NEW.payload->>'staff', '') = 'true');
    RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Suspended servers
-- ---------------------------------------------------------------------------

-- Invoker: under a SECURITY DEFINER function current_user is its owner, so only client statements
-- are refused.
CREATE OR REPLACE FUNCTION public.guard_server_suspension_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;
    IF (TG_OP = 'INSERT'
        AND (NEW.suspended_at IS NOT NULL OR NEW.suspended_reason IS NOT NULL OR NEW.suspended_by IS NOT NULL))
       OR (TG_OP = 'UPDATE'
        AND (NEW.suspended_at, NEW.suspended_reason, NEW.suspended_by)
            IS DISTINCT FROM (OLD.suspended_at, OLD.suspended_reason, OLD.suspended_by)) THEN
        RAISE EXCEPTION 'SERVER_SUSPENSION_STAFF_ONLY: instance staff suspend servers through staff_set_server_suspended'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_servers_suspension_guard ON public.servers;
CREATE TRIGGER a_servers_suspension_guard
    BEFORE INSERT OR UPDATE OF suspended_at, suspended_reason, suspended_by ON public.servers
    FOR EACH ROW EXECUTE FUNCTION public.guard_server_suspension_write();

CREATE OR REPLACE FUNCTION public.refuse_message_in_suspended_server()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF EXISTS (SELECT 1
                 FROM public.channels c
                 JOIN public.servers s ON s.id = c.server_id
                WHERE c.id = NEW.channel_id
                  AND s.suspended_at IS NOT NULL) THEN
        RAISE EXCEPTION 'SERVER_SUSPENDED: this server is suspended by instance staff'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_messages_server_suspension_guard ON public.messages;
CREATE TRIGGER a_messages_server_suspension_guard
    BEFORE INSERT ON public.messages
    FOR EACH ROW
    WHEN (NEW.channel_id IS NOT NULL AND NEW.is_system IS NOT TRUE)
    EXECUTE FUNCTION public.refuse_message_in_suspended_server();

CREATE OR REPLACE FUNCTION public.refuse_join_of_suspended_server()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.status IS NOT DISTINCT FROM 'banned'
       OR (TG_OP = 'UPDATE' AND (NEW.status IS NOT DISTINCT FROM OLD.status
                                 OR NEW.status NOT IN ('accepted', 'pending'))) THEN
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM public.servers s WHERE s.id = NEW.server_id AND s.suspended_at IS NOT NULL) THEN
        RAISE EXCEPTION 'SERVER_SUSPENDED: this server is suspended by instance staff'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_user_servers_suspension_guard ON public.user_servers;
CREATE TRIGGER a_user_servers_suspension_guard
    BEFORE INSERT OR UPDATE OF status ON public.user_servers
    FOR EACH ROW EXECUTE FUNCTION public.refuse_join_of_suspended_server();

-- As 20261014100002, with suspended_at and suspended_reason.
CREATE OR REPLACE FUNCTION public.broadcast_server_change_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_member_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    FOR v_member_id IN
      SELECT user_id FROM user_servers WHERE server_id = NEW.id
    LOOP
      PERFORM realtime.send(
        jsonb_build_object(
          'type', 'server:updated',
          'server', jsonb_build_object(
            'id', NEW.id,
            'name', NEW.name,
            'description', NEW.description,
            'icon', NEW.icon,
            'banner', NEW.banner,
            'sidebar_banner', NEW.sidebar_banner,
            'public', NEW.public,
            'federation_enabled', NEW.federation_enabled,
            'suspended_at', NEW.suspended_at,
            'suspended_reason', NEW.suspended_reason,
            'updated_at', NEW.updated_at
          )
        ),
        'user_event',
        'user:' || v_member_id::text,
        true
      );
    END LOOP;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Staff actions
-- ---------------------------------------------------------------------------

-- The calling staff profile. With p_server_id, the server must be hosted here.
CREATE OR REPLACE FUNCTION public.staff_caller(p_server_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL OR NOT public.is_current_user_admin_or_mod() THEN
        RAISE EXCEPTION 'Instance admins and moderators only' USING ERRCODE = '42501';
    END IF;
    IF p_server_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.servers s
             WHERE s.id = p_server_id AND s.is_local_server IS NOT FALSE) THEN
        RAISE EXCEPTION 'SERVER_NOT_HOSTED_HERE: no server % is hosted on this instance', p_server_id
            USING ERRCODE = 'P0002';
    END IF;
    RETURN v_me;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_remove_member(
    p_server_id uuid,
    p_profile_id uuid,
    p_ban boolean DEFAULT false,
    p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.staff_caller(p_server_id);
    v_ban boolean := COALESCE(p_ban, false);
    v_reason text := NULLIF(left(btrim(COALESCE(p_reason, '')), 512), '');
    v_target public.profiles%ROWTYPE;
    v_server_name text;
    v_system_channel_id uuid;
    v_system_messages_enabled boolean;
    v_prev text := current_setting('harmony.staff_action', true);
BEGIN
    SELECT * INTO v_target FROM public.profiles WHERE id = p_profile_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User not found' USING ERRCODE = 'P0002';
    END IF;
    IF p_profile_id = v_me THEN
        RAISE EXCEPTION 'Cannot remove yourself' USING ERRCODE = '42501';
    END IF;
    IF NOT public.is_current_user_admin() AND (v_target.is_admin IS TRUE OR v_target.is_moderator IS TRUE) THEN
        RAISE EXCEPTION 'Moderators cannot act on instance staff' USING ERRCODE = '42501';
    END IF;

    SELECT s.name INTO v_server_name FROM public.servers s WHERE s.id = p_server_id;
    IF EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.owner = p_profile_id) THEN
        RAISE EXCEPTION 'SERVER_OWNER: the owner cannot be removed; suspend or delete the server instead'
            USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.user_servers us
                    WHERE us.server_id = p_server_id AND us.user_id = p_profile_id
                      AND us.status IN ('accepted', 'pending')) THEN
        RAISE EXCEPTION 'NOT_A_MEMBER: this account is not a member of the server' USING ERRCODE = 'P0002';
    END IF;

    PERFORM set_config('harmony.staff_action', '1', true);

    IF v_ban THEN
        INSERT INTO public.server_bans (server_id, user_id, banned_by, reason)
        VALUES (p_server_id, p_profile_id, v_me, v_reason)
        ON CONFLICT (server_id, user_id) DO NOTHING;
    END IF;

    -- Suppresses the "has left the server" trigger; "was kicked" / "was banned" is posted below.
    PERFORM set_config('harmony.skip_leave_message', '1', true);

    DELETE FROM public.user_servers
     WHERE user_id = p_profile_id AND server_id = p_server_id;

    IF v_ban THEN
        DELETE FROM public.user_roles
         WHERE user_id = p_profile_id AND server_id = p_server_id;
    END IF;

    INSERT INTO public.server_membership_events (server_id, user_id, event_type, payload)
    VALUES (p_server_id, p_profile_id, CASE WHEN v_ban THEN 'ban' ELSE 'kick' END,
            jsonb_build_object(
                CASE WHEN v_ban THEN 'banned_by' ELSE 'kicked_by' END, v_me,
                'reason', COALESCE(v_reason, ''),
                'messages_deleted', 0,
                'staff', true));

    SELECT system_channel_id, system_messages_enabled
      INTO v_system_channel_id, v_system_messages_enabled
      FROM public.server_settings WHERE server_id = p_server_id;
    IF v_system_messages_enabled IS NOT FALSE THEN
        IF v_system_channel_id IS NULL THEN
            v_system_channel_id := public.get_default_channel(p_server_id);
        END IF;
        IF v_system_channel_id IS NOT NULL THEN
            INSERT INTO public.messages (channel_id, content, is_system, metadata)
            VALUES (
                v_system_channel_id,
                jsonb_build_array(jsonb_build_object('type', 'text', 'text',
                    CASE WHEN v_ban THEN 'was banned from the server' ELSE 'was kicked from the server' END)),
                true,
                jsonb_build_object('type', CASE WHEN v_ban THEN 'member_ban' ELSE 'member_kick' END,
                                   'subject_id', p_profile_id, 'actor_id', v_me,
                                   'reason', COALESCE(v_reason, ''), 'staff', true)
            );
        END IF;
    END IF;

    PERFORM public.log_admin_action(v_me,
        CASE WHEN v_ban THEN 'server_member_ban' ELSE 'server_member_remove' END,
        'server', p_server_id::text,
        jsonb_build_object('server_name', v_server_name, 'user_id', p_profile_id,
                           'username', v_target.username, 'domain', v_target.domain, 'reason', v_reason));

    PERFORM set_config('harmony.staff_action', COALESCE(v_prev, ''), true);

    RETURN jsonb_build_object('success', true, 'banned', v_ban);
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_remove_message(
    p_message_id uuid,
    p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.staff_caller(NULL);
    v_reason text := NULLIF(left(btrim(COALESCE(p_reason, '')), 512), '');
    v_msg record;
    v_prev text := current_setting('harmony.staff_action', true);
BEGIN
    SELECT m.id, m.user_id, m.bot_id, m.is_deleted, m.channel_id, c.name AS channel_name, c.server_id,
           COALESCE(p.username, b.username) AS author_name
      INTO v_msg
      FROM public.messages m
      JOIN public.channels c ON c.id = m.channel_id
      LEFT JOIN public.profiles p ON p.id = m.user_id
      LEFT JOIN public.bots b ON b.id = m.bot_id
     WHERE m.id = p_message_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Message not found in a server channel' USING ERRCODE = 'P0002';
    END IF;
    PERFORM public.staff_caller(v_msg.server_id);

    IF v_msg.is_deleted IS TRUE THEN
        RETURN jsonb_build_object('success', true, 'already_removed', true);
    END IF;

    PERFORM set_config('harmony.staff_action', '1', true);

    -- Same write as moderate_report's delete_message.
    UPDATE public.messages
       SET content = '[{"type": "text", "text": "[deleted]"}]'::jsonb, is_deleted = true
     WHERE id = p_message_id;

    PERFORM public.server_audit_write(
        v_msg.server_id, 'message.delete',
        CASE WHEN v_msg.user_id IS NOT NULL THEN 'user' WHEN v_msg.bot_id IS NOT NULL THEN 'bot' END,
        COALESCE(v_msg.user_id, v_msg.bot_id)::text,
        v_msg.author_name,
        NULL,
        jsonb_build_object('channel_id', v_msg.channel_id, 'channel_name', v_msg.channel_name, 'count', 1,
                           'message_ids', jsonb_build_array(p_message_id::text)),
        v_reason, v_me);

    PERFORM public.log_admin_action(v_me, 'server_message_remove', 'message', p_message_id::text,
        jsonb_build_object('server_id', v_msg.server_id, 'channel_id', v_msg.channel_id,
                           'author_id', COALESCE(v_msg.user_id, v_msg.bot_id), 'reason', v_reason));

    PERFORM set_config('harmony.staff_action', COALESCE(v_prev, ''), true);

    RETURN jsonb_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_set_server_suspended(
    p_server_id uuid,
    p_suspended boolean,
    p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.staff_caller(p_server_id);
    v_reason text := NULLIF(left(btrim(COALESCE(p_reason, '')), 512), '');
    v_server public.servers%ROWTYPE;
    v_prev text := current_setting('harmony.staff_action', true);
BEGIN
    IF p_suspended IS NULL THEN
        RAISE EXCEPTION 'p_suspended is required' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_server FROM public.servers WHERE id = p_server_id FOR UPDATE;
    IF NOT p_suspended AND v_server.suspended_at IS NULL THEN
        RETURN jsonb_build_object('success', true, 'suspended', false, 'unchanged', true);
    END IF;

    PERFORM set_config('harmony.staff_action', '1', true);

    IF p_suspended THEN
        UPDATE public.servers
           SET suspended_at = COALESCE(suspended_at, now()),
               suspended_reason = v_reason,
               suspended_by = v_me
         WHERE id = p_server_id
        RETURNING * INTO v_server;
    ELSE
        UPDATE public.servers
           SET suspended_at = NULL, suspended_reason = NULL, suspended_by = NULL
         WHERE id = p_server_id
        RETURNING * INTO v_server;
    END IF;

    PERFORM public.server_audit_write(
        p_server_id, CASE WHEN p_suspended THEN 'server.suspend' ELSE 'server.unsuspend' END,
        'server', p_server_id::text, v_server.name, NULL, NULL, v_reason, v_me);

    PERFORM public.log_admin_action(v_me,
        CASE WHEN p_suspended THEN 'server_suspend' ELSE 'server_unsuspend' END,
        'server', p_server_id::text,
        jsonb_build_object('server_name', v_server.name, 'reason', v_reason));

    PERFORM set_config('harmony.staff_action', COALESCE(v_prev, ''), true);

    RETURN jsonb_build_object('success', true, 'suspended', p_suspended,
                              'suspended_at', v_server.suspended_at,
                              'suspended_reason', v_server.suspended_reason);
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_delete_server(
    p_server_id uuid,
    p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.staff_caller(p_server_id);
    v_reason text := NULLIF(left(btrim(COALESCE(p_reason, '')), 512), '');
    v_server public.servers%ROWTYPE;
    v_members integer;
    v_remote integer;
BEGIN
    SELECT * INTO v_server FROM public.servers WHERE id = p_server_id FOR UPDATE;

    SELECT count(*)::int, count(*) FILTER (WHERE p.is_local IS FALSE)::int
      INTO v_members, v_remote
      FROM public.user_servers us
      JOIN public.profiles p ON p.id = us.user_id
     WHERE us.server_id = p_server_id AND us.status = 'accepted';

    PERFORM public.log_admin_action(v_me, 'server_delete', 'server', p_server_id::text,
        jsonb_build_object('server_name', v_server.name, 'owner_id', v_server.owner,
                           'owner_username', (SELECT p.username FROM public.profiles p WHERE p.id = v_server.owner),
                           'members', v_members, 'remote_members', v_remote, 'reason', v_reason));

    DELETE FROM public.servers WHERE id = p_server_id;

    RETURN jsonb_build_object('success', true, 'members', v_members);
END;
$$;

-- ---------------------------------------------------------------------------
-- Dashboard reads
-- ---------------------------------------------------------------------------

-- p_search matches the name, the owner's username or the id. Newest first.
CREATE OR REPLACE FUNCTION public.staff_hosted_servers(
    p_search text DEFAULT NULL,
    p_suspended_only boolean DEFAULT false,
    p_limit integer DEFAULT 25,
    p_offset integer DEFAULT 0)
RETURNS TABLE (
    id uuid,
    name text,
    icon text,
    public boolean,
    federation_enabled boolean,
    created_at timestamptz,
    owner_id uuid,
    owner_username text,
    owner_display_name text,
    owner_avatar_url text,
    member_count integer,
    remote_member_count integer,
    suspended_at timestamptz,
    suspended_reason text,
    suspended_by_username text,
    total_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
    v_pattern text;
BEGIN
    PERFORM public.staff_caller(NULL);
    IF v_search IS NOT NULL THEN
        v_pattern := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    END IF;

    RETURN QUERY
    WITH matched AS (
        SELECT s.id, s.created_at, count(*) OVER () AS total
          FROM public.servers s
          LEFT JOIN public.profiles o ON o.id = s.owner
         WHERE s.is_local_server IS NOT FALSE
           AND (NOT COALESCE(p_suspended_only, false) OR s.suspended_at IS NOT NULL)
           AND (v_search IS NULL
                OR s.name ILIKE v_pattern
                OR o.username ILIKE v_pattern
                OR s.id::text = lower(v_search))
         ORDER BY s.created_at DESC, s.id
         LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100)
        OFFSET GREATEST(COALESCE(p_offset, 0), 0)
    )
    SELECT s.id, s.name, s.icon, s.public, s.federation_enabled, s.created_at,
           s.owner, o.username, o.display_name, o.avatar_url,
           COALESCE(mc.members, 0), COALESCE(mc.remote, 0),
           s.suspended_at, s.suspended_reason, sb.username,
           m.total
      FROM matched m
      JOIN public.servers s ON s.id = m.id
      LEFT JOIN public.profiles o ON o.id = s.owner
      LEFT JOIN public.profiles sb ON sb.id = s.suspended_by
      LEFT JOIN LATERAL (
          SELECT count(*)::int AS members,
                 count(*) FILTER (WHERE p.is_local IS FALSE)::int AS remote
            FROM public.user_servers us
            JOIN public.profiles p ON p.id = us.user_id
           WHERE us.server_id = s.id AND us.status = 'accepted') mc ON true
     ORDER BY m.created_at DESC, m.id;
END;
$$;

-- Owner first, then by join time.
CREATE OR REPLACE FUNCTION public.staff_server_members(
    p_server_id uuid,
    p_search text DEFAULT NULL,
    p_limit integer DEFAULT 50,
    p_offset integer DEFAULT 0)
RETURNS TABLE (
    user_id uuid,
    username text,
    display_name text,
    avatar_url text,
    domain text,
    is_local boolean,
    status text,
    joined_at timestamptz,
    is_owner boolean,
    is_instance_staff boolean,
    total_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
    v_pattern text;
BEGIN
    PERFORM public.staff_caller(p_server_id);
    IF v_search IS NOT NULL THEN
        v_pattern := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    END IF;

    RETURN QUERY
    SELECT p.id, p.username, p.display_name, p.avatar_url, p.domain, p.is_local IS NOT FALSE,
           us.status, us.created_at,
           s.owner IS NOT DISTINCT FROM p.id,
           (p.is_admin IS TRUE OR p.is_moderator IS TRUE),
           count(*) OVER ()
      FROM public.user_servers us
      JOIN public.profiles p ON p.id = us.user_id
      JOIN public.servers s ON s.id = us.server_id
     WHERE us.server_id = p_server_id
       AND us.status IN ('accepted', 'pending')
       AND (v_search IS NULL
            OR p.username ILIKE v_pattern
            OR p.display_name ILIKE v_pattern
            OR p.domain ILIKE v_pattern)
     ORDER BY (s.owner IS NOT DISTINCT FROM p.id) DESC, us.created_at, p.id
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_server_channels(p_server_id uuid)
RETURNS TABLE (
    id uuid,
    name text,
    type smallint,
    category_name text,
    "position" integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.staff_caller(p_server_id);
    RETURN QUERY
    SELECT c.id, c.name, c.type, cc.name, c."order"
      FROM public.channels c
      LEFT JOIN public.channel_categories cc ON cc.id = c.category
     WHERE c.server_id = p_server_id
     ORDER BY cc."order" NULLS FIRST, c."order", c.name;
END;
$$;

-- Newest first, in one channel or by one author; p_before pages on created_at.
CREATE OR REPLACE FUNCTION public.staff_server_messages(
    p_server_id uuid,
    p_channel_id uuid DEFAULT NULL,
    p_author_id uuid DEFAULT NULL,
    p_before timestamptz DEFAULT NULL,
    p_limit integer DEFAULT 50)
RETURNS TABLE (
    id uuid,
    channel_id uuid,
    channel_name text,
    thread_id uuid,
    user_id uuid,
    bot_id uuid,
    author_username text,
    author_display_name text,
    author_avatar_url text,
    author_domain text,
    content jsonb,
    encrypted boolean,
    created_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.staff_caller(p_server_id);
    IF p_channel_id IS NULL AND p_author_id IS NULL THEN
        RAISE EXCEPTION 'A channel or an author is required' USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT m.id, m.channel_id, c.name, m.thread_id, m.user_id, m.bot_id,
           COALESCE(p.username, b.username), COALESCE(p.display_name, b.display_name),
           COALESCE(p.avatar_url, b.avatar_url), p.domain,
           CASE WHEN m.encrypted IS TRUE THEN NULL ELSE m.content END,
           m.encrypted IS TRUE,
           m.created_at
      FROM public.messages m
      JOIN public.channels c ON c.id = m.channel_id
      LEFT JOIN public.profiles p ON p.id = m.user_id
      LEFT JOIN public.bots b ON b.id = m.bot_id
     WHERE c.server_id = p_server_id
       AND (p_channel_id IS NULL OR m.channel_id = p_channel_id)
       AND (p_author_id IS NULL OR m.user_id = p_author_id)
       AND m.is_deleted IS NOT TRUE
       AND m.is_system IS NOT TRUE
       AND (p_before IS NULL OR m.created_at < p_before)
     ORDER BY m.created_at DESC, m.id
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
END;
$$;

-- ---------------------------------------------------------------------------
-- Remote accounts suspended here
-- ---------------------------------------------------------------------------

-- Accepted and pending memberships of the given remote profiles in servers hosted here.
CREATE OR REPLACE FUNCTION public.remove_suspended_remote_members(p_profile_ids uuid[], p_cause text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row record;
    v_count integer := 0;
    v_prev_staff text := current_setting('harmony.staff_action', true);
    v_prev_leave text := current_setting('harmony.skip_leave_message', true);
BEGIN
    IF p_profile_ids IS NULL OR cardinality(p_profile_ids) = 0 THEN
        RETURN 0;
    END IF;

    PERFORM set_config('harmony.staff_action', '1', true);
    PERFORM set_config('harmony.skip_leave_message', '1', true);

    FOR v_row IN
        SELECT us.id AS membership_id, us.server_id, p.id AS profile_id, p.username, p.domain
          FROM public.user_servers us
          JOIN public.servers s ON s.id = us.server_id
          JOIN public.profiles p ON p.id = us.user_id
         WHERE us.user_id = ANY (p_profile_ids)
           AND us.status IN ('accepted', 'pending')
           AND s.is_local_server IS NOT FALSE
           AND p.is_local IS FALSE
           AND p.federated_id IS NOT NULL
    LOOP
        INSERT INTO public.federation_member_removals (server_id, profile_id, reason, staff)
        VALUES (v_row.server_id, v_row.profile_id, 'suspended', true);

        DELETE FROM public.user_servers WHERE id = v_row.membership_id;

        PERFORM public.server_audit_write(
            v_row.server_id, 'member.kick', 'user', v_row.profile_id::text, v_row.username,
            NULL, jsonb_build_object('cause', p_cause, 'domain', v_row.domain));
        v_count := v_count + 1;
    END LOOP;

    PERFORM set_config('harmony.staff_action', COALESCE(v_prev_staff, ''), true);
    PERFORM set_config('harmony.skip_leave_message', COALESCE(v_prev_leave, ''), true);
    RETURN v_count;
END;
$$;

-- As 20261006600001; a profile of another instance also leaves every server hosted here.
-- Memberships of servers hosted elsewhere stay.
CREATE OR REPLACE FUNCTION public.handle_remote_user_suspension()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.is_suspended = true AND OLD.is_suspended IS DISTINCT FROM true THEN
        DELETE FROM public.follows f
         WHERE f.follower_id = NEW.id
           AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = f.following_id AND p.is_local = true);
        DELETE FROM public.follows f
         WHERE f.following_id = NEW.id
           AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = f.follower_id AND p.is_local = true);

        DELETE FROM public.voice_channel_participants WHERE user_id = NEW.id;

        UPDATE public.federated_voice_calls
           SET status = 'ended', ended_at = now()
         WHERE (caller_id = NEW.id OR recipient_id = NEW.id)
           AND status IN ('pending', 'accepted');

        IF NEW.is_local IS FALSE THEN
            PERFORM public.remove_suspended_remote_members(ARRAY[NEW.id], 'account_suspended');
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.handle_remote_user_suspension() IS
    'On suspension: removes follows with local profiles, voice presence and active federated calls; a profile of another instance leaves the servers hosted here with the Group''s Remove. Its memberships of servers hosted elsewhere are kept.';

CREATE OR REPLACE FUNCTION public.trigger_domain_suspension_removals()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.is_blocked IS TRUE THEN
        RETURN NULL;
    END IF;
    PERFORM public.remove_suspended_remote_members(
        ARRAY(SELECT p.id FROM public.profiles p
               WHERE p.is_local IS FALSE AND lower(p.domain) = NEW.domain),
        'domain_suspended');
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_federated_instances_suspension_removals ON public.federated_instances;
CREATE TRIGGER z_federated_instances_suspension_removals
    AFTER INSERT OR UPDATE OF is_blocked ON public.federated_instances
    FOR EACH ROW
    WHEN (NEW.is_blocked IS TRUE)
    EXECUTE FUNCTION public.trigger_domain_suspension_removals();

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
           AND p.proname IN ('staff_remove_member', 'staff_remove_message', 'staff_set_server_suspended',
                             'staff_delete_server', 'staff_hosted_servers', 'staff_server_members',
                             'staff_server_channels', 'staff_server_messages')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
    END LOOP;

    FOR fn IN
        SELECT p.oid::regprocedure FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('staff_caller', 'remove_suspended_remote_members', 'trigger_domain_suspension_removals',
                             'refuse_message_in_suspended_server', 'refuse_join_of_suspended_server',
                             'guard_server_suspension_write')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;
END;
$$;

COMMENT ON FUNCTION public.staff_remove_member(uuid, uuid, boolean, text) IS
    'Instance staff remove (or ban) a member of a server hosted here; recorded in the server audit log as staff.';
COMMENT ON FUNCTION public.staff_remove_message(uuid, text) IS
    'Instance staff remove a message in a server hosted here; federated as the Group''s Delete.';
COMMENT ON FUNCTION public.staff_set_server_suspended(uuid, boolean, text) IS
    'Instance staff suspend or unsuspend a server hosted here: no new messages or members while suspended.';
COMMENT ON FUNCTION public.staff_delete_server(uuid, text) IS
    'Instance staff delete a server hosted here; logged in admin_audit_log.';

COMMIT;

NOTIFY pgrst, 'reload schema';
