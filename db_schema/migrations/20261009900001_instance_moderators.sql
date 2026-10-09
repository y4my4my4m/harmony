-- Instance moderators.
--
-- profiles.is_moderator had no working writer: the admin panel updated another user's row,
-- which profiles_update_own filters to zero rows without an error. And moderate_user
-- admitted moderators, but prevent_profile_moderation_self_update refused every account
-- flag change by a non-admin, so a moderator's suspend, silence or force-sensitive raised.
--
-- - admin_set_moderator: instance admins grant and revoke the moderator flag on local
--   accounts; audit-logged.
-- - prevent_profile_moderation_self_update: checks callers whose role is anon or
--   authenticated (as recompute_supporter_tier); service_role and direct database sessions
--   pass. Admins change any flag. Moderators change is_suspended, is_silenced and
--   force_sensitive on accounts that are neither staff nor their own; nobody else changes
--   them, and only admins raise is_admin or is_moderator.
-- - moderate_user, moderate_report: a moderator's account actions refuse staff targets and
--   the caller's own account; moderate_report's account actions open to moderators, domain
--   actions stay admin-only.
-- - notify_admins_on_pending_donation: admins only; moderators cannot open the queue.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.prevent_profile_moderation_self_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_role text := current_setting('role', true);
    v_actor public.profiles%ROWTYPE;
    v_account_flags boolean;
    v_promotion boolean;
