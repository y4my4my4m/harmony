-- 20261011000001_server_templates.sql: export_server_template, create_server_from_template.
--
--   source (f1131000-...01)   owner alice; bob member; carol113 member holding mods
--     roles        @everyone (462850, #123456), members (2: none, #00ff00, 🌱),
--                  Admin (999), mods (1000: MANAGE_CHANNELS, MANAGE_SERVER; hoisted)
--     categories   info (0), talk (1)
--     channels     welcome113 (text, info, 0, slowmode 30), staff113 (text, info, 1, private,
--                  mods allowed), lounge113 (voice, talk, 0, members allowed CONNECT),
--                  loose113 (text, no category, 5, a member override for bob)
--     settings     default role members, system channel welcome113, system messages off,
--                  newcomer alerts on, notifications all, invites by mods
--     welcome      enabled, one rule, acceptance required
--     automod      the preset, alert channel welcome113, bots not exempt, and a keyword rule
--                  exempting mods, staff113 and info
--   admin113                  instance admin, member of nothing
--   mallory                   creates the copy
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(62);

-- Setup, as postgres. -----------------------------------------------------------------------------
INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f1130000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol113@test.local'),
  ('f1130000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin113@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, is_admin) VALUES
  ('f1130000-0000-0000-0000-0000000000c1', 'f1130000-0000-0000-0000-0000000000a1', 'carol113', 'Carol', true, false),
  ('f1130000-0000-0000-0000-0000000000c2', 'f1130000-0000-0000-0000-0000000000a2', 'admin113', 'Admin113', true, true);

INSERT INTO public.servers (id, name, owner, description, public, allow_cross_server_emojis, rules, category)
VALUES ('f1131000-0000-0000-0000-000000000001', 'Template Source', '11111111-0000-0000-0000-000000000001',
        'A source server', true, false, '["Be kind"]'::jsonb, 'gaming');
DELETE FROM public.channels WHERE server_id = 'f1131000-0000-0000-0000-000000000001';
DELETE FROM public.channel_categories WHERE server_id = 'f1131000-0000-0000-0000-000000000001';

UPDATE public.server_roles SET permissions = 462850, color = '#123456'
 WHERE server_id = 'f1131000-0000-0000-0000-000000000001' AND is_default;
INSERT INTO public.server_roles (id, server_id, name, color, position, permissions, mentionable, hoist, unicode_emoji) VALUES
  ('f1131100-0000-0000-0000-000000000001', 'f1131000-0000-0000-0000-000000000001', 'mods', '#ff0000', 1000, 132, false, true, NULL),
  ('f1131100-0000-0000-0000-000000000002', 'f1131000-0000-0000-0000-000000000001', 'members', '#00ff00', 2, 0, true, false, '🌱');

INSERT INTO public.channel_categories (id, server_id, name, "order") VALUES
  ('f1131200-0000-0000-0000-000000000001', 'f1131000-0000-0000-0000-000000000001', 'info', 0),
  ('f1131200-0000-0000-0000-000000000002', 'f1131000-0000-0000-0000-000000000001', 'talk', 1);
INSERT INTO public.channels (id, server_id, name, description, type, "order", slowmode_seconds, category) VALUES
  ('f1131300-0000-0000-0000-000000000001', 'f1131000-0000-0000-0000-000000000001', 'welcome113', 'Read me first', 0, 0, 30, 'f1131200-0000-0000-0000-000000000001'),
  ('f1131300-0000-0000-0000-000000000002', 'f1131000-0000-0000-0000-000000000001', 'staff113', NULL, 0, 1, 0, 'f1131200-0000-0000-0000-000000000001'),
  ('f1131300-0000-0000-0000-000000000003', 'f1131000-0000-0000-0000-000000000001', 'lounge113', NULL, 1, 0, 0, 'f1131200-0000-0000-0000-000000000002'),
  ('f1131300-0000-0000-0000-000000000004', 'f1131000-0000-0000-0000-000000000001', 'loose113', NULL, 0, 5, 0, NULL);

-- VIEW_CHANNEL is bit 1, SEND_MESSAGES bit 12, CONNECT bit 24.
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
SELECT 'f1131300-0000-0000-0000-000000000002', 'role', r.id, NULL, 0, 2
  FROM public.server_roles r WHERE r.server_id = 'f1131000-0000-0000-0000-000000000001' AND r.is_default;
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions) VALUES
  ('f1131300-0000-0000-0000-000000000002', 'role', 'f1131100-0000-0000-0000-000000000001', NULL, 2, 0),
  ('f1131300-0000-0000-0000-000000000003', 'role', 'f1131100-0000-0000-0000-000000000002', NULL, 16777216, 0),
  ('f1131300-0000-0000-0000-000000000004', 'user', NULL, '22222222-0000-0000-0000-000000000002', 0, 4096);

INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'f1131000-0000-0000-0000-000000000001', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'f1131000-0000-0000-0000-000000000001', 'accepted'),
  ('f1130000-0000-0000-0000-0000000000c1', 'f1131000-0000-0000-0000-000000000001', 'accepted');
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('f1130000-0000-0000-0000-0000000000c1', 'f1131100-0000-0000-0000-000000000001', 'f1131000-0000-0000-0000-000000000001');

