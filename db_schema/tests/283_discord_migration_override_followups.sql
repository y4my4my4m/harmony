-- "Migrate from Discord": member channel override follow-ups,
-- 20261112600005_discord_migration_override_followups.sql.
--
--   bob  accepted member linked to Discord 600000000000000001; the snapshot gives him an overwrite on
--        general (e1), staff (e2) and lounge (e3), all paired with Discord channels
--
-- The apply function is granted to no role; the file runs as the table owner and calls it directly.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(23);

CREATE TEMP TABLE out (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;

INSERT INTO public.servers (id, name, owner) VALUES
  ('f2830000-0000-0000-0000-0000000000a1', 'S1 283', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'f2830000-0000-0000-0000-0000000000a1', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'f2830000-0000-0000-0000-0000000000a1', 'accepted');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f2830000-0000-0000-0000-0000000000e1', 'f2830000-0000-0000-0000-0000000000a1', 'general283', 0),
  ('f2830000-0000-0000-0000-0000000000e2', 'f2830000-0000-0000-0000-0000000000a1', 'staff283', 0),
  ('f2830000-0000-0000-0000-0000000000e3', 'f2830000-0000-0000-0000-0000000000a1', 'lounge283', 0);
INSERT INTO public.discord_bridges (id, server_id, mode, discord_guild_id, created_by) VALUES
  ('f2830000-0000-0000-0000-0000000000b1', 'f2830000-0000-0000-0000-0000000000a1', 'hosted',
   '900000000000000283', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.discord_bridge_channels (bridge_id, harmony_channel_id, discord_channel_id) VALUES
  ('f2830000-0000-0000-0000-0000000000b1', 'f2830000-0000-0000-0000-0000000000e1', '800000000000000001'),
  ('f2830000-0000-0000-0000-0000000000b1', 'f2830000-0000-0000-0000-0000000000e2', '800000000000000002'),
  ('f2830000-0000-0000-0000-0000000000b1', 'f2830000-0000-0000-0000-0000000000e3', '800000000000000003');
INSERT INTO public.discord_migrations (server_id, discord_guild_id, credential_source, state, opened_at) VALUES
  ('f2830000-0000-0000-0000-0000000000a1', '900000000000000283', 'instance_bot', 'open', now());
INSERT INTO public.discord_migration_links (server_id, user_id, discord_user_id, status) VALUES
  ('f2830000-0000-0000-0000-0000000000a1', '22222222-0000-0000-0000-000000000002', '600000000000000001', 'active');
INSERT INTO public.discord_migration_member_overrides (server_id, discord_channel_id, discord_user_id, allow_harmony, deny_harmony, discord_channel_name) VALUES
  ('f2830000-0000-0000-0000-0000000000a1', '800000000000000001', '600000000000000001', 2, 0, 'general'),
  ('f2830000-0000-0000-0000-0000000000a1', '800000000000000002', '600000000000000001', 2, 0, 'staff'),
  ('f2830000-0000-0000-0000-0000000000a1', '800000000000000003', '600000000000000001', 2, 0, 'lounge');

CREATE FUNCTION pg_temp.ov(ch text) RETURNS bigint LANGUAGE sql AS $$
  SELECT allow_permissions FROM public.channel_permission_overrides
   WHERE channel_id = ('f2830000-0000-0000-0000-0000000000' || ch)::uuid AND user_id = '22222222-0000-0000-0000-000000000002'
$$;
CREATE FUNCTION pg_temp.apply() RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.discord_migration_apply_member_overrides('f2830000-0000-0000-0000-0000000000a1', '22222222-0000-0000-0000-000000000002')
$$;
CREATE FUNCTION pg_temp.tracked() RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM public.discord_migration_applied_overrides
   WHERE server_id = 'f2830000-0000-0000-0000-0000000000a1' AND user_id = '22222222-0000-0000-0000-000000000002'
$$;

-- Applied bits are recorded -----------------------------------------------------------------------------
INSERT INTO out VALUES ('a1', pg_temp.apply());
SELECT is((SELECT v ->> 'created' FROM out WHERE k = 'a1'), '3', 'the first apply creates the three overrides');
SELECT results_eq($q$SELECT applied_allow, applied_deny FROM public.discord_migration_applied_overrides
                      WHERE harmony_channel_id = 'f2830000-0000-0000-0000-0000000000e1'$q$,
  $q$VALUES (2::bigint, 0::bigint)$q$, 'the tracking row records the bits applied');

-- An admin edits staff and deletes lounge -----------------------------------------------------------------
UPDATE public.channel_permission_overrides SET allow_permissions = 4
 WHERE channel_id = 'f2830000-0000-0000-0000-0000000000e2' AND user_id = '22222222-0000-0000-0000-000000000002';
DELETE FROM public.channel_permission_overrides
 WHERE channel_id = 'f2830000-0000-0000-0000-0000000000e3' AND user_id = '22222222-0000-0000-0000-000000000002';
SELECT is((SELECT count(*)::int FROM public.discord_migration_applied_overrides
            WHERE harmony_channel_id = 'f2830000-0000-0000-0000-0000000000e3' AND dismissed_at IS NOT NULL AND override_id IS NULL),
  1, 'an admin''s delete tombstones the tracking row instead of dropping it');
INSERT INTO out VALUES ('a2', pg_temp.apply());
SELECT is(pg_temp.ov('e2'), 4::bigint, 'an admin-edited override is never overwritten');
SELECT is((SELECT count(*)::int FROM public.channel_permission_overrides
            WHERE channel_id = 'f2830000-0000-0000-0000-0000000000e3' AND user_id = '22222222-0000-0000-0000-000000000002'),
  0, 'a deleted override is not recreated');
SELECT is((SELECT v ->> 'created' FROM out WHERE k = 'a2'), '0', 'and nothing is created');
SELECT is((SELECT count(*)::int FROM public.discord_migration_applied_overrides
            WHERE dismissed_at IS NOT NULL), 2, 'both pairs are dismissed');
SELECT is(pg_temp.ov('e1'), 2::bigint, 'the untouched override stays');

-- A later Discord change still reaches the managed override ------------------------------------------------
UPDATE public.discord_migration_member_overrides SET allow_harmony = 6
 WHERE discord_channel_id = '800000000000000001';
SELECT pg_temp.apply();
SELECT is(pg_temp.ov('e1'), 6::bigint, 'a Discord change updates the override the migration still manages');
SELECT is((SELECT applied_allow FROM public.discord_migration_applied_overrides
            WHERE harmony_channel_id = 'f2830000-0000-0000-0000-0000000000e1'), 6::bigint, 'and the recorded bits follow');

-- The tombstone goes with the Discord overwrite ------------------------------------------------------------
DELETE FROM public.discord_migration_member_overrides WHERE discord_channel_id = '800000000000000003';
SELECT pg_temp.apply();
SELECT is((SELECT count(*)::int FROM public.discord_migration_applied_overrides
            WHERE harmony_channel_id = 'f2830000-0000-0000-0000-0000000000e3'), 0, 'a tombstone is dropped once Discord no longer has the overwrite');
INSERT INTO public.discord_migration_member_overrides (server_id, discord_channel_id, discord_user_id, allow_harmony, deny_harmony, discord_channel_name) VALUES
  ('f2830000-0000-0000-0000-0000000000a1', '800000000000000003', '600000000000000001', 2, 0, 'lounge');
SELECT pg_temp.apply();
SELECT is(pg_temp.ov('e3'), 2::bigint, 'and a new overwrite is applied again');

-- Leaving removes what the migration made ---------------------------------------------------------------------
DELETE FROM public.user_servers
 WHERE server_id = 'f2830000-0000-0000-0000-0000000000a1' AND user_id = '22222222-0000-0000-0000-000000000002';
SELECT is(pg_temp.ov('e1'), NULL::bigint, 'leaving the server removes the migration-made override on general');
SELECT is(pg_temp.ov('e3'), NULL::bigint, 'and on lounge');
SELECT is(pg_temp.ov('e2'), 4::bigint, 'an admin-edited override stays');
SELECT is(pg_temp.tracked(), 0, 'and nothing stays tracked');
SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE server_id = 'f2830000-0000-0000-0000-0000000000a1' AND action = 'override.delete'
              AND source = 'system' AND details ->> 'via' = 'discord_migration'
              AND target_id = 'f2830000-0000-0000-0000-0000000000e1'), 1, 'the removal is audited as a system row');

