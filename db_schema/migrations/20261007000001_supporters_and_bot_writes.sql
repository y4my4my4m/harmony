-- Supporter amounts leave the client surface; bot channel grants, after 20261006700001.
--
-- instance_supporters. Clients read id, user_id, tier_id and is_active: who supports, at
-- which tier (the profile embed and the active count). get_supporter_badge(s) are SECURITY
-- DEFINER and return the badge projection alone (tier name, icon, colour, is_active) of an
-- active, unexpired supporter, so started_at and expires_at leave the client surface too.
-- amount, external_id, platform, started_at and expires_at are read through
-- admin_list_supporters(). Clients hold no write privilege; instance admins write through
-- admin_add_supporter, admin_update_supporter and admin_resolve_pending_donation. A column
-- revoke under the PostgREST upsert fails: ON CONFLICT ... EXCLUDED.amount needs SELECT on
-- amount. service_role, the Ko-fi webhook, keeps SELECT, INSERT and UPDATE.
--
-- bot_server_permissions.allowed_channel_ids. NULL: the bot sees the channels @everyone
-- sees, and writes where @everyone keeps the write's bit, after the channel's @everyone
-- override. An array: the bot uses the listed channels only, and in a listed channel sees it
-- and uses its install's write flags whatever @everyone's override denies. bot-gateway
-- applies it (botCanSeeChannel, botCanWriteChannel). set_bot_allowed_channels() writes it
-- for the server owner and an accepted member holding MANAGE_SERVER. A caller adds only
-- channels they can view; listed channels they cannot view stay listed.
-- get_bot_channel_access() returns the list and the caller's viewable channels, each with
-- whether @everyone can view it.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- instance_supporters
-- ---------------------------------------------------------------------------

-- A table-level REVOKE also revokes every column privilege of the table.
REVOKE ALL ON public.instance_supporters FROM anon, authenticated;
GRANT SELECT (id, user_id, tier_id, is_active) ON public.instance_supporters TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.instance_supporters TO service_role;

