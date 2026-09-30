-- federation_group_access, federation_channel_recipients and the accepted-only
-- get_server_members_by_instance from 20261001100001_federation_channel_access.sql.
--
-- GroupService serves a private server's channels, and ChannelMessageHandler
-- delivers a channel's messages, only to what these functions return.
--
-- Servers:
--   priv    public = false, owned by alice
--   pub     public = true, owned by alice
--   ref     a remote reference (is_local_server = false)
--
-- Channels:
--   priv.general   default @everyone permissions
--   priv.secret    @everyone denied VIEW_CHANNEL
--   priv.vip       @everyone denied VIEW_CHANNEL, rm allowed by user override
--   pub.general    default
--   pub.hidden     @everyone denied VIEW_CHANNEL
--   pub.rolechan   @everyone denied VIEW_CHANNEL, role 'vip' (held by rm) allowed
--   ref.chan       is_remote = true
--
-- Remote profiles (is_local = false):
--   rm   accepted on priv and pub, remote.test, advertises a shared inbox
--   ro   accepted on priv, other.test, no shared inbox
--   rs   no membership
--   rp   pending on priv
--   rb   accepted on priv and listed in server_bans
--   rbs  user_servers status 'banned' on priv
--   rx   accepted on priv, suspended
-- Local profile:
--   lm   accepted on priv, carries a federated_id

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(29);

CREATE OR REPLACE FUNCTION pg_temp.sig(p_name text) RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT pg_get_function_arguments(p.oid) || ' -> ' || pg_get_function_result(p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = p_name;
$fn$;

-- Named grantee in proacl; see 32_rpc_contracts.sql for why not has_function_privilege.
CREATE OR REPLACE FUNCTION pg_temp.granted_execute(p_name text, p_role text)
RETURNS boolean LANGUAGE sql STABLE AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(p.proacl) a
    WHERE n.nspname = 'public' AND p.proname = p_name
      AND a.grantee = p_role::regrole
      AND a.privilege_type = 'EXECUTE'
  );
$fn$;

-- Setup, as postgres. -------------------------------------------------------------------
INSERT INTO public.profiles (id, username, display_name, domain, federated_id, shared_inbox_url, is_local, is_suspended)
VALUES
  ('f3810000-0000-0000-0000-000000000001', 'rm',  'rm',  'remote.test', 'https://remote.test/users/rm',  'https://remote.test/inbox', false, false),
  ('f3810000-0000-0000-0000-000000000002', 'ro',  'ro',  'other.test',  'https://other.test/users/ro',   NULL,                        false, false),
  ('f3810000-0000-0000-0000-000000000003', 'rs',  'rs',  'remote.test', 'https://remote.test/users/rs',  'https://remote.test/inbox', false, false),
  ('f3810000-0000-0000-0000-000000000004', 'rp',  'rp',  'remote.test', 'https://remote.test/users/rp',  'https://remote.test/inbox', false, false),
  ('f3810000-0000-0000-0000-000000000005', 'rb',  'rb',  'remote.test', 'https://remote.test/users/rb',  'https://remote.test/inbox', false, false),
  ('f3810000-0000-0000-0000-000000000006', 'rbs', 'rbs', 'remote.test', 'https://remote.test/users/rbs', 'https://remote.test/inbox', false, false),
  ('f3810000-0000-0000-0000-000000000007', 'rx',  'rx',  'remote.test', 'https://remote.test/users/rx',  'https://remote.test/inbox', false, true),
  ('f3810000-0000-0000-0000-000000000008', 'lm',  'lm',  'local.test',  'https://local.test/users/lm',   NULL,                        true,  false);

INSERT INTO public.servers (id, name, owner, public) VALUES
  ('f3820000-0000-0000-0000-000000000001', 'Private', '11111111-0000-0000-0000-000000000001', false),
  ('f3820000-0000-0000-0000-000000000002', 'Public',  '11111111-0000-0000-0000-000000000001', true);
INSERT INTO public.servers (id, name, owner, public, is_local_server, ap_id) VALUES
  ('f3820000-0000-0000-0000-000000000003', 'Reference', '11111111-0000-0000-0000-000000000001', true, false,
   'https://remote.test/servers/f3820000-0000-0000-0000-000000000003');

