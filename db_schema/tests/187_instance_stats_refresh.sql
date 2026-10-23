-- 20261027700001_instance_stats_refresh.sql: record_instance_nodeinfo stores software, version,
-- users and local posts of a NodeInfo read. An admin-set software stands and keeps its version
-- current when NodeInfo names the same software; absent usage keeps the stored numbers.
--
-- spacify187: written by an admin refresh (no software_source), as the admin list writes it.
-- mony187: learned from NodeInfo before user and post counts were stored.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(13);

SELECT ok(NOT has_function_privilege('anon', 'public.record_instance_nodeinfo(text, text, text, bigint, bigint, boolean)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.record_instance_nodeinfo(text, text, text, bigint, bigint, boolean)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.record_instance_nodeinfo(text, text, text, bigint, bigint, boolean)', 'EXECUTE'),
  'only service callers execute record_instance_nodeinfo');
SELECT throws_ok(
    $q$SELECT public.record_instance_nodeinfo('x187.test', 'harmony', '1.0', 1, 1, true)$q$,
    '42501', NULL, 'a client cannot record NodeInfo')
  FROM (SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001')) a;
SELECT tests.clear_authentication();

INSERT INTO public.federated_instances (domain, software, version, user_count, status_count, metadata) VALUES
  ('spacify187.test', 'harmony', '1.7.4', 2, 37, '{"last_refresh": "2026-10-10T00:00:00Z", "added_by": "admin"}'),
  ('mony187.test', 'harmony', '1.8.10', 0, 0, '{"software_source": "nodeinfo", "software_checked_at": "2026-10-22T00:00:00Z"}'),
  ('pinned187.test', 'mastodon', '4.0.0', 10, 20, '{}'),
  ('unknown187.test', 'unknown', NULL, 0, 0, '{}');

SELECT is(public.record_instance_software('spacify187.test', 'harmony', '1.8.11', 'nodeinfo'), 'harmony',
  'record_instance_software answers with the admin''s software');
SELECT is((SELECT version FROM public.federated_instances WHERE domain = 'spacify187.test'), '1.7.4',
  'and leaves its version as the admin''s refresh wrote it');

SELECT is(public.record_instance_nodeinfo('Spacify187.TEST', 'Harmony', '1.8.11', 2, 37, true), 'harmony',
  'record_instance_nodeinfo answers with the admin''s software');
SELECT results_eq(
    $q$SELECT software, version, user_count, status_count, metadata ? 'software_source',
              metadata ? 'nodeinfo_read_at', metadata ? 'software_checked_at'
         FROM public.federated_instances WHERE domain = 'spacify187.test'$q$,
    $q$VALUES ('harmony'::text, '1.8.11'::text, 2, 37, false, true, true)$q$,
    'and refreshes its version and counts: NodeInfo names the same software; the software stays the admin''s');

SELECT is(public.record_instance_nodeinfo('mony187.test', 'harmony', '1.8.10', 2, 2, true), 'harmony',
  'a NodeInfo-learned software answers as is');
SELECT results_eq(
    $q$SELECT software, version, user_count, status_count, metadata->>'software_source'
         FROM public.federated_instances WHERE domain = 'mony187.test'$q$,
    $q$VALUES ('harmony'::text, '1.8.10'::text, 2, 2, 'nodeinfo'::text)$q$,
    'users.total and localPosts replace the zero counts');

SELECT public.record_instance_nodeinfo('mony187.test', 'harmony', '1.8.11', NULL, -1, true);
SELECT results_eq(
    $q$SELECT version, user_count, status_count
         FROM public.federated_instances WHERE domain = 'mony187.test'$q$,
    $q$VALUES ('1.8.11'::text, 2, 2)$q$,
    'absent or negative usage keeps the stored counts');

UPDATE public.federated_instances SET metadata = metadata - 'nodeinfo_read_at' WHERE domain = 'mony187.test';
SELECT is(public.record_instance_nodeinfo('mony187.test', NULL, NULL, NULL, NULL, true), 'harmony',
  'an unanswered read keeps the software');
SELECT results_eq(
    $q$SELECT software, version, user_count, status_count, metadata ? 'nodeinfo_read_at', metadata ? 'software_checked_at'
         FROM public.federated_instances WHERE domain = 'mony187.test'$q$,
    $q$VALUES ('harmony'::text, '1.8.11'::text, 2, 2, false, true)$q$,
    'and stamps the attempt alone');

SELECT results_eq(
    $q$SELECT public.record_instance_nodeinfo('pinned187.test', 'pleroma', '2.7.0', 5000000000, 30, true),
              public.record_instance_nodeinfo('unknown187.test', 'gotosocial', '0.19.0', 3, 4, true),
              public.record_instance_nodeinfo('absent187.test', 'misskey', '2025.4.0', 1, 1, false),
              public.record_instance_nodeinfo('new187.test', 'misskey', '2025.4.0', 1, 1, true)$q$,
    $q$VALUES ('mastodon'::text, 'gotosocial'::text, NULL::text, 'misskey'::text)$q$,
    'an admin''s other software stands; unknown is replaced; create false adds no row, create true does');
SELECT results_eq(
    $q$SELECT domain, software, version, user_count, status_count, metadata->>'software_source'
         FROM public.federated_instances
        WHERE domain IN ('pinned187.test', 'unknown187.test', 'absent187.test', 'new187.test')
        ORDER BY domain$q$,
    $q$VALUES ('new187.test'::text, 'misskey'::text, '2025.4.0'::text, 1, 1, 'nodeinfo'::text),
              ('pinned187.test'::text, 'mastodon'::text, '4.0.0'::text, 2147483647, 30, NULL::text),
              ('unknown187.test'::text, 'gotosocial'::text, '0.19.0'::text, 3, 4, 'nodeinfo'::text)$q$,
    'a version describes the software beside it; counts are clamped to integer range');

SELECT * FROM finish();
ROLLBACK;
