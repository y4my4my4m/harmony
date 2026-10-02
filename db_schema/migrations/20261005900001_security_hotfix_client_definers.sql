-- Client-reachable SECURITY DEFINER functions and policies that trusted the caller.
--
-- Supabase's default privileges grant EXECUTE on public functions to anon and
-- authenticated, so these were PostgREST endpoints for the anon key:
--
--   add_user_to_conversation     added any profile to any conversation (DM history,
--                                Megolm key sharing, call tokens). A client caller is now
--                                an active participant of a group conversation; the row
--                                it writes is a member and an existing role is kept.
--   create_federated_profile     overwrote a remote profile's public_key and inbox URLs;
--                                SignatureService trusts the stored key. A client caller
--                                now only inserts a profile that does not exist, without
--                                key or endpoint URLs, under the domain its federated_id
--                                names; federation-backend fetches the rest from the actor.
--   service-only functions       no browser caller; federation-backend and bot-gateway use
--                                service_role. EXECUTE: postgres, supabase_admin,
--                                service_role.
--
-- Policies:
--   federation_delivery_queue   rows hold whole activities, federated DMs included;
--                               SELECT was USING (true) for authenticated. Admins only.
--   federation_endpoint_health  any authenticated user inserted rows; is_dead = true
--                               stops delivery to that inbox. Clients insert nothing.
--   storage user_media          SELECT was open to everyone, which lists every upload.
--                               Clients read rows of their own folder (the INSERT rule),
--                               and admins all rows. INSERT/DELETE RETURNING need it.
--                               Public URLs are served without RLS.
--
-- A client caller is a request whose role GUC is anon or authenticated: PostgREST sets it
-- with SET LOCAL ROLE, and SECURITY DEFINER changes current_user, not the GUC.

BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN (
               'get_or_create_dm_conversation', 'get_or_create_federated_group_conversation',
               'safe_upsert_remote_profile', 'update_post_embeds', 'broadcast_user_event',
               'create_federated_emoji', 'upsert_remote_emoji',
               'upsert_ap_activity', 'claim_ap_activity', 'complete_ap_activity',
               'update_endpoint_health', 'update_federation_health', 'touch_federated_instance',
               'cleanup_old_metrics', 'aggregate_hourly_metrics', 'record_slow_query',
               'check_and_increment_bot_rate_limit', 'check_key_consistency')
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