-- Server creation seeds default channels; the cells name only their own.
DELETE FROM public.channels
 WHERE server_id IN ('f3820000-0000-0000-0000-000000000001', 'f3820000-0000-0000-0000-000000000002',
                     'f3820000-0000-0000-0000-000000000003');

INSERT INTO public.channels (id, server_id, name, type, is_remote) VALUES
  ('f3830000-0000-0000-0000-000000000001', 'f3820000-0000-0000-0000-000000000001', 'general',  0, false),
  ('f3830000-0000-0000-0000-000000000002', 'f3820000-0000-0000-0000-000000000001', 'secret',   0, false),
  ('f3830000-0000-0000-0000-000000000003', 'f3820000-0000-0000-0000-000000000001', 'vip',      0, false),
  ('f3830000-0000-0000-0000-000000000004', 'f3820000-0000-0000-0000-000000000002', 'general',  0, false),
  ('f3830000-0000-0000-0000-000000000005', 'f3820000-0000-0000-0000-000000000002', 'hidden',   0, false),
  ('f3830000-0000-0000-0000-000000000006', 'f3820000-0000-0000-0000-000000000002', 'rolechan', 0, false),
  ('f3830000-0000-0000-0000-000000000007', 'f3820000-0000-0000-0000-000000000003', 'chan',     0, true);

INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('f3810000-0000-0000-0000-000000000001', 'f3820000-0000-0000-0000-000000000001', 'accepted'),
  ('f3810000-0000-0000-0000-000000000001', 'f3820000-0000-0000-0000-000000000002', 'accepted'),
  ('f3810000-0000-0000-0000-000000000002', 'f3820000-0000-0000-0000-000000000001', 'accepted'),
  ('f3810000-0000-0000-0000-000000000004', 'f3820000-0000-0000-0000-000000000001', 'pending'),
  ('f3810000-0000-0000-0000-000000000005', 'f3820000-0000-0000-0000-000000000001', 'accepted'),
  ('f3810000-0000-0000-0000-000000000006', 'f3820000-0000-0000-0000-000000000001', 'banned'),
  ('f3810000-0000-0000-0000-000000000007', 'f3820000-0000-0000-0000-000000000001', 'accepted'),
  ('f3810000-0000-0000-0000-000000000008', 'f3820000-0000-0000-0000-000000000001', 'accepted'),
  ('f3810000-0000-0000-0000-000000000001', 'f3820000-0000-0000-0000-000000000003', 'accepted');

INSERT INTO public.server_bans (server_id, user_id)
VALUES ('f3820000-0000-0000-0000-000000000001', 'f3810000-0000-0000-0000-000000000005');

INSERT INTO public.server_roles (id, server_id, name, permissions) VALUES
  ('f3840000-0000-0000-0000-000000000001', 'f3820000-0000-0000-0000-000000000002', 'vip', 0);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('f3810000-0000-0000-0000-000000000001', 'f3840000-0000-0000-0000-000000000001', 'f3820000-0000-0000-0000-000000000002');

-- VIEW_CHANNEL is bit 1 (2).
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
SELECT c.channel_id, 'role', r.id, NULL, 0, 2
  FROM (VALUES ('f3830000-0000-0000-0000-000000000002'::uuid, 'f3820000-0000-0000-0000-000000000001'::uuid),
               ('f3830000-0000-0000-0000-000000000003'::uuid, 'f3820000-0000-0000-0000-000000000001'::uuid),
               ('f3830000-0000-0000-0000-000000000005'::uuid, 'f3820000-0000-0000-0000-000000000002'::uuid),
               ('f3830000-0000-0000-0000-000000000006'::uuid, 'f3820000-0000-0000-0000-000000000002'::uuid)) c(channel_id, server_id)
  JOIN public.server_roles r ON r.server_id = c.server_id AND r.is_default;
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions) VALUES
  ('f3830000-0000-0000-0000-000000000003', 'user', NULL, 'f3810000-0000-0000-0000-000000000001', 2, 0),
  ('f3830000-0000-0000-0000-000000000006', 'role', 'f3840000-0000-0000-0000-000000000001', NULL, 2, 0);

