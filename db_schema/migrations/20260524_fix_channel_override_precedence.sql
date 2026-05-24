-- =============================================================================
-- 20260524_fix_channel_override_precedence
-- =============================================================================
-- Fixes a Discord-precedence bug in `get_user_permissions(uuid, uuid, uuid)`.
--
-- BUG
-- ---
-- The previous implementation combined every relevant channel override into a
-- single allow mask and a single deny mask, then applied them in one step:
--
--     v_final_mask := (v_final_mask | v_allow_mask) & ~v_deny_mask;
--
-- That breaks the most common Discord-style use case:
--
--     • In #announcements, deny SEND_MESSAGES on @everyone.
--     • On the @mods role, leave SEND_MESSAGES granted at the server level.
--     • Expected: @mods members can still send in #announcements.
--     • Actual: the @everyone deny gets OR'd into the same v_deny_mask as
--       any role grants, so `... & ~v_deny_mask` wipes SEND_MESSAGES even if
--       @mods had it.
--
-- DISCORD'S ACTUAL ALGORITHM (https://discord.com/developers/docs/topics/permissions)
-- ----------------------------------------------------------------------------
-- Permissions are applied in layers, and within each layer DENY is applied
-- before ALLOW, so a higher layer can re-grant what a lower layer revoked:
--
--   1) Start with merged server-role permissions (already correct above).
--   2) Apply the @everyone channel override:           (mask & ~deny) | allow
--   3) Apply the COMBINED non-everyone role overrides: (mask & ~deny) | allow
--   4) Apply the user-specific channel override:       (mask & ~deny) | allow
--
-- This means a role override ALLOW always trumps an @everyone DENY at the
-- channel level, and a user-specific ALLOW always trumps a role DENY — which
-- is what every Discord admin (and our UI copy in ChannelEditModal) assumes.
--
-- This migration is idempotent — `CREATE OR REPLACE FUNCTION` replaces the
-- previous implementation. No data is touched; only the computation changes.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_user_permissions(
    p_user_id uuid,
    p_server_id uuid,
    p_channel_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_owner boolean;
    v_base_mask bigint := 0;
    v_final_mask bigint;
    v_role record;
    v_override record;
    v_result jsonb := '{}'::jsonb;
    v_bit_map jsonb := '[
        "ADMINISTRATOR","VIEW_CHANNEL","MANAGE_CHANNELS","MANAGE_ROLES",
        "MANAGE_EMOJIS","VIEW_AUDIT_LOG","MANAGE_WEBHOOKS","MANAGE_SERVER",
        "CREATE_INVITE","KICK_MEMBERS","BAN_MEMBERS","TIMEOUT_MEMBERS",
        "SEND_MESSAGES","SEND_MESSAGES_IN_THREADS","CREATE_PUBLIC_THREADS","CREATE_PRIVATE_THREADS",
        "EMBED_LINKS","ATTACH_FILES","ADD_REACTIONS","USE_EXTERNAL_EMOJIS",
        "MENTION_EVERYONE","MANAGE_MESSAGES","READ_MESSAGE_HISTORY","PIN_MESSAGES",
        "CONNECT","SPEAK","STREAM","MUTE_MEMBERS","DEAFEN_MEMBERS","MOVE_MEMBERS"
    ]'::jsonb;
    v_i int;
    v_perm_name text;
