-- One mention notification per member per message, after 20261011700001_mention_dedupe.sql.
--
-- Fixture server_1: alice owns it (MENTION_EVERYONE through ownership), bob is a member.
-- Role r120 (mentionable) is held by bob. bob_mentions(message) lists bob's mention
-- notifications of the message: 'direct', 'everyone' or 'role'.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(5);

INSERT INTO public.server_roles (id, server_id, name, position, permissions, mentionable) VALUES
  ('f1201000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'r120', 1, 0, true);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f1201000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005');

CREATE FUNCTION pg_temp.post(p_content jsonb) RETURNS uuid LANGUAGE plpgsql AS $fn$
DECLARE
    v uuid;
BEGIN
    INSERT INTO public.messages (channel_id, user_id, content)
    VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001', p_content)
    RETURNING id INTO v;
    RETURN v;
END;
$fn$;

CREATE FUNCTION pg_temp.bob_mentions(p_message uuid) RETURNS text[] LANGUAGE sql AS $fn$
    SELECT COALESCE(array_agg(CASE WHEN n.data->>'is_everyone' = 'true' THEN 'everyone'
                                   WHEN n.data->>'is_role_mention' = 'true' THEN 'role'
                                   ELSE 'direct' END ORDER BY n.data::text), '{}')
      FROM public.notifications n
     WHERE n.user_id = '22222222-0000-0000-0000-000000000002'
       AND n.type = 'mention' AND n.data->>'message_id' = p_message::text;
$fn$;

CREATE FUNCTION pg_temp.everyone() RETURNS jsonb LANGUAGE sql AS
$fn$ SELECT jsonb_build_array(jsonb_build_object('type', 'role_mention', 'roleId', r.id::text))
       FROM public.server_roles r
      WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default $fn$;
CREATE FUNCTION pg_temp.at_bob() RETURNS jsonb LANGUAGE sql AS
$fn$ SELECT '[{"type":"text","text":" "},{"type":"mention","userId":"22222222-0000-0000-0000-000000000002","username":"bob"}]'::jsonb $fn$;
CREATE FUNCTION pg_temp.at_r120() RETURNS jsonb LANGUAGE sql AS
$fn$ SELECT '[{"type":"text","text":" "},{"type":"role_mention","roleId":"f1201000-0000-0000-0000-000000000001"}]'::jsonb $fn$;

SELECT is(pg_temp.bob_mentions(pg_temp.post(pg_temp.everyone())), ARRAY['everyone'],
    '@everyone alone notifies bob once');
SELECT is(pg_temp.bob_mentions(pg_temp.post(pg_temp.everyone() || pg_temp.at_bob())), ARRAY['direct'],
    '@everyone and a direct mention notify bob once, as the direct mention');
SELECT is(pg_temp.bob_mentions(pg_temp.post(pg_temp.at_r120() || pg_temp.at_bob())), ARRAY['direct'],
    'a role he holds and a direct mention notify bob once');
SELECT is(pg_temp.bob_mentions(pg_temp.post(pg_temp.everyone() || pg_temp.at_r120() || pg_temp.at_bob())), ARRAY['direct'],
    '@everyone, his role and a direct mention notify bob once');
SELECT is(pg_temp.bob_mentions(pg_temp.post(pg_temp.at_r120())), ARRAY['role'],
    'his role alone notifies bob once');

SELECT * FROM finish();
ROLLBACK;
