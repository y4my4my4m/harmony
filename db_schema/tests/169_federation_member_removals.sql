-- 20261025200001_federation_member_removals.sql: a local server that turns federation off removes
-- its members from other instances, each with a federation_member_removals row for the Group's
-- Remove, and posts no "has left" message; local members stay, turning federation on again brings
-- nobody back, and a server reference of another instance removes nobody. A kick or ban of a
-- remote member records one too; of a local member, none. The table and the function are the
-- service role's only.
--
--   s168     local, federation on: rm168a (remote.test) accepted, rm168b (other.test) pending,
--            bob accepted
--   k168     local, federation on: rm168a and bob accepted, alice owner
--   ref168   a server reference (is_local_server false), rm168a accepted

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(15);

INSERT INTO public.profiles (id, username, display_name, domain, federated_id, inbox_url, is_local)
VALUES
  ('f1680000-0000-0000-0000-000000000001', 'rm168a', 'rm168a', 'remote.test',
   'https://remote.test/users/rm168a', 'https://remote.test/users/rm168a/inbox', false),
  ('f1680000-0000-0000-0000-000000000002', 'rm168b', 'rm168b', 'other.test',
   'https://other.test/users/rm168b', 'https://other.test/users/rm168b/inbox', false);

INSERT INTO public.servers (id, name, owner, public, federation_enabled, is_local_server)
VALUES
  ('f1680000-0000-0000-0000-0000000000a1', 'Closing', '11111111-0000-0000-0000-000000000001', true, true, true),
  ('f1680000-0000-0000-0000-0000000000a2', 'Kicking', '11111111-0000-0000-0000-000000000001', true, true, true),
  ('f1680000-0000-0000-0000-0000000000a3', 'Elsewhere', '11111111-0000-0000-0000-000000000001', true, true, false);

INSERT INTO public.user_servers (server_id, user_id, status)
VALUES
  ('f1680000-0000-0000-0000-0000000000a1', 'f1680000-0000-0000-0000-000000000001', 'accepted'),
  ('f1680000-0000-0000-0000-0000000000a1', 'f1680000-0000-0000-0000-000000000002', 'pending'),
  ('f1680000-0000-0000-0000-0000000000a1', '22222222-0000-0000-0000-000000000002', 'accepted'),
  ('f1680000-0000-0000-0000-0000000000a2', 'f1680000-0000-0000-0000-000000000001', 'accepted'),
  ('f1680000-0000-0000-0000-0000000000a2', '22222222-0000-0000-0000-000000000002', 'accepted'),
  ('f1680000-0000-0000-0000-0000000000a3', 'f1680000-0000-0000-0000-000000000001', 'accepted')
ON CONFLICT DO NOTHING;

CREATE TEMP TABLE system_before AS
SELECT m.id FROM public.messages m JOIN public.channels c ON c.id = m.channel_id
 WHERE c.server_id = 'f1680000-0000-0000-0000-0000000000a1' AND m.is_system IS TRUE;

-- Federation off.
UPDATE public.servers SET federation_enabled = false WHERE id = 'f1680000-0000-0000-0000-0000000000a1';

SELECT is(
  (SELECT array_agg(profile_id ORDER BY profile_id)::text FROM public.federation_member_removals
    WHERE server_id = 'f1680000-0000-0000-0000-0000000000a1' AND reason = 'federation_closed' AND delivered_at IS NULL),
  ARRAY['f1680000-0000-0000-0000-000000000001', 'f1680000-0000-0000-0000-000000000002']::uuid[]::text,
  'federation off: a removal row for each member from another instance, accepted or pending');
SELECT is(
  (SELECT count(*)::int FROM public.user_servers us JOIN public.profiles p ON p.id = us.user_id
    WHERE us.server_id = 'f1680000-0000-0000-0000-0000000000a1' AND p.is_local IS FALSE),
  0, 'federation off: their memberships are gone');
SELECT ok(
  EXISTS (SELECT 1 FROM public.user_servers WHERE server_id = 'f1680000-0000-0000-0000-0000000000a1'
            AND user_id = '22222222-0000-0000-0000-000000000002' AND status = 'accepted'),
  'federation off: a local member stays');
SELECT is(
  (SELECT count(*)::int FROM public.messages m JOIN public.channels c ON c.id = m.channel_id
    WHERE c.server_id = 'f1680000-0000-0000-0000-0000000000a1' AND m.is_system IS TRUE
      AND m.id NOT IN (SELECT id FROM system_before)),
  0, 'federation off: no "has left" message for the removed members');