-- Rejoining without an active link adds nothing -------------------------------------------------------------------
UPDATE public.discord_migration_links SET status = 'left'
 WHERE server_id = 'f2830000-0000-0000-0000-0000000000a1' AND user_id = '22222222-0000-0000-0000-000000000002';
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f2830000-0000-0000-0000-0000000000a1', 'accepted');
SELECT pg_temp.apply();
SELECT is(pg_temp.ov('e1'), NULL::bigint, 'rejoining through an invite without an active link does not bring the override back');

-- A link that is active again gets them; unlinking takes them away -----------------------------------------------
UPDATE public.discord_migration_links SET status = 'active'
 WHERE server_id = 'f2830000-0000-0000-0000-0000000000a1' AND user_id = '22222222-0000-0000-0000-000000000002';
SELECT pg_temp.apply();
SELECT is(pg_temp.ov('e1'), 6::bigint, 'an active link gets the overrides again');
UPDATE public.discord_migration_links SET status = 'left'
 WHERE server_id = 'f2830000-0000-0000-0000-0000000000a1' AND user_id = '22222222-0000-0000-0000-000000000002';
SELECT is(pg_temp.ov('e1'), NULL::bigint, 'a link that stops being active removes them');

-- A ban removes them too ------------------------------------------------------------------------------------------
UPDATE public.discord_migration_links SET status = 'active'
 WHERE server_id = 'f2830000-0000-0000-0000-0000000000a1' AND user_id = '22222222-0000-0000-0000-000000000002';
SELECT pg_temp.apply();
UPDATE public.user_servers SET status = 'banned'
 WHERE server_id = 'f2830000-0000-0000-0000-0000000000a1' AND user_id = '22222222-0000-0000-0000-000000000002';
SELECT is(pg_temp.ov('e1'), NULL::bigint, 'a member who stops being accepted loses them');
SELECT is(pg_temp.ov('e2'), 4::bigint, 'and the admin-owned override still stays');
SELECT is((SELECT count(*)::int FROM public.discord_migration_applied_overrides
            WHERE user_id = '22222222-0000-0000-0000-000000000002'), 0, 'with no tracking left');

SELECT * FROM finish();
ROLLBACK;
