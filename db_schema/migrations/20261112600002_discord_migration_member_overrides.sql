-- Migrate from Discord: carry Discord's per-member channel overrides to linked members.
--
-- A Discord channel can allow or deny permissions for a single member (a type 1 permission
-- overwrite). The bridge copies roles only, so these were left behind with a readiness warning.
-- Now the gateway stores a snapshot of them (discord_migration_store_member_overrides, on refresh
-- and on every sync pass) and the migration applies them to the linked Harmony user:
--
-- discord_migration_member_overrides  the snapshot: per Discord channel and member, the allow and deny
--                         bits translated to Harmony bits (ADMINISTRATOR stripped), plus the channel name.
-- discord_migration_applied_overrides  every channel_permission_overrides row the migration made, by
--                         user and Harmony channel. Only these are ever updated or deleted. A user
--                         override that a Harmony admin made on the same channel is left alone.
--
-- discord_migration_apply_member_overrides(server, user) runs from claim and from sync_member. It
-- covers only channels paired with a Harmony channel through the server's bridge, never acts for the
-- server owner, removes a migration-made override when Discord no longer has it, and leaves them all
-- in place when the migration finishes. The override audit trigger writes a system row with
-- details.via = discord_migration for these changes. discord_migration_get also returns
-- member_overrides: [{discord_channel_id, channel_name, discord_user_id, allow, deny, status, username}]
-- where status is unpaired, linked or not_linked.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.discord_migration_member_overrides (
    server_id uuid NOT NULL REFERENCES public.discord_migrations(server_id) ON DELETE CASCADE,
    discord_channel_id text NOT NULL,
    discord_user_id text NOT NULL,
    allow_harmony bigint NOT NULL DEFAULT 0,
    deny_harmony bigint NOT NULL DEFAULT 0,
    discord_channel_name text,
    fetched_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (server_id, discord_channel_id, discord_user_id),
    CONSTRAINT discord_migration_member_overrides_channel_check CHECK (discord_channel_id ~ '^[0-9]{1,20}$'),
    CONSTRAINT discord_migration_member_overrides_user_check CHECK (discord_user_id ~ '^[0-9]{1,20}$'),
    CONSTRAINT discord_migration_member_overrides_name_check CHECK (char_length(discord_channel_name) <= 100)
);

