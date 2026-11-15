-- A new report tells the people who can act on it.
--
-- notify_report_moderators: AFTER INSERT on reports, a pending row sends a 'report_created'
-- notification. A report scoped to a server (scope_server_id) goes to that server's owner and to
-- accepted members with MANAGE_MESSAGES (can_current_user_moderate_server_reports' rule); any other
-- report goes to this instance's admins and moderators. Neither the reporter nor the reported
-- account is told, nor anyone suspended or deleted, nor anyone whose
-- notification_preferences.moderation_reports is false. A failed notification leaves the report
-- stored. The row names the report, never the reporter.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE public.notification_preferences
    ADD COLUMN IF NOT EXISTS moderation_reports boolean DEFAULT true;

-- Local, unsuspended, undeleted accounts among p_ids that take report notifications.
CREATE OR REPLACE FUNCTION public.report_alert_recipients(p_ids uuid[], p_report public.reports)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(array_agg(DISTINCT p.id), '{}'::uuid[])
      FROM public.profiles p
      LEFT JOIN public.notification_preferences np ON np.user_id = p.id
     WHERE p.id = ANY (p_ids)
       AND COALESCE(p.is_local, true)
       AND p.is_suspended IS NOT TRUE
       AND p.deleted_at IS NULL
       AND p.id IS DISTINCT FROM p_report.reporter_id
       AND p.id IS DISTINCT FROM p_report.reported_user_id
       AND COALESCE(np.moderation_reports, true)
$$;

CREATE OR REPLACE FUNCTION public.notify_report_moderators()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_ids uuid[];
    v_server_name text;
BEGIN
    IF NEW.scope_server_id IS NOT NULL THEN
        SELECT s.name INTO v_server_name FROM public.servers s WHERE s.id = NEW.scope_server_id;
        SELECT array_agg(u) INTO v_ids
          FROM (SELECT s.owner AS u FROM public.servers s WHERE s.id = NEW.scope_server_id
                UNION
                SELECT us.user_id
                  FROM public.user_servers us
                 WHERE us.server_id = NEW.scope_server_id
                   AND us.status = 'accepted'
                   AND public.has_permission(us.user_id, NEW.scope_server_id, 'MANAGE_MESSAGES', NULL)) m;
    ELSE
        SELECT array_agg(p.id) INTO v_ids
          FROM public.profiles p
         WHERE p.is_admin IS TRUE OR p.is_moderator IS TRUE;
    END IF;

    v_ids := public.report_alert_recipients(COALESCE(v_ids, '{}'::uuid[]), NEW);
    IF cardinality(v_ids) = 0 THEN
        RETURN NULL;
    END IF;

    -- p_server_id stays NULL: a muted server does not hide its reports from its moderators.
    PERFORM public.send_notification(
        'report_created',
        v_ids,
        jsonb_strip_nulls(jsonb_build_object(
            'report_id', NEW.id,
            'report_type', NEW.report_type,
            'category', NEW.category,
            'reason', NEW.reason,
            'source', NEW.source,
            'source_instance', NEW.source_instance,
            'scope', CASE WHEN NEW.scope_server_id IS NULL THEN 'instance' ELSE 'server' END,
            'report_server_id', NEW.scope_server_id,
            'report_server_name', v_server_name)));
    RETURN NULL;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_report_moderators: report %: %', NEW.id, SQLERRM;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trigger_notify_report_moderators ON public.reports;
CREATE TRIGGER trigger_notify_report_moderators
    AFTER INSERT ON public.reports
    FOR EACH ROW
    WHEN (NEW.status = 'pending')
    EXECUTE FUNCTION public.notify_report_moderators();

REVOKE ALL ON FUNCTION public.report_alert_recipients(uuid[], public.reports) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_alert_recipients(uuid[], public.reports) TO service_role;
REVOKE ALL ON FUNCTION public.notify_report_moderators() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_report_moderators() TO service_role;

-- Prod definers have mixed owners, postgres and supabase_admin. A definer runs as its owner, and a
-- non-superuser owner has no EXECUTE on a helper with PUBLIC revoked.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT DISTINCT pg_get_userbyid(p.proowner) AS owner
          FROM pg_proc p
         WHERE p.proname = 'notify_report_moderators' AND p.pronamespace = 'public'::regnamespace
    LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.report_alert_recipients(uuid[], public.reports) TO %I', r.owner);
    END LOOP;
END
$$;

COMMIT;
