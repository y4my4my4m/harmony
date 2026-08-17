-- Migration: Add image/apng support to all image storage buckets
-- Also adds image/svg+xml and image/jpeg to emojis bucket

BEGIN;

UPDATE storage.buckets
SET allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/apng']
WHERE id = 'avatars';

UPDATE storage.buckets
SET allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/apng']
WHERE id = 'banners';

UPDATE storage.buckets
SET allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/apng']
WHERE id = 'server_icons';

UPDATE storage.buckets
SET allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/apng']
WHERE id = 'server_banners';

UPDATE storage.buckets
SET allowed_mime_types = ARRAY['image/png', 'image/gif', 'image/webp', 'image/apng', 'image/svg+xml', 'image/jpeg']
WHERE id = 'emojis';

COMMIT;
