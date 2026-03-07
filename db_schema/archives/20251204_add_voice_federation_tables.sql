-- Migration: Add voice federation support tables and triggers
-- Enables federation of voice channel join/leave events and DM calls

-- =============================================================================
-- VOICE CHANNEL PARTICIPANTS TABLE
-- =============================================================================
-- Tracks all users currently in voice channels (both local and federated)

CREATE TABLE IF NOT EXISTS public.voice_channel_participants (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    channel_id UUID NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    server_id UUID NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    is_federated BOOLEAN DEFAULT FALSE NOT NULL,
    federation_status TEXT DEFAULT 'local',
    -- Additional voice state
    is_muted BOOLEAN DEFAULT FALSE,
    is_deafened BOOLEAN DEFAULT FALSE,
    is_video_enabled BOOLEAN DEFAULT FALSE,
    is_screen_sharing BOOLEAN DEFAULT FALSE,
    -- Metadata for federated users
    metadata JSONB DEFAULT '{}'::jsonb,
    
    UNIQUE(channel_id, user_id)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_voice_channel_participants_channel 
    ON public.voice_channel_participants(channel_id);
CREATE INDEX IF NOT EXISTS idx_voice_channel_participants_user 
    ON public.voice_channel_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_voice_channel_participants_server 
    ON public.voice_channel_participants(server_id);

-- RLS policies
ALTER TABLE public.voice_channel_participants ENABLE ROW LEVEL SECURITY;

-- Users can see participants in servers they're members of
CREATE POLICY "View voice participants in servers you're a member of"
    ON public.voice_channel_participants FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.user_servers us
            WHERE us.server_id = voice_channel_participants.server_id
            AND us.user_id = auth.uid()
            AND us.status = 'accepted'
        )
    );

-- Users can insert/update their own participation
CREATE POLICY "Manage own voice participation"
    ON public.voice_channel_participants FOR ALL
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- Service role can manage all (for federation backend)
CREATE POLICY "Service role full access"
    ON public.voice_channel_participants FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- =============================================================================
-- FEDERATED VOICE CALLS TABLE (for DM calls)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.federated_voice_calls (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    ap_id TEXT UNIQUE NOT NULL,
    caller_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    caller_federated_id TEXT NOT NULL,
    recipient_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    call_type TEXT CHECK (call_type IN ('voice', 'video')) NOT NULL,
    conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
    livekit_url TEXT NOT NULL,
    room_name TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'ended', 'missed')) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    accepted_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_federated_voice_calls_caller 
    ON public.federated_voice_calls(caller_id);
CREATE INDEX IF NOT EXISTS idx_federated_voice_calls_recipient 
    ON public.federated_voice_calls(recipient_id);
CREATE INDEX IF NOT EXISTS idx_federated_voice_calls_status 
    ON public.federated_voice_calls(status);
CREATE INDEX IF NOT EXISTS idx_federated_voice_calls_expires 
    ON public.federated_voice_calls(expires_at);

-- RLS policies
ALTER TABLE public.federated_voice_calls ENABLE ROW LEVEL SECURITY;

-- Users can see calls they're involved in
CREATE POLICY "View own calls"
    ON public.federated_voice_calls FOR SELECT
    USING (caller_id = auth.uid() OR recipient_id = auth.uid());

-- Users can update calls they're involved in
CREATE POLICY "Update own calls"
    ON public.federated_voice_calls FOR UPDATE
    USING (caller_id = auth.uid() OR recipient_id = auth.uid());

-- Service role can manage all (for federation backend)
CREATE POLICY "Service role full access on calls"
    ON public.federated_voice_calls FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- =============================================================================
-- TRIGGER: FEDERATE VOICE CHANNEL JOIN
-- =============================================================================

CREATE OR REPLACE FUNCTION public.trigger_queue_voice_channel_join_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_is_local BOOLEAN;
    v_server_is_local BOOLEAN;
    v_federation_enabled BOOLEAN;