-- Bodies as on production and staging; SECURITY DEFINER and the search_path are new.
-- Any caller: the result is the public badge of an active, unexpired supporter.
CREATE OR REPLACE FUNCTION public.get_supporter_badge(p_user_id uuid)
RETURNS TABLE(tier_name text, badge_icon text, badge_color text, is_active boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT t.name AS tier_name,
           t.badge_icon,
           t.badge_color,
           s.is_active
      FROM public.instance_supporters s
      JOIN public.instance_supporter_tiers t ON t.id = s.tier_id
     WHERE s.user_id = p_user_id
       AND s.is_active = true
       AND s.tier_id IS NOT NULL
       AND (s.expires_at IS NULL OR s.expires_at > now())
     LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_supporter_badges(p_user_ids uuid[])
RETURNS TABLE(user_id uuid, tier_name text, badge_icon text, badge_color text, is_active boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT DISTINCT ON (s.user_id)
           s.user_id,
           t.name AS tier_name,
           t.badge_icon,
           t.badge_color,
           s.is_active
      FROM public.instance_supporters s
      JOIN public.instance_supporter_tiers t ON t.id = s.tier_id
     WHERE s.user_id = ANY (p_user_ids)
       AND s.is_active = true
       AND s.tier_id IS NOT NULL
       AND (s.expires_at IS NULL OR s.expires_at > now())
     ORDER BY s.user_id, t.min_amount DESC NULLS LAST, s.started_at DESC;
$$;

-- get_supporter_badge has no client caller.
REVOKE ALL ON FUNCTION public.get_supporter_badge(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_supporter_badge(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.get_supporter_badges(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_supporter_badges(uuid[]) TO authenticated, service_role;

-- Active supporters with amount, platform, external_id, tier row and profile; newest first.
CREATE OR REPLACE FUNCTION public.admin_list_supporters()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;

    RETURN COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                   'id', s.id,
                   'user_id', s.user_id,
                   'tier_id', s.tier_id,
                   'amount', s.amount,
                   'started_at', s.started_at,
                   'expires_at', s.expires_at,
                   'is_active', s.is_active,
                   'platform', s.platform,
                   'external_id', s.external_id,
                   'tier', CASE WHEN t.id IS NULL THEN NULL ELSE to_jsonb(t) END,
                   'user', CASE WHEN p.id IS NULL THEN NULL ELSE
                       jsonb_build_object('username', p.username,
                                          'display_name', p.display_name,
                                          'avatar_url', p.avatar_url) END)
                 ORDER BY s.started_at DESC NULLS LAST, s.id)
          FROM public.instance_supporters s
          LEFT JOIN public.instance_supporter_tiers t ON t.id = s.tier_id
          LEFT JOIN public.profiles p ON p.id = s.user_id
         WHERE s.is_active IS TRUE), '[]'::jsonb);
END;
$$;

-- Creates or reactivates the user's supporter row. A NULL or blank platform is 'manual'.
CREATE OR REPLACE FUNCTION public.admin_add_supporter(
    p_user_id uuid,
    p_tier_id uuid DEFAULT NULL,
    p_amount numeric DEFAULT NULL,
    p_platform text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id uuid;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.instance_supporters AS s
           (user_id, tier_id, amount, platform, is_active, started_at)
    VALUES (p_user_id, p_tier_id, p_amount,
            COALESCE(NULLIF(btrim(p_platform), ''), 'manual'), true, now())
    ON CONFLICT (user_id) DO UPDATE
       SET tier_id = EXCLUDED.tier_id,
           amount = EXCLUDED.amount,
           platform = EXCLUDED.platform,
           is_active = true,
           started_at = EXCLUDED.started_at
    RETURNING s.id INTO v_id;

    RETURN v_id;
END;
$$;

-- p_changes keys: tier_id, amount, platform, is_active. An absent key keeps the column; JSON
-- null clears it. False when the user has no supporter row.
CREATE OR REPLACE FUNCTION public.admin_update_supporter(p_user_id uuid, p_changes jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_unknown text;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;
    IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' THEN
        RAISE EXCEPTION 'changes must be a JSON object' USING ERRCODE = '22023';
    END IF;

    SELECT string_agg(k, ', ' ORDER BY k) INTO v_unknown
      FROM jsonb_object_keys(p_changes) k
     WHERE k NOT IN ('tier_id', 'amount', 'platform', 'is_active');
    IF v_unknown IS NOT NULL THEN
        RAISE EXCEPTION 'Unknown supporter field: %', v_unknown USING ERRCODE = '22023';
    END IF;

    UPDATE public.instance_supporters s
       SET tier_id = CASE WHEN p_changes ? 'tier_id'
                          THEN (p_changes ->> 'tier_id')::uuid ELSE s.tier_id END,
           amount = CASE WHEN p_changes ? 'amount'
                         THEN (p_changes ->> 'amount')::numeric ELSE s.amount END,
           platform = CASE WHEN p_changes ? 'platform'
                           THEN p_changes ->> 'platform' ELSE s.platform END,
           is_active = CASE WHEN p_changes ? 'is_active'
                            THEN (p_changes ->> 'is_active')::boolean ELSE s.is_active END
     WHERE s.user_id = p_user_id;

    RETURN FOUND;
END;
$$;

-- Attributes a webhook donation to a user: supporter row, donation_history row (a retry of
-- the webhook's own insert is skipped by its unique index), the pending row marked resolved,
-- then the tier recomputed from the cycle total. NULL when the row was already resolved.
CREATE OR REPLACE FUNCTION public.admin_resolve_pending_donation(p_pending_id uuid, p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_pending public.instance_pending_donations%ROWTYPE;
    v_supporter uuid;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_pending
      FROM public.instance_pending_donations d
     WHERE d.id = p_pending_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Pending donation not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_pending.resolved_at IS NOT NULL THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.instance_supporters AS s
           (user_id, amount, platform, is_active, started_at)
    VALUES (p_user_id, v_pending.amount, v_pending.platform, true, now())
    ON CONFLICT (user_id) DO UPDATE
       SET amount = EXCLUDED.amount,
           platform = EXCLUDED.platform,
           is_active = true,
           started_at = EXCLUDED.started_at
    RETURNING s.id INTO v_supporter;

    INSERT INTO public.instance_donation_history
           (supporter_id, user_id, amount, currency, platform, external_reference, note)
    VALUES (v_supporter, p_user_id, v_pending.amount, v_pending.currency, v_pending.platform,
            v_pending.external_reference, v_pending.donor_message)
    ON CONFLICT DO NOTHING;

    UPDATE public.instance_pending_donations
       SET resolved_at = now(),
           resolved_by = public.get_current_profile_id(),
           resolved_user_id = p_user_id
     WHERE id = p_pending_id;

    PERFORM public.recompute_supporter_tier(p_user_id);

    RETURN v_supporter;
END;
$$;

-- ---------------------------------------------------------------------------
-- Bot channel grants
-- ---------------------------------------------------------------------------

-- allowed_channel_ids restricted to channels the caller can view, and the server's channels
-- the caller can view. everyone_can_view: @everyone keeps VIEW_CHANNEL (bit 1) after the
-- channel's @everyone override, or holds ADMINISTRATOR (bit 0).
CREATE OR REPLACE FUNCTION public.get_bot_channel_access(p_server_id uuid, p_bot_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_allowed uuid[];
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.owner = v_caller)
       AND NOT (EXISTS (SELECT 1 FROM public.user_servers us
                         WHERE us.server_id = p_server_id
                           AND us.user_id = v_caller
                           AND us.status = 'accepted')
                AND public.has_permission(v_caller, p_server_id, 'MANAGE_SERVER')) THEN
        RAISE EXCEPTION 'Missing permission: MANAGE_SERVER' USING ERRCODE = '42501';
    END IF;

    SELECT i.allowed_channel_ids INTO v_allowed
      FROM public.bot_server_permissions i
     WHERE i.bot_id = p_bot_id
       AND i.server_id = p_server_id
       AND i.is_active IS TRUE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bot is not installed in this server' USING ERRCODE = 'P0002';
    END IF;

    RETURN jsonb_build_object(
        'allowed_channel_ids',
        CASE WHEN v_allowed IS NULL THEN NULL ELSE to_jsonb(ARRAY(
            SELECT c.id
              FROM public.channels c
             WHERE c.server_id = p_server_id
               AND c.id = ANY (v_allowed)
               AND public.can_view_channel(v_caller, c.id)
             ORDER BY c.id)) END,
        'channels',
        COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'id', c.id,
                       'name', c.name,
                       'type', c.type,
                       'category_id', c.category,
                       'everyone_can_view',
                           (COALESCE(ev.permissions, 0) & 1) <> 0
                           OR (((COALESCE(ev.permissions, 0) & ~COALESCE(eo.deny_p, 0))
                                | COALESCE(eo.allow_p, 0)) & 2) <> 0)
                     ORDER BY c."order", c.name, c.id)
              FROM public.channels c
              LEFT JOIN public.server_roles ev
                     ON ev.server_id = c.server_id AND ev.is_default = true
              LEFT JOIN LATERAL (
                  SELECT bit_or(COALESCE(o.allow_permissions, 0)) AS allow_p,
                         bit_or(COALESCE(o.deny_permissions, 0)) AS deny_p
                    FROM public.channel_permission_overrides o
                   WHERE o.channel_id = c.id AND o.role_id = ev.id AND o.user_id IS NULL
              ) eo ON true
             WHERE c.server_id = p_server_id
               AND public.can_view_channel(v_caller, c.id)), '[]'::jsonb));
END;
$$;

-- NULL restores the @everyone default. Every id must be a channel of the server; an id not
-- already listed must be a channel the caller can view. Returns the stored list.
CREATE OR REPLACE FUNCTION public.set_bot_allowed_channels(
    p_server_id uuid,
    p_bot_id uuid,
    p_channel_ids uuid[])
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_install uuid;
    v_current uuid[];
    v_final uuid[];
    v_bad uuid;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.owner = v_caller)
       AND NOT (EXISTS (SELECT 1 FROM public.user_servers us
                         WHERE us.server_id = p_server_id
                           AND us.user_id = v_caller
                           AND us.status = 'accepted')
                AND public.has_permission(v_caller, p_server_id, 'MANAGE_SERVER')) THEN
        RAISE EXCEPTION 'Missing permission: MANAGE_SERVER' USING ERRCODE = '42501';
    END IF;

    SELECT i.id, i.allowed_channel_ids INTO v_install, v_current
      FROM public.bot_server_permissions i
     WHERE i.bot_id = p_bot_id
       AND i.server_id = p_server_id
       AND i.is_active IS TRUE
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bot is not installed in this server' USING ERRCODE = 'P0002';
    END IF;

    IF p_channel_ids IS NULL THEN
        UPDATE public.bot_server_permissions SET allowed_channel_ids = NULL WHERE id = v_install;
        RETURN NULL;
    END IF;

    SELECT x INTO v_bad
      FROM unnest(p_channel_ids) x
     WHERE x IS NULL
        OR NOT EXISTS (SELECT 1 FROM public.channels c WHERE c.id = x AND c.server_id = p_server_id)
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'Channel % is not in this server', v_bad USING ERRCODE = '22023';
    END IF;

    SELECT x INTO v_bad
      FROM unnest(p_channel_ids) x
     WHERE NOT (x = ANY (COALESCE(v_current, '{}'::uuid[])))
       AND NOT public.can_view_channel(v_caller, x)
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'Channel % is not visible to the caller', v_bad USING ERRCODE = '42501';
    END IF;

    v_final := ARRAY(
        SELECT DISTINCT u.x
          FROM (SELECT unnest(p_channel_ids) AS x
                UNION
                SELECT y
                  FROM unnest(COALESCE(v_current, '{}'::uuid[])) y
                 WHERE EXISTS (SELECT 1 FROM public.channels c
                                WHERE c.id = y AND c.server_id = p_server_id)
                   AND NOT public.can_view_channel(v_caller, y)) u
         ORDER BY u.x);

    UPDATE public.bot_server_permissions SET allowed_channel_ids = v_final WHERE id = v_install;
    RETURN v_final;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.admin_list_supporters()',
        'public.admin_add_supporter(uuid, uuid, numeric, text)',
        'public.admin_update_supporter(uuid, jsonb)',
        'public.admin_resolve_pending_donation(uuid, uuid)',
        'public.get_bot_channel_access(uuid, uuid)',
        'public.set_bot_allowed_channels(uuid, uuid, uuid[])'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
