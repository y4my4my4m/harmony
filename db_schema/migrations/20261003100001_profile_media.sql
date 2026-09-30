-- Profile media tab: a user's own posts carrying images or video, newest first.
--
-- Media lives in two places on a post row:
--   media_attachments   composer uploads {type 'Image'|'Video'|..., url, mediaType, name,
--                       description}; outbox imports {type, mediaType, url, name, width,
--                       height, blurhash}; Mastodon-API-shaped rows {type 'image'|'video'|
--                       'gifv', url, preview_url, description, meta}
--   content             inbox-delivered notes carry attachments as file parts only:
--                       {type 'file', fileType 'image'|'video'|'audio'|'file', url, mimeType,
--                       altText}
-- An attachment counts when its type is image, video or gifv (any case), its MIME type is
-- image/* or video/*, or it is an untyped Document whose URL ends in an image or video
-- extension. An attachment typed Audio never counts, whatever its MIME type. A content
-- part counts when it is a file part of fileType image or video.
--
-- Excluded: reblog rows (reblog IS NOT NULL; a boost copies the original's content, and a
-- quote's own content carries no attachments), soft-deleted rows, and direct posts, which
-- are not profile content. Visibility is otherwise left to posts_select_public: both
-- functions run SECURITY INVOKER, so followers-only posts reach accepted followers and the
-- author, and a block in either direction hides every row.
--
-- post_has_profile_media() is the index predicate. Redefining it leaves
-- idx_posts_author_media built against the old definition; a change drops and rebuilds the
-- index in the same migration.
--
-- Keyset pagination on (created_at, id). The index is ascending and read backwards.
-- visibility is INCLUDEd so count_profile_media answers from an index-only scan: the RLS
-- predicate reads author_id and visibility, and the partial predicate covers the rest.
--
-- Measured on supabase/postgres 15.8.1.060, 1M posts over 2000 authors plus one author with
-- 40k posts of which 10k carry media, warm cache, as an authenticated non-follower:
--   index build                     970 ms, 8.9 MB (posts heap 271 MB); 282 ms with the
--                                   predicate function inlined, which its SET clause prevents
--   first page of 30                0.5 ms
--   page with a cursor 6k rows in   0.25 ms; 4.1 ms with COALESCE(...) in the comparison,
--                                   which rescans and filters the 6k newer rows
--   count over 10k media posts      1.2-1.7 ms, index-only, no heap fetches
-- The build holds a SHARE lock that blocks writes to posts for its duration.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.post_has_profile_media(p_media_attachments jsonb, p_content jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT COALESCE(p_media_attachments @? '$[*] ? ((@.type like_regex "^(image|video|gifv)$" flag "i"
                        || @.mediaType starts with "image/" || @.mediaType starts with "video/"
                        || @.mime_type starts with "image/" || @.mime_type starts with "video/"
                        || (@.type like_regex "^(document|unknown)$" flag "i"
                            && @.url like_regex "\\.(jpe?g|png|gif|webp|avif|mp4|webm|mov|m4v)([?#]|$)" flag "i"))
                       && !(@.type like_regex "^audio$" flag "i"))', false)
        OR COALESCE(p_content @? '$[*] ? (@.type == "file" && (@.fileType == "image" || @.fileType == "video"))', false)
$$;

CREATE INDEX IF NOT EXISTS idx_posts_author_media
    ON public.posts (author_id, created_at, id) INCLUDE (visibility)
    WHERE is_deleted = false
      AND reblog IS NULL
      AND visibility <> 'direct'
      AND public.post_has_profile_media(media_attachments, content);

CREATE OR REPLACE FUNCTION public.get_profile_media(
    p_author_id uuid,
    p_limit integer DEFAULT 30,
    p_before_created_at timestamptz DEFAULT NULL,
    p_before_id uuid DEFAULT NULL
) RETURNS TABLE (
    id uuid,
    created_at timestamptz,
    visibility text,
    content_warning text,
    is_sensitive boolean,
    media_attachments jsonb,
    content_media jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    -- Under RLS a row comparison against COALESCE(...) is not promoted to an index
    -- condition; it runs as a filter after the policy and every page rescans from the
    -- newest row. Plain variables are promoted.
    v_before_created_at timestamptz := COALESCE(p_before_created_at, 'infinity'::timestamptz);
    v_before_id uuid := COALESCE(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid);
    v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 60);
BEGIN
    RETURN QUERY
    SELECT p.id,
           p.created_at,
           p.visibility,
           p.content_warning,
           COALESCE(p.is_sensitive, false),
           jsonb_path_query_array(p.media_attachments,
               '$[*] ? ((@.type like_regex "^(image|video|gifv)$" flag "i"
                        || @.mediaType starts with "image/" || @.mediaType starts with "video/"
                        || @.mime_type starts with "image/" || @.mime_type starts with "video/"
                        || (@.type like_regex "^(document|unknown)$" flag "i"
                            && @.url like_regex "\\.(jpe?g|png|gif|webp|avif|mp4|webm|mov|m4v)([?#]|$)" flag "i"))
                       && !(@.type like_regex "^audio$" flag "i"))'),
           jsonb_path_query_array(p.content,
               '$[*] ? (@.type == "file" && (@.fileType == "image" || @.fileType == "video"))')
      FROM public.posts p
     WHERE p.author_id = p_author_id
       AND p.is_deleted = false
       AND p.reblog IS NULL
       AND p.visibility <> 'direct'
       AND public.post_has_profile_media(p.media_attachments, p.content)
       AND (p.created_at, p.id) < (v_before_created_at, v_before_id)
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT v_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.count_profile_media(p_author_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
    SELECT count(*)::integer
      FROM public.posts p
     WHERE p.author_id = p_author_id
       AND p.is_deleted = false
       AND p.reblog IS NULL
       AND p.visibility <> 'direct'
       AND public.post_has_profile_media(p.media_attachments, p.content)
$$;

REVOKE ALL ON FUNCTION public.post_has_profile_media(jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_has_profile_media(jsonb, jsonb) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_profile_media(uuid, integer, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_profile_media(uuid, integer, timestamptz, uuid) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.count_profile_media(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.count_profile_media(uuid) TO anon, authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
