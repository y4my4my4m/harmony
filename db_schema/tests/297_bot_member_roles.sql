-- 20261116300001_bot_member_roles.sql: member role changes bot-gateway writes for a bot
-- (service role, then member_role_added / member_role_removed in bot_audit_log) are credited
-- to the bot in the server audit log, by member and role.
--
--   server_1 (55555555-...05)  member user_2 (22222222-...02)
--   bot b1                     the bot writing
--   roles r1, r2               two roles of server_1
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(7);

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('29700000-0000-0000-0000-0000000000b1', 'level-bot-297', 'Level Bot', '11111111-0000-0000-0000-000000000001', 'bot');
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('29700000-0000-0000-0000-0000000000a1', '55555555-0000-0000-0000-000000000005', 'Level 5', 1, '0'),
  ('29700000-0000-0000-0000-0000000000a2', '55555555-0000-0000-0000-000000000005', 'Level 10', 2, '0');

-- Two roles given in one go; the bot logs only r1.
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', '29700000-0000-0000-0000-0000000000a1', '55555555-0000-0000-0000-000000000005'),
  ('22222222-0000-0000-0000-000000000002', '29700000-0000-0000-0000-0000000000a2', '55555555-0000-0000-0000-000000000005');
INSERT INTO public.bot_audit_log (bot_id, action_type, success, metadata, server_id)
VALUES ('29700000-0000-0000-0000-0000000000b1', 'member_role_added', true,
        '{"server_id":"55555555-0000-0000-0000-000000000005","user_id":"22222222-0000-0000-0000-000000000002","role_id":"29700000-0000-0000-0000-0000000000a1"}'::jsonb,
        '55555555-0000-0000-0000-000000000005');

SELECT is((SELECT source || ' ' || actor_bot_id::text FROM public.server_audit_log
            WHERE action = 'member.role_add' AND target_id = '22222222-0000-0000-0000-000000000002'
              AND details ->> 'role_id' = '29700000-0000-0000-0000-0000000000a1'),
  'bot 29700000-0000-0000-0000-0000000000b1', 'a role the bot gave is credited to the bot');
SELECT is((SELECT source FROM public.server_audit_log
            WHERE action = 'member.role_add' AND target_id = '22222222-0000-0000-0000-000000000002'
              AND details ->> 'role_id' = '29700000-0000-0000-0000-0000000000a2'),
  'system', 'another role given to the same member at the same time is not');

-- Removal.
DELETE FROM public.user_roles
 WHERE user_id = '22222222-0000-0000-0000-000000000002' AND role_id = '29700000-0000-0000-0000-0000000000a1';
INSERT INTO public.bot_audit_log (bot_id, action_type, success, metadata, server_id)
VALUES ('29700000-0000-0000-0000-0000000000b1', 'member_role_removed', true,
        '{"server_id":"55555555-0000-0000-0000-000000000005","user_id":"22222222-0000-0000-0000-000000000002","role_id":"29700000-0000-0000-0000-0000000000a1"}'::jsonb,
        '55555555-0000-0000-0000-000000000005');
SELECT is((SELECT source || ' ' || actor_bot_id::text FROM public.server_audit_log
            WHERE action = 'member.role_remove' AND target_id = '22222222-0000-0000-0000-000000000002'),
  'bot 29700000-0000-0000-0000-0000000000b1', 'a role the bot removed is credited to the bot');

-- A log without role_id credits nothing.
DELETE FROM public.user_roles
 WHERE user_id = '22222222-0000-0000-0000-000000000002' AND role_id = '29700000-0000-0000-0000-0000000000a2';
INSERT INTO public.bot_audit_log (bot_id, action_type, success, metadata, server_id)
VALUES ('29700000-0000-0000-0000-0000000000b1', 'member_role_removed', true,
        '{"server_id":"55555555-0000-0000-0000-000000000005","user_id":"22222222-0000-0000-0000-000000000002"}'::jsonb,
        '55555555-0000-0000-0000-000000000005');
SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE action = 'member.role_remove' AND details ->> 'role_id' = '29700000-0000-0000-0000-0000000000a2'
              AND source = 'bot'),
  0, 'a member role log without role_id credits no row');

-- A failed write credits nothing.
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', '29700000-0000-0000-0000-0000000000a2', '55555555-0000-0000-0000-000000000005');
INSERT INTO public.bot_audit_log (bot_id, action_type, success, metadata, server_id)
VALUES ('29700000-0000-0000-0000-0000000000b1', 'member_role_added', false,
        '{"server_id":"55555555-0000-0000-0000-000000000005","user_id":"22222222-0000-0000-0000-000000000002","role_id":"29700000-0000-0000-0000-0000000000a2"}'::jsonb,
        '55555555-0000-0000-0000-000000000005');
SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE action = 'member.role_add' AND details ->> 'role_id' = '29700000-0000-0000-0000-0000000000a2'
              AND source = 'bot'),
  0, 'a failed write credits no row');

-- Role actions keep their target.
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('29700000-0000-0000-0000-0000000000a3', '55555555-0000-0000-0000-000000000005', 'Made by bot', 1, '0');
INSERT INTO public.bot_audit_log (bot_id, action_type, success, metadata, server_id)
VALUES ('29700000-0000-0000-0000-0000000000b1', 'role_created', true,
        '{"server_id":"55555555-0000-0000-0000-000000000005","role_id":"29700000-0000-0000-0000-0000000000a3"}'::jsonb,
        '55555555-0000-0000-0000-000000000005');
SELECT is((SELECT source || ' ' || actor_bot_id::text FROM public.server_audit_log
            WHERE action = 'role.create' AND target_id = '29700000-0000-0000-0000-0000000000a3'),
  'bot 29700000-0000-0000-0000-0000000000b1', 'a role the bot created is still credited to the bot');

SELECT is((SELECT count(*)::int FROM pg_trigger
            WHERE tgname = 'z_bot_audit_log_server_audit' AND tgrelid = 'public.bot_audit_log'::regclass),
  1, 'one attribution trigger on bot_audit_log');

SELECT * FROM finish();
ROLLBACK;
