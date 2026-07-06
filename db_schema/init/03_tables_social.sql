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
    language text DEFAULT 'en'::text,
    
    -- ActivityPub
    ap_id text,
    ap_type text DEFAULT 'Note'::text,
    url text,
    
    -- Reply chain
    in_reply_to uuid REFERENCES public.posts(id) ON DELETE SET NULL,
    conversation_id uuid,
    conversation_root_id uuid,
    
    -- Visibility: public, unlisted, followers, direct
    visibility text DEFAULT 'public'::text,
    
    -- Local/Federation state
    is_local boolean DEFAULT true,
    is_federated boolean DEFAULT true,
    federation_status text DEFAULT 'pending'::text,
    federated_to text[] DEFAULT '{}'::text[],
    last_federated_at timestamp with time zone,
    
    -- Denormalized counts
    replies_count integer DEFAULT 0,
    reblogs_count integer DEFAULT 0,
    favorites_count integer DEFAULT 0,
    
    -- Media
    media_attachments jsonb DEFAULT '[]'::jsonb,
    voice_attachments jsonb DEFAULT '[]'::jsonb,
    
    -- Metadata
    metadata jsonb DEFAULT '{}'::jsonb,
    is_sensitive boolean DEFAULT false,
    
    -- Soft delete
    is_deleted boolean DEFAULT false,
    deleted_at timestamp with time zone,
    
    -- Edit history
    edit_history jsonb DEFAULT '[]'::jsonb,
    
    -- Reblog support (embedded reblog data for performance)
    reblog jsonb,
    reblog_author jsonb,
    
    -- Pin to profile
    is_pinned boolean DEFAULT false,
    
    -- Denormalized user interaction states (computed per-user in queries)
    -- These are placeholder columns used by RPC functions
    is_favorited boolean DEFAULT false,
    is_reblogged boolean DEFAULT false,
    is_bookmarked boolean DEFAULT false,
    
    -- Constraints
    CONSTRAINT posts_content_is_array CHECK (jsonb_typeof(content) = 'array'),
    CONSTRAINT posts_content_not_empty CHECK (jsonb_array_length(content) > 0 OR reblog IS NOT NULL),
    CONSTRAINT posts_visibility_check CHECK (visibility IN ('public', 'unlisted', 'followers', 'direct')),
    CONSTRAINT posts_federation_status_check CHECK (federation_status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'skipped')),
    CONSTRAINT posts_content_warning_length_check CHECK (content_warning IS NULL OR char_length(content_warning) <= 200)
);

ALTER TABLE public.posts REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_posts_author_id ON public.posts(author_id);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON public.posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_visibility ON public.posts(visibility);
CREATE INDEX IF NOT EXISTS idx_posts_is_local ON public.posts(is_local);
-- UNIQUE: federated posts are keyed by ap_id; the check-then-insert path in
-- ActivityProcessor relies on this to be race-proof against concurrent delivery.
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_ap_id ON public.posts(ap_id) WHERE ap_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_in_reply_to ON public.posts(in_reply_to) WHERE in_reply_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_conversation_id ON public.posts(conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_conversation_root ON public.posts(conversation_root_id) WHERE conversation_root_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_not_deleted ON public.posts(created_at DESC) WHERE is_deleted = false;

COMMENT ON TABLE public.posts IS 'Timeline posts - federated with Mastodon/Misskey';
COMMENT ON COLUMN public.posts.conversation_root_id IS 'UUID of the root post in this ActivityPub conversation thread. Enables O(1) conversation lookups.';
COMMENT ON COLUMN public.posts.is_favorited IS 'Whether the current user has favorited this post (computed in queries)';
COMMENT ON COLUMN public.posts.is_reblogged IS 'Whether the current user has reblogged this post (computed in queries)';
COMMENT ON COLUMN public.posts.is_bookmarked IS 'Whether the current user has bookmarked this post (computed in queries)';
COMMENT ON CONSTRAINT posts_content_not_empty ON public.posts IS 'Ensures posts have content OR are reblogs. Pure reblogs can have empty content if reblog field is present.';

-- ---------------------------------------------------------------------------
-- FOLLOWS - Following relationships
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.follows (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    
    follower_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    following_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Federation
    ap_id text,
    accepted_at timestamp with time zone,
    
    -- Status: pending (awaiting approval), accepted, rejected
    status text DEFAULT 'pending'::text,
    is_local boolean DEFAULT true,
    metadata jsonb DEFAULT '{}'::jsonb,
    federation_status text DEFAULT 'pending'::text,
    
    UNIQUE(follower_id, following_id),
    CONSTRAINT follows_no_self_follow CHECK (follower_id != following_id),
    CONSTRAINT follows_status_check CHECK (status IN ('pending', 'accepted', 'rejected')),
    CONSTRAINT follows_federation_status_check CHECK (federation_status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'skipped'))
);

