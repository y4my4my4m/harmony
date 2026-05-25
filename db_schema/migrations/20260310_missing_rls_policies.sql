-- Migration: Add missing RLS policies for 26 tables that had RLS enabled but no policies
-- These policies match production (latest_dev_backup.sql)
-- Idempotent: uses DROP POLICY IF EXISTS before each CREATE POLICY

BEGIN;

-- ---------------------------------------------------------------------------
-- AP ACTIVITIES (ActivityPub activity log)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "System can manage ActivityPub activities" ON public.ap_activities;
CREATE POLICY "System can manage ActivityPub activities" ON public.ap_activities USING (true);

DROP POLICY IF EXISTS "Users can view their own activities" ON public.ap_activities;
CREATE POLICY "Users can view their own activities" ON public.ap_activities
    FOR SELECT USING (actor_id = auth.uid());

DROP POLICY IF EXISTS "Users can create their own activities" ON public.ap_activities;
CREATE POLICY "Users can create their own activities" ON public.ap_activities
    FOR INSERT WITH CHECK (actor_id = auth.uid());

DROP POLICY IF EXISTS "Users can update their own activities" ON public.ap_activities;
CREATE POLICY "Users can update their own activities" ON public.ap_activities
    FOR UPDATE USING (actor_id = auth.uid());

-- ---------------------------------------------------------------------------
-- AP ACTOR CACHE
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Service role can manage actor cache" ON public.ap_actor_cache;
CREATE POLICY "Service role can manage actor cache" ON public.ap_actor_cache
    USING (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- AP OBJECT CACHE
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Service role can manage object cache" ON public.ap_object_cache;
CREATE POLICY "Service role can manage object cache" ON public.ap_object_cache
    USING (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- ADMIN AUDIT LOG
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admin audit log admin access" ON public.admin_audit_log;
CREATE POLICY "Admin audit log admin access" ON public.admin_audit_log
    TO authenticated USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.is_admin = true)
    );

-- ---------------------------------------------------------------------------
-- BLOCKED INSTANCES
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Blocked instances admin access" ON public.blocked_instances;
CREATE POLICY "Blocked instances admin access" ON public.blocked_instances
    TO authenticated USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.is_admin = true)
    );

-- ---------------------------------------------------------------------------
-- BOTS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Public bots are viewable by everyone" ON public.bots;
CREATE POLICY "Public bots are viewable by everyone" ON public.bots
    FOR SELECT USING (
        is_public = true OR EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = bots.owner_id AND profiles.auth_user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Bot owners can manage bots" ON public.bots;
CREATE POLICY "Bot owners can manage bots" ON public.bots
    USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = bots.owner_id AND profiles.auth_user_id = auth.uid())
    )
    WITH CHECK (
        EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = bots.owner_id AND profiles.auth_user_id = auth.uid())
    );

-- ---------------------------------------------------------------------------
-- BOT TOKENS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Bot owners can manage tokens" ON public.bot_tokens;
CREATE POLICY "Bot owners can manage tokens" ON public.bot_tokens
    USING (
        EXISTS (
            SELECT 1 FROM public.bots
            JOIN public.profiles ON profiles.id = bots.owner_id
            WHERE bots.id = bot_tokens.bot_id AND profiles.auth_user_id = auth.uid()
        )
    );

-- ---------------------------------------------------------------------------
-- BOT SERVER PERMISSIONS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Server members can view bot permissions" ON public.bot_server_permissions;
CREATE POLICY "Server members can view bot permissions" ON public.bot_server_permissions
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.user_servers
            JOIN public.profiles ON profiles.id = user_servers.user_id
            WHERE user_servers.server_id = bot_server_permissions.server_id AND profiles.auth_user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Server owners can manage bot permissions" ON public.bot_server_permissions;
CREATE POLICY "Server owners can manage bot permissions" ON public.bot_server_permissions
    USING (
        EXISTS (
            SELECT 1 FROM public.servers
            JOIN public.profiles ON profiles.id = servers.owner
            WHERE servers.id = bot_server_permissions.server_id AND profiles.auth_user_id = auth.uid()
        )
    );

-- ---------------------------------------------------------------------------
-- EMOJI USAGE
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "emoji_usage_access_policy" ON public.emoji_usage;
CREATE POLICY "emoji_usage_access_policy" ON public.emoji_usage
    TO authenticated USING (
        server_id IN (SELECT user_servers.server_id FROM public.user_servers WHERE user_servers.user_id = auth.uid())
    );

