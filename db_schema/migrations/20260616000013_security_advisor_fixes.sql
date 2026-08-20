-- =============================================================================
-- Security advisor fixes (ERROR-level) + unread_counts hardening
-- =============================================================================
-- Source: Supabase security advisor (prod + staging), 2026-06-15.
-- Mirrors changes already applied to db_schema/init/ so fresh deploys match:
--   * 70_views.sql / 71_views_performance.sql -> security_invoker on 12 views
--   * 98_enable_rls.sql                       -> RLS on 3 federation stat tables
--   * 31_rls_policies_extended.sql            -> unread_counts own-row policies
--
-- Idempotent: re-running is safe.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1) security_definer_view (lint 0010, ERROR)
-- -----------------------------------------------------------------------------
-- Without security_invoker, a view runs with its owner's privileges and bypasses
-- the caller's RLS. Flipping to security_invoker makes each view respect the
-- querying user's RLS. Verified safe: base-table RLS already grants the right
-- access (posts_select_public encodes full visibility; the admin/metrics tables
-- have is_current_user_admin() policies; federation_health is SELECT USING(true)).
ALTER VIEW IF EXISTS public.follow_relationships     SET (security_invoker = true);
ALTER VIEW IF EXISTS public.user_bookmarks           SET (security_invoker = true);
ALTER VIEW IF EXISTS public.visible_posts            SET (security_invoker = true);
ALTER VIEW IF EXISTS public.active_threads_view      SET (security_invoker = true);
ALTER VIEW IF EXISTS public.pinned_messages_view     SET (security_invoker = true);
ALTER VIEW IF EXISTS public.active_statuses_view     SET (security_invoker = true);
ALTER VIEW IF EXISTS public.timeline_posts           SET (security_invoker = true);
ALTER VIEW IF EXISTS public.federation_health_metrics SET (security_invoker = true);
ALTER VIEW IF EXISTS public.federation_stats          SET (security_invoker = true);
ALTER VIEW IF EXISTS public.instance_health           SET (security_invoker = true);
ALTER VIEW IF EXISTS public.metrics_summary_view      SET (security_invoker = true);
ALTER VIEW IF EXISTS public.slow_queries_summary      SET (security_invoker = true);

-- Defense-in-depth: instance-wide metrics/health views are admin-dashboard
-- surfaces, never needed by anonymous PostgREST callers. REVOKE has no
-- IF EXISTS, and not every environment has every view (e.g. staging built from
-- an older init snapshot lacks federation_stats/slow_queries_summary), so guard
-- each statement on the view actually existing.
DO $$
DECLARE
    v text;
    views text[] := ARRAY[
        'public.federation_stats',
        'public.instance_health',
        'public.metrics_summary_view',
        'public.slow_queries_summary',
        'public.federation_health_metrics'
    ];
BEGIN
    FOREACH v IN ARRAY views LOOP
        IF to_regclass(v) IS NOT NULL THEN
            EXECUTE format('REVOKE SELECT ON %s FROM anon', v);
        ELSE
            RAISE NOTICE 'Skipping REVOKE on missing view: %', v;
        END IF;
    END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- 2) rls_disabled_in_public (lint 0013, ERROR)
-- -----------------------------------------------------------------------------
-- Internal stat/log tables written by the federation backend (service_role) and
-- SECURITY DEFINER functions. They are PostgREST-exposed but had RLS off. The
-- frontend never reads them. Enable RLS with NO client policy: service_role and
-- SECURITY DEFINER writers bypass RLS, all client roles are denied. Guarded on
-- existence so an out-of-date environment missing a table doesn't abort.
DO $$
DECLARE
    t text;
    tbls text[] := ARRAY[
        'public.federation_delivery_stats',
        'public.activity_processing_logs',
        'public.activitypub_processing_stats'
    ];
BEGIN
    FOREACH t IN ARRAY tbls LOOP
        IF to_regclass(t) IS NOT NULL THEN
            EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
        ELSE
            RAISE NOTICE 'Skipping ENABLE RLS on missing table: %', t;
        END IF;
    END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- 3) rls_policy_always_true on unread_counts (WARNING)
-- -----------------------------------------------------------------------------
-- The old "System can manage unread counts" policy (WITH CHECK (true), FOR ALL)
-- let any authenticated user read/modify ANY user's unread rows. Rows are
-- populated by SECURITY DEFINER triggers/RPCs + service_role (all bypass RLS),
-- so scoping the client policy to the caller's own profile id is safe. The
-- frontend only SELECTs and UPDATEs (clears) its own rows.
DROP POLICY IF EXISTS "System can manage unread counts" ON public.unread_counts;

DROP POLICY IF EXISTS "unread_counts_select_own" ON public.unread_counts;
CREATE POLICY "unread_counts_select_own" ON public.unread_counts
    FOR SELECT TO authenticated
    USING (user_id = public.get_current_profile_id());

DROP POLICY IF EXISTS "unread_counts_update_own" ON public.unread_counts;
CREATE POLICY "unread_counts_update_own" ON public.unread_counts
    FOR UPDATE TO authenticated
    USING (user_id = public.get_current_profile_id())
    WITH CHECK (user_id = public.get_current_profile_id());

NOTIFY pgrst, 'reload schema';

COMMIT;
