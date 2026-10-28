-- create_comprehensive_timeline_entries wrote, for every public post, local or federated, one
-- 'public' timeline_entries row per local profile: local profiles x public posts. Nothing selects
-- them. The public, local and federated feeds read posts; broadcast_home_feed_entry returns on any
-- type but 'home'; create_report admits a public post before it consults timeline_entries. The
-- 'public' arm is removed.
--
-- 'home' rows stay: each INSERT fires trg_broadcast_home_feed_entry (home_feed:new_post on the
-- follower's user channel), and create_report counts one as having seen the post.
--
-- Rows of any type but 'home' are deleted in 256-block TID ranges (~20k rows at 81 rows per
-- page, measured on a seeded table), one transaction per range, so no row lock is held past its
-- range. Inside a transaction block (deploy-master.sh dry run, psql -1) a procedure cannot
-- COMMIT; there the first range is deleted and the rest left for an autocommit run. A second run
-- deletes nothing.
--
-- Deleting writes about one full-page image of WAL per 81 rows. Above 4M rows (pg_class estimate,
-- all types) the deletion is left to an operator with disk and WAL headroom in view, outside a
-- transaction block:
--   CALL public.delete_unread_timeline_entries(256);
--   VACUUM (ANALYZE) public.timeline_entries;
BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.create_comprehensive_timeline_entries()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    IF COALESCE(NEW.is_deleted, false) THEN
        RETURN NEW;
    END IF;

    IF NEW.is_local THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        VALUES (NEW.author_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000)
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    END IF;

    -- A pending follower sees public posts only.
    IF NEW.visibility = 'public' THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        SELECT f.follower_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000
        FROM follows f
        JOIN profiles p ON f.follower_id = p.id
        WHERE f.following_id = NEW.author_id
          AND f.status IN ('accepted', 'pending')
          AND p.is_local = true
          AND f.follower_id != NEW.author_id
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    ELSIF NEW.visibility IN ('unlisted', 'followers') THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        SELECT f.follower_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000
        FROM follows f
        JOIN profiles p ON f.follower_id = p.id
        WHERE f.following_id = NEW.author_id
          AND f.status = 'accepted'
          AND p.is_local = true
          AND f.follower_id != NEW.author_id
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.create_comprehensive_timeline_entries() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_comprehensive_timeline_entries() TO service_role;

COMMIT;

-- No SET clause and no SECURITY DEFINER: either forbids COMMIT in a procedure.
-- transaction_timestamp() equals statement_timestamp() only when CALL opened its own transaction.
CREATE OR REPLACE PROCEDURE public.delete_unread_timeline_entries(p_blocks integer)
LANGUAGE plpgsql
AS $$
DECLARE
    v_atomic boolean := transaction_timestamp() <> statement_timestamp();
    v_block_size bigint := current_setting('block_size')::bigint;
    v_pages bigint;
    v_from bigint := 0;
    v_lo tid;
    v_hi tid;
    v_rows bigint;
    v_total bigint := 0;
BEGIN
    -- Re-read per range: pages appended during the walk are walked too.
    LOOP
        v_pages := pg_relation_size('public.timeline_entries') / v_block_size;
        EXIT WHEN v_from >= v_pages;
        v_lo := format('(%s,0)', v_from)::tid;
        v_hi := format('(%s,0)', v_from + p_blocks)::tid;
        DELETE FROM public.timeline_entries
         WHERE ctid >= v_lo AND ctid < v_hi
           AND timeline_type IS DISTINCT FROM 'home';
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        v_total := v_total + v_rows;
        v_from := v_from + p_blocks;
        IF v_atomic THEN
            RAISE NOTICE 'timeline_entries: inside a transaction block; % rows deleted from blocks 0-%, % of % blocks left',
                v_total, least(v_from, v_pages) - 1, greatest(v_pages - v_from, 0), v_pages;
            RETURN;
        END IF;
        COMMIT;
    END LOOP;
    RAISE NOTICE 'timeline_entries: % rows deleted across % blocks', v_total, v_pages;
END;
$$;

REVOKE ALL ON PROCEDURE public.delete_unread_timeline_entries(integer) FROM PUBLIC, anon, authenticated, service_role;

-- A range blocked by another writer's row lock fails the CALL instead of queueing writers behind it.
SET lock_timeout = '10s';

-- reltuples is -1 before the first ANALYZE; pages x 81 stands in.
DO $$
DECLARE
    v_rows double precision;
BEGIN
    SELECT CASE WHEN c.reltuples >= 0 THEN c.reltuples
                ELSE pg_relation_size(c.oid) / current_setting('block_size')::bigint * 81 END
      INTO v_rows
      FROM pg_class c
     WHERE c.oid = 'public.timeline_entries'::regclass;
    IF v_rows > 4000000 THEN
        RAISE NOTICE 'timeline_entries holds about % rows; unread rows left in place. Outside a transaction block: CALL public.delete_unread_timeline_entries(256); VACUUM (ANALYZE) public.timeline_entries;',
            v_rows::bigint;
    ELSE
        CALL public.delete_unread_timeline_entries(256);
    END IF;
END;
$$;

RESET lock_timeout;
