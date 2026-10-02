-- 20261007000001_supporters_and_bot_writes.sql: supporter columns and admin RPCs, and the
-- bot channel grant RPCs.
--
--   alice    owns server_1; instance admin from setup
--   bob      member of server_1
--   carol72  member of server_1 holding managers72 (MANAGE_SERVER, VIEW_CHANNEL on mods72);
--            an expired supporter
--   dave72   banned on server_1, holding managers72
--   mallory  in no server
--
-- server_1 channels: general (fixture, open), staff72 and mods72 (@everyone denied
-- VIEW_CHANNEL). other72 is a channel of another server. bot72 is installed in server_1;
-- bot72b's installation there is inactive.
--
-- Supporter rows are written through the admin RPCs and as service_role: production grants
-- postgres nothing on instance_supporters.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(64);

-- Setup, as postgres. -------------------------------------------------------------------
UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f7200000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol72@test.local'),
  ('f7200000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dave72@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('f7210000-0000-0000-0000-0000000000a1', 'f7200000-0000-0000-0000-0000000000a1', 'carol72', 'Carol', true),
  ('f7210000-0000-0000-0000-0000000000a2', 'f7200000-0000-0000-0000-0000000000a2', 'dave72', 'Dave', true);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('f7210000-0000-0000-0000-0000000000a1', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('f7210000-0000-0000-0000-0000000000a2', '55555555-0000-0000-0000-000000000005', 'banned');

INSERT INTO public.servers (id, name, owner)
VALUES ('f7220000-0000-0000-0000-000000000001', 'Other72', '22222222-0000-0000-0000-000000000002');
INSERT INTO public.posts (id, author_id, content, visibility)
VALUES ('f7280000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002',
        '[{"type":"text","text":"post72"}]', 'public');
INSERT INTO public.channels (id, server_id, name, type, "order") VALUES
  ('f7230000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'staff72', 0, 1),
  ('f7230000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'mods72', 0, 2),
  ('f7230000-0000-0000-0000-000000000003', 'f7220000-0000-0000-0000-000000000001', 'other72', 0, 0);

-- MANAGE_SERVER is bit 7; VIEW_CHANNEL bit 1.
INSERT INTO public.server_roles (id, server_id, name, position, permissions)
VALUES ('f7240000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'managers72', 1, 128);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('f7210000-0000-0000-0000-0000000000a1', 'f7240000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005'),
  ('f7210000-0000-0000-0000-0000000000a2', 'f7240000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005');
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
SELECT ch, 'role', r.id, NULL, 0, 2
  FROM public.server_roles r
 CROSS JOIN unnest(ARRAY['f7230000-0000-0000-0000-000000000001',
                         'f7230000-0000-0000-0000-000000000002']::uuid[]) ch
 WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
VALUES ('f7230000-0000-0000-0000-000000000002', 'role', 'f7240000-0000-0000-0000-000000000001', NULL, 2, 0);

INSERT INTO public.bots (id, username, display_name, owner_id, is_public, is_active) VALUES
  ('f7250000-0000-0000-0000-000000000001', 'bot72', 'Bot 72', '11111111-0000-0000-0000-000000000001', true, true),
  ('f7250000-0000-0000-0000-000000000002', 'bot72b', 'Bot 72b', '11111111-0000-0000-0000-000000000001', true, true);
INSERT INTO public.bot_server_permissions (bot_id, server_id, installed_by, is_active) VALUES
  ('f7250000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', true),
  ('f7250000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', false);

CREATE FUNCTION pg_temp.allowed72() RETURNS uuid[]
LANGUAGE sql SECURITY DEFINER AS $fn$
  SELECT allowed_channel_ids FROM public.bot_server_permissions
   WHERE bot_id = 'f7250000-0000-0000-0000-000000000001'
     AND server_id = '55555555-0000-0000-0000-000000000005'
$fn$;
GRANT EXECUTE ON FUNCTION pg_temp.allowed72() TO authenticated;
GRANT USAGE ON SCHEMA tests TO service_role;

-- instance_supporters privileges. --------------------------------------------------------
SELECT ok(NOT has_column_privilege('authenticated', 'public.instance_supporters', 'amount', 'SELECT')
          AND NOT has_column_privilege('authenticated', 'public.instance_supporters', 'external_id', 'SELECT')
          AND NOT has_column_privilege('authenticated', 'public.instance_supporters', 'platform', 'SELECT')
          AND NOT has_column_privilege('authenticated', 'public.instance_supporters', 'started_at', 'SELECT')
          AND NOT has_column_privilege('authenticated', 'public.instance_supporters', 'expires_at', 'SELECT'),
  'clients cannot read amount, external_id, platform, started_at or expires_at');
SELECT ok(has_column_privilege('authenticated', 'public.instance_supporters', 'id', 'SELECT')
          AND has_column_privilege('authenticated', 'public.instance_supporters', 'user_id', 'SELECT')
          AND has_column_privilege('authenticated', 'public.instance_supporters', 'tier_id', 'SELECT')
          AND has_column_privilege('authenticated', 'public.instance_supporters', 'is_active', 'SELECT'),
  'clients read who supports and at which tier');
SELECT ok(NOT has_any_column_privilege('authenticated', 'public.instance_supporters', 'INSERT')
          AND NOT has_any_column_privilege('authenticated', 'public.instance_supporters', 'UPDATE')
          AND NOT has_table_privilege('authenticated', 'public.instance_supporters', 'DELETE'),
  'clients hold no write privilege');
SELECT ok(NOT has_any_column_privilege('anon', 'public.instance_supporters', 'SELECT')
          AND NOT has_any_column_privilege('anon', 'public.instance_supporters', 'INSERT')
          AND NOT has_any_column_privilege('anon', 'public.instance_supporters', 'UPDATE'),
  'anon holds nothing');
SELECT ok(has_table_privilege('service_role', 'public.instance_supporters', 'SELECT')
          AND has_table_privilege('service_role', 'public.instance_supporters', 'INSERT')
          AND has_table_privilege('service_role', 'public.instance_supporters', 'UPDATE'),
  'the Ko-fi webhook keeps SELECT, INSERT and UPDATE');

-- Admin writes. --------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO public.instance_supporter_tiers (id, name, min_amount, badge_icon, badge_color)
VALUES ('f7260000-0000-0000-0000-000000000001', 'Gold72', 5, 'star', '#ffcc00');
SELECT isnt(public.admin_add_supporter('22222222-0000-0000-0000-000000000002',
                                        'f7260000-0000-0000-0000-000000000001', 12.50, 'ko-fi'),
            NULL, 'an admin adds a supporter');
SELECT is((SELECT e ->> 'amount' FROM jsonb_array_elements(public.admin_list_supporters()) e
            WHERE e ->> 'user_id' = '22222222-0000-0000-0000-000000000002'),
  '12.50', 'admin_list_supporters returns the amount');
SELECT is((SELECT row(e ->> 'platform', e -> 'tier' ->> 'name', e -> 'user' ->> 'username')::text
             FROM jsonb_array_elements(public.admin_list_supporters()) e
            WHERE e ->> 'user_id' = '22222222-0000-0000-0000-000000000002'),
  '(ko-fi,Gold72,bob)', 'admin_list_supporters returns platform, tier and profile');

-- Client reads and writes. --------------------------------------------------------------
-- carol72's supporter row has expired.
SELECT tests.clear_authentication();
SELECT set_config('role', 'service_role', true);
INSERT INTO public.instance_supporters (user_id, tier_id, amount, is_active, started_at, expires_at)
VALUES ('f7210000-0000-0000-0000-0000000000a1', 'f7260000-0000-0000-0000-000000000001', 9, true,
        now() - interval '40 days', now() - interval '1 day');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT amount FROM public.instance_supporters$q$, '42501', NULL,
  'a user cannot read amounts');
SELECT throws_ok($q$SELECT external_id FROM public.instance_supporters$q$, '42501', NULL,
  'a user cannot read external ids');
SELECT throws_ok($q$SELECT * FROM public.instance_supporters$q$, '42501', NULL,
  'a user cannot select every column');
SELECT is((SELECT row(s.is_active, t.name)::text
             FROM public.instance_supporters s
             JOIN public.instance_supporter_tiers t ON t.id = s.tier_id
            WHERE s.user_id = '22222222-0000-0000-0000-000000000002'),
  '(t,Gold72)', 'a user reads who supports at which tier, the profile embed''s columns');
SELECT throws_ok($q$SELECT started_at FROM public.instance_supporters$q$, '42501', NULL,
  'a user cannot read started_at');
SELECT throws_ok($q$SELECT expires_at FROM public.instance_supporters$q$, '42501', NULL,
  'a user cannot read expires_at');
SELECT is((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.user_id)
             FROM public.get_supporter_badges(ARRAY['22222222-0000-0000-0000-000000000002',
                                                    'f7210000-0000-0000-0000-0000000000a1']::uuid[]) b),
  '[{"user_id": "22222222-0000-0000-0000-000000000002", "tier_name": "Gold72", "badge_icon": "star",
     "badge_color": "#ffcc00", "is_active": true}]'::jsonb,
  'get_supporter_badges returns the badge alone, and nothing for an expired supporter');
SELECT ok((SELECT count(*) FROM public.instance_supporters WHERE is_active) >= 1,
  'a user counts active supporters');
SELECT ok((SELECT bool_or(e -> 'author' -> 'supporter_membership' @> '[{"is_active": true, "tier": {"name": "Gold72"}}]')
             FROM jsonb_array_elements(public.get_home_timeline_page(20)) e
            WHERE e ->> 'id' = 'f7280000-0000-0000-0000-000000000001'),
  'the home timeline embeds the author''s supporter tier for a user');
SELECT throws_ok($q$INSERT INTO public.instance_supporters (user_id, amount) VALUES ('22222222-0000-0000-0000-000000000002', 1)
                   ON CONFLICT (user_id) DO UPDATE SET amount = EXCLUDED.amount$q$,
  '42501', NULL, 'a user cannot upsert a supporter row');
SELECT throws_ok($q$UPDATE public.instance_supporters SET is_active = false
                    WHERE user_id = '22222222-0000-0000-0000-000000000002'$q$,
  '42501', NULL, 'a user cannot update a supporter row');
SELECT throws_ok($q$DELETE FROM public.instance_supporters$q$, '42501', NULL,
  'a user cannot delete supporter rows');
SELECT throws_ok($q$SELECT public.admin_list_supporters()$q$, '42501', NULL,
  'a user cannot list supporters with amounts');
SELECT throws_ok($q$SELECT public.admin_add_supporter('22222222-0000-0000-0000-000000000002', NULL, 1, NULL)$q$,
  '42501', NULL, 'a user cannot add a supporter');
SELECT throws_ok($q$SELECT public.admin_update_supporter('22222222-0000-0000-0000-000000000002', '{"amount": 1}')$q$,
  '42501', NULL, 'a user cannot update a supporter');
SELECT throws_ok($q$SELECT public.admin_resolve_pending_donation('f7270000-0000-0000-0000-000000000001',
                                                                 '22222222-0000-0000-0000-000000000002')$q$,
  '42501', NULL, 'a user cannot resolve a pending donation');

-- admin_add_supporter and admin_update_supporter. ----------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT ok(public.admin_update_supporter('22222222-0000-0000-0000-000000000002', '{"amount": 20, "platform": null}'),
  'an admin updates a supporter');
SELECT is((SELECT row(e ->> 'amount', e ->> 'platform', e ->> 'tier_id')::text
             FROM jsonb_array_elements(public.admin_list_supporters()) e
            WHERE e ->> 'user_id' = '22222222-0000-0000-0000-000000000002'),
  '(20.00,,f7260000-0000-0000-0000-000000000001)', 'listed keys change, absent keys keep their value');
SELECT ok(public.admin_update_supporter('22222222-0000-0000-0000-000000000002', '{"is_active": false}'),
  'an admin deactivates a supporter');
SELECT ok(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.admin_list_supporters()) e
                       WHERE e ->> 'user_id' = '22222222-0000-0000-0000-000000000002'),
  'a deactivated supporter leaves the list');
