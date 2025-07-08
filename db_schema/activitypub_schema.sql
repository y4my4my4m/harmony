-- ActivityPub Federation Schema for Harmony (Monyverse)
-- Professional federated social media implementation
-- Scalable, clean, and DRY design for the Monyverse

-- =============================================
-- PROFILES TABLE MODIFICATION
-- Split username into username + domain for federation
-- =============================================

-- First, let's safely migrate existing usernames
-- Step 1: Add domain column
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS domain TEXT;

-- Step 2: Extract domain from existing usernames and update
UPDATE profiles SET 
    domain = CASE 
        WHEN username LIKE '%@%' THEN split_part(username, '@', -1)
        ELSE 'harmony.com'
    END
WHERE domain IS NULL;

-- Step 3: Update username to remove domain part
UPDATE profiles SET 
    username = CASE 
        WHEN username LIKE '%@%' THEN split_part(username, '@', 1)
        ELSE username
    END
WHERE username LIKE '%@%';

-- Step 4: Set default domain for null values
UPDATE profiles SET domain = 'harmony.com' WHERE domain IS NULL;

-- Step 5: Make domain NOT NULL
ALTER TABLE profiles ALTER COLUMN domain SET NOT NULL;
ALTER TABLE profiles ALTER COLUMN domain SET DEFAULT 'harmony.com';

-- Create index for efficient federated user lookups
CREATE INDEX IF NOT EXISTS idx_profiles_username_domain ON profiles(username, domain);
CREATE INDEX IF NOT EXISTS idx_profiles_domain ON profiles(domain);

-- Add federated user fields
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS federated_id TEXT; -- ActivityPub actor ID
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS public_key TEXT; -- For ActivityPub verification
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS private_key TEXT; -- For signing (encrypted)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS inbox_url TEXT; -- ActivityPub inbox
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS outbox_url TEXT; -- ActivityPub outbox
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS followers_url TEXT; -- ActivityPub followers
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS following_url TEXT; -- ActivityPub following
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS featured_url TEXT; -- Featured posts
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_local BOOLEAN DEFAULT true; -- Local vs federated user
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP WITH TIME ZONE; -- Last federation sync

-- Create unique constraint for federated identity
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_federated_id ON profiles(federated_id) WHERE federated_id IS NOT NULL;

-- =============================================
-- FEDERATED INSTANCES TABLE
-- =============================================

CREATE TABLE IF NOT EXISTS federated_instances (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    domain TEXT NOT NULL UNIQUE,
    software TEXT, -- 'mastodon', 'pleroma', 'harmony', etc.
    version TEXT,
    description TEXT,
    admin_contact TEXT,
    is_blocked BOOLEAN DEFAULT false,
    is_trusted BOOLEAN DEFAULT false,
    last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    user_count INTEGER DEFAULT 0,
    status_count INTEGER DEFAULT 0,
    connection_count INTEGER DEFAULT 0, -- Number of follows between instances
    metadata JSONB DEFAULT '{}'::jsonb -- Store additional instance info
);

-- Indexes for federated instances
CREATE INDEX IF NOT EXISTS idx_federated_instances_domain ON federated_instances(domain);
CREATE INDEX IF NOT EXISTS idx_federated_instances_is_blocked ON federated_instances(is_blocked);
CREATE INDEX IF NOT EXISTS idx_federated_instances_last_seen ON federated_instances(last_seen_at);

-- =============================================
-- POSTS TABLE (ActivityPub Objects)
-- =============================================

