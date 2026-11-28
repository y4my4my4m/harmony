-- A group invite from another instance adds the people it names to the copy here
-- (20261125500001); a message adds nobody, and the inviter's right is its own participation.
--
--   u01..u13   local accounts c390
--   r          account on another instance, in the group
--   s          account there, outside it
--   'group-c390'  the group's id on its host
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(32);
GRANT USAGE ON SCHEMA tests TO service_role;

INSERT INTO auth.users (id, instance_id, aud, role, email)
SELECT format('c3900000-0000-0000-0000-0000000000%s', lpad(n::text, 2, '0'))::uuid,
       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', format('u%s@c390.test', n)
  FROM generate_series(1, 13) n;
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, created_at)
SELECT format('c3901000-0000-0000-0000-0000000000%s', lpad(n::text, 2, '0'))::uuid,
       format('c3900000-0000-0000-0000-0000000000%s', lpad(n::text, 2, '0'))::uuid,
       format('c390u%s', n), format('U%s', n), true, now() - interval '30 days'
  FROM generate_series(1, 13) n;
INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id) VALUES
  ('c3902000-0000-0000-0000-000000000001', 'c390r', 'R', false, 'c390.example', 'https://c390.example/users/c390r'),
  ('c3902000-0000-0000-0000-000000000002', 'c390s', 'S', false, 'c390.example', 'https://c390.example/users/c390s');

CREATE FUNCTION pg_temp.u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT format('c3901000-0000-0000-0000-0000000000%s', lpad(n::text, 2, '0'))::uuid
$$;
CREATE FUNCTION pg_temp.auth(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT format('c3900000-0000-0000-0000-0000000000%s', lpad(n::text, 2, '0'))::uuid
$$;
CREATE FUNCTION pg_temp.r() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT 'c3902000-0000-0000-0000-000000000001'::uuid $$;
CREATE FUNCTION pg_temp.s() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT 'c3902000-0000-0000-0000-000000000002'::uuid $$;
-- The call as the federation backend makes it.
CREATE FUNCTION pg_temp.invite(p_actor uuid, p_recipients uuid[], p_remote text DEFAULT 'group-c390') RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  SET LOCAL role service_role;
  v := public.apply_federated_group_invite(p_actor, p_recipients, p_remote);
  RESET role;
  RETURN v;
END $$;
CREATE FUNCTION pg_temp.added(v jsonb) RETURNS uuid[] LANGUAGE sql AS $$
  SELECT ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(v -> 'added') x ORDER BY 1)
$$;
CREATE FUNCTION pg_temp.active(p_conversation uuid) RETURNS uuid[] LANGUAGE sql AS $$
  SELECT ARRAY(SELECT user_id FROM public.conversation_participants WHERE conversation_id = p_conversation AND left_at IS NULL ORDER BY 1)
$$;
CREATE FUNCTION pg_temp.notices(p_user uuid) RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM public.notifications WHERE user_id = p_user AND type = 'dm' AND data ->> 'is_invite' = 'true'
$$;

-- The first invite -----------------------------------------------------------------------------------
SELECT set_config('tests.first', pg_temp.invite(pg_temp.r(), ARRAY[pg_temp.u(1), pg_temp.s()])::text, true) <> '' AS made;
SELECT set_config('tests.g', current_setting('tests.first')::jsonb ->> 'conversation_id', true) <> '' AS named;
SELECT is(pg_temp.added(current_setting('tests.first')::jsonb), ARRAY[pg_temp.u(1)], 'the first invite adds the local person it names');
SELECT is(pg_temp.active(current_setting('tests.g')::uuid), ARRAY[pg_temp.u(1), pg_temp.r()], 'to a group of the inviter and that person');
SELECT is(pg_temp.notices(pg_temp.u(1)), 0, 'and leaves the notice to the invite');

INSERT INTO public.messages (conversation_id, user_id, content)
VALUES (current_setting('tests.g')::uuid, pg_temp.r(), '[{"type":"text","text":"before c390u2"}]');