-- ---------------------------------------------------------------------------
-- FEDERATION DELIVERY QUEUE
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Service role can manage delivery queue" ON public.federation_delivery_queue;
CREATE POLICY "Service role can manage delivery queue" ON public.federation_delivery_queue
    USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role can manage federation queue" ON public.federation_delivery_queue;
CREATE POLICY "Service role can manage federation queue" ON public.federation_delivery_queue
    TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Users can view federation delivery queue" ON public.federation_delivery_queue;
CREATE POLICY "Users can view federation delivery queue" ON public.federation_delivery_queue
    FOR SELECT TO authenticated USING (true);

-- ---------------------------------------------------------------------------
-- FEDERATED VOICE CALLS (schema varies: init vs production)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'federated_voice_calls' AND column_name = 'caller_id'
    ) THEN
        EXECUTE 'DROP POLICY IF EXISTS "System can insert calls" ON public.federated_voice_calls';
        EXECUTE 'CREATE POLICY "System can insert calls" ON public.federated_voice_calls FOR INSERT WITH CHECK (true)';

        EXECUTE 'DROP POLICY IF EXISTS "Recipients can update call status" ON public.federated_voice_calls';
        EXECUTE 'CREATE POLICY "Recipients can update call status" ON public.federated_voice_calls FOR UPDATE USING (auth.uid() = recipient_id) WITH CHECK (auth.uid() = recipient_id)';

        EXECUTE 'DROP POLICY IF EXISTS "Update own calls" ON public.federated_voice_calls';
        EXECUTE 'CREATE POLICY "Update own calls" ON public.federated_voice_calls FOR UPDATE USING (caller_id = auth.uid() OR recipient_id = auth.uid())';

        EXECUTE 'DROP POLICY IF EXISTS "Service role full access on calls" ON public.federated_voice_calls';
        EXECUTE 'CREATE POLICY "Service role full access on calls" ON public.federated_voice_calls TO service_role USING (true) WITH CHECK (true)';
    ELSE
        RAISE NOTICE 'federated_voice_calls: caller_id column not found, skipping user-level policies';
        EXECUTE 'DROP POLICY IF EXISTS "Service role full access on calls" ON public.federated_voice_calls';
        EXECUTE 'CREATE POLICY "Service role full access on calls" ON public.federated_voice_calls TO service_role USING (true) WITH CHECK (true)';
    END IF;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'federated_voice_calls table does not exist, skipping';
END $$;

-- ---------------------------------------------------------------------------
-- GIF FAVORITES
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own gif favorites" ON public.gif_favorites;
CREATE POLICY "Users can view own gif favorites" ON public.gif_favorites
    FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can insert own gif favorites" ON public.gif_favorites;
CREATE POLICY "Users can insert own gif favorites" ON public.gif_favorites
    FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can delete own gif favorites" ON public.gif_favorites;
CREATE POLICY "Users can delete own gif favorites" ON public.gif_favorites
    FOR DELETE USING (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- PERFORMANCE METRICS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can read metrics" ON public.performance_metrics;
CREATE POLICY "Admins can read metrics" ON public.performance_metrics
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE profiles.auth_user_id = auth.uid() AND profiles.is_admin = true)
    );

-- ---------------------------------------------------------------------------
-- PG BACKGROUND JOB (may not exist on all installations)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'pg_background_job') THEN
        EXECUTE 'DROP POLICY IF EXISTS "Service role manages all background jobs" ON public.pg_background_job';
        EXECUTE 'CREATE POLICY "Service role manages all background jobs" ON public.pg_background_job USING (auth.role() = ''service_role'')';
    ELSE
        RAISE NOTICE 'pg_background_job table does not exist, skipping';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- POST HASHTAGS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Anyone can view post hashtags" ON public.post_hashtags;
CREATE POLICY "Anyone can view post hashtags" ON public.post_hashtags
    FOR SELECT USING (true);

DROP POLICY IF EXISTS "Only system can modify post hashtags" ON public.post_hashtags;
CREATE POLICY "Only system can modify post hashtags" ON public.post_hashtags
    USING (false) WITH CHECK (false);

-- ---------------------------------------------------------------------------
-- PREKEYS (schema varies: init uses used_at, production uses is_used)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can insert their own prekeys" ON public.prekeys;
CREATE POLICY "Users can insert their own prekeys" ON public.prekeys
    FOR INSERT WITH CHECK (
        EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = prekeys.user_id AND profiles.auth_user_id = auth.uid())
    );

DROP POLICY IF EXISTS "Users can update their own prekeys" ON public.prekeys;
CREATE POLICY "Users can update their own prekeys" ON public.prekeys
    FOR UPDATE USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = prekeys.user_id AND profiles.auth_user_id = auth.uid())
    );

