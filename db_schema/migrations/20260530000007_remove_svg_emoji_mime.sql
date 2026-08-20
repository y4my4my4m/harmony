-- =============================================================================
-- Remove SVG from the emojis storage bucket (XSS hardening)
-- =============================================================================
-- User-uploaded SVGs are an XSS vector: they can embed <script> tags, inline
-- event handlers, <foreignObject>, and external references. Even when rendered
-- via <img>, a direct hit on the storage URL renders the SVG in the storage
-- origin and executes embedded script. Emoji have no need for SVG, so we
-- restrict the bucket to raster formats only.
--
-- Existing SVG emoji rows/objects are left in place (this only blocks NEW
-- uploads). Remove them manually if you want them gone.
-- =============================================================================

BEGIN;

UPDATE storage.buckets
SET allowed_mime_types = ARRAY['image/png', 'image/gif', 'image/webp', 'image/apng', 'image/jpeg']
WHERE id = 'emojis';

COMMIT;
