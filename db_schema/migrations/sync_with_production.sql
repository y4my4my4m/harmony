-- =============================================================================
-- SYNC WITH PRODUCTION - Comprehensive migration to align init schema with production
-- =============================================================================
-- Run this AFTER fix_missing_columns.sql
-- This fixes:
-- 1. server_encryption_settings table structure
-- 2. get_batch_message_reactions function
-- 3. Missing RLS policies for all tables
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. FIX server_encryption_settings TABLE
-- ---------------------------------------------------------------------------
-- The init schema has a different structure than production
-- We need to recreate it with the correct columns

-- Drop existing table and recreate with correct structure
DROP TABLE IF EXISTS public.server_encryption_settings CASCADE;

CREATE TABLE public.server_encryption_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    server_id uuid NOT NULL UNIQUE REFERENCES public.servers(id) ON DELETE CASCADE,
    encryption_mode text DEFAULT 'optional'::text,
    allow_federation boolean DEFAULT true,
    require_verified_devices boolean DEFAULT false,
    force_key_setup boolean DEFAULT false NOT NULL,
    encrypt_attachments boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT server_encryption_settings_encryption_mode_check 
        CHECK (encryption_mode = ANY (ARRAY['disabled'::text, 'optional'::text, 'required'::text, 'required_local_only'::text]))
);

COMMENT ON TABLE public.server_encryption_settings IS 'Per-server E2EE enforcement policies. Server owners control encryption requirements.';
COMMENT ON COLUMN public.server_encryption_settings.encryption_mode IS 'disabled: No E2EE. optional: User choice. required: All messages encrypted. required_local_only: E2EE required, federation disabled.';

-- ---------------------------------------------------------------------------
-- 2. FIX get_batch_message_reactions FUNCTION
-- ---------------------------------------------------------------------------
-- The init schema has type mismatches

DROP FUNCTION IF EXISTS public.get_batch_message_reactions(uuid[]);

CREATE FUNCTION public.get_batch_message_reactions(message_ids uuid[]) 
RETURNS TABLE(
    message_id uuid, 
    emoji_id uuid, 
    emoji_name character varying, 
    emoji_url character varying, 
    custom_emoji_content text, 
    reaction_count bigint, 
    users jsonb
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        r.message_id,
        r.emoji_id,
        COALESCE(e.name, r.custom_emoji_content)::varchar as emoji_name,
        e.url::varchar as emoji_url,
        r.custom_emoji_content,
        COUNT(r.id)::bigint as reaction_count,
        jsonb_agg(
            jsonb_build_object(
                'user_id', r.user_id,
                'bot_id', r.bot_id,
                'metadata', r.metadata
            )
        ) as users
    FROM reactions r
    LEFT JOIN emojis e ON r.emoji_id = e.id
    WHERE r.message_id = ANY(get_batch_message_reactions.message_ids)
    GROUP BY r.message_id, r.emoji_id, e.name, e.url, r.custom_emoji_content
    ORDER BY r.message_id, reaction_count DESC;
END;
$$;

COMMENT ON FUNCTION public.get_batch_message_reactions(message_ids uuid[]) IS 'Batch fetch reactions for multiple messages including metadata for bridged users';

-- ---------------------------------------------------------------------------
-- 3. ENABLE RLS ON ALL TABLES
-- ---------------------------------------------------------------------------

-- Core tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_participants ENABLE ROW LEVEL SECURITY;

-- Social tables
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY;

-- Server-related tables
ALTER TABLE public.channel_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.emojis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.thread_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_channel_participants ENABLE ROW LEVEL SECURITY;

-- Encryption tables
ALTER TABLE public.server_encryption_settings ENABLE ROW LEVEL SECURITY;

-- Misc tables (if they exist)
DO $$ BEGIN
    ALTER TABLE public.server_folders ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE public.hashtags ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE public.instance_config ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE public.emoji_usage ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE public.gif_favorites ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE public.user_lists ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE public.user_list_members ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- Bot tables
DO $$ BEGIN
    ALTER TABLE public.bots ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE public.bot_server_permissions ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- Federation tables
DO $$ BEGIN
    ALTER TABLE public.ap_activities ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE public.federated_instances ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 4. CREATE SIMPLE RLS POLICIES (matching production)
-- ---------------------------------------------------------------------------
-- Production uses mostly permissive policies for development convenience
-- These can be tightened for production deployments

-- ===== PROFILES =====
DROP POLICY IF EXISTS "profiles_select_all" ON public.profiles;
DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "Enable read access for all users" ON public.profiles FOR SELECT USING (true);
CREATE POLICY "Users can insert their own profile" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth_user_id = auth.uid());
CREATE POLICY "Users can update their own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth_user_id = auth.uid());