CREATE TABLE IF NOT EXISTS public.discord_migration_applied_overrides (
    server_id uuid NOT NULL REFERENCES public.discord_migrations(server_id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    harmony_channel_id uuid NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
    override_id uuid NOT NULL REFERENCES public.channel_permission_overrides(id) ON DELETE CASCADE,
    discord_channel_id text NOT NULL,
    PRIMARY KEY (server_id, user_id, harmony_channel_id),
    CONSTRAINT discord_migration_applied_overrides_override_key UNIQUE (override_id)
);

REVOKE ALL ON public.discord_migration_member_overrides, public.discord_migration_applied_overrides
    FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.discord_migration_member_overrides, public.discord_migration_applied_overrides
    TO service_role;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['discord_migration_member_overrides', 'discord_migration_applied_overrides'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service_role', t);
        EXECUTE format('CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true)',
                       t || '_service_role', t);
    END LOOP;
END;
$$;

COMMENT ON TABLE public.discord_migration_member_overrides IS
    'The gateway''s snapshot of Discord member channel overwrites, as Harmony permission bits; service_role only.';
COMMENT ON TABLE public.discord_migration_applied_overrides IS
    'channel_permission_overrides rows Migrate from Discord made; only these are updated or deleted by it.';

-- Replaces the guild's member overwrite snapshot with p_overrides, [{channel_id, channel_name, user_id,
-- allow, deny}] (allow and deny decimal strings of Harmony bits; ADMINISTRATOR is dropped). P0002 when
-- the migration is absent.
CREATE OR REPLACE FUNCTION public.discord_migration_store_member_overrides(p_server_id uuid, p_overrides jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    IF p_overrides IS NULL OR jsonb_typeof(p_overrides) <> 'array' THEN
        RAISE EXCEPTION 'overrides must be an array' USING ERRCODE = '22023';
    END IF;
    PERFORM 1 FROM public.discord_migrations m WHERE m.server_id = p_server_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'migration_not_configured' USING ERRCODE = 'P0002';
    END IF;

    DELETE FROM public.discord_migration_member_overrides o WHERE o.server_id = p_server_id;
    INSERT INTO public.discord_migration_member_overrides
        (server_id, discord_channel_id, discord_user_id, allow_harmony, deny_harmony, discord_channel_name, fetched_at)
    SELECT DISTINCT ON (e ->> 'channel_id', e ->> 'user_id')
           p_server_id,
           e ->> 'channel_id',
           e ->> 'user_id',
           COALESCE((e ->> 'allow')::bigint, 0) & ~(1::bigint),
           COALESCE((e ->> 'deny')::bigint, 0) & ~(1::bigint),
           left(NULLIF(btrim(e ->> 'channel_name'), ''), 100),
           now()
      FROM jsonb_array_elements(p_overrides) e
     WHERE jsonb_typeof(e) = 'object'
       AND e ->> 'channel_id' ~ '^[0-9]{1,20}$'
       AND e ->> 'user_id' ~ '^[0-9]{1,20}$'
       AND COALESCE(e ->> 'allow', '0') ~ '^[0-9]{1,18}$'
       AND COALESCE(e ->> 'deny', '0') ~ '^[0-9]{1,18}$'
     ORDER BY e ->> 'channel_id', e ->> 'user_id';
END;
$$;

-- Makes the member's channel overrides match the snapshot: for each Discord channel paired with a Harmony
-- channel of this server where the snapshot has an overwrite for the member's Discord account, the member
-- gets a user override with those bits; an override that Discord no longer has is deleted. Only rows in
-- discord_migration_applied_overrides are ever changed or deleted; a user override a Harmony admin made on
-- the same channel is skipped. The server owner, non-members and members without an active link are never
-- touched. Returns {created, updated, removed, skipped}.
CREATE OR REPLACE FUNCTION public.discord_migration_apply_member_overrides(p_server_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_owner uuid;
    v_discord_user text;
    v_prev_via text := current_setting('harmony.via', true);
    v_keep uuid[];
    v_row record;
    v_tracked uuid;
    v_id uuid;
    v_n integer;
    v_created integer := 0;
    v_updated integer := 0;
    v_removed integer := 0;
    v_skipped integer := 0;
BEGIN
    SELECT s.owner INTO v_owner FROM public.servers s WHERE s.id = p_server_id;
    IF NOT FOUND OR v_owner IS NOT DISTINCT FROM p_user_id THEN
        RETURN jsonb_build_object('created', 0, 'updated', 0, 'removed', 0, 'skipped', 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.user_servers us
                    WHERE us.server_id = p_server_id AND us.user_id = p_user_id AND us.status = 'accepted') THEN
        RETURN jsonb_build_object('created', 0, 'updated', 0, 'removed', 0, 'skipped', 0);
    END IF;
    SELECT l.discord_user_id INTO v_discord_user FROM public.discord_migration_links l
     WHERE l.server_id = p_server_id AND l.user_id = p_user_id AND l.status = 'active';
    IF NOT FOUND THEN
        RETURN jsonb_build_object('created', 0, 'updated', 0, 'removed', 0, 'skipped', 0);
    END IF;

    SELECT COALESCE(array_agg(DISTINCT bc.harmony_channel_id), '{}') INTO v_keep
      FROM public.discord_migration_member_overrides o
      JOIN public.discord_bridge_channels bc ON bc.discord_channel_id = o.discord_channel_id
      JOIN public.discord_bridges b ON b.id = bc.bridge_id AND b.server_id = p_server_id
      JOIN public.channels c ON c.id = bc.harmony_channel_id AND c.server_id = p_server_id
     WHERE o.server_id = p_server_id AND o.discord_user_id = v_discord_user
       AND ((o.allow_harmony & ~(1::bigint)) <> 0 OR (o.deny_harmony & ~(1::bigint)) <> 0);

    PERFORM set_config('harmony.via', 'discord_migration', true);

    FOR v_row IN
        SELECT a.override_id FROM public.discord_migration_applied_overrides a
         WHERE a.server_id = p_server_id AND a.user_id = p_user_id
           AND NOT (a.harmony_channel_id = ANY (v_keep))
    LOOP
        DELETE FROM public.channel_permission_overrides cpo WHERE cpo.id = v_row.override_id;
        v_removed := v_removed + 1;
    END LOOP;

    FOR v_row IN
        SELECT DISTINCT ON (bc.harmony_channel_id)
               bc.harmony_channel_id, o.discord_channel_id,
               o.allow_harmony & ~(1::bigint) AS allow_p, o.deny_harmony & ~(1::bigint) AS deny_p
          FROM public.discord_migration_member_overrides o
          JOIN public.discord_bridge_channels bc ON bc.discord_channel_id = o.discord_channel_id
          JOIN public.discord_bridges b ON b.id = bc.bridge_id AND b.server_id = p_server_id
          JOIN public.channels c ON c.id = bc.harmony_channel_id AND c.server_id = p_server_id
         WHERE o.server_id = p_server_id AND o.discord_user_id = v_discord_user
           AND ((o.allow_harmony & ~(1::bigint)) <> 0 OR (o.deny_harmony & ~(1::bigint)) <> 0)
         ORDER BY bc.harmony_channel_id, o.discord_channel_id
    LOOP
        SELECT a.override_id INTO v_tracked FROM public.discord_migration_applied_overrides a
         WHERE a.server_id = p_server_id AND a.user_id = p_user_id AND a.harmony_channel_id = v_row.harmony_channel_id;
        IF FOUND THEN
            UPDATE public.channel_permission_overrides cpo
               SET allow_permissions = v_row.allow_p, deny_permissions = v_row.deny_p
             WHERE cpo.id = v_tracked
               AND (cpo.allow_permissions IS DISTINCT FROM v_row.allow_p
                    OR cpo.deny_permissions IS DISTINCT FROM v_row.deny_p);
            GET DIAGNOSTICS v_n = ROW_COUNT;
            v_updated := v_updated + v_n;
            UPDATE public.discord_migration_applied_overrides a
               SET discord_channel_id = v_row.discord_channel_id
             WHERE a.override_id = v_tracked;
        ELSIF EXISTS (SELECT 1 FROM public.channel_permission_overrides cpo
                       WHERE cpo.channel_id = v_row.harmony_channel_id AND cpo.user_id = p_user_id) THEN
            v_skipped := v_skipped + 1;
        ELSE
            INSERT INTO public.channel_permission_overrides
                (channel_id, target_type, user_id, allow_permissions, deny_permissions)
            VALUES (v_row.harmony_channel_id, 'user', p_user_id, v_row.allow_p, v_row.deny_p)
            RETURNING id INTO v_id;
            INSERT INTO public.discord_migration_applied_overrides
                (server_id, user_id, harmony_channel_id, override_id, discord_channel_id)
            VALUES (p_server_id, p_user_id, v_row.harmony_channel_id, v_id, v_row.discord_channel_id);
            v_created := v_created + 1;
        END IF;
    END LOOP;

    PERFORM set_config('harmony.via', COALESCE(v_prev_via, ''), true);
    RETURN jsonb_build_object('created', v_created, 'updated', v_updated, 'removed', v_removed, 'skipped', v_skipped);
END;
$$;

-- The audit trigger for overrides: a change the migration makes is a system row naming it.
CREATE OR REPLACE FUNCTION public.server_audit_overrides()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_keys constant text[] := ARRAY['allow_permissions', 'deny_permissions'];
    v_row public.channel_permission_overrides := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    v_channel public.channels;
    v_changes jsonb;
    v_via text := current_setting('harmony.via', true);
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;
    SELECT c.* INTO v_channel FROM public.channels c WHERE c.id = v_row.channel_id;
    IF NOT FOUND OR v_channel.server_id IS NULL THEN
        RETURN NULL;
    END IF;

    v_changes := public.server_audit_diff(
        CASE WHEN TG_OP <> 'INSERT' THEN public.server_audit_pick(to_jsonb(OLD), v_keys) END,
        CASE WHEN TG_OP <> 'DELETE' THEN public.server_audit_pick(to_jsonb(NEW), v_keys) END);
    IF TG_OP = 'UPDATE' AND v_changes = '{}'::jsonb THEN
        RETURN NULL;
    END IF;

    PERFORM public.server_audit_write(
        v_channel.server_id,
        CASE TG_OP WHEN 'INSERT' THEN 'override.create' WHEN 'UPDATE' THEN 'override.update' ELSE 'override.delete' END,
        'channel', v_channel.id::text, v_channel.name,
        v_changes,
        jsonb_build_object(
            'override_type', v_row.target_type,
            'role_id', v_row.role_id,
            'role_name', (SELECT sr.name FROM public.server_roles sr WHERE sr.id = v_row.role_id),
            'user_id', v_row.user_id,
            'user_name', (SELECT p.username FROM public.profiles p WHERE p.id = v_row.user_id))
        -- An override the migration makes is a system action that names the migration.
        || CASE WHEN v_via = 'discord_migration' THEN jsonb_build_object('via', 'discord_migration') ELSE '{}'::jsonb END,
        NULL, NULL,
        CASE WHEN v_via = 'discord_migration' THEN 'system' END);
    RETURN NULL;
END;
$$;

-- Grants ----------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.discord_migration_store_member_overrides(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discord_migration_store_member_overrides(uuid, jsonb) TO service_role;
-- Reached only from claim and sync_member, which run as the owner.
REVOKE ALL ON FUNCTION public.discord_migration_apply_member_overrides(uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;

-- get, claim and sync_member, redefined with the override additions. Claims also apply the overrides.

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
    v_names text[] := public.permission_bit_names();
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
            'member_overrides', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                           'discord_channel_id', o.discord_channel_id,
                           'channel_name', o.discord_channel_name,
                           'discord_user_id', o.discord_user_id,
                           'allow', to_jsonb(ARRAY(SELECT v_names[i]
                                                     FROM generate_series(1, array_length(v_names, 1)) i
                                                    WHERE (o.allow_harmony & (1::bigint << (i - 1))) <> 0
                                                    ORDER BY i)),
                           'deny', to_jsonb(ARRAY(SELECT v_names[i]
                                                    FROM generate_series(1, array_length(v_names, 1)) i
                                                   WHERE (o.deny_harmony & (1::bigint << (i - 1))) <> 0
                                                   ORDER BY i)),
                           'status', CASE
                               WHEN NOT EXISTS (SELECT 1 FROM public.discord_bridge_channels bc
                                                  JOIN public.discord_bridges b ON b.id = bc.bridge_id
                                                 WHERE b.server_id = p_server_id
                                                   AND bc.discord_channel_id = o.discord_channel_id) THEN 'unpaired'
                               WHEN l.user_id IS NOT NULL THEN 'linked'
                               ELSE 'not_linked' END,
                           'username', pr.username)
                           ORDER BY o.discord_channel_name, o.discord_channel_id, o.discord_user_id)
                  FROM public.discord_migration_member_overrides o
                  LEFT JOIN public.discord_migration_links l
                    ON l.server_id = o.server_id AND l.discord_user_id = o.discord_user_id AND l.status = 'active'
                  LEFT JOIN public.profiles pr ON pr.id = l.user_id
                 WHERE o.server_id = p_server_id), '[]'::jsonb),
            'readiness', public.discord_migration_readiness(p_server_id),
            'permission_gaps', public.discord_migration_permission_gaps(p_server_id));
