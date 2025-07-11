-- Implement the ActivityPub conversation functions that currently have empty bodies
-- Based on the actual schema structure from the dump

BEGIN;

-- First, restart PostgREST to clear schema cache
NOTIFY pgrst, 'reload schema';

-- Drop and recreate get_activitypub_conversation_root with proper implementation
DROP FUNCTION IF EXISTS get_activitypub_conversation_root(uuid) CASCADE;
CREATE OR REPLACE FUNCTION get_activitypub_conversation_root(post_id uuid)
RETURNS TABLE(root_id uuid) 
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
    -- O(1) lookup using conversation_root_id column
    RETURN QUERY
    SELECT p.conversation_root_id
    FROM posts p
    WHERE p.id = post_id
    AND p.deleted_at IS NULL;
END;
$$;

-- Drop and recreate get_activitypub_conversation_thread with proper implementation
DROP FUNCTION IF EXISTS get_activitypub_conversation_thread(uuid) CASCADE;
CREATE OR REPLACE FUNCTION get_activitypub_conversation_thread(conversation_root_id uuid)
RETURNS TABLE(
    id uuid,
    content jsonb,
    created_at timestamp with time zone,
    author jsonb,
    visibility text,
    favorites_count integer,
    reblogs_count integer,
    replies_count integer,
    is_favorited boolean,
    is_reblogged boolean,
    is_bookmarked boolean,
    media_attachments jsonb,
    reply_context jsonb,
    content_warning text,
    is_sensitive boolean,
    reblog jsonb,
    reblog_author jsonb,
    url text,
    thread_depth integer
) 
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
    -- O(log n) lookup using indexed conversation_root_id
    RETURN QUERY
    WITH RECURSIVE thread_tree AS (
        -- Start with the root post
        SELECT 
            p.id,
            p.content,
            p.created_at,
            jsonb_build_object(
                'id', pr.id,
                'username', pr.username,
                'display_name', pr.display_name,
                'avatar_url', pr.avatar_url,
                'domain', COALESCE(pr.domain, 'har.mony.lol'),
                'handle', CASE 
                    WHEN COALESCE(pr.domain, 'har.mony.lol') = 'har.mony.lol'
                    THEN '@' || pr.username
                    ELSE '@' || pr.username || '@' || pr.domain
                END,
                'is_local', CASE WHEN COALESCE(pr.domain, 'har.mony.lol') = 'har.mony.lol' THEN true ELSE false END
            ) as author,
            p.visibility,
            COALESCE(p.favorites_count, 0) as favorites_count,
            COALESCE(p.reblogs_count, 0) as reblogs_count,
            COALESCE(p.replies_count, 0) as replies_count,
            false as is_favorited, -- Will be calculated per user in the frontend
            false as is_reblogged,
            false as is_bookmarked,
            COALESCE(p.media_attachments, '[]'::jsonb) as media_attachments,
            -- Reply context for replies
            CASE 
                WHEN p.in_reply_to IS NOT NULL THEN
                    jsonb_build_object(
                        'id', rp.id,
                        'author', jsonb_build_object(
                            'id', rpr.id,
                            'username', rpr.username,
                            'display_name', rpr.display_name,
                            'avatar_url', rpr.avatar_url,
                            'domain', COALESCE(rpr.domain, 'har.mony.lol')
                        ),
                        'created_at', rp.created_at,
                        'content_preview', LEFT(rp.content::text, 100)
                    )
                ELSE NULL
            END as reply_context,
            p.content_warning,
            COALESCE(p.is_sensitive, false) as is_sensitive,
            NULL::jsonb as reblog,
            NULL::jsonb as reblog_author,
            p.url,
            0 as thread_depth,
            p.created_at as sort_key
        FROM posts p
        LEFT JOIN profiles pr ON p.author_id = pr.id
        LEFT JOIN posts rp ON p.in_reply_to = rp.id
        LEFT JOIN profiles rpr ON rp.author_id = rpr.id
        WHERE p.conversation_root_id = get_activitypub_conversation_thread.conversation_root_id
        AND p.deleted_at IS NULL
        AND p.id = get_activitypub_conversation_thread.conversation_root_id -- Root post
        
        UNION ALL
        
        -- Recursively get all replies in the conversation
        SELECT 
            p.id,
            p.content,
            p.created_at,
            jsonb_build_object(
                'id', pr.id,
                'username', pr.username,
                'display_name', pr.display_name,
                'avatar_url', pr.avatar_url,
                'domain', COALESCE(pr.domain, 'har.mony.lol'),
                'handle', CASE 
                    WHEN COALESCE(pr.domain, 'har.mony.lol') = 'har.mony.lol'
                    THEN '@' || pr.username
                    ELSE '@' || pr.username || '@' || pr.domain
                END,
                'is_local', CASE WHEN COALESCE(pr.domain, 'har.mony.lol') = 'har.mony.lol' THEN true ELSE false END
            ) as author,
            p.visibility,
            COALESCE(p.favorites_count, 0) as favorites_count,
            COALESCE(p.reblogs_count, 0) as reblogs_count,
            COALESCE(p.replies_count, 0) as replies_count,
            false as is_favorited,
            false as is_reblogged,
            false as is_bookmarked,
            COALESCE(p.media_attachments, '[]'::jsonb) as media_attachments,
            CASE 
                WHEN p.in_reply_to IS NOT NULL THEN
                    jsonb_build_object(
                        'id', rp.id,
                        'author', jsonb_build_object(
                            'id', rpr.id,
                            'username', rpr.username,
                            'display_name', rpr.display_name,
                            'avatar_url', rpr.avatar_url,
                            'domain', COALESCE(rpr.domain, 'har.mony.lol')
                        ),
                        'created_at', rp.created_at,
                        'content_preview', LEFT(rp.content::text, 100)
                    )
                ELSE NULL
            END as reply_context,
            p.content_warning,
            COALESCE(p.is_sensitive, false) as is_sensitive,
            NULL::jsonb as reblog,
            NULL::jsonb as reblog_author,
            p.url,
            tt.thread_depth + 1,
            p.created_at as sort_key
        FROM posts p
        LEFT JOIN profiles pr ON p.author_id = pr.id
        LEFT JOIN posts rp ON p.in_reply_to = rp.id
        LEFT JOIN profiles rpr ON rp.author_id = rpr.id
        INNER JOIN thread_tree tt ON p.in_reply_to = tt.id
        WHERE p.conversation_root_id = get_activitypub_conversation_thread.conversation_root_id
        AND p.deleted_at IS NULL
        AND tt.thread_depth < 50 -- Prevent infinite recursion
    )
    SELECT 
        tt.id,
        tt.content,
        tt.created_at,
        tt.author,
        tt.visibility,
        tt.favorites_count,
        tt.reblogs_count,
        tt.replies_count,
        tt.is_favorited,
        tt.is_reblogged,
        tt.is_bookmarked,
        tt.media_attachments,
        tt.reply_context,
        tt.content_warning,
        tt.is_sensitive,
        tt.reblog,
        tt.reblog_author,
        tt.url,
        tt.thread_depth
    FROM thread_tree tt
    ORDER BY tt.sort_key ASC; -- Chronological order like Twitter/X
