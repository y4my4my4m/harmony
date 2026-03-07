-- =============================================================================
-- FIX NOTIFICATIONS SCHEMA & RLS POLICIES
-- =============================================================================
-- Safe to run on both dev (har.mony.lol) and localhost.
-- All operations are idempotent (safe to run multiple times).
-- Compatible with Supabase SQL Editor (no psql-only commands).
--
-- Fixes:
--   1. notifications table: metadata→data, read→is_read, add is_clicked/updated_at/expires_at,
--      drop unused FK columns (actor_id, post_id, message_id, server_id)
--   2. conversation_participants: muted→is_muted, add created_at/updated_at
--   3. RLS policies: fix auth.uid() vs get_current_profile_id() mismatches
--   4. Functions: fix column references in notification functions
--   5. Ensure RLS is enabled on critical tables
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. NOTIFICATIONS TABLE SCHEMA
-- ---------------------------------------------------------------------------

-- Rename metadata → data (if metadata exists and data doesn't)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'metadata')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'data')
    THEN
        ALTER TABLE public.notifications RENAME COLUMN metadata TO data;
        RAISE NOTICE 'Renamed notifications.metadata → data';
    END IF;
END $$;

-- Rename read → is_read (if read exists and is_read doesn't)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'read')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'is_read')
    THEN
        ALTER TABLE public.notifications RENAME COLUMN read TO is_read;
        RAISE NOTICE 'Renamed notifications.read → is_read';
    END IF;
END $$;

-- Add is_clicked if missing
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'is_clicked')
    THEN
        ALTER TABLE public.notifications ADD COLUMN is_clicked boolean DEFAULT false;
        RAISE NOTICE 'Added notifications.is_clicked';
    END IF;
END $$;

-- Add updated_at if missing
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'updated_at')
    THEN
        ALTER TABLE public.notifications ADD COLUMN updated_at timestamp with time zone DEFAULT now();
        RAISE NOTICE 'Added notifications.updated_at';
    END IF;
END $$;

-- Add expires_at if missing
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'expires_at')
    THEN
        ALTER TABLE public.notifications ADD COLUMN expires_at timestamp with time zone DEFAULT (now() + '30 days'::interval);
        RAISE NOTICE 'Added notifications.expires_at';
    END IF;
END $$;

-- Add read_at if missing
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'read_at')
    THEN
        ALTER TABLE public.notifications ADD COLUMN read_at timestamp with time zone;
        RAISE NOTICE 'Added notifications.read_at';
    END IF;
END $$;

-- Drop unused FK columns (only if they exist — dev never had them)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'actor_id')
    THEN
        ALTER TABLE public.notifications DROP COLUMN actor_id;
        RAISE NOTICE 'Dropped notifications.actor_id';
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'post_id')
    THEN
        ALTER TABLE public.notifications DROP COLUMN post_id;
        RAISE NOTICE 'Dropped notifications.post_id';
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'message_id')
    THEN
        ALTER TABLE public.notifications DROP COLUMN message_id;
        RAISE NOTICE 'Dropped notifications.message_id';
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'server_id')
    THEN
        ALTER TABLE public.notifications DROP COLUMN server_id;
        RAISE NOTICE 'Dropped notifications.server_id';
    END IF;
END $$;

-- NOTE: Intentionally NOT changing notifications.type from text to varchar(50).
-- PostgreSQL treats them identically and the ALTER fails if triggers depend on the column.

-- Fix indexes to use is_read instead of read
DROP INDEX IF EXISTS idx_notifications_unread;
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON public.notifications(user_id, is_read) WHERE is_read = false;

COMMENT ON COLUMN public.notifications.is_read IS 'Boolean field indicating if notification has been read';
COMMENT ON COLUMN public.notifications.read_at IS 'Timestamp when notification was marked as read';


-- ---------------------------------------------------------------------------
-- 2. CONVERSATION_PARTICIPANTS TABLE
-- ---------------------------------------------------------------------------

-- Rename muted → is_muted
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'conversation_participants' AND column_name = 'muted')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'conversation_participants' AND column_name = 'is_muted')
    THEN
        ALTER TABLE public.conversation_participants RENAME COLUMN muted TO is_muted;
        RAISE NOTICE 'Renamed conversation_participants.muted → is_muted';
    END IF;
END $$;

