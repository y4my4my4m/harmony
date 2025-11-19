-- Message Search Setup
-- Enables full-text search for messages using PostgreSQL's native capabilities
-- No LLMs or embeddings required - uses tsvector and pg_trgm

-- Enable pg_trgm extension for fuzzy matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Create search index table (denormalized for performance)
CREATE TABLE IF NOT EXISTS message_search_index (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  content_text text NOT NULL, -- Plain text extracted from MessagePart[]
  content_tsvector tsvector, -- Full-text search vector
  channel_id uuid REFERENCES channels(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  server_id uuid, -- Denormalized from channel
  has_media boolean DEFAULT false,
  has_url boolean DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz DEFAULT now(),
  UNIQUE(message_id)
);

-- Full-text search index (GIN for fast search)
CREATE INDEX IF NOT EXISTS idx_message_search_tsvector ON message_search_index USING gin (content_tsvector);

-- Filter indexes for fast filtering
CREATE INDEX IF NOT EXISTS idx_message_search_channel ON message_search_index (channel_id) WHERE channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_search_conversation ON message_search_index (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_search_user ON message_search_index (user_id);
CREATE INDEX IF NOT EXISTS idx_message_search_server ON message_search_index (server_id) WHERE server_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_search_created ON message_search_index (created_at);
CREATE INDEX IF NOT EXISTS idx_message_search_media ON message_search_index (has_media) WHERE has_media = true;
CREATE INDEX IF NOT EXISTS idx_message_search_url ON message_search_index (has_url) WHERE has_url = true;

-- Composite indexes for common filter combinations
CREATE INDEX IF NOT EXISTS idx_message_search_channel_date ON message_search_index (channel_id, created_at DESC) WHERE channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_search_user_date ON message_search_index (user_id, created_at DESC);

-- Function to extract plain text from MessagePart[] JSONB
CREATE OR REPLACE FUNCTION extract_message_text(content_parts jsonb)
RETURNS text AS $$
DECLARE
  part jsonb;
  text_result text := '';
BEGIN
  IF content_parts IS NULL OR jsonb_typeof(content_parts) != 'array' THEN
    RETURN '';
  END IF;

  FOR part IN SELECT * FROM jsonb_array_elements(content_parts)
  LOOP
    CASE (part->>'type')
      WHEN 'text' THEN
        text_result := text_result || COALESCE(part->>'text', '') || ' ';
      WHEN 'emoji' THEN
        text_result := text_result || COALESCE(':' || (part->'emoji'->>'name'), '') || ' ';
      WHEN 'mention' THEN
        text_result := text_result || COALESCE(part->>'mention', '') || ' ';
      WHEN 'url' THEN
        text_result := text_result || COALESCE(part->>'url', '') || ' ';
      WHEN 'hashtag' THEN
        text_result := text_result || COALESCE('#' || (part->>'name'), '') || ' ';
      WHEN 'file' THEN
        text_result := text_result || '[file] ';
      ELSE
        -- Skip system messages and unknown types
        NULL;
    END CASE;
  END LOOP;

  RETURN trim(text_result);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to detect message features (media/URL presence)
CREATE OR REPLACE FUNCTION detect_message_features(content_parts jsonb)
RETURNS jsonb AS $$
DECLARE
  part jsonb;
  has_media boolean := false;
  has_url boolean := false;
BEGIN
  IF content_parts IS NULL OR jsonb_typeof(content_parts) != 'array' THEN
    RETURN jsonb_build_object('has_media', false, 'has_url', false);
  END IF;

  FOR part IN SELECT * FROM jsonb_array_elements(content_parts)
  LOOP
    IF (part->>'type') = 'file' THEN
      has_media := true;
    ELSIF (part->>'type') = 'url' THEN
      has_url := true;
    END IF;
    
    -- Exit early if both found
    IF has_media AND has_url THEN
      EXIT;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('has_media', has_media, 'has_url', has_url);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to get server_id from channel_id
CREATE OR REPLACE FUNCTION get_channel_server_id(channel_uuid uuid)
RETURNS uuid AS $$
DECLARE
  server_uuid uuid;
BEGIN
  SELECT server_id INTO server_uuid
  FROM channels
  WHERE id = channel_uuid;
  
  RETURN server_uuid;
END;
$$ LANGUAGE plpgsql STABLE;

-- Function to index a message (called by trigger)
CREATE OR REPLACE FUNCTION index_message()
RETURNS trigger AS $$
DECLARE
  content_text_val text;
  features jsonb;
  server_id_val uuid;
BEGIN
  -- Skip deleted messages
  IF NEW.is_deleted = true THEN
    DELETE FROM message_search_index WHERE message_id = NEW.id;
    RETURN NEW;
  END IF;

  -- Extract plain text from MessagePart[] JSONB
  content_text_val := extract_message_text(NEW.content);
  
  -- Skip if no text content (system messages, etc.)
  IF content_text_val IS NULL OR trim(content_text_val) = '' THEN
    -- Still index for filtering by user/channel even without text
    content_text_val := '';
  END IF;

  -- Detect features
  features := detect_message_features(NEW.content);
  
  -- Get server_id if channel_id exists
  server_id_val := NULL;
  IF NEW.channel_id IS NOT NULL THEN
    server_id_val := get_channel_server_id(NEW.channel_id);
  END IF;

  -- Insert or update search index
  INSERT INTO message_search_index (
    message_id,
    content_text,
    content_tsvector,
    channel_id,
    conversation_id,
    user_id,
    server_id,
    has_media,
    has_url,
    created_at
  ) VALUES (
    NEW.id,
    content_text_val,
    to_tsvector('english', content_text_val),
    NEW.channel_id,
    NEW.conversation_id,
    NEW.user_id,
    server_id_val,
    (features->>'has_media')::boolean,
    (features->>'has_url')::boolean,
    NEW.created_at
  )
  ON CONFLICT (message_id) DO UPDATE SET
    content_text = EXCLUDED.content_text,
    content_tsvector = EXCLUDED.content_tsvector,
    channel_id = EXCLUDED.channel_id,
    conversation_id = EXCLUDED.conversation_id,
    user_id = EXCLUDED.user_id,
    server_id = EXCLUDED.server_id,
    has_media = EXCLUDED.has_media,
    has_url = EXCLUDED.has_url,
    updated_at = now();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-index messages on insert/update
DROP TRIGGER IF EXISTS trigger_index_message ON messages;
CREATE TRIGGER trigger_index_message
  AFTER INSERT OR UPDATE OF content, channel_id, conversation_id, user_id, is_deleted ON messages
  FOR EACH ROW
  EXECUTE FUNCTION index_message();

-- Trigger to remove from index on delete
CREATE OR REPLACE FUNCTION remove_message_from_index()
RETURNS trigger AS $$
BEGIN
  DELETE FROM message_search_index WHERE message_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_remove_message_index ON messages;
CREATE TRIGGER trigger_remove_message_index
  AFTER DELETE ON messages
  FOR EACH ROW
  EXECUTE FUNCTION remove_message_from_index();

-- Main search function
CREATE OR REPLACE FUNCTION search_messages(
  p_query text,
  p_channel_id uuid DEFAULT NULL,
  p_channel_ids uuid[] DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_conversation_id uuid DEFAULT NULL,
  p_server_id uuid DEFAULT NULL,
  p_has_media boolean DEFAULT NULL,
  p_has_url boolean DEFAULT NULL,
  p_from_date timestamptz DEFAULT NULL,
  p_to_date timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  message_id uuid,
  relevance real,
  content_text text,
  channel_id uuid,
  conversation_id uuid,
  user_id uuid,
  created_at timestamptz
) AS $$
DECLARE
  search_query text;
  tsquery_val tsquery;
BEGIN
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
         similarity(msi.content_text, search_query) * 0.3)::real
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
    -- Search conditions (only if query provided)
    (tsquery_val IS NULL OR 
     msi.content_tsvector @@ tsquery_val OR 
     similarity(msi.content_text, search_query) > 0.2)
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
    CASE WHEN tsquery_val IS NOT NULL THEN relevance ELSE 1.0 END DESC,
    msi.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$ LANGUAGE plpgsql STABLE;

