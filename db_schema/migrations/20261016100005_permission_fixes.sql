-- Channel-resolved message moderation; the role hierarchy on timeouts; ADD_REACTIONS and
-- ATTACH_FILES enforced for members.
--
-- can_current_user_manage_messages_in_channel (messages_update_authorized,
-- messages_delete_authorized) resolves MANAGE_MESSAGES through get_user_permissions with the
-- channel's overrides: a channel Allow grants it there alone, a channel Deny removes a
-- server-wide grant there. The server owner and ADMINISTRATOR holders keep it everywhere. The
-- author and instance admin and moderator branches of both policies are unchanged. A role
-- flagged is_admin whose mask lacks ADMINISTRATOR no longer passes, as in every other
-- has_permission check.
--
-- moderate_report delete_message takes the same channel-resolved permission from a server
-- moderator; instance moderators keep it everywhere.
--
-- set_server_member_timeout refuses a target whose highest role position is equal to or above
-- the caller's, as kick_server_member and ban_server_member do. The server owner is exempt.
-- Applies to setting and lifting.
--
-- ADD_REACTIONS (bit 18): a reaction from a client on a local server channel's message needs it
-- in that channel, unless another member already reacted with the same emoji (Discord's rule).
-- ATTACH_FILES (bit 17): a client message on a local server channel that names an uploaded
-- object (a file part with path, or media_paths) not already on the row needs it in that
-- channel. File parts without path (picker GIFs, remote media) are links, not uploads.
-- Conversations, remote server copies and server-side writers are exempt.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- MANAGE_MESSAGES per channel
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.can_current_user_manage_messages_in_channel(p_channel_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_server uuid;
BEGIN
    IF v_me IS NULL OR p_channel_id IS NULL THEN
        RETURN false;
    END IF;
    SELECT c.server_id INTO v_server FROM public.channels c WHERE c.id = p_channel_id;
    IF v_server IS NULL THEN
        RETURN false;
    END IF;
    RETURN public.has_permission(v_me, v_server, 'MANAGE_MESSAGES', p_channel_id);
END;
$$;

-- As 20261009900001; delete_message from a server moderator needs MANAGE_MESSAGES in the
-- message's channel.
CREATE OR REPLACE FUNCTION public.moderate_report(
    p_report_id uuid,
    p_action text,
    p_note text DEFAULT NULL,
    p_reason text DEFAULT NULL,
    p_show_resolver boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_is_admin boolean := public.is_current_user_admin();
    v_is_mod boolean := public.is_current_user_admin_or_mod();
    v_server_mod boolean := false;
    r public.reports%ROWTYPE;
    v_target public.profiles%ROWTYPE;
    v_status text;
    v_open boolean;
    v_note text := NULLIF(left(btrim(COALESCE(p_note, '')), 1000), '');
    v_reason text := NULLIF(left(btrim(COALESCE(p_reason, '')), 500), '');
    v_resolver jsonb := '{}'::jsonb;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO r FROM public.reports WHERE id = p_report_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Report not found' USING ERRCODE = 'P0002';
    END IF;

    v_server_mod := r.scope_server_id IS NOT NULL
                    AND public.can_current_user_moderate_server_reports(r.scope_server_id);
    IF NOT v_is_mod AND NOT v_server_mod THEN
        RAISE EXCEPTION 'Permission denied: moderator access required' USING ERRCODE = '42501';
    END IF;
    IF NOT v_is_mod AND p_action NOT IN ('investigate', 'resolve', 'dismiss', 'reopen',
                                         'assign', 'unassign', 'delete_message') THEN
        RAISE EXCEPTION 'Permission denied: % requires an instance moderator', p_action USING ERRCODE = '42501';
    END IF;
    IF NOT v_is_admin AND p_action IN ('limit_domain', 'suspend_domain') THEN
        RAISE EXCEPTION 'Permission denied: % requires an instance admin', p_action USING ERRCODE = '42501';
    END IF;

    v_open := r.status IN ('pending', 'investigating');
    v_status := r.status;

    IF r.reported_user_id IS NOT NULL THEN
        SELECT * INTO v_target FROM public.profiles WHERE id = r.reported_user_id;
    END IF;

    CASE p_action
    WHEN 'investigate' THEN
        IF r.status <> 'pending' THEN
            RAISE EXCEPTION 'Only a pending report can move to investigating' USING ERRCODE = '22023';
        END IF;
        v_status := 'investigating';
    WHEN 'resolve' THEN
        IF NOT v_open THEN RAISE EXCEPTION 'Report is closed' USING ERRCODE = '22023'; END IF;
        v_status := 'resolved';
    WHEN 'dismiss' THEN
        IF NOT v_open THEN RAISE EXCEPTION 'Report is closed' USING ERRCODE = '22023'; END IF;
        v_status := 'dismissed';
    WHEN 'reopen' THEN
        IF v_open THEN RAISE EXCEPTION 'Report is open' USING ERRCODE = '22023'; END IF;
        v_status := 'pending';
    WHEN 'assign' THEN
        UPDATE public.reports SET assigned_to = v_caller, updated_at = now() WHERE id = r.id;
    WHEN 'unassign' THEN
        UPDATE public.reports SET assigned_to = NULL, updated_at = now() WHERE id = r.id;
    WHEN 'forward' THEN
        IF r.source <> 'local' OR v_target.id IS NULL OR COALESCE(v_target.is_local, true) THEN
            RAISE EXCEPTION 'Only a local report about a remote account can be forwarded' USING ERRCODE = '22023';
        END IF;
        IF r.forwarded_at IS NOT NULL OR r.federation_status IN ('queued', 'processing') THEN
            RAISE EXCEPTION 'Report already forwarded' USING ERRCODE = '22023';
        END IF;
        UPDATE public.reports
           SET forward = true, federation_status = 'queued', updated_at = now()
         WHERE id = r.id;
        PERFORM public.queue_federation_job(
            'federate-report', jsonb_build_object('type', 'create', 'report_id', r.id), 10, 5, 7200);
    WHEN 'delete_post' THEN
        IF NOT v_open THEN RAISE EXCEPTION 'Report is closed' USING ERRCODE = '22023'; END IF;
        IF r.reported_post_id IS NULL THEN
            RAISE EXCEPTION 'Report names no post' USING ERRCODE = '22023';
        END IF;
        UPDATE public.posts SET is_deleted = true, deleted_at = now() WHERE id = r.reported_post_id;
        v_status := 'resolved';
    WHEN 'mark_sensitive' THEN
        IF NOT v_open THEN RAISE EXCEPTION 'Report is closed' USING ERRCODE = '22023'; END IF;
        IF r.reported_post_id IS NULL THEN
            RAISE EXCEPTION 'Report names no post' USING ERRCODE = '22023';
        END IF;
        UPDATE public.posts SET is_sensitive = true WHERE id = r.reported_post_id;
        v_status := 'resolved';
    WHEN 'delete_message' THEN
        IF NOT v_open THEN RAISE EXCEPTION 'Report is closed' USING ERRCODE = '22023'; END IF;
        IF r.reported_message_id IS NULL THEN
            RAISE EXCEPTION 'Report names no message' USING ERRCODE = '22023';
        END IF;
        IF NOT v_is_mod AND NOT EXISTS (
            SELECT 1 FROM public.messages m
              JOIN public.channels c ON c.id = m.channel_id
             WHERE m.id = r.reported_message_id
               AND public.has_permission(v_caller, c.server_id, 'MANAGE_MESSAGES', m.channel_id)) THEN
            RAISE EXCEPTION 'Permission denied: MANAGE_MESSAGES required in the message''s channel'
                USING ERRCODE = '42501';
        END IF;
        -- Same write as CoreMessageService.deleteMessage.
        UPDATE public.messages
           SET content = '[{"type": "text", "text": "[deleted]"}]'::jsonb, is_deleted = true
         WHERE id = r.reported_message_id;
        v_status := 'resolved';
    WHEN 'warn' THEN
        IF NOT v_open THEN RAISE EXCEPTION 'Report is closed' USING ERRCODE = '22023'; END IF;
        IF v_target.id IS NULL OR NOT COALESCE(v_target.is_local, true) THEN
            RAISE EXCEPTION 'Only a local account can be warned' USING ERRCODE = '22023';
        END IF;
        PERFORM public.send_notification_to_user(
            'moderation_warning', v_target.id,
            jsonb_build_object('text', v_reason, 'category', r.category, 'report_type', r.report_type),
            NULL, NULL, NULL, NULL, 'high');
        v_status := 'resolved';
    WHEN 'silence_account', 'suspend_account', 'force_sensitive_account' THEN
        IF NOT v_open THEN RAISE EXCEPTION 'Report is closed' USING ERRCODE = '22023'; END IF;
        IF v_target.id IS NULL THEN
            RAISE EXCEPTION 'Report names no account' USING ERRCODE = '22023';
        END IF;
        IF v_target.id = v_caller THEN
            RAISE EXCEPTION 'Cannot moderate your own account' USING ERRCODE = '42501';
        END IF;
        IF NOT v_is_admin AND (v_target.is_admin IS TRUE OR v_target.is_moderator IS TRUE) THEN
            RAISE EXCEPTION 'Moderators cannot act on instance staff' USING ERRCODE = '42501';
        END IF;
        IF p_action = 'silence_account' THEN
            UPDATE public.profiles
               SET is_silenced = true, silenced_at = now(), silenced_reason = v_reason
             WHERE id = v_target.id;
        ELSIF p_action = 'suspend_account' THEN
            UPDATE public.profiles
               SET is_suspended = true, suspended_at = now(), suspension_reason = v_reason
             WHERE id = v_target.id;
        ELSE
            UPDATE public.profiles SET force_sensitive = true WHERE id = v_target.id;
        END IF;
        v_status := 'resolved';
    WHEN 'limit_domain', 'suspend_domain' THEN
        IF NOT v_open THEN RAISE EXCEPTION 'Report is closed' USING ERRCODE = '22023'; END IF;
        IF v_target.id IS NULL OR COALESCE(v_target.is_local, true) THEN
            RAISE EXCEPTION 'Only a remote account''s domain can be limited or suspended' USING ERRCODE = '22023';
        END IF;
        PERFORM public.set_domain_moderation(
            v_target.domain,
            CASE p_action WHEN 'limit_domain' THEN 'limit' ELSE 'suspend' END,
            v_reason);
        v_status := 'resolved';
    ELSE
        RAISE EXCEPTION 'Invalid report action: %', p_action USING ERRCODE = '22023';
    END CASE;

    IF v_status IS DISTINCT FROM r.status THEN
        UPDATE public.reports
           SET status = v_status,
               updated_at = now(),
               resolved_at = CASE WHEN v_status IN ('resolved', 'dismissed') THEN now() END,
               resolved_by = CASE WHEN v_status IN ('resolved', 'dismissed') THEN v_caller END,
               resolution_note = CASE WHEN v_status IN ('resolved', 'dismissed') THEN v_note
                                      WHEN v_status = 'pending' THEN NULL
                                      ELSE resolution_note END
         WHERE id = r.id;
    END IF;

    PERFORM public.log_admin_action(
        v_caller, 'report_' || p_action, 'report', r.id::text,
        jsonb_strip_nulls(jsonb_build_object(
            'status', v_status,
            'previous_status', r.status,
            'report_type', r.report_type,
            'category', r.category,
            'reported_user_id', r.reported_user_id,
            'reported_post_id', r.reported_post_id,
            'reported_message_id', r.reported_message_id,
            'domain', CASE WHEN p_action IN ('limit_domain', 'suspend_domain') THEN lower(v_target.domain) END,
            'reason', v_reason,
            'note', v_note,
            'server_scope', CASE WHEN NOT v_is_mod THEN r.scope_server_id END)));

    IF r.reporter_id IS NOT NULL
       AND v_status IS DISTINCT FROM r.status
       AND v_status IN ('investigating', 'resolved', 'dismissed') THEN
        IF p_show_resolver THEN
            SELECT jsonb_build_object('resolver_username', p.username,
                                      'resolver_display_name', p.display_name,
                                      'resolver_avatar_url', p.avatar_url)
              INTO v_resolver
              FROM public.profiles p WHERE p.id = v_caller;
        END IF;
        PERFORM public.send_notification_to_user(
            'report_update', r.reporter_id,
            jsonb_build_object(
                'report_id', r.id,
                'status', v_status,
                'report_type', r.report_type,
                'category', r.category,
                'resolution_note', CASE WHEN v_status IN ('resolved', 'dismissed') THEN v_note END,
                'show_resolver', COALESCE(p_show_resolver, false))
            || COALESCE(v_resolver, '{}'::jsonb),
            NULL, NULL, NULL,
            CASE WHEN p_show_resolver THEN v_caller END,
            'normal');
    END IF;

    RETURN jsonb_build_object('report_id', r.id, 'action', p_action, 'status', v_status);
END;
$$;

REVOKE ALL ON FUNCTION public.moderate_report(uuid, text, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.moderate_report(uuid, text, text, text, boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Timeouts follow the role hierarchy
-- ---------------------------------------------------------------------------

-- As 20261005100001, with kick_server_member's rank check.
CREATE OR REPLACE FUNCTION public.set_server_member_timeout(
    p_server_id uuid, p_user_id uuid, p_seconds integer, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.automod_require(p_server_id, ARRAY['TIMEOUT_MEMBERS']);
    v_until timestamptz;
BEGIN
    IF p_user_id = v_me THEN
        RAISE EXCEPTION 'You cannot time yourself out' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.owner = p_user_id)
       OR public.has_permission(p_user_id, p_server_id, 'ADMINISTRATOR') THEN
        RAISE EXCEPTION 'The server owner and administrators cannot be timed out' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.owner = v_me)
       AND public.get_user_highest_role_position(v_me, p_server_id)
           <= public.get_user_highest_role_position(p_user_id, p_server_id) THEN
        RAISE EXCEPTION 'Cannot time out a member with an equal or higher role' USING ERRCODE = '42501';
    END IF;
    IF p_seconds IS NULL OR p_seconds < 0 OR p_seconds > 2419200 THEN
        RAISE EXCEPTION 'Timeouts last from 0 seconds to 28 days' USING ERRCODE = '22023';
    END IF;

    IF p_seconds = 0 THEN
        DELETE FROM public.server_member_timeouts WHERE server_id = p_server_id AND user_id = p_user_id;
        RETURN jsonb_build_object('user_id', p_user_id, 'until', NULL);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.user_servers us
                    WHERE us.server_id = p_server_id AND us.user_id = p_user_id AND us.status = 'accepted') THEN
        RAISE EXCEPTION 'Not a member of this server' USING ERRCODE = '22023';
    END IF;

    v_until := now() + make_interval(secs => p_seconds);
    INSERT INTO public.server_member_timeouts (server_id, user_id, until, reason, source, created_by)
    VALUES (p_server_id, p_user_id, v_until, left(NULLIF(btrim(p_reason), ''), 512), 'moderator', v_me)
    ON CONFLICT (server_id, user_id) DO UPDATE
       SET until = EXCLUDED.until, reason = EXCLUDED.reason, source = EXCLUDED.source,
           created_by = EXCLUDED.created_by, created_at = now();
    RETURN jsonb_build_object('user_id', p_user_id, 'until', v_until);
END;
$$;

REVOKE ALL ON FUNCTION public.set_server_member_timeout(uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_server_member_timeout(uuid, uuid, integer, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- ADD_REACTIONS
-- ---------------------------------------------------------------------------

-- Invoker trigger: the writer sees the message, its channel and the reactions it is joining.
CREATE OR REPLACE FUNCTION public.enforce_reaction_add_permission()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_channel uuid;
    v_server uuid;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    SELECT m.channel_id, c.server_id INTO v_channel, v_server
      FROM public.messages m
      JOIN public.channels c ON c.id = m.channel_id
      JOIN public.servers s ON s.id = c.server_id
     WHERE m.id = NEW.message_id
       AND s.is_local_server IS NOT FALSE;
    IF v_server IS NULL
       OR public.has_permission(public.get_current_profile_id(), v_server, 'ADD_REACTIONS', v_channel)
       OR EXISTS (SELECT 1 FROM public.reactions r
                   WHERE r.message_id = NEW.message_id
                     AND r.emoji_id IS NOT DISTINCT FROM NEW.emoji_id
                     AND r.custom_emoji_content IS NOT DISTINCT FROM NEW.custom_emoji_content) THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Missing permission: ADD_REACTIONS' USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_reaction_add_permission() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_reactions_add_permission ON public.reactions;
CREATE TRIGGER a_reactions_add_permission
    BEFORE INSERT ON public.reactions
    FOR EACH ROW EXECUTE FUNCTION public.enforce_reaction_add_permission();

-- ---------------------------------------------------------------------------
-- ATTACH_FILES
-- ---------------------------------------------------------------------------

-- message_media and Drive object names a message row carries: file parts with path, and
-- media_paths (encrypted rows).
CREATE OR REPLACE FUNCTION public.message_upload_paths(p_content jsonb, p_media_paths text[])
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(array_agg(DISTINCT p), '{}')
      FROM (SELECT e ->> 'path' AS p
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_content) = 'array'
                                             THEN p_content ELSE '[]'::jsonb END) e
             WHERE jsonb_typeof(e) = 'object' AND e ->> 'type' = 'file' AND e ? 'path'
            UNION ALL
            SELECT unnest(COALESCE(p_media_paths, '{}'))) x
     WHERE p IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.message_upload_paths(jsonb, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.message_upload_paths(jsonb, text[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enforce_message_attach_files()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server uuid;
    v_new text[];
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1
       OR NEW.channel_id IS NULL THEN
        RETURN NEW;
    END IF;

    v_new := public.message_upload_paths(NEW.content, NEW.media_paths);
    IF TG_OP = 'UPDATE' THEN
        v_new := ARRAY(SELECT unnest(v_new)
                       EXCEPT
                       SELECT unnest(public.message_upload_paths(OLD.content, OLD.media_paths)));
    END IF;
    IF cardinality(v_new) = 0 THEN
        RETURN NEW;
    END IF;

    SELECT c.server_id INTO v_server
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id
     WHERE c.id = NEW.channel_id
       AND s.is_local_server IS NOT FALSE;
    IF v_server IS NULL
       OR public.has_permission(public.get_current_profile_id(), v_server, 'ATTACH_FILES', NEW.channel_id) THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Missing permission: ATTACH_FILES' USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_message_attach_files() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_messages_attach_files ON public.messages;
CREATE TRIGGER a_messages_attach_files
    BEFORE INSERT OR UPDATE OF content, media_paths ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.enforce_message_attach_files();

COMMIT;