-- Add created_at if missing
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'conversation_participants' AND column_name = 'created_at')
    THEN
        ALTER TABLE public.conversation_participants ADD COLUMN created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP;
        RAISE NOTICE 'Added conversation_participants.created_at';
    END IF;
END $$;

-- Add updated_at if missing
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'conversation_participants' AND column_name = 'updated_at')
    THEN
        ALTER TABLE public.conversation_participants ADD COLUMN updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP;
        RAISE NOTICE 'Added conversation_participants.updated_at';
    END IF;
END $$;

-- Add role check constraint if missing
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.constraint_column_usage
                   WHERE table_schema = 'public' AND table_name = 'conversation_participants'
                   AND constraint_name = 'conversation_participants_role_check')
    THEN
        BEGIN
            ALTER TABLE public.conversation_participants
                ADD CONSTRAINT conversation_participants_role_check
                CHECK (role = ANY (ARRAY['admin'::text, 'member'::text]));
            RAISE NOTICE 'Added conversation_participants_role_check constraint';
        EXCEPTION WHEN duplicate_object THEN
            NULL;
        END;
    END IF;
END $$;


-- ---------------------------------------------------------------------------
-- 3. RLS POLICY FIXES
-- ---------------------------------------------------------------------------

-- Fix conversation_participants UPDATE policy: auth.uid() → get_current_profile_id()
DROP POLICY IF EXISTS "conversation_participants_update_policy" ON public.conversation_participants;
CREATE POLICY "conversation_participants_update_policy" ON public.conversation_participants
    FOR UPDATE TO authenticated USING (user_id = public.get_current_profile_id());

-- Fix conversation_participants DELETE policy: auth.uid() → get_current_profile_id()
DROP POLICY IF EXISTS "conversation_participants_delete_policy" ON public.conversation_participants;
CREATE POLICY "conversation_participants_delete_policy" ON public.conversation_participants
    FOR DELETE TO authenticated USING (user_id = public.get_current_profile_id());

-- Fix user_servers leave policy: auth.uid() → get_current_profile_id()
DROP POLICY IF EXISTS "Users can leave servers" ON public.user_servers;
CREATE POLICY "Users can leave servers" ON public.user_servers
    FOR DELETE TO authenticated USING (
        user_id = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.servers
            WHERE servers.id = user_servers.server_id
            AND owner = public.get_current_profile_id()
        )
    );

-- Add user_blocks "check if blocked" SELECT policy (allows users to see if they've been blocked)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'user_blocks'
        AND policyname = 'user_blocks_check_if_blocked'
    ) THEN
        CREATE POLICY "user_blocks_check_if_blocked" ON public.user_blocks
            FOR SELECT USING (blocked_user_id = public.get_current_profile_id());
        RAISE NOTICE 'Added user_blocks_check_if_blocked policy';
    END IF;
END $$;

-- Fix notifications RLS to use get_current_profile_id() instead of auth.uid()
-- (only needed if the old auth.uid()-based policies exist)
DO $$
BEGIN
    -- Drop old dev-site policies that used auth.uid() or USING(true) for notifications
    DROP POLICY IF EXISTS "Enable users to view their own data only" ON public.notifications;
    DROP POLICY IF EXISTS "Enable insert for users based on user_id" ON public.notifications;

    -- Ensure correct policies exist
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'notifications' AND policyname = 'notifications_select_own') THEN
        CREATE POLICY "notifications_select_own" ON public.notifications
            FOR SELECT USING (user_id = public.get_current_profile_id());
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'notifications' AND policyname = 'notifications_insert_system') THEN
        CREATE POLICY "notifications_insert_system" ON public.notifications
            FOR INSERT WITH CHECK (true);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'notifications' AND policyname = 'notifications_update_own') THEN
        CREATE POLICY "notifications_update_own" ON public.notifications
            FOR UPDATE USING (user_id = public.get_current_profile_id());
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'notifications' AND policyname = 'notifications_delete_own') THEN
        CREATE POLICY "notifications_delete_own" ON public.notifications
            FOR DELETE USING (user_id = public.get_current_profile_id());
    END IF;
END $$;

-- Drop the overly-permissive "Anyone can view conversations" policy if it exists
DROP POLICY IF EXISTS "Anyone can view conversations" ON public.conversations;

