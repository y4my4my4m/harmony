-- =============================================================================
-- 20260524_channel_overrides_fix
-- =============================================================================
-- Fixes two real bugs that surface when admins try to edit per-channel role
-- permissions from the Channel > Permissions UI:
--
-- 1) The composite UNIQUE(channel_id, role_id, user_id) constraint doesn't
--    enforce uniqueness for role-only rows (where user_id IS NULL) because
--    Postgres treats NULLs as distinct. PostgREST then refuses upserts with
--    `onConflict=channel_id,role_id,user_id` whenever one column is NULL,
--    returning 400 ("there is no unique or exclusion constraint matching the
--    ON CONFLICT specification") - exactly the error in the network log.
--
--    Fix: add two *partial* unique indexes - one for role overrides, one for
--    user overrides - that PostgREST can match for the upsert key. The
--    original composite UNIQUE is left in place (harmless) so the data model
--    is unchanged.
--
-- 2) The original RLS modify policy only let the *server owner* touch
--    overrides. Anyone else (instance admin, role with MANAGE_CHANNELS or
--    MANAGE_ROLES) got "permission denied" even when the UI showed them the
--    rows. We replace it with a broader policy that allows:
--      - the server owner,
--      - any instance admin/moderator,
--      - anyone whose effective role permissions include MANAGE_CHANNELS or
--        MANAGE_ROLES (bits 2 and 3 respectively - see
--        services/RoleService.ts::PERMISSION_BITS),
--      - or an explicit ADMINISTRATOR bit (bit 0).
-- =============================================================================

-- 1) Partial unique indexes for the upsert key -------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uniq_cpo_channel_role
    ON public.channel_permission_overrides (channel_id, role_id)
    WHERE user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_cpo_channel_user
    ON public.channel_permission_overrides (channel_id, user_id)
    WHERE role_id IS NULL;

-- 2) Replace the modify-owner-only policy ------------------------------------
DROP POLICY IF EXISTS "channel_permission_overrides_modify_owner"
    ON public.channel_permission_overrides;

DROP POLICY IF EXISTS "channel_permission_overrides_modify"
    ON public.channel_permission_overrides;

CREATE POLICY "channel_permission_overrides_modify"
    ON public.channel_permission_overrides
    FOR ALL
    USING (
        EXISTS (
            SELECT 1
            FROM public.channels c
            JOIN public.servers s ON s.id = c.server_id
            LEFT JOIN public.profiles p
                ON p.id = public.get_current_profile_id()
            WHERE c.id = channel_permission_overrides.channel_id
              AND (
                    -- server owner
                    s.owner = public.get_current_profile_id()
                    -- instance staff
                    OR COALESCE(p.is_admin, false)
                    OR COALESCE(p.is_moderator, false)
                    -- has MANAGE_CHANNELS, MANAGE_ROLES, or ADMINISTRATOR
                    -- on any role they hold in this server
                    OR EXISTS (
                        SELECT 1
                        FROM public.user_roles ur
                        JOIN public.server_roles sr ON sr.id = ur.role_id
                        WHERE ur.user_id = public.get_current_profile_id()
                          AND ur.server_id = s.id
                          AND (
                                (sr.permissions::bigint & (1::bigint << 0)) <> 0  -- ADMINISTRATOR
                             OR (sr.permissions::bigint & (1::bigint << 2)) <> 0  -- MANAGE_CHANNELS
                             OR (sr.permissions::bigint & (1::bigint << 3)) <> 0  -- MANAGE_ROLES
                          )
                    )
              )
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM public.channels c
            JOIN public.servers s ON s.id = c.server_id
            LEFT JOIN public.profiles p
                ON p.id = public.get_current_profile_id()
            WHERE c.id = channel_permission_overrides.channel_id
              AND (
                    s.owner = public.get_current_profile_id()
                    OR COALESCE(p.is_admin, false)
                    OR COALESCE(p.is_moderator, false)
                    OR EXISTS (
                        SELECT 1
                        FROM public.user_roles ur
                        JOIN public.server_roles sr ON sr.id = ur.role_id
                        WHERE ur.user_id = public.get_current_profile_id()
                          AND ur.server_id = s.id
                          AND (
                                (sr.permissions::bigint & (1::bigint << 0)) <> 0
                             OR (sr.permissions::bigint & (1::bigint << 2)) <> 0
                             OR (sr.permissions::bigint & (1::bigint << 3)) <> 0
                          )
                    )
              )
        )
    );

-- 3) Repeat the policy for normal updates/deletes is implicit (FOR ALL above).

COMMENT ON POLICY "channel_permission_overrides_modify"
    ON public.channel_permission_overrides
    IS 'Server owners, instance staff, and members with MANAGE_CHANNELS / MANAGE_ROLES / ADMINISTRATOR can manage channel permission overrides.';
