-- Account migration: Mastodon-compatible aliases and Move, in both directions, and the
-- server memberships a moved account takes along when it rejoins.
--
-- Profiles. also_known_as holds actor URIs (ActivityPub alsoKnownAs); moved_to_id and
-- moved_to_uri name the account this one moved to (movedTo), moved_at when it did. For a
-- local account they are written by the RPCs below only: guard_profile_client_write keeps
-- them fixed on client updates and empty on client inserts. A change to also_known_as or
-- moved_to_uri federates an Update(Person). For a remote account the federation backend
-- copies them from the actor document.
--
-- Aliases. set_my_account_aliases(p_uris) replaces the caller's alias list: at most ten
-- distinct http(s) URIs, never the caller's own. A URI not already listed must be the actor
-- URI of a stored profile (a resolved remote account or a local one); one already listed
-- stays when its profile is gone.
--
-- Move. begin_account_move(p_target_profile_id, p_password) re-authenticates as
-- delete_my_account does (TOTP within ten minutes for 2FA accounts; the password, sharing
-- its five-per-fifteen-minutes budget; a sign-in within ten minutes for accounts without
-- one). It refuses a moved, suspended or deleted target, the caller itself, and a target
-- whose also_known_as lacks the caller's actor URI; a second move inside 30 days of the
-- previous one, cancelled or not, raises PT429 move_cooldown. It sets moved_to_*, records
-- an account_migrations row and queues 'account-moved' { migration_id }. The worker sends
-- Move { actor: A, object: A, target: B } to A's followers and to the instances A shares
-- servers with, then calls migrate_account_followers until a batch comes back short, then
-- sets delivered_at. cancel_my_account_redirect() clears moved_to_*; the cooldown stays.
-- A target on this instance works the same way.
--
-- Inbound Move. The backend verifies the signature, the target document's alsoKnownAs and
-- the absence of its movedTo, then calls record_remote_account_move(origin, target), which
-- re-checks the target, refuses an origin that moved elsewhere in the last 30 days, and is
-- idempotent for a repeated Move to the same target.
--
-- Follower migration, after Mastodon's MoveWorker. migrate_account_followers(migration,
-- limit) moves one batch of the origin's accepted local followers: a follower that is
-- deleted, suspended, the target itself, or blocks or is blocked by the target is left in
-- place. The new follow is accepted when the target is local and pending when remote (the
-- follow trigger sends the Follow); the old row is deleted (the trigger sends the Undo).
-- The follower's list memberships move to the target and the follower gets a 'move'
-- notification. Local blocks and live mutes of the origin are copied to the target on every
-- call; the copy skips rows that exist.
--
-- Undo. trigger_queue_follow_federation read the follower from NEW on DELETE, where NEW is
-- null, so no unfollow of a remote account queued an Undo. It reads OLD there; the worker
-- skips a follower whose account was deleted, as the actor Delete covers it.
--
-- Server memberships. carry_over_moved_membership(server, profile, alias) moves an accepted
-- member's nickname and roles to the account it moved to, which has just joined, and removes
-- the old membership. It requires alias.moved_to_id = profile and the alias's actor URI in
-- profile.also_known_as.
--
-- Export. profile_handle carries the actor URI, and request_my_data_export's servers carry
-- ap_id, host_domain and is_local_server, so an export names accounts and servers on other
-- instances unambiguously.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Columns and table
-- ---------------------------------------------------------------------------

ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS also_known_as text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS moved_to_id uuid,
    ADD COLUMN IF NOT EXISTS moved_to_uri text,
    ADD COLUMN IF NOT EXISTS moved_at timestamptz;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.profiles'::regclass
                      AND conname = 'profiles_moved_to_id_fkey') THEN
        ALTER TABLE public.profiles
            ADD CONSTRAINT profiles_moved_to_id_fkey FOREIGN KEY (moved_to_id)
            REFERENCES public.profiles(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.profiles'::regclass
                      AND conname = 'profiles_moved_to_not_self') THEN
        ALTER TABLE public.profiles
            ADD CONSTRAINT profiles_moved_to_not_self CHECK (moved_to_id <> id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.profiles'::regclass
                      AND conname = 'profiles_also_known_as_length') THEN
        ALTER TABLE public.profiles
            ADD CONSTRAINT profiles_also_known_as_length CHECK (cardinality(also_known_as) <= 20);
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_profiles_moved_to_id
    ON public.profiles (moved_to_id) WHERE moved_to_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_also_known_as
    ON public.profiles USING gin (also_known_as);

COMMENT ON COLUMN public.profiles.also_known_as IS
    'Actor URIs of the other accounts of this person (ActivityPub alsoKnownAs).';
COMMENT ON COLUMN public.profiles.moved_to_id IS
    'Profile this account moved to; moved_to_uri is its actor URI (ActivityPub movedTo).';
COMMENT ON COLUMN public.profiles.moved_to_uri IS
    'Actor URI this account moved to (ActivityPub movedTo); set without moved_to_id when the target is not stored.';
COMMENT ON COLUMN public.profiles.moved_at IS
    'When moved_to_uri last changed to a target.';

