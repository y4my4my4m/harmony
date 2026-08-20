-- =============================================================================
-- Expose public storage bucket metadata to clients
-- =============================================================================
-- The `public = true` flag on a bucket only makes its OBJECTS downloadable; it
-- does NOT grant SELECT on the bucket's own row in storage.buckets (where
-- file_size_limit / allowed_mime_types live). That row is RLS-gated separately,
-- so supabase.storage.getBucket() comes back empty for normal authenticated
-- users and the frontend can't surface accurate per-instance upload limits.
--
-- This adds a minimal SELECT policy exposing metadata for PUBLIC buckets only.
-- All exposed columns (id, public, file_size_limit, allowed_mime_types) are
-- non-sensitive. No SECURITY DEFINER RPC required.
-- =============================================================================

BEGIN;

ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public buckets metadata is readable" ON storage.buckets;
CREATE POLICY "Public buckets metadata is readable"
    ON storage.buckets FOR SELECT
    USING (public = true);

COMMIT;