CREATE TABLE IF NOT EXISTS posts (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Content
    content JSONB NOT NULL, -- Rich content like messages (text, mentions, emojis, files)
    content_warning TEXT, -- Content warning/spoiler text
    language TEXT DEFAULT 'en',
    
    -- Author
    author_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    
    -- ActivityPub fields
    ap_id TEXT UNIQUE, -- ActivityPub object ID (for federated posts)
    ap_type TEXT DEFAULT 'Note', -- ActivityPub object type
    url TEXT, -- Public URL of the post
    
    -- Thread/Reply structure
    in_reply_to UUID REFERENCES posts(id) ON DELETE SET NULL,
    conversation_id UUID, -- Thread conversation ID
    
    -- Visibility and federation
    visibility TEXT DEFAULT 'public' CHECK (visibility IN ('public', 'unlisted', 'followers', 'direct')),
    is_local BOOLEAN DEFAULT true,
    is_federated BOOLEAN DEFAULT true, -- Whether to federate this post
    
    -- Interaction counts (cached for performance)
    replies_count INTEGER DEFAULT 0,
    reblogs_count INTEGER DEFAULT 0,
    favorites_count INTEGER DEFAULT 0,
    
    -- Media and attachments
    media_attachments JSONB DEFAULT '[]'::jsonb,
    
    -- Metadata
    metadata JSONB DEFAULT '{}'::jsonb,
    
    -- Moderation
    is_sensitive BOOLEAN DEFAULT false,
    is_deleted BOOLEAN DEFAULT false,
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for posts
CREATE INDEX IF NOT EXISTS idx_posts_author_id ON posts(author_id);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_ap_id ON posts(ap_id) WHERE ap_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_conversation_id ON posts(conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_in_reply_to ON posts(in_reply_to) WHERE in_reply_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_visibility ON posts(visibility);
CREATE INDEX IF NOT EXISTS idx_posts_is_local ON posts(is_local);
CREATE INDEX IF NOT EXISTS idx_posts_is_deleted ON posts(is_deleted);

-- Composite indexes for efficient timeline queries
CREATE INDEX IF NOT EXISTS idx_posts_timeline ON posts(author_id, created_at DESC) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_posts_public_timeline ON posts(created_at DESC) WHERE visibility IN ('public', 'unlisted') AND is_deleted = false;

-- =============================================
-- FOLLOWS TABLE (ActivityPub Follow relationships)
-- =============================================

CREATE TABLE IF NOT EXISTS follows (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Relationship
    follower_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    following_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    
    -- ActivityPub fields
    ap_id TEXT UNIQUE, -- ActivityPub Follow activity ID
    accepted_at TIMESTAMP WITH TIME ZONE, -- When follow was accepted
    
    -- State
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
    is_local BOOLEAN DEFAULT true, -- Whether this is a local follow relationship
    
    -- Metadata
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Ensure no self-follows and unique relationships
ALTER TABLE follows ADD CONSTRAINT follows_no_self_follow CHECK (follower_id != following_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_follows_unique ON follows(follower_id, following_id);

-- Indexes for follows
CREATE INDEX IF NOT EXISTS idx_follows_follower_id ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following_id ON follows(following_id);
CREATE INDEX IF NOT EXISTS idx_follows_status ON follows(status);
CREATE INDEX IF NOT EXISTS idx_follows_ap_id ON follows(ap_id) WHERE ap_id IS NOT NULL;

-- =============================================
-- POST INTERACTIONS TABLE
-- =============================================

CREATE TABLE IF NOT EXISTS post_interactions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Interaction details
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    interaction_type TEXT NOT NULL CHECK (interaction_type IN ('favorite', 'reblog', 'bookmark')),
    
    -- ActivityPub fields
    ap_id TEXT UNIQUE, -- ActivityPub activity ID
    
    -- State
    is_local BOOLEAN DEFAULT true,
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Ensure unique interactions per user per post
CREATE UNIQUE INDEX IF NOT EXISTS idx_post_interactions_unique ON post_interactions(user_id, post_id, interaction_type);

-- Indexes for post interactions
CREATE INDEX IF NOT EXISTS idx_post_interactions_user_id ON post_interactions(user_id);
CREATE INDEX IF NOT EXISTS idx_post_interactions_post_id ON post_interactions(post_id);
CREATE INDEX IF NOT EXISTS idx_post_interactions_type ON post_interactions(interaction_type);
CREATE INDEX IF NOT EXISTS idx_post_interactions_ap_id ON post_interactions(ap_id) WHERE ap_id IS NOT NULL;

-- =============================================
-- TIMELINES TABLE (Cached timeline entries)
-- =============================================

CREATE TABLE IF NOT EXISTS timeline_entries (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Timeline details
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    timeline_type TEXT NOT NULL CHECK (timeline_type IN ('home', 'public', 'local', 'notifications')),
    
    -- Ordering and metadata
    position BIGINT, -- For pagination
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Unique constraint to prevent duplicates
CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_entries_unique ON timeline_entries(user_id, post_id, timeline_type);

-- Indexes for timeline entries
CREATE INDEX IF NOT EXISTS idx_timeline_entries_user_timeline ON timeline_entries(user_id, timeline_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_timeline_entries_post_id ON timeline_entries(post_id);

-- =============================================
-- ACTIVITYPUB ACTIVITIES TABLE
-- =============================================

CREATE TABLE IF NOT EXISTS ap_activities (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- ActivityPub activity details
    ap_id TEXT NOT NULL UNIQUE,
    ap_type TEXT NOT NULL, -- 'Create', 'Update', 'Delete', 'Follow', 'Accept', 'Reject', etc.
    actor_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    target_id UUID, -- Can reference posts, profiles, etc.
    target_type TEXT, -- 'post', 'profile', etc.
    
    -- Activity data
    activity_data JSONB NOT NULL,
    
    -- Processing state
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    processed_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    
    -- Delivery tracking
    is_local BOOLEAN DEFAULT false,
    origin_domain TEXT,
    
    -- Metadata
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Indexes for ActivityPub activities
CREATE INDEX IF NOT EXISTS idx_ap_activities_ap_id ON ap_activities(ap_id);
CREATE INDEX IF NOT EXISTS idx_ap_activities_actor_id ON ap_activities(actor_id);
CREATE INDEX IF NOT EXISTS idx_ap_activities_type ON ap_activities(ap_type);
CREATE INDEX IF NOT EXISTS idx_ap_activities_status ON ap_activities(status);
CREATE INDEX IF NOT EXISTS idx_ap_activities_created_at ON ap_activities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ap_activities_target ON ap_activities(target_id, target_type) WHERE target_id IS NOT NULL;

-- =============================================
-- DELIVERY QUEUE TABLE
-- =============================================

CREATE TABLE IF NOT EXISTS delivery_queue (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Delivery details
    activity_id UUID NOT NULL REFERENCES ap_activities(id) ON DELETE CASCADE,
    target_domain TEXT NOT NULL,
    target_inbox_url TEXT NOT NULL,
    
    -- Delivery state
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
    attempt_count INTEGER DEFAULT 0,
    next_attempt_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_attempt_at TIMESTAMP WITH TIME ZONE,
    delivered_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    
    -- Metadata
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Indexes for delivery queue
CREATE INDEX IF NOT EXISTS idx_delivery_queue_activity_id ON delivery_queue(activity_id);
CREATE INDEX IF NOT EXISTS idx_delivery_queue_target_domain ON delivery_queue(target_domain);
CREATE INDEX IF NOT EXISTS idx_delivery_queue_status ON delivery_queue(status);
CREATE INDEX IF NOT EXISTS idx_delivery_queue_next_attempt ON delivery_queue(next_attempt_at) WHERE status IN ('pending', 'failed');

-- =============================================
-- ROW LEVEL SECURITY POLICIES
-- =============================================

-- Enable RLS on all tables
ALTER TABLE federated_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE timeline_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_queue ENABLE ROW LEVEL SECURITY;

-- Federated instances - public read, admin write
CREATE POLICY "Anyone can view federated instances" ON federated_instances
    FOR SELECT USING (true);

CREATE POLICY "Only authenticated users can manage instances" ON federated_instances
    FOR ALL USING (auth.uid() IS NOT NULL);

-- Posts - visibility-based access
CREATE POLICY "Users can view public posts" ON posts
    FOR SELECT USING (
        visibility IN ('public', 'unlisted') 
        AND is_deleted = false
    );

CREATE POLICY "Users can view their own posts" ON posts
    FOR SELECT USING (auth.uid() = author_id);

CREATE POLICY "Users can view posts from users they follow" ON posts
    FOR SELECT USING (
        visibility = 'followers'
        AND is_deleted = false
        AND EXISTS (
            SELECT 1 FROM follows 
            WHERE follower_id = auth.uid() 
            AND following_id = author_id 
            AND status = 'accepted'
        )
    );

CREATE POLICY "Users can create their own posts" ON posts
    FOR INSERT WITH CHECK (auth.uid() = author_id);

CREATE POLICY "Users can update their own posts" ON posts
    FOR UPDATE USING (auth.uid() = author_id);

CREATE POLICY "Users can delete their own posts" ON posts
    FOR DELETE USING (auth.uid() = author_id);

-- Follows - users can manage their own relationships
CREATE POLICY "Users can view follows" ON follows
    FOR SELECT USING (
        auth.uid() = follower_id 
        OR auth.uid() = following_id
    );

CREATE POLICY "Users can create follow relationships" ON follows
    FOR INSERT WITH CHECK (auth.uid() = follower_id);

CREATE POLICY "Users can update their follow relationships" ON follows
    FOR UPDATE USING (
        auth.uid() = follower_id 
        OR auth.uid() = following_id
    );

CREATE POLICY "Users can delete their follow relationships" ON follows
    FOR DELETE USING (
        auth.uid() = follower_id 
        OR auth.uid() = following_id
    );

-- Post interactions - users can manage their own interactions
CREATE POLICY "Users can view all interactions" ON post_interactions
    FOR SELECT USING (true);

CREATE POLICY "Users can create their own interactions" ON post_interactions
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own interactions" ON post_interactions
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own interactions" ON post_interactions
    FOR DELETE USING (auth.uid() = user_id);

-- Timeline entries - users can only see their own timelines
CREATE POLICY "Users can view their own timeline entries" ON timeline_entries
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "System can manage timeline entries" ON timeline_entries
    FOR ALL WITH CHECK (true);

-- ActivityPub activities - system managed
CREATE POLICY "System can manage ActivityPub activities" ON ap_activities
    FOR ALL WITH CHECK (true);

-- Delivery queue - system managed
CREATE POLICY "System can manage delivery queue" ON delivery_queue
    FOR ALL WITH CHECK (true);

-- =============================================
-- TRIGGERS AND FUNCTIONS
-- =============================================

-- Function to update post interaction counts
CREATE OR REPLACE FUNCTION update_post_counts()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE posts SET
            favorites_count = favorites_count + CASE WHEN NEW.interaction_type = 'favorite' THEN 1 ELSE 0 END,
            reblogs_count = reblogs_count + CASE WHEN NEW.interaction_type = 'reblog' THEN 1 ELSE 0 END
        WHERE id = NEW.post_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE posts SET
            favorites_count = favorites_count - CASE WHEN OLD.interaction_type = 'favorite' THEN 1 ELSE 0 END,
            reblogs_count = reblogs_count - CASE WHEN OLD.interaction_type = 'reblog' THEN 1 ELSE 0 END
        WHERE id = OLD.post_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger for post interaction counts
CREATE TRIGGER update_post_counts_trigger
    AFTER INSERT OR DELETE ON post_interactions
    FOR EACH ROW EXECUTE FUNCTION update_post_counts();

-- Function to update reply counts
CREATE OR REPLACE FUNCTION update_reply_counts()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.in_reply_to IS NOT NULL THEN
        UPDATE posts SET replies_count = replies_count + 1
        WHERE id = NEW.in_reply_to;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' AND OLD.in_reply_to IS NOT NULL THEN
        UPDATE posts SET replies_count = replies_count - 1
        WHERE id = OLD.in_reply_to;
        RETURN OLD;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Trigger for reply counts
CREATE TRIGGER update_reply_counts_trigger
    AFTER INSERT OR DELETE ON posts
    FOR EACH ROW EXECUTE FUNCTION update_reply_counts();

-- Function to create timeline entries for new posts
CREATE OR REPLACE FUNCTION create_timeline_entries()
RETURNS TRIGGER AS $$
BEGIN
    -- Add to author's timeline
    INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
    VALUES (NEW.author_id, NEW.id, 'home', extract(epoch from NEW.created_at) * 1000000);
    
    -- Add to followers' timelines if public/unlisted
    IF NEW.visibility IN ('public', 'unlisted') THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        SELECT f.follower_id, NEW.id, 'home', extract(epoch from NEW.created_at) * 1000000
        FROM follows f
        WHERE f.following_id = NEW.author_id AND f.status = 'accepted';
    END IF;
    
    -- Add to public timeline if public
    IF NEW.visibility = 'public' THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        SELECT p.id, NEW.id, 'public', extract(epoch from NEW.created_at) * 1000000
        FROM profiles p
        WHERE p.is_local = true;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for timeline entries
CREATE TRIGGER create_timeline_entries_trigger
    AFTER INSERT ON posts
    FOR EACH ROW EXECUTE FUNCTION create_timeline_entries();

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add updated_at triggers to relevant tables
CREATE TRIGGER update_federated_instances_updated_at
    BEFORE UPDATE ON federated_instances
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_posts_updated_at
    BEFORE UPDATE ON posts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_follows_updated_at
    BEFORE UPDATE ON follows
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =============================================
-- ENABLE REALTIME
-- =============================================

-- Enable real-time subscriptions for ActivityPub tables
ALTER PUBLICATION supabase_realtime ADD TABLE posts;
ALTER PUBLICATION supabase_realtime ADD TABLE follows;
ALTER PUBLICATION supabase_realtime ADD TABLE post_interactions;
ALTER PUBLICATION supabase_realtime ADD TABLE timeline_entries;
ALTER PUBLICATION supabase_realtime ADD TABLE federated_instances;

-- =============================================
-- HELPER FUNCTIONS
-- =============================================

-- Function to get user's timeline
CREATE OR REPLACE FUNCTION get_user_timeline(
    p_user_id UUID,
    p_timeline_type TEXT DEFAULT 'home',
    p_limit INTEGER DEFAULT 20,
    p_max_id UUID DEFAULT NULL
)
RETURNS TABLE(
    post_id UUID,
    content JSONB,
    author_id UUID,
    author_username TEXT,
    author_display_name TEXT,
    author_avatar_url TEXT,
    author_domain TEXT,
    created_at TIMESTAMP WITH TIME ZONE,
    visibility TEXT,
    replies_count INTEGER,
    reblogs_count INTEGER,
    favorites_count INTEGER,
    in_reply_to UUID,
    media_attachments JSONB,
    is_favorited BOOLEAN,
    is_reblogged BOOLEAN
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id as post_id,
        p.content,
        p.author_id,
        pr.username as author_username,
        pr.display_name as author_display_name,
        pr.avatar_url as author_avatar_url,
        pr.domain as author_domain,
        p.created_at,
        p.visibility,
        p.replies_count,
        p.reblogs_count,
        p.favorites_count,
        p.in_reply_to,
        p.media_attachments,
        EXISTS(
            SELECT 1 FROM post_interactions pi 
            WHERE pi.post_id = p.id 
            AND pi.user_id = p_user_id 
            AND pi.interaction_type = 'favorite'
        ) as is_favorited,
        EXISTS(
            SELECT 1 FROM post_interactions pi 
            WHERE pi.post_id = p.id 
            AND pi.user_id = p_user_id 
            AND pi.interaction_type = 'reblog'
        ) as is_reblogged
    FROM timeline_entries te
    JOIN posts p ON te.post_id = p.id
    JOIN profiles pr ON p.author_id = pr.id
    WHERE te.user_id = p_user_id
    AND te.timeline_type = p_timeline_type
    AND p.is_deleted = false
    AND (p_max_id IS NULL OR p.created_at < (SELECT created_at FROM posts WHERE id = p_max_id))
    ORDER BY p.created_at DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- Function to get federated user handle
CREATE OR REPLACE FUNCTION get_user_handle(p_user_id UUID)
RETURNS TEXT AS $$
DECLARE
    user_record profiles%ROWTYPE;
BEGIN
    SELECT * INTO user_record FROM profiles WHERE id = p_user_id;
    IF user_record.domain = 'harmony.com' THEN
        RETURN '@' || user_record.username;
    ELSE
        RETURN '@' || user_record.username || '@' || user_record.domain;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to search federated users
CREATE OR REPLACE FUNCTION search_federated_users(
    p_query TEXT,
    p_limit INTEGER DEFAULT 10
)
RETURNS TABLE(
    user_id UUID,
    username TEXT,
    display_name TEXT,
    domain TEXT,
    avatar_url TEXT,
    handle TEXT,
    is_local BOOLEAN
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id as user_id,
        p.username,
        p.display_name,
        p.domain,
        p.avatar_url,
        get_user_handle(p.id) as handle,
        p.is_local
    FROM profiles p
    WHERE (
        p.username ILIKE '%' || p_query || '%'
        OR p.display_name ILIKE '%' || p_query || '%'
        OR (p.username || '@' || p.domain) ILIKE '%' || p_query || '%'
    )
    ORDER BY 
        CASE WHEN p.is_local THEN 0 ELSE 1 END,
        p.username
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;