CREATE TEMP TABLE acc AS
SELECT a.actor, g.*
  FROM (VALUES ('none', NULL::text),
               ('rm',   'https://remote.test/users/rm'),
               ('rs',   'https://remote.test/users/rs'),
               ('rp',   'https://remote.test/users/rp'),
               ('rb',   'https://remote.test/users/rb'),
               ('rbs',  'https://remote.test/users/rbs'),
               ('rx',   'https://remote.test/users/rx'),
               ('lm',   'https://local.test/users/lm')) a(actor, ap_id)
  CROSS JOIN LATERAL public.federation_group_access('f3820000-0000-0000-0000-000000000001', a.ap_id) g;

-- Contracts -----------------------------------------------------------------------------
SELECT is(pg_temp.sig('federation_group_access'),
          'p_server_id uuid, p_actor_ap_id text DEFAULT NULL::text -> '
          || 'TABLE(is_public boolean, member_id uuid, everyone_channel_ids uuid[], member_channel_ids uuid[])',
          'federation_group_access takes a server id and an optional actor id');
SELECT is(pg_temp.sig('federation_channel_recipients'),
          'p_channel_id uuid -> TABLE(instance text, member_ap_ids text[], member_count integer, shared_inbox text)',
          'federation_channel_recipients takes a channel id');
SELECT ok(pg_temp.granted_execute('federation_group_access', 'service_role')
          AND NOT pg_temp.granted_execute('federation_group_access', 'anon')
          AND NOT pg_temp.granted_execute('federation_group_access', 'authenticated')
          AND NOT has_function_privilege('anon', 'public.federation_group_access(uuid, text)', 'EXECUTE'),
          'federation_group_access is executable by service_role only');
SELECT ok(pg_temp.granted_execute('federation_channel_recipients', 'service_role')
          AND NOT pg_temp.granted_execute('federation_channel_recipients', 'anon')
          AND NOT pg_temp.granted_execute('federation_channel_recipients', 'authenticated')
          AND NOT has_function_privilege('anon', 'public.federation_channel_recipients(uuid)', 'EXECUTE'),
          'federation_channel_recipients is executable by service_role only');

-- Servers without a row -----------------------------------------------------------------
SELECT is((SELECT count(*)::int FROM public.federation_group_access('f3820000-0000-0000-0000-0000000000ff', NULL)), 0,
          'an unknown server has no row');
SELECT is((SELECT count(*)::int FROM public.federation_group_access('f3820000-0000-0000-0000-000000000003',
                                                                    'https://remote.test/users/rm')), 0,
          'a remote reference has no row, member or not');

-- Private server ------------------------------------------------------------------------
SELECT is((SELECT is_public FROM acc WHERE actor = 'none'), false, 'priv reads as private');
SELECT is((SELECT member_id FROM acc WHERE actor = 'none'), NULL, 'no actor, no member');
SELECT is((SELECT everyone_channel_ids FROM acc WHERE actor = 'none'),
          ARRAY['f3830000-0000-0000-0000-000000000001']::uuid[],
          '@everyone sees general only: secret and vip deny it');
SELECT is((SELECT member_channel_ids FROM acc WHERE actor = 'none'), '{}'::uuid[],
          'no member, no member channels');
SELECT is((SELECT member_id FROM acc WHERE actor = 'rm'), 'f3810000-0000-0000-0000-000000000001'::uuid,
          'an accepted remote member resolves to its profile');
SELECT is((SELECT member_channel_ids FROM acc WHERE actor = 'rm'),
          ARRAY['f3830000-0000-0000-0000-000000000001', 'f3830000-0000-0000-0000-000000000003']::uuid[],
          'rm sees general and vip (user override), not secret');
SELECT is((SELECT member_id FROM acc WHERE actor = 'rs'), NULL, 'a remote actor with no membership is no member');
SELECT is((SELECT member_id FROM acc WHERE actor = 'rp'), NULL, 'a pending membership is no member');
SELECT is((SELECT member_id FROM acc WHERE actor = 'rb'), NULL, 'a server_bans row overrides an accepted status');
SELECT is((SELECT member_id FROM acc WHERE actor = 'rbs'), NULL, 'status banned is no member');
SELECT is((SELECT member_id FROM acc WHERE actor = 'rx'), NULL, 'a suspended profile is no member');
SELECT is((SELECT member_id FROM acc WHERE actor = 'lm'), NULL, 'a local profile never reads as a remote member');