CREATE TABLE IF NOT EXISTS public.account_migrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    target_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    target_uri text NOT NULL,
    followers_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz,
    cancelled_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_account_migrations_profile
    ON public.account_migrations (profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_migrations_undelivered
    ON public.account_migrations (created_at) WHERE delivered_at IS NULL AND cancelled_at IS NULL;
ALTER TABLE public.account_migrations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_migrations_service_role ON public.account_migrations;
CREATE POLICY account_migrations_service_role ON public.account_migrations
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.account_migrations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.account_migrations TO service_role;
COMMENT ON TABLE public.account_migrations IS
    'One row per Move, local or received: delivered_at marks the Move sent and the local followers migrated.';

-- ---------------------------------------------------------------------------
-- Client writes and profile federation
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_profile_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_fixed CONSTANT text[] := ARRAY[
        'federated_id', 'inbox_url', 'outbox_url', 'followers_url', 'following_url',
        'featured_url', 'shared_inbox_url', 'public_key', 'domain', 'is_local',
        'followers_count', 'following_count', 'posts_count',
        'message_count', 'voice_minutes', 'created_at', 'suspended_at', 'suspension_reason',
        'silenced_at', 'silenced_reason', 'last_synced_at', 'last_federation_sync',
        'supported_activities', 'also_known_as', 'moved_to_id', 'moved_to_uri', 'moved_at'];
    v_domain text;
    v_actor text;
    v_old jsonb;
    v_keep jsonb;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.is_local IS FALSE THEN
            RAISE EXCEPTION 'remote profiles arrive through federation' USING ERRCODE = '42501';
        END IF;
        IF NEW.public_key IS NOT NULL OR NEW.featured_url IS NOT NULL OR NEW.shared_inbox_url IS NOT NULL
           OR NEW.suspended_at IS NOT NULL OR NEW.suspension_reason IS NOT NULL
           OR NEW.silenced_at IS NOT NULL OR NEW.silenced_reason IS NOT NULL THEN
            RAISE EXCEPTION 'keys and moderation details are set by the server' USING ERRCODE = '42501';
        END IF;

        SELECT lower(btrim(replace(c.config_value #>> '{}', '"', ''))) INTO v_domain
          FROM public.instance_config c
         WHERE c.config_key = 'domain';
        IF NEW.domain IS NOT NULL AND v_domain IS NOT NULL AND v_domain <> ''
           AND lower(NEW.domain) <> v_domain THEN
            RAISE EXCEPTION 'a local profile is on this instance''s domain' USING ERRCODE = '42501';
        END IF;

        v_actor := 'https://' || NEW.domain || '/users/' || NEW.username;
        IF (NEW.federated_id IS NOT NULL OR NEW.inbox_url IS NOT NULL OR NEW.outbox_url IS NOT NULL
            OR NEW.followers_url IS NOT NULL OR NEW.following_url IS NOT NULL)
           AND (v_actor IS NULL
                OR NEW.federated_id IS DISTINCT FROM v_actor
                OR (NEW.inbox_url IS NOT NULL AND NEW.inbox_url <> v_actor || '/inbox')
                OR (NEW.outbox_url IS NOT NULL AND NEW.outbox_url <> v_actor || '/outbox')
                OR (NEW.followers_url IS NOT NULL AND NEW.followers_url <> v_actor || '/followers')
                OR (NEW.following_url IS NOT NULL AND NEW.following_url <> v_actor || '/following')) THEN
            RAISE EXCEPTION 'actor URLs derive from https://<domain>/users/<username>' USING ERRCODE = '42501';
        END IF;

        NEW.created_at := now();
        NEW.followers_count := 0;
        NEW.following_count := 0;
        NEW.posts_count := 0;
        NEW.message_count := 0;
        NEW.voice_minutes := 0;
        NEW.also_known_as := '{}';
        NEW.moved_to_id := NULL;
        NEW.moved_to_uri := NULL;
        NEW.moved_at := NULL;
        RETURN NEW;
    END IF;

    v_old := to_jsonb(OLD);
    SELECT jsonb_object_agg(k, v_old -> k) INTO v_keep
      FROM unnest(v_fixed) k
     WHERE v_old ? k;
    IF v_keep IS NOT NULL THEN
        NEW := jsonb_populate_record(NEW, v_keep);
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_profile_client_write() FROM PUBLIC, anon, authenticated;

-- Profile federation stays silent for a tombstone; the Delete covers it.
CREATE OR REPLACE FUNCTION public.trigger_queue_profile_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.is_local != true OR NEW.deleted_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF (
            OLD.display_name IS NOT DISTINCT FROM NEW.display_name AND
            OLD.bio IS NOT DISTINCT FROM NEW.bio AND
            OLD.avatar_url IS NOT DISTINCT FROM NEW.avatar_url AND
            OLD.banner_url IS NOT DISTINCT FROM NEW.banner_url AND
            OLD.custom_status IS NOT DISTINCT FROM NEW.custom_status AND
            OLD.also_known_as IS NOT DISTINCT FROM NEW.also_known_as AND
            OLD.moved_to_uri IS NOT DISTINCT FROM NEW.moved_to_uri
        ) THEN
            RETURN NEW;
        END IF;
    END IF;

    PERFORM public.queue_federation_job(
        'federate-profile',
        jsonb_build_object(
            'type', CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END,
            'profile_id', NEW.id,
            'username', NEW.username,
            'display_name', NEW.display_name,
            'bio', NEW.bio,
            'avatar_url', NEW.avatar_url,
            'banner_url', NEW.banner_url,
            'custom_status', NEW.custom_status
        ),
        3, 5, 3600
    );

    RETURN NEW;
END;
$$;

-- NEW is null on DELETE: the follower is read from OLD there, or no Undo is queued.
CREATE OR REPLACE FUNCTION public.trigger_queue_follow_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_follower_is_local BOOLEAN;
BEGIN
    SELECT is_local INTO v_follower_is_local FROM public.profiles
     WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.follower_id ELSE NEW.follower_id END;

    IF TG_OP = 'DELETE' THEN
        IF v_follower_is_local = true THEN
            PERFORM public.queue_federation_job(
                'federate-follow',
                jsonb_build_object(
                    'type', 'delete',
                    'follow_id', OLD.id,
                    'follower_id', OLD.follower_id,
                    'following_id', OLD.following_id
                ), 5, 5, 3600
            );
        END IF;
        RETURN OLD;
    END IF;

    IF v_follower_is_local = true THEN
        NEW.federation_status := 'queued';
        PERFORM public.queue_federation_job(
            'federate-follow',
            jsonb_build_object(
                'type', 'create',
                'follow_id', NEW.id,
                'follower_id', NEW.follower_id,
                'following_id', NEW.following_id,
                'status', NEW.status
            ), 5, 5, 3600
        );
    ELSE
        NEW.federation_status := 'skipped';
    END IF;

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Actor URI of a profile: federated_id, or for a local profile not yet backfilled
-- https://<domain>/users/<username>, as the actor route derives it.
CREATE OR REPLACE FUNCTION public.profile_actor_uri(p_profile_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT coalesce(nullif(p.federated_id, ''),
                    CASE WHEN p.is_local IS NOT FALSE AND p.deleted_at IS NULL AND p.username IS NOT NULL
                         THEN 'https://' || p.domain || '/users/' || p.username END)
      FROM public.profiles p
     WHERE p.id = p_profile_id;
$$;

-- Live profile whose actor URI is p_uri.
CREATE OR REPLACE FUNCTION public.profile_id_by_actor_uri(p_uri text)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT id FROM (
        SELECT p.id, 0 AS rank
          FROM public.profiles p
         WHERE p.federated_id = p_uri AND p.deleted_at IS NULL
        UNION ALL
        SELECT p.id, 1
          FROM public.profiles p
         WHERE p.is_local IS NOT FALSE
           AND p.deleted_at IS NULL
           AND p.federated_id IS NULL
           AND p.username = substring(p_uri FROM '^https?://[^/]+/users/([A-Za-z0-9_]+)$')
           AND lower(p.domain) = lower(substring(p_uri FROM '^https?://([^/]+)/users/'))
    ) m
    ORDER BY rank
    LIMIT 1;
$$;

-- NULL when p_origin may move to p_target, otherwise the refusal code.
CREATE OR REPLACE FUNCTION public.account_move_refusal(p_origin_id uuid, p_target_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_target public.profiles%ROWTYPE;
    v_origin_uri text := public.profile_actor_uri(p_origin_id);
BEGIN
    IF p_target_id IS NOT DISTINCT FROM p_origin_id THEN
        RETURN 'target_is_self';
    END IF;
    SELECT p.* INTO v_target FROM public.profiles p WHERE p.id = p_target_id;
    IF v_target.id IS NULL OR v_target.deleted_at IS NOT NULL
       OR public.profile_actor_uri(v_target.id) IS NULL THEN
        RETURN 'target_not_found';
    END IF;
    IF coalesce(v_target.is_suspended, false) THEN
        RETURN 'target_suspended';
    END IF;
    IF v_target.moved_to_id IS NOT NULL OR v_target.moved_to_uri IS NOT NULL THEN
        RETURN 'target_moved';
    END IF;
    IF v_origin_uri IS NULL OR NOT (v_origin_uri = ANY (v_target.also_known_as)) THEN
        RETURN 'alias_missing';
    END IF;
    RETURN NULL;
END;
$$;

-- Points p_origin at p_target, records the migration and queues its delivery.
CREATE OR REPLACE FUNCTION public.apply_account_move(p_origin_id uuid, p_target_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_target_uri text := public.profile_actor_uri(p_target_id);
    v_followers integer;
    v_id uuid;
BEGIN
    UPDATE public.profiles p SET
        moved_to_id = p_target_id,
        moved_to_uri = v_target_uri,
        moved_at = CASE WHEN p.moved_to_uri IS DISTINCT FROM v_target_uri OR p.moved_at IS NULL
                        THEN now() ELSE p.moved_at END,
        updated_at = now()
     WHERE p.id = p_origin_id;

    SELECT count(*) INTO v_followers
      FROM public.follows f
     WHERE f.following_id = p_origin_id AND f.status = 'accepted';

    INSERT INTO public.account_migrations (profile_id, target_profile_id, target_uri, followers_count)
    VALUES (p_origin_id, p_target_id, v_target_uri, v_followers)
    RETURNING id INTO v_id;

    PERFORM public.queue_federation_job('account-moved',
        jsonb_build_object('migration_id', v_id), 3, 10, 86400);
    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.profile_actor_uri(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.profile_id_by_actor_uri(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_move_refusal(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_account_move(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Client RPCs
-- ---------------------------------------------------------------------------

-- Errors: invalid_alias { uri }, too_many_aliases { max }, alias_is_self,
-- unknown_account { uris }.
CREATE OR REPLACE FUNCTION public.set_my_account_aliases(p_uris text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_profile_id uuid := public.get_current_profile_id();
    v_current text[];
    v_uris text[];
    v_bad text;
    v_unknown text[];
BEGIN
    IF auth.uid() IS NULL OR v_profile_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    SELECT p.also_known_as INTO v_current FROM public.profiles p WHERE p.id = v_profile_id;

    SELECT coalesce(array_agg(d.uri ORDER BY d.ord), '{}') INTO v_uris
      FROM (SELECT DISTINCT ON (btrim(t.raw)) btrim(t.raw) AS uri, t.ord
              FROM unnest(coalesce(p_uris, '{}'::text[])) WITH ORDINALITY AS t(raw, ord)
             WHERE nullif(btrim(t.raw), '') IS NOT NULL
             ORDER BY btrim(t.raw), t.ord) d;

    SELECT u INTO v_bad FROM unnest(v_uris) u
     WHERE (u !~ '^https?://[^/\s]+/\S*$' OR length(u) > 2048)
       AND NOT (u = ANY (v_current))
     LIMIT 1;
    IF v_bad IS NOT NULL THEN
        RETURN jsonb_build_object('error', 'invalid_alias', 'uri', v_bad);
    END IF;
    IF cardinality(v_uris) > 10 THEN
        RETURN jsonb_build_object('error', 'too_many_aliases', 'max', 10);
    END IF;
    IF public.profile_actor_uri(v_profile_id) = ANY (v_uris) THEN
        RETURN jsonb_build_object('error', 'alias_is_self');
    END IF;

    SELECT array_agg(u) INTO v_unknown FROM unnest(v_uris) u
     WHERE NOT (u = ANY (v_current))
       AND public.profile_id_by_actor_uri(u) IS NULL;
    IF v_unknown IS NOT NULL THEN
        RETURN jsonb_build_object('error', 'unknown_account', 'uris', to_jsonb(v_unknown));
    END IF;

    UPDATE public.profiles SET also_known_as = v_uris, updated_at = now()
     WHERE id = v_profile_id;

    RETURN jsonb_build_object('success', true, 'aliases', to_jsonb(v_uris));
END;
$$;

-- Errors: mfa_required, password_required, invalid_password, reauthentication_required,
-- account_suspended, already_moved, and the account_move_refusal codes. Raises PT429
-- move_cooldown (DETAIL retry_after=<seconds>) inside 30 days of the previous move and
-- PT429 too_many_attempts after five wrong passwords.
CREATE OR REPLACE FUNCTION public.begin_account_move(p_target_profile_id uuid, p_password text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_auth_id uuid := auth.uid();
    v_hash text;
    v_profile public.profiles%ROWTYPE;
    v_refusal text;
    v_last timestamptz;
    v_migration uuid;
BEGIN
    IF v_auth_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: requires an authenticated session' USING ERRCODE = '42501';
    END IF;

    SELECT p.* INTO v_profile FROM public.profiles p WHERE p.auth_user_id = v_auth_id;
    IF v_profile.id IS NULL OR v_profile.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF coalesce(v_profile.is_suspended, false) THEN
        RETURN jsonb_build_object('error', 'account_suspended');
    END IF;
    IF v_profile.moved_to_id IS NOT NULL OR v_profile.moved_to_uri IS NOT NULL THEN
        RETURN jsonb_build_object('error', 'already_moved');
    END IF;

    v_refusal := public.account_move_refusal(v_profile.id, p_target_profile_id);
    IF v_refusal IS NOT NULL THEN
        RETURN jsonb_build_object('error', v_refusal);
    END IF;

    SELECT max(m.created_at) INTO v_last
      FROM public.account_migrations m WHERE m.profile_id = v_profile.id;
    IF v_last > now() - interval '30 days' THEN
        RAISE SQLSTATE 'PT429' USING MESSAGE = 'move_cooldown',
            DETAIL = 'retry_after=' || ceil(extract(epoch FROM v_last + interval '30 days' - now()))::bigint;
    END IF;

    IF public.mfa_enabled_for(v_auth_id)
       AND (public.current_jwt_claims() ->> 'aal' IS DISTINCT FROM 'aal2'
            OR NOT public.session_step_up_fresh('totp', interval '10 minutes')) THEN
        RETURN jsonb_build_object('error', 'mfa_required');
    END IF;

    SELECT u.encrypted_password INTO v_hash FROM auth.users u WHERE u.id = v_auth_id;
    IF v_hash LIKE '$2%' THEN
        IF coalesce(p_password, '') = '' THEN
            RETURN jsonb_build_object('error', 'password_required');
        END IF;
        PERFORM public.assert_security_attempt_budget(v_auth_id, 'password');
        IF extensions.crypt(p_password, v_hash) IS DISTINCT FROM v_hash THEN
            PERFORM public.record_security_attempt(v_auth_id, 'password', false);
            RETURN jsonb_build_object('error', 'invalid_password');
        END IF;
    ELSIF NOT public.session_step_up_fresh(NULL, interval '10 minutes') THEN
        RETURN jsonb_build_object('error', 'reauthentication_required');
    END IF;

    v_migration := public.apply_account_move(v_profile.id, p_target_profile_id);

    RETURN jsonb_build_object('success', true, 'migration_id', v_migration,
                              'target_uri', public.profile_actor_uri(p_target_profile_id));
END;
$$;

-- Errors: not_moved.
CREATE OR REPLACE FUNCTION public.cancel_my_account_redirect()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_profile_id uuid := public.get_current_profile_id();
BEGIN
    IF auth.uid() IS NULL OR v_profile_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    UPDATE public.profiles SET moved_to_id = NULL, moved_to_uri = NULL, moved_at = NULL, updated_at = now()
     WHERE id = v_profile_id AND (moved_to_id IS NOT NULL OR moved_to_uri IS NOT NULL);
    IF NOT FOUND THEN
        RETURN jsonb_build_object('error', 'not_moved');
    END IF;

    UPDATE public.account_migrations SET cancelled_at = now()
     WHERE profile_id = v_profile_id AND cancelled_at IS NULL;

    RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.set_my_account_aliases(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_account_move(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_my_account_redirect() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_my_account_aliases(text[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.begin_account_move(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_my_account_redirect() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Federation backend RPCs
-- ---------------------------------------------------------------------------

-- A verified Move from a remote origin. Returns { migration_id, created } or { error }:
-- origin_not_remote, recently_moved, and the account_move_refusal codes. A repeated Move to
-- the origin's current target returns that target's migration.
CREATE OR REPLACE FUNCTION public.record_remote_account_move(p_origin_id uuid, p_target_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_origin public.profiles%ROWTYPE;
    v_target_uri text := public.profile_actor_uri(p_target_id);
    v_refusal text;
    v_existing uuid;
BEGIN
    SELECT p.* INTO v_origin FROM public.profiles p WHERE p.id = p_origin_id FOR UPDATE;
    IF v_origin.id IS NULL OR v_origin.is_local IS NOT FALSE THEN
        RETURN jsonb_build_object('error', 'origin_not_remote');
    END IF;

    v_refusal := public.account_move_refusal(p_origin_id, p_target_id);
    IF v_refusal IS NOT NULL THEN
        RETURN jsonb_build_object('error', v_refusal);
    END IF;

    IF v_origin.moved_to_id = p_target_id OR v_origin.moved_to_uri = v_target_uri THEN
        SELECT m.id INTO v_existing
          FROM public.account_migrations m
         WHERE m.profile_id = p_origin_id AND m.target_profile_id = p_target_id
           AND m.cancelled_at IS NULL
         ORDER BY m.created_at DESC
         LIMIT 1;
        IF v_existing IS NOT NULL THEN
            RETURN jsonb_build_object('migration_id', v_existing, 'created', false);
        END IF;
    ELSIF (v_origin.moved_to_id IS NOT NULL OR v_origin.moved_to_uri IS NOT NULL)
          AND v_origin.moved_at > now() - interval '30 days' THEN
        RETURN jsonb_build_object('error', 'recently_moved');
    END IF;

    RETURN jsonb_build_object('migration_id', public.apply_account_move(p_origin_id, p_target_id),
                              'created', true);
END;
$$;

-- Moves up to p_limit of the migration's eligible local followers and returns how many
-- moved; a short batch means none remain. Blocks and mutes are copied first.
CREATE OR REPLACE FUNCTION public.migrate_account_followers(p_migration_id uuid, p_limit integer DEFAULT 200)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_migration public.account_migrations%ROWTYPE;
    v_origin uuid;
    v_target public.profiles%ROWTYPE;
    v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
    v_follow_ids uuid[];
    v_followers uuid[];
    v_status text;
    v_data jsonb;
BEGIN
    SELECT m.* INTO v_migration FROM public.account_migrations m WHERE m.id = p_migration_id;
    IF v_migration.id IS NULL OR v_migration.cancelled_at IS NOT NULL
       OR v_migration.target_profile_id IS NULL THEN
        RETURN 0;
    END IF;
    v_origin := v_migration.profile_id;
    SELECT p.* INTO v_target FROM public.profiles p WHERE p.id = v_migration.target_profile_id;
    IF v_target.id IS NULL OR v_target.deleted_at IS NOT NULL THEN
        RETURN 0;
    END IF;

    INSERT INTO public.user_blocks (blocker_id, blocked_user_id, block_type, reason, expires_at)
    SELECT b.blocker_id, v_target.id, b.block_type, b.reason, b.expires_at
      FROM public.user_blocks b
      JOIN public.profiles bp ON bp.id = b.blocker_id
     WHERE b.blocked_user_id = v_origin
       AND bp.is_local IS TRUE AND bp.deleted_at IS NULL
       AND b.blocker_id <> v_target.id
       AND NOT EXISTS (SELECT 1 FROM public.user_blocks x
                        WHERE x.blocker_id = b.blocker_id AND x.blocked_user_id = v_target.id)
    ON CONFLICT (blocker_id, blocked_user_id) DO NOTHING;

    INSERT INTO public.user_mutes (muter_id, muted_user_id, expires_at, hide_notifications, hide_from_timeline)
    SELECT m.muter_id, v_target.id, m.expires_at, m.hide_notifications, m.hide_from_timeline
      FROM public.user_mutes m
      JOIN public.profiles mp ON mp.id = m.muter_id
     WHERE m.muted_user_id = v_origin
       AND mp.is_local IS TRUE AND mp.deleted_at IS NULL
       AND m.muter_id <> v_target.id
       AND (m.expires_at IS NULL OR m.expires_at > now())
       AND NOT EXISTS (SELECT 1 FROM public.user_mutes x
                        WHERE x.muter_id = m.muter_id AND x.muted_user_id = v_target.id)
    ON CONFLICT (muter_id, muted_user_id) DO NOTHING;

    SELECT array_agg(b.id), array_agg(b.follower_id) INTO v_follow_ids, v_followers
      FROM (SELECT f.id, f.follower_id
              FROM public.follows f
              JOIN public.profiles fp ON fp.id = f.follower_id
             WHERE f.following_id = v_origin
               AND f.status = 'accepted'
               AND fp.is_local IS TRUE
               AND fp.deleted_at IS NULL
               AND coalesce(fp.is_suspended, false) = false
               AND f.follower_id <> v_target.id
               AND NOT EXISTS (SELECT 1 FROM public.user_blocks ub
                                WHERE (ub.blocker_id = f.follower_id AND ub.blocked_user_id = v_target.id)
                                   OR (ub.blocker_id = v_target.id AND ub.blocked_user_id = f.follower_id))
             ORDER BY f.created_at, f.id
             LIMIT v_limit
               FOR UPDATE OF f SKIP LOCKED) b;
    IF v_follow_ids IS NULL THEN
        RETURN 0;
    END IF;

    v_status := CASE WHEN v_target.is_local IS NOT FALSE THEN 'accepted' ELSE 'pending' END;

    INSERT INTO public.follows (follower_id, following_id, status, accepted_at, is_local)
    SELECT f, v_target.id, v_status, CASE WHEN v_status = 'accepted' THEN now() END, true
      FROM unnest(v_followers) f
     WHERE NOT EXISTS (SELECT 1 FROM public.follows x
                        WHERE x.follower_id = f AND x.following_id = v_target.id);

    UPDATE public.user_list_members lm SET account_id = v_target.id
      FROM public.user_lists l
     WHERE l.id = lm.list_id
       AND l.user_id = ANY (v_followers)
       AND lm.account_id = v_origin
       AND NOT EXISTS (SELECT 1 FROM public.user_list_members x
                        WHERE x.list_id = lm.list_id AND x.account_id = v_target.id);
    DELETE FROM public.user_list_members lm
     USING public.user_lists l
     WHERE l.id = lm.list_id
       AND l.user_id = ANY (v_followers)
       AND lm.account_id = v_origin;

    DELETE FROM public.follows WHERE id = ANY (v_follow_ids);

    v_data := jsonb_build_object(
        'origin', (SELECT public.profile_handle(p.id) || jsonb_build_object('is_local', p.is_local)
                     FROM public.profiles p WHERE p.id = v_origin),
        'target', public.profile_handle(v_target.id)
                  || jsonb_build_object('is_local', v_target.is_local, 'avatar_url', v_target.avatar_url),
        'follow_status', v_status,
        'migration_id', v_migration.id);
    INSERT INTO public.notifications (user_id, type, data)
    SELECT f, 'move', v_data FROM unnest(v_followers) f;

    RETURN cardinality(v_follow_ids);
END;
$$;

-- Returns carried, not_alias, not_member or alias_banned. p_profile_id is an accepted
-- member already.
CREATE OR REPLACE FUNCTION public.carry_over_moved_membership(p_server_id uuid, p_profile_id uuid, p_alias_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_alias public.profiles%ROWTYPE;
    v_aliases text[];
    v_alias_member public.user_servers%ROWTYPE;
BEGIN
    SELECT p.* INTO v_alias FROM public.profiles p WHERE p.id = p_alias_id;
    SELECT p.also_known_as INTO v_aliases FROM public.profiles p WHERE p.id = p_profile_id;
    IF v_alias.id IS NULL OR v_alias.moved_to_id IS DISTINCT FROM p_profile_id
       OR NOT (public.profile_actor_uri(v_alias.id) = ANY (coalesce(v_aliases, '{}'))) THEN
        RETURN 'not_alias';
    END IF;

    IF EXISTS (SELECT 1 FROM public.server_bans b WHERE b.server_id = p_server_id AND b.user_id = p_alias_id)
       OR EXISTS (SELECT 1 FROM public.user_servers us
                   WHERE us.server_id = p_server_id AND us.user_id = p_alias_id AND us.status = 'banned') THEN
        RETURN 'alias_banned';
    END IF;

    SELECT us.* INTO v_alias_member FROM public.user_servers us
     WHERE us.server_id = p_server_id AND us.user_id = p_alias_id AND us.status = 'accepted'
       FOR UPDATE;
    IF v_alias_member.id IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.user_servers us
                       WHERE us.server_id = p_server_id AND us.user_id = p_profile_id
                         AND us.status = 'accepted') THEN
        RETURN 'not_member';
    END IF;

    UPDATE public.user_servers us SET nickname = v_alias_member.nickname, updated_at = now()
     WHERE us.server_id = p_server_id AND us.user_id = p_profile_id
       AND us.nickname IS NULL AND v_alias_member.nickname IS NOT NULL;

    INSERT INTO public.user_roles (user_id, role_id, server_id, assigned_by)
    SELECT p_profile_id, ur.role_id, ur.server_id, ur.assigned_by
      FROM public.user_roles ur
     WHERE ur.user_id = p_alias_id AND ur.server_id = p_server_id
    ON CONFLICT (user_id, role_id) DO NOTHING;

    DELETE FROM public.user_servers us WHERE us.id = v_alias_member.id;
    RETURN 'carried';
END;
$$;

REVOKE ALL ON FUNCTION public.record_remote_account_move(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.migrate_account_followers(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.carry_over_moved_membership(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_remote_account_move(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.migrate_account_followers(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.carry_over_moved_membership(uuid, uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Export
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.profile_handle(p_profile_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT jsonb_build_object('id', p.id, 'username', p.username, 'domain', p.domain,
                              'display_name', p.display_name, 'deleted', p.deleted_at IS NOT NULL,
                              'federated_id', public.profile_actor_uri(p.id))
      FROM public.profiles p WHERE p.id = p_profile_id;
$$;
REVOKE ALL ON FUNCTION public.profile_handle(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.request_my_data_export()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_profile uuid := public.get_current_profile_id();
    v_last timestamptz;
    v_today integer;
    v_export_id uuid;
    v_doc jsonb;
    v_media jsonb := '[]'::jsonb;
BEGIN
    IF v_uid IS NULL OR v_profile IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    SELECT max(e.requested_at), count(*) FILTER (WHERE e.requested_at > now() - interval '1 day')
      INTO v_last, v_today
      FROM public.account_data_exports e WHERE e.profile_id = v_profile;
    IF v_last > now() - interval '10 minutes' THEN
        RAISE SQLSTATE 'PT429' USING MESSAGE = 'export_rate_limited',
            DETAIL = 'retry_after=' || ceil(extract(epoch FROM v_last + interval '10 minutes' - now()))::bigint;
    END IF;
    IF v_today >= 5 THEN
        RAISE SQLSTATE 'PT429' USING MESSAGE = 'export_rate_limited',
            DETAIL = 'retry_after=' || ceil(extract(epoch FROM
                (SELECT min(e.requested_at) FROM public.account_data_exports e
                  WHERE e.profile_id = v_profile AND e.requested_at > now() - interval '1 day')
                + interval '1 day' - now()))::bigint;
    END IF;

    DELETE FROM public.account_data_exports e
     WHERE e.profile_id = v_profile AND e.requested_at < now() - interval '2 days';
    INSERT INTO public.account_data_exports (profile_id) VALUES (v_profile) RETURNING id INTO v_export_id;

    BEGIN
        SELECT coalesce(jsonb_agg(jsonb_build_object(
                   'bucket', o.bucket_id, 'name', o.name, 'created_at', o.created_at,
                   'size', o.metadata ->> 'size', 'mimetype', o.metadata ->> 'mimetype')
                   ORDER BY o.created_at), '[]'::jsonb)
          INTO v_media
          FROM storage.objects o
         WHERE o.bucket_id IN ('avatars', 'banners', 'user_media')
           AND (storage.foldername(o.name))[1] IN (v_uid::text, v_profile::text);
    EXCEPTION WHEN undefined_table OR undefined_function OR insufficient_privilege THEN
        v_media := '[]'::jsonb;
    END;

    v_doc := jsonb_build_object(
        'format', 'harmony-account-export',
        'version', 1,
        'export_id', v_export_id,
        'generated_at', now(),
        'account', (SELECT jsonb_build_object(
                        'auth_user_id', u.id, 'email', u.email,
                        'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at,
                        'confirmed_at', u.confirmed_at,
                        'providers', u.raw_app_meta_data -> 'providers')
                      FROM auth.users u WHERE u.id = v_uid),
        'two_factor', jsonb_build_object(
            'enabled', public.mfa_enabled_for(v_uid),
            'recovery_codes_remaining', (SELECT count(*) FROM public.mfa_recovery_codes r
                                          WHERE r.user_id IN (v_profile, v_uid) AND r.used_at IS NULL)),
        'sessions', (SELECT coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) FROM public.list_my_sessions() s),
        'profile', (SELECT to_jsonb(p) - 'web_handle' FROM public.profiles p WHERE p.id = v_profile),
        'notification_preferences', (SELECT to_jsonb(n) - 'id' - 'user_id'
                                       FROM public.notification_preferences n WHERE n.user_id = v_profile LIMIT 1),
        'notification_overrides', (SELECT coalesce(jsonb_agg(to_jsonb(n) - 'user_id'), '[]'::jsonb)
                                     FROM public.notification_channels n WHERE n.user_id = v_profile),
        'server_folders', (SELECT coalesce(jsonb_agg(to_jsonb(f) - 'user_id'), '[]'::jsonb)
                             FROM public.server_folders f WHERE f.user_id = v_profile),
        -- Whole row: production's user_servers lacks columns a fresh install has (nickname).
        'servers', (SELECT coalesce(jsonb_agg((to_jsonb(us) - 'id' - 'user_id') || jsonb_build_object(
                        'name', s.name, 'owner', s.owner = v_profile, 'ap_id', s.ap_id,
                        'host_domain', s.host_domain, 'is_local_server', s.is_local_server)
                        ORDER BY us.created_at), '[]'::jsonb)
                      FROM public.user_servers us
                      JOIN public.servers s ON s.id = us.server_id
                     WHERE us.user_id = v_profile),
        'servers_owned', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                              'id', s.id, 'name', s.name, 'description', s.description,
                              'created_at', s.created_at)), '[]'::jsonb)
                            FROM public.servers s WHERE s.owner = v_profile),
        'conversations', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                              'id', c.id, 'type', c.type, 'name', c.name, 'created_at', c.created_at,
                              'joined_at', cp.joined_at, 'left_at', cp.left_at,
                              'participants', (SELECT coalesce(jsonb_agg(public.profile_handle(o.user_id)), '[]'::jsonb)
                                                 FROM public.conversation_participants o
                                                WHERE o.conversation_id = c.id))
                              ORDER BY c.created_at), '[]'::jsonb)
                            FROM public.conversation_participants cp
                            JOIN public.conversations c ON c.id = cp.conversation_id
                           WHERE cp.user_id = v_profile),
        'posts', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                      'id', p.id, 'created_at', p.created_at, 'updated_at', p.updated_at,
                      'content', p.content, 'content_warning', p.content_warning,
                      'language', p.language, 'visibility', p.visibility,
                      'in_reply_to', p.in_reply_to, 'url', p.url, 'ap_id', p.ap_id,
                      'media_attachments', p.media_attachments,
                      'voice_attachments', p.voice_attachments, 'is_sensitive', p.is_sensitive,
                      'is_deleted', p.is_deleted, 'edit_history', p.edit_history,
                      'reblog', p.reblog, 'is_pinned', p.is_pinned) ORDER BY p.created_at), '[]'::jsonb)
                    FROM public.posts p WHERE p.author_id = v_profile),
        'post_interactions', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                                  'post_id', i.post_id, 'type', i.interaction_type,
                                  'emoji_id', i.emoji_id, 'emoji', i.custom_emoji_content,
                                  'created_at', i.created_at) ORDER BY i.created_at), '[]'::jsonb)
                                FROM public.post_interactions i WHERE i.user_id = v_profile),
        'reactions', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                          'message_id', r.message_id, 'emoji_id', r.emoji_id,
                          'emoji', r.custom_emoji_content, 'created_at', r.created_at)
                          ORDER BY r.created_at), '[]'::jsonb)
                        FROM public.reactions r WHERE r.user_id = v_profile),
        'following', (SELECT coalesce(jsonb_agg(public.profile_handle(f.following_id)
                          || jsonb_build_object('status', f.status, 'since', f.created_at)), '[]'::jsonb)
                        FROM public.follows f WHERE f.follower_id = v_profile),
        'followers', (SELECT coalesce(jsonb_agg(public.profile_handle(f.follower_id)
                          || jsonb_build_object('status', f.status, 'since', f.created_at)), '[]'::jsonb)
                        FROM public.follows f WHERE f.following_id = v_profile),
        'blocks', (SELECT coalesce(jsonb_agg(public.profile_handle(b.blocked_user_id)
                       || jsonb_build_object('since', b.created_at, 'reason', b.reason)), '[]'::jsonb)
                     FROM public.user_blocks b WHERE b.blocker_id = v_profile),
        'mutes', (SELECT coalesce(jsonb_agg(public.profile_handle(m.muted_user_id)
                      || jsonb_build_object('since', m.created_at, 'expires_at', m.expires_at)), '[]'::jsonb)
                    FROM public.user_mutes m WHERE m.muter_id = v_profile),
        'reports_filed', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                              'id', r.id, 'created_at', r.created_at, 'type', r.report_type,
                              'reason', r.reason, 'comment', r.comment, 'status', r.status,
                              'reported_user_id', r.reported_user_id,
                              'reported_post_id', r.reported_post_id,
                              'reported_message_id', r.reported_message_id,
                              'reported_server_id', r.reported_server_id,
                              'resolved_at', r.resolved_at) ORDER BY r.created_at), '[]'::jsonb)
                            FROM public.reports r WHERE r.reporter_id = v_profile),
        'bots', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                     'id', b.id, 'username', b.username, 'display_name', b.display_name,
                     'created_at', b.created_at, 'is_active', b.is_active)), '[]'::jsonb)
                   FROM public.bots b WHERE b.owner_id = v_profile),
        'media', v_media,
        'message_count', (SELECT count(*) FROM public.messages m
                           WHERE m.user_id = v_profile AND m.is_system IS NOT TRUE)
    );
    RETURN v_doc;
