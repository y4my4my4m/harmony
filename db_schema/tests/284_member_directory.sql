-- 20261113100001_member_directory.sql: members by range, search and id; the stored count.
--
-- Fixture roles: alice owns server_1; bob is an accepted member; banned holds a row with
-- status 'banned'; mallory is a member of nothing. carol (remote) and dave join here.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(90);

CREATE FUNCTION tests.md284_stored() RETURNS integer LANGUAGE sql AS $fn$
  SELECT member_count FROM public.server_member_stats WHERE server_id = '55555555-0000-0000-0000-000000000005';
$fn$;
-- get_server_member_list of server_1 as the signed-in caller.
CREATE FUNCTION tests.md284_list(p_offset integer DEFAULT 0, p_limit integer DEFAULT 100, p_query text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT public.get_server_member_list('55555555-0000-0000-0000-000000000005', p_offset, p_limit, p_query);
$fn$;
CREATE FUNCTION tests.md284_names(p_list jsonb) RETURNS text LANGUAGE sql AS $fn$
  SELECT COALESCE(string_agg(m ->> 'username', ',' ORDER BY ord), '')
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_list) = 'array' THEN p_list ELSE p_list -> 'members' END)
         WITH ORDINALITY AS t(m, ord);
$fn$;
CREATE FUNCTION tests.md284_groups(p_list jsonb) RETURNS text LANGUAGE sql AS $fn$
  SELECT COALESCE(string_agg((g ->> 'key') || ':' || (g ->> 'count'), ',' ORDER BY ord), '')
    FROM jsonb_array_elements(p_list -> 'groups') WITH ORDINALITY AS t(g, ord);
$fn$;

-- The stored count.
SELECT is(tests.md284_stored(), 2, 'the backfill counts accepted members: alice and bob, not the banned row');

INSERT INTO public.profiles (id, username, display_name, is_local, domain) VALUES
  ('e2840000-0000-0000-0000-000000000001', 'carol', 'Carol', false, 'remote.example'),
  ('e2840000-0000-0000-0000-000000000002', 'dave',  NULL,    true,  'localhost'),
  ('e2840000-0000-0000-0000-000000000003', 'erin',  'Erin',  true,  'localhost');

INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('e2840000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('e2840000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('e2840000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'pending');
SELECT is(tests.md284_stored(), 4, 'one statement adding two accepted members and a pending one adds two');

UPDATE public.user_servers SET status = 'accepted'
 WHERE user_id = 'e2840000-0000-0000-0000-000000000003' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT is(tests.md284_stored(), 5, 'a pending member accepted counts');
UPDATE public.user_servers SET muted = true
 WHERE user_id = 'e2840000-0000-0000-0000-000000000003' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT is(tests.md284_stored(), 5, 'an update of another column changes nothing');
DELETE FROM public.user_servers
 WHERE user_id = 'e2840000-0000-0000-0000-000000000003' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT is(tests.md284_stored(), 4, 'a member who leaves no longer counts');
DELETE FROM public.user_servers
 WHERE user_id = '44444444-0000-0000-0000-000000000004' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT is(tests.md284_stored(), 4, 'a banned row removed changes nothing');

INSERT INTO public.servers (id, name, owner) VALUES ('e2845000-0000-0000-0000-000000000001', 'Empty', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('11111111-0000-0000-0000-000000000001', 'e2845000-0000-0000-0000-000000000001', 'accepted');
SELECT is((SELECT member_count FROM public.server_member_stats WHERE server_id = 'e2845000-0000-0000-0000-000000000001'), 1,
          'a server created after the backfill is counted from its first member');

-- Presence: bob away; carol and dave absent.
INSERT INTO public.user_presence (profile_id, status, online, published_status, published_at)
VALUES ('22222222-0000-0000-0000-000000000002', 2, true, 2, now())
ON CONFLICT (profile_id) DO UPDATE SET status = 2, online = true, published_status = 2;

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT member_count FROM public.get_server_member_counts(ARRAY['55555555-0000-0000-0000-000000000005']::uuid[])), 4::bigint,
          'get_server_member_counts answers the stored count to a member');
SELECT is((tests.md284_list() ->> 'total')::integer, 4, 'the list totals accepted members');
SELECT is(tests.md284_groups(tests.md284_list()), 'online:1,away:1,federated:1,offline:1',
          'groups in display order: the caller online, bob away, the remote account federated, dave offline');
SELECT is(tests.md284_names(tests.md284_list()), 'alice,bob,carol,dave', 'members follow the group order');
SELECT is(tests.md284_list() -> 'members' -> 1 ->> 'group', 'away', 'a member names its group');
SELECT is((tests.md284_list() -> 'members' -> 1 ->> 'presence_status')::integer, 2, 'and its presence as the caller sees it');
SELECT is((tests.md284_list() -> 'members' -> 3 ->> 'online')::boolean, false, 'an absent member reads offline');
SELECT ok(NOT (tests.md284_list() -> 'members' -> 3) ? 'display_name', 'a null column is left out');
SELECT is(tests.md284_names(tests.md284_list(1, 2)), 'bob,carol', 'offset and limit cut the same order');
SELECT is((tests.md284_list(1, 2) ->> 'total')::integer, 4, 'a page still carries the whole total');
SELECT is(tests.md284_names(tests.md284_list(0, 0)), 'alice', 'a limit below one reads one member');
SELECT is(tests.md284_names(tests.md284_list(-5, 100)), 'alice,bob,carol,dave', 'a negative offset reads from the head');
SELECT is(tests.md284_groups(tests.md284_list(0, 100, 'A')), 'online:1,federated:1,offline:1',
          'a query keeps members whose username or display name contains it, in any case');
SELECT is((tests.md284_list(0, 100, '%') ->> 'total')::integer, 0, 'a wildcard in the query is a literal');
RESET role;

-- Invisible, the caller lists itself offline, as others see it: the same in a list of any length.
INSERT INTO public.user_presence (profile_id, status, online, published_status, published_at)
VALUES ('11111111-0000-0000-0000-000000000001', 4, true, 0, now());
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(tests.md284_groups(tests.md284_list()), 'away:1,federated:1,offline:2', 'an invisible caller is offline in its own list');
SELECT is((SELECT (m ->> 'online') || ':' || (m ->> 'presence_status') FROM jsonb_array_elements(tests.md284_list() -> 'members') m
            WHERE m ->> 'username' = 'alice'), 'false:0', 'and absent in its own row');
RESET role;
DELETE FROM public.user_presence WHERE profile_id = '11111111-0000-0000-0000-000000000001';

-- A member who blocks the caller is listed with their status, as on Discord.
INSERT INTO public.user_blocks (blocker_id, blocked_user_id)
VALUES ('22222222-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(tests.md284_groups(tests.md284_list()), 'online:1,away:1,federated:1,offline:1', 'bob, who blocks alice, lists away to her');
SELECT is((SELECT (m ->> 'presence_status') || ':' || (m ->> 'online') || ':' || (m ->> 'is_mobile')
             FROM jsonb_array_elements(tests.md284_list() -> 'members') m WHERE m ->> 'username' = 'bob'),
          '2:true:false', 'with the status he published');
RESET role;
DELETE FROM public.user_blocks WHERE blocker_id = '22222222-0000-0000-0000-000000000002';

-- A row with no status is an accepted member, as it is to the row-level policies.
INSERT INTO public.profiles (id, username, display_name, is_local, domain)
VALUES ('e2840000-0000-0000-0000-000000000004', 'zed', 'Zed', true, 'localhost');
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('e2840000-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000005', NULL);
SELECT is(tests.md284_stored(), 5, 'a member with no status counts');
DELETE FROM public.user_servers
 WHERE user_id = 'e2840000-0000-0000-0000-000000000004' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT is(tests.md284_stored(), 4, 'and stops counting when it leaves');

-- A hoisted role groups its present members above the presence groups.
INSERT INTO public.server_roles (id, server_id, name, position, hoist, is_default)
VALUES ('e2846000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'Crew', 5, true, false);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', 'e2846000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005'),
  ('e2840000-0000-0000-0000-000000000002', 'e2846000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(tests.md284_groups(tests.md284_list()), 'role:e2846000-0000-0000-0000-000000000001:1,online:1,federated:1,offline:1',
          'bob, present, lists under the hoisted role; dave, absent, stays offline');
SELECT is(tests.md284_list() -> 'members' -> 0 -> 'role_ids', '["e2846000-0000-0000-0000-000000000001"]'::jsonb,
          'a member carries its roles without the default one');
SELECT is(tests.md284_list() -> 'members' -> 2 -> 'role_ids', '[]'::jsonb, 'carol, with the default role alone, carries none');

SELECT is(tests.md284_names(public.search_server_members('55555555-0000-0000-0000-000000000005', 'a')), 'alice,carol,dave',
          'search answers members whose name contains the query, prefix matches first');
SELECT is(tests.md284_names(public.search_server_members('55555555-0000-0000-0000-000000000005', 'DAVE')), 'dave',
          'search ignores case');
SELECT is(tests.md284_names(public.search_server_members('55555555-0000-0000-0000-000000000005', 'a', 1)), 'alice',
          'search stops at its limit');
SELECT is(public.search_server_members('55555555-0000-0000-0000-000000000005', '  '), '[]'::jsonb, 'a blank query finds nothing');
SELECT is(tests.md284_names(public.search_server_members('55555555-0000-0000-0000-000000000005', 'banned')), '',
          'a row that is not accepted is not a member');

SELECT is(public.get_server_member_roles('55555555-0000-0000-0000-000000000005',
              ARRAY['22222222-0000-0000-0000-000000000002', 'e2840000-0000-0000-0000-000000000001']::uuid[]),
          '{"22222222-0000-0000-0000-000000000002": ["e2846000-0000-0000-0000-000000000001"]}'::jsonb,
          'member roles answer the ids asked; a member without roles is absent');
SELECT throws_ok(
    $q$SELECT public.get_server_member_roles('55555555-0000-0000-0000-000000000005',
           ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 201)))$q$,
    '22023', NULL, 'more than 200 ids are refused');