INSERT INTO public.server_settings (server_id, default_role_id, system_channel_id, system_messages_enabled,
                                    newcomer_alerts, default_message_notifications, invite_permissions)
VALUES ('f1131000-0000-0000-0000-000000000001', 'f1131100-0000-0000-0000-000000000002',
        'f1131300-0000-0000-0000-000000000001', false, true, 'all',
        '{"who_can_create": "roles", "allowed_roles": ["f1131100-0000-0000-0000-000000000001"],
          "default_expiration": 60, "max_expiration": 0, "allow_temporary": false, "max_uses_limit": 10}'::jsonb)
ON CONFLICT (server_id) DO UPDATE
   SET default_role_id = EXCLUDED.default_role_id, system_channel_id = EXCLUDED.system_channel_id,
       system_messages_enabled = EXCLUDED.system_messages_enabled, newcomer_alerts = EXCLUDED.newcomer_alerts,
       default_message_notifications = EXCLUDED.default_message_notifications,
       invite_permissions = EXCLUDED.invite_permissions;

INSERT INTO public.server_welcome_screens (server_id, enabled, message, rules, require_acceptance,
                                           enabled_at, acceptance_required_at)
VALUES ('f1131000-0000-0000-0000-000000000001', true, 'Hello there',
        '[{"title": "Be kind", "description": "Always"}]'::jsonb, true, now(), now());

UPDATE public.server_automod_settings
   SET alert_channel_id = 'f1131300-0000-0000-0000-000000000001', exempt_bots = false
 WHERE server_id = 'f1131000-0000-0000-0000-000000000001';
INSERT INTO public.server_automod_rules (server_id, name, rule_type, enabled, config, actions,
                                         exempt_role_ids, exempt_channel_ids, position)
VALUES ('f1131000-0000-0000-0000-000000000001', 'No badword', 'keyword', true,
        public.automod_canonical_config('keyword', '{"keywords": ["badword"]}'::jsonb),
        public.automod_canonical_actions('{"block": true, "alert": true}'::jsonb),
        ARRAY['f1131100-0000-0000-0000-000000000001']::uuid[],
        ARRAY['f1131300-0000-0000-0000-000000000002', 'f1131200-0000-0000-0000-000000000001']::uuid[], 6);

-- Shape. ------------------------------------------------------------------------------------------
SELECT ok(has_function_privilege('authenticated', 'public.export_server_template(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.export_server_template(uuid)', 'EXECUTE'),
          'export_server_template is for authenticated, not anon');
SELECT ok(has_function_privilege('authenticated', 'public.create_server_from_template(text,jsonb)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.create_server_from_template(text,jsonb)', 'EXECUTE'),
          'create_server_from_template is for authenticated, not anon');
SELECT ok(NOT has_function_privilege('authenticated', 'public.server_template_canonical(jsonb)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.server_template_bits(jsonb,text)', 'EXECUTE'),
          'the validator and its readers are internal');

-- Export permissions. -----------------------------------------------------------------------------
SELECT tests.authenticate_as_anon();
SELECT throws_ok($$SELECT public.export_server_template('f1131000-0000-0000-0000-000000000001')$$,
                 '42501', NULL, 'anon cannot export');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($$SELECT public.export_server_template('f1131000-0000-0000-0000-000000000001')$$,
                 '42501', NULL, 'a non-member cannot export');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($$SELECT public.export_server_template('f1131000-0000-0000-0000-000000000001')$$,
                 '42501', NULL, 'a member without MANAGE_SERVER cannot export');

SELECT tests.authenticate_as('f1130000-0000-0000-0000-0000000000a1');
SELECT lives_ok($$SELECT public.export_server_template('f1131000-0000-0000-0000-000000000001')$$,
                'a MANAGE_SERVER holder exports');