END;
$$;

CREATE OR REPLACE FUNCTION public.discord_migration_claim(p_ticket text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_me uuid := public.get_current_profile_id();
    v_claim public.discord_migration_claims;
    v_state text;
    v_mine record;
    v_status text;
    v_names text[];
BEGIN
    IF v_uid IS NULL OR v_me IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_me AND p.is_local IS TRUE) THEN
        RAISE EXCEPTION 'Only local accounts can claim' USING ERRCODE = '42501';
    END IF;

    SELECT c.* INTO v_claim FROM public.discord_migration_claims c WHERE c.ticket = p_ticket FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TICKET_EXPIRED';
    END IF;
    IF v_claim.auth_user_id IS NOT NULL AND v_claim.auth_user_id <> v_uid THEN
        RAISE EXCEPTION 'This ticket belongs to another account' USING ERRCODE = '42501';
    END IF;
    IF v_claim.expires_at < now() THEN
        RAISE EXCEPTION 'TICKET_EXPIRED';
    END IF;

    SELECT m.state INTO v_state FROM public.discord_migrations m WHERE m.server_id = v_claim.server_id FOR SHARE;
    IF v_state IS DISTINCT FROM 'open' THEN
        RAISE EXCEPTION 'MIGRATION_CLOSED';
    END IF;

    -- Harmony moderation first: nothing below undoes a ban or a kick.
    IF EXISTS (SELECT 1 FROM public.server_bans b WHERE b.server_id = v_claim.server_id AND b.user_id = v_me)
       OR EXISTS (SELECT 1 FROM public.user_servers us
                   WHERE us.server_id = v_claim.server_id AND us.user_id = v_me AND us.status = 'banned') THEN
        RAISE EXCEPTION 'HARMONY_BANNED';
    END IF;

    SELECT l.discord_user_id, l.status INTO v_mine
      FROM public.discord_migration_links l
     WHERE l.server_id = v_claim.server_id AND l.user_id = v_me;
    IF FOUND THEN
        IF v_mine.status = 'kicked_on_harmony' THEN
            RAISE EXCEPTION 'KICKED_ON_HARMONY';
        END IF;
        IF v_mine.discord_user_id <> v_claim.discord_user_id THEN
            RAISE EXCEPTION 'ALREADY_LINKED_OTHER_DISCORD';
        END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM public.discord_migration_links l
                WHERE l.server_id = v_claim.server_id AND l.discord_user_id = v_claim.discord_user_id
                  AND l.user_id <> v_me) THEN
        RAISE EXCEPTION 'DISCORD_ACCOUNT_TAKEN';
    END IF;
    IF v_mine.status = 'banned' THEN
        RAISE EXCEPTION 'DISCORD_BANNED_HERE';
    END IF;

    BEGIN
        -- last_synced_at = NULL puts the link first in the next sync batch: the roles recorded at sign-in may be
        -- stale, and a fresh Discord read corrects them.
        INSERT INTO public.discord_migration_links
            (server_id, user_id, discord_user_id, status, discord_role_ids, discord_joined_at, last_synced_at)
        VALUES (v_claim.server_id, v_me, v_claim.discord_user_id, 'active',
                v_claim.discord_role_ids, v_claim.discord_joined_at, NULL)
        ON CONFLICT (server_id, user_id) DO UPDATE
           SET status = 'active', discord_role_ids = EXCLUDED.discord_role_ids,
               discord_joined_at = COALESCE(EXCLUDED.discord_joined_at, discord_migration_links.discord_joined_at),
               last_synced_at = NULL;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'DISCORD_ACCOUNT_TAKEN';
    END;

    -- Joins as an accepted member, as redeem_invite does; the join triggers (membership event, rate
    -- limit) run for the caller.
    SELECT us.status INTO v_status
      FROM public.user_servers us WHERE us.server_id = v_claim.server_id AND us.user_id = v_me;
    IF NOT FOUND THEN
        INSERT INTO public.user_servers (server_id, user_id, status)
        VALUES (v_claim.server_id, v_me, 'accepted');
    ELSIF v_status <> 'accepted' THEN
        UPDATE public.user_servers SET status = 'accepted'
         WHERE server_id = v_claim.server_id AND user_id = v_me;
    END IF;

    PERFORM public.discord_migration_apply_roles(v_claim.server_id, v_me, v_claim.discord_role_ids);
    BEGIN
        PERFORM public.discord_migration_apply_member_overrides(v_claim.server_id, v_me);
    EXCEPTION WHEN OTHERS THEN
        -- Overrides are a courtesy on top of the claim: a failure here never blocks joining.
        RAISE WARNING 'discord_migration_apply_member_overrides failed: %', SQLERRM;
    END;

    -- A ticket that sat for more than 15 minutes asks for a sync now.
    IF v_claim.created_at < now() - interval '15 minutes' THEN
        UPDATE public.discord_migrations SET sync_requested_at = now() WHERE server_id = v_claim.server_id;
    END IF;

    SELECT COALESCE(array_agg(DISTINCT sr.name), '{}') INTO v_names
      FROM public.discord_migration_role_map m
      JOIN public.server_roles sr ON sr.id = m.harmony_role_id
     WHERE m.server_id = v_claim.server_id AND m.discord_role_id = ANY (v_claim.discord_role_ids)
       AND NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = v_claim.server_id AND s.owner = v_me);

    DELETE FROM public.discord_migration_claims WHERE ticket = p_ticket;
    RETURN jsonb_build_object('server_id', v_claim.server_id, 'roles_granted', to_jsonb(v_names));
