-- =============================================================================
-- Migration: Instance moderators, message deletion permissions,
--            notification_preferences RLS, aggregated encryption stats
-- =============================================================================
-- Safe to run multiple times (idempotent).
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Add is_moderator column to profiles
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_moderator boolean DEFAULT false;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Instance-level helper functions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_current_user_moderator()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
    SELECT COALESCE(
        (SELECT is_moderator FROM public.profiles WHERE auth_user_id = auth.uid()),
        false
    );
$$;

CREATE OR REPLACE FUNCTION public.is_current_user_admin_or_mod()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
    SELECT COALESCE(
        (SELECT (is_admin OR is_moderator) FROM public.profiles WHERE auth_user_id = auth.uid()),
        false
    );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Server-level MANAGE_MESSAGES helper for RLS
--    Checks server ownership + ADMINISTRATOR (bit 0) + MANAGE_MESSAGES (bit 21)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.can_current_user_manage_messages_in_channel(p_channel_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
DECLARE
    v_profile_id uuid;
    v_server_id uuid;
    v_is_owner boolean;
    v_has_perm boolean;
BEGIN
    v_profile_id := public.get_current_profile_id();
    IF v_profile_id IS NULL THEN RETURN false; END IF;

    SELECT server_id INTO v_server_id FROM public.channels WHERE id = p_channel_id;
    IF v_server_id IS NULL THEN RETURN false; END IF;

    SELECT (owner = v_profile_id) INTO v_is_owner FROM public.servers WHERE id = v_server_id;
    IF v_is_owner THEN RETURN true; END IF;

    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        JOIN public.server_roles sr ON sr.id = ur.role_id
        WHERE ur.user_id = v_profile_id
          AND sr.server_id = v_server_id
          AND (
              sr.is_admin = true
              OR (sr.permissions & (1::bigint << 0)) != 0
              OR (sr.permissions & (1::bigint << 21)) != 0
          )
    ) INTO v_has_perm;

    RETURN v_has_perm;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Replace messages UPDATE policy
--    Now allows: author, instance admin, instance mod, server owner/admin/mod
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'messages_update_own' AND tablename = 'messages') THEN
        DROP POLICY "messages_update_own" ON public.messages;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'messages_update_authorized' AND tablename = 'messages') THEN
        DROP POLICY "messages_update_authorized" ON public.messages;
    END IF;
END $$;

CREATE POLICY "messages_update_authorized" ON public.messages
    FOR UPDATE USING (
        user_id = public.get_current_profile_id()
        OR public.is_current_user_admin()
        OR public.is_current_user_moderator()
        OR public.can_current_user_manage_messages_in_channel(channel_id)
    );

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Replace messages DELETE policy
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'messages_delete_own' AND tablename = 'messages') THEN
        DROP POLICY "messages_delete_own" ON public.messages;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'messages_delete_authorized' AND tablename = 'messages') THEN
        DROP POLICY "messages_delete_authorized" ON public.messages;
    END IF;
END $$;

CREATE POLICY "messages_delete_authorized" ON public.messages
    FOR DELETE USING (
        user_id = public.get_current_profile_id()
        OR public.is_current_user_admin()
        OR public.is_current_user_moderator()
        OR public.can_current_user_manage_messages_in_channel(channel_id)
    );

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Fix notification_preferences trigger (SECURITY DEFINER)
--    Without this, profile creation fails with RLS violation
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_notification_preferences()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF NEW.is_local = true OR NEW.is_local IS NULL THEN
        INSERT INTO notification_preferences (user_id)
        VALUES (NEW.id)
        ON CONFLICT (user_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Add RLS policies for notification_preferences
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'notification_preferences_select_own' AND tablename = 'notification_preferences') THEN
        CREATE POLICY "notification_preferences_select_own" ON public.notification_preferences
            FOR SELECT USING (user_id = public.get_current_profile_id());
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'notification_preferences_insert_own' AND tablename = 'notification_preferences') THEN
        CREATE POLICY "notification_preferences_insert_own" ON public.notification_preferences
            FOR INSERT WITH CHECK (user_id = public.get_current_profile_id());
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'notification_preferences_update_own' AND tablename = 'notification_preferences') THEN
        CREATE POLICY "notification_preferences_update_own" ON public.notification_preferences
            FOR UPDATE USING (user_id = public.get_current_profile_id());
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'notification_preferences_delete_own' AND tablename = 'notification_preferences') THEN
        CREATE POLICY "notification_preferences_delete_own" ON public.notification_preferences
            FOR DELETE USING (user_id = public.get_current_profile_id());
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Add RLS policies for notification_channels
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.notification_channels ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'notification_channels_select_own' AND tablename = 'notification_channels') THEN
        CREATE POLICY "notification_channels_select_own" ON public.notification_channels
            FOR SELECT USING (user_id = public.get_current_profile_id());
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'notification_channels_insert_own' AND tablename = 'notification_channels') THEN
        CREATE POLICY "notification_channels_insert_own" ON public.notification_channels
            FOR INSERT WITH CHECK (user_id = public.get_current_profile_id());
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'notification_channels_update_own' AND tablename = 'notification_channels') THEN
        CREATE POLICY "notification_channels_update_own" ON public.notification_channels
            FOR UPDATE USING (user_id = public.get_current_profile_id());
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'notification_channels_delete_own' AND tablename = 'notification_channels') THEN
        CREATE POLICY "notification_channels_delete_own" ON public.notification_channels
            FOR DELETE USING (user_id = public.get_current_profile_id());
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Aggregated encryption stats (replaces N+1 per-user RPC calls)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_server_encryption_stats(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
DECLARE
  v_total int;
  v_with_keys int;
BEGIN
  SELECT count(*) INTO v_total
  FROM user_servers WHERE server_id = p_server_id;

  SELECT count(DISTINCT us.user_id) INTO v_with_keys
  FROM user_servers us
  JOIN user_key_pairs ukp ON ukp.user_id = us.user_id AND ukp.is_active = true
  WHERE us.server_id = p_server_id;

  RETURN jsonb_build_object(
    'total', v_total,
    'with_keys', v_with_keys,
    'percentage', CASE WHEN v_total > 0
      THEN round((v_with_keys::numeric / v_total) * 100)
      ELSE 0 END
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Done
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
    RAISE NOTICE 'Migration complete: moderator role, message permissions, notification RLS, encryption stats';
END $$;