SELECT ok(NOT public.admin_update_supporter('33333333-0000-0000-0000-000000000003', '{"amount": 1}'),
  'updating a user without a supporter row answers false');
SELECT throws_ok($q$SELECT public.admin_update_supporter('22222222-0000-0000-0000-000000000002', '{"external_id": "x"}')$q$,
  '22023', 'Unknown supporter field: external_id', 'unknown fields are refused');
SELECT lives_ok($q$SELECT public.admin_add_supporter('22222222-0000-0000-0000-000000000002', NULL, NULL, '  ')$q$,
  'an admin re-adds a deactivated supporter');
SELECT is((SELECT row(e ->> 'is_active', e ->> 'platform', e -> 'amount', e -> 'tier')::text
             FROM jsonb_array_elements(public.admin_list_supporters()) e
            WHERE e ->> 'user_id' = '22222222-0000-0000-0000-000000000002'),
  '(true,manual,null,null)', 're-adding reactivates with the given fields; a blank platform is manual');

-- admin_resolve_pending_donation. -------------------------------------------------------
-- Webhook rows are written and read back as service_role: staging's pending-donation policy
-- compares profiles.id with auth.uid(), which no fixture profile satisfies.
SELECT tests.clear_authentication();
SELECT set_config('role', 'service_role', true);
INSERT INTO public.instance_pending_donations
       (id, platform, external_reference, amount, currency, donor_name, donor_message, raw_payload)