SELECT tests.authenticate_as('f1130000-0000-0000-0000-0000000000a2');
SELECT lives_ok($$SELECT public.export_server_template('f1131000-0000-0000-0000-000000000001')$$,
                'an instance admin exports');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT ok(set_config('t113.tpl', public.export_server_template('f1131000-0000-0000-0000-000000000001')::text, true)
          IS NOT NULL, 'the owner exports');

-- Export content. ---------------------------------------------------------------------------------
SELECT tests.clear_authentication();

SELECT is(current_setting('t113.tpl')::jsonb -> 'format', '"harmony.server-template"'::jsonb, 'format names the document');
SELECT is(current_setting('t113.tpl')::jsonb -> 'version', '1'::jsonb, 'version 1');
SELECT ok(current_setting('t113.tpl') !~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
          'the export carries no uuid');
SELECT is((SELECT count(*) FROM jsonb_array_elements(current_setting('t113.tpl')::jsonb -> 'roles') r
            WHERE jsonb_typeof(r -> 'permissions') <> 'string'), 0::bigint,
          'permission masks are strings');
SELECT is((SELECT r ->> 'permissions' FROM jsonb_array_elements(current_setting('t113.tpl')::jsonb -> 'roles') r
            WHERE (r ->> 'is_admin')::boolean),
          ((1::bigint << array_length(public.permission_bit_names(), 1)) - 1)::text,
          'the Admin mask keeps the named bits only');
SELECT is((SELECT count(*) FROM jsonb_array_elements(current_setting('t113.tpl')::jsonb -> 'channels') c,
                                jsonb_array_elements(c -> 'overrides') o), 3::bigint,
          'role overrides are exported, member overrides are not');
SELECT is((SELECT array_agg(c ->> 'name') FROM jsonb_array_elements(current_setting('t113.tpl')::jsonb -> 'channels') c
            WHERE (c ->> 'private')::boolean), ARRAY['staff113'],
          'the private channel is marked private');
SELECT is(current_setting('t113.tpl')::jsonb #> '{settings,invite_permissions,allowed_roles}',
          (SELECT jsonb_agg(r -> 'ref') FROM jsonb_array_elements(current_setting('t113.tpl')::jsonb -> 'roles') r
            WHERE r ->> 'name' = 'mods'),
          'invite roles are refs');

-- Round trip. -------------------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT ok(set_config('t113.copy',
                     public.create_server_from_template('  Copy113 ', current_setting('t113.tpl')::jsonb)::text, true)
          IS NOT NULL, 'any signed-in user creates a server from the template');
SELECT tests.clear_authentication();

CREATE FUNCTION pg_temp.roles_of(p_server uuid) RETURNS text[] LANGUAGE sql AS $fn$
  SELECT array_agg(format('%s|%s|%s|%s|%s|%s', name, color, permissions, mentionable, hoist, unicode_emoji)
                   ORDER BY position)
    FROM public.server_roles WHERE server_id = p_server AND NOT is_default AND NOT is_admin;
$fn$;
CREATE FUNCTION pg_temp.channels_of(p_server uuid) RETURNS text[] LANGUAGE sql AS $fn$
  SELECT array_agg(format('%s|%s|%s|%s|%s|%s', c.name, c.description, c.type, c."order", c.slowmode_seconds, cc.name)
                   ORDER BY c.name)
    FROM public.channels c LEFT JOIN public.channel_categories cc ON cc.id = c.category
   WHERE c.server_id = p_server;
$fn$;
CREATE FUNCTION pg_temp.overrides_of(p_server uuid) RETURNS text[] LANGUAGE sql AS $fn$
  SELECT array_agg(format('%s|%s|%s|%s', c.name, r.name, o.allow_permissions, o.deny_permissions)
                   ORDER BY c.name, r.name)
    FROM public.channel_permission_overrides o
    JOIN public.channels c ON c.id = o.channel_id
    JOIN public.server_roles r ON r.id = o.role_id
   WHERE c.server_id = p_server;
$fn$;
CREATE FUNCTION pg_temp.channel_id(p_server uuid, p_name text) RETURNS uuid LANGUAGE sql AS $fn$
  SELECT id FROM public.channels WHERE server_id = p_server AND name = p_name;
$fn$;
CREATE FUNCTION pg_temp.copy() RETURNS uuid LANGUAGE sql AS $fn$
  SELECT current_setting('t113.copy')::uuid;
$fn$;