END;
$$;

CREATE OR REPLACE FUNCTION public.discord_migration_sync_member(
    p_server_id uuid, p_user_id uuid, p_member jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_link public.discord_migration_links;
    v_owner uuid;
    v_prev_via text;
    v_profile jsonb := COALESCE(p_member -> 'profile', '{}'::jsonb);
    v_fields text[];
    v_roles text[];
    v_role_result jsonb := jsonb_build_object('added', '[]'::jsonb, 'removed', '[]'::jsonb);
    v_server jsonb := '{}'::jsonb;
    v_color integer;
    v_until timestamptz;
    v_timeout public.server_member_timeouts;
    v_username text;
    v_profile_error boolean := false;
    v_timeout_changed boolean := false;
    v_overrides jsonb := '{}'::jsonb;
BEGIN
    IF p_member IS NULL OR jsonb_typeof(p_member) <> 'object' THEN
        RAISE EXCEPTION 'p_member must be a JSON object' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_profile) <> 'object' THEN
        v_profile := '{}'::jsonb;
    END IF;

    SELECT s.owner INTO v_owner FROM public.servers s WHERE s.id = p_server_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Server not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.user_servers us
                    WHERE us.server_id = p_server_id AND us.user_id = p_user_id AND us.status = 'accepted') THEN
        RETURN jsonb_build_object('skipped', 'not_member');
    END IF;
    SELECT * INTO v_link FROM public.discord_migration_links l
     WHERE l.server_id = p_server_id AND l.user_id = p_user_id AND l.status = 'active';
    IF NOT FOUND THEN
        RETURN jsonb_build_object('skipped', 'no_link');
    END IF;

    IF NOT COALESCE((p_member ->> 'present')::boolean, false) THEN
        RETURN jsonb_build_object('candidate',
            CASE WHEN COALESCE((p_member ->> 'banned')::boolean, false) THEN 'banned' ELSE 'left' END);
    END IF;

    v_fields := v_link.sync_fields;
    SELECT p.username INTO v_username FROM public.profiles p WHERE p.id = p_user_id;

    -- Roles
    IF p_member ? 'role_ids' AND jsonb_typeof(p_member -> 'role_ids') = 'array' THEN
        SELECT COALESCE(array_agg(DISTINCT e), '{}') INTO v_roles
          FROM jsonb_array_elements_text(p_member -> 'role_ids') e WHERE e ~ '^[0-9]{1,20}$';
        v_role_result := public.discord_migration_apply_roles(p_server_id, p_user_id, v_roles);
        UPDATE public.discord_migration_links SET discord_role_ids = v_roles
         WHERE server_id = p_server_id AND user_id = p_user_id;
    END IF;
    IF p_member ? 'joined_at' AND jsonb_typeof(p_member -> 'joined_at') = 'string' THEN
        UPDATE public.discord_migration_links SET discord_joined_at = (p_member ->> 'joined_at')::timestamptz
         WHERE server_id = p_server_id AND user_id = p_user_id;
    END IF;

    -- Channel overrides for this member from the Discord snapshot. A failure leaves everything else applied.
    BEGIN
        v_overrides := public.discord_migration_apply_member_overrides(p_server_id, p_user_id);
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'discord_migration_apply_member_overrides failed: %', SQLERRM;
    END;

    -- Profile: only what the member opted into. A global value that is null leaves the profile alone.
    -- A write that fails (a value over its limit, say) skips the profile part and nothing else: the roles
    -- above stay applied. The result carries profile_error.
    BEGIN
        IF 'avatar' = ANY (v_fields) AND jsonb_typeof(v_profile -> 'avatar_url') = 'string' THEN
            UPDATE public.profiles SET avatar_url = v_profile ->> 'avatar_url' WHERE id = p_user_id;
        END IF;
        IF 'display_name' = ANY (v_fields) AND jsonb_typeof(v_profile -> 'display_name') = 'string' THEN
            UPDATE public.profiles SET display_name = v_profile ->> 'display_name' WHERE id = p_user_id;
        END IF;
        IF 'banner' = ANY (v_fields) AND jsonb_typeof(v_profile -> 'banner_url') = 'string' THEN
            UPDATE public.profiles SET banner_url = v_profile ->> 'banner_url' WHERE id = p_user_id;
        END IF;
        IF 'accent_color' = ANY (v_fields) AND jsonb_typeof(v_profile -> 'accent_color') = 'number'
           AND (v_profile ->> 'accent_color') ~ '^[0-9]{1,8}$' AND (v_profile ->> 'accent_color')::bigint <= 16777215 THEN
            v_color := (v_profile ->> 'accent_color')::integer;
            UPDATE public.profiles SET color = '#' || lpad(to_hex(v_color & 16777215), 6, '0') WHERE id = p_user_id;
        END IF;
        IF 'server_nickname' = ANY (v_fields) AND v_profile ? 'server_nickname' THEN
            v_server := v_server || jsonb_build_object('nickname', v_profile -> 'server_nickname');
        END IF;
        IF 'server_avatar' = ANY (v_fields) AND v_profile ? 'server_avatar_url' THEN
            v_server := v_server || jsonb_build_object('avatar_url', v_profile -> 'server_avatar_url');
        END IF;
        IF 'server_banner' = ANY (v_fields) AND v_profile ? 'server_banner_url' THEN
            v_server := v_server || jsonb_build_object('banner_url', v_profile -> 'server_banner_url');
        END IF;
        IF v_server <> '{}'::jsonb THEN
            PERFORM public.service_set_member_server_profile(p_server_id, p_user_id, v_server);
        END IF;
    EXCEPTION WHEN OTHERS THEN
        v_profile_error := true;
    END;

    -- Timeouts: Harmony's own (moderator, automod) are never replaced or lifted. The owner and
    -- Administrator holders cannot be timed out.
    IF p_member ? 'timed_out_until' THEN
        v_prev_via := current_setting('harmony.via', true);
        PERFORM set_config('harmony.via', 'discord_migration', true);
        v_until := CASE WHEN jsonb_typeof(p_member -> 'timed_out_until') = 'string'
                        THEN (p_member ->> 'timed_out_until')::timestamptz END;
        IF v_until IS NOT NULL AND v_until > now() THEN
            IF v_owner IS DISTINCT FROM p_user_id AND NOT public.has_permission(p_user_id, p_server_id, 'ADMINISTRATOR') THEN
                SELECT * INTO v_timeout FROM public.server_member_timeouts t
                 WHERE t.server_id = p_server_id AND t.user_id = p_user_id;
                IF NOT FOUND OR v_timeout.until <= now() OR v_timeout.source = 'discord_migration' THEN
                    INSERT INTO public.server_member_timeouts (server_id, user_id, until, reason, source)
                    VALUES (p_server_id, p_user_id, v_until, 'Timed out on Discord', 'discord_migration')
                    ON CONFLICT (server_id, user_id) DO UPDATE
                       SET until = EXCLUDED.until, reason = EXCLUDED.reason, source = EXCLUDED.source,
                           created_by = NULL, created_at = now();
                    IF v_timeout.user_id IS NULL OR v_timeout.until <= now() OR v_timeout.until IS DISTINCT FROM v_until THEN
                        v_timeout_changed := true;
                        PERFORM public.server_audit_write(p_server_id, 'member.timeout', 'user', p_user_id::text,
                            v_username, NULL,
                            jsonb_build_object('until', v_until, 'via', 'discord_migration'),
                            'Timed out on Discord', NULL, 'system');
                    END IF;
                END IF;
            END IF;
        ELSE
            DELETE FROM public.server_member_timeouts t
             WHERE t.server_id = p_server_id AND t.user_id = p_user_id AND t.source = 'discord_migration'
            RETURNING * INTO v_timeout;
            IF FOUND THEN
                v_timeout_changed := true;
            END IF;
            IF FOUND AND v_timeout.until > now() THEN
                PERFORM public.server_audit_write(p_server_id, 'member.timeout_remove', 'user', p_user_id::text,
                    v_username, NULL, jsonb_build_object('via', 'discord_migration'), NULL, NULL, 'system');
            END IF;
        END IF;
        PERFORM set_config('harmony.via', COALESCE(v_prev_via, ''), true);
    END IF;

    UPDATE public.discord_migration_links SET last_synced_at = now()
     WHERE server_id = p_server_id AND user_id = p_user_id;
    RETURN jsonb_build_object('present', true, 'roles', v_role_result, 'timeout_changed', v_timeout_changed,
                              'member_overrides', v_overrides)
        || CASE WHEN v_profile_error THEN jsonb_build_object('profile_error', true) ELSE '{}'::jsonb END;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
