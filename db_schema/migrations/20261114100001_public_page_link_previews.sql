-- Public pages show a post's link previews: public_page_post returns the previews stored in
-- posts.metadata.embeds (one LinkPreviewService payload per URL, written when the post is created,
-- edited or fetched from its origin) as `embeds`, an empty object when there are none. Nothing is
-- fetched for a visitor.
--
-- Signature and grants unchanged. Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.public_page_post(p_post_id uuid, p_depth integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_post public.posts%ROWTYPE;
    v_author jsonb;
    v_quote jsonb;
    v_parent public.posts%ROWTYPE;
    v_parent_author jsonb;
    v_reply_to jsonb;
    v_meta jsonb;
BEGIN
    SELECT * INTO v_post FROM public.posts WHERE id = p_post_id;
    IF NOT FOUND
       OR v_post.is_deleted IS TRUE
       OR v_post.visibility IS DISTINCT FROM 'public' AND v_post.visibility IS DISTINCT FROM 'unlisted' THEN
        RETURN NULL;
    END IF;
    v_meta := COALESCE(v_post.metadata, '{}'::jsonb);
    IF NULLIF(v_meta ->> 'reblog_of', '') IS NOT NULL AND COALESCE(v_meta ->> 'is_quote', '') <> 'true' THEN
        RETURN NULL;
    END IF;
    v_author := public.public_page_account(v_post.author_id);
    IF v_author IS NULL THEN
        RETURN NULL;
    END IF;

    IF p_depth > 0 THEN
        IF v_meta ->> 'is_quote' = 'true' AND v_meta ->> 'reblog_of' ~ '^[0-9a-fA-F-]{36}$' THEN
            v_quote := public.public_page_post((v_meta ->> 'reblog_of')::uuid, p_depth - 1);
        END IF;
        IF v_post.in_reply_to IS NOT NULL THEN
            SELECT * INTO v_parent FROM public.posts WHERE id = v_post.in_reply_to;
            IF FOUND AND v_parent.is_deleted IS NOT TRUE AND v_parent.visibility IN ('public', 'unlisted') THEN
                v_parent_author := public.public_page_account(v_parent.author_id);
                IF v_parent_author IS NOT NULL THEN
                    v_reply_to := jsonb_build_object(
                        'id', v_parent.id,
                        'url', COALESCE(NULLIF(v_parent.url, ''), v_parent.ap_id),
                        'is_local', v_parent.is_local IS NOT FALSE,
                        'author', v_parent_author);
                END IF;
            END IF;
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'id', v_post.id,
        'created_at', v_post.created_at,
        'edited_at', CASE WHEN jsonb_typeof(v_post.edit_history) = 'array'
                               AND jsonb_array_length(v_post.edit_history) > 0
                          THEN v_post.updated_at END,
        'content', v_post.content,
        'content_warning', v_post.content_warning,
        'visibility', v_post.visibility,
        'language', v_post.language,
        'is_sensitive', v_post.is_sensitive IS TRUE,
        'is_local', v_post.is_local IS NOT FALSE,
        'is_pinned', v_post.is_pinned IS TRUE,
        'url', NULLIF(v_post.url, ''),
        'ap_id', v_post.ap_id,
        'media_attachments', COALESCE(v_post.media_attachments, '[]'::jsonb),
        'embeds', CASE WHEN jsonb_typeof(v_meta -> 'embeds') = 'object' THEN v_meta -> 'embeds' ELSE '{}'::jsonb END,
        'replies_count', COALESCE(v_post.replies_count, 0),
        'reblogs_count', COALESCE(v_post.reblogs_count, 0),
        'favorites_count', COALESCE(v_post.favorites_count, 0),
        'poll', CASE WHEN v_meta ->> 'is_poll' = 'true' AND jsonb_typeof(v_meta -> 'poll_options') = 'array'
                     THEN jsonb_build_object(
                              'options', v_meta -> 'poll_options',
                              'multiple', v_meta ->> 'poll_multiple_choice' = 'true',
                              'end_time', v_meta ->> 'poll_end_time',
                              'voters_count', v_meta -> 'poll_voters_count',
                              'closed', v_meta ->> 'poll_closed' = 'true') END,
        'is_quote', v_meta ->> 'is_quote' = 'true',
        'quote', v_quote,
        'reply_to', v_reply_to,
        'author', v_author);
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