SELECT is((SELECT name FROM public.servers WHERE id = pg_temp.copy()), 'Copy113', 'the name is the one given, trimmed');
SELECT is((SELECT owner FROM public.servers WHERE id = pg_temp.copy()), '33333333-0000-0000-0000-000000000003'::uuid,
          'the caller owns the copy');
SELECT ok(EXISTS (SELECT 1 FROM public.user_servers
                   WHERE server_id = pg_temp.copy() AND user_id = '33333333-0000-0000-0000-000000000003'
                     AND status = 'accepted'),
          'the owner is an accepted member');
SELECT ok(EXISTS (SELECT 1 FROM public.user_roles ur JOIN public.server_roles r ON r.id = ur.role_id
                   WHERE ur.server_id = pg_temp.copy() AND ur.user_id = '33333333-0000-0000-0000-000000000003'
                     AND r.is_admin AND r.name = 'Admin' AND (r.permissions & 1) = 1),
          'the owner holds the Admin role, which keeps ADMINISTRATOR');
SELECT is((SELECT count(*) FROM public.user_roles WHERE server_id = pg_temp.copy()), 2::bigint,
          'no other role assignment is copied');
SELECT is((SELECT row(description, public, allow_cross_server_emojis, rules, category)::text
             FROM public.servers WHERE id = pg_temp.copy()),
          (SELECT row(description, public, allow_cross_server_emojis, rules, category)::text
             FROM public.servers WHERE id = 'f1131000-0000-0000-0000-000000000001'),
          'server settings match');
SELECT is((SELECT federation_enabled FROM public.servers WHERE id = pg_temp.copy()), false,
          'federation stays off');

SELECT is(pg_temp.roles_of(pg_temp.copy()), pg_temp.roles_of('f1131000-0000-0000-0000-000000000001'),
          'roles match in order, with permissions');
SELECT is((SELECT format('%s|%s|%s', color, permissions, position) FROM public.server_roles
            WHERE server_id = pg_temp.copy() AND is_default),
          '#123456|462850|0', '@everyone is updated in place');
SELECT ok((SELECT position FROM public.server_roles WHERE server_id = pg_temp.copy() AND is_admin)
          > (SELECT max(position) FROM public.server_roles WHERE server_id = pg_temp.copy() AND NOT is_admin),
          'Admin outranks every template role');
SELECT is((SELECT count(*) FROM public.server_roles WHERE server_id = pg_temp.copy()), 4::bigint,
          'no extra roles');

SELECT is((SELECT array_agg(format('%s|%s', name, "order") ORDER BY "order") FROM public.channel_categories
            WHERE server_id = pg_temp.copy()),
          ARRAY['info|0', 'talk|1'], 'categories match; the defaults are gone');
SELECT is(pg_temp.channels_of(pg_temp.copy()), pg_temp.channels_of('f1131000-0000-0000-0000-000000000001'),
          'channels match: type, order, slowmode, category; the defaults are gone');
SELECT is(pg_temp.overrides_of(pg_temp.copy()), pg_temp.overrides_of('f1131000-0000-0000-0000-000000000001'),
          'role overrides are remapped to the copy''s roles');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.channel_permission_overrides o JOIN public.channels c ON c.id = o.channel_id
                       WHERE c.server_id = pg_temp.copy() AND o.user_id IS NOT NULL),
          'no member override is copied');
SELECT ok(public.channel_is_restricted(pg_temp.channel_id(pg_temp.copy(), 'staff113'))
          AND NOT public.channel_is_restricted(pg_temp.channel_id(pg_temp.copy(), 'welcome113')),
          'the private channel stays private');

SELECT is((SELECT format('%s|%s|%s|%s|%s', r.name, c.name, ss.system_messages_enabled, ss.newcomer_alerts,
                         ss.default_message_notifications)
             FROM public.server_settings ss
             JOIN public.server_roles r ON r.id = ss.default_role_id
             JOIN public.channels c ON c.id = ss.system_channel_id
            WHERE ss.server_id = pg_temp.copy()),
          'members|welcome113|f|t|all', 'settings match, ids remapped');
SELECT is((SELECT invite_permissions FROM public.server_settings WHERE server_id = pg_temp.copy()),
          jsonb_build_object('who_can_create', 'roles', 'default_expiration', 60, 'max_expiration', 0,
                             'allow_temporary', false, 'max_uses_limit', 10,
                             'allowed_roles', jsonb_build_array((SELECT id FROM public.server_roles
                                                                  WHERE server_id = pg_temp.copy() AND name = 'mods'))),
          'invite settings match, roles remapped');

