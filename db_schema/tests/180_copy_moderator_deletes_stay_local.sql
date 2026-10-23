-- 20261027100002_copy_moderator_deletes_stay_local.sql: in this instance's copy of a remote server, a
-- local author's message federates its delete only when the author deletes it, or when no one is
-- signed in (service paths). Anyone else's delete stays on this instance.
--
-- queue_federation_job is replaced for the transaction with a recorder into tests.fed_jobs.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(5);

CREATE TABLE tests.fed_jobs (name text, data jsonb);

CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  INSERT INTO tests.fed_jobs VALUES (p_job_name, p_job_data);
  RETURN gen_random_uuid();
END;
$fn$;

-- auth.uid() without a role switch: the deleter the trigger sees, RLS aside.
CREATE OR REPLACE FUNCTION pg_temp.signed_in(p_auth uuid) RETURNS void LANGUAGE sql AS $fn$
  SELECT set_config('request.jwt.claim.sub', coalesce(p_auth::text, ''), true),
         set_config('request.jwt.claims', CASE WHEN p_auth IS NULL THEN '' ELSE json_build_object('sub', p_auth)::text END, true);
$fn$;

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('18000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'author180@test.local'),
  ('18000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'staff180@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, is_admin) VALUES
  ('18010000-0000-0000-0000-0000000000a1', '18000000-0000-0000-0000-0000000000a1', 'author180', 'Author', true, false),
  ('18010000-0000-0000-0000-0000000000a2', '18000000-0000-0000-0000-0000000000a2', 'staff180', 'Staff', true, true);

INSERT INTO public.servers (id, name, owner, is_local_server, ap_id, federation_inbox_url)
VALUES ('18020000-0000-0000-0000-000000000001', 'Remote 180', '18010000-0000-0000-0000-0000000000a2', false,
        'https://host.test/servers/18020000-0000-0000-0000-000000000001', 'https://host.test/servers/x/inbox');
INSERT INTO public.channels (id, server_id, name, type, is_remote)
VALUES ('18030000-0000-0000-0000-000000000001', '18020000-0000-0000-0000-000000000001', 'general', 0, true);
INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('18040000-0000-0000-0000-000000000001', '18030000-0000-0000-0000-000000000001', '18010000-0000-0000-0000-0000000000a1', '[{"type":"text","text":"own"}]'),
  ('18040000-0000-0000-0000-000000000002', '18030000-0000-0000-0000-000000000001', '18010000-0000-0000-0000-0000000000a1', '[{"type":"text","text":"staff"}]'),
  ('18040000-0000-0000-0000-000000000003', '18030000-0000-0000-0000-000000000001', '18010000-0000-0000-0000-0000000000a1', '[{"type":"text","text":"service"}]');
DELETE FROM tests.fed_jobs;

SELECT pg_temp.signed_in('18000000-0000-0000-0000-0000000000a1');
UPDATE public.messages SET is_deleted = true WHERE id = '18040000-0000-0000-0000-000000000001';
SELECT is((SELECT count(*)::int FROM tests.fed_jobs
            WHERE name = 'federate-channel-message-delete' AND data->>'message_id' = '18040000-0000-0000-0000-000000000001'),
          1, 'the author''s own delete goes to the host');

SELECT pg_temp.signed_in('18000000-0000-0000-0000-0000000000a2');
UPDATE public.messages SET is_deleted = true WHERE id = '18040000-0000-0000-0000-000000000002';
SELECT is((SELECT count(*)::int FROM tests.fed_jobs
            WHERE name = 'federate-channel-message-delete' AND data->>'message_id' = '18040000-0000-0000-0000-000000000002'),
          0, 'instance staff deleting it hides it here and sends nothing in the author''s name');
SELECT ok((SELECT is_deleted FROM public.messages WHERE id = '18040000-0000-0000-0000-000000000002'),
          'the message is gone on this instance');

SELECT pg_temp.signed_in(NULL);
UPDATE public.messages SET is_deleted = true WHERE id = '18040000-0000-0000-0000-000000000003';
SELECT is((SELECT count(*)::int FROM tests.fed_jobs
            WHERE name = 'federate-channel-message-delete' AND data->>'message_id' = '18040000-0000-0000-0000-000000000003'),
          1, 'a delete with no signed-in deleter (account removal) still goes to the host');

SELECT is((SELECT count(*)::int FROM tests.fed_jobs WHERE name = 'federate-channel-message-delete'), 2,
          'nothing else was queued');

SELECT * FROM finish();
ROLLBACK;