-- A later one ------------------------------------------------------------------------------------------
SELECT set_config('tests.later', pg_temp.invite(pg_temp.r(), ARRAY[pg_temp.u(2)])::text, true) <> '' AS made;
SELECT is(current_setting('tests.later')::jsonb ->> 'conversation_id', current_setting('tests.g'), 'a later invite finds the group');
SELECT is(pg_temp.added(current_setting('tests.later')::jsonb), ARRAY[pg_temp.u(2)], 'and adds the person it names');
SELECT is(pg_temp.active(current_setting('tests.g')::uuid), ARRAY[pg_temp.u(1), pg_temp.u(2), pg_temp.r()], 'beside the others');
SELECT is((SELECT role FROM public.conversation_participants WHERE conversation_id = current_setting('tests.g')::uuid AND user_id = pg_temp.u(2)),
          'member', 'as a member');
SELECT is(pg_temp.notices(pg_temp.u(2)), 0, 'leaving the notice to the invite');
SELECT tests.authenticate_as(pg_temp.auth(2));
SELECT is((SELECT count(*)::int FROM public.messages WHERE conversation_id = current_setting('tests.g')::uuid), 1, 'who reads what was sent before');
SELECT tests.clear_authentication();

SELECT is(pg_temp.added(pg_temp.invite(pg_temp.r(), ARRAY[pg_temp.u(2)])), '{}'::uuid[], 'the invite again adds nobody');
SELECT is(pg_temp.added(pg_temp.invite(pg_temp.r(), ARRAY[pg_temp.u(1), pg_temp.u(3)])), ARRAY[pg_temp.u(3)], 'one naming a participant and a new person adds the new one');

UPDATE public.conversation_participants SET left_at = now()
 WHERE conversation_id = current_setting('tests.g')::uuid AND user_id = pg_temp.u(2);
SELECT is(pg_temp.added(pg_temp.invite(pg_temp.r(), ARRAY[pg_temp.u(2)])), ARRAY[pg_temp.u(2)], 'one who left is added again');
SELECT is((SELECT count(*)::int FROM public.conversation_participants WHERE conversation_id = current_setting('tests.g')::uuid AND user_id = pg_temp.u(2)),
          1, 'in the row it has');

-- Who may invite -----------------------------------------------------------------------------------------
SELECT is(pg_temp.invite(pg_temp.s(), ARRAY[pg_temp.u(4)]), NULL, 'an account outside the group invites nobody into it');
UPDATE public.conversation_participants SET left_at = now()
 WHERE conversation_id = current_setting('tests.g')::uuid AND user_id = pg_temp.r();
SELECT is(pg_temp.invite(pg_temp.r(), ARRAY[pg_temp.u(4)]), NULL, 'nor one who left it');
UPDATE public.conversation_participants SET left_at = NULL
 WHERE conversation_id = current_setting('tests.g')::uuid AND user_id = pg_temp.r();
SELECT is(pg_temp.active(current_setting('tests.g')::uuid), ARRAY[pg_temp.u(1), pg_temp.u(2), pg_temp.u(3), pg_temp.r()], 'the group is as it was');
SELECT is((SELECT count(*)::int FROM public.conversation_participants WHERE user_id = pg_temp.u(4)), 0, 'and the person named is in none');

-- Who may be invited ----------------------------------------------------------------------------------------
INSERT INTO public.user_blocks (blocker_id, blocked_user_id) VALUES (pg_temp.u(5), pg_temp.r()), (pg_temp.r(), pg_temp.u(6));
UPDATE public.profiles SET dm_policy = 'known' WHERE id = pg_temp.u(7);
SELECT is(pg_temp.invite(pg_temp.r(), ARRAY[pg_temp.u(5)]), NULL, 'a person who blocks the inviter is not added');
SELECT is(pg_temp.invite(pg_temp.r(), ARRAY[pg_temp.u(6)]), NULL, 'nor one the inviter blocks');
SELECT is(pg_temp.invite(pg_temp.r(), ARRAY[pg_temp.u(7)]), NULL, 'nor one whose setting refuses a stranger');
SELECT is(pg_temp.added(pg_temp.invite(pg_temp.r(), ARRAY[pg_temp.u(5), pg_temp.u(6), pg_temp.u(7), pg_temp.u(8)])), ARRAY[pg_temp.u(8)],
          'an invite naming them and another adds the other');

