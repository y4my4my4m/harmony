-- Locked accounts: follow requests and their answers, as Mastodon handles them.
--
-- profiles.manually_approves_followers already held follows of a local account as pending, but
-- nothing set it, and the surrounding graph leaked or mishandled requests:
--   * A follow of a remote account was accepted on insert, before the remote side answered;
--     its Accept or Reject then had nothing to change. Mastodon keeps every remote follow a
--     request until the Accept arrives.
--   * A blocked account could follow its blocker, and a blocker the account it blocked.
--   * Pending and rejected rows were readable by anyone: who asked to follow whom, and who
--     turned whom down.
--   * Turning approval off left the waiting requests pending.
--   * Removing a remote follower sent nothing, so the remote side kept delivering to it.
--   * An inbound Reject deleted the row, and the delete queued an Undo back to the account
--     that had just rejected it.
--   * The follow-request notification outlived the request.
--   * Accepting a follower backfilled public and unlisted posts, not followers-only ones.
--   * A local account mentioned in a followers-only post was notified of a post it could
--     not read.
--
-- Changes:
--   guard_follow_client_write          the server decides the status of a client follow:
--                                      accepted for a local account without approval, pending
--                                      for a locked or remote one. A block in either direction
--                                      refuses it (42501), as Mastodon's FollowService does.
--   trigger_queue_follow_federation    on DELETE, no Undo for a rejected follow; a client
--                                      removing a remote follower (accepted or pending) queues
--                                      a 'respond' job with status rejected, which delivers a
--                                      Reject. Mirrors Mastodon RemoveFromFollowersService and
--                                      the Reject BlockService sends.
--   accept_pending_follows_on_unlock   turning manually_approves_followers off on a local
--                                      account accepts its pending requests; the existing
--                                      follows triggers send the Accepts, notify and backfill.
--                                      Mirrors Mastodon UpdateAccountService.
--   trigger_queue_profile_federation   manually_approves_followers changes federate the actor.
--   clear_follow_request_notification  a request withdrawn, accepted or rejected takes its
--                                      activitypub_follow_request notification with it.
--   add_existing_posts_to_new_follower_timeline
--                                      an accepted follow backfills followers-only posts.
--   follows_select_visible             replaces follows_select_all (USING true): an accepted
--                                      follow is public, a pending or rejected one is visible
--                                      to its two parties only.
--   posts_select_public                a followers-only post is also readable by a local
--                                      account it mentions, matched as the mention
--                                      notification triggers match it (isLocal, username).
--
-- Existing rows are left as they are: a remote follow stored accepted stays accepted, existing
-- followers of an account that locks stay followers.
--
-- Converges by state: functions are replaced, the policy and triggers dropped and recreated.

BEGIN;

-- ---------------------------------------------------------------------------
-- Client follows
-- ---------------------------------------------------------------------------

-- Sorts before trigger_federate_follow and trigger_federate_follow_response, which copy
-- NEW.status into the federation job.
CREATE OR REPLACE FUNCTION public.guard_follow_client_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid;
    v_manual boolean;
    v_target_local boolean;