-- ===== SERVERS =====
-- (Already handled in fix_missing_columns.sql)

-- ===== CHANNELS =====
DROP POLICY IF EXISTS "channels_select_member" ON public.channels;
DROP POLICY IF EXISTS "channels_insert_owner" ON public.channels;
DROP POLICY IF EXISTS "channels_update_owner" ON public.channels;
DROP POLICY IF EXISTS "channels_delete_owner" ON public.channels;
CREATE POLICY "Enable read access for all users" ON public.channels FOR SELECT USING (true);
CREATE POLICY "Authenticated users can create channels" ON public.channels FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Channel owners can update" ON public.channels FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Channel owners can delete" ON public.channels FOR DELETE TO authenticated USING (true);

-- ===== MESSAGES =====
DROP POLICY IF EXISTS "messages_select_member" ON public.messages;
DROP POLICY IF EXISTS "messages_insert_author" ON public.messages;
DROP POLICY IF EXISTS "messages_update_author" ON public.messages;
DROP POLICY IF EXISTS "messages_delete_author" ON public.messages;
CREATE POLICY "Enable read access for all users" ON public.messages FOR SELECT USING (true);
CREATE POLICY "Authenticated users can insert messages" ON public.messages FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Message authors can update" ON public.messages FOR UPDATE TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Message authors can delete" ON public.messages FOR DELETE TO authenticated USING (user_id = auth.uid());

-- ===== USER_SERVERS =====
-- (Already handled in fix_missing_columns.sql)

-- ===== CONVERSATIONS =====
DROP POLICY IF EXISTS "conversations_select_participant" ON public.conversations;
DROP POLICY IF EXISTS "conversations_insert_authenticated" ON public.conversations;
CREATE POLICY "Anyone can view conversations" ON public.conversations FOR SELECT USING (true);
CREATE POLICY "Authenticated users can create conversations" ON public.conversations FOR INSERT TO authenticated WITH CHECK (true);

-- ===== CONVERSATION_PARTICIPANTS =====
-- (Already handled in fix_missing_columns.sql)

-- ===== POSTS =====
DROP POLICY IF EXISTS "posts_select_public" ON public.posts;
DROP POLICY IF EXISTS "posts_insert_author" ON public.posts;
DROP POLICY IF EXISTS "posts_update_author" ON public.posts;
DROP POLICY IF EXISTS "posts_delete_author" ON public.posts;
CREATE POLICY "Enable read access for all users" ON public.posts FOR SELECT USING (true);
CREATE POLICY "Authenticated users can create posts" ON public.posts FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Post authors can update" ON public.posts FOR UPDATE TO authenticated USING (author_id = auth.uid());
CREATE POLICY "Post authors can delete" ON public.posts FOR DELETE TO authenticated USING (author_id = auth.uid());

-- ===== FOLLOWS =====
DROP POLICY IF EXISTS "follows_select_all" ON public.follows;
DROP POLICY IF EXISTS "follows_insert_follower" ON public.follows;
DROP POLICY IF EXISTS "follows_delete_follower" ON public.follows;
CREATE POLICY "Enable read access for all users" ON public.follows FOR SELECT USING (true);
CREATE POLICY "Authenticated users can follow" ON public.follows FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Users can unfollow" ON public.follows FOR DELETE TO authenticated USING (follower_id = auth.uid());

