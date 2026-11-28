-- 20261125100001_role_menu_guard.sql: a role_menu part is posted with Manage Roles and never edited.
--
--   server_1 (55555555-...05)  owner alice, member bob, general 6666, DM 7777 of alice and bob
--   copy server                a copy (is_local_server false) both are members of
--   p0  bob's text message
--   m1  alice's role menu in general     m2  bob's, posted with Manage Roles he loses
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(21);
GRANT USAGE ON SCHEMA tests TO service_role;

CREATE FUNCTION pg_temp.menu(p_title text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_array(
    jsonb_build_object('type', 'role_menu', 'serverId', '55555555-0000-0000-0000-000000000005', 'group', null, 'title', p_title),
    jsonb_build_object('type', 'text', 'text', p_title))
$$;
CREATE FUNCTION pg_temp.post(p_id uuid, p_channel uuid, p_conversation uuid, p_content jsonb) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO public.messages (id, channel_id, conversation_id, user_id, content)
  VALUES (p_id, p_channel, p_conversation, public.get_current_profile_id(), p_content)
$$;
CREATE FUNCTION pg_temp.content(p_id uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT content FROM public.messages WHERE id = p_id
$$;
CREATE TEMP TABLE ids AS SELECT
  '38000000-0000-0000-0000-000000000000'::uuid AS p0,
  '38000000-0000-0000-0000-000000000001'::uuid AS m1,
  '38000000-0000-0000-0000-000000000002'::uuid AS m2,
  '66666666-0000-0000-0000-000000000006'::uuid AS general,
  '77777777-0000-0000-0000-000000000007'::uuid AS dm;
GRANT SELECT ON ids TO PUBLIC;

UPDATE public.server_roles SET permissions = 4098 | 8192 WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default;
INSERT INTO public.server_roles (id, server_id, name, position, permissions)
VALUES ('38000000-0000-0000-0000-0000000000a1', '55555555-0000-0000-0000-000000000005', 'managers', 5, 8);
INSERT INTO public.servers (id, name, owner, is_local_server) VALUES
  ('38020000-0000-0000-0000-000000000001', 'Copy', '11111111-0000-0000-0000-000000000001', false);
INSERT INTO public.channels (id, server_id, name, type)
VALUES ('38020000-0000-0000-0000-000000000002', '38020000-0000-0000-0000-000000000001', 'general', 0);
INSERT INTO public.server_roles (id, server_id, name, position, permissions, is_default)
VALUES ('38020000-0000-0000-0000-000000000003', '38020000-0000-0000-0000-000000000001', 'everyone', 0, 4098 | 8, true)
ON CONFLICT DO NOTHING;
UPDATE public.server_roles SET permissions = 4098 | 8 WHERE server_id = '38020000-0000-0000-0000-000000000001' AND is_default;
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('22222222-0000-0000-0000-000000000002', '38020000-0000-0000-0000-000000000001', 'accepted');
INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by)
VALUES ('38000000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006', '88888888-0000-0000-0000-000000000008',
        'picks', '11111111-0000-0000-0000-000000000001');

-- Posting -------------------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($$SELECT pg_temp.post((SELECT p0 FROM ids), (SELECT general FROM ids), NULL, '[{"type":"text","text":"role_menu"}]')$$,
  'a member posts text that names the part');
SELECT throws_ok($$SELECT pg_temp.post((SELECT m2 FROM ids), (SELECT general FROM ids), NULL, pg_temp.menu('Free roles'))$$,
  '42501', 'Missing permission: MANAGE_ROLES', 'a member without Manage Roles posts no role menu');
SELECT throws_ok($$SELECT pg_temp.post((SELECT m2 FROM ids), (SELECT general FROM ids), NULL,
                                       '[{"type":"text","text":"hi"},{"type":"role_menu","serverId":"other"}]')$$,
  '42501', NULL, 'wherever the part stands and whichever server it names');
SELECT throws_ok($$INSERT INTO public.messages (channel_id, thread_id, user_id, content)
                   VALUES ((SELECT general FROM ids), '38000000-0000-0000-0000-0000000000b1',
                           '22222222-0000-0000-0000-000000000002', pg_temp.menu('Free roles'))$$,
  '42501', 'Missing permission: MANAGE_ROLES', 'nor in a thread');
SELECT throws_ok($$SELECT pg_temp.post((SELECT m2 FROM ids), NULL, (SELECT dm FROM ids), pg_temp.menu('Free roles'))$$,
  '42501', 'Missing permission: MANAGE_ROLES', 'nor in a conversation');
SELECT throws_ok($$SELECT pg_temp.post((SELECT m2 FROM ids), '38020000-0000-0000-0000-000000000002', NULL, pg_temp.menu('Free roles'))$$,
  '42501', 'Missing permission: MANAGE_ROLES', 'nor on a copy, whose roles are its host''s');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($$SELECT pg_temp.post((SELECT m1 FROM ids), (SELECT general FROM ids), NULL, pg_temp.menu('Pick'))$$, 'the owner posts one');
SELECT throws_ok($$SELECT pg_temp.post(gen_random_uuid(), NULL, (SELECT dm FROM ids), pg_temp.menu('Pick'))$$,
  '42501', NULL, 'but not in a conversation, which has no roles');
SELECT tests.clear_authentication();

INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('22222222-0000-0000-0000-000000000002', '38000000-0000-0000-0000-0000000000a1', '55555555-0000-0000-0000-000000000005');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($$SELECT pg_temp.post((SELECT m2 FROM ids), (SELECT general FROM ids), NULL, pg_temp.menu('Colours'))$$,
  'a member with Manage Roles posts one');
SELECT tests.clear_authentication();
DELETE FROM public.user_roles WHERE role_id = '38000000-0000-0000-0000-0000000000a1';

-- Editing -------------------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($$UPDATE public.messages SET content = pg_temp.menu('Changed') WHERE id = (SELECT m2 FROM ids)$$,
  '42501', 'ROLE_MENU_IMMUTABLE: a role menu message cannot be edited', 'the author cannot change the part');
SELECT throws_ok($$UPDATE public.messages SET content = '[{"type":"text","text":"gone"}]' WHERE id = (SELECT m2 FROM ids)$$,
  '42501', 'ROLE_MENU_IMMUTABLE: a role menu message cannot be edited', 'nor take it out');
SELECT throws_ok($$UPDATE public.messages SET content = jsonb_set(content, '{1,text}', '"Other words"') WHERE id = (SELECT m2 FROM ids)$$,
  '42501', 'ROLE_MENU_IMMUTABLE: a role menu message cannot be edited', 'nor change the text beside it');
SELECT throws_ok($$UPDATE public.messages SET content = pg_temp.menu('Smuggled') WHERE id = (SELECT p0 FROM ids)$$,
  '42501', 'ROLE_MENU_IMMUTABLE: a role menu message cannot be edited', 'nor edit one into a text message');
SELECT lives_ok($$UPDATE public.messages SET content = '[{"type":"text","text":"edited"}]' WHERE id = (SELECT p0 FROM ids)$$,
  'a text message is edited as before');
SELECT lives_ok($$UPDATE public.messages SET content = content, is_pinned = is_pinned WHERE id = (SELECT m2 FROM ids)$$,
  'a write that leaves the content passes');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($$UPDATE public.messages SET content = pg_temp.menu('Changed') WHERE id = (SELECT m1 FROM ids)$$,
  '42501', 'ROLE_MENU_IMMUTABLE: a role menu message cannot be edited', 'the owner cannot edit one either');
SELECT tests.clear_authentication();
SELECT is(pg_temp.content((SELECT m2 FROM ids)), pg_temp.menu('Colours'), 'the menu is as posted');

-- Deleting, and the service role --------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($$UPDATE public.messages SET is_deleted = true, content = pg_temp.menu('Changed') WHERE id = (SELECT m2 FROM ids)$$,
  '42501', NULL, 'a deletion cannot carry another menu');
SELECT lives_ok($$UPDATE public.messages SET is_deleted = true, content = '[{"type":"text","text":"[deleted]"}]' WHERE id = (SELECT m2 FROM ids)$$,
  'the author deletes the message');
SELECT tests.clear_authentication();
SET LOCAL role service_role;
SELECT lives_ok($$INSERT INTO public.messages (channel_id, user_id, content)
                  VALUES ((SELECT general FROM ids), '22222222-0000-0000-0000-000000000002', pg_temp.menu('Imported'))$$,
  'the service role is not limited');
RESET role;

SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'public.messages'::regclass
            AND tgname IN ('a_messages_role_menu_guard', 'a_messages_role_menu_edit_guard')
            AND pg_get_triggerdef(oid) LIKE '%@> ''[{"type": "role_menu"}]''::jsonb%'
            AND pg_get_triggerdef(oid) LIKE '%CURRENT_USER%'),
  2, 'both triggers fire on the part alone, for client roles');

SELECT * FROM finish();
ROLLBACK;
