-- Public profile and post pages for visitors without a session: /@<username>,
-- /@<username>/<post id> and the HTML of /posts/<post id>, rendered by federation-backend
-- src/publicPages/.
--
-- instance_config public_profile_pages (public key; true unless set to false): whether those
-- pages show to visitors without a session. false sends them to sign in. ActivityPub reads,
-- link-preview cards and the REST API do not depend on it.
--
-- public_profile_page(p_username, p_before, p_limit) and public_post_page(p_post_id) are the
-- renderer's reads, service_role only. Both answer {enabled, instance, ...} for any input.
--
--   account    public_page_account: not deleted, suspended or silenced; a remote account of a
--              blocked instance is not one. The profile page takes local accounts only, the
--              username matched without case, the exact spelling first.
--   post       public_page_post: public or unlisted, not deleted, not a boost, its author an
--              account above. Followers-only and direct posts, chat and DMs never appear.
--              Depth 1 adds the quoted post (depth 0, same rules) and the post it replies to.
--   profile    pinned posts (at most 10, first page only), then the others newest first:
--              originals, quotes and replies to the account's own posts. Keyset on
--              (created_at, id) after p_before; p_limit 1-40, 20 when NULL. next is the last
--              post's id while more remain.
--   instance   name, icon and whether registration is open, from instance_config.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- instance_config public_profile_pages
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
    v_keys text[] := public.public_instance_config_keys();
BEGIN
    IF NOT ('public_profile_pages' = ANY (v_keys)) THEN
        EXECUTE format(
            'CREATE OR REPLACE FUNCTION public.public_instance_config_keys() RETURNS text[] '
            'LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS %L',
            format('SELECT %L::text[]', v_keys || 'public_profile_pages'::text));
    END IF;
END;
$do$;

INSERT INTO public.instance_config (config_key, config_value, description)
VALUES ('public_profile_pages', 'true'::jsonb,
        'Show profiles and public posts to visitors who are not signed in. Off sends them to sign in.')
