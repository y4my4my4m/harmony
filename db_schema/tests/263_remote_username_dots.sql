-- 20261111300001_remote_username_dots.sql: remote usernames take "." and "-"; local usernames
-- keep guard_local_username's rule.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(7);

SELECT is((SELECT count(*)::int FROM pg_constraint
            WHERE conrelid = 'public.profiles'::regclass AND conname = 'profiles_username_check'), 0,
          'profiles carries no username character check');

SELECT lives_ok($q$
  INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id) VALUES
    ('e2630000-0000-0000-0000-000000000001', 'hltv-mirror.eurosky.social', 'HLTV.org mirror', false,
     'bsky.brid.gy', 'https://bsky.brid.gy/ap/did:plc:tgf3lkiolj2p5f34fsoj5qoc')
$q$, 'a bridged Bluesky account is stored');

SELECT is((SELECT web_handle FROM public.profiles WHERE id = 'e2630000-0000-0000-0000-000000000001'),
          '@hltv-mirror.eurosky.social@bsky.brid.gy', 'its handle names the dotted user');

SELECT is((SELECT handle FROM public.search_federated_users('hltv-mirror.eurosky.social@bsky.brid.gy', 10)
            WHERE user_id = 'e2630000-0000-0000-0000-000000000001'),
          public.get_user_handle('e2630000-0000-0000-0000-000000000001'),
          'the stored search finds it by its full handle');

SELECT throws_ok($q$
  INSERT INTO public.profiles (id, username, display_name, is_local)
  VALUES ('e2630000-0000-0000-0000-000000000002', 'john.doe', 'John', true)
$q$, '23514', NULL, 'a local username takes no dot');

SELECT throws_ok($q$
  UPDATE public.profiles SET username = 'jo-hn' WHERE id = '11111111-0000-0000-0000-000000000001'
$q$, '23514', NULL, 'nor a hyphen on rename');

SELECT throws_ok($q$
  INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id) VALUES
    ('e2630000-0000-0000-0000-000000000003', repeat('a', 65), 'Long', false,
     'far.example', 'https://far.example/users/long')
$q$, '23514', NULL, 'a remote username stays within 64 characters');

SELECT * FROM finish();
ROLLBACK;
