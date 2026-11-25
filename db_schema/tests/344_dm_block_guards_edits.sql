-- Edits in a blocked direct conversation, after 20261123500002_dm_block_guards_edits.sql.
--
--   alice  blocks bob; wrote fixture message 9999 in the DM
--   bob    wrote m1 in the DM and m2 in group g1 before the block
--   carol  c344 account, in g1
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(14);
-- Rolled back with the file: an assertion runs as service_role below.
GRANT USAGE ON SCHEMA tests TO service_role;

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('c3440000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol344@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('c3441000-0000-0000-0000-00000000000c', 'c3440000-0000-0000-0000-00000000000c', 'carol344', 'Carol', true);
INSERT INTO public.conversations (id, type, name, created_by) VALUES
  ('c3442000-0000-0000-0000-000000000001', 'group', 'g1', 'c3441000-0000-0000-0000-00000000000c');
INSERT INTO public.conversation_participants (conversation_id, user_id, role) VALUES
  ('c3442000-0000-0000-0000-000000000001', 'c3441000-0000-0000-0000-00000000000c', 'admin'),
  ('c3442000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'member'),
  ('c3442000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', 'member');

INSERT INTO public.messages (id, conversation_id, user_id, content) VALUES
  ('c3443000-0000-0000-0000-000000000001', '77777777-0000-0000-0000-000000000007',
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"before"}]'),
  ('c3443000-0000-0000-0000-000000000002', 'c3442000-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"group before"}]');

CREATE FUNCTION pg_temp.edit(p_id uuid, p_text text) RETURNS text LANGUAGE sql AS $$
  SELECT format($f$UPDATE public.messages SET content = '[{"type":"text","text":%s}]' WHERE id = %L$f$,
                to_json(p_text)::text, p_id);
$$;

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(pg_temp.edit('c3443000-0000-0000-0000-000000000001', 'edited'), 'bob edits his direct message');
RESET ROLE;
SELECT tests.clear_authentication();

INSERT INTO public.user_blocks (blocker_id, blocked_user_id) VALUES
  ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002');

-- Blocked --------------------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(pg_temp.edit('c3443000-0000-0000-0000-000000000001', 'edited while blocked'),
                 'P0001'::char(5), 'DM_UNDELIVERABLE', 'the blocked account cannot edit its earlier direct message');
SELECT throws_ok($q$UPDATE public.messages SET encrypted = true,
                        encryption_metadata = '{"algorithm": "megolm"}'
                     WHERE id = 'c3443000-0000-0000-0000-000000000001'$q$,
                 'P0001'::char(5), 'DM_UNDELIVERABLE', 'nor replace it with ciphertext');
SELECT lives_ok($q$UPDATE public.messages SET metadata = '{"note": "kept"}'
                    WHERE id = 'c3443000-0000-0000-0000-000000000001'$q$,
                'a change that shows nothing new passes');
SELECT lives_ok(pg_temp.edit('c3443000-0000-0000-0000-000000000002', 'group edit'),
                'it edits in a group the blocker is in, as it writes there');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(pg_temp.edit('99999999-0000-0000-0000-000000000009', 'blocker edit'),
                 'P0001'::char(5), 'DM_UNDELIVERABLE', 'the blocker cannot edit either');
RESET ROLE;
SELECT tests.clear_authentication();
SET LOCAL role service_role;
SELECT throws_ok(pg_temp.edit('c3443000-0000-0000-0000-000000000001', 'service edit'),
                 'P0001'::char(5), 'DM_UNDELIVERABLE', 'an edit by the service role is refused the same');
RESET ROLE;
SELECT is((SELECT content->0->>'text' FROM public.messages WHERE id = 'c3443000-0000-0000-0000-000000000001'),
          'edited', 'the stored text is the last one before the block');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$UPDATE public.messages SET content = '[{"type":"text","text":"[deleted]"}]', is_deleted = true
                    WHERE id = 'c3443000-0000-0000-0000-000000000001'$q$,
                'the blocked account still deletes its message');
RESET ROLE;
SELECT tests.clear_authentication();
SELECT ok((SELECT is_deleted FROM public.messages WHERE id = 'c3443000-0000-0000-0000-000000000001'),
          'and the deletion is stored');
SELECT lives_ok($q$UPDATE public.messages SET is_pinned = true WHERE id = '99999999-0000-0000-0000-000000000009'$q$,
                'an update of other fields passes');

-- Unblocked and expired ------------------------------------------------------------------------------
DELETE FROM public.user_blocks WHERE blocker_id = '11111111-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(pg_temp.edit('99999999-0000-0000-0000-000000000009', 'after unblock'), 'after the unblock alice edits');
RESET ROLE;
SELECT tests.clear_authentication();
INSERT INTO public.user_blocks (blocker_id, blocked_user_id, expires_at) VALUES
  ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', now() - interval '1 minute');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(pg_temp.edit('99999999-0000-0000-0000-000000000009', 'after expiry'), 'an expired block refuses no edit');
RESET ROLE;
SELECT tests.clear_authentication();
SELECT is((SELECT content->0->>'text' FROM public.messages WHERE id = '99999999-0000-0000-0000-000000000009'),
          'after expiry', 'the edit is stored');

SELECT * FROM finish();
ROLLBACK;