DROP POLICY IF EXISTS "Users can view others' unused public prekeys" ON public.prekeys;
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'prekeys' AND column_name = 'is_used'
    ) THEN
        EXECUTE 'CREATE POLICY "Users can view others'' unused public prekeys" ON public.prekeys FOR SELECT USING (is_used = false)';
    ELSE
        EXECUTE 'CREATE POLICY "Users can view others'' unused public prekeys" ON public.prekeys FOR SELECT USING (used_at IS NULL)';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PUSH SUBSCRIPTIONS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Service role can manage all push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Service role can manage all push subscriptions" ON public.push_subscriptions
    TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- SERVER FEDERATION EVENTS (init schema has no user_id column)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'server_federation_events' AND column_name = 'user_id'
    ) THEN
        EXECUTE 'DROP POLICY IF EXISTS "Users can create their own server events" ON public.server_federation_events';
        EXECUTE 'CREATE POLICY "Users can create their own server events" ON public.server_federation_events FOR INSERT WITH CHECK (user_id = auth.uid())';

        EXECUTE 'DROP POLICY IF EXISTS "Users can view server events they''re involved in" ON public.server_federation_events';
        EXECUTE 'CREATE POLICY "Users can view server events they''re involved in" ON public.server_federation_events FOR SELECT USING (user_id = auth.uid())';
    ELSE
        EXECUTE 'DROP POLICY IF EXISTS "Authenticated users can manage server events" ON public.server_federation_events';
        EXECUTE 'CREATE POLICY "Authenticated users can manage server events" ON public.server_federation_events TO authenticated USING (true) WITH CHECK (true)';
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
        server_id IN (SELECT us.server_id FROM public.user_servers us WHERE us.user_id = auth.uid())
    );

DROP POLICY IF EXISTS "System can insert membership events" ON public.server_membership_events;
CREATE POLICY "System can insert membership events" ON public.server_membership_events
    FOR INSERT TO authenticated WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- TIMELINE ENTRIES
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "System can manage all timeline entries" ON public.timeline_entries;
CREATE POLICY "System can manage all timeline entries" ON public.timeline_entries
    USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- UNREAD COUNTS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "System can manage unread counts" ON public.unread_counts;
CREATE POLICY "System can manage unread counts" ON public.unread_counts
    WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- USER KEY PAIRS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can insert their own key pairs" ON public.user_key_pairs;
CREATE POLICY "Users can insert their own key pairs" ON public.user_key_pairs
    FOR INSERT WITH CHECK (
        EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = user_key_pairs.user_id AND profiles.auth_user_id = auth.uid())
    );

DROP POLICY IF EXISTS "Users can update their own key pairs" ON public.user_key_pairs;
CREATE POLICY "Users can update their own key pairs" ON public.user_key_pairs
    FOR UPDATE USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = user_key_pairs.user_id AND profiles.auth_user_id = auth.uid())
    );

DROP POLICY IF EXISTS "Users can view others' public keys for encryption" ON public.user_key_pairs;
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'user_key_pairs' AND column_name = 'is_active'
    ) THEN
        EXECUTE 'CREATE POLICY "Users can view others'' public keys for encryption" ON public.user_key_pairs FOR SELECT USING (is_active = true)';
    ELSE
        EXECUTE 'CREATE POLICY "Users can view others'' public keys for encryption" ON public.user_key_pairs FOR SELECT USING (true)';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- USER SESSIONS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Service role can manage all sessions" ON public.user_sessions;
CREATE POLICY "Service role can manage all sessions" ON public.user_sessions
    TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Users can view own sessions" ON public.user_sessions;
CREATE POLICY "Users can view own sessions" ON public.user_sessions
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own sessions" ON public.user_sessions;
CREATE POLICY "Users can insert own sessions" ON public.user_sessions
    FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own sessions" ON public.user_sessions;
CREATE POLICY "Users can update own sessions" ON public.user_sessions
    FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own sessions" ON public.user_sessions;
CREATE POLICY "Users can delete own sessions" ON public.user_sessions
    FOR DELETE USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- USER TIMELINE CACHE
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can access own timeline cache" ON public.user_timeline_cache;
CREATE POLICY "Users can access own timeline cache" ON public.user_timeline_cache
    USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- VOICE FEDERATION EVENTS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can create their own voice events" ON public.voice_federation_events;
CREATE POLICY "Users can create their own voice events" ON public.voice_federation_events
    FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can view voice events they're involved in" ON public.voice_federation_events;
CREATE POLICY "Users can view voice events they're involved in" ON public.voice_federation_events
    FOR SELECT USING (user_id = auth.uid());

COMMIT;
