-- Internal SECURITY DEFINER functions are not callable by clients.
--
-- Supabase's default privileges grant EXECUTE on new public functions to anon and
-- authenticated, so these internal routines were reachable through PostgREST with the
-- anon key. Each runs as its owner and trusts its arguments:
--
--   queue_federation_job              enqueues any job with caller-supplied data: push
--                                     notifications to any user, follow/undo/accept
--                                     activities signed as any local user
--   cleanup_dead_endpoint_users       deletes every follow of a remote endpoint's users
--   log_admin_action                  writes admin_audit_log rows for any admin id
--   create_default_server_structure   adds default categories and channels to any server
--   bump_server_channel_epochs        rotates a server's channel epochs
--   fetch_link_preview                fetches a caller-supplied URL from the database host
--   purge_stale_invites               deletes invites
--
-- Callers are SECURITY DEFINER functions owned by postgres or supabase_admin (27 for
-- queue_federation_job on production), triggers and pg_cron; none is called through the
-- client API or referenced by a policy. Every overload of each name is converged.

BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('queue_federation_job', 'cleanup_dead_endpoint_users',
                             'log_admin_action', 'create_default_server_structure',
                             'bump_server_channel_epochs', 'fetch_link_preview',
                             'purge_stale_invites')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, grantee);
            END IF;
        END LOOP;
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
