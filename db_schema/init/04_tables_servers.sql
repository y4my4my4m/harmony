-- =============================================================================
-- Harmony Database Schema - Server Tables
-- =============================================================================
-- Discord-like servers, channels, and messages
-- =============================================================================

-- ---------------------------------------------------------------------------
-- SERVERS (Discord-like communities)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.servers (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    
    name text NOT NULL,
    description text,
    icon text DEFAULT '/default_server.webp'::text,
    banner text,
    
    -- Owner
    owner uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Settings
    public boolean DEFAULT false,
    allow_cross_server_emojis boolean DEFAULT true,
    
    -- Federation
    is_local_server boolean DEFAULT true,
    federation_enabled boolean DEFAULT false,
    federation_domain text,
    federation_inbox_url text,
    federation_metadata jsonb DEFAULT '{}'::jsonb,
    supported_activities text[] DEFAULT '{}'::text[],
    ap_id text,
    host_domain text,
    
    -- Invite code
    invite_code text UNIQUE,

    -- WebFinger/federation handle (acct:{slug}@domain). Unique among local
    -- servers; NULL for remote servers. Auto-assigned by trg_assign_server_slug.
    slug text,
    
    -- Member count (denormalized)
    member_count integer DEFAULT 0,

    -- Featured communities (admin-managed)
    is_featured boolean DEFAULT false,
    featured_order integer DEFAULT 0,

    -- Length backstops (sanitize_server_text() trigger clamps on every write)
    CONSTRAINT servers_name_length_check CHECK (char_length(name) <= 100),
    CONSTRAINT servers_description_length_check CHECK (description IS NULL OR char_length(description) <= 500),
    CONSTRAINT servers_slug_format CHECK (slug IS NULL OR slug ~ '^[a-z0-9][a-z0-9_-]{0,63}$')
);

ALTER TABLE public.servers REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_servers_owner ON public.servers(owner);
CREATE INDEX IF NOT EXISTS idx_servers_invite_code ON public.servers(invite_code) WHERE invite_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_servers_federation ON public.servers(federation_enabled, is_local_server);
CREATE INDEX IF NOT EXISTS idx_servers_ap_id ON public.servers(ap_id) WHERE ap_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_servers_featured ON public.servers(is_featured, featured_order) WHERE is_featured = true;
CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_slug_local ON public.servers (lower(slug)) WHERE is_local_server = true AND slug IS NOT NULL;

COMMENT ON TABLE public.servers IS 'Discord-like community servers';
COMMENT ON COLUMN public.servers.allow_cross_server_emojis IS 'Whether server emojis can be used in other servers';
COMMENT ON COLUMN public.servers.ap_id IS 'ActivityPub ID for this server (Group actor)';
COMMENT ON COLUMN public.servers.host_domain IS 'Domain where this server is hosted (null if local)';
COMMENT ON COLUMN public.servers.is_local_server IS 'True if server is hosted on this instance';

-- ---------------------------------------------------------------------------
-- CHANNEL CATEGORIES
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.channel_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    name text NOT NULL,
    "order" integer DEFAULT 0,
    
    -- Federation
    federation_status text DEFAULT 'pending'::text,

    CONSTRAINT channel_categories_name_length_check CHECK (char_length(name) <= 100)
);

CREATE INDEX IF NOT EXISTS idx_channel_categories_server ON public.channel_categories(server_id);
CREATE INDEX IF NOT EXISTS idx_channel_categories_federation_status ON public.channel_categories(federation_status) WHERE federation_status = 'pending';

COMMENT ON TABLE public.channel_categories IS 'Channel category groupings within servers';

-- ---------------------------------------------------------------------------
-- CHANNELS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.channels (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    
    server_id uuid REFERENCES public.servers(id) ON DELETE CASCADE,
    category uuid REFERENCES public.channel_categories(id) ON DELETE SET NULL,
    
    name text NOT NULL,
    description text,
    
    -- Type: 0=text, 1=voice, 2=category
    type smallint DEFAULT 0,
    "order" integer DEFAULT 0,
    
    -- Permissions
    is_private boolean DEFAULT false,
    slowmode_seconds integer DEFAULT 0,
    
    -- Federation
    ap_id text,
    is_remote boolean DEFAULT false,
    federation_status text DEFAULT 'pending'::text,
    
    CONSTRAINT channels_federation_status_check CHECK (federation_status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'skipped')),
    CONSTRAINT channels_name_length_check CHECK (char_length(name) <= 100),
    CONSTRAINT channels_description_length_check CHECK (description IS NULL OR char_length(description) <= 1024)
);

