-- Remote instance access by the host serving the account's actor.
--
-- A remote profile's domain is its account domain: the domain of its WebFinger subject when
-- that domain's WebFinger links back to the actor, else the host of its actor id. A
-- split-domain instance (Mastodon LOCAL_DOMAIN + WEB_DOMAIN) names accounts
-- acct:alice@example.com and serves their actors and its instance actor from
-- social.example.com, so the signer of its GETs is on social.example.com.
--
-- federation_post_access and federation_conversation_access take the signer's host
-- (federation-backend postAccess.signerHost: host[:port] of the verified key owner's actor
-- id, lowercased). A follower, mentioned account or participant now matches by its domain
-- or by the host of its federated_id. Rows whose domain is the actor host are unchanged.
--
-- Converged by state: CREATE OR REPLACE with the signatures of 20261006900001, grants
-- restated.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.federation_post_access(p_post_id uuid, p_domain text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_domain text := lower(btrim(p_domain));
    v_visibility text;
    v_author uuid;
    v_content jsonb;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'federation_post_access is for service callers' USING ERRCODE = '42501';
    END IF;

    SELECT coalesce(po.visibility, 'public'), po.author_id, po.content
      INTO v_visibility, v_author, v_content
      FROM public.posts po
     WHERE po.id = p_post_id AND po.is_deleted IS NOT TRUE;

    IF NOT FOUND THEN
        RETURN false;
    END IF;
    IF v_visibility IN ('public', 'unlisted') THEN
        RETURN true;
    END IF;
    IF v_domain IS NULL OR v_domain = '' OR v_domain = '*' THEN
        RETURN false;
    END IF;

    IF EXISTS (
        SELECT 1
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_content) = 'array' THEN v_content ELSE '[]'::jsonb END) e
          LEFT JOIN public.profiles mp
                 ON mp.id = CASE WHEN e ->> 'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                 THEN (e ->> 'userId')::uuid END
         WHERE jsonb_typeof(e) = 'object'
           AND e ->> 'type' = 'mention'
           AND CASE WHEN mp.id IS NOT NULL
                    THEN mp.is_local IS FALSE
                         AND (lower(mp.domain) = v_domain
                              OR lower(substring(mp.federated_id FROM '^https?://(?:[^/?#@]*@)?([^/?#@]+)')) = v_domain)
                    ELSE lower(e ->> 'domain') = v_domain AND coalesce(e ->> 'isLocal', 'false') <> 'true'
               END
    ) THEN
        RETURN true;
    END IF;

    IF v_visibility IN ('followers', 'private') THEN
        RETURN EXISTS (
            SELECT 1
              FROM public.follows f
              JOIN public.profiles fp ON fp.id = f.follower_id
             WHERE f.following_id = v_author
               AND f.status = 'accepted'
               AND fp.is_local IS FALSE
               AND (lower(fp.domain) = v_domain
                    OR lower(substring(fp.federated_id FROM '^https?://(?:[^/?#@]*@)?([^/?#@]+)')) = v_domain)
        );
    END IF;
    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.federation_conversation_access(p_conversation_id uuid, p_domain text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_domain text := lower(btrim(p_domain));
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'federation_conversation_access is for service callers' USING ERRCODE = '42501';
    END IF;

    RETURN EXISTS (
        SELECT 1
          FROM public.conversation_participants cp
          JOIN public.profiles p ON p.id = cp.user_id
         WHERE cp.conversation_id = p_conversation_id
           AND cp.left_at IS NULL
           AND p.is_local IS FALSE
           AND p.is_suspended IS NOT TRUE
           AND (lower(p.domain) = v_domain
                OR lower(substring(p.federated_id FROM '^https?://(?:[^/?#@]*@)?([^/?#@]+)')) = v_domain)
    );
END;
$$;

DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    FOREACH fn IN ARRAY ARRAY['public.federation_post_access(uuid, text)'::regprocedure,
                              'public.federation_conversation_access(uuid, text)'::regprocedure]
    LOOP
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