VALUES ('f7270000-0000-0000-0000-000000000001', 'ko-fi', 'txn72a', 7, 'USD', 'M', 'thanks', '{}'),
       ('f7270000-0000-0000-0000-000000000002', 'ko-fi', 'txn72b', 3, 'USD', 'B', NULL, '{}');
-- The webhook already recorded txn72b for bob before an admin attributes the pending copy.
SELECT lives_ok($q$INSERT INTO public.instance_supporters AS s (user_id, amount, platform, is_active, started_at)
                  VALUES ('22222222-0000-0000-0000-000000000002', 3, 'ko-fi', true, now())
                  ON CONFLICT (user_id) DO UPDATE
                     SET amount = EXCLUDED.amount, platform = EXCLUDED.platform,
                         is_active = EXCLUDED.is_active, started_at = EXCLUDED.started_at
                  RETURNING s.id$q$,
  'service_role upserts a supporter as the Ko-fi webhook does');
INSERT INTO public.instance_donation_history (supporter_id, user_id, amount, currency, platform, external_reference)
SELECT s.id, s.user_id, 3, 'USD', 'ko-fi', 'txn72b'
  FROM public.instance_supporters s WHERE s.user_id = '22222222-0000-0000-0000-000000000002';

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT isnt(public.admin_resolve_pending_donation('f7270000-0000-0000-0000-000000000001',
                                                   '33333333-0000-0000-0000-000000000003'),
            NULL, 'an admin attributes a pending donation');
