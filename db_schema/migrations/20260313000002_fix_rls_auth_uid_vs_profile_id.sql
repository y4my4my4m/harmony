-- Migration: Fix RLS policies that incorrectly use auth.uid() where column references profiles(id)
-- auth.uid() returns auth.users.id, but many columns reference profiles.id (profile UUID).
-- These are different UUIDs. The correct helper is get_current_profile_id().
-- Also uses is_current_user_admin() which already resolves via profile internally.
-- Idempotent: uses DROP POLICY IF EXISTS before each CREATE POLICY.

BEGIN;

-- ---------------------------------------------------------------------------
-- REPORTS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can create reports" ON public.reports;
CREATE POLICY "Users can create reports" ON public.reports
    FOR INSERT TO authenticated
    WITH CHECK (reporter_id = public.get_current_profile_id());

DROP POLICY IF EXISTS "Users can view own reports" ON public.reports;
CREATE POLICY "Users can view own reports" ON public.reports
    FOR SELECT TO authenticated
    USING (reporter_id = public.get_current_profile_id());

DROP POLICY IF EXISTS "Admins can view all reports" ON public.reports;
CREATE POLICY "Admins can view all reports" ON public.reports
    FOR SELECT TO authenticated
    USING (public.is_current_user_admin());

DROP POLICY IF EXISTS "Admins can update reports" ON public.reports;
CREATE POLICY "Admins can update reports" ON public.reports
    FOR UPDATE TO authenticated
    USING (public.is_current_user_admin());

-- ---------------------------------------------------------------------------
-- INSTANCE FUNDING (admin policies)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "funding_modify_admin" ON public.instance_funding;
CREATE POLICY "funding_modify_admin" ON public.instance_funding
    FOR ALL TO authenticated USING (public.is_current_user_admin());

DROP POLICY IF EXISTS "tiers_modify_admin" ON public.instance_supporter_tiers;
CREATE POLICY "tiers_modify_admin" ON public.instance_supporter_tiers
    FOR ALL TO authenticated USING (public.is_current_user_admin());

DROP POLICY IF EXISTS "supporters_modify_admin" ON public.instance_supporters;
CREATE POLICY "supporters_modify_admin" ON public.instance_supporters
    FOR ALL TO authenticated USING (public.is_current_user_admin());

-- ---------------------------------------------------------------------------
-- INSTANCE DONATION HISTORY
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "donation_history_select_admin" ON public.instance_donation_history;
CREATE POLICY "donation_history_select_admin" ON public.instance_donation_history
    FOR SELECT TO authenticated USING (
        public.is_current_user_admin()
        OR user_id = public.get_current_profile_id()
    );

DROP POLICY IF EXISTS "donation_history_modify_admin" ON public.instance_donation_history;
CREATE POLICY "donation_history_modify_admin" ON public.instance_donation_history
    FOR ALL TO authenticated USING (public.is_current_user_admin());

-- ---------------------------------------------------------------------------
-- AP ACTIVITIES (conditional - actor_id must be uuid; old schema had actor_id as text)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'ap_activities' AND column_name = 'actor_id'
        AND data_type = 'uuid'
    ) THEN
        EXECUTE 'DROP POLICY IF EXISTS "Users can view their own activities" ON public.ap_activities';
        EXECUTE 'CREATE POLICY "Users can view their own activities" ON public.ap_activities FOR SELECT USING (actor_id = public.get_current_profile_id())';

        EXECUTE 'DROP POLICY IF EXISTS "Users can create their own activities" ON public.ap_activities';
        EXECUTE 'CREATE POLICY "Users can create their own activities" ON public.ap_activities FOR INSERT WITH CHECK (actor_id = public.get_current_profile_id())';

        EXECUTE 'DROP POLICY IF EXISTS "Users can update their own activities" ON public.ap_activities';
        EXECUTE 'CREATE POLICY "Users can update their own activities" ON public.ap_activities FOR UPDATE USING (actor_id = public.get_current_profile_id())';
    ELSE
        RAISE NOTICE 'ap_activities.actor_id is not uuid (old schema?) - skipping user-level ap_activities policies. Run 20260310_ap_activities_schema_update first.';
    END IF;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'ap_activities table does not exist, skipping';
END $$;

-- ---------------------------------------------------------------------------
-- ADMIN AUDIT LOG
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admin audit log admin access" ON public.admin_audit_log;
CREATE POLICY "Admin audit log admin access" ON public.admin_audit_log
    TO authenticated USING (public.is_current_user_admin());

-- ---------------------------------------------------------------------------
-- BLOCKED INSTANCES (was using profiles.id = auth.uid() - wrong comparison)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Blocked instances admin access" ON public.blocked_instances;
CREATE POLICY "Blocked instances admin access" ON public.blocked_instances
    TO authenticated USING (public.is_current_user_admin());

-- ---------------------------------------------------------------------------
-- PERFORMANCE METRICS (consistency: use is_current_user_admin())
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can read metrics" ON public.performance_metrics;
CREATE POLICY "Admins can read metrics" ON public.performance_metrics
    FOR SELECT USING (public.is_current_user_admin());