BEGIN
    -- Skip if this is already a federated entry
    IF NEW.is_federated = TRUE THEN
        RETURN NEW;
    END IF;
    
    -- Check if user is local
    SELECT is_local INTO v_user_is_local
    FROM public.profiles
    WHERE id = NEW.user_id;
    
    IF v_user_is_local IS NOT TRUE THEN
        RETURN NEW;
    END IF;
    
    -- Check if server is local and federation enabled
    SELECT is_local_server, federation_enabled 
    INTO v_server_is_local, v_federation_enabled
    FROM public.servers
    WHERE id = NEW.server_id;
    
    -- If local server with federation, broadcast to remote members
    -- If remote server, federate join to that server
    IF v_federation_enabled = TRUE OR v_server_is_local = FALSE THEN
        NEW.federation_status := 'queued';
        
        PERFORM public.queue_federation_job(
            'federate-voice-join',
            jsonb_build_object(
                'type', 'join',
                'channel_id', NEW.channel_id,
                'server_id', NEW.server_id,
                'user_id', NEW.user_id
            ),
            10,  -- high priority for real-time voice
            3,   -- retry_limit
            300  -- expire_in (5 min - voice events are time-sensitive)
        );
    END IF;
    
    RETURN NEW;
END;
$$;

ALTER FUNCTION public.trigger_queue_voice_channel_join_federation() OWNER TO supabase_admin;

DROP TRIGGER IF EXISTS trigger_federate_voice_channel_join ON public.voice_channel_participants;

CREATE TRIGGER trigger_federate_voice_channel_join
    BEFORE INSERT ON public.voice_channel_participants
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_voice_channel_join_federation();

-- =============================================================================
-- TRIGGER: FEDERATE VOICE CHANNEL LEAVE
-- =============================================================================

CREATE OR REPLACE FUNCTION public.trigger_queue_voice_channel_leave_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_is_local BOOLEAN;
    v_server_is_local BOOLEAN;
    v_federation_enabled BOOLEAN;
BEGIN
    -- Skip if this was a federated entry
    IF OLD.is_federated = TRUE THEN
        RETURN OLD;
    END IF;
    
    -- Check if user is local
    SELECT is_local INTO v_user_is_local
    FROM public.profiles
    WHERE id = OLD.user_id;
    
    IF v_user_is_local IS NOT TRUE THEN
        RETURN OLD;
    END IF;
    
    -- Check if server is local and federation enabled
    SELECT is_local_server, federation_enabled 
    INTO v_server_is_local, v_federation_enabled
    FROM public.servers
    WHERE id = OLD.server_id;
    
    IF v_federation_enabled = TRUE OR v_server_is_local = FALSE THEN
        PERFORM public.queue_federation_job(
            'federate-voice-leave',
            jsonb_build_object(
                'type', 'leave',
                'channel_id', OLD.channel_id,
                'server_id', OLD.server_id,
                'user_id', OLD.user_id
            ),
            10,  -- high priority for real-time voice
            3,   -- retry_limit
            300  -- expire_in (5 min)
        );
    END IF;
    
    RETURN OLD;
END;
$$;

ALTER FUNCTION public.trigger_queue_voice_channel_leave_federation() OWNER TO supabase_admin;

DROP TRIGGER IF EXISTS trigger_federate_voice_channel_leave ON public.voice_channel_participants;

CREATE TRIGGER trigger_federate_voice_channel_leave
    AFTER DELETE ON public.voice_channel_participants
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_voice_channel_leave_federation();

