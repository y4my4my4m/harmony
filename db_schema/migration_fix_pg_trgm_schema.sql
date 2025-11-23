-- Migration: Fix pg_trgm extension schema and update search function
-- Date: 2025-11-23
-- Description: Moves pg_trgm extension from public to extensions schema and updates similarity function calls

-- Step 1: Drop the extension from public schema if it exists there
DROP EXTENSION IF EXISTS pg_trgm CASCADE;

-- Step 2: Recreate the extension in the extensions schema
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- Step 3: Update the search_messages function to use extensions.similarity()
CREATE OR REPLACE FUNCTION public.search_messages(
  p_query text DEFAULT NULL::text,
  p_channel_id uuid DEFAULT NULL::uuid,
  p_channel_ids uuid[] DEFAULT NULL::uuid[],
  p_user_id uuid DEFAULT NULL::uuid,
  p_conversation_id uuid DEFAULT NULL::uuid,
  p_server_id uuid DEFAULT NULL::uuid,
  p_has_media boolean DEFAULT NULL::boolean,
  p_has_url boolean DEFAULT NULL::boolean,
  p_from_date timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_to_date timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
  message_id uuid,
  relevance real,
  content_text text,
  channel_id uuid,
  conversation_id uuid,
  user_id uuid,
  created_at timestamp with time zone
)
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  current_user_profile_id uuid;
  search_query text;
  tsquery_val tsquery;
BEGIN
  -- Get current user's profile ID (works for both local and remote users)
  current_user_profile_id := get_current_user_profile_id();
  
  -- If no profile found, return empty (user not authenticated or no profile)
  IF current_user_profile_id IS NULL THEN
    RETURN;
  END IF;
  -- Build search query - handle empty query
  IF p_query IS NULL OR trim(p_query) = '' THEN
    search_query := '';
    tsquery_val := NULL;
  ELSE
    search_query := trim(p_query);
    -- Use plainto_tsquery for natural language search
    tsquery_val := plainto_tsquery('english', search_query);
  END IF;

  RETURN QUERY
  SELECT 
    msi.message_id,
    -- Combine ts_rank (full-text) with similarity (fuzzy) for ranking
    CASE 
      WHEN tsquery_val IS NOT NULL THEN
        (ts_rank(msi.content_tsvector, tsquery_val) * 0.7 +
         extensions.similarity(msi.content_text, search_query) * 0.3)::real
      ELSE
        -- If no query, rank by date
        1.0::real
    END as relevance,
    msi.content_text,
    msi.channel_id,
    msi.conversation_id,
    msi.user_id,
    msi.created_at
  FROM message_search_index msi
  WHERE 
    -- Access control: Only show messages user has access to
    (
      -- For conversations: user must be a participant
      (msi.conversation_id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM conversation_participants cp
        WHERE cp.conversation_id = msi.conversation_id
          AND cp.user_id = current_user_profile_id
          AND cp.left_at IS NULL
      ))
      OR
      -- For channels: user must be a member of the server
      (msi.channel_id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM channels c
        JOIN user_servers us ON c.server_id = us.server_id
        WHERE c.id = msi.channel_id
          AND us.user_id = current_user_profile_id
      ))
    )
    -- Search conditions (only if query provided)
    AND (tsquery_val IS NULL OR 
         msi.content_tsvector @@ tsquery_val OR 
         extensions.similarity(msi.content_text, search_query) > 0.2)
    -- Filters
    AND (p_channel_id IS NULL OR msi.channel_id = p_channel_id)
    AND (p_channel_ids IS NULL OR msi.channel_id = ANY(p_channel_ids))
    AND (p_user_id IS NULL OR msi.user_id = p_user_id)
    AND (p_conversation_id IS NULL OR msi.conversation_id = p_conversation_id)
    AND (p_server_id IS NULL OR msi.server_id = p_server_id)
    AND (p_has_media IS NULL OR msi.has_media = p_has_media)
    AND (p_has_url IS NULL OR msi.has_url = p_has_url)
    AND (p_from_date IS NULL OR msi.created_at >= p_from_date)
    AND (p_to_date IS NULL OR msi.created_at <= p_to_date)
  ORDER BY 
    CASE 
      WHEN tsquery_val IS NOT NULL THEN
        (ts_rank(msi.content_tsvector, tsquery_val) * 0.7 +
         extensions.similarity(msi.content_text, search_query) * 0.3)
      ELSE
        extract(epoch from msi.created_at) / 1000000.0 -- Convert timestamp to sortable number
    END DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$function$;

-- Step 4: Grant necessary permissions
GRANT USAGE ON SCHEMA extensions TO authenticated;
GRANT USAGE ON SCHEMA extensions TO anon;

-- Step 5: Verify the extension is in the correct schema
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 
    FROM pg_extension e
    JOIN pg_namespace n ON e.extnamespace = n.oid
    WHERE e.extname = 'pg_trgm' 
    AND n.nspname = 'extensions'
  ) THEN
    RAISE EXCEPTION 'pg_trgm extension not found in extensions schema';
  END IF;
  
  RAISE NOTICE 'Migration completed successfully. pg_trgm is now in extensions schema.';
END $$;