ON CONFLICT (config_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Readers
-- ---------------------------------------------------------------------------

-- An account as the pages show it; NULL when it is not shown.
CREATE OR REPLACE FUNCTION public.public_page_account(p_profile_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
               'id', a.id,
               'username', a.username,
               'display_name', a.display_name,
               'avatar_url', a.avatar_url,
               'domain', a.domain,
               'is_local', a.is_local IS NOT FALSE,
               'federated_id', a.federated_id,
               'url', NULLIF(a.federation_metadata ->> 'url', ''),
               'discoverable', a.federation_discoverable IS NOT FALSE,
               'display_name_emojis', COALESCE(a.federation_metadata -> 'display_name_emojis', '[]'::jsonb))
      FROM public.profiles a
     WHERE a.id = p_profile_id
       AND a.username IS NOT NULL
       AND a.deleted_at IS NULL
       AND a.is_suspended IS NOT TRUE
       AND a.is_silenced IS NOT TRUE
       AND (a.is_local IS NOT FALSE
            OR NOT EXISTS (SELECT 1 FROM public.federated_instances fi
                            WHERE fi.is_blocked IS TRUE AND lower(fi.domain) = lower(a.domain)))
$$;

-- A post as the pages show it; NULL when it is not shown. p_depth 1 adds quote and reply_to.
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

CREATE OR REPLACE FUNCTION public.public_page_instance()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'enabled', COALESCE((SELECT lower(btrim(c.config_value #>> '{}', '" ')) <> 'false'
                               FROM public.instance_config c WHERE c.config_key = 'public_profile_pages'), true),
        'name', (SELECT NULLIF(btrim(c.config_value #>> '{}', '" '), '')
                   FROM public.instance_config c WHERE c.config_key = 'instance_name'),
        'icon', (SELECT NULLIF(btrim(c.config_value #>> '{}', '" '), '')
                   FROM public.instance_config c WHERE c.config_key = 'instance_icon'),
        'registrations_open', COALESCE((SELECT lower(btrim(c.config_value #>> '{}', '" ')) = 'true'
                                          FROM public.instance_config c WHERE c.config_key = 'open_registration'), true))
$$;

CREATE OR REPLACE FUNCTION public.public_profile_page(
    p_username text,
    p_before uuid DEFAULT NULL,
    p_limit integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_instance jsonb := public.public_page_instance();
    v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 40);
    v_profile public.profiles%ROWTYPE;
    v_account jsonb;
    v_cursor_at timestamptz;
    v_cursor_id uuid;
    v_pinned jsonb := '[]'::jsonb;
    v_posts jsonb := '[]'::jsonb;
    v_next uuid;
    v_count integer := 0;
    v_post jsonb;
    r record;
BEGIN
    SELECT * INTO v_profile
      FROM public.profiles p
     WHERE p.is_local IS NOT FALSE
       AND lower(p.username) = lower(btrim(p_username))
     ORDER BY (p.username = btrim(p_username)) DESC, p.created_at
     LIMIT 1;
    IF FOUND THEN
        v_account := public.public_page_account(v_profile.id);
    END IF;
    IF v_account IS NULL THEN
        RETURN jsonb_build_object('enabled', v_instance -> 'enabled', 'instance', v_instance, 'account', NULL);
    END IF;

    v_account := v_account || jsonb_build_object(
        'bio', v_profile.bio,
        'banner_url', v_profile.banner_url,
        'color', v_profile.color,
        'profile_fields', COALESCE(v_profile.profile_fields, '[]'::jsonb),
        'bio_emojis', COALESCE(v_profile.federation_metadata -> 'bio_emojis', '[]'::jsonb),
        'followers_count', COALESCE(v_profile.followers_count, 0),
        'following_count', COALESCE(v_profile.following_count, 0),
        'posts_count', COALESCE(v_profile.posts_count, 0),
        'created_at', v_profile.created_at,
        'locked', v_profile.manually_approves_followers IS TRUE,
        'moved_to_uri', NULLIF(v_profile.moved_to_uri, ''));

    IF p_before IS NOT NULL THEN
        SELECT created_at, id INTO v_cursor_at, v_cursor_id
          FROM public.posts WHERE id = p_before AND author_id = v_profile.id;
    ELSE
        FOR r IN
            SELECT id FROM public.posts
             WHERE author_id = v_profile.id AND is_pinned IS TRUE
               AND is_deleted IS NOT TRUE AND visibility IN ('public', 'unlisted')
             ORDER BY created_at DESC, id DESC
             LIMIT 10
        LOOP
            v_post := public.public_page_post(r.id, 1);
            IF v_post IS NOT NULL THEN
                v_pinned := v_pinned || jsonb_build_array(v_post);
            END IF;
        END LOOP;
    END IF;

    FOR r IN
        SELECT p.id
          FROM public.posts p
         WHERE p.author_id = v_profile.id
           AND p.is_deleted IS NOT TRUE
           AND p.visibility IN ('public', 'unlisted')
           AND p.is_pinned IS NOT TRUE
           AND (NULLIF(p.metadata ->> 'reblog_of', '') IS NULL OR p.metadata ->> 'is_quote' = 'true')
           AND (p.in_reply_to IS NULL
                OR EXISTS (SELECT 1 FROM public.posts parent
                            WHERE parent.id = p.in_reply_to AND parent.author_id = p.author_id))
           AND (p_before IS NULL
                OR (v_cursor_at IS NOT NULL
                    AND (p.created_at < v_cursor_at OR (p.created_at = v_cursor_at AND p.id < v_cursor_id))))
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT v_limit + 1
    LOOP
        v_count := v_count + 1;
        EXIT WHEN v_count > v_limit;
        v_post := public.public_page_post(r.id, 1);
        IF v_post IS NOT NULL THEN
            v_posts := v_posts || jsonb_build_array(v_post);
        END IF;
        v_next := r.id;
    END LOOP;
    IF v_count <= v_limit THEN
        v_next := NULL;
    END IF;

    RETURN jsonb_build_object(
        'enabled', v_instance -> 'enabled',
        'instance', v_instance,
        'account', v_account,
        'pinned', v_pinned,
        'posts', v_posts,
        'next', v_next);
END;
$$;

COMMENT ON FUNCTION public.public_profile_page(text, uuid, integer) IS
'A local account''s public page: account, pinned and public or unlisted posts, newest first. Service callers only.';

CREATE OR REPLACE FUNCTION public.public_post_page(p_post_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'enabled', i -> 'enabled',
        'instance', i,
        'post', public.public_page_post(p_post_id, 1))
      FROM public.public_page_instance() i
$$;

COMMENT ON FUNCTION public.public_post_page(uuid) IS
'A public or unlisted post with its quote and parent, as the public post page shows it. Service callers only.';

DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    FOREACH fn IN ARRAY ARRAY['public.public_page_account(uuid)'::regprocedure,
                              'public.public_page_post(uuid, integer)'::regprocedure,
                              'public.public_page_instance()'::regprocedure,
                              'public.public_profile_page(text, uuid, integer)'::regprocedure,
                              'public.public_post_page(uuid)'::regprocedure] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, grantee);
            END IF;
        END LOOP;
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