SELECT is((public.get_server_role_member_counts('55555555-0000-0000-0000-000000000005')
              ->> 'e2846000-0000-0000-0000-000000000001')::integer, 2, 'a role counts its members');
SELECT is((SELECT (public.get_server_role_member_counts('55555555-0000-0000-0000-000000000005') ->> r.id::text)::integer
             FROM public.server_roles r
            WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default),
          4, 'the default role counts every accepted member');
RESET role;

-- A caller outside the server.
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.get_server_member_list('55555555-0000-0000-0000-000000000005')$q$,
                 '42501', NULL, 'the list is refused to a non-member');
SELECT throws_ok($q$SELECT public.search_server_members('55555555-0000-0000-0000-000000000005', 'a')$q$,
                 '42501', NULL, 'so is search');
SELECT throws_ok($q$SELECT public.get_server_member_roles('55555555-0000-0000-0000-000000000005',
                        ARRAY['22222222-0000-0000-0000-000000000002']::uuid[])$q$,
                 '42501', NULL, 'so are member roles');
SELECT throws_ok($q$SELECT public.get_server_role_member_counts('55555555-0000-0000-0000-000000000005')$q$,
                 '42501', NULL, 'so are role counts');
SELECT is((SELECT member_count FROM public.get_server_member_counts(ARRAY['55555555-0000-0000-0000-000000000005']::uuid[])), 0::bigint,
          'a private server reads zero to a non-member');
SELECT throws_ok($q$SELECT * FROM public.server_member_stats$q$, '42501', NULL, 'the stored counts are closed to clients');
SELECT throws_ok($q$SELECT * FROM public.server_member_order$q$, '42501', NULL, 'so are the stored orders');
RESET role;