ALTER TABLE public.channels REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_channels_server ON public.channels(server_id);
CREATE INDEX IF NOT EXISTS idx_channels_category ON public.channels(category);
CREATE INDEX IF NOT EXISTS idx_channels_federation_status ON public.channels(federation_status) WHERE federation_status = 'pending';

COMMENT ON TABLE public.channels IS 'Server channels (text and voice)';

-- ---------------------------------------------------------------------------
-- MESSAGES
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    
    -- Author (either user or bot, mutually exclusive)
    user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    bot_id uuid,
    
    -- Location (either channel or conversation, mutually exclusive)
    channel_id uuid REFERENCES public.channels(id) ON DELETE CASCADE,
    conversation_id uuid,
    
    -- Thread support
    thread_id uuid,
    reply_to uuid REFERENCES public.messages(id) ON DELETE SET NULL,
    
    -- Content
    content jsonb NOT NULL,
    
    -- Message state
    is_deleted boolean DEFAULT false,
    is_system boolean DEFAULT false,
    is_pinned boolean DEFAULT false,
    pinned_at timestamp with time zone,
    pinned_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    
    -- Encryption
    encrypted boolean DEFAULT false,
    encryption_metadata jsonb,
    megolm_session_id text,
    megolm_message_index integer,
    
    -- Legacy reactions array (deprecated, use reactions table)
    reactions uuid[],
    
    -- Federation
    federation_status text DEFAULT 'pending'::text,
    metadata jsonb DEFAULT '{}'::jsonb,
    
    CONSTRAINT messages_content_is_array CHECK (jsonb_typeof(content) = 'array'),
    CONSTRAINT messages_content_not_empty CHECK (jsonb_array_length(content) > 0),
    CONSTRAINT messages_federation_status_check CHECK (federation_status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'skipped')),
    -- Allow both NULL (message from deleted user) or exactly one non-NULL
    CONSTRAINT messages_user_or_bot_check CHECK (
        (user_id IS NULL AND bot_id IS NULL) OR  -- Deleted user
        (user_id IS NOT NULL AND bot_id IS NULL) OR  -- User message
        (user_id IS NULL AND bot_id IS NOT NULL)  -- Bot message
    )
    -- NOTE: per-message text length is enforced by `messages_text_length_check`
    -- added in `10_functions_core.sql` after the helper function is defined.
);

