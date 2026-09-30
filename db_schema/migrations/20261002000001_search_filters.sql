-- Discord-style search filters: from, mentions, has, in, before/after/during, pinned.
--
-- message_search_index gains the columns the filters read:
--   has_image, has_video, has_audio   a file part of that kind
--   has_embed                         an embed part, or link previews in metadata.embeds
--   is_pinned                         messages.is_pinned
--   mentioned_user_ids                userId of every mention part
-- has:file reads has_media (any file part), has:link reads has_url. An encrypted message is
-- indexed with empty text and no content flags, since its content is one ciphertext part;
-- author, date and is_pinned still apply to it.
--
-- message_search_flags() derives the filter columns of one message and index_message_row()
-- writes its whole row; the trigger and the backfill share both. trigger_index_message now
-- also fires on is_pinned and metadata, and returns early when no indexed input changed.
--
-- search_messages keeps its twelve parameters with their meaning, and its first seven result
-- columns; every new parameter defaults to NULL. It becomes SECURITY DEFINER. Under RLS the
-- planner cannot use either GIN index, because tsvector @@ tsquery and array && are not
-- leakproof: every text search was a sequential scan. The function applies the rule the RLS
-- policies apply (20261001200002): a channel row when its channel is in
-- current_user_viewable_channel_ids(), a conversation row when the caller is a participant
-- who has not left.
--
-- Text matches through websearch_to_tsquery('english'): words and their stems, "quoted
-- phrases", or, -exclusion. A query yielding no lexeme (stop words only, symbols) or holding
-- CJK text, which the english parser does not segment, matches as a case-insensitive
-- substring. The trigram similarity branch is dropped; it forced a sequential scan.
--
-- Filter values are computed before any lock above ACCESS SHARE. From the LOCK TABLE to
-- COMMIT, writes to messages wait; reads do not. Seeded local DB with production's index set,
-- supabase/postgres 15.8.1.060:
--                      precompute (no lock)   locked section
--   13k messages             239 ms               160 ms
--   220k messages          3,731 ms             1,893 ms
--
-- search_messages on the 220k DB as a member of a 150k-message server with two hidden
-- channels, 25-row page plus count, best of six, ms, before -> after:
--   text in a server                    1,189 -> 1.7
--   text, no scope                      1,575 -> 1.6
--   in:#channel + text                     49 -> 1.3
--   before:date                            67 -> 1.7
--   page 21 of a filter-only search        91 -> 1.7
--   has:image / has:sound / pinned:true     - -> 2.1 / 0.5 / 0.4
--   from:user / mentions:user              - -> 0.5 / 0.4
-- A stop-word-only query falls back to ILIKE and takes 34 ms.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Derivation
-- ---------------------------------------------------------------------------

-- Keys: has_media, has_url, has_image, has_video, has_audio, has_embed, mentioned_user_ids.
-- A file part's kind is its fileType ('image', 'video', 'audio', 'file') or the type half of
-- a MIME type. Parts typed 'image', 'video' or 'audio' count as media of that kind.
-- plpgsql: the equivalent SQL body with jsonb_agg(DISTINCT) costs twice as much per row.
CREATE OR REPLACE FUNCTION public.detect_message_features(content_parts jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
    part jsonb;
    v_type text;
    v_kind text;
    v_media boolean := false;
    v_url boolean := false;
    v_image boolean := false;
    v_video boolean := false;
    v_audio boolean := false;
    v_embed boolean := false;
    v_mentions jsonb := '[]'::jsonb;
BEGIN
    IF jsonb_typeof(content_parts) IS DISTINCT FROM 'array' THEN
        content_parts := '[]'::jsonb;
    END IF;

    FOR part IN SELECT jsonb_array_elements(content_parts) LOOP
        v_type := part->>'type';
        IF v_type IN ('file', 'image', 'video', 'audio') THEN
            v_media := true;
            v_kind := CASE WHEN v_type = 'file'
                           THEN lower(split_part(coalesce(part->>'fileType', ''), '/', 1))
                           ELSE v_type END;
            v_image := v_image OR v_kind = 'image';
            v_video := v_video OR v_kind = 'video';
            v_audio := v_audio OR v_kind = 'audio';
        ELSIF v_type = 'url' THEN
            v_url := true;
        ELSIF v_type = 'embed' THEN
            v_embed := true;
        ELSIF v_type = 'mention'
              AND part->>'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              AND NOT v_mentions @> jsonb_build_array(part->'userId') THEN
            v_mentions := v_mentions || jsonb_build_array(part->'userId');
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'has_media', v_media, 'has_url', v_url, 'has_image', v_image, 'has_video', v_video,
        'has_audio', v_audio, 'has_embed', v_embed, 'mentioned_user_ids', v_mentions);
