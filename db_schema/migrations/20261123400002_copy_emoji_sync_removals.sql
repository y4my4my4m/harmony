-- A copy's emoji the Group's list dropped, told apart from an instance admin's removal by a mark of
-- its own (federation-backend services/CopyMirrorService.ts applyGroupEmojis).
--
--   emojis.ap_removed_at   equals deleted_at exactly when the copy sync set both: the Group's list
--                          no longer names the emoji. remove_emoji and restore_emoji do not write
--                          it, so a later removal by a person has another deleted_at and the mark
--                          no longer matches. A removed row without a matching mark is a person's
--                          removal, whatever deleted_by holds: deleted_by is ON DELETE SET NULL,
--                          and an admin's removal outlives the admin's account. The mark stays
--                          through detach_copy_emojis. As emojis.bridge_removed_at
--                          (20261112500001) for the Discord bridge.
--   Backfill               rows the sync could have dropped and that hold no remover (deleted_by
--                          NULL): a copy's mirrored rows, and rows without a server (detached or
--                          cached) of scope server. Before this file a removal without deleted_by
--                          read as the sync's drop, so these keep reading as one; an admin's
--                          removal whose account was deleted before this file stays undone.
--                          Instance imports (scope instance) take no mark: the sync never drops
--                          one.
--   evict_copy_emojis      as 20261115900001; the dropped rows are those with the mark, not those
--                          without deleted_by.
--
-- Body otherwise, volatility, owner and grants of evict_copy_emojis as 20261115900001 and
-- 20261115700001.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.emojis ADD COLUMN IF NOT EXISTS ap_removed_at timestamptz;

COMMENT ON COLUMN public.emojis.ap_removed_at IS
'Set with deleted_at by the copy sync when the Group''s list drops the emoji; equal to deleted_at exactly while that drop stands.';

DO $$
DECLARE
    v_quiet boolean := false;
BEGIN
    -- The rows update with their triggers off (session_replication_role replica, superuser only):
    -- broadcast_emoji_change would send emoji:update to every member of each copy for a column no
    -- client reads. Without a superuser the triggers run.
    BEGIN
        PERFORM set_config('session_replication_role', 'replica', true);
        v_quiet := true;
    EXCEPTION WHEN insufficient_privilege THEN
        v_quiet := false;
    END;
    UPDATE public.emojis e
       SET ap_removed_at = e.deleted_at
     WHERE e.deleted_at IS NOT NULL
       AND e.deleted_by IS NULL
       AND e.ap_removed_at IS NULL
       AND e.scope = 'server'
       AND (e.ap_id IS NOT NULL OR e.server_id IS NULL);
    IF v_quiet THEN
        PERFORM set_config('session_replication_role', 'origin', true);
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.evict_copy_emojis(p_server_id uuid, p_keep integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_count integer;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.is_local_server IS FALSE) THEN
        RETURN 0;
    END IF;
    -- Emojis the copy's list dropped (ap_removed_at = deleted_at), past the most recent p_keep, at
    -- most 1000 a call. A row inserted within the hour stays, so the copy's hourly insert count
    -- holds; a row something names (a reaction, a post reaction, a sound, an import) stays, as rows
    -- a copy took over from the activity cache are named elsewhere. Rows are ranked first and
    -- filtered after, so rows that stay do not take the places of rows that go.
    WITH ranked AS (
        SELECT e.id, e.created_at,
               row_number() OVER (ORDER BY e.deleted_at DESC, e.id) AS rn
          FROM public.emojis e
         WHERE e.server_id = p_server_id AND e.ap_id IS NOT NULL
           AND e.deleted_at IS NOT NULL AND e.ap_removed_at = e.deleted_at
    ),
    evictable AS (
        SELECT r.id
          FROM ranked r
         WHERE r.rn > GREATEST(COALESCE(p_keep, 0), 0)
           AND r.created_at < now() - interval '1 hour'
           AND NOT EXISTS (SELECT 1 FROM public.reactions x WHERE x.emoji_id = r.id)
           AND NOT EXISTS (SELECT 1 FROM public.post_interactions pi WHERE pi.emoji_id = r.id)
           AND NOT EXISTS (SELECT 1 FROM public.server_sounds ss WHERE ss.emoji_id = r.id)
           AND NOT EXISTS (SELECT 1 FROM public.remote_emojis_cache c WHERE c.imported_as = r.id)
         LIMIT 1000
    )
    DELETE FROM public.emojis e
     USING evictable v
     WHERE e.id = v.id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.evict_copy_emojis(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evict_copy_emojis(uuid, integer) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