ALTER TABLE public.messages REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_messages_channel ON public.messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON public.messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_user ON public.messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON public.messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON public.messages(thread_id) WHERE thread_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_channel_created_main
  ON public.messages (channel_id, created_at DESC)
  WHERE thread_id IS NULL AND (is_deleted IS NULL OR is_deleted = false);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON public.messages (conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL
    AND thread_id IS NULL
    AND (is_deleted IS NULL OR is_deleted = false);

CREATE INDEX IF NOT EXISTS idx_messages_thread_created
  ON public.messages (thread_id, created_at ASC)
  WHERE thread_id IS NOT NULL;

COMMENT ON TABLE public.messages IS 'Channel and DM messages';

-- ---------------------------------------------------------------------------
-- THREADS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.threads (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    
    channel_id uuid NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
    parent_message_id uuid NOT NULL,
    
    name text NOT NULL,
    created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    archived boolean DEFAULT false,
    archived_at timestamp with time zone,
    auto_archive_duration integer DEFAULT 1440,
    locked boolean DEFAULT false,
    
    -- Denormalized counts
    message_count integer DEFAULT 0,
    member_count integer DEFAULT 0,
    
    last_message_id uuid,
    last_message_at timestamp with time zone,
    
    -- Federation
    ap_id text,
    federation_status text DEFAULT 'pending',

    CONSTRAINT threads_name_length_check CHECK (char_length(name) <= 100)
);

ALTER TABLE public.threads REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_threads_channel ON public.threads(channel_id);
CREATE INDEX IF NOT EXISTS idx_threads_parent_message ON public.threads(parent_message_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_ap_id ON public.threads(ap_id) WHERE ap_id IS NOT NULL;

COMMENT ON TABLE public.threads IS 'Message threads within channels';

-- FK: threads.parent_message_id → messages.id (needed for PostgREST joins in federation)
ALTER TABLE public.threads
    ADD CONSTRAINT threads_parent_message_id_fkey
    FOREIGN KEY (parent_message_id) REFERENCES public.messages(id) ON DELETE CASCADE;

-- Add FK for messages.thread_id after threads table exists
ALTER TABLE public.messages 
    ADD CONSTRAINT messages_thread_id_fkey 
    FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- THREAD MEMBERS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.thread_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    thread_id uuid NOT NULL REFERENCES public.threads(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    last_read_at timestamp with time zone,
    muted boolean DEFAULT false,
    
    UNIQUE(thread_id, user_id)
);

ALTER TABLE public.thread_members REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_thread_members_thread ON public.thread_members(thread_id);
CREATE INDEX IF NOT EXISTS idx_thread_members_user ON public.thread_members(user_id);

-- ---------------------------------------------------------------------------
-- EMOJIS (moved here from 06_tables_misc.sql - reactions FK depends on it)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.emojis (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    
    name character varying,
    url character varying,
    server_id uuid REFERENCES public.servers(id) ON DELETE CASCADE,
    uploader uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    
    usage_count integer DEFAULT 0,
    last_used timestamp with time zone,
    file_size integer,
    
    domain text,

    -- Ownership scope: 'server' (server_id set), 'instance' (server_id NULL,
    -- e.g. remote imports), or 'user' (personal emoji owned by `uploader`).
    scope text NOT NULL DEFAULT 'server',
    -- True for emoji created via the Klipy AI generation API (a 'user' scope).
    is_ai_generated boolean NOT NULL DEFAULT false,

    CONSTRAINT emojis_name_length_check CHECK (name IS NULL OR char_length(name::text) <= 64),
    CONSTRAINT emojis_scope_check CHECK (scope IN ('server', 'instance', 'user'))
);

CREATE INDEX IF NOT EXISTS idx_emojis_server ON public.emojis(server_id);
CREATE INDEX IF NOT EXISTS idx_emojis_name ON public.emojis(lower(name::text));
CREATE INDEX IF NOT EXISTS idx_emojis_user ON public.emojis(uploader) WHERE scope = 'user';
CREATE INDEX IF NOT EXISTS idx_emojis_scope ON public.emojis(scope);
CREATE INDEX IF NOT EXISTS idx_emojis_ai_generated
    ON public.emojis(uploader, created_at) WHERE is_ai_generated;

COMMENT ON TABLE public.emojis IS 'Custom emoji library';

-- ---------------------------------------------------------------------------
-- REACTIONS (for messages)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,

    message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
    user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
    bot_id uuid,  -- For bot reactions

    emoji_id uuid REFERENCES public.emojis(id) ON DELETE CASCADE,
    custom_emoji_content text,

    -- Denormalized from parent message for CDC server-side filtering
    channel_id uuid,
    conversation_id uuid,

    federation_status text DEFAULT 'pending'::text,
    metadata jsonb DEFAULT '{}'::jsonb,

    CONSTRAINT reactions_has_emoji CHECK (emoji_id IS NOT NULL OR custom_emoji_content IS NOT NULL),
    CONSTRAINT reactions_has_author CHECK (user_id IS NOT NULL OR bot_id IS NOT NULL),
    CONSTRAINT reactions_custom_emoji_length_check CHECK (custom_emoji_content IS NULL OR char_length(custom_emoji_content) <= 256)
);

ALTER TABLE public.reactions REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_reactions_message ON public.reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_reactions_user ON public.reactions(user_id);
CREATE INDEX IF NOT EXISTS idx_reactions_channel_id ON public.reactions(channel_id) WHERE channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reactions_conversation_id ON public.reactions(conversation_id) WHERE conversation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS reactions_message_user_emoji_unique
ON public.reactions (
  message_id,
  user_id,
  COALESCE(emoji_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(custom_emoji_content, '')
);

COMMENT ON TABLE public.reactions IS 'Message emoji reactions';

-- Auto-populate channel_id/conversation_id from the parent message on INSERT
CREATE OR REPLACE FUNCTION public.populate_reaction_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.channel_id IS NULL AND NEW.conversation_id IS NULL AND NEW.message_id IS NOT NULL THEN
    SELECT m.channel_id, m.conversation_id
    INTO NEW.channel_id, NEW.conversation_id
    FROM messages m
    WHERE m.id = NEW.message_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_populate_reaction_context ON reactions;
CREATE TRIGGER trg_populate_reaction_context
  BEFORE INSERT ON reactions
  FOR EACH ROW
  EXECUTE FUNCTION populate_reaction_context();

-- ---------------------------------------------------------------------------
-- USER SERVERS (membership)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_servers (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    
    -- Status: pending, accepted, banned
    status text DEFAULT 'accepted'::text,
    
    -- Federation
    member_instance text,
    
    -- Nickname in this server
    nickname text,
    
    -- Server organization
    folder_id uuid,  -- References server_folders, added after that table is created
    position integer DEFAULT 0,
    
    -- Notifications
    muted boolean DEFAULT false,
    muted_until timestamp with time zone,
    
    UNIQUE(user_id, server_id),
    CONSTRAINT user_servers_status_check CHECK (status IN ('pending', 'accepted', 'banned')),
    CONSTRAINT user_servers_nickname_length_check CHECK (nickname IS NULL OR char_length(nickname) <= 64)
);

ALTER TABLE public.user_servers REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_user_servers_user ON public.user_servers(user_id);
CREATE INDEX IF NOT EXISTS idx_user_servers_server ON public.user_servers(server_id);
CREATE INDEX IF NOT EXISTS idx_user_servers_folder_id ON public.user_servers(folder_id);
CREATE INDEX IF NOT EXISTS idx_user_servers_user_position ON public.user_servers(user_id, position);
CREATE INDEX IF NOT EXISTS idx_user_servers_by_instance ON public.user_servers(server_id, member_instance);
CREATE INDEX IF NOT EXISTS idx_user_servers_status ON public.user_servers(server_id, status);
CREATE INDEX IF NOT EXISTS idx_user_servers_user_server ON public.user_servers(user_id, server_id);

COMMENT ON TABLE public.user_servers IS 'Server membership records';
COMMENT ON COLUMN public.user_servers.member_instance IS 'Instance domain of the member (for efficient batching)';
COMMENT ON COLUMN public.user_servers.status IS 'Membership status: pending, accepted, rejected';
COMMENT ON COLUMN public.user_servers.folder_id IS 'Optional folder this server belongs to (null = root level)';
COMMENT ON COLUMN public.user_servers.position IS 'Sort order position within the folder or at root level';

-- ---------------------------------------------------------------------------
-- SERVER ROLES
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.server_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    
    name text NOT NULL,
    color text,
    position integer DEFAULT 0,
    
    -- Permission bits (Discord-style)
    permissions bigint DEFAULT 0,
    
    -- Special flags
    is_default boolean DEFAULT false,
    is_admin boolean DEFAULT false,
    mentionable boolean DEFAULT true,
    hoist boolean DEFAULT false,

    CONSTRAINT server_roles_name_length_check CHECK (char_length(name) <= 100)
);

ALTER TABLE public.server_roles REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_server_roles_server ON public.server_roles(server_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_server_roles_default ON public.server_roles(server_id) WHERE is_default = true;

COMMENT ON TABLE public.server_roles IS 'Server role definitions';

-- ---------------------------------------------------------------------------
-- USER ROLES (role assignments)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    role_id uuid NOT NULL REFERENCES public.server_roles(id) ON DELETE CASCADE,
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    assigned_at timestamp with time zone DEFAULT now(),
    assigned_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    
    UNIQUE(user_id, role_id)
);

ALTER TABLE public.user_roles REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_user_roles_user ON public.user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_server ON public.user_roles(server_id);

COMMENT ON TABLE public.user_roles IS 'User role assignments';

-- ---------------------------------------------------------------------------
-- CONVERSATIONS (DMs)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    
    -- Conversation info
    name text,
    type text DEFAULT 'direct'::text,
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    is_active boolean DEFAULT true,
    
    -- Metadata for federation etc.
    metadata jsonb DEFAULT '{}'::jsonb,
    
    CONSTRAINT conversations_type_check CHECK (type IN ('direct', 'group', 'channel')),
    CONSTRAINT conversations_name_length_check CHECK (name IS NULL OR char_length(name) <= 100)
);