END;
$$;

REVOKE ALL ON FUNCTION public.request_my_data_export() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_my_data_export() TO authenticated;

-- ---------------------------------------------------------------------------
-- Ownership
-- ---------------------------------------------------------------------------

-- As in 20261005400001_account_security.sql: a definer created by supabase_admin would
-- call postgres-owned helpers whose PUBLIC grant is revoked.
DO $$
DECLARE
    fn regprocedure;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
        RAISE NOTICE 'postgres role absent, ownership left with %', current_user;
        RETURN;
    END IF;
    FOR fn IN
        SELECT p.oid::regprocedure
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN (
               'guard_profile_client_write', 'trigger_queue_profile_federation',
               'trigger_queue_follow_federation',
               'profile_actor_uri', 'profile_id_by_actor_uri', 'account_move_refusal',
               'apply_account_move', 'set_my_account_aliases', 'begin_account_move',
               'cancel_my_account_redirect', 'record_remote_account_move',
               'migrate_account_followers', 'carry_over_moved_membership', 'profile_handle',
               'request_my_data_export')
           AND pg_get_userbyid(p.proowner) <> 'postgres'
    LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', fn);
        RAISE NOTICE '% now owned by postgres', fn;
    END LOOP;
END;
$$;

ALTER TABLE public.account_migrations OWNER TO postgres;

COMMIT;

NOTIFY pgrst, 'reload schema';
