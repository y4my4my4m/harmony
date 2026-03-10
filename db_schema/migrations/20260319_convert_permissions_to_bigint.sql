-- =============================================================================
-- Migration: Convert permissions from JSONB to bigint bitmask
-- =============================================================================
-- Fixes: operator does not exist: jsonb || bigint
--
-- The old get_user_permissions expected server_roles.permissions as jsonb.
-- When permissions was migrated to bigint, the function crashed on
-- v_base_permissions || v_role.permissions (jsonb || bigint).
--
-- This migration:
--   1. Creates helper to convert JSONB permission objects to bigint bitmask
--   2. Converts server_roles.permissions from jsonb to bigint (if needed)
--   3. Converts channel_permission_overrides from jsonb to bigint (if needed)
--   4. Replaces get_user_permissions to work with bigint
--   5. Replaces has_permission
--
-- Safe to run on environments that already use bigint (no-op).
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Helper: Convert a JSONB permission object to a bigint bitmask
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._jsonb_perms_to_bitmask(p_perms jsonb)
RETURNS bigint
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
    v_mask bigint := 0;
    v_bits jsonb := '{
        "ADMINISTRATOR": 0,
        "VIEW_CHANNEL": 1,
        "MANAGE_CHANNELS": 2,
        "MANAGE_ROLES": 3,
        "MANAGE_EMOJIS": 4,
        "VIEW_AUDIT_LOG": 5,
        "MANAGE_WEBHOOKS": 6,
        "MANAGE_SERVER": 7,
        "CREATE_INVITE": 8,
        "KICK_MEMBERS": 9,
        "BAN_MEMBERS": 10,
        "TIMEOUT_MEMBERS": 11,
        "SEND_MESSAGES": 12,
        "SEND_MESSAGES_IN_THREADS": 13,
        "CREATE_PUBLIC_THREADS": 14,
        "CREATE_PRIVATE_THREADS": 15,
        "EMBED_LINKS": 16,
        "ATTACH_FILES": 17,
        "ADD_REACTIONS": 18,
        "USE_EXTERNAL_EMOJIS": 19,
        "MENTION_EVERYONE": 20,
        "MANAGE_MESSAGES": 21,
        "READ_MESSAGE_HISTORY": 22,
        "PIN_MESSAGES": 23,
        "CONNECT": 24,
        "SPEAK": 25,
        "STREAM": 26,
        "MUTE_MEMBERS": 27,
        "DEAFEN_MEMBERS": 28,
        "MOVE_MEMBERS": 29
    }'::jsonb;
    v_key text;
    v_bit int;