SELECT is((SELECT row(e ->> 'is_active', e ->> 'platform', e ->> 'tier_id')::text
             FROM jsonb_array_elements(public.admin_list_supporters()) e
            WHERE e ->> 'user_id' = '33333333-0000-0000-0000-000000000003'),
  row('true', 'ko-fi', public.compute_supporter_tier_for_amount(7)::text)::text,
  'the supporter row exists and its tier follows the cycle total');
SELECT is(public.admin_resolve_pending_donation('f7270000-0000-0000-0000-000000000001',
                                                 '33333333-0000-0000-0000-000000000003'),
          NULL, 'a resolved donation is not attributed twice');
SELECT lives_ok($q$SELECT public.admin_resolve_pending_donation('f7270000-0000-0000-0000-000000000002',
                                                                '22222222-0000-0000-0000-000000000002')$q$,
  'a donation the webhook already recorded resolves');
SELECT throws_ok($q$SELECT public.admin_resolve_pending_donation('f7270000-0000-0000-0000-0000000000ff',
                                                                 '22222222-0000-0000-0000-000000000002')$q$,
  'P0002', NULL, 'an unknown pending donation is refused');

SELECT tests.clear_authentication();
SELECT set_config('role', 'service_role', true);
SELECT is((SELECT row(user_id, amount, currency, note)::text FROM public.instance_donation_history
            WHERE platform = 'ko-fi' AND external_reference = 'txn72a'),
  '(33333333-0000-0000-0000-000000000003,7.00,USD,thanks)', 'the donation is recorded');
SELECT is((SELECT row(resolved_at IS NOT NULL, resolved_by, resolved_user_id)::text
             FROM public.instance_pending_donations WHERE id = 'f7270000-0000-0000-0000-000000000001'),
  '(t,11111111-0000-0000-0000-000000000001,33333333-0000-0000-0000-000000000003)',
  'the pending row is resolved by the admin''s profile');
SELECT is((SELECT count(*)::int FROM public.instance_donation_history
            WHERE platform = 'ko-fi' AND external_reference IN ('txn72a', 'txn72b')),
  2, 'no donation is recorded twice');
SELECT tests.clear_authentication();