BEGIN
    -- Server owner short-circuit (always all-permissions).
    SELECT (owner = p_user_id) INTO v_is_owner
      FROM public.servers WHERE id = p_server_id;

    IF v_is_owner THEN
        FOR v_i IN 0..29 LOOP
            v_perm_name := v_bit_map->>v_i;
            IF v_perm_name IS NOT NULL THEN
                v_result := v_result || jsonb_build_object(v_perm_name, true);
            END IF;
        END LOOP;
        RETURN v_result;
    END IF;

    -- 1) Base: @everyone server perms OR'd with each of the user's roles.
    SELECT COALESCE(permissions, 0) INTO v_base_mask
      FROM public.server_roles
     WHERE server_id = p_server_id AND is_default = true;
    v_base_mask := COALESCE(v_base_mask, 0);

    FOR v_role IN
        SELECT sr.permissions
          FROM public.user_roles ur
          JOIN public.server_roles sr ON ur.role_id = sr.id
         WHERE ur.user_id = p_user_id AND ur.server_id = p_server_id
    LOOP
        v_base_mask := v_base_mask | COALESCE(v_role.permissions, 0);
    END LOOP;

    -- ADMINISTRATOR bit short-circuit (bypasses channel overrides entirely).
    IF (v_base_mask & 1) != 0 THEN
        FOR v_i IN 0..29 LOOP
            v_perm_name := v_bit_map->>v_i;
            IF v_perm_name IS NOT NULL THEN
                v_result := v_result || jsonb_build_object(v_perm_name, true);
            END IF;
        END LOOP;
        RETURN v_result;
    END IF;

    v_final_mask := v_base_mask;

    -- 2-4) Channel overrides, applied in Discord's layered order.
    IF p_channel_id IS NOT NULL THEN
        DECLARE
            v_everyone_role_id uuid;
            v_everyone_allow bigint := 0;
            v_everyone_deny  bigint := 0;
            v_role_allow     bigint := 0;
            v_role_deny      bigint := 0;
            v_user_allow     bigint := 0;
            v_user_deny      bigint := 0;
        BEGIN
            SELECT id INTO v_everyone_role_id
              FROM public.server_roles
             WHERE server_id = p_server_id AND is_default = true
             LIMIT 1;

            -- Single pass over the overrides table; partition into the
            -- three layers as we go.
            FOR v_override IN
                SELECT role_id, user_id,
                       COALESCE(allow_permissions, 0) AS allow_p,
                       COALESCE(deny_permissions, 0)  AS deny_p
                  FROM public.channel_permission_overrides
                 WHERE channel_id = p_channel_id
                   AND (
                        role_id = v_everyone_role_id
                     OR role_id IN (
                            SELECT ur.role_id
                              FROM public.user_roles ur
                             WHERE ur.user_id = p_user_id
                               AND ur.server_id = p_server_id
                        )
                     OR user_id = p_user_id
                   )
            LOOP
                IF v_override.user_id = p_user_id THEN
                    v_user_allow := v_user_allow | v_override.allow_p;
                    v_user_deny  := v_user_deny  | v_override.deny_p;
                ELSIF v_override.role_id = v_everyone_role_id THEN
                    v_everyone_allow := v_everyone_allow | v_override.allow_p;
                    v_everyone_deny  := v_everyone_deny  | v_override.deny_p;
                ELSIF v_override.role_id IS NOT NULL THEN
                    v_role_allow := v_role_allow | v_override.allow_p;
                    v_role_deny  := v_role_deny  | v_override.deny_p;
                END IF;
            END LOOP;

            -- Layer 2: @everyone
            v_final_mask := (v_final_mask & ~v_everyone_deny) | v_everyone_allow;
            -- Layer 3: combined non-everyone role overrides
            v_final_mask := (v_final_mask & ~v_role_deny) | v_role_allow;
            -- Layer 4: user-specific
            v_final_mask := (v_final_mask & ~v_user_deny) | v_user_allow;
        END;
    END IF;

    -- Bitmask → jsonb { PERMISSION_NAME: boolean } shape.
    FOR v_i IN 0..29 LOOP
        v_perm_name := v_bit_map->>v_i;
        IF v_perm_name IS NOT NULL THEN
            v_result := v_result || jsonb_build_object(
                v_perm_name,
                (v_final_mask & (1::bigint << v_i)) != 0
            );
        END IF;
    END LOOP;

    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_user_permissions(uuid, uuid, uuid)
    IS 'Discord-style layered channel permission resolution: base server-role mask, then @everyone override, then combined non-everyone role overrides, then user-specific override. Each layer applies deny then allow, so a higher layer can re-grant what a lower layer revoked.';