CREATE OR REPLACE FUNCTION public.add_user_to_conversation(
    conversation_uuid uuid,
    user_uuid uuid,
    user_role text DEFAULT 'member'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    participant_id uuid;
    v_caller uuid;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        v_caller := public.get_current_profile_id();
        IF v_caller IS NULL THEN
            RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
        END IF;
        IF NOT EXISTS (
            SELECT 1
              FROM conversations c
              JOIN conversation_participants cp ON cp.conversation_id = c.id
             WHERE c.id = conversation_uuid
               AND c.type = 'group'
               AND cp.user_id = v_caller
               AND cp.left_at IS NULL
        ) THEN
            RAISE EXCEPTION 'Only participants of a group conversation can add members'
                USING ERRCODE = '42501';
        END IF;

        INSERT INTO conversation_participants (conversation_id, user_id, role)
        VALUES (conversation_uuid, user_uuid, 'member')
        ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL
        RETURNING id INTO participant_id;
        RETURN participant_id;
    END IF;

    INSERT INTO conversation_participants (conversation_id, user_id, role)
    VALUES (conversation_uuid, user_uuid, user_role)
    ON CONFLICT (conversation_id, user_id)
    DO UPDATE SET left_at = NULL, role = user_role
    RETURNING id INTO participant_id;

    RETURN participant_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_federated_profile(
    p_username text,
    p_display_name text DEFAULT NULL,
    p_domain text DEFAULT NULL,
    p_avatar_url text DEFAULT NULL,
    p_banner_url text DEFAULT NULL,
    p_federated_id text DEFAULT NULL,
    p_bio text DEFAULT NULL,
    p_inbox_url text DEFAULT NULL,
    p_outbox_url text DEFAULT NULL,
    p_followers_url text DEFAULT NULL,
    p_following_url text DEFAULT NULL,
    p_public_key text DEFAULT NULL,
    p_shared_inbox_url text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_profile_id uuid;
    v_instance_domain text;
BEGIN
    SELECT COALESCE(
        (SELECT trim(both '"' from config_value::text) FROM instance_config WHERE config_key = 'domain'),
        'localhost'
    ) INTO v_instance_domain;

    IF p_domain = v_instance_domain THEN
        RAISE WARNING 'Refusing to create federated profile for local domain: %@%', p_username, p_domain;
        SELECT id INTO v_profile_id
        FROM profiles WHERE username = p_username AND domain = p_domain AND is_local = true;
        RETURN v_profile_id;
    END IF;

    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        IF public.get_current_profile_id() IS NULL THEN
            RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
        END IF;
        IF p_domain IS NULL OR p_federated_id IS NULL
           OR lower(substring(p_federated_id from '^https://([^/:?#]+)')) IS DISTINCT FROM lower(p_domain) THEN
            RAISE EXCEPTION 'federated_id must be an https URL on the profile domain'
                USING ERRCODE = '22023';
        END IF;

        SELECT id INTO v_profile_id
          FROM profiles
         WHERE (username = p_username AND domain = p_domain)
            OR federated_id = p_federated_id
         LIMIT 1;
        IF v_profile_id IS NOT NULL THEN
            RETURN v_profile_id;
        END IF;

        INSERT INTO profiles (
            username, display_name, domain, avatar_url, banner_url,
            federated_id, bio, is_local
        ) VALUES (
            p_username, COALESCE(p_display_name, p_username), p_domain,
            p_avatar_url, p_banner_url, p_federated_id, p_bio, false
        )
        ON CONFLICT (username, domain) DO NOTHING
        RETURNING id INTO v_profile_id;

        IF v_profile_id IS NULL THEN
            SELECT id INTO v_profile_id
            FROM profiles WHERE username = p_username AND domain = p_domain;
        END IF;
        RETURN v_profile_id;
    END IF;

    INSERT INTO profiles (
        username, display_name, domain, avatar_url, banner_url,
        federated_id, bio, inbox_url, outbox_url, followers_url,
        following_url, public_key, shared_inbox_url, is_local, last_synced_at
    ) VALUES (
        p_username, COALESCE(p_display_name, p_username), p_domain,
        p_avatar_url, p_banner_url, p_federated_id, p_bio,
        p_inbox_url, p_outbox_url, p_followers_url,
        p_following_url, p_public_key, p_shared_inbox_url, false, NOW()
    )
    ON CONFLICT (username, domain) DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, profiles.display_name),
        avatar_url = COALESCE(EXCLUDED.avatar_url, profiles.avatar_url),
        banner_url = COALESCE(EXCLUDED.banner_url, profiles.banner_url),
        federated_id = COALESCE(EXCLUDED.federated_id, profiles.federated_id),
        bio = COALESCE(EXCLUDED.bio, profiles.bio),
        inbox_url = COALESCE(EXCLUDED.inbox_url, profiles.inbox_url),
        outbox_url = COALESCE(EXCLUDED.outbox_url, profiles.outbox_url),
        followers_url = COALESCE(EXCLUDED.followers_url, profiles.followers_url),
        following_url = COALESCE(EXCLUDED.following_url, profiles.following_url),
        public_key = COALESCE(EXCLUDED.public_key, profiles.public_key),
        shared_inbox_url = COALESCE(EXCLUDED.shared_inbox_url, profiles.shared_inbox_url),
        last_synced_at = NOW(), updated_at = NOW()
    WHERE profiles.is_local = false
    RETURNING id INTO v_profile_id;

    IF v_profile_id IS NULL THEN
        SELECT id INTO v_profile_id
        FROM profiles WHERE username = p_username AND domain = p_domain;
    END IF;

    RETURN v_profile_id;
END;
$$;

REVOKE ALL ON FUNCTION public.add_user_to_conversation(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_user_to_conversation(uuid, uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_federated_profile(text, text, text, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_federated_profile(text, text, text, text, text, text, text, text, text, text, text, text, text) TO authenticated, service_role;

DROP POLICY IF EXISTS "Users can view federation delivery queue" ON public.federation_delivery_queue;
DROP POLICY IF EXISTS "Admins can view federation delivery queue" ON public.federation_delivery_queue;
CREATE POLICY "Admins can view federation delivery queue" ON public.federation_delivery_queue
    FOR SELECT TO authenticated
    USING ((SELECT public.is_current_user_admin()));

DROP POLICY IF EXISTS federation_endpoint_health_insert_update ON public.federation_endpoint_health;

DROP POLICY IF EXISTS "Public read access for user_media" ON storage.objects;
DROP POLICY IF EXISTS "Users can read their own user_media" ON storage.objects;
CREATE POLICY "Users can read their own user_media" ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'user_media'
        AND (
            (storage.foldername(name))[1] = (SELECT auth.uid())::text
            OR ((SELECT public.get_current_profile_id()) IS NOT NULL
                AND (storage.foldername(name))[1] = (SELECT public.get_current_profile_id())::text)
            OR (SELECT public.is_current_user_admin())
        )
    );

COMMIT;

NOTIFY pgrst, 'reload schema';