-- Bot channel grants: who may call. -----------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.get_bot_channel_access('55555555-0000-0000-0000-000000000005',
                                                         'f7250000-0000-0000-0000-000000000001')$q$,
  '42501', 'Missing permission: MANAGE_SERVER', 'a plain member cannot read bot channel access');
SELECT throws_ok($q$SELECT public.set_bot_allowed_channels('55555555-0000-0000-0000-000000000005',
                                                           'f7250000-0000-0000-0000-000000000001',
                                                           ARRAY['66666666-0000-0000-0000-000000000006']::uuid[])$q$,
  '42501', 'Missing permission: MANAGE_SERVER', 'a plain member cannot set bot channels');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.set_bot_allowed_channels('55555555-0000-0000-0000-000000000005',
                                                           'f7250000-0000-0000-0000-000000000001', NULL)$q$,
  '42501', 'Missing permission: MANAGE_SERVER', 'a non-member cannot set bot channels');
SELECT tests.authenticate_as('f7200000-0000-0000-0000-0000000000a2');
SELECT throws_ok($q$SELECT public.set_bot_allowed_channels('55555555-0000-0000-0000-000000000005',
                                                           'f7250000-0000-0000-0000-000000000001', NULL)$q$,
  '42501', 'Missing permission: MANAGE_SERVER', 'a banned holder of MANAGE_SERVER cannot set bot channels');
SELECT tests.clear_authentication();

-- Owner. --------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT jsonb_object_agg(c ->> 'name', c -> 'everyone_can_view')
             FROM jsonb_array_elements(public.get_bot_channel_access('55555555-0000-0000-0000-000000000005',
                                                                     'f7250000-0000-0000-0000-000000000001') -> 'channels') c
            WHERE c ->> 'id' IN ('66666666-0000-0000-0000-000000000006', 'f7230000-0000-0000-0000-000000000001',
                                 'f7230000-0000-0000-0000-000000000002')),
  '{"general": true, "mods72": false, "staff72": false}'::jsonb,
  'the owner sees every channel, with @everyone''s visibility');
SELECT is(public.get_bot_channel_access('55555555-0000-0000-0000-000000000005',
                                        'f7250000-0000-0000-0000-000000000001') -> 'allowed_channel_ids',
  'null'::jsonb, 'an unrestricted installation has no list');
SELECT is(public.set_bot_allowed_channels('55555555-0000-0000-0000-000000000005',
                                          'f7250000-0000-0000-0000-000000000001',
                                          ARRAY['f7230000-0000-0000-0000-000000000001',
                                                '66666666-0000-0000-0000-000000000006',
                                                '66666666-0000-0000-0000-000000000006']::uuid[]),
  ARRAY['66666666-0000-0000-0000-000000000006', 'f7230000-0000-0000-0000-000000000001']::uuid[],
  'the owner grants a hidden channel; the list is distinct and sorted');
SELECT is(pg_temp.allowed72(),
  ARRAY['66666666-0000-0000-0000-000000000006', 'f7230000-0000-0000-0000-000000000001']::uuid[],
  'the installation stores the list');
SELECT throws_ok($q$SELECT public.set_bot_allowed_channels('55555555-0000-0000-0000-000000000005',
                                                           'f7250000-0000-0000-0000-000000000001',
                                                           ARRAY['f7230000-0000-0000-0000-000000000003']::uuid[])$q$,
  '22023', 'Channel f7230000-0000-0000-0000-000000000003 is not in this server',
  'a channel of another server is refused');
SELECT throws_ok($q$SELECT public.set_bot_allowed_channels('55555555-0000-0000-0000-000000000005',
                                                           'f7250000-0000-0000-0000-000000000002', NULL)$q$,
  'P0002', 'Bot is not installed in this server', 'an inactive installation is refused');
SELECT tests.clear_authentication();

-- MANAGE_SERVER holder. -----------------------------------------------------------------
SELECT tests.authenticate_as('f7200000-0000-0000-0000-0000000000a1');
SELECT is((SELECT jsonb_agg(c ->> 'name' ORDER BY c ->> 'name')
             FROM jsonb_array_elements(public.get_bot_channel_access('55555555-0000-0000-0000-000000000005',
                                                                     'f7250000-0000-0000-0000-000000000001') -> 'channels') c
            WHERE c ->> 'id' IN ('66666666-0000-0000-0000-000000000006', 'f7230000-0000-0000-0000-000000000001',
                                 'f7230000-0000-0000-0000-000000000002')),
  '["general", "mods72"]'::jsonb, 'a MANAGE_SERVER holder lists the channels they can view');