-- NAME ORDER ---------------------------------------------------------------------------------
-- As a browser's Intl.Collator orders them: accents beside their letters, not after z.
INSERT INTO public.servers (id, name, owner) VALUES ('e2845000-0000-0000-0000-000000000002', 'Names', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.profiles (id, username, display_name, is_local, domain) VALUES
  ('e2841000-0000-0000-0000-000000000001', 'nm1', 'Zoë',    true, 'localhost'),
  ('e2841000-0000-0000-0000-000000000002', 'nm2', 'émile',  true, 'localhost'),
  ('e2841000-0000-0000-0000-000000000003', 'nm3', 'Eve',    true, 'localhost'),
  ('e2841000-0000-0000-0000-000000000004', 'nm4', 'Ärmel',  true, 'localhost'),
  ('e2841000-0000-0000-0000-000000000005', 'nm5', 'apple',  true, 'localhost');
INSERT INTO public.user_servers (user_id, server_id, status)
SELECT id, 'e2845000-0000-0000-0000-000000000002', 'accepted' FROM public.profiles
 WHERE id = '11111111-0000-0000-0000-000000000001' OR username IN ('nm1', 'nm2', 'nm3', 'nm4', 'nm5');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(tests.md284_names(public.get_server_member_list('e2845000-0000-0000-0000-000000000002')),
          'alice,nm5,nm4,nm2,nm3,nm1', 'offline names sort apple, Ärmel, émile, Eve, Zoë');
RESET role;

-- THE STORED ORDER ---------------------------------------------------------------------------
-- A list of more than 200 members is answered from server_member_order.
INSERT INTO public.servers (id, name, owner) VALUES ('e2845000-0000-0000-0000-000000000003', 'Wide', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.profiles (id, username, display_name, is_local, domain)
SELECT ('e2842000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, 'w' || lpad(g::text, 4, '0'), 'Wide ' || lpad(g::text, 4, '0'), true, 'localhost'
  FROM generate_series(1, 250) g;
INSERT INTO public.user_servers (user_id, server_id, status)
SELECT id, 'e2845000-0000-0000-0000-000000000003', 'accepted' FROM public.profiles
 WHERE username LIKE 'w0%' OR id IN ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002');
-- w0001-w0010 online; bob is away from above; alice has published nothing yet.
INSERT INTO public.user_presence (profile_id, status, online, published_status, published_at)
SELECT id, 1, true, 1, now() FROM public.profiles WHERE username BETWEEN 'w0001' AND 'w0010';

CREATE FUNCTION tests.md284_wide(p_offset integer DEFAULT 0, p_limit integer DEFAULT 100, p_query text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT public.get_server_member_list('e2845000-0000-0000-0000-000000000003', p_offset, p_limit, p_query);
$fn$;
-- Alice's chosen status and what has been published of it, as presence_heartbeat leaves them.
CREATE FUNCTION tests.md284_alice(p_status smallint) RETURNS void LANGUAGE sql AS $fn$
  INSERT INTO public.user_presence (profile_id, status, online, published_status, published_at)
  VALUES ('11111111-0000-0000-0000-000000000001', p_status, true, CASE WHEN p_status = 4 THEN 0 ELSE p_status END, now())
  ON CONFLICT (profile_id) DO UPDATE
     SET status = EXCLUDED.status, online = true, published_status = EXCLUDED.published_status;
$fn$;

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((tests.md284_wide() ->> 'total')::integer, 252, 'the long list totals its members');
SELECT is(tests.md284_groups(tests.md284_wide()), 'online:11,away:1,offline:240',
          'the caller, who has published nothing yet, is online in its own list at once');
SELECT is((tests.md284_wide() ->> 'max_age_ms')::integer, 5000, 'the answer says how old its order may be');
SELECT is((tests.md284_wide() ->> 'live')::boolean, true, 'presence changes of a server this size are broadcast');
SELECT is(tests.md284_names(tests.md284_wide(0, 13)), 'alice,w0001,w0002,w0003,w0004,w0005,w0006,w0007,w0008,w0009,w0010,bob,w0011',
          'the head: online by name with the caller in its place, then away, then offline by name');
SELECT is(tests.md284_wide(11, 1) -> 'members' -> 0 ->> 'group', 'away', 'a member names its group by its place in the order');
SELECT is(tests.md284_names(tests.md284_wide(250, 100)), 'w0249,w0250', 'the last page is short');
SELECT is((tests.md284_wide(0, 1) -> 'members' -> 0 ->> 'online')::boolean, true, 'the caller reads present to itself');
RESET role;
SELECT is((SELECT total FROM public.server_member_order WHERE server_id = 'e2845000-0000-0000-0000-000000000003'), 252,
          'the order is stored');
SELECT is((SELECT array_position(member_ids, '11111111-0000-0000-0000-000000000001') FROM public.server_member_order
            WHERE server_id = 'e2845000-0000-0000-0000-000000000003'), 12,
          'with alice where others see her: offline, first by name');
SELECT is((SELECT count(*) FROM public.server_member_order WHERE server_id = '55555555-0000-0000-0000-000000000005'), 0::bigint,
          'a short list stores none');

-- Within its age limit the order held is answered: another member's change shows after it.
INSERT INTO public.user_presence (profile_id, status, online, published_status, published_at)
SELECT id, 1, true, 1, now() FROM public.profiles WHERE username = 'w0200';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(tests.md284_groups(tests.md284_wide()), 'online:10,away:1,offline:241',
          'to bob: a change inside the age limit waits, and alice is offline until she publishes');
RESET role;
UPDATE public.server_member_order SET built_at = built_at - interval '6 seconds'
 WHERE server_id = 'e2845000-0000-0000-0000-000000000003';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(tests.md284_groups(tests.md284_wide()), 'online:11,away:1,offline:240', 'and shows once the order is older than that');
RESET role;

-- The caller's own place follows the status it chose, whatever the order held says.
SELECT tests.md284_alice(4::smallint);
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(tests.md284_groups(tests.md284_wide()), 'online:11,away:1,offline:240',
          'invisible, the caller lists itself offline, as others see it');
SELECT is((SELECT (m ->> 'online') || ':' || (m ->> 'presence_status') FROM jsonb_array_elements(tests.md284_wide(12, 1) -> 'members') m
            WHERE m ->> 'username' = 'alice'), 'false:0', 'first of the offline members, absent to itself');
RESET role;
SELECT tests.md284_alice(2::smallint);
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(tests.md284_groups(tests.md284_wide()), 'online:11,away:2,offline:239', 'away, it joins the away group at once');
SELECT is(tests.md284_names(tests.md284_wide(11, 2)), 'alice,bob', 'at its place by name');
RESET role;
SELECT tests.md284_alice(3::smallint);
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(tests.md284_groups(tests.md284_wide()), 'online:11,away:1,busy:1,offline:239',
          'busy, where nobody else is: the group appears in its place');
SELECT is(tests.md284_wide(12, 1) -> 'members' -> 0 ->> 'username', 'alice', 'holding the caller');
RESET role;
SELECT tests.md284_alice(1::smallint);
INSERT INTO public.server_roles (id, server_id, name, position, hoist, is_default)
VALUES ('e2846000-0000-0000-0000-000000000002', 'e2845000-0000-0000-0000-000000000003', 'Lead', 9, true, false);
INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('11111111-0000-0000-0000-000000000001', 'e2846000-0000-0000-0000-000000000002', 'e2845000-0000-0000-0000-000000000003');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(tests.md284_groups(tests.md284_wide()), 'role:e2846000-0000-0000-0000-000000000002:1,online:11,away:1,offline:239',
          'online with a hoisted role, it heads the list under the role');
SELECT is(tests.md284_wide(0, 1) -> 'members' -> 0 ->> 'group', 'role:e2846000-0000-0000-0000-000000000002', 'in the role group');
RESET role;
DELETE FROM public.user_roles WHERE role_id = 'e2846000-0000-0000-0000-000000000002';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(tests.md284_groups(tests.md284_wide()), 'online:12,away:1,offline:239', 'online without it, it is in the online group');
SELECT is(tests.md284_names(tests.md284_wide(0, 2)), 'alice,w0001', 'first by name');
-- A query is answered from the tables, for the caller.
SELECT is(tests.md284_groups(tests.md284_wide(0, 100, 'w02')), 'online:1,offline:50', 'a query filters the list');
SELECT is((tests.md284_wide(0, 100, 'w02') ->> 'max_age_ms')::integer, 0, 'and is no older than the call');
RESET role;
SELECT is((SELECT array_position(member_ids, '11111111-0000-0000-0000-000000000001') FROM public.server_member_order
            WHERE server_id = 'e2845000-0000-0000-0000-000000000003'), 13,
          'none of it rebuilt the order: alice is still stored offline, after bob');

-- A member who blocks the caller changes nothing of the caller's list: the stored order serves it.
INSERT INTO public.user_blocks (blocker_id, blocked_user_id)
VALUES ((SELECT id FROM public.profiles WHERE username = 'w0001'), '11111111-0000-0000-0000-000000000001');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(tests.md284_groups(tests.md284_wide()), 'online:12,away:1,offline:239',
          'w0001, who blocks alice, lists online to her');
SELECT ok((tests.md284_wide() ->> 'max_age_ms')::integer > 0, 'from the stored order');
RESET role;
UPDATE public.server_member_order SET built_at = built_at - interval '6 seconds'
 WHERE server_id = 'e2845000-0000-0000-0000-000000000003';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(tests.md284_groups(tests.md284_wide()), 'online:12,away:1,offline:239',
          'and online to bob, from the stored order, with alice now published online');
RESET role;
DELETE FROM public.user_blocks WHERE blocked_user_id = '11111111-0000-0000-0000-000000000001';

-- PRESENCE BROADCASTS ------------------------------------------------------------------------
-- A server of more than 1000 members gets no presence:update; its members' other servers do.
INSERT INTO public.servers (id, name, owner) VALUES ('e2845000-0000-0000-0000-000000000004', 'Huge', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.profiles (id, username, display_name, is_local, domain)
SELECT ('e2843000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, 'h' || lpad(g::text, 4, '0'), 'Huge ' || lpad(g::text, 4, '0'), true, 'localhost'
  FROM generate_series(1, 1000) g;
INSERT INTO public.user_servers (user_id, server_id, status)
SELECT id, 'e2845000-0000-0000-0000-000000000004', 'accepted' FROM public.profiles
 WHERE username LIKE 'h____' AND username ~ '^h[0-9]{4}$'
    OR id IN ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002');
SELECT is((SELECT member_count FROM public.server_member_stats WHERE server_id = 'e2845000-0000-0000-0000-000000000004'), 1002,
          'the large server has 1,002 members');
SELECT ok(public.server_is_large('e2845000-0000-0000-0000-000000000004'), 'which is large');
SELECT ok(NOT public.server_is_large('e2845000-0000-0000-0000-000000000003'), 'a server of 252 is not');

DELETE FROM realtime.messages;
UPDATE public.user_presence SET published_at = published_at - interval '2 seconds';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$SELECT public.presence_heartbeat('dev-284', 1::smallint, false)$q$, 'bob, away until now, heartbeats online');
RESET role;
SELECT is_empty(
    $q$SELECT 1 FROM realtime.messages WHERE topic = 'server-presence:e2845000-0000-0000-0000-000000000004'$q$,
    'the large server is not told');
SELECT isnt_empty(
    $q$SELECT 1 FROM realtime.messages
        WHERE topic = 'server-presence:55555555-0000-0000-0000-000000000005' AND payload ->> 'type' = 'presence:update'
          AND payload ->> 'user_id' = '22222222-0000-0000-0000-000000000002'$q$,
    'his small server is');
SELECT isnt_empty(
    $q$SELECT 1 FROM realtime.messages
        WHERE topic = 'server-presence:e2845000-0000-0000-0000-000000000003' AND payload ->> 'type' = 'presence:update'$q$,
    'so is the server of 252');
SELECT isnt_empty(
    $q$SELECT 1 FROM realtime.messages WHERE topic = 'user:11111111-0000-0000-0000-000000000001' AND payload ->> 'type' = 'presence:update'$q$,
    'and his DM partner');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((public.get_server_member_list('e2845000-0000-0000-0000-000000000004', 0, 5) ->> 'live')::boolean, false,
          'the large server''s list says its presence is not broadcast');
SELECT is(tests.md284_groups(public.get_server_member_list('e2845000-0000-0000-0000-000000000004', 0, 5)), 'online:2,offline:1000',
          'and still carries who is online: alice and bob');
RESET role;

-- Room members as one value: the same ids get_room_member_ids answers row by row.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT array_agg(x ORDER BY x) FROM unnest(public.get_room_member_id_list('66666666-0000-0000-0000-000000000006')) x),
          (SELECT array_agg(x ORDER BY x) FROM public.get_room_member_ids('66666666-0000-0000-0000-000000000006') x),
          'the room member list is get_room_member_ids as one array');
SELECT is(cardinality(public.get_room_member_id_list('66666666-0000-0000-0000-000000000006')), 4, 'of every accepted member');
RESET role;
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.get_room_member_id_list('66666666-0000-0000-0000-000000000006'), '{}'::uuid[], 'and empty to a caller outside the room');
RESET role;

SELECT ok(NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('server_member_presence', 'server_member_json', 'server_member_reader', 'member_search_pattern',
                         'server_member_stats_on_insert', 'server_member_stats_on_delete', 'server_member_stats_on_update',
                         'server_member_keyed', 'server_member_order_fresh', 'server_member_order_for', 'member_group_rank',
                         'server_is_large', 'member_order_min', 'presence_publish')
       AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))),
    'the helpers are closed to clients');

SELECT * FROM finish();
ROLLBACK;
