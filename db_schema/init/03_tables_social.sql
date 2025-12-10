-- =============================================================================
-- Harmony Database Schema - Social Tables
-- =============================================================================
-- Tables for social features: posts, follows, interactions
-- =============================================================================

-- ---------------------------------------------------------------------------
-- POSTS - Timeline posts (Mastodon-style)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    
    -- Author
    author_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Content
    content jsonb NOT NULL,
    content_warning text,
    
    -- Visibility: public, unlisted, private (followers), direct
    visibility text DEFAULT 'public'::text,
    
    -- Reply chain
    reply_to_id uuid REFERENCES public.posts(id) ON DELETE SET NULL,
    reply_to_author_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    
    -- Reblog (boost)
    reblog_of_id uuid REFERENCES public.posts(id) ON DELETE SET NULL,
    
    -- Soft delete
    is_deleted boolean DEFAULT false,
    deleted_at timestamp with time zone,
    
    -- Pin to profile
    is_pinned boolean DEFAULT false,
    pinned_at timestamp with time zone,
    
    -- Federation
    is_local boolean DEFAULT true,
    is_federated boolean DEFAULT false,
    ap_id text,
    ap_type text DEFAULT 'Note'::text,
    federation_status text DEFAULT 'pending'::text,
    
    -- Denormalized counts
    replies_count integer DEFAULT 0,
    reblogs_count integer DEFAULT 0,
    favorites_count integer DEFAULT 0,
    
    -- Metadata
    metadata jsonb DEFAULT '{}'::jsonb,
    language text DEFAULT 'en'::text,
    
    -- Constraints
    CONSTRAINT posts_visibility_check CHECK (visibility IN ('public', 'unlisted', 'private', 'direct')),
    CONSTRAINT posts_federation_status_check CHECK (federation_status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'skipped'))
);

ALTER TABLE public.posts REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_posts_author_id ON public.posts(author_id);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON public.posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_visibility ON public.posts(visibility);
CREATE INDEX IF NOT EXISTS idx_posts_is_local ON public.posts(is_local);
CREATE INDEX IF NOT EXISTS idx_posts_ap_id ON public.posts(ap_id) WHERE ap_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_reply_to ON public.posts(reply_to_id) WHERE reply_to_id IS NOT NULL;

COMMENT ON TABLE public.posts IS 'Timeline posts - federated with Mastodon/Misskey';

-- ---------------------------------------------------------------------------
-- FOLLOWS - Following relationships
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.follows (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    
    follower_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    following_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Status: pending (awaiting approval), accepted, rejected
    status text DEFAULT 'pending'::text,
    
    -- Federation
    federation_status text DEFAULT 'pending'::text,
    ap_id text,
    
    -- Notifications
    notify_posts boolean DEFAULT true,
    show_reblogs boolean DEFAULT true,
    
    UNIQUE(follower_id, following_id),
    CONSTRAINT follows_status_check CHECK (status IN ('pending', 'accepted', 'rejected')),
    CONSTRAINT follows_federation_status_check CHECK (federation_status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'skipped')),
    CONSTRAINT follows_no_self_follow CHECK (follower_id != following_id)
);

ALTER TABLE public.follows REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_follows_follower_id ON public.follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following_id ON public.follows(following_id);
CREATE INDEX IF NOT EXISTS idx_follows_status ON public.follows(status);

COMMENT ON TABLE public.follows IS 'User following relationships';

-- ---------------------------------------------------------------------------
-- POST INTERACTIONS - Likes, reblogs, emoji reactions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.post_interactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
    
    -- Type: favorite, reblog, emoji_reaction, bookmark
    interaction_type text NOT NULL,
    
    -- For emoji reactions
    emoji_id uuid,
    custom_emoji_content text,
    
    -- Federation
    is_local boolean DEFAULT true,
    federation_status text DEFAULT 'pending'::text,
    ap_id text,
    metadata jsonb DEFAULT '{}'::jsonb,
    
    CONSTRAINT post_interactions_type_check CHECK (interaction_type IN ('favorite', 'reblog', 'emoji_reaction', 'bookmark')),
    CONSTRAINT post_interactions_federation_status_check CHECK (federation_status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'skipped'))
);

ALTER TABLE public.post_interactions REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_post_interactions_user_id ON public.post_interactions(user_id);
CREATE INDEX IF NOT EXISTS idx_post_interactions_post_id ON public.post_interactions(post_id);
CREATE INDEX IF NOT EXISTS idx_post_interactions_type ON public.post_interactions(interaction_type);

-- Unique constraint for non-emoji interactions
CREATE UNIQUE INDEX IF NOT EXISTS idx_post_interactions_unique 
    ON public.post_interactions(user_id, post_id, interaction_type) 
    WHERE interaction_type != 'emoji_reaction';

COMMENT ON TABLE public.post_interactions IS 'Post likes, reblogs, emoji reactions, and bookmarks';

-- ---------------------------------------------------------------------------
-- HASHTAGS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hashtags (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    name text NOT NULL UNIQUE,
    usage_count integer DEFAULT 0,
    last_used_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    is_trending boolean DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_hashtags_name ON public.hashtags(lower(name));
CREATE INDEX IF NOT EXISTS idx_hashtags_usage ON public.hashtags(usage_count DESC);

COMMENT ON TABLE public.hashtags IS 'Hashtag registry for trending and discovery';

-- ---------------------------------------------------------------------------
-- POST HASHTAGS - Junction table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.post_hashtags (
    post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
    hashtag_id uuid NOT NULL REFERENCES public.hashtags(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, hashtag_id)
);

-- ---------------------------------------------------------------------------
-- USER BLOCKS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_blocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    blocker_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    blocked_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    UNIQUE(blocker_id, blocked_user_id),
    CONSTRAINT user_blocks_no_self_block CHECK (blocker_id != blocked_user_id)
);

ALTER TABLE public.user_blocks REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON public.user_blocks(blocker_id);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON public.user_blocks(blocked_user_id);

COMMENT ON TABLE public.user_blocks IS 'User block relationships';

-- ---------------------------------------------------------------------------
-- TIMELINE ENTRIES - Cached timeline for fast retrieval
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.timeline_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
    timeline_type text DEFAULT 'home'::text,
    position bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    
    UNIQUE(user_id, post_id, timeline_type),
    CONSTRAINT timeline_entries_type_check CHECK (timeline_type IN ('home', 'local', 'federated', 'list'))
);

ALTER TABLE public.timeline_entries REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_timeline_entries_user_type ON public.timeline_entries(user_id, timeline_type);
CREATE INDEX IF NOT EXISTS idx_timeline_entries_position ON public.timeline_entries(user_id, timeline_type, position DESC);

COMMENT ON TABLE public.timeline_entries IS 'Cached timeline entries for fast feed retrieval';

DO $$
BEGIN
    RAISE NOTICE 'Social tables created successfully';
END $$;

