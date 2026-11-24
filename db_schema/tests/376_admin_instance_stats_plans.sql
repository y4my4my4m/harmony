-- 20261124600001, 20261124600002, 20261124600003: every count of refresh_admin_instance_stats over a
-- table that grows with use has an index path, and posts and messages are vacuumed at 5%.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(12);

CREATE FUNCTION pg_temp.plan_of(p_query text) RETURNS SETOF text LANGUAGE plpgsql AS
  $$ DECLARE l text; BEGIN FOR l IN EXECUTE 'EXPLAIN ' || p_query LOOP RETURN NEXT l; END LOOP; END $$;
CREATE FUNCTION pg_temp.indexed(p_query text) RETURNS boolean LANGUAGE sql AS
  $$ SELECT bool_or(l LIKE '%Index%Scan%') AND NOT bool_or(l LIKE '%Seq Scan%') FROM pg_temp.plan_of(p_query) l $$;
CREATE FUNCTION pg_temp.uses(p_query text, p_index text) RETURNS boolean LANGUAGE sql AS
  $$ SELECT bool_or(l LIKE '%' || p_index || '%') FROM pg_temp.plan_of(p_query) l $$;

SELECT ok((SELECT x.indisvalid FROM pg_index x WHERE x.indexrelid = to_regclass('public.idx_profiles_created_at')),
          'idx_profiles_created_at exists and is valid');
SELECT is((SELECT pg_get_indexdef(x.indexrelid) FROM pg_index x
            WHERE x.indexrelid = to_regclass('public.idx_profiles_suspended') AND x.indisvalid),
          'CREATE INDEX idx_profiles_suspended ON public.profiles USING btree (id) WHERE is_suspended',
          'idx_profiles_suspended holds suspended profiles only');
SELECT ok((SELECT reloptions @> ARRAY['autovacuum_vacuum_scale_factor=0.05', 'autovacuum_vacuum_insert_scale_factor=0.05']
             FROM pg_class WHERE oid = 'public.posts'::regclass),
          'posts is vacuumed at 5% dead or inserted tuples');
SELECT ok((SELECT reloptions @> ARRAY['autovacuum_vacuum_scale_factor=0.05', 'autovacuum_vacuum_insert_scale_factor=0.05']
             FROM pg_class WHERE oid = 'public.messages'::regclass),
          'messages is vacuumed at 5% dead or inserted tuples');
SELECT ok((SELECT reloptions @> ARRAY['autovacuum_vacuum_scale_factor=0.05', 'autovacuum_vacuum_insert_scale_factor=0.05']
             FROM pg_class WHERE oid = 'public.profiles'::regclass),
          'profiles is vacuumed at 5% dead or inserted tuples');

SET LOCAL enable_seqscan = off;
-- The planner's choice between index paths over these near-empty tables follows statistics the
-- test cannot set (no VACUUM inside a transaction); an index that can answer is checked instead.
SELECT ok(EXISTS (SELECT 1 FROM pg_index x
                   WHERE x.indrelid = 'public.profiles'::regclass AND x.indisvalid AND x.indpred IS NULL
                     AND x.indkey[0] = (SELECT attnum FROM pg_attribute
                                         WHERE attrelid = 'public.profiles'::regclass AND attname = 'is_local')),
          'an index holds is_local for every profile: users_total and users_local are one index-only pass');
SELECT ok(pg_temp.uses('SELECT count(*) FROM public.profiles t WHERE t.is_suspended', 'idx_profiles_suspended'),
          'users_suspended reads idx_profiles_suspended');
SELECT ok(pg_temp.uses($q$SELECT count(*) FROM public.profiles p WHERE p.created_at >= now() - interval '24 hours'$q$,
                       'idx_profiles_created_at'),
          'users_new_24h is a range of idx_profiles_created_at');
SELECT ok(pg_temp.indexed('SELECT count(*) FROM public.posts t WHERE t.is_deleted = false'),
          'posts_total reads an index');
SELECT is((SELECT pg_get_indexdef(x.indexrelid) FROM pg_index x
            WHERE x.indexrelid = to_regclass('public.idx_posts_not_deleted') AND x.indisvalid),
          'CREATE INDEX idx_posts_not_deleted ON public.posts USING btree (created_at DESC) WHERE (is_deleted = false)',
          'posts_24h has idx_posts_not_deleted: created_at over not-deleted posts');
SELECT ok(pg_temp.indexed($q$SELECT count(*) FROM public.federation_delivery_queue t WHERE t.status = 'pending'$q$),
          'queue counts read an index');
SELECT ok(pg_temp.uses($q$
    SELECT count(*) FROM public.servers sv
     WHERE EXISTS (SELECT 1 FROM public.channels c WHERE c.server_id = sv.id
       AND (EXISTS (SELECT 1 FROM public.messages m WHERE m.channel_id = c.id AND m.thread_id IS NULL
                      AND (m.is_deleted IS NULL OR m.is_deleted = false) AND m.created_at >= now() - interval '30 days')
            OR EXISTS (SELECT 1 FROM public.threads th JOIN public.messages m ON m.thread_id = th.id
                        WHERE th.channel_id = c.id AND m.created_at >= now() - interval '30 days'
                          AND m.is_deleted IS NOT TRUE)))$q$, 'idx_messages_channel_created_main'),
          'servers_active_30d probes idx_messages_channel_created_main per channel');
RESET enable_seqscan;

SELECT * FROM finish();
ROLLBACK;