-- ===== POST_INTERACTIONS =====
DROP POLICY IF EXISTS "post_interactions_select_all" ON public.post_interactions;
DROP POLICY IF EXISTS "post_interactions_insert_own" ON public.post_interactions;
DROP POLICY IF EXISTS "post_interactions_update_own" ON public.post_interactions;
DROP POLICY IF EXISTS "post_interactions_delete_own" ON public.post_interactions;
CREATE POLICY "Enable read access for all users" ON public.post_interactions FOR SELECT USING (true);
CREATE POLICY "Authenticated users can interact" ON public.post_interactions FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Users can update own interactions" ON public.post_interactions FOR UPDATE TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users can delete own interactions" ON public.post_interactions FOR DELETE TO authenticated USING (user_id = auth.uid());

-- ===== NOTIFICATIONS =====
DROP POLICY IF EXISTS "notifications_select_own" ON public.notifications;
DROP POLICY IF EXISTS "notifications_insert_system" ON public.notifications;
DROP POLICY IF EXISTS "notifications_update_own" ON public.notifications;
DROP POLICY IF EXISTS "notifications_delete_own" ON public.notifications;
CREATE POLICY "Users can view own notifications" ON public.notifications FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "System can create notifications" ON public.notifications FOR INSERT WITH CHECK (true);
CREATE POLICY "Users can update own notifications" ON public.notifications FOR UPDATE TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users can delete own notifications" ON public.notifications FOR DELETE TO authenticated USING (user_id = auth.uid());

-- ===== USER_BLOCKS =====
DO $$ BEGIN
    DROP POLICY IF EXISTS "user_blocks_select_own" ON public.user_blocks;
    DROP POLICY IF EXISTS "user_blocks_insert_own" ON public.user_blocks;
    DROP POLICY IF EXISTS "user_blocks_delete_own" ON public.user_blocks;
    CREATE POLICY "Users can view own blocks" ON public.user_blocks FOR SELECT TO authenticated USING (blocker_id = auth.uid());
    CREATE POLICY "Users can block" ON public.user_blocks FOR INSERT TO authenticated WITH CHECK (blocker_id = auth.uid());
    CREATE POLICY "Users can unblock" ON public.user_blocks FOR DELETE TO authenticated USING (blocker_id = auth.uid());
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- ===== CHANNEL_CATEGORIES =====
DO $$ BEGIN
    CREATE POLICY "Enable read access for all users" ON public.channel_categories FOR SELECT USING (true);
    CREATE POLICY "Authenticated users can manage categories" ON public.channel_categories FOR ALL TO authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ===== SERVER_ROLES =====
DO $$ BEGIN
    CREATE POLICY "Enable read access for all users" ON public.server_roles FOR SELECT USING (true);
    CREATE POLICY "Authenticated users can manage roles" ON public.server_roles FOR ALL TO authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ===== USER_ROLES =====
DO $$ BEGIN
    CREATE POLICY "Enable read access for all users" ON public.user_roles FOR SELECT USING (true);
    CREATE POLICY "Authenticated users can manage user roles" ON public.user_roles FOR ALL TO authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ===== INVITES =====
DO $$ BEGIN
    CREATE POLICY "Enable read access for all users" ON public.invites FOR SELECT USING (true);
    CREATE POLICY "Authenticated users can create invites" ON public.invites FOR INSERT TO authenticated WITH CHECK (true);
    CREATE POLICY "Invite creators can delete" ON public.invites FOR DELETE TO authenticated USING (created_by = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ===== EMOJIS =====
-- Fix emojis table structure first (init uses created_by, production uses uploader)
ALTER TABLE public.emojis ADD COLUMN IF NOT EXISTS uploader uuid;
ALTER TABLE public.emojis ADD COLUMN IF NOT EXISTS usage_count integer DEFAULT 0;
ALTER TABLE public.emojis ADD COLUMN IF NOT EXISTS last_used timestamp with time zone;
ALTER TABLE public.emojis ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();

-- Copy data from created_by to uploader if created_by exists
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_name = 'emojis' AND column_name = 'created_by') THEN
        UPDATE public.emojis SET uploader = created_by WHERE uploader IS NULL AND created_by IS NOT NULL;
    END IF;
END $$;

