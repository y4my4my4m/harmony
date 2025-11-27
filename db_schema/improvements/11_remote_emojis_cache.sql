-- Remote Emojis Cache
-- Tracks all custom emojis we've encountered from remote instances
-- Enables an "emoji importer" feature for admins

-- Create the remote emojis cache table
CREATE TABLE IF NOT EXISTS public.remote_emojis_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Emoji identification
  shortcode text NOT NULL,              -- e.g., "kawa_yu" (without colons)
  origin_domain text NOT NULL,          -- e.g., "misskey.io"
  full_code text NOT NULL,              -- e.g., ":kawa_yu@misskey.io:" or ":suteki2@fedibird.com:"
  
  -- Emoji data
  url text NOT NULL,                    -- Full URL to the emoji image
  static_url text,                      -- Static (non-animated) version if available
  
  -- Tracking
  first_seen_at timestamptz DEFAULT now(),
  last_seen_at timestamptz DEFAULT now(),
  usage_count int DEFAULT 1,
  
  -- Import status (references the actual emojis table)
  imported_as uuid REFERENCES public.emojis(id) ON DELETE SET NULL,
  imported_at timestamptz,
  
  -- Metadata
  category text,                        -- Category if known from origin
  is_animated boolean DEFAULT false,
  
  -- Constraints
  UNIQUE(shortcode, origin_domain),
  
  -- Indexes for common queries
  created_at timestamptz DEFAULT now()
);

-- Index for admin queries (most used emojis)
CREATE INDEX IF NOT EXISTS idx_remote_emojis_usage ON public.remote_emojis_cache(usage_count DESC);

-- Index for domain filtering
CREATE INDEX IF NOT EXISTS idx_remote_emojis_domain ON public.remote_emojis_cache(origin_domain);

-- Index for import status
CREATE INDEX IF NOT EXISTS idx_remote_emojis_imported ON public.remote_emojis_cache(imported_as) WHERE imported_as IS NULL;

-- RLS Policies
ALTER TABLE public.remote_emojis_cache ENABLE ROW LEVEL SECURITY;

-- Everyone can read remote emojis (for display)
DROP POLICY IF EXISTS "Anyone can view remote emojis" ON public.remote_emojis_cache;
CREATE POLICY "Anyone can view remote emojis" ON public.remote_emojis_cache
  FOR SELECT USING (true);

-- Only service role can insert/update (federation backend)
DROP POLICY IF EXISTS "Service role can manage remote emojis" ON public.remote_emojis_cache;
CREATE POLICY "Service role can manage remote emojis" ON public.remote_emojis_cache
  FOR ALL USING (auth.role() = 'service_role');

-- Admins can update (for importing)
DROP POLICY IF EXISTS "Admins can update remote emojis" ON public.remote_emojis_cache;
CREATE POLICY "Admins can update remote emojis" ON public.remote_emojis_cache
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE id = auth.uid() AND is_admin = true
    )
  );

-- Function to upsert a remote emoji (called from federation backend)
CREATE OR REPLACE FUNCTION upsert_remote_emoji(
  p_shortcode text,
  p_origin_domain text,
  p_full_code text,
  p_url text,
  p_static_url text DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_is_animated boolean DEFAULT false
) RETURNS uuid AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.remote_emojis_cache (
    shortcode, origin_domain, full_code, url, static_url, category, is_animated
  ) VALUES (
    p_shortcode, p_origin_domain, p_full_code, p_url, p_static_url, p_category, p_is_animated
  )
  ON CONFLICT (shortcode, origin_domain) DO UPDATE SET
    url = EXCLUDED.url,
    static_url = COALESCE(EXCLUDED.static_url, remote_emojis_cache.static_url),
    last_seen_at = now(),
    usage_count = remote_emojis_cache.usage_count + 1,
    category = COALESCE(EXCLUDED.category, remote_emojis_cache.category),
    is_animated = COALESCE(EXCLUDED.is_animated, remote_emojis_cache.is_animated)
  RETURNING id INTO v_id;
  
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to import a remote emoji to local emojis table
CREATE OR REPLACE FUNCTION import_remote_emoji(
  p_remote_emoji_id uuid,
  p_new_name text DEFAULT NULL,  -- Optional: rename on import
  p_server_id uuid DEFAULT NULL  -- Optional: assign to a server
) RETURNS uuid AS $$
DECLARE
  v_remote remote_emojis_cache%ROWTYPE;
  v_new_id uuid;
  v_name text;
BEGIN
  -- Get the remote emoji
  SELECT * INTO v_remote FROM public.remote_emojis_cache WHERE id = p_remote_emoji_id;
  
  IF v_remote.id IS NULL THEN
    RAISE EXCEPTION 'Remote emoji not found';
  END IF;
  
  IF v_remote.imported_as IS NOT NULL THEN
    RAISE EXCEPTION 'Emoji already imported';
  END IF;
  
  -- Use provided name or original shortcode
  v_name := COALESCE(p_new_name, v_remote.shortcode);
  
  -- Check if name already exists locally (where domain is null = local emoji)
  IF EXISTS (SELECT 1 FROM public.emojis WHERE name = v_name AND domain IS NULL) THEN
    RAISE EXCEPTION 'Emoji name already exists locally: %', v_name;
  END IF;
  
  -- Create the local emoji
  INSERT INTO public.emojis (
    name,
    url,
    server_id,
    domain  -- NULL means it's now a local emoji
  ) VALUES (
    v_name,
    v_remote.url,
    p_server_id,
    NULL  -- Imported as local emoji
  ) RETURNING id INTO v_new_id;
  
  -- Update the remote emoji to mark as imported
  UPDATE public.remote_emojis_cache 
  SET imported_as = v_new_id, imported_at = now()
  WHERE id = p_remote_emoji_id;
  
  RETURN v_new_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant table permissions
GRANT SELECT ON public.remote_emojis_cache TO authenticated;
GRANT SELECT ON public.remote_emojis_cache TO anon;
GRANT ALL ON public.remote_emojis_cache TO service_role;

-- Grant execute on functions
GRANT EXECUTE ON FUNCTION upsert_remote_emoji TO authenticated;
GRANT EXECUTE ON FUNCTION upsert_remote_emoji TO service_role;
GRANT EXECUTE ON FUNCTION import_remote_emoji TO authenticated;

COMMENT ON TABLE public.remote_emojis_cache IS 'Cache of custom emojis encountered from remote instances. Used for the emoji importer feature.';
COMMENT ON FUNCTION upsert_remote_emoji IS 'Insert or update a remote emoji, incrementing usage count on conflict.';
COMMENT ON FUNCTION import_remote_emoji IS 'Import a remote emoji to local emojis table.';

