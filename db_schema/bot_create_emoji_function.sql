-- Create a function to allow bots to create federated emojis
-- This runs with SECURITY DEFINER to bypass RLS

CREATE OR REPLACE FUNCTION create_federated_emoji(
  p_name TEXT,
  p_url TEXT,
  p_uploader UUID,
  p_domain TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  created_at TIMESTAMPTZ,
  name VARCHAR,
  url VARCHAR,
  server_id UUID,
  uploader UUID,
  updated_at TIMESTAMPTZ,
  usage_count INTEGER,
  last_used TIMESTAMPTZ,
  domain TEXT
)
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
  -- Check if emoji already exists by URL
  RETURN QUERY
  SELECT e.* FROM emojis e
  WHERE e.url = p_url
  LIMIT 1;
  
  -- If found, return it
  IF FOUND THEN
    RETURN;
  END IF;
  
  -- Otherwise, create new emoji
  -- For federated emojis created by bots, uploader is NULL since bots aren't profiles
  RETURN QUERY
  INSERT INTO emojis (name, url, server_id, uploader, domain)
  VALUES (p_name, p_url, NULL, NULL, p_domain)
  RETURNING emojis.*;
END;
$$;

-- Grant execute permission to authenticated users (bots)
GRANT EXECUTE ON FUNCTION create_federated_emoji TO authenticated;

COMMENT ON FUNCTION create_federated_emoji IS 'Allows bots to create federated emojis (server_id = NULL, uploader = NULL). Checks for duplicates by URL.';