DO $$ BEGIN
    CREATE POLICY "Enable read access for all users" ON public.emojis FOR SELECT USING (true);
    CREATE POLICY "Authenticated users can upload emojis" ON public.emojis FOR INSERT TO authenticated WITH CHECK (true);
    CREATE POLICY "Authenticated users can update emojis" ON public.emojis FOR UPDATE TO authenticated USING (true);
    CREATE POLICY "Authenticated users can delete emojis" ON public.emojis FOR DELETE TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ===== REACTIONS =====
DO $$ BEGIN
    CREATE POLICY "Enable read access for all users" ON public.reactions FOR SELECT USING (true);
    CREATE POLICY "Authenticated users can react" ON public.reactions FOR INSERT TO authenticated WITH CHECK (true);
    CREATE POLICY "Users can remove own reactions" ON public.reactions FOR DELETE TO authenticated USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ===== THREADS =====
DO $$ BEGIN
    CREATE POLICY "Enable read access for all users" ON public.threads FOR SELECT USING (true);
    CREATE POLICY "Authenticated users can create threads" ON public.threads FOR INSERT TO authenticated WITH CHECK (true);
    CREATE POLICY "Thread creators can update" ON public.threads FOR UPDATE TO authenticated USING (created_by = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ===== THREAD_MEMBERS =====
DO $$ BEGIN
    CREATE POLICY "Enable read access for all users" ON public.thread_members FOR SELECT USING (true);
    CREATE POLICY "Users can join threads" ON public.thread_members FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
    CREATE POLICY "Users can leave threads" ON public.thread_members FOR DELETE TO authenticated USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ===== VOICE_CHANNEL_PARTICIPANTS =====
DO $$ BEGIN
    CREATE POLICY "Enable read access for all users" ON public.voice_channel_participants FOR SELECT USING (true);
    CREATE POLICY "Users can join voice" ON public.voice_channel_participants FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
    CREATE POLICY "Users can update own participation" ON public.voice_channel_participants FOR UPDATE TO authenticated USING (user_id = auth.uid());
    CREATE POLICY "Users can leave voice" ON public.voice_channel_participants FOR DELETE TO authenticated USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ===== SERVER_ENCRYPTION_SETTINGS =====
CREATE POLICY "Enable read access for all users" ON public.server_encryption_settings FOR SELECT USING (true);
CREATE POLICY "Server owners can manage encryption" ON public.server_encryption_settings FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ===== SERVER_FOLDERS =====
DO $$ BEGIN
    CREATE POLICY "Users can view own folders" ON public.server_folders FOR SELECT TO authenticated USING (user_id = auth.uid());
    CREATE POLICY "Users can create folders" ON public.server_folders FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
    CREATE POLICY "Users can update own folders" ON public.server_folders FOR UPDATE TO authenticated USING (user_id = auth.uid());
    CREATE POLICY "Users can delete own folders" ON public.server_folders FOR DELETE TO authenticated USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
WHEN undefined_table THEN NULL;
END $$;

-- ===== HASHTAGS =====
DO $$ BEGIN
    CREATE POLICY "Enable read access for all users" ON public.hashtags FOR SELECT USING (true);
    CREATE POLICY "System can manage hashtags" ON public.hashtags FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
WHEN undefined_table THEN NULL;
END $$;

-- ===== INSTANCE_CONFIG =====
DO $$ BEGIN
    CREATE POLICY "Enable read access for all users" ON public.instance_config FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
WHEN undefined_table THEN NULL;
END $$;

-- ===== EMOJI_USAGE =====
DO $$ BEGIN
    CREATE POLICY "Enable read access for all users" ON public.emoji_usage FOR SELECT USING (true);
    CREATE POLICY "System can track usage" ON public.emoji_usage FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
WHEN undefined_table THEN NULL;
END $$;

-- ===== GIF_FAVORITES =====
DO $$ BEGIN
    CREATE POLICY "Users can view own favorites" ON public.gif_favorites FOR SELECT TO authenticated USING (user_id = auth.uid());
    CREATE POLICY "Users can add favorites" ON public.gif_favorites FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
    CREATE POLICY "Users can remove favorites" ON public.gif_favorites FOR DELETE TO authenticated USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
WHEN undefined_table THEN NULL;
END $$;

-- ===== USER_LISTS =====
DO $$ BEGIN
    CREATE POLICY "Enable read access for all users" ON public.user_lists FOR SELECT USING (true);
    CREATE POLICY "Users can create lists" ON public.user_lists FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
    CREATE POLICY "Users can update own lists" ON public.user_lists FOR UPDATE TO authenticated USING (user_id = auth.uid());
    CREATE POLICY "Users can delete own lists" ON public.user_lists FOR DELETE TO authenticated USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
WHEN undefined_table THEN NULL;
END $$;

-- ===== USER_LIST_MEMBERS =====
DO $$ BEGIN
    CREATE POLICY "Enable read access for all users" ON public.user_list_members FOR SELECT USING (true);
    CREATE POLICY "List owners can add members" ON public.user_list_members FOR INSERT TO authenticated WITH CHECK (true);
    CREATE POLICY "List owners can remove members" ON public.user_list_members FOR DELETE TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
WHEN undefined_table THEN NULL;
END $$;

-- ===== BOTS =====
DO $$ BEGIN
    CREATE POLICY "Enable read access for public bots" ON public.bots FOR SELECT USING (is_public = true OR owner_id = auth.uid());
    CREATE POLICY "Owners can create bots" ON public.bots FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
    CREATE POLICY "Owners can update bots" ON public.bots FOR UPDATE TO authenticated USING (owner_id = auth.uid());
    CREATE POLICY "Owners can delete bots" ON public.bots FOR DELETE TO authenticated USING (owner_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
WHEN undefined_table THEN NULL;
END $$;

-- ===== BOT_SERVER_PERMISSIONS =====
DO $$ BEGIN
    CREATE POLICY "Enable read access for all users" ON public.bot_server_permissions FOR SELECT USING (true);
    CREATE POLICY "Server owners can manage bot permissions" ON public.bot_server_permissions FOR ALL TO authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
WHEN undefined_table THEN NULL;
END $$;

-- ===== AP_ACTIVITIES =====
DO $$ BEGIN
    CREATE POLICY "Enable read access for all users" ON public.ap_activities FOR SELECT USING (true);
    CREATE POLICY "System can manage activities" ON public.ap_activities FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
WHEN undefined_table THEN NULL;
END $$;

-- ===== FEDERATED_INSTANCES =====
DO $$ BEGIN
    CREATE POLICY "Enable read access for all users" ON public.federated_instances FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
WHEN undefined_table THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 5. ADD MISSING bot_id COLUMN TO REACTIONS (if needed)
-- ---------------------------------------------------------------------------
ALTER TABLE public.reactions ADD COLUMN IF NOT EXISTS bot_id uuid;
ALTER TABLE public.reactions ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- 6. FIX unread_counts TABLE (init has different structure than production)
-- ---------------------------------------------------------------------------
-- Production tracks per-channel unread counts, init has simple global counts
-- Add missing columns for per-channel tracking

ALTER TABLE public.unread_counts ADD COLUMN IF NOT EXISTS server_id uuid;
ALTER TABLE public.unread_counts ADD COLUMN IF NOT EXISTS channel_id uuid;
ALTER TABLE public.unread_counts ADD COLUMN IF NOT EXISTS conversation_id uuid;
ALTER TABLE public.unread_counts ADD COLUMN IF NOT EXISTS unread_messages integer DEFAULT 0;
ALTER TABLE public.unread_counts ADD COLUMN IF NOT EXISTS unread_mentions integer DEFAULT 0;
ALTER TABLE public.unread_counts ADD COLUMN IF NOT EXISTS last_read_message_id uuid;
ALTER TABLE public.unread_counts ADD COLUMN IF NOT EXISTS last_read_at timestamp with time zone DEFAULT now();
ALTER TABLE public.unread_counts ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now();

-- Drop the unique constraint on user_id if it exists (production allows multiple rows per user)
DO $$ BEGIN
    ALTER TABLE public.unread_counts DROP CONSTRAINT IF EXISTS unread_counts_user_id_key;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

-- Create appropriate indexes
CREATE INDEX IF NOT EXISTS idx_unread_counts_user ON public.unread_counts(user_id);
CREATE INDEX IF NOT EXISTS idx_unread_counts_channel ON public.unread_counts(channel_id);
CREATE INDEX IF NOT EXISTS idx_unread_counts_conversation ON public.unread_counts(conversation_id);

-- Add FK constraints if they don't exist
DO $$ BEGIN
    ALTER TABLE public.unread_counts 
        ADD CONSTRAINT unread_counts_server_id_fkey 
        FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE public.unread_counts 
        ADD CONSTRAINT unread_counts_channel_id_fkey 
        FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 7. ADD MISSING get_message_reactions FUNCTION (singular, not batch)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_message_reactions(uuid);

CREATE FUNCTION public.get_message_reactions(message_id uuid) 
RETURNS TABLE(count bigint, emoji jsonb, reactions jsonb, message_id_of_reactions uuid)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(r.id)::bigint as count,
        CASE 
            WHEN r.emoji_id IS NOT NULL THEN
                -- Custom server emoji - use emoji table data
                jsonb_build_object(
                    'id', e.id,
                    'name', e.name,
                    'url', e.url,
                    'is_native', false
                )
            ELSE
                -- Native unicode emoji - use custom_emoji_content
                jsonb_build_object(
                    'id', r.custom_emoji_content,
                    'name', r.custom_emoji_content,
                    'url', NULL,
                    'content', r.custom_emoji_content,
                    'is_native', true
                )
        END as emoji,
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'user_id', r2.user_id,
                    'bot_id', r2.bot_id,
                    'metadata', r2.metadata,
                    'username', p.username,
                    'display_name', p.display_name,
                    'avatar_url', p.avatar_url
                )
            )
            FROM reactions r2
            LEFT JOIN profiles p ON r2.user_id = p.id
            WHERE r2.message_id = get_message_reactions.message_id
            AND (
                (r2.emoji_id IS NOT DISTINCT FROM r.emoji_id)
                AND (r2.custom_emoji_content IS NOT DISTINCT FROM r.custom_emoji_content)
            )
        ) as reactions,
        r.message_id as message_id_of_reactions
    FROM reactions r
    LEFT JOIN emojis e ON r.emoji_id = e.id
    WHERE r.message_id = get_message_reactions.message_id
    GROUP BY r.message_id, r.emoji_id, e.id, e.name, e.url, r.custom_emoji_content
    ORDER BY count DESC;
