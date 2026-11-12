-- Migrate from Discord: discord_migration_get also returns the bridge's guild.
--
-- The settings panel left the Discord server ID blank until the first save, even when the server
-- has a Discord bridge with a guild: discord_migration_save fills it from the bridge when given a
-- null guild id, but nothing showed that. get now returns bridge_discord_guild_id (text or null),
-- the discord_guild_id of this server's discord_bridges row in any mode, also while no migration
-- row exists yet. The panel prefills the field from it. Same managers as before.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.discord_migration_get(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_me uuid := public.discord_migration_assert_manager(p_server_id);
    v_row public.discord_migrations;
BEGIN
    SELECT * INTO v_row FROM public.discord_migrations WHERE server_id = p_server_id;

    RETURN COALESCE(to_jsonb(v_row), jsonb_build_object('server_id', p_server_id, 'state', NULL))
        || jsonb_build_object(
            'has_own_credentials', EXISTS (SELECT 1 FROM public.discord_migration_secrets s
                                            WHERE s.server_id = p_server_id
                                              AND s.client_id IS NOT NULL
                                              AND s.client_secret_secret IS NOT NULL
                                              AND s.bot_token_secret IS NOT NULL),
            'bridge_discord_guild_id', (SELECT b.discord_guild_id FROM public.discord_bridges b
                                         WHERE b.server_id = p_server_id LIMIT 1),
            'bridge_available', EXISTS (SELECT 1 FROM public.discord_bridges b
                                          JOIN public.discord_bridge_secrets bs ON bs.bridge_id = b.id
                                         WHERE b.server_id = p_server_id AND b.mode = 'hosted'),
            'instance_bot_available', public.discord_bridge_instance_bot_enabled()
                                      AND public.discord_bridge_instance_bot_configured(),
            'caller_is_owner', EXISTS (SELECT 1 FROM public.servers s
                                        WHERE s.id = p_server_id AND s.owner = v_me),
            'discord_roles', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                           'discord_role_id', r.discord_role_id, 'name', r.name, 'color', r.color,
                           'position', r.position, 'harmony_permissions', r.harmony_permissions::text,
                           'fetched_at', r.fetched_at)
                           ORDER BY r.position DESC, r.discord_role_id)
                  FROM public.discord_migration_discord_roles r
                 WHERE r.server_id = p_server_id), '[]'::jsonb),
            'role_map', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                           'discord_role_id', m.discord_role_id, 'harmony_role_id', m.harmony_role_id)
                           ORDER BY m.discord_role_id)
                  FROM public.discord_migration_role_map m
                 WHERE m.server_id = p_server_id), '[]'::jsonb),
            'link_counts', (
                SELECT jsonb_build_object(
                           'active', count(*) FILTER (WHERE l.status = 'active'),
                           'left', count(*) FILTER (WHERE l.status = 'left'),
                           'banned', count(*) FILTER (WHERE l.status = 'banned'),
                           'kicked_on_harmony', count(*) FILTER (WHERE l.status = 'kicked_on_harmony'))
                  FROM public.discord_migration_links l
                 WHERE l.server_id = p_server_id),
            'readiness', public.discord_migration_readiness(p_server_id),
            'permission_gaps', public.discord_migration_permission_gaps(p_server_id));
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
