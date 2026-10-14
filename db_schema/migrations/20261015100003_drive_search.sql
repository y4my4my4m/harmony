-- Message search matches attachment names. index_message_row (20261002000001) indexes the text
-- of an unencrypted message followed by the fileName of each file part, once as written and
-- once with dots, dashes and underscores as spaces (the parser keeps 'a-b.pdf' as one token);
-- content_text carries the same string. Previews keep using extract_message_text, which names no files.
--
-- Existing messages with named attachments are indexed again.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.message_file_names(p_content jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT coalesce(string_agg(btrim(e ->> 'fileName') || ' '
                               || regexp_replace(btrim(e ->> 'fileName'), '[._-]+', ' ', 'g'), ' '), '')
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_content) = 'array' THEN p_content ELSE '[]'::jsonb END) e
     WHERE jsonb_typeof(e) = 'object'
       AND e ->> 'type' = 'file'
       AND btrim(coalesce(e ->> 'fileName', '')) <> '';
$$;

CREATE OR REPLACE FUNCTION public.index_message_row(p_message public.messages)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
    v_text text;
BEGIN
    IF p_message.is_deleted = true THEN
        DELETE FROM message_search_index WHERE message_id = p_message.id;
        RETURN;
    END IF;

    IF p_message.encrypted = true THEN
        v_text := '';
    ELSE
        v_text := btrim(coalesce(extract_message_text(p_message.content), '') || ' '
                        || message_file_names(p_message.content));
    END IF;

    INSERT INTO message_search_index (
        message_id, content_text, content_tsvector, channel_id, conversation_id, user_id,
        server_id, has_media, has_url, has_image, has_video, has_audio, has_embed, is_pinned,
        mentioned_user_ids, created_at
    )
    SELECT p_message.id, v_text, to_tsvector('english', v_text), p_message.channel_id,
           p_message.conversation_id, p_message.user_id,
           CASE WHEN p_message.channel_id IS NOT NULL
                THEN get_channel_server_id(p_message.channel_id) END,
           f.has_media, f.has_url, f.has_image, f.has_video, f.has_audio, f.has_embed,
           f.is_pinned, f.mentioned_user_ids, p_message.created_at
      FROM message_search_flags(p_message) f
    ON CONFLICT (message_id) DO UPDATE SET
        content_text = EXCLUDED.content_text,
        content_tsvector = EXCLUDED.content_tsvector,
        channel_id = EXCLUDED.channel_id,
        conversation_id = EXCLUDED.conversation_id,
        user_id = EXCLUDED.user_id,
        server_id = EXCLUDED.server_id,
        has_media = EXCLUDED.has_media,
        has_url = EXCLUDED.has_url,
        has_image = EXCLUDED.has_image,
        has_video = EXCLUDED.has_video,
        has_audio = EXCLUDED.has_audio,
        has_embed = EXCLUDED.has_embed,
        is_pinned = EXCLUDED.is_pinned,
        mentioned_user_ids = EXCLUDED.mentioned_user_ids,
        updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.index_message_row(public.messages) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.index_message_row(public.messages) TO postgres, service_role;
REVOKE ALL ON FUNCTION public.message_file_names(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.message_file_names(jsonb) TO postgres, service_role;

SELECT public.index_message_row(m)
  FROM public.messages m
 WHERE m.encrypted IS NOT TRUE
   AND m.is_deleted IS NOT TRUE
   AND public.message_file_names(m.content) <> '';

COMMIT;
