-- Safe migration for emojis table - Add columns with proper handling
-- First, add columns that can be NULL initially
ALTER TABLE emojis ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE emojis ADD COLUMN IF NOT EXISTS usage_count integer DEFAULT 0;
ALTER TABLE emojis ADD COLUMN IF NOT EXISTS last_used timestamptz;

-- Check if server_id column exists, if not add it as nullable first
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'emojis' AND column_name = 'server_id') THEN
        ALTER TABLE emojis ADD COLUMN server_id uuid REFERENCES servers(id) ON DELETE CASCADE;
    END IF;
END $$;

-- Update existing emojis to have a server_id if they don't have one
-- You'll need to manually set server_id for existing emojis or delete orphaned ones
-- UPDATE emojis SET server_id = 'your-default-server-id' WHERE server_id IS NULL;

-- Only add NOT NULL constraint after ensuring all records have server_id
-- ALTER TABLE emojis ALTER COLUMN server_id SET NOT NULL;

-- Add missing NOT NULL constraints for other fields (only if they don't have data issues)
-- ALTER TABLE emojis ALTER COLUMN name SET NOT NULL;
-- ALTER TABLE emojis ALTER COLUMN url SET NOT NULL;
-- ALTER TABLE emojis ALTER COLUMN uploader SET NOT NULL;

-- Add indexes for performance (safe operations)
CREATE INDEX IF NOT EXISTS idx_emojis_server_id ON emojis(server_id);
CREATE INDEX IF NOT EXISTS idx_emojis_name ON emojis(name);
CREATE INDEX IF NOT EXISTS idx_emojis_updated_at ON emojis(updated_at);
CREATE INDEX IF NOT EXISTS idx_emojis_usage_count ON emojis(usage_count DESC);
CREATE INDEX IF NOT EXISTS idx_emojis_last_used ON emojis(last_used DESC);

-- Add unique constraint for emoji names within a server (only after server_id is populated)
-- ALTER TABLE emojis ADD CONSTRAINT unique_emoji_name_per_server UNIQUE(server_id, name);

-- Create function to automatically update the updated_at column
CREATE OR REPLACE FUNCTION update_emoji_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update updated_at on emoji changes
DROP TRIGGER IF EXISTS trigger_emoji_updated_at ON emojis;
CREATE TRIGGER trigger_emoji_updated_at
    BEFORE UPDATE ON emojis
    FOR EACH ROW
    EXECUTE FUNCTION update_emoji_updated_at();

-- Function to get emoji metadata for cache validation
CREATE OR REPLACE FUNCTION get_emoji_metadata_bulk(server_ids uuid[])
RETURNS TABLE(
    server_id uuid,
    last_modified timestamptz,
    emoji_count integer
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.server_id,
        COALESCE(MAX(e.updated_at), MAX(e.created_at)) as last_modified,
        COUNT(e.id)::integer as emoji_count
    FROM emojis e
    WHERE e.server_id = ANY(server_ids)
    GROUP BY e.server_id;
END;
$$ LANGUAGE plpgsql;

-- Function to get most used emojis for preloading
CREATE OR REPLACE FUNCTION get_most_used_emojis(server_ids uuid[] DEFAULT NULL, limit_count integer DEFAULT 100)
RETURNS TABLE(
    emoji_id uuid,
    server_id uuid,
    name text,
    url text,
    usage_count integer,
    last_used timestamptz
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.id as emoji_id,
        e.server_id,
        e.name,
        e.url,
        e.usage_count,
        e.last_used
    FROM emojis e
    WHERE 
        CASE 
            WHEN server_ids IS NOT NULL THEN e.server_id = ANY(server_ids)
            ELSE TRUE
        END
    ORDER BY e.usage_count DESC, e.last_used DESC NULLS LAST
    LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- Function to increment emoji usage count
CREATE OR REPLACE FUNCTION increment_emoji_usage(emoji_id uuid)
RETURNS void AS $$
BEGIN
    UPDATE emojis 
    SET 
        usage_count = usage_count + 1,
        last_used = now(),
        updated_at = now()
    WHERE id = emoji_id;
END;
$$ LANGUAGE plpgsql;

-- Function to get emoji analytics for a server
CREATE OR REPLACE FUNCTION get_server_emoji_analytics(target_server_id uuid)
RETURNS TABLE(
    total_emojis integer,
    total_usage integer,
    most_used_emoji_name text,
    most_used_emoji_count integer,
    least_used_emoji_name text,
    least_used_emoji_count integer,
    average_usage numeric
) AS $$
BEGIN
    RETURN QUERY
    WITH emoji_stats AS (
        SELECT 
            COUNT(*) as total_emojis,
            SUM(usage_count) as total_usage,
            AVG(usage_count) as avg_usage
        FROM emojis 
        WHERE server_id = target_server_id
    ),
    most_used AS (
        SELECT name, usage_count
        FROM emojis 
        WHERE server_id = target_server_id 
        ORDER BY usage_count DESC 
        LIMIT 1
    ),
    least_used AS (
        SELECT name, usage_count
        FROM emojis 
        WHERE server_id = target_server_id 
        ORDER BY usage_count ASC 
        LIMIT 1
    )
    SELECT 
        es.total_emojis::integer,
        es.total_usage::integer,
        mu.name as most_used_emoji_name,
        mu.usage_count::integer as most_used_emoji_count,
        lu.name as least_used_emoji_name,
        lu.usage_count::integer as least_used_emoji_count,
        es.avg_usage::numeric as average_usage
    FROM emoji_stats es
    LEFT JOIN most_used mu ON true
    LEFT JOIN least_used lu ON true;
END;
$$ LANGUAGE plpgsql;

-- Better emoji usage tracking with per-user and per-context granularity

-- Create emoji_usage table to track individual usage events
CREATE TABLE IF NOT EXISTS emoji_usage (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    emoji_id uuid NOT NULL REFERENCES emojis(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    context_type text NOT NULL CHECK (context_type IN ('message', 'reaction')),
    context_id uuid, -- message_id for both messages and reactions
    used_at timestamptz DEFAULT now(),
    
    -- Indexes for performance
    CONSTRAINT idx_emoji_usage_unique UNIQUE(emoji_id, user_id, context_type, context_id)
);

-- Indexes for emoji_usage table
CREATE INDEX IF NOT EXISTS idx_emoji_usage_emoji_id ON emoji_usage(emoji_id);
CREATE INDEX IF NOT EXISTS idx_emoji_usage_user_id ON emoji_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_emoji_usage_server_id ON emoji_usage(server_id);
CREATE INDEX IF NOT EXISTS idx_emoji_usage_used_at ON emoji_usage(used_at DESC);
CREATE INDEX IF NOT EXISTS idx_emoji_usage_context ON emoji_usage(context_type, context_id);

-- Function to record emoji usage
CREATE OR REPLACE FUNCTION record_emoji_usage(
    p_emoji_id uuid,
    p_user_id uuid,
    p_server_id uuid,
    p_context_type text,
    p_context_id uuid DEFAULT NULL
)
RETURNS void AS $$
BEGIN
    -- Insert usage record (ignore if duplicate due to unique constraint)
    INSERT INTO emoji_usage (emoji_id, user_id, server_id, context_type, context_id)
    VALUES (p_emoji_id, p_user_id, p_server_id, p_context_type, p_context_id)
    ON CONFLICT (emoji_id, user_id, context_type, context_id) DO NOTHING;
    
    -- Update emoji global usage count and last_used
    UPDATE emojis 
    SET 
        usage_count = (
            SELECT COUNT(DISTINCT (user_id, context_type, context_id))
            FROM emoji_usage 
            WHERE emoji_id = p_emoji_id
        ),
        last_used = now(),
        updated_at = now()
    WHERE id = p_emoji_id;
END;
$$ LANGUAGE plpgsql;

-- Function to get emoji usage analytics with user-specific data
CREATE OR REPLACE FUNCTION get_emoji_usage_analytics(
    p_server_id uuid,
    p_user_id uuid DEFAULT NULL,
    p_limit integer DEFAULT 10
)
RETURNS TABLE(
    emoji_id uuid,
    emoji_name text,
    emoji_url text,
    total_uses bigint,
    unique_users bigint,
    user_uses bigint,
    last_used timestamptz,
    message_uses bigint,
    reaction_uses bigint
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.id as emoji_id,
        e.name as emoji_name,
        e.url as emoji_url,
        COUNT(eu.*) as total_uses,
        COUNT(DISTINCT eu.user_id) as unique_users,
        CASE 
            WHEN p_user_id IS NOT NULL THEN 
                COUNT(CASE WHEN eu.user_id = p_user_id THEN 1 END)
            ELSE 0 
        END as user_uses,
        MAX(eu.used_at) as last_used,
        COUNT(CASE WHEN eu.context_type = 'message' THEN 1 END) as message_uses,
        COUNT(CASE WHEN eu.context_type = 'reaction' THEN 1 END) as reaction_uses
    FROM emojis e
    LEFT JOIN emoji_usage eu ON e.id = eu.emoji_id
    WHERE e.server_id = p_server_id
    GROUP BY e.id, e.name, e.url
    ORDER BY total_uses DESC, unique_users DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- Function to get user's most used emojis
CREATE OR REPLACE FUNCTION get_user_emoji_stats(
    p_user_id uuid,
    p_server_id uuid DEFAULT NULL,
    p_limit integer DEFAULT 20
)
RETURNS TABLE(
    emoji_id uuid,
    emoji_name text,
    emoji_url text,
    usage_count bigint,
    last_used timestamptz,
    message_uses bigint,
    reaction_uses bigint
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.id as emoji_id,
        e.name as emoji_name,
        e.url as emoji_url,
        COUNT(eu.*) as usage_count,
        MAX(eu.used_at) as last_used,
        COUNT(CASE WHEN eu.context_type = 'message' THEN 1 END) as message_uses,
        COUNT(CASE WHEN eu.context_type = 'reaction' THEN 1 END) as reaction_uses
    FROM emoji_usage eu
    JOIN emojis e ON eu.emoji_id = e.id
    WHERE eu.user_id = p_user_id
    AND (p_server_id IS NULL OR eu.server_id = p_server_id)
    GROUP BY e.id, e.name, e.url
    ORDER BY usage_count DESC, last_used DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- Enable RLS for emoji_usage table
ALTER TABLE emoji_usage ENABLE ROW LEVEL SECURITY;

-- RLS policies for emoji_usage
CREATE POLICY emoji_usage_access_policy ON emoji_usage
FOR ALL
TO authenticated
USING (
    server_id IN (
        SELECT server_id 
        FROM user_servers 
        WHERE user_id = auth.uid()
    )
);

-- Grant permissions
GRANT ALL ON emoji_usage TO authenticated;
GRANT EXECUTE ON FUNCTION record_emoji_usage(uuid, uuid, uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_emoji_usage_analytics(uuid, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION get_user_emoji_stats(uuid, uuid, integer) TO authenticated;

-- Enable Row Level Security (RLS) for emoji access control
ALTER TABLE emojis ENABLE ROW LEVEL SECURITY;

-- RLS policy to allow users to see emojis from servers they belong to
CREATE POLICY emoji_access_policy ON emojis
FOR ALL
TO authenticated
USING (
    server_id IN (
        SELECT server_id 
        FROM user_servers 
        WHERE user_id = auth.uid()
    )
);

-- RLS policy to allow users to see public server emojis
CREATE POLICY emoji_public_access_policy ON emojis
FOR SELECT
TO authenticated
USING (
    server_id IN (
        SELECT id 
        FROM servers 
        WHERE public = true
    )
);

-- Grant necessary permissions
GRANT SELECT ON emojis TO authenticated;
GRANT INSERT ON emojis TO authenticated;
GRANT UPDATE ON emojis TO authenticated;
GRANT DELETE ON emojis TO authenticated;
GRANT EXECUTE ON FUNCTION get_emoji_metadata_bulk(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION get_most_used_emojis(uuid[], integer) TO authenticated;
GRANT EXECUTE ON FUNCTION increment_emoji_usage(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_server_emoji_analytics(uuid) TO authenticated;