-- Messages ----------------------------------------------------------------------------------------------------
SET LOCAL role service_role;
SELECT is(public.get_or_create_federated_group_conversation(pg_temp.r(), ARRAY[pg_temp.u(1), pg_temp.u(9)], 'group-c390'),
          current_setting('tests.g')::uuid, 'a message finds the group');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.conversation_participants WHERE user_id = pg_temp.u(9)), 0, 'and adds nobody it names');

-- The limit ---------------------------------------------------------------------------------------------------
SELECT is(cardinality(pg_temp.added(pg_temp.invite(pg_temp.r(), ARRAY(SELECT pg_temp.u(n) FROM generate_series(9, 13) n)))), 5, 'five more are added');
UPDATE public.profiles SET dm_policy = 'everyone' WHERE id = pg_temp.u(7);
DELETE FROM public.user_blocks WHERE blocker_id = pg_temp.u(5);
SELECT is(cardinality(pg_temp.added(pg_temp.invite(pg_temp.r(), ARRAY[pg_temp.u(4), pg_temp.u(5), pg_temp.u(7)]))), 3, 'and three');
SELECT is(cardinality(pg_temp.active(current_setting('tests.g')::uuid)), 13, 'past 10, in a group of another instance');

INSERT INTO public.conversations (id, type, name, created_by, metadata)
VALUES ('c3903000-0000-0000-0000-000000000001', 'group', 'here', pg_temp.u(1), '{"remote_conversation_id": "here-c390"}');
INSERT INTO public.conversation_participants (conversation_id, user_id, role)
SELECT 'c3903000-0000-0000-0000-000000000001', id, 'member'
  FROM unnest(ARRAY(SELECT pg_temp.u(n) FROM generate_series(1, 8) n) || pg_temp.r()) id;
SELECT is(pg_temp.added(pg_temp.invite(pg_temp.r(), ARRAY[pg_temp.u(9)], 'here-c390')), ARRAY[pg_temp.u(9)], 'a participant''s invite fills a group made here');
SELECT throws_ok(format($q$SELECT pg_temp.invite(%L, ARRAY[%L]::uuid[], 'here-c390')$q$, pg_temp.r(), pg_temp.u(10)),
                 'P0001'::char(5), 'GROUP_CONVERSATION_FULL:10', 'to 10 and no further');

-- A plain add still notifies ---------------------------------------------------------------------------------
INSERT INTO public.conversations (id, type, name, created_by) VALUES ('c3903000-0000-0000-0000-000000000002', 'group', 'local', pg_temp.u(1));
INSERT INTO public.conversation_participants (conversation_id, user_id, role) VALUES ('c3903000-0000-0000-0000-000000000002', pg_temp.u(13), 'member');
SELECT is(pg_temp.notices(pg_temp.u(13)), 1, 'a person added here gets the trigger''s notice');

-- Callers -----------------------------------------------------------------------------------------------------
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['anon', 'authenticated']) g
            WHERE has_function_privilege(g, 'public.apply_federated_group_invite(uuid, uuid[], text)', 'EXECUTE')), 0,
          'no client calls the function');
SELECT ok(has_function_privilege('service_role', 'public.apply_federated_group_invite(uuid, uuid[], text)', 'EXECUTE'), 'the federation backend does');
SELECT is((SELECT count(*)::int FROM public.conversations WHERE metadata ->> 'remote_conversation_id' = 'group-c390'), 1, 'one copy of the group');

SELECT * FROM finish();
ROLLBACK;
