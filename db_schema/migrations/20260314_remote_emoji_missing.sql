BEGIN;

-- 1. upsert_remote_emoji function (used by federation backend)
CREATE OR REPLACE FUNCTION public.upsert_remote_emoji(
    p_shortcode text,
    p_origin_domain text,
    p_full_code text,
    p_url text,
    p_static_url text DEFAULT NULL,
    p_category text DEFAULT NULL,
    p_is_animated boolean DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.remote_emojis_cache (
    shortcode, origin_domain, full_code, url, static_url, category, is_animated
  ) VALUES (
    p_shortcode, p_origin_domain, p_full_code, p_url, p_static_url, p_category, COALESCE(p_is_animated, false)
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
$$;

COMMENT ON FUNCTION public.upsert_remote_emoji(text, text, text, text, text, text, boolean)
IS 'Insert or update a remote emoji, incrementing usage count on conflict.';

-- 2. Service role RLS policy for remote_emojis_cache
DROP POLICY IF EXISTS "Service role can manage remote emojis" ON public.remote_emojis_cache;
CREATE POLICY "Service role can manage remote emojis" ON public.remote_emojis_cache
    USING (auth.role() = 'service_role');

-- 3. Partial index for unimported remote emojis (speeds up importer UI)
CREATE INDEX IF NOT EXISTS idx_remote_emojis_imported
    ON public.remote_emojis_cache USING btree (imported_as)
    WHERE (imported_as IS NULL);

-- 4. GRANTs
GRANT EXECUTE ON FUNCTION public.upsert_remote_emoji(text, text, text, text, text, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.import_remote_emoji(uuid, text, uuid) TO authenticated;

COMMIT;