-- =============================================================================
-- HELPER: Clean up expired voice participants (connection loss, etc.)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.cleanup_stale_voice_participants()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Remove participants that haven't been updated in 5 minutes
    -- (The frontend should send heartbeats to keep presence alive)
    DELETE FROM public.voice_channel_participants
    WHERE joined_at < NOW() - INTERVAL '5 minutes'
    AND NOT EXISTS (
        SELECT 1 FROM public.user_presence up
        WHERE up.user_id = voice_channel_participants.user_id
        AND up.voice_channel_id = voice_channel_participants.channel_id
        AND up.last_seen > NOW() - INTERVAL '2 minutes'
    );
END;
$$;

ALTER FUNCTION public.cleanup_stale_voice_participants() OWNER TO supabase_admin;

-- =============================================================================
-- HELPER: Get voice channel participants with user info
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_voice_channel_participants(p_channel_id UUID)
RETURNS TABLE (
    user_id UUID,
    username TEXT,
    display_name TEXT,
    avatar_url TEXT,
    is_federated BOOLEAN,
    federated_domain TEXT,
    joined_at TIMESTAMPTZ,
    is_muted BOOLEAN,
    is_deafened BOOLEAN,
    is_video_enabled BOOLEAN,
    is_screen_sharing BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        vcp.user_id,
        p.username,
        p.display_name,
        p.avatar_url,
        vcp.is_federated,
        p.domain AS federated_domain,
        vcp.joined_at,
        vcp.is_muted,
        vcp.is_deafened,
        vcp.is_video_enabled,
        vcp.is_screen_sharing
    FROM public.voice_channel_participants vcp
    JOIN public.profiles p ON p.id = vcp.user_id
    WHERE vcp.channel_id = p_channel_id
    ORDER BY vcp.joined_at ASC;
END;
$$;

ALTER FUNCTION public.get_voice_channel_participants(UUID) OWNER TO supabase_admin;

-- =============================================================================
-- UPDATE enable/disable functions to include voice triggers
-- =============================================================================

CREATE OR REPLACE FUNCTION public.enable_federation_triggers()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    ALTER TABLE public.posts ENABLE TRIGGER trigger_federate_post;
    ALTER TABLE public.post_interactions ENABLE TRIGGER trigger_federate_post_interaction;
    ALTER TABLE public.post_interactions ENABLE TRIGGER trigger_federate_post_interaction_delete;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow_delete;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_dm;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message_edit;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message_delete;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_message_reaction;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_message_reaction_delete;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_channel_reaction;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_channel_reaction_delete;
    ALTER TABLE public.user_blocks ENABLE TRIGGER trigger_federate_block;
    ALTER TABLE public.user_blocks ENABLE TRIGGER trigger_federate_block_delete;
    ALTER TABLE public.reports ENABLE TRIGGER trigger_federate_report;
    ALTER TABLE public.profiles ENABLE TRIGGER trigger_federate_profile;
    ALTER TABLE public.voice_channel_participants ENABLE TRIGGER trigger_federate_voice_channel_join;
    ALTER TABLE public.voice_channel_participants ENABLE TRIGGER trigger_federate_voice_channel_leave;
    
    RAISE NOTICE '✅ All federation triggers enabled (including voice)';
END;
$$;

CREATE OR REPLACE FUNCTION public.disable_federation_triggers()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    ALTER TABLE public.posts DISABLE TRIGGER trigger_federate_post;
    ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_federate_post_interaction;
    ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_federate_post_interaction_delete;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow_delete;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_dm;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message_edit;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message_delete;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_message_reaction;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_message_reaction_delete;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_channel_reaction;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_channel_reaction_delete;
    ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block;
    ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block_delete;
    ALTER TABLE public.reports DISABLE TRIGGER trigger_federate_report;
    ALTER TABLE public.profiles DISABLE TRIGGER trigger_federate_profile;
    ALTER TABLE public.voice_channel_participants DISABLE TRIGGER trigger_federate_voice_channel_join;
    ALTER TABLE public.voice_channel_participants DISABLE TRIGGER trigger_federate_voice_channel_leave;
    
    RAISE NOTICE '⚠️ All federation triggers disabled';
END;
$$;