UPDATE public.servers SET name = 'Closed' WHERE id = 'f1680000-0000-0000-0000-0000000000a1';
UPDATE public.servers SET federation_enabled = false WHERE id = 'f1680000-0000-0000-0000-0000000000a1';
SELECT is(
  (SELECT count(*)::int FROM public.federation_member_removals WHERE server_id = 'f1680000-0000-0000-0000-0000000000a1'),
  2, 'an update that leaves federation off removes nothing again');

UPDATE public.servers SET federation_enabled = true WHERE id = 'f1680000-0000-0000-0000-0000000000a1';
SELECT is(
  (SELECT count(*)::int FROM public.user_servers us JOIN public.profiles p ON p.id = us.user_id
    WHERE us.server_id = 'f1680000-0000-0000-0000-0000000000a1' AND p.is_local IS FALSE),
  0, 'federation on again: nobody is brought back');

-- A server reference of another instance.
UPDATE public.servers SET federation_enabled = false WHERE id = 'f1680000-0000-0000-0000-0000000000a3';
SELECT is(
  (SELECT count(*)::int FROM public.federation_member_removals WHERE server_id = 'f1680000-0000-0000-0000-0000000000a3'),
  0, 'a server reference of another instance removes nobody');
SELECT ok(
  EXISTS (SELECT 1 FROM public.user_servers WHERE server_id = 'f1680000-0000-0000-0000-0000000000a3'
            AND user_id = 'f1680000-0000-0000-0000-000000000001'),
  'and keeps its members');

-- Kick and ban, through the owner's RPCs.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.kick_server_member('f1680000-0000-0000-0000-0000000000a2', 'f1680000-0000-0000-0000-000000000001', 'off topic');
SELECT public.kick_server_member('f1680000-0000-0000-0000-0000000000a2', '22222222-0000-0000-0000-000000000002', NULL);
SELECT tests.clear_authentication();

SELECT is(
  (SELECT row(profile_id, reason, summary)::text FROM public.federation_member_removals
    WHERE server_id = 'f1680000-0000-0000-0000-0000000000a2'),
  row('f1680000-0000-0000-0000-000000000001'::uuid, 'kick', 'off topic')::text,
  'a kick of a member from another instance records one removal, with its reason; of a local member, none');

INSERT INTO public.server_membership_events (server_id, user_id, event_type, payload)
VALUES ('f1680000-0000-0000-0000-0000000000a2', 'f1680000-0000-0000-0000-000000000002', 'ban', '{"reason": ""}'),
       ('f1680000-0000-0000-0000-0000000000a2', 'f1680000-0000-0000-0000-000000000002', 'leave', '{}');
SELECT is(
  (SELECT row(reason, summary)::text FROM public.federation_member_removals
    WHERE server_id = 'f1680000-0000-0000-0000-0000000000a2' AND profile_id = 'f1680000-0000-0000-0000-000000000002'),
  row('ban', NULL::text)::text,
  'a ban records one with no reason when none was given; a leave records none');

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.federation_member_removals', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.federation_member_removals', 'SELECT'),
  'clients cannot read federation_member_removals');
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.remove_members_from_other_instances(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.remove_members_from_other_instances(uuid)', 'EXECUTE'),
  'clients cannot run remove_members_from_other_instances');
SELECT ok(
  has_function_privilege('service_role', 'public.remove_members_from_other_instances(uuid)', 'EXECUTE'),
  'the service role can');

-- The upgrade path: a server already off with a remote member left.
INSERT INTO public.user_servers (server_id, user_id, status)
VALUES ('f1680000-0000-0000-0000-0000000000a1', 'f1680000-0000-0000-0000-000000000002', 'accepted');
UPDATE public.servers SET federation_enabled = false WHERE id = 'f1680000-0000-0000-0000-0000000000a1';
DELETE FROM public.federation_member_removals WHERE server_id = 'f1680000-0000-0000-0000-0000000000a1';
INSERT INTO public.user_servers (server_id, user_id, status)
VALUES ('f1680000-0000-0000-0000-0000000000a1', 'f1680000-0000-0000-0000-000000000001', 'accepted');
SELECT is(public.remove_members_from_other_instances('f1680000-0000-0000-0000-0000000000a1'), 1,
  'a server already off: the remaining remote member is removed once');

SELECT has_column('public', 'user_servers', 'join_activity_id', 'user_servers keeps the Join id this instance sent');

SELECT * FROM finish();
ROLLBACK;