ALTER TABLE public.follows REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_follows_follower_id ON public.follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following_id ON public.follows(following_id);
CREATE INDEX IF NOT EXISTS idx_follows_status ON public.follows(status);

COMMENT ON TABLE public.follows IS 'User following relationships';
COMMENT ON COLUMN public.follows.follower_id IS 'ID of the user doing the following. This is the source of the follow relationship (follower_id -> following_id)';
COMMENT ON COLUMN public.follows.following_id IS 'ID of the user being followed. IMPORTANT: Code should use following_id, NOT followed_id. This is the target of the follow relationship (follower_id -> following_id)';

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
    emoji_id uuid REFERENCES public.emojis(id) ON DELETE SET NULL,
    custom_emoji_content text,
    
    -- Federation
    is_local boolean DEFAULT true,
    federation_status text DEFAULT 'pending'::text,
    ap_id text,
    metadata jsonb DEFAULT '{}'::jsonb,
    
    CONSTRAINT post_interactions_type_check CHECK (interaction_type IN ('favorite', 'reblog', 'emoji_reaction', 'bookmark')),
    CONSTRAINT post_interactions_federation_status_check CHECK (federation_status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'skipped')),
    CONSTRAINT post_interactions_custom_emoji_length_check CHECK (custom_emoji_content IS NULL OR char_length(custom_emoji_content) <= 256)
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
-- HASHTAGS - With trending support
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hashtags (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    
    -- Tag name
    tag text NOT NULL,
    normalized_tag text NOT NULL,
    
    -- Usage counts
    total_uses integer DEFAULT 0,
    daily_uses integer DEFAULT 0,
    weekly_uses integer DEFAULT 0,
    
    -- Peak tracking
    peak_daily_uses integer DEFAULT 0,
    peak_daily_date date,
    
    -- Timestamps
    first_used_at timestamp with time zone DEFAULT now(),
    last_used_at timestamp with time zone DEFAULT now(),
    
    -- Trending
    trending_score numeric DEFAULT 0,
    trending_rank integer,
    last_trending_update timestamp with time zone,
    
    UNIQUE(normalized_tag)
);

CREATE INDEX IF NOT EXISTS idx_hashtags_tag ON public.hashtags(tag);
CREATE INDEX IF NOT EXISTS idx_hashtags_normalized ON public.hashtags(normalized_tag);
CREATE INDEX IF NOT EXISTS idx_hashtags_trending ON public.hashtags(trending_score DESC);
CREATE INDEX IF NOT EXISTS idx_hashtags_daily_uses ON public.hashtags(daily_uses DESC);

COMMENT ON TABLE public.hashtags IS 'Hashtag registry for trending and discovery';

-- ---------------------------------------------------------------------------
-- POST HASHTAGS - Junction table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.post_hashtags (
    post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
    hashtag_id uuid NOT NULL REFERENCES public.hashtags(id) ON DELETE CASCADE,
    created_at timestamp with time zone DEFAULT now(),
    position_in_content integer DEFAULT 0,
    PRIMARY KEY (post_id, hashtag_id)
);

CREATE INDEX IF NOT EXISTS idx_post_hashtags_hashtag ON public.post_hashtags(hashtag_id);
CREATE INDEX IF NOT EXISTS idx_post_hashtags_created ON public.post_hashtags(created_at DESC);

