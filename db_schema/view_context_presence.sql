-- Ephemeral view context tracking for notification suppression
-- 
-- View context is tracked in Supabase Realtime presence (ephemeral) AND synced to a lightweight
-- database table so PostgreSQL functions can check it before creating notifications.
-- 
-- This provides database-level notification suppression (Discord-like behavior) while keeping
-- the primary source of truth ephemeral. The database table is just a cache/sync of presence state.

-- Lightweight table to sync ephemeral presence state for database access
-- This is updated via RPC when presence changes, allowing PostgreSQL to check view context
CREATE TABLE IF NOT EXISTS public.user_view_contexts (
    user_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    server_id UUID REFERENCES public.servers(id) ON DELETE SET NULL,
    channel_id UUID REFERENCES public.channels(id) ON DELETE SET NULL,
    conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
    view_type TEXT NOT NULL DEFAULT 'home',
    last_active_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE public.user_view_contexts IS 'Lightweight cache of ephemeral presence state for database-level notification suppression. Updated via RPC when presence changes.';

-- RLS for user_view_contexts
ALTER TABLE public.user_view_contexts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own view context" ON public.user_view_contexts
FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own view context" ON public.user_view_contexts
FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own view context" ON public.user_view_contexts
FOR UPDATE USING (auth.uid() = user_id);

-- Function to sync ephemeral presence state to database (called from frontend)
CREATE OR REPLACE FUNCTION public.sync_view_context_from_presence(
    p_view_type TEXT,
    p_server_id UUID DEFAULT NULL,
    p_channel_id UUID DEFAULT NULL,
    p_conversation_id UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID := auth.uid();
BEGIN
    IF v_user_id IS NULL THEN
        RETURN;
    END IF;

    -- Upsert view context (sync from ephemeral presence to database)
    INSERT INTO public.user_view_contexts (user_id, view_type, server_id, channel_id, conversation_id, last_active_at)
    VALUES (v_user_id, p_view_type, p_server_id, p_channel_id, p_conversation_id, NOW())
    ON CONFLICT (user_id) DO UPDATE
    SET
        view_type = EXCLUDED.view_type,
        server_id = EXCLUDED.server_id,
        channel_id = EXCLUDED.channel_id,
        conversation_id = EXCLUDED.conversation_id,
        last_active_at = EXCLUDED.last_active_at;
END;
$$;

COMMENT ON FUNCTION public.sync_view_context_from_presence IS 'Syncs ephemeral presence state to database table for PostgreSQL function access. Called from frontend when view context changes.';

-- Function to check if user is viewing a specific context (used by send_notification)
CREATE OR REPLACE FUNCTION public.is_user_viewing_context(
    p_user_id UUID,
    p_server_id UUID DEFAULT NULL,
    p_channel_id UUID DEFAULT NULL,
    p_conversation_id UUID DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_view_context RECORD;
BEGIN
    -- Get user's current view context from synced table
    SELECT * INTO v_view_context
    FROM public.user_view_contexts
    WHERE user_id = p_user_id;

    IF NOT FOUND THEN
        RETURN FALSE; -- No view context, not viewing
    END IF;

    -- Check if viewing the exact server channel
    IF p_server_id IS NOT NULL AND p_channel_id IS NOT NULL THEN
        IF v_view_context.view_type = 'server_channel' AND
           v_view_context.server_id = p_server_id AND
           v_view_context.channel_id = p_channel_id THEN
            RETURN TRUE; -- User is viewing this channel
        END IF;
    END IF;

    -- Check if viewing the exact DM conversation
    IF p_conversation_id IS NOT NULL THEN
        IF v_view_context.view_type = 'dm' AND
           v_view_context.conversation_id = p_conversation_id THEN
            RETURN TRUE; -- User is viewing this DM
        END IF;
    END IF;

    RETURN FALSE; -- Not viewing this context
END;
$$;

COMMENT ON FUNCTION public.is_user_viewing_context IS 'Checks if user is viewing a specific channel/DM. Used by send_notification to suppress notifications at database level.';

-- Cleanup function to remove stale view contexts (run periodically via pg_cron)
CREATE OR REPLACE FUNCTION public.cleanup_stale_view_contexts()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    -- Delete view contexts older than 5 minutes (user likely navigated away)
    DELETE FROM public.user_view_contexts
    WHERE last_active_at < NOW() - INTERVAL '5 minutes';

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION public.cleanup_stale_view_contexts IS 'Cleans up stale view context entries. Should be run periodically via pg_cron.';