BEGIN
    IF COALESCE(current_setting('role', true), '') NOT IN ('anon', 'authenticated')
       OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF EXISTS (SELECT 1 FROM public.user_blocks b
                    WHERE (b.blocker_id = NEW.following_id AND b.blocked_user_id = NEW.follower_id)
                       OR (b.blocker_id = NEW.follower_id AND b.blocked_user_id = NEW.following_id)) THEN
            RAISE EXCEPTION 'a block stands between these accounts'
                USING ERRCODE = '42501';
        END IF;

        SELECT p.manually_approves_followers, p.is_local
          INTO v_manual, v_target_local
          FROM public.profiles p
         WHERE p.id = NEW.following_id;

        NEW.status := CASE WHEN v_target_local IS TRUE AND v_manual IS NOT TRUE
                           THEN 'accepted' ELSE 'pending' END;
        NEW.accepted_at := CASE WHEN NEW.status = 'accepted' THEN now() END;
        NEW.ap_id := NULL;
        NEW.is_local := true;
        NEW.federation_status := 'pending';
        NEW.created_at := now();
        NEW.updated_at := now();
        RETURN NEW;
    END IF;

    IF NEW.follower_id IS DISTINCT FROM OLD.follower_id
       OR NEW.following_id IS DISTINCT FROM OLD.following_id
       OR NEW.ap_id IS DISTINCT FROM OLD.ap_id
       OR NEW.is_local IS DISTINCT FROM OLD.is_local
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.federation_status IS DISTINCT FROM OLD.federation_status
       OR NEW.metadata IS DISTINCT FROM OLD.metadata THEN
        RAISE EXCEPTION 'follow participants and federation fields are fixed'
            USING ERRCODE = '42501';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        v_caller := public.get_current_profile_id();
        IF v_caller IS NULL OR OLD.following_id IS DISTINCT FROM v_caller THEN
            RAISE EXCEPTION 'only the followed account answers a follow request'
                USING ERRCODE = '42501';
        END IF;
        IF OLD.status IS DISTINCT FROM 'pending'
           OR COALESCE(NEW.status, '') NOT IN ('accepted', 'rejected') THEN
            RAISE EXCEPTION 'a pending follow request is answered with accepted or rejected'
                USING ERRCODE = '42501';
        END IF;
        NEW.accepted_at := CASE WHEN NEW.status = 'accepted' THEN now() END;
    ELSE
        NEW.accepted_at := OLD.accepted_at;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_follow_client_write() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Follow federation
-- ---------------------------------------------------------------------------