-- ---------------------------------------------------------------------------
-- USER BLOCKS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_blocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    blocker_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    blocked_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Block type: full, posts_only, interactions_only
    block_type text DEFAULT 'full'::text,
    reason text,
    expires_at timestamp with time zone,
    
    -- Federation
    metadata jsonb DEFAULT '{}'::jsonb,
    ap_id text,
    is_federated boolean DEFAULT false,
    federation_status text DEFAULT 'pending'::text,
    
    UNIQUE(blocker_id, blocked_user_id),
    CONSTRAINT user_blocks_no_self_block CHECK (blocker_id != blocked_user_id),
    CONSTRAINT user_blocks_block_type_check CHECK (block_type IN ('full', 'posts_only', 'interactions_only')),
    CONSTRAINT user_blocks_federation_status_check CHECK (federation_status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'skipped'))
);

ALTER TABLE public.user_blocks REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON public.user_blocks(blocker_id);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON public.user_blocks(blocked_user_id);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker_blocked ON public.user_blocks(blocker_id, blocked_user_id);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked_blocker ON public.user_blocks(blocked_user_id, blocker_id);

COMMENT ON TABLE public.user_blocks IS 'User-level blocking with granular control and optional expiration';
COMMENT ON COLUMN public.user_blocks.ap_id IS 'ActivityPub ID for federated Block activities';
COMMENT ON COLUMN public.user_blocks.is_federated IS 'Whether this block was received via federation';

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
    CONSTRAINT timeline_entries_timeline_type_check CHECK (timeline_type = ANY (ARRAY['home'::text, 'public'::text, 'local'::text, 'notifications'::text]))
);

ALTER TABLE public.timeline_entries REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_timeline_entries_user_type ON public.timeline_entries(user_id, timeline_type);
CREATE INDEX IF NOT EXISTS idx_timeline_entries_position ON public.timeline_entries(user_id, timeline_type, position DESC);

COMMENT ON TABLE public.timeline_entries IS 'Cached timeline entries for fast feed retrieval';

-- ---------------------------------------------------------------------------
-- USER LISTS - Mastodon-style lists for organizing followed accounts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_lists (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    
    -- Owner of the list
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- List metadata
    title text NOT NULL,
    description text,
    
    -- Visibility controls
    -- 'followed': Only show replies to other list members
    -- 'list': Only show replies to list members  
    -- 'none': Hide all replies
    replies_policy text DEFAULT 'list'::text,
    
    -- Whether the list is exclusive (members removed from home timeline)
    is_exclusive boolean DEFAULT false,
    
    -- Whether the list can be viewed by others
    is_public boolean DEFAULT false,
    
    -- ActivityPub federation
    federated_id text,
    ap_id text,
    is_local boolean DEFAULT true,
    
    CONSTRAINT user_lists_replies_policy_check 
        CHECK (replies_policy IN ('followed', 'list', 'none')),
    CONSTRAINT user_lists_title_length_check CHECK (char_length(title) <= 100),
    CONSTRAINT user_lists_description_length_check CHECK (description IS NULL OR char_length(description) <= 500)
);

ALTER TABLE public.user_lists REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_user_lists_user_id ON public.user_lists(user_id);
CREATE INDEX IF NOT EXISTS idx_user_lists_created_at ON public.user_lists(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS user_lists_federated_id_key 
    ON public.user_lists(federated_id) WHERE federated_id IS NOT NULL;

COMMENT ON TABLE public.user_lists IS 'User-created lists for organizing followed accounts (Mastodon-compatible)';
COMMENT ON COLUMN public.user_lists.replies_policy IS 'Controls which replies are shown: followed, list, or none';
COMMENT ON COLUMN public.user_lists.is_exclusive IS 'When true, list members are hidden from home timeline';

-- ---------------------------------------------------------------------------
-- USER LIST MEMBERS - Junction table for list membership
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_list_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    
    -- The list this membership belongs to
    list_id uuid NOT NULL REFERENCES public.user_lists(id) ON DELETE CASCADE,
    
    -- The user being added to the list (must be followed by list owner)
    account_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Unique constraint: a user can only be in a list once
    CONSTRAINT user_list_members_unique UNIQUE (list_id, account_id)
);

ALTER TABLE public.user_list_members REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_user_list_members_list_id ON public.user_list_members(list_id);
CREATE INDEX IF NOT EXISTS idx_user_list_members_account_id ON public.user_list_members(account_id);

COMMENT ON TABLE public.user_list_members IS 'Membership junction table for user lists';

DO $$
BEGIN
    RAISE NOTICE 'Social tables created successfully';
END $$;