-- Public server -------------------------------------------------------------------------
SELECT is((SELECT is_public FROM public.federation_group_access('f3820000-0000-0000-0000-000000000002', NULL)), true,
          'pub reads as public');
SELECT is((SELECT everyone_channel_ids FROM public.federation_group_access('f3820000-0000-0000-0000-000000000002', NULL)),
          ARRAY['f3830000-0000-0000-0000-000000000004']::uuid[],
          '@everyone sees pub.general only');
SELECT is((SELECT member_channel_ids FROM public.federation_group_access('f3820000-0000-0000-0000-000000000002',
                                                                         'https://remote.test/users/rm')),
          ARRAY['f3830000-0000-0000-0000-000000000004', 'f3830000-0000-0000-0000-000000000006']::uuid[],
          'rm sees pub.general and rolechan (role override), not hidden');

UPDATE public.server_roles SET permissions = permissions | 1
 WHERE server_id = 'f3820000-0000-0000-0000-000000000002' AND is_default;
SELECT is((SELECT everyone_channel_ids FROM public.federation_group_access('f3820000-0000-0000-0000-000000000002', NULL)),
          ARRAY['f3830000-0000-0000-0000-000000000004', 'f3830000-0000-0000-0000-000000000005',
                'f3830000-0000-0000-0000-000000000006']::uuid[],
          'ADMINISTRATOR on @everyone outranks every channel deny, as in get_user_permissions');

-- @everyone visibility agrees with get_user_permissions for a caller holding nothing.
SELECT is((SELECT everyone_channel_ids FROM acc WHERE actor = 'none'),
          (SELECT array_agg(c.id ORDER BY c.id) FROM public.channels c
            WHERE c.server_id = 'f3820000-0000-0000-0000-000000000001'
              AND public.has_permission(NULL, c.server_id, 'VIEW_CHANNEL', c.id)),
          '@everyone channels match has_permission for a caller with no roles');

-- Recipients ----------------------------------------------------------------------------
SELECT set_eq(
  $$SELECT instance, member_ap_ids FROM public.federation_channel_recipients('f3830000-0000-0000-0000-000000000001')$$,
  $$VALUES ('other.test', ARRAY['https://other.test/users/ro']),
           ('remote.test', ARRAY['https://remote.test/users/rm'])$$,
  'priv.general reaches accepted, unbanned, unsuspended remote members, grouped by instance');
SELECT is((SELECT shared_inbox FROM public.federation_channel_recipients('f3830000-0000-0000-0000-000000000001')
            WHERE instance = 'remote.test'), 'https://remote.test/inbox',
          'the group carries a shared inbox a member advertises');
SELECT is((SELECT shared_inbox FROM public.federation_channel_recipients('f3830000-0000-0000-0000-000000000001')
            WHERE instance = 'other.test'), NULL,
          'no advertised shared inbox is NULL');
SELECT is((SELECT count(*)::int FROM public.federation_channel_recipients('f3830000-0000-0000-0000-000000000002')), 0,
          'a channel no remote member can view has no recipients');
SELECT set_eq(
  $$SELECT instance, member_ap_ids FROM public.federation_channel_recipients('f3830000-0000-0000-0000-000000000003')$$,
  $$VALUES ('remote.test', ARRAY['https://remote.test/users/rm'])$$,
  'priv.vip reaches only the member its user override admits');

-- get_server_members_by_instance ------------------------------------------------------------
SELECT ok(
  NOT EXISTS (SELECT 1 FROM public.get_server_members_by_instance('f3820000-0000-0000-0000-000000000001') g,
                            unnest(g.member_ap_ids) a
               WHERE a IN ('https://remote.test/users/rp', 'https://remote.test/users/rbs'))
  AND EXISTS (SELECT 1 FROM public.get_server_members_by_instance('f3820000-0000-0000-0000-000000000001') g,
                            unnest(g.member_ap_ids) a
               WHERE a = 'https://remote.test/users/rm'),
  'get_server_members_by_instance returns accepted members only');

SELECT * FROM finish();
ROLLBACK;