-- NEW is null on DELETE: the follower is read from OLD there.
-- A rejected follow was answered by its target: no Undo follows it. A remote follower removed
-- by a client (the followee removing or blocking it) is sent a Reject; the row is gone when the
-- job runs, so the job carries ap_id. Service writes (inbound Undo, Block, Move) send nothing.
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
            IF OLD.status IS DISTINCT FROM 'rejected' THEN
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
        ELSIF v_follower_is_local = false
              AND OLD.status IN ('accepted', 'pending')
              AND COALESCE(current_setting('role', true), '') IN ('anon', 'authenticated')
              AND EXISTS (SELECT 1 FROM public.profiles p
                           WHERE p.id = OLD.following_id AND p.is_local = true) THEN
            PERFORM public.queue_federation_job(
                'federate-follow',
                jsonb_build_object(
                    'type', 'respond',
                    'follow_id', OLD.id,
                    'follower_id', OLD.follower_id,
                    'following_id', OLD.following_id,
                    'status', 'rejected',
                    'ap_id', OLD.ap_id
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

REVOKE ALL ON FUNCTION public.trigger_queue_follow_federation() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Unlocking accepts the waiting requests
-- ---------------------------------------------------------------------------

-- Runs at trigger depth 2, below guard_follow_client_write; trigger_federate_follow_response
-- queues the Accept of each remote request.
CREATE OR REPLACE FUNCTION public.accept_pending_follows_on_unlock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.is_local IS TRUE
       AND OLD.manually_approves_followers IS TRUE
       AND NEW.manually_approves_followers IS NOT TRUE THEN
        UPDATE public.follows
           SET status = 'accepted', accepted_at = now()
         WHERE following_id = NEW.id
           AND status = 'pending';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_pending_follows_on_unlock() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS accept_pending_follows_on_unlock_trigger ON public.profiles;
CREATE TRIGGER accept_pending_follows_on_unlock_trigger
    AFTER UPDATE OF manually_approves_followers ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.accept_pending_follows_on_unlock();

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
            OLD.moved_to_uri IS NOT DISTINCT FROM NEW.moved_to_uri AND
            OLD.manually_approves_followers IS NOT DISTINCT FROM NEW.manually_approves_followers
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

REVOKE ALL ON FUNCTION public.trigger_queue_profile_federation() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Follow-request notifications
-- ---------------------------------------------------------------------------

-- handle_unified_notification_processing stores the requester under data.follower_id.
CREATE OR REPLACE FUNCTION public.clear_follow_request_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.status IS DISTINCT FROM 'pending' THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'DELETE' OR NEW.status IS DISTINCT FROM 'pending' THEN
        DELETE FROM public.notifications n
         WHERE n.user_id = OLD.following_id
           AND n.type = 'activitypub_follow_request'
           AND n.data->>'follower_id' = OLD.follower_id::text;
    END IF;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_follow_request_notification() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS clear_follow_request_notification_trigger ON public.follows;
CREATE TRIGGER clear_follow_request_notification_trigger
    AFTER UPDATE OF status OR DELETE ON public.follows
    FOR EACH ROW
    EXECUTE FUNCTION public.clear_follow_request_notification();

-- ---------------------------------------------------------------------------
-- Timeline backfill
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.add_existing_posts_to_new_follower_timeline()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    IF NEW.status = 'pending' THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        SELECT NEW.follower_id, sub.id, 'home', EXTRACT(epoch FROM sub.created_at) * 1000000
        FROM (
            SELECT p.id, p.created_at
            FROM posts p
            WHERE p.author_id = NEW.following_id
              AND p.visibility = 'public'
              AND NOT COALESCE(p.is_deleted, false)
              AND p.created_at > NOW() - INTERVAL '7 days'
            ORDER BY p.created_at DESC
            LIMIT 50
        ) sub
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    ELSIF NEW.status = 'accepted' THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        SELECT NEW.follower_id, sub.id, 'home', EXTRACT(epoch FROM sub.created_at) * 1000000
        FROM (
            SELECT p.id, p.created_at
            FROM posts p
            WHERE p.author_id = NEW.following_id
              AND p.visibility IN ('public', 'unlisted', 'followers')
              AND NOT COALESCE(p.is_deleted, false)
              AND p.created_at > NOW() - INTERVAL '7 days'
            ORDER BY p.created_at DESC
            LIMIT 50
        ) sub
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.add_existing_posts_to_new_follower_timeline() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Read access
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS follows_select_all ON public.follows;
DROP POLICY IF EXISTS follows_select_visible ON public.follows;
CREATE POLICY follows_select_visible ON public.follows AS PERMISSIVE FOR SELECT TO public
    USING (
        status = 'accepted'
        OR follower_id = ( SELECT public.get_current_profile_id() )
        OR following_id = ( SELECT public.get_current_profile_id() )
    );

CREATE OR REPLACE FUNCTION public.current_profile_username()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT p.username
      FROM public.profiles p
     WHERE p.id = (SELECT public.get_current_profile_id());
$$;

-- posts_select_public applies to every role and executes as the querying role.
REVOKE ALL ON FUNCTION public.current_profile_username() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_profile_username() TO anon, authenticated, service_role;

ALTER POLICY "posts_select_public" ON public.posts
    USING (
        author_id = ( SELECT public.get_current_profile_id() )
        OR (
            author_id NOT IN ( SELECT public.current_user_block_peer_ids() )
            AND (
                visibility IN ('public', 'unlisted')
                OR (visibility = 'followers' AND (
                    EXISTS (
                        SELECT 1 FROM public.follows
                        WHERE follows.follower_id = ( SELECT public.get_current_profile_id() )
                          AND follows.following_id = posts.author_id
                          AND follows.status = 'accepted'
                    )
                    OR EXISTS (
                        SELECT 1 FROM jsonb_array_elements(posts.content) part
                        WHERE part->>'type' = 'mention'
                          AND part->>'isLocal' = 'true'
                          AND part->>'username' = ( SELECT public.current_profile_username() )
                    )
                ))
                OR (visibility = 'direct' AND EXISTS (
                    SELECT 1 WHERE posts.author_id = ( SELECT public.get_current_profile_id() )
                ))
            )
        )
    );

COMMIT;

NOTIFY pgrst, 'reload schema';
