-- Fixture graph shared by every test file.
--
-- Fixed uuids so assertions can name a row without a lookup. Loaded once as
-- postgres, before any test transaction; test files only read it.
--
--   alice   member of server_1, participant in the DM
--   bob     member of server_1, participant in the DM
--   mallory member of NO server, participant in NO conversation
--   banned  a user_servers row on server_1 with status = 'banned'

INSERT INTO auth.users (id, instance_id, aud, role, email)
VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'alice@test.local'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bob@test.local'),
  ('cccccccc-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'mallory@test.local'),
  ('dddddddd-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'banned@test.local')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
VALUES
  ('11111111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'alice',   'Alice',   true),
  ('22222222-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', 'bob',     'Bob',     true),
  ('33333333-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000003', 'mallory', 'Mallory', true),
  ('44444444-0000-0000-0000-000000000004', 'dddddddd-0000-0000-0000-000000000004', 'banned',  'Banned',  true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.servers (id, name, owner)
VALUES ('55555555-0000-0000-0000-000000000005', 'Test Server', '11111111-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.user_servers (user_id, server_id, status)
VALUES
  ('11111111-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('44444444-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000005', 'banned')
ON CONFLICT DO NOTHING;

-- channels.type is a smallint; 0 is text.
INSERT INTO public.channels (id, server_id, name, type)
VALUES ('66666666-0000-0000-0000-000000000006', '55555555-0000-0000-0000-000000000005', 'general', 0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.conversations (id, type)
VALUES ('77777777-0000-0000-0000-000000000007', 'direct')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.conversation_participants (conversation_id, user_id)
VALUES
  ('77777777-0000-0000-0000-000000000007', '11111111-0000-0000-0000-000000000001'),
  ('77777777-0000-0000-0000-000000000007', '22222222-0000-0000-0000-000000000002')
ON CONFLICT DO NOTHING;

INSERT INTO public.messages (id, channel_id, user_id, content)
VALUES ('88888888-0000-0000-0000-000000000008', '66666666-0000-0000-0000-000000000006',
        '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"channel message"}]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.messages (id, conversation_id, user_id, content)
VALUES ('99999999-0000-0000-0000-000000000009', '77777777-0000-0000-0000-000000000007',
        '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"dm message"}]'::jsonb)
ON CONFLICT (id) DO NOTHING;