SELECT is((SELECT row(enabled, message, rules, require_acceptance)::text FROM public.server_welcome_screens
            WHERE server_id = pg_temp.copy()),
          (SELECT row(enabled, message, rules, require_acceptance)::text FROM public.server_welcome_screens
            WHERE server_id = 'f1131000-0000-0000-0000-000000000001'),
          'the welcome screen matches');

SELECT is((SELECT format('%s|%s|%s|%s', st.enabled, st.exempt_bots, c.name, st.raid_settings)
             FROM public.server_automod_settings st JOIN public.channels c ON c.id = st.alert_channel_id
            WHERE st.server_id = pg_temp.copy()),
          (SELECT format('%s|%s|%s|%s', st.enabled, st.exempt_bots, c.name, st.raid_settings)
             FROM public.server_automod_settings st JOIN public.channels c ON c.id = st.alert_channel_id
            WHERE st.server_id = 'f1131000-0000-0000-0000-000000000001'),
          'AutoMod settings match');
SELECT is((SELECT array_agg(format('%s|%s|%s|%s|%s|%s', name, rule_type, enabled, config, actions, position)
                            ORDER BY position, name)
             FROM public.server_automod_rules WHERE server_id = pg_temp.copy()),
          (SELECT array_agg(format('%s|%s|%s|%s|%s|%s', name, rule_type, enabled, config, actions, position)
                            ORDER BY position, name)
             FROM public.server_automod_rules WHERE server_id = 'f1131000-0000-0000-0000-000000000001'),
          'AutoMod rules match');
-- upsert_server_automod_rule stores the exempt lists DISTINCT, in no fixed order.
SELECT is((SELECT format('%s|%s', r.exempt_role_ids,
                         (SELECT array_agg(x ORDER BY x) FROM unnest(r.exempt_channel_ids) x))
             FROM public.server_automod_rules r WHERE r.server_id = pg_temp.copy() AND r.name = 'No badword'),
          format('%s|%s',
                 ARRAY[(SELECT id FROM public.server_roles WHERE server_id = pg_temp.copy() AND name = 'mods')],
                 (SELECT array_agg(x ORDER BY x)
                    FROM unnest(ARRAY[pg_temp.channel_id(pg_temp.copy(), 'staff113'),
                                      (SELECT id FROM public.channel_categories
                                        WHERE server_id = pg_temp.copy() AND name = 'info')]) x)),
          'AutoMod exemptions are remapped');
SELECT ok((SELECT jsonb_array_length(compiled -> 'rules') FROM public.server_automod_settings
            WHERE server_id = pg_temp.copy()) = 4,
          'enabled AutoMod rules are compiled');

-- Without optional sections. ----------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT ok(set_config('t113.bare',
                     public.create_server_from_template('Bare113', '{"format": "harmony.server-template", "version": 1}')::text,
                     true) IS NOT NULL, 'a template of format and version alone is accepted');
SELECT tests.clear_authentication();
SELECT is((SELECT format('%s|%s|%s', (SELECT count(*) FROM public.channels WHERE server_id = s.id),
                                     (SELECT count(*) FROM public.server_roles WHERE server_id = s.id),
                                     (SELECT count(*) FROM public.server_automod_rules WHERE server_id = s.id))
             FROM public.servers s WHERE s.id = current_setting('t113.bare')::uuid),
          '0|2|6', 'it has no channels, @everyone and Admin, and the AutoMod preset');

-- Validation. -------------------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');

SELECT throws_ok($$SELECT public.create_server_from_template('Bad', '{"format": "other", "version": 1}')$$,
                 '22023', NULL, 'another format is refused');
SELECT throws_ok($$SELECT public.create_server_from_template('Bad', '{"format": "harmony.server-template", "version": 2}')$$,
                 '22023', NULL, 'another version is refused');
SELECT throws_ok($$SELECT public.create_server_from_template('Bad',
                     jsonb_set(current_setting('t113.tpl')::jsonb, '{channels,1,category}', '"nope"'))$$,
                 '22023', NULL, 'a category ref that resolves to nothing is refused');
SELECT throws_ok($$SELECT public.create_server_from_template('Bad',
                     jsonb_set(current_setting('t113.tpl')::jsonb, '{categories,0,ref}', '"r1"'))$$,
                 '22023', NULL, 'a duplicate ref is refused');
