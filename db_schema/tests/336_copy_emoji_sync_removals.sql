-- 20261123400002_copy_emoji_sync_removals.sql: the copy sync's drops carry ap_removed_at equal to
-- deleted_at; any other removal is a person's, also once deleted_by is cleared, and
-- evict_copy_emojis deletes only the sync's drops.
--
--   copy336    a server reference (is_local_server false) of remote.test
--   admin336   an instance admin, deleted after removing emoji 01
--   01         removed by admin336                                  kept
--   02         dropped by the sync                                  evicted
--   03         dropped by the sync, restored, then removed by alice kept
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(9);

SELECT has_column('public', 'emojis', 'ap_removed_at', 'emojis.ap_removed_at exists');

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('e3360000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin336@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, is_admin) VALUES
  ('e3360000-0000-0000-0000-0000000000c1', 'e3360000-0000-0000-0000-0000000000a1', 'admin336', 'Admin 336', true, true);
INSERT INTO public.profiles (id, username, display_name, domain, federated_id, is_local)
VALUES ('e3360000-0000-0000-0000-0000000000e1', 'remote336', 'Remote 336', 'remote.test', 'https://remote.test/users/remote336', false);
INSERT INTO public.servers (id, name, owner, is_local_server, federation_enabled, host_domain, ap_id)
VALUES ('e3360000-0000-0000-0000-0000000000f0', 'Copy 336', 'e3360000-0000-0000-0000-0000000000e1', false, true,
        'remote.test', 'https://remote.test/servers/e3360000-0000-0000-0000-0000000000f0');
INSERT INTO public.emojis (id, name, url, server_id, scope, domain, ap_id, created_at)
SELECT ('e3360000-0000-0000-0000-0000000001' || lpad(n::text, 2, '0'))::uuid, 'e336_' || n,
       'https://remote.test/e/' || n || '.webp', 'e3360000-0000-0000-0000-0000000000f0', 'server', 'remote.test',
       'https://remote.test/servers/e3360000-0000-0000-0000-0000000000f0/emojis/' || n, now() - interval '3 hours'
  FROM generate_series(1, 3) AS n;
UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';

-- 01: an instance admin removes it, then the admin's account is deleted.
SELECT tests.authenticate_as('e3360000-0000-0000-0000-0000000000a1');
SELECT lives_ok($q$SELECT public.remove_emoji('e3360000-0000-0000-0000-000000000101')$q$, 'admin336 removes 01');
SELECT tests.clear_authentication();
DELETE FROM public.profiles WHERE id = 'e3360000-0000-0000-0000-0000000000c1';
SELECT results_eq(
    $q$SELECT deleted_at IS NOT NULL, deleted_by, ap_removed_at FROM public.emojis WHERE id = 'e3360000-0000-0000-0000-000000000101'$q$,
    $q$VALUES (true, NULL::uuid, NULL::timestamptz)$q$,
    'the removal outlives its remover: deleted_by is cleared, no mark is set');

-- 02, 03: the sync drops them (as CopyMirrorService.applyGroupEmojis writes it).
UPDATE public.emojis
   SET deleted_at = now() - interval '2 hours', deleted_by = NULL, ap_removed_at = now() - interval '2 hours'
 WHERE id IN ('e3360000-0000-0000-0000-000000000102', 'e3360000-0000-0000-0000-000000000103');

-- 03: alice restores it and removes it again; neither writes the mark.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.restore_emoji('e3360000-0000-0000-0000-000000000103')$q$, 'alice restores 03');
SELECT lives_ok($q$SELECT public.remove_emoji('e3360000-0000-0000-0000-000000000103')$q$, 'and removes it');
SELECT tests.clear_authentication();
SELECT ok((SELECT deleted_at IS NOT NULL AND ap_removed_at IS DISTINCT FROM deleted_at
             FROM public.emojis WHERE id = 'e3360000-0000-0000-0000-000000000103'),
  'the old mark no longer matches the new removal');

SELECT is(public.evict_copy_emojis('e3360000-0000-0000-0000-0000000000f0', 0), 1, 'one dropped emoji is evicted');
SELECT is((SELECT array_agg(right(id::text, 2) ORDER BY id) FROM public.emojis WHERE server_id = 'e3360000-0000-0000-0000-0000000000f0'),
          ARRAY['01', '03'], 'the removals by people stay, the one whose remover is gone included');
SELECT ok(NOT has_function_privilege('authenticated', 'public.evict_copy_emojis(uuid, integer)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.evict_copy_emojis(uuid, integer)', 'EXECUTE'),
          'eviction is for the service role alone');

SELECT * FROM finish();
ROLLBACK;
