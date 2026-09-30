-- Message search indexer. The baseline ships index_message() as a no-op, so installs built from
-- it (staging, fresh self-hosts) never fill message_search_index and search_messages returns no
-- rows. Production runs the body below; it differs from production in one respect: encrypted
-- messages are indexed with empty text, since their content is a single ciphertext part.
--
-- Backfill indexes every live message missing from the index and blanks rows already holding
-- ciphertext.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.index_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
  content_text_val text;
  features jsonb;
  server_id_val uuid;
BEGIN
  IF NEW.is_deleted = true THEN
    DELETE FROM message_search_index WHERE message_id = NEW.id;
    RETURN NEW;
  END IF;

  IF NEW.encrypted = true THEN
    content_text_val := '';
  ELSE
    content_text_val := coalesce(extract_message_text(NEW.content), '');
  END IF;

  features := detect_message_features(NEW.content);

  server_id_val := NULL;
  IF NEW.channel_id IS NOT NULL THEN
    server_id_val := get_channel_server_id(NEW.channel_id);
  END IF;

  INSERT INTO message_search_index (
    message_id, content_text, content_tsvector, channel_id, conversation_id,
    user_id, server_id, has_media, has_url, created_at
  ) VALUES (
    NEW.id, content_text_val, to_tsvector('english', content_text_val), NEW.channel_id,
    NEW.conversation_id, NEW.user_id, server_id_val,
    (features->>'has_media')::boolean, (features->>'has_url')::boolean, NEW.created_at
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
$$;

REVOKE ALL ON FUNCTION public.index_message() FROM PUBLIC, anon, authenticated;

INSERT INTO public.message_search_index (
  message_id, content_text, content_tsvector, channel_id, conversation_id,
  user_id, server_id, has_media, has_url, created_at
)
SELECT
  m.id, t.txt, to_tsvector('english', t.txt), m.channel_id, m.conversation_id, m.user_id,
  CASE WHEN m.channel_id IS NOT NULL THEN public.get_channel_server_id(m.channel_id) END,
  (f.features->>'has_media')::boolean, (f.features->>'has_url')::boolean, m.created_at
FROM public.messages m
CROSS JOIN LATERAL (
  SELECT CASE WHEN m.encrypted THEN '' ELSE coalesce(public.extract_message_text(m.content), '') END AS txt
) t
CROSS JOIN LATERAL (SELECT public.detect_message_features(m.content) AS features) f
WHERE coalesce(m.is_deleted, false) = false
  AND NOT EXISTS (SELECT 1 FROM public.message_search_index i WHERE i.message_id = m.id)
ON CONFLICT (message_id) DO NOTHING;

UPDATE public.message_search_index i
SET content_text = '', content_tsvector = to_tsvector('english', ''), updated_at = now()
FROM public.messages m
WHERE m.id = i.message_id
  AND m.encrypted = true
  AND coalesce(i.content_text, '') <> '';

COMMIT;