END;
$$;

-- Drop and recreate get_activitypub_conversation_context with proper implementation
DROP FUNCTION IF EXISTS get_activitypub_conversation_context(uuid) CASCADE;
CREATE OR REPLACE FUNCTION get_activitypub_conversation_context(post_id uuid)
RETURNS TABLE(
    conversation_root_id uuid,
    total_posts integer,
    participant_count integer,
    created_at timestamp with time zone,
    last_activity timestamp with time zone
) 
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    conv_root_id UUID;
BEGIN
    -- Get conversation_root_id for the post
    SELECT p.conversation_root_id 
    INTO conv_root_id
    FROM posts p 
    WHERE p.id = post_id
    AND p.deleted_at IS NULL;
    
    IF conv_root_id IS NULL THEN
        RETURN;
    END IF;
    
    -- Return conversation context
    RETURN QUERY
    SELECT 
        conv_root_id as conversation_root_id,
        COUNT(*)::integer as total_posts,
        COUNT(DISTINCT p.author_id)::integer as participant_count,
        MIN(p.created_at) as created_at,
        MAX(p.created_at) as last_activity
    FROM posts p
    WHERE p.conversation_root_id = conv_root_id
    AND p.deleted_at IS NULL;
END;
$$;

-- Also create the get_conversation_context function that some views are calling
DROP FUNCTION IF EXISTS get_conversation_context(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS get_conversation_context(uuid) CASCADE;

-- Two-parameter version (with user_id for interaction states)
CREATE OR REPLACE FUNCTION get_conversation_context(p_post_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    conversation_root_id uuid;
    result jsonb;
    ancestors jsonb DEFAULT '[]'::jsonb;
    descendants jsonb DEFAULT '[]'::jsonb;
BEGIN
    -- Get the conversation root ID for this post
    SELECT p.conversation_root_id 
    INTO conversation_root_id
    FROM posts p 
    WHERE p.id = p_post_id
    AND p.deleted_at IS NULL;
    
    IF conversation_root_id IS NULL THEN
        RETURN jsonb_build_object(
            'ancestors', '[]'::jsonb,
            'descendants', '[]'::jsonb,
            'conversation_id', null
        );
    END IF;
    
    -- Get all posts in conversation ordered chronologically
    WITH conversation_posts AS (
        SELECT 
            p.id,
            p.content,
            p.created_at,
            p.in_reply_to,
            jsonb_build_object(
                'id', pr.id,
                'username', pr.username,
                'display_name', pr.display_name,
                'avatar_url', pr.avatar_url,
                'domain', COALESCE(pr.domain, 'har.mony.lol')
            ) as author,
            p.visibility,
            COALESCE(p.favorites_count, 0) as favorites_count,
            COALESCE(p.reblogs_count, 0) as reblogs_count,
            COALESCE(p.replies_count, 0) as replies_count,
            COALESCE(p.media_attachments, '[]'::jsonb) as media_attachments,
            p.content_warning,
            COALESCE(p.is_sensitive, false) as is_sensitive,
            p.url,
            -- User interaction states (would need user_id parameter for real calculation)
            false as is_favorited,
            false as is_reblogged,
            false as is_bookmarked
        FROM posts p
        LEFT JOIN profiles pr ON p.author_id = pr.id
        WHERE p.conversation_root_id = conversation_root_id
        AND p.deleted_at IS NULL
        ORDER BY p.created_at ASC
    )
    SELECT jsonb_build_object(
        'ancestors', jsonb_agg(
            jsonb_build_object(
                'id', cp.id,
                'content', cp.content,
                'created_at', cp.created_at,
                'author', cp.author,
                'visibility', cp.visibility,
                'favorites_count', cp.favorites_count,
                'reblogs_count', cp.reblogs_count,
                'replies_count', cp.replies_count,
                'media_attachments', cp.media_attachments,
                'content_warning', cp.content_warning,
                'is_sensitive', cp.is_sensitive,
                'url', cp.url,
                'is_favorited', cp.is_favorited,
                'is_reblogged', cp.is_reblogged,
                'is_bookmarked', cp.is_bookmarked
            )
        ) FILTER (WHERE cp.created_at < (SELECT created_at FROM posts WHERE id = p_post_id)),
        'descendants', jsonb_agg(
            jsonb_build_object(
                'id', cp.id,
                'content', cp.content,
                'created_at', cp.created_at,
                'author', cp.author,
                'visibility', cp.visibility,
                'favorites_count', cp.favorites_count,
                'reblogs_count', cp.reblogs_count,
                'replies_count', cp.replies_count,
                'media_attachments', cp.media_attachments,
                'content_warning', cp.content_warning,
                'is_sensitive', cp.is_sensitive,
                'url', cp.url,
                'is_favorited', cp.is_favorited,
                'is_reblogged', cp.is_reblogged,
                'is_bookmarked', cp.is_bookmarked
            )
        ) FILTER (WHERE cp.created_at > (SELECT created_at FROM posts WHERE id = p_post_id)),
        'conversation_id', conversation_root_id
    ) INTO result
    FROM conversation_posts cp;
    
    RETURN COALESCE(result, jsonb_build_object(
        'ancestors', '[]'::jsonb,
        'descendants', '[]'::jsonb,
        'conversation_id', conversation_root_id
    ));
END;
$$;

-- Single-parameter version (calls two-parameter version with NULL user_id)
CREATE OR REPLACE FUNCTION get_conversation_context(p_post_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN get_conversation_context(p_post_id, NULL);
END;
$$;

-- Grant execute permissions to authenticated users
GRANT EXECUTE ON FUNCTION get_activitypub_conversation_root(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_activitypub_conversation_thread(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_activitypub_conversation_context(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_conversation_context(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_conversation_context(uuid) TO authenticated;

-- Ensure the trigger for setting conversation_root_id exists and works
CREATE OR REPLACE FUNCTION set_activitypub_conversation_root_id()
RETURNS TRIGGER 
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.in_reply_to IS NULL THEN
        -- This is a root post, set conversation_root_id to its own ID
        NEW.conversation_root_id = NEW.id;
    ELSE
        -- This is a reply, inherit conversation_root_id from parent
        SELECT conversation_root_id 
        INTO NEW.conversation_root_id
        FROM posts 
        WHERE id = NEW.in_reply_to;
        
        -- If parent doesn't exist or has no conversation_root_id, make this the root
        IF NEW.conversation_root_id IS NULL THEN
            NEW.conversation_root_id = NEW.id;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;

-- Create trigger if it doesn't exist
DROP TRIGGER IF EXISTS set_conversation_root_id_trigger ON posts;
CREATE TRIGGER set_conversation_root_id_trigger
    BEFORE INSERT ON posts
    FOR EACH ROW
    EXECUTE FUNCTION set_activitypub_conversation_root_id();

-- Force PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';

COMMIT;