ALTER TABLE public.conversations REPLICA IDENTITY FULL;

-- Add FK to messages.conversation_id
ALTER TABLE public.messages 
    ADD CONSTRAINT messages_conversation_id_fkey 
    FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;

COMMENT ON TABLE public.conversations IS 'DM conversations between users. Supports both local users (in auth.users) and federated users (profiles only). Foreign keys reference profiles to enable federated DMs.';

-- ---------------------------------------------------------------------------
-- CONVERSATION PARTICIPANTS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversation_participants (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    role text DEFAULT 'member'::text,
    joined_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    left_at timestamp with time zone,
    
    -- Last read tracking
    last_read_at timestamp with time zone,
    last_read_message_id uuid,

    -- Notifications
    is_muted boolean DEFAULT false,

    -- Per-user dismissal: hide the conversation from this user's list without
    -- deleting it or leaving. Cleared (set back to NULL) when the conversation
    -- is reopened or a newer message arrives, so it reappears on new activity.
    hidden_at timestamp with time zone,

    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT conversation_participants_role_check CHECK (role = ANY (ARRAY['admin'::text, 'member'::text])),
    UNIQUE(conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_participants_conversation ON public.conversation_participants(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_participants_user ON public.conversation_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_conversation_participants_conv_user ON public.conversation_participants(conversation_id, user_id);

COMMENT ON TABLE public.conversation_participants IS 'DM conversation participants';

-- ---------------------------------------------------------------------------
-- INVITES
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    code text NOT NULL UNIQUE,
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    channel_id uuid REFERENCES public.channels(id) ON DELETE SET NULL,
    created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    created_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone,
    max_uses integer,
    uses integer DEFAULT 0,
    used boolean DEFAULT false,
    temporary boolean DEFAULT false,

    CONSTRAINT invites_code_format_check CHECK (code ~ '^[A-Za-z0-9_-]{1,64}$')
);

CREATE INDEX IF NOT EXISTS idx_invites_code ON public.invites(code);
CREATE INDEX IF NOT EXISTS idx_invites_server ON public.invites(server_id);

COMMENT ON TABLE public.invites IS 'Server invite links';

-- ---------------------------------------------------------------------------
-- VOICE CHANNEL PARTICIPANTS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.voice_channel_participants (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    channel_id uuid NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    
    -- Federation
    is_federated boolean DEFAULT false NOT NULL,
    federation_status text DEFAULT 'local'::text,
    
    -- State
    is_muted boolean DEFAULT false,
    is_deafened boolean DEFAULT false,
    is_video_enabled boolean DEFAULT false,
    is_screen_sharing boolean DEFAULT false,
    
    -- Metadata
    metadata jsonb DEFAULT '{}'::jsonb,
    
    UNIQUE(channel_id, user_id)
);

ALTER TABLE public.voice_channel_participants REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_voice_participants_channel ON public.voice_channel_participants(channel_id);
CREATE INDEX IF NOT EXISTS idx_voice_participants_user ON public.voice_channel_participants(user_id);

COMMENT ON TABLE public.voice_channel_participants IS 'Active voice channel participants';

-- ---------------------------------------------------------------------------
-- SERVER BANS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.server_bans (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    banned_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
    reason text,
    delete_message_seconds integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,

    UNIQUE(server_id, user_id),
    CONSTRAINT server_bans_reason_length_check CHECK (reason IS NULL OR char_length(reason) <= 512)
);

ALTER TABLE public.server_bans REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_server_bans_server ON public.server_bans(server_id);
CREATE INDEX IF NOT EXISTS idx_server_bans_user ON public.server_bans(user_id);

COMMENT ON TABLE public.server_bans IS 'Server-level ban records for moderation';

DO $$
BEGIN
    RAISE NOTICE 'Server tables created successfully';
END $$;

