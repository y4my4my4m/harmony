-- CHANGE_NICKNAME (bit 32) and MANAGE_NICKNAMES (bit 33), 20261112100001_nickname_permissions.sql.
--
-- New servers' @everyone carries CHANGE_NICKNAME, not MANAGE_NICKNAMES. A server made from a
-- template does too, whatever the template's mask says. Existing local servers' @everyone gains
-- CHANGE_NICKNAME once, when the bit map is first extended; a rerun leaves a removed bit removed.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(10);

-- Bit map -----------------------------------------------------------------------------------
SELECT is(array_length(public.permission_bit_names(), 1), 34, 'the bit map names 34 permissions');
SELECT is((public.permission_bit_names())[33], 'CHANGE_NICKNAME', 'CHANGE_NICKNAME is bit 32');
SELECT is((public.permission_bit_names())[34], 'MANAGE_NICKNAMES', 'MANAGE_NICKNAMES is bit 33');

-- fresh_server_default_role -------------------------------------------------------------------
INSERT INTO public.servers (id, name, owner) VALUES
  ('f2460000-0000-0000-0000-000000000001', 'Fresh246', '22222222-0000-0000-0000-000000000002');
SELECT is((SELECT permissions FROM public.server_roles
            WHERE server_id = 'f2460000-0000-0000-0000-000000000001' AND is_default),
          7638839554::bigint, 'a new server''s @everyone holds the 1.8 defaults and CHANGE_NICKNAME');
SELECT ok((SELECT permissions & (1::bigint << 33) FROM public.server_roles
            WHERE server_id = 'f2460000-0000-0000-0000-000000000001' AND is_default) = 0,
          'but not MANAGE_NICKNAMES');
SELECT ok(public.has_permission('22222222-0000-0000-0000-000000000002', 'f2460000-0000-0000-0000-000000000001',
                                'CHANGE_NICKNAME'),
          'has_permission names CHANGE_NICKNAME');

-- template_default_role -----------------------------------------------------------------------
-- A template exported before the bit existed, as the source server's @everyone held it then.
UPDATE public.server_roles SET permissions = permissions & ~(1::bigint << 32)
 WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT set_config('t246.tpl', public.export_server_template('55555555-0000-0000-0000-000000000005')::text, true);
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT set_config('t246.copy', public.create_server_from_template('Tpl246', current_setting('t246.tpl')::jsonb)::text, true);
SELECT tests.clear_authentication();
SELECT ok((SELECT permissions & (1::bigint << 32) FROM public.server_roles
            WHERE server_id = current_setting('t246.copy')::uuid AND is_default) <> 0,
          'a server made from a template has CHANGE_NICKNAME on @everyone');

-- Convergence ---------------------------------------------------------------------------------
INSERT INTO public.servers (id, name, owner, is_local_server) VALUES
  ('f2464000-0000-0000-0000-000000000001', 'Old246', '11111111-0000-0000-0000-000000000001', true);
UPDATE public.server_roles SET permissions = 3343872258
 WHERE server_id = 'f2464000-0000-0000-0000-000000000001' AND is_default;

-- The bit map as 20261012300001 left it.
CREATE OR REPLACE FUNCTION public.permission_bit_names()
RETURNS text[]
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT ARRAY[
        'ADMINISTRATOR','VIEW_CHANNEL','MANAGE_CHANNELS','MANAGE_ROLES',
        'MANAGE_EMOJIS','VIEW_AUDIT_LOG','MANAGE_WEBHOOKS','MANAGE_SERVER',
        'CREATE_INVITE','KICK_MEMBERS','BAN_MEMBERS','TIMEOUT_MEMBERS',
        'SEND_MESSAGES','SEND_MESSAGES_IN_THREADS','CREATE_PUBLIC_THREADS','CREATE_PRIVATE_THREADS',
        'EMBED_LINKS','ATTACH_FILES','ADD_REACTIONS','USE_EXTERNAL_EMOJIS',
        'MENTION_EVERYONE','MANAGE_MESSAGES','READ_MESSAGE_HISTORY','PIN_MESSAGES',
        'CONNECT','SPEAK','STREAM','MUTE_MEMBERS','DEAFEN_MEMBERS','MOVE_MEMBERS',
        'USE_SOUNDBOARD','USE_EXTERNAL_SOUNDS']
$$;

-- The block is read from the migration file at /db_schema/migrations, where
-- scripts/run-db-tests.sh copies db_schema.
\! sed -n '/^-- Existing @everyone roles$/,/^\$\$;$/p' /db_schema/migrations/20261112100001_nickname_permissions.sql > /tmp/converge270.sql
\! test -s /tmp/converge270.sql || echo 'ERROR: /db_schema/migrations/20261112100001_nickname_permissions.sql is not in the container; copy db_schema to /db_schema'
\i /tmp/converge270.sql
SELECT is((SELECT permissions FROM public.server_roles
            WHERE server_id = 'f2464000-0000-0000-0000-000000000001' AND is_default),
          7638839554::bigint, 'an existing server''s @everyone gains CHANGE_NICKNAME');

-- The migration's own bit map is back in force for the rerun.
CREATE OR REPLACE FUNCTION public.permission_bit_names()
RETURNS text[]
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$ SELECT ARRAY[
        'ADMINISTRATOR','VIEW_CHANNEL','MANAGE_CHANNELS','MANAGE_ROLES',
        'MANAGE_EMOJIS','VIEW_AUDIT_LOG','MANAGE_WEBHOOKS','MANAGE_SERVER',
        'CREATE_INVITE','KICK_MEMBERS','BAN_MEMBERS','TIMEOUT_MEMBERS',
        'SEND_MESSAGES','SEND_MESSAGES_IN_THREADS','CREATE_PUBLIC_THREADS','CREATE_PRIVATE_THREADS',
        'EMBED_LINKS','ATTACH_FILES','ADD_REACTIONS','USE_EXTERNAL_EMOJIS',
        'MENTION_EVERYONE','MANAGE_MESSAGES','READ_MESSAGE_HISTORY','PIN_MESSAGES',
        'CONNECT','SPEAK','STREAM','MUTE_MEMBERS','DEAFEN_MEMBERS','MOVE_MEMBERS',
        'USE_SOUNDBOARD','USE_EXTERNAL_SOUNDS','CHANGE_NICKNAME','MANAGE_NICKNAMES']
$$;
UPDATE public.server_roles SET permissions = 3343872258
 WHERE server_id = 'f2464000-0000-0000-0000-000000000001' AND is_default;
\i /tmp/converge270.sql
SELECT is((SELECT permissions FROM public.server_roles
            WHERE server_id = 'f2464000-0000-0000-0000-000000000001' AND is_default),
          3343872258::bigint, 'a rerun leaves a removed bit removed');

SELECT is((SELECT count(*)::integer FROM public.server_roles
            WHERE is_default AND permissions & (1::bigint << 33) <> 0),
          0, 'no @everyone holds MANAGE_NICKNAMES');

SELECT * FROM finish();
ROLLBACK;