BEGIN
    IF v_role IS DISTINCT FROM 'authenticated' AND v_role IS DISTINCT FROM 'anon' THEN
        RETURN NEW;
    END IF;

    v_account_flags := NEW.is_suspended IS DISTINCT FROM OLD.is_suspended
                    OR NEW.is_silenced IS DISTINCT FROM OLD.is_silenced
                    OR NEW.force_sensitive IS DISTINCT FROM OLD.force_sensitive;
    -- Lowering is_admin or is_moderator is not escalation; account deletion lowers them.
    v_promotion := (NEW.is_admin IS DISTINCT FROM OLD.is_admin AND NEW.is_admin IS NOT FALSE)
                OR (NEW.is_moderator IS DISTINCT FROM OLD.is_moderator AND NEW.is_moderator IS NOT FALSE);
    IF NOT v_account_flags AND NOT v_promotion THEN
        RETURN NEW;
    END IF;

    SELECT * INTO v_actor
      FROM public.profiles p
     WHERE p.auth_user_id = auth.uid()
       AND COALESCE(p.is_suspended, false) = false
     LIMIT 1;

    IF v_actor.is_admin IS TRUE THEN
        RETURN NEW;
    END IF;

    IF v_actor.is_moderator IS TRUE
       AND NOT v_promotion
       AND OLD.is_admin IS NOT TRUE
       AND OLD.is_moderator IS NOT TRUE
       AND OLD.id IS DISTINCT FROM v_actor.id THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Permission denied: cannot modify moderation flags on profile'
        USING ERRCODE = '42501';
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_moderator(p_profile_id uuid, p_is_moderator boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_actor uuid;
    v_target public.profiles%ROWTYPE;
BEGIN
    SELECT p.id INTO v_actor
      FROM public.profiles p
     WHERE p.auth_user_id = auth.uid()
       AND p.is_admin IS TRUE
       AND COALESCE(p.is_suspended, false) = false;
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_target FROM public.profiles WHERE id = p_profile_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User not found' USING ERRCODE = 'P0002';
    END IF;
    IF p_is_moderator IS TRUE AND v_target.is_local IS NOT TRUE THEN
        RAISE EXCEPTION 'Only local accounts can be instance moderators' USING ERRCODE = '22023';
    END IF;

    UPDATE public.profiles
       SET is_moderator = COALESCE(p_is_moderator, false)
     WHERE id = p_profile_id;

    PERFORM public.log_admin_action(v_actor,
        CASE WHEN p_is_moderator IS TRUE THEN 'user_promote_moderator' ELSE 'user_demote_moderator' END,
        'user', p_profile_id::text, jsonb_build_object('username', v_target.username));

    RETURN COALESCE(p_is_moderator, false);
END;
$$;

COMMENT ON FUNCTION public.admin_set_moderator(uuid, boolean) IS
    'Grant or revoke the instance moderator flag on a local profile (profiles.id) as the calling admin.';

-- As 20261005600001, with the staff and self checks.
CREATE OR REPLACE FUNCTION public.moderate_user(
    p_admin_id uuid, p_target_user_id uuid, p_action text, p_reason text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_actor uuid;
    v_actor_admin boolean;
    v_target_username text;
    v_target_staff boolean;
BEGIN
    IF p_admin_id IS NOT NULL AND p_admin_id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'p_admin_id must be the caller' USING ERRCODE = '42501';
    END IF;

    SELECT p.id, p.is_admin IS TRUE INTO v_actor, v_actor_admin
      FROM public.profiles p
     WHERE p.id = public.get_current_profile_id()
       AND (p.is_admin IS TRUE OR p.is_moderator IS TRUE)
       AND p.is_suspended IS NOT TRUE;

    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'Insufficient permissions' USING ERRCODE = '42501';
    END IF;

    SELECT username, (is_admin IS TRUE OR is_moderator IS TRUE)
      INTO v_target_username, v_target_staff
      FROM public.profiles WHERE id = p_target_user_id;
    IF v_target_username IS NULL THEN
        RAISE EXCEPTION 'User not found';
    END IF;
    IF p_target_user_id = v_actor THEN
        RAISE EXCEPTION 'Cannot moderate your own account' USING ERRCODE = '42501';
    END IF;
    IF v_target_staff AND NOT v_actor_admin THEN
        RAISE EXCEPTION 'Moderators cannot act on instance staff' USING ERRCODE = '42501';
    END IF;

    IF p_action = 'suspend' THEN
        UPDATE public.profiles
           SET is_suspended = true, suspended_at = now(), suspension_reason = p_reason
         WHERE id = p_target_user_id;
        PERFORM public.log_admin_action(v_actor, 'user_suspend'::text, 'user'::text, p_target_user_id::text,
            jsonb_build_object('reason', p_reason, 'username', v_target_username));
    ELSIF p_action = 'unsuspend' THEN
        UPDATE public.profiles
           SET is_suspended = false, suspended_at = NULL, suspension_reason = NULL
         WHERE id = p_target_user_id;
        PERFORM public.log_admin_action(v_actor, 'user_unsuspend'::text, 'user'::text, p_target_user_id::text,
            jsonb_build_object('username', v_target_username));
    ELSIF p_action = 'force_sensitive' THEN
        UPDATE public.profiles SET force_sensitive = true WHERE id = p_target_user_id;
        PERFORM public.log_admin_action(v_actor, 'user_force_sensitive'::text, 'user'::text, p_target_user_id::text,
            jsonb_build_object('reason', p_reason, 'username', v_target_username));
    ELSIF p_action = 'unforce_sensitive' THEN
        UPDATE public.profiles SET force_sensitive = false WHERE id = p_target_user_id;
        PERFORM public.log_admin_action(v_actor, 'user_unforce_sensitive'::text, 'user'::text, p_target_user_id::text,
            jsonb_build_object('username', v_target_username));
    ELSIF p_action = 'silence' THEN
        UPDATE public.profiles
           SET is_silenced = true, silenced_at = now(), silenced_reason = p_reason
         WHERE id = p_target_user_id;
        PERFORM public.log_admin_action(v_actor, 'user_silence'::text, 'user'::text, p_target_user_id::text,
            jsonb_build_object('reason', p_reason, 'username', v_target_username));
    ELSIF p_action = 'unsilence' THEN
        UPDATE public.profiles
           SET is_silenced = false, silenced_at = NULL, silenced_reason = NULL
         WHERE id = p_target_user_id;
        PERFORM public.log_admin_action(v_actor, 'user_unsilence'::text, 'user'::text, p_target_user_id::text,
            jsonb_build_object('username', v_target_username));
    ELSE
        RAISE EXCEPTION 'Invalid action: %', p_action;
    END IF;

    RETURN true;
END;
$$;
COMMENT ON FUNCTION public.moderate_user(uuid, uuid, text, text) IS
    'Suspend, silence or force-sensitive a profile as the calling admin or moderator; moderators act only on non-staff accounts other than their own. p_admin_id is null or auth.uid(); p_target_user_id is profiles.id.';

-- As the baseline, recipients limited to admins.
CREATE OR REPLACE FUNCTION public.notify_admins_on_pending_donation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_recipient_ids uuid[];
    v_data jsonb;
BEGIN
    SELECT array_agg(id) INTO v_recipient_ids
    FROM public.profiles
    WHERE is_admin = true
      AND is_suspended = false;

    IF v_recipient_ids IS NULL OR array_length(v_recipient_ids, 1) IS NULL THEN
        RETURN NEW;
    END IF;

    v_data := jsonb_build_object(
        'pending_donation_id', NEW.id,
        'platform', NEW.platform,
        'amount', NEW.amount,
        'currency', NEW.currency,
        'donor_name', NEW.donor_name,
        'donor_message', NEW.donor_message,
        'received_at', NEW.received_at
    );

    PERFORM public.send_notification(
        'admin_pending_donation'::varchar,
        v_recipient_ids,
        v_data,
        NULL,    -- server_id
        NULL,    -- channel_id
        NULL,    -- conversation_id
        NULL,    -- from_user_id (donor isn't a profile)
        'normal'::varchar
    );

    RETURN NEW;
END;
$$;

-- As 20261005000001: account actions open to moderators, with the staff and self checks.
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


REVOKE ALL ON FUNCTION public.admin_set_moderator(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_moderator(uuid, boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.moderate_user(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.moderate_user(uuid, uuid, text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.moderate_report(uuid, text, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.moderate_report(uuid, text, text, text, boolean) TO authenticated, service_role;

COMMIT;