END;
$$;

COMMENT ON FUNCTION public.get_message_reactions(message_id uuid) IS 'Returns reaction groups for a message including metadata for bridged users (Discord, etc.)';

-- ---------------------------------------------------------------------------
-- VERIFICATION
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    -- Check server_encryption_settings has correct columns
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'server_encryption_settings' 
        AND column_name = 'encryption_mode'
    ) THEN
        RAISE NOTICE '✅ server_encryption_settings.encryption_mode exists';
    ELSE
        RAISE WARNING '❌ server_encryption_settings.encryption_mode missing';
    END IF;
    
    -- Check function exists
    IF EXISTS (
        SELECT 1 FROM pg_proc 
        WHERE proname = 'get_batch_message_reactions'
    ) THEN
        RAISE NOTICE '✅ get_batch_message_reactions function exists';
    ELSE
        RAISE WARNING '❌ get_batch_message_reactions function missing';
    END IF;
    
    RAISE NOTICE '✅ Sync with production completed!';
END $$;


-- =============================================================================
-- FIX voice_channel_participants table - Add missing columns
-- =============================================================================
ALTER TABLE public.voice_channel_participants 
    ADD COLUMN IF NOT EXISTS server_id uuid REFERENCES public.servers(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS is_federated boolean DEFAULT false NOT NULL,
    ADD COLUMN IF NOT EXISTS federation_status text DEFAULT 'local'::text,
    ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

-- Drop old columns that are not in production
ALTER TABLE public.voice_channel_participants 
    DROP COLUMN IF EXISTS peer_id,
    DROP COLUMN IF EXISTS connection_quality;