END;
$$;

REVOKE ALL ON FUNCTION public.detect_message_features(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.detect_message_features(jsonb) TO postgres, service_role;

-- Filter columns of one message. Encrypted content yields no content flags. plpgsql: as a
-- SQL function called per row from a lateral join it measured 440 us a row, against 8 us.
CREATE OR REPLACE FUNCTION public.message_search_flags(
    p_message public.messages,
    OUT has_media boolean,
    OUT has_url boolean,
    OUT has_image boolean,
    OUT has_video boolean,
    OUT has_audio boolean,
    OUT has_embed boolean,
    OUT is_pinned boolean,
    OUT mentioned_user_ids uuid[]
)
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
    f jsonb := '{}'::jsonb;
BEGIN
    IF p_message.encrypted IS NOT TRUE THEN
        f := detect_message_features(p_message.content);
    END IF;

    has_media := coalesce((f->>'has_media')::boolean, false);
    has_url := coalesce((f->>'has_url')::boolean, false);
    has_image := coalesce((f->>'has_image')::boolean, false);
    has_video := coalesce((f->>'has_video')::boolean, false);
    has_audio := coalesce((f->>'has_audio')::boolean, false);
    has_embed := p_message.encrypted IS NOT TRUE
        AND (coalesce((f->>'has_embed')::boolean, false)
             OR coalesce(jsonb_typeof(p_message.metadata->'embeds') = 'object'
                         AND p_message.metadata->'embeds' <> '{}'::jsonb, false));
    is_pinned := coalesce(p_message.is_pinned, false);
    mentioned_user_ids := ARRAY(
        SELECT jsonb_array_elements_text(coalesce(f->'mentioned_user_ids', '[]'::jsonb))::uuid);
END;
$$;

REVOKE ALL ON FUNCTION public.message_search_flags(public.messages) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.message_search_flags(public.messages) TO postgres, service_role;

-- Filter columns of every indexed message, read under ACCESS SHARE. xmin names the message
-- version they came from.
CREATE TEMP TABLE search_filter_backfill ON COMMIT DROP AS
SELECT m.id AS message_id, m.xmin AS message_xmin, f.*
  FROM public.messages m
  JOIN public.message_search_index i ON i.message_id = m.id
 CROSS JOIN LATERAL public.message_search_flags(m) f;

CREATE UNIQUE INDEX ON search_filter_backfill (message_id);
ANALYZE search_filter_backfill;

-- Writers to messages finish or wait from here to COMMIT: nothing changes between the
-- catch-up below and the new trigger. Reads proceed.
LOCK TABLE public.messages IN SHARE ROW EXCLUSIVE MODE;

-- ---------------------------------------------------------------------------
-- Columns. Constant defaults, so no table rewrite.
-- ---------------------------------------------------------------------------

ALTER TABLE public.message_search_index
    ADD COLUMN IF NOT EXISTS has_image boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS has_video boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS has_audio boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS has_embed boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS is_pinned boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS mentioned_user_ids uuid[] NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------
-- Indexer
-- ---------------------------------------------------------------------------

-- Upserts one message's index row; deletes it once the message is soft-deleted.
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
        v_text := coalesce(extract_message_text(p_message.content), '');
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

CREATE OR REPLACE FUNCTION public.index_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND NEW.content IS NOT DISTINCT FROM OLD.content
       AND NEW.channel_id IS NOT DISTINCT FROM OLD.channel_id
       AND NEW.conversation_id IS NOT DISTINCT FROM OLD.conversation_id
       AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
       AND NEW.is_deleted IS NOT DISTINCT FROM OLD.is_deleted
       AND NEW.is_pinned IS NOT DISTINCT FROM OLD.is_pinned
       AND (NEW.metadata->'embeds') IS NOT DISTINCT FROM (OLD.metadata->'embeds') THEN
        RETURN NEW;
    END IF;

    PERFORM index_message_row(NEW);
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.index_message() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------

-- A row whose flags all hold their defaults is left as it is; most rows are.
UPDATE public.message_search_index i
   SET has_media = b.has_media,
       has_url = b.has_url,
       has_image = b.has_image,
       has_video = b.has_video,
       has_audio = b.has_audio,
       has_embed = b.has_embed,
       is_pinned = b.is_pinned,
       mentioned_user_ids = b.mentioned_user_ids
  FROM search_filter_backfill b
 WHERE b.message_id = i.message_id
   AND (i.has_media, i.has_url, i.has_image, i.has_video, i.has_audio, i.has_embed, i.is_pinned,
        i.mentioned_user_ids)
       IS DISTINCT FROM
       (b.has_media, b.has_url, b.has_image, b.has_video, b.has_audio, b.has_embed, b.is_pinned,
        b.mentioned_user_ids);

-- Messages written between the snapshot above and the lock. The updated rows' tsvector
-- entries sit in the GIN pending list, which every text search scans until a vacuum: 35k
-- pending rows took a 220k-row search from 0.5 to 3 ms.
DO $$
BEGIN
    PERFORM public.index_message_row(m)
       FROM public.messages m
       JOIN public.message_search_index i ON i.message_id = m.id
       LEFT JOIN search_filter_backfill b ON b.message_id = m.id
      WHERE b.message_id IS NULL OR b.message_xmin <> m.xmin;

    IF to_regclass('public.idx_message_search_tsvector') IS NOT NULL THEN
        PERFORM gin_clean_pending_list('public.idx_message_search_tsvector'::regclass);
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Indexes. Two names match production's existing indexes of the same definition.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_message_search_server_date
    ON public.message_search_index (server_id, created_at DESC) WHERE server_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_search_channel_date
    ON public.message_search_index (channel_id, created_at DESC) WHERE channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_search_conversation_date
    ON public.message_search_index (conversation_id, created_at DESC) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_search_user_date
    ON public.message_search_index (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_search_mentions
    ON public.message_search_index USING gin (mentioned_user_ids) WHERE mentioned_user_ids <> '{}';
CREATE INDEX IF NOT EXISTS idx_message_search_pinned
    ON public.message_search_index (server_id, created_at DESC) WHERE is_pinned;

-- has: within a server. A conversation is small enough for its date index and a filter.
CREATE INDEX IF NOT EXISTS idx_message_search_server_media
    ON public.message_search_index (server_id, created_at DESC) WHERE has_media;
CREATE INDEX IF NOT EXISTS idx_message_search_server_url
    ON public.message_search_index (server_id, created_at DESC) WHERE has_url;
CREATE INDEX IF NOT EXISTS idx_message_search_server_image
    ON public.message_search_index (server_id, created_at DESC) WHERE has_image;
CREATE INDEX IF NOT EXISTS idx_message_search_server_video
    ON public.message_search_index (server_id, created_at DESC) WHERE has_video;
CREATE INDEX IF NOT EXISTS idx_message_search_server_audio
    ON public.message_search_index (server_id, created_at DESC) WHERE has_audio;
CREATE INDEX IF NOT EXISTS idx_message_search_server_embed
    ON public.message_search_index (server_id, created_at DESC) WHERE has_embed;

ANALYZE public.message_search_index (has_media, has_url, has_image, has_video, has_audio, has_embed,
    is_pinned, mentioned_user_ids);

CREATE OR REPLACE TRIGGER trigger_index_message
    AFTER INSERT OR UPDATE OF content, channel_id, conversation_id, user_id, is_deleted, is_pinned, metadata
    ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.index_message();

-- ---------------------------------------------------------------------------
-- search_messages
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.search_messages(text, uuid, uuid[], uuid, uuid, uuid, boolean, boolean,
    timestamp with time zone, timestamp with time zone, integer, integer);

-- Filters combine with AND. p_user_id and p_user_ids, and the entries of each array, combine
-- with OR, as do the entries of p_mentioned_user_ids. p_from_date and p_to_date bound
-- created_at inclusively. p_sort is 'newest', 'oldest' or 'relevance'; NULL is relevance with
-- a query and newest without. With p_with_total, total_count is the match count up to
-- 10,000, and 10,001 for more; otherwise NULL. The cap bounds the count of a broad filter to
-- the rows a page 400 deep reads.
CREATE FUNCTION public.search_messages(
    p_query text DEFAULT NULL,
    p_channel_id uuid DEFAULT NULL,
    p_channel_ids uuid[] DEFAULT NULL,
    p_user_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL,
    p_server_id uuid DEFAULT NULL,
    p_has_media boolean DEFAULT NULL,
    p_has_url boolean DEFAULT NULL,
    p_from_date timestamp with time zone DEFAULT NULL,
    p_to_date timestamp with time zone DEFAULT NULL,
    p_limit integer DEFAULT 50,
    p_offset integer DEFAULT 0,
    p_user_ids uuid[] DEFAULT NULL,
    p_mentioned_user_ids uuid[] DEFAULT NULL,
    p_has_image boolean DEFAULT NULL,
    p_has_video boolean DEFAULT NULL,
    p_has_audio boolean DEFAULT NULL,
    p_has_embed boolean DEFAULT NULL,
    p_pinned boolean DEFAULT NULL,
    p_sort text DEFAULT NULL,
    p_with_total boolean DEFAULT false
)
RETURNS TABLE(
    message_id uuid,
    relevance real,
    content_text text,
    channel_id uuid,
    conversation_id uuid,
    user_id uuid,
    created_at timestamp with time zone,
    server_id uuid,
    total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := get_current_user_profile_id();
    v_query text := nullif(btrim(p_query), '');
    v_tsq tsquery;
    v_pattern text;
    v_channels uuid[] := '{}';
    v_conversations uuid[] := '{}';
    v_users uuid[];
    v_sort text;
    v_where text;
    v_order text;
    v_rank text := '1';
    v_total bigint;
BEGIN
    IF v_me IS NULL THEN
        RETURN;
    END IF;

    -- Visible rows: the RLS rule of message_search_index, narrowed by the scope parameters.
    IF p_conversation_id IS NULL THEN
        v_channels := ARRAY(
            SELECT v.id
              FROM current_user_viewable_channel_ids() v(id)
             WHERE (p_channel_id IS NULL OR v.id = p_channel_id)
               AND (p_channel_ids IS NULL OR v.id = ANY (p_channel_ids))
               AND (p_server_id IS NULL
                    OR EXISTS (SELECT 1 FROM channels c WHERE c.id = v.id AND c.server_id = p_server_id)));
    END IF;
    IF p_server_id IS NULL AND p_channel_id IS NULL AND p_channel_ids IS NULL THEN
        v_conversations := ARRAY(
            SELECT cp.conversation_id
              FROM conversation_participants cp
             WHERE cp.user_id = v_me
               AND cp.left_at IS NULL
               AND (p_conversation_id IS NULL OR cp.conversation_id = p_conversation_id));
    END IF;

    IF cardinality(v_channels) = 0 AND cardinality(v_conversations) = 0 THEN
        RETURN;
    END IF;

    -- A single channel, server or conversation leads with its (…, created_at) index.
    IF cardinality(v_conversations) = 0 AND cardinality(v_channels) = 1
       AND (p_channel_id IS NOT NULL OR p_channel_ids IS NOT NULL) THEN
        v_where := 'i.channel_id = ($1)[1]';
    ELSIF cardinality(v_conversations) = 0 AND p_server_id IS NOT NULL THEN
        v_where := 'i.server_id = $3 AND i.channel_id = ANY ($1)';
    ELSIF cardinality(v_conversations) = 0 THEN
        v_where := 'i.channel_id = ANY ($1)';
    ELSIF cardinality(v_channels) = 0 AND p_conversation_id IS NOT NULL THEN
        v_where := 'i.conversation_id = $4';
    ELSIF cardinality(v_channels) = 0 THEN
        v_where := 'i.conversation_id = ANY ($2)';
    ELSE
        v_where := '(i.channel_id = ANY ($1) OR i.conversation_id = ANY ($2))';
    END IF;

    IF v_query IS NOT NULL THEN
        IF v_query !~ '[぀-ヿ㐀-鿿가-힯]' THEN
            v_tsq := websearch_to_tsquery('english', v_query);
            IF numnode(v_tsq) = 0 THEN
                v_tsq := NULL;
            END IF;
        END IF;
        IF v_tsq IS NOT NULL THEN
            v_where := v_where || ' AND i.content_tsvector @@ $5';
            v_rank := 'ts_rank(i.content_tsvector, $5)';
        ELSE
            v_pattern := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';
            v_where := v_where || ' AND i.content_text ILIKE $6';
        END IF;
    END IF;

    v_users := CASE
        WHEN p_user_id IS NULL THEN p_user_ids
        ELSE array_append(coalesce(p_user_ids, '{}'), p_user_id)
    END;
    IF v_users IS NOT NULL THEN
        v_where := v_where || CASE WHEN cardinality(v_users) = 1
                                   THEN ' AND i.user_id = ($7)[1]'
                                   ELSE ' AND i.user_id = ANY ($7)' END;
    END IF;
    -- The second clause matches the partial GIN index's predicate.
    IF p_mentioned_user_ids IS NOT NULL THEN
        v_where := v_where || ' AND i.mentioned_user_ids && $8 AND i.mentioned_user_ids <> ''{}''';
    END IF;
    IF p_from_date IS NOT NULL THEN
        v_where := v_where || ' AND i.created_at >= $9';
    END IF;
    IF p_to_date IS NOT NULL THEN
        v_where := v_where || ' AND i.created_at <= $10';
    END IF;

    -- Flags are spelled as bare columns so the planner can match a partial index.
    v_where := v_where
        || CASE p_has_media WHEN true THEN ' AND i.has_media' WHEN false THEN ' AND NOT i.has_media' ELSE '' END
        || CASE p_has_url   WHEN true THEN ' AND i.has_url'   WHEN false THEN ' AND NOT i.has_url'   ELSE '' END
        || CASE p_has_image WHEN true THEN ' AND i.has_image' WHEN false THEN ' AND NOT i.has_image' ELSE '' END
        || CASE p_has_video WHEN true THEN ' AND i.has_video' WHEN false THEN ' AND NOT i.has_video' ELSE '' END
        || CASE p_has_audio WHEN true THEN ' AND i.has_audio' WHEN false THEN ' AND NOT i.has_audio' ELSE '' END
        || CASE p_has_embed WHEN true THEN ' AND i.has_embed' WHEN false THEN ' AND NOT i.has_embed' ELSE '' END
        || CASE p_pinned    WHEN true THEN ' AND i.is_pinned' WHEN false THEN ' AND NOT i.is_pinned' ELSE '' END;

    v_sort := coalesce(p_sort, CASE WHEN v_tsq IS NOT NULL THEN 'relevance' ELSE 'newest' END);
    v_order := CASE
        WHEN v_sort = 'oldest' THEN 'i.created_at, i.message_id'
        WHEN v_sort = 'relevance' AND v_tsq IS NOT NULL THEN v_rank || ' DESC, i.created_at DESC, i.message_id DESC'
        ELSE 'i.created_at DESC, i.message_id DESC'
    END;

    IF p_with_total THEN
        EXECUTE 'SELECT count(*) FROM (SELECT 1 FROM message_search_index i WHERE ' || v_where
                || ' LIMIT 10001) s'
           INTO v_total
          USING v_channels, v_conversations, p_server_id, p_conversation_id, v_tsq, v_pattern,
                v_users, p_mentioned_user_ids, p_from_date, p_to_date;
    END IF;

    RETURN QUERY EXECUTE
        'SELECT i.message_id, (' || v_rank || ')::real, i.content_text, i.channel_id,'
        || ' i.conversation_id, i.user_id, i.created_at, i.server_id, $11'
        || ' FROM message_search_index i WHERE ' || v_where
        || ' ORDER BY ' || v_order
        || ' LIMIT $12 OFFSET $13'
      USING v_channels, v_conversations, p_server_id, p_conversation_id, v_tsq, v_pattern,
            v_users, p_mentioned_user_ids, p_from_date, p_to_date, v_total,
            least(greatest(coalesce(p_limit, 50), 1), 201), greatest(coalesce(p_offset, 0), 0);
END;
$$;

REVOKE ALL ON FUNCTION public.search_messages(text, uuid, uuid[], uuid, uuid, uuid, boolean, boolean,
    timestamp with time zone, timestamp with time zone, integer, integer, uuid[], uuid[], boolean,
    boolean, boolean, boolean, boolean, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_messages(text, uuid, uuid[], uuid, uuid, uuid, boolean, boolean,
    timestamp with time zone, timestamp with time zone, integer, integer, uuid[], uuid[], boolean,
    boolean, boolean, boolean, boolean, text, boolean) TO authenticated, service_role;

COMMIT;
