-- Reconciles cleanup_dead_endpoint_users between init/ and migrations/.
--
-- The difference is one RAISE NOTICE per cleaned profile, naming the user and
-- the number of follow rows removed. init/ has it; the body left by
-- 20260310_backfill_archives.sql does not, while still computing
-- v_follows_removed via GET DIAGNOSTICS and then discarding it.
--
-- init/ is carried over. This function deletes follow rows in both directions
-- and nulls a profile's inbox_url, and it runs from a trigger --
-- trigger_cleanup_dead_endpoint on federation_endpoints -- rather than from an
-- operator's session, so the log line is the only record of what it removed.
--
-- RECONCILE.md classed it "superseded anyway - revoke candidate". That is
-- wrong: trigger_cleanup_dead_endpoint calls it, that trigger is bound in
-- 40_triggers.sql, and it does not appear in UNREACHABLE.tsv. It is live.

BEGIN;

CREATE OR REPLACE FUNCTION public.cleanup_dead_endpoint_users(p_endpoint_url text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_dead_profiles RECORD;
    v_follows_removed integer := 0;
BEGIN
    FOR v_dead_profiles IN
        SELECT id, username, domain, inbox_url, shared_inbox_url
        FROM profiles
        WHERE (inbox_url = p_endpoint_url OR shared_inbox_url = p_endpoint_url)
        AND is_local = false
    LOOP
        DELETE FROM follows WHERE following_id = v_dead_profiles.id;
        GET DIAGNOSTICS v_follows_removed = ROW_COUNT;
        DELETE FROM follows WHERE follower_id = v_dead_profiles.id;

        UPDATE profiles SET
            inbox_url = NULL, shared_inbox_url = NULL, updated_at = NOW()
        WHERE id = v_dead_profiles.id;

        RAISE NOTICE 'Cleaned up dead user: %@% (removed % follows)',
            v_dead_profiles.username, v_dead_profiles.domain, v_follows_removed;
    END LOOP;
END;
$$;

COMMIT;
