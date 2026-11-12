-- Migrate from Discord: the server owner gets their mapped roles, add-only.
--
-- The owner was exempt from role sync. The owner's mapped Harmony roles are now added at claim and on
-- every sync, and never removed: losing the Discord role leaves the Harmony role. Membership, ban,
-- kick and timeout handling for the owner stays exempt. discord_migration_apply_roles skips its owner
-- notification when the owner is the member, and claim reports is_owner and lists the owner's granted
-- roles in roles_granted.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.discord_migration_apply_roles(
    p_server_id uuid, p_user_id uuid, p_discord_role_ids text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_owner uuid;
    v_server_name text;
    v_username text;
    v_prev_via text := current_setting('harmony.via', true);
    v_target uuid[];
    v_held uuid[];
    v_stale uuid[];
    v_stale_held uuid[];
    v_add uuid[];
    v_remove uuid[];
    v_role uuid;
    v_role_name text;
    v_admin boolean;
BEGIN
    SELECT s.owner, s.name INTO v_owner, v_server_name FROM public.servers s WHERE s.id = p_server_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Server not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.user_servers us
                    WHERE us.server_id = p_server_id AND us.user_id = p_user_id AND us.status = 'accepted') THEN
        RETURN jsonb_build_object('added', '[]'::jsonb, 'removed', '[]'::jsonb);
    END IF;
    SELECT p.username INTO v_username FROM public.profiles p WHERE p.id = p_user_id;

    SELECT COALESCE(array_agg(DISTINCT m.harmony_role_id), '{}') INTO v_target
      FROM public.discord_migration_role_map m
     WHERE m.server_id = p_server_id AND m.discord_role_id = ANY (COALESCE(p_discord_role_ids, '{}'));
    SELECT COALESCE(array_agg(ur.role_id), '{}') INTO v_held
      FROM public.user_roles ur
     WHERE ur.server_id = p_server_id AND ur.user_id = p_user_id
       AND ur.role_id IN (SELECT m.harmony_role_id FROM public.discord_migration_role_map m
                           WHERE m.server_id = p_server_id);
    -- A role this function granted for a Discord role that is now mapped to a different Harmony role
    -- is taken back too (a remap moves the role). Dropping a mapping leaves the role alone.
    SELECT COALESCE(array_agg(DISTINCT (a.value #>> '{}')::uuid), '{}') INTO v_stale
      FROM public.discord_migration_links l
      CROSS JOIN LATERAL jsonb_each(l.applied_roles) a
      JOIN public.discord_migration_role_map m
        ON m.server_id = l.server_id AND m.discord_role_id = a.key
       AND m.harmony_role_id <> (a.value #>> '{}')::uuid
     WHERE l.server_id = p_server_id AND l.user_id = p_user_id;
    SELECT COALESCE(array_agg(ur.role_id), '{}') INTO v_stale_held
      FROM public.user_roles ur
     WHERE ur.server_id = p_server_id AND ur.user_id = p_user_id AND ur.role_id = ANY (v_stale);
    SELECT COALESCE(array_agg(t), '{}') INTO v_add FROM unnest(v_target) t WHERE NOT (t = ANY (v_held));
    SELECT COALESCE(array_agg(DISTINCT h), '{}') INTO v_remove
      FROM unnest(v_held || v_stale_held) h WHERE NOT (h = ANY (v_target));
    -- The server owner only ever gains roles: losing a Discord role never takes a Harmony role away.
    IF v_owner IS NOT DISTINCT FROM p_user_id THEN
        v_remove := '{}';
    END IF;

    PERFORM set_config('harmony.via', 'discord_migration', true);

    FOREACH v_role IN ARRAY v_add LOOP
        INSERT INTO public.user_roles (user_id, role_id, server_id)
        VALUES (p_user_id, v_role, p_server_id)
        ON CONFLICT (user_id, role_id) DO NOTHING;
        SELECT sr.name INTO v_role_name FROM public.server_roles sr WHERE sr.id = v_role;
        SELECT COALESCE(bool_or(public.discord_migration_admin_bearing(p_server_id, m.discord_role_id, m.harmony_role_id)), false)
               OR public.discord_migration_admin_bearing(p_server_id, '', v_role)
          INTO v_admin
          FROM public.discord_migration_role_map m
         WHERE m.server_id = p_server_id AND m.harmony_role_id = v_role;
        PERFORM public.server_audit_write(p_server_id, 'member.role_add', 'user', p_user_id::text, v_username, NULL,
            jsonb_build_object('role_id', v_role, 'role_name', v_role_name, 'via', 'discord_migration',
                               'administrator', CASE WHEN v_admin THEN true END),
            NULL, NULL, 'system');
        IF v_admin AND v_owner IS NOT NULL AND v_owner IS DISTINCT FROM p_user_id THEN
            INSERT INTO public.notifications (user_id, type, data)
            VALUES (v_owner, 'discord_migration_admin_change', jsonb_build_object(
                'server', jsonb_build_object('id', p_server_id, 'name', v_server_name),
                'user', jsonb_build_object('id', p_user_id, 'username', v_username),
                'role', jsonb_build_object('id', v_role, 'name', v_role_name),
                'change', 'granted'));
        END IF;
    END LOOP;

    FOREACH v_role IN ARRAY v_remove LOOP
        DELETE FROM public.user_roles ur
         WHERE ur.server_id = p_server_id AND ur.user_id = p_user_id AND ur.role_id = v_role;
        SELECT sr.name INTO v_role_name FROM public.server_roles sr WHERE sr.id = v_role;
        SELECT COALESCE(bool_or(public.discord_migration_admin_bearing(p_server_id, m.discord_role_id, m.harmony_role_id)), false)
               OR public.discord_migration_admin_bearing(p_server_id, '', v_role)
          INTO v_admin
          FROM public.discord_migration_role_map m
         WHERE m.server_id = p_server_id AND m.harmony_role_id = v_role;
        PERFORM public.server_audit_write(p_server_id, 'member.role_remove', 'user', p_user_id::text, v_username, NULL,
            jsonb_build_object('role_id', v_role, 'role_name', v_role_name, 'via', 'discord_migration',
                               'administrator', CASE WHEN v_admin THEN true END),
            NULL, NULL, 'system');
        IF v_admin AND v_owner IS NOT NULL THEN
            INSERT INTO public.notifications (user_id, type, data)
            VALUES (v_owner, 'discord_migration_admin_change', jsonb_build_object(
                'server', jsonb_build_object('id', p_server_id, 'name', v_server_name),
                'user', jsonb_build_object('id', p_user_id, 'username', v_username),
                'role', jsonb_build_object('id', v_role, 'name', v_role_name),
                'change', 'removed'));
        END IF;
    END LOOP;

    UPDATE public.discord_migration_links l
       SET applied_roles = COALESCE((SELECT jsonb_object_agg(m.discord_role_id, m.harmony_role_id)
                                       FROM public.discord_migration_role_map m
                                      WHERE m.server_id = p_server_id
                                        AND m.discord_role_id = ANY (COALESCE(p_discord_role_ids, '{}'))), '{}'::jsonb)
     WHERE l.server_id = p_server_id AND l.user_id = p_user_id;

    PERFORM set_config('harmony.via', COALESCE(v_prev_via, ''), true);
    RETURN jsonb_build_object('added', to_jsonb(v_add), 'removed', to_jsonb(v_remove));
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
     WHERE m.server_id = v_claim.server_id AND m.discord_role_id = ANY (v_claim.discord_role_ids);

    DELETE FROM public.discord_migration_claims WHERE ticket = p_ticket;
    RETURN jsonb_build_object('server_id', v_claim.server_id, 'roles_granted', to_jsonb(v_names),
        'is_owner', EXISTS (SELECT 1 FROM public.servers s WHERE s.id = v_claim.server_id AND s.owner = v_me));
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