SELECT is(public.get_bot_channel_access('55555555-0000-0000-0000-000000000005',
                                        'f7250000-0000-0000-0000-000000000001') -> 'allowed_channel_ids',
  '["66666666-0000-0000-0000-000000000006"]'::jsonb,
  'listed channels the caller cannot view are not shown');
SELECT is(public.set_bot_allowed_channels('55555555-0000-0000-0000-000000000005',
                                          'f7250000-0000-0000-0000-000000000001',
                                          ARRAY['f7230000-0000-0000-0000-000000000002']::uuid[]),
  ARRAY['f7230000-0000-0000-0000-000000000001', 'f7230000-0000-0000-0000-000000000002']::uuid[],
  'a MANAGE_SERVER holder grants a channel they view; a listed channel they cannot view stays');
SELECT is(public.set_bot_allowed_channels('55555555-0000-0000-0000-000000000005',
                                          'f7250000-0000-0000-0000-000000000001',
                                          ARRAY['66666666-0000-0000-0000-000000000006',
                                                'f7230000-0000-0000-0000-000000000001']::uuid[]),
  ARRAY['66666666-0000-0000-0000-000000000006', 'f7230000-0000-0000-0000-000000000001']::uuid[],
  'a listed channel the caller cannot view may be resubmitted');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.set_bot_allowed_channels('55555555-0000-0000-0000-000000000005',
                                                          'f7250000-0000-0000-0000-000000000001',
                                                          ARRAY['66666666-0000-0000-0000-000000000006']::uuid[])$q$,
  'the owner narrows the list');
SELECT tests.authenticate_as('f7200000-0000-0000-0000-0000000000a1');
SELECT throws_ok($q$SELECT public.set_bot_allowed_channels('55555555-0000-0000-0000-000000000005',
                                                           'f7250000-0000-0000-0000-000000000001',
                                                           ARRAY['66666666-0000-0000-0000-000000000006',
                                                                 'f7230000-0000-0000-0000-000000000001']::uuid[])$q$,
  '42501', 'Channel f7230000-0000-0000-0000-000000000001 is not visible to the caller',
  'a MANAGE_SERVER holder cannot grant a channel they cannot view');
SELECT is(pg_temp.allowed72(), ARRAY['66666666-0000-0000-0000-000000000006']::uuid[],
  'a refused grant leaves the list unchanged');
SELECT is(public.set_bot_allowed_channels('55555555-0000-0000-0000-000000000005',
                                          'f7250000-0000-0000-0000-000000000001', NULL),
  NULL::uuid[], 'NULL restores the @everyone default');
SELECT is(pg_temp.allowed72(), NULL::uuid[], 'the installation is unrestricted again');
SELECT tests.clear_authentication();

-- Function properties. ------------------------------------------------------------------
SELECT ok(NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('admin_list_supporters', 'admin_add_supporter', 'admin_update_supporter',
                         'admin_resolve_pending_donation', 'get_bot_channel_access',
                         'set_bot_allowed_channels')
       AND (has_function_privilege('anon', p.oid, 'EXECUTE')
            OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
  'the new RPCs are executable by authenticated and not by anon');
SELECT is((SELECT count(*)::int FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('admin_list_supporters', 'admin_add_supporter', 'admin_update_supporter',
                                'admin_resolve_pending_donation', 'get_bot_channel_access',
                                'set_bot_allowed_channels')
              AND p.prosecdef
              AND p.proconfig @> ARRAY['search_path=public, pg_temp']),
  6, 'each is SECURITY DEFINER with a fixed search_path');

SELECT is((SELECT count(*)::int FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('get_supporter_badge', 'get_supporter_badges')
              AND p.prosecdef
              AND p.proconfig @> ARRAY['search_path=public, pg_temp']),
  2, 'the badge functions are SECURITY DEFINER with a fixed search_path');
SELECT ok(has_function_privilege('authenticated', 'public.get_supporter_badges(uuid[])', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.get_supporter_badges(uuid[])', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.get_supporter_badge(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.get_supporter_badge(uuid)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.get_supporter_badge(uuid)', 'EXECUTE'),
  'get_supporter_badges is a client RPC for authenticated; get_supporter_badge is service-only');

SELECT * FROM finish();
ROLLBACK;