-- ---------------------------------------------------------------------------
-- GIF FAVORITES
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own gif favorites" ON public.gif_favorites;
CREATE POLICY "Users can view own gif favorites" ON public.gif_favorites
    FOR SELECT USING (user_id = public.get_current_profile_id());

DROP POLICY IF EXISTS "Users can insert own gif favorites" ON public.gif_favorites;
CREATE POLICY "Users can insert own gif favorites" ON public.gif_favorites
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id());

DROP POLICY IF EXISTS "Users can delete own gif favorites" ON public.gif_favorites;
CREATE POLICY "Users can delete own gif favorites" ON public.gif_favorites
    FOR DELETE USING (user_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- EMOJI USAGE
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "emoji_usage_access_policy" ON public.emoji_usage;
CREATE POLICY "emoji_usage_access_policy" ON public.emoji_usage
    TO authenticated USING (
        server_id IN (
            SELECT us.server_id FROM public.user_servers us
            WHERE us.user_id = public.get_current_profile_id()
        )
    );

-- ---------------------------------------------------------------------------
-- USER SESSIONS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own sessions" ON public.user_sessions;
CREATE POLICY "Users can view own sessions" ON public.user_sessions
    FOR SELECT USING (public.get_current_profile_id() = user_id);

DROP POLICY IF EXISTS "Users can insert own sessions" ON public.user_sessions;
CREATE POLICY "Users can insert own sessions" ON public.user_sessions
    FOR INSERT WITH CHECK (public.get_current_profile_id() = user_id);

DROP POLICY IF EXISTS "Users can update own sessions" ON public.user_sessions;
CREATE POLICY "Users can update own sessions" ON public.user_sessions
    FOR UPDATE USING (public.get_current_profile_id() = user_id);

DROP POLICY IF EXISTS "Users can delete own sessions" ON public.user_sessions;
CREATE POLICY "Users can delete own sessions" ON public.user_sessions
    FOR DELETE USING (public.get_current_profile_id() = user_id);

-- ---------------------------------------------------------------------------
-- USER TIMELINE CACHE
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can access own timeline cache" ON public.user_timeline_cache;
CREATE POLICY "Users can access own timeline cache" ON public.user_timeline_cache
    USING (public.get_current_profile_id() = user_id);

-- ---------------------------------------------------------------------------
-- VOICE FEDERATION EVENTS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can create their own voice events" ON public.voice_federation_events;
CREATE POLICY "Users can create their own voice events" ON public.voice_federation_events
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id());

DROP POLICY IF EXISTS "Users can view voice events they're involved in" ON public.voice_federation_events;
CREATE POLICY "Users can view voice events they're involved in" ON public.voice_federation_events
    FOR SELECT USING (user_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- SERVER FEDERATION EVENTS (conditional - only if user_id column exists)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'server_federation_events' AND column_name = 'user_id'
    ) THEN
        EXECUTE 'DROP POLICY IF EXISTS "Users can create their own server events" ON public.server_federation_events';
        EXECUTE 'CREATE POLICY "Users can create their own server events" ON public.server_federation_events FOR INSERT WITH CHECK (user_id = public.get_current_profile_id())';

        EXECUTE 'DROP POLICY IF EXISTS "Users can view server events they''re involved in" ON public.server_federation_events';
        EXECUTE 'CREATE POLICY "Users can view server events they''re involved in" ON public.server_federation_events FOR SELECT USING (user_id = public.get_current_profile_id())';
    END IF;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'server_federation_events table does not exist, skipping';
END $$;

-- ---------------------------------------------------------------------------
-- SERVER MEMBERSHIP EVENTS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Members can view server membership events" ON public.server_membership_events;
CREATE POLICY "Members can view server membership events" ON public.server_membership_events
    FOR SELECT TO authenticated USING (
        server_id IN (
            SELECT us.server_id FROM public.user_servers us
            WHERE us.user_id = public.get_current_profile_id()
        )
    );

-- ---------------------------------------------------------------------------
-- FEDERATED VOICE CALLS (conditional - only if caller_id column exists)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'federated_voice_calls' AND column_name = 'caller_id'
    ) THEN
        EXECUTE 'DROP POLICY IF EXISTS "Recipients can update call status" ON public.federated_voice_calls';
        EXECUTE 'CREATE POLICY "Recipients can update call status" ON public.federated_voice_calls FOR UPDATE USING (public.get_current_profile_id() = recipient_id) WITH CHECK (public.get_current_profile_id() = recipient_id)';

        EXECUTE 'DROP POLICY IF EXISTS "Update own calls" ON public.federated_voice_calls';
        EXECUTE 'CREATE POLICY "Update own calls" ON public.federated_voice_calls FOR UPDATE USING (caller_id = public.get_current_profile_id() OR recipient_id = public.get_current_profile_id())';
    END IF;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'federated_voice_calls table does not exist, skipping';
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