SELECT throws_ok($$SELECT public.create_server_from_template('Bad',
                     jsonb_set(current_setting('t113.tpl')::jsonb, '{channels,0,overrides}',
                               '[{"role": "c1", "allow": "2", "deny": "0"}]'))$$,
                 '22023', NULL, 'an override naming a category is refused');
SELECT throws_ok($$SELECT public.create_server_from_template('Bad',
                     jsonb_set(current_setting('t113.tpl')::jsonb, '{channels,0,overrides}',
                               '[{"role": "r1", "deny": "2"}, {"role": "r1", "allow": "2"}]'))$$,
                 '22023', NULL, 'two overrides for one role on a channel are refused');
SELECT throws_ok($$SELECT public.create_server_from_template('Bad',
                     jsonb_set(current_setting('t113.tpl')::jsonb, '{roles,1,permissions}',
                               to_jsonb((1::bigint << array_length(public.permission_bit_names(), 1))::text)))$$,
                 '22023', NULL, 'a permission bit beyond the named ones is refused');
SELECT throws_ok($$SELECT public.create_server_from_template('Bad',
                     jsonb_set(current_setting('t113.tpl')::jsonb, '{roles,1,permissions}', '"-1"'))$$,
                 '22023', NULL, 'a negative mask is refused');
SELECT throws_ok($$SELECT public.create_server_from_template('Bad',
                     jsonb_set(current_setting('t113.tpl')::jsonb, '{roles,1,is_default}', 'true'))$$,
                 '22023', NULL, 'two @everyone roles are refused');
SELECT throws_ok($$SELECT public.create_server_from_template('Bad',
                     jsonb_set(current_setting('t113.tpl')::jsonb, '{channels}',
                               (SELECT jsonb_agg(jsonb_build_object('ref', 'x' || i, 'name', 'c' || i))
                                  FROM generate_series(1, 101) i)))$$,
                 '22023', NULL, 'more than 100 channels are refused');
SELECT throws_ok($$SELECT public.create_server_from_template('Bad',
                     jsonb_set(current_setting('t113.tpl')::jsonb, '{categories}',
                               (SELECT jsonb_agg(jsonb_build_object('ref', 'x' || i, 'name', 'c' || i))
                                  FROM generate_series(1, 26) i)))$$,
                 '22023', NULL, 'more than 25 categories are refused');
SELECT throws_ok($$SELECT public.create_server_from_template('Bad',
                     jsonb_set(current_setting('t113.tpl')::jsonb, '{roles,1,name}', to_jsonb(repeat('x', 101))))$$,
                 '22023', NULL, 'a role name over 100 characters is refused');
SELECT throws_ok($$SELECT public.create_server_from_template('Bad',
                     jsonb_set(current_setting('t113.tpl')::jsonb, '{channels,0,type}', '2'))$$,
                 '22023', NULL, 'a channel type other than text or voice is refused');
SELECT throws_ok($$SELECT public.create_server_from_template('Bad',
                     jsonb_set(current_setting('t113.tpl')::jsonb, '{settings,default_role}',
                               (SELECT r -> 'ref' FROM jsonb_array_elements(current_setting('t113.tpl')::jsonb -> 'roles') r
                                 WHERE (r ->> 'is_admin')::boolean)))$$,
                 '22023', NULL, 'the Admin role as default role is refused');
SELECT throws_ok($$SELECT public.create_server_from_template('Bad',
                     jsonb_set(current_setting('t113.tpl')::jsonb, '{settings,system_channel}',
                               (SELECT c -> 'ref' FROM jsonb_array_elements(current_setting('t113.tpl')::jsonb -> 'channels') c
                                 WHERE c ->> 'name' = 'lounge113')))$$,
                 '22023', NULL, 'a voice system channel is refused');
SELECT throws_ok($$SELECT public.create_server_from_template('   ', current_setting('t113.tpl')::jsonb)$$,
                 '23514', NULL, 'a blank name is refused');

-- Rule types are checked by upsert_server_automod_rule, after the server row exists.
SELECT throws_ok($$SELECT public.create_server_from_template('Broken113',
                     jsonb_set(current_setting('t113.tpl')::jsonb, '{automod,rules,0,rule_type}', '"bogus"'))$$,
                 '22023', NULL, 'an unknown AutoMod rule type is refused');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*) FROM public.servers WHERE name = 'Broken113'), 0::bigint,
          'a refused template leaves no server behind');

SELECT tests.authenticate_as_anon();
SELECT throws_ok($$SELECT public.create_server_from_template('Anon', '{"format": "harmony.server-template", "version": 1}')$$,
                 '42501', NULL, 'anon cannot create');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