BEGIN
    IF p_perms IS NULL OR p_perms = 'null'::jsonb OR p_perms = '{}'::jsonb THEN
        RETURN 0;
    END IF;

    IF jsonb_typeof(p_perms) = 'number' THEN
        RETURN p_perms::text::bigint;
    END IF;

    IF jsonb_typeof(p_perms) != 'object' THEN
        RETURN 0;
    END IF;

    FOR v_key IN SELECT jsonb_object_keys(p_perms)
    LOOP
        IF (p_perms->>v_key)::boolean = true AND v_bits ? v_key THEN
            v_bit := (v_bits->>v_key)::int;
            v_mask := v_mask | (1::bigint << v_bit);
        END IF;
    END LOOP;

    RETURN v_mask;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Convert server_roles.permissions from jsonb to bigint
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    v_col_type text;
BEGIN
    SELECT data_type INTO v_col_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'server_roles'
      AND column_name = 'permissions';

    IF v_col_type = 'jsonb' THEN
        ALTER TABLE public.server_roles ADD COLUMN IF NOT EXISTS permissions_new bigint DEFAULT 0;
        UPDATE public.server_roles
        SET permissions_new = public._jsonb_perms_to_bitmask(permissions);
        ALTER TABLE public.server_roles DROP COLUMN permissions;
        ALTER TABLE public.server_roles RENAME COLUMN permissions_new TO permissions;
        ALTER TABLE public.server_roles ALTER COLUMN permissions SET DEFAULT 0;
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Convert channel_permission_overrides from jsonb to bigint
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    v_has_allow_col boolean;
    v_has_allow_perms_col boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'channel_permission_overrides'
        AND column_name = 'allow'
    ) INTO v_has_allow_col;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'channel_permission_overrides'
        AND column_name = 'allow_permissions'
    ) INTO v_has_allow_perms_col;

    IF v_has_allow_col AND NOT v_has_allow_perms_col THEN
        ALTER TABLE public.channel_permission_overrides
            ADD COLUMN allow_permissions bigint DEFAULT 0,
            ADD COLUMN deny_permissions bigint DEFAULT 0;

        UPDATE public.channel_permission_overrides
        SET allow_permissions = public._jsonb_perms_to_bitmask("allow"),
            deny_permissions = public._jsonb_perms_to_bitmask("deny");

        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'channel_permission_overrides'
            AND column_name = 'role_id'
        ) THEN
            ALTER TABLE public.channel_permission_overrides
                ADD COLUMN role_id uuid REFERENCES public.server_roles(id) ON DELETE CASCADE,
                ADD COLUMN user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE;

            UPDATE public.channel_permission_overrides
            SET role_id = target_id WHERE target_type = 'role';

            UPDATE public.channel_permission_overrides
            SET user_id = target_id WHERE target_type = 'user';
        END IF;

        ALTER TABLE public.channel_permission_overrides DROP COLUMN IF EXISTS "allow";
        ALTER TABLE public.channel_permission_overrides DROP COLUMN IF EXISTS "deny";
        ALTER TABLE public.channel_permission_overrides DROP COLUMN IF EXISTS target_id;
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Replace get_user_permissions to work with bigint bitmask
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_user_permissions(
    p_user_id uuid,
    p_server_id uuid,
    p_channel_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
DECLARE
    v_is_owner boolean;
    v_base_mask bigint := 0;
    v_allow_mask bigint := 0;
    v_deny_mask bigint := 0;
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
    SELECT (owner = p_user_id) INTO v_is_owner
    FROM public.servers WHERE id = p_server_id;

    IF v_is_owner THEN
        v_result := '{}'::jsonb;
        FOR v_i IN 0..29 LOOP
            v_perm_name := v_bit_map->>v_i;
            IF v_perm_name IS NOT NULL THEN
                v_result := v_result || jsonb_build_object(v_perm_name, true);
            END IF;
        END LOOP;
        RETURN v_result;
    END IF;

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

    IF (v_base_mask & 1) != 0 THEN
        v_result := '{}'::jsonb;
        FOR v_i IN 0..29 LOOP
            v_perm_name := v_bit_map->>v_i;
            IF v_perm_name IS NOT NULL THEN
                v_result := v_result || jsonb_build_object(v_perm_name, true);
            END IF;
        END LOOP;
        RETURN v_result;
    END IF;

    v_final_mask := v_base_mask;
    IF p_channel_id IS NOT NULL THEN
        FOR v_override IN
            SELECT allow_permissions, deny_permissions
            FROM public.channel_permission_overrides
            WHERE channel_id = p_channel_id
              AND (role_id IN (
                  SELECT sr.id FROM public.user_roles ur
                  JOIN public.server_roles sr ON ur.role_id = sr.id
                  WHERE ur.user_id = p_user_id AND ur.server_id = p_server_id
              ) OR user_id = p_user_id)
        LOOP
            v_allow_mask := v_allow_mask | COALESCE(v_override.allow_permissions, 0);
            v_deny_mask := v_deny_mask | COALESCE(v_override.deny_permissions, 0);
        END LOOP;

        v_final_mask := (v_final_mask | v_allow_mask) & ~v_deny_mask;
    END IF;

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

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Ensure has_permission works
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.has_permission(
    p_user_id uuid,
    p_server_id uuid,
    p_permission text,
    p_channel_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
DECLARE
    v_permissions jsonb;
BEGIN
    v_permissions := public.get_user_permissions(p_user_id, p_server_id, p_channel_id);
    RETURN COALESCE((v_permissions->>p_permission)::boolean, false);
END;
$$;

DROP FUNCTION IF EXISTS public._jsonb_perms_to_bitmask(jsonb);

COMMIT;