-- Ensure restrictive conversations SELECT exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'conversations' AND policyname = 'conversations_select_participant') THEN
        CREATE POLICY "conversations_select_participant" ON public.conversations
            FOR SELECT USING (
                EXISTS (
                    SELECT 1 FROM public.conversation_participants
                    WHERE conversation_id = conversations.id
                    AND user_id = public.get_current_profile_id()
                )
            );
    END IF;
END $$;


-- ---------------------------------------------------------------------------
-- 4. FUNCTION FIXES
-- ---------------------------------------------------------------------------

-- Fix get_unread_notification_count to use is_read
CREATE OR REPLACE FUNCTION public.get_unread_notification_count(p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
    SELECT COUNT(*)::INTEGER
    FROM notifications
    WHERE user_id = p_user_id AND is_read = false;
$$;

-- Fix cleanup_old_notifications to use is_read
CREATE OR REPLACE FUNCTION public.cleanup_old_notifications()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    deleted_count integer;
BEGIN
    DELETE FROM notifications
    WHERE created_at < NOW() - INTERVAL '90 days'
      AND is_read = true;

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

-- Fix create_notification_structured: use data column + restore auth checks
CREATE OR REPLACE FUNCTION public.create_notification_structured(
    p_user_id uuid,
    p_type varchar,
    p_data jsonb DEFAULT '{}'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    notification_id UUID;
    v_caller_profile_id uuid;
BEGIN
    SELECT id INTO v_caller_profile_id FROM profiles WHERE auth_user_id = auth.uid();

    IF v_caller_profile_id IS NOT NULL THEN
        IF v_caller_profile_id != p_user_id AND NOT EXISTS (
            SELECT 1 FROM profiles WHERE id = v_caller_profile_id AND is_admin = true
        ) THEN
            RAISE EXCEPTION 'Unauthorized: Cannot create notifications for other users';
        END IF;
    END IF;

    INSERT INTO notifications (user_id, type, data, created_at, is_read)
    VALUES (p_user_id, p_type, p_data, NOW(), false)
    RETURNING id INTO notification_id;

    RETURN notification_id;
END;
$$;

COMMENT ON FUNCTION public.create_notification_structured IS 'Create notification with structured data.
SECURITY: Caller must be target user, admin, or service_role.';

-- Drop old 6-arg signature (localhost still has it; dev already has the 9-arg version)
DROP FUNCTION IF EXISTS public.create_notification_with_spam_prevention(uuid, text, uuid, uuid, uuid, uuid);

-- Fix create_notification_with_spam_prevention: restore caller identity check
CREATE OR REPLACE FUNCTION public.create_notification_with_spam_prevention(
    p_user_id uuid,
    p_type text,
    p_source_user_id uuid,
    p_title text DEFAULT NULL,
    p_message text DEFAULT NULL,
    p_data jsonb DEFAULT '{}'::jsonb,
    p_server_id uuid DEFAULT NULL,
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_notification_id uuid;
    v_caller_profile_id uuid;
    v_rate_limit RECORD;
    v_should_suppress boolean := false;
    v_time_threshold timestamp with time zone := NOW() - INTERVAL '2 minutes';
BEGIN
    SELECT id INTO v_caller_profile_id FROM profiles WHERE auth_user_id = auth.uid();

    IF v_caller_profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required';
    END IF;

    IF p_source_user_id != v_caller_profile_id THEN
        RAISE EXCEPTION 'Unauthorized: Cannot create notifications from another user';
    END IF;

    IF p_type = 'reaction' AND p_source_user_id IS NOT NULL THEN
        INSERT INTO notification_rate_limits (user_id, notification_type, source_user_id)
        VALUES (p_user_id, p_type, p_source_user_id)
        ON CONFLICT (user_id, notification_type, source_user_id)
        DO UPDATE SET
            notification_count = notification_rate_limits.notification_count + 1,
            last_notification_at = NOW()
        RETURNING * INTO v_rate_limit;

        SELECT
            (notification_count > 3) OR
            (notification_count > 1 AND last_notification_at > v_time_threshold) OR
            (suppressed_until IS NOT NULL AND suppressed_until > NOW())
        INTO v_should_suppress
        FROM notification_rate_limits
        WHERE user_id = p_user_id AND notification_type = p_type AND source_user_id = p_source_user_id;

        IF v_should_suppress THEN
            UPDATE notification_rate_limits
            SET suppressed_until = NOW() + INTERVAL '2 minutes'
            WHERE user_id = p_user_id AND notification_type = p_type AND source_user_id = p_source_user_id;
            RETURN NULL;
        END IF;
    END IF;

    SELECT send_notification_to_user(
        p_type,
        p_user_id,
        p_data,
        p_server_id,
        p_channel_id,
        p_conversation_id,
        p_source_user_id,
        'normal'
    ) INTO v_notification_id;

    RETURN v_notification_id;
END;
$$;

COMMENT ON FUNCTION public.create_notification_with_spam_prevention IS
'Creates notifications with spam prevention. SECURITY: p_source_user_id must match the authenticated caller.';

-- Fix get_conversation_participants to use is_muted
CREATE OR REPLACE FUNCTION public.get_conversation_participants(conversation_uuid uuid)
RETURNS TABLE(user_id uuid, role text, joined_at timestamp with time zone, is_muted boolean, last_read_at timestamp with time zone)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        cp.user_id,
        cp.role,
        cp.joined_at,
        cp.is_muted,
        cp.last_read_at
    FROM conversation_participants cp
    WHERE cp.conversation_id = conversation_uuid
      AND cp.left_at IS NULL;
END;
$$;

-- Fix is_user_viewing_context (create if missing)
CREATE OR REPLACE FUNCTION public.is_user_viewing_context(
    p_user_id uuid,
    p_server_id uuid DEFAULT NULL,
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_view_context RECORD;
BEGIN
    SELECT * INTO v_view_context
    FROM public.user_view_contexts
    WHERE user_id = p_user_id;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    IF p_server_id IS NOT NULL AND p_channel_id IS NOT NULL THEN
        IF v_view_context.view_type = 'server_channel' AND
           v_view_context.server_id = p_server_id AND
           v_view_context.channel_id = p_channel_id THEN
            RETURN TRUE;
        END IF;
    END IF;

    IF p_conversation_id IS NOT NULL THEN
        IF v_view_context.view_type = 'dm' AND
           v_view_context.conversation_id = p_conversation_id THEN
            RETURN TRUE;
        END IF;
    END IF;

    RETURN FALSE;
END;
$$;

COMMENT ON FUNCTION public.is_user_viewing_context(uuid, uuid, uuid, uuid)
IS 'Checks if user is viewing a specific channel/DM. Used by send_notification to suppress notifications at database level.';

-- Fix sync_view_context_from_presence (resolves auth.uid() → profiles.id)
CREATE OR REPLACE FUNCTION public.sync_view_context_from_presence(
    p_view_type text,
    p_server_id uuid DEFAULT NULL,
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_auth_id UUID := auth.uid();
    v_profile_id UUID;
BEGIN
    IF v_auth_id IS NULL THEN
        RETURN;
    END IF;

    SELECT id INTO v_profile_id
    FROM public.profiles
    WHERE auth_user_id = v_auth_id
    LIMIT 1;

    IF v_profile_id IS NULL THEN
        RETURN;
    END IF;

    INSERT INTO public.user_view_contexts (user_id, view_type, server_id, channel_id, conversation_id, last_active_at)
    VALUES (v_profile_id, p_view_type, p_server_id, p_channel_id, p_conversation_id, NOW())
    ON CONFLICT (user_id) DO UPDATE
    SET
        view_type = EXCLUDED.view_type,
        server_id = EXCLUDED.server_id,
        channel_id = EXCLUDED.channel_id,
        conversation_id = EXCLUDED.conversation_id,
        last_active_at = EXCLUDED.last_active_at;
END;
$$;

COMMENT ON FUNCTION public.sync_view_context_from_presence(text, uuid, uuid, uuid)
IS 'Syncs ephemeral presence state to database table. Resolves auth.uid() to profiles.id before writing.';

GRANT EXECUTE ON FUNCTION public.sync_view_context_from_presence(text, uuid, uuid, uuid) TO authenticated;


-- ---------------------------------------------------------------------------
-- 5. ENSURE RLS IS ENABLED ON CRITICAL TABLES
-- ---------------------------------------------------------------------------

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_view_contexts ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- NOTE: send_notification with rate limiting
-- ---------------------------------------------------------------------------
-- The send_notification function (with built-in reaction spam rate limiting)
-- is too large to duplicate here. Apply it by running the function definition
-- from db_schema/init/13_functions_rpc_extended.sql (the send_notification block).
-- You already did this manually — this note is just for documentation.
-- ---------------------------------------------------------------------------
