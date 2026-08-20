-- ---------------------------------------------------------------------------
-- Restrict `public.invites` SELECT to row-owners and server admins, and expose
-- a SECURITY DEFINER RPC for invite-code lookup (used by accept / preview).
--
-- Why:
-- The previous migration 20260520_invites_drop_legacy_fixme_policies.sql
-- restated `invites_select_public` as `USING (true)` so the
-- accept-by-code flow could read invites without auth. That allows ANY
-- caller to `SELECT * FROM invites` and enumerate every code on the
-- instance (effectively making all invites public).
--
-- Fix:
--   1. Drop the broad SELECT policy.
--   2. Allow SELECT only for:
--        - the invite creator (`created_by = get_current_profile_id()`),
--        - server admins for invites of their server (via
--          `is_current_user_admin()` for instance admins; per-server admin
--          check is left to a future per-server permission policy).
--   3. Add `lookup_invite_by_code(p_code text)` SECURITY DEFINER RPC that
--      returns a single invite row matched by code. Callable by `anon`
--      (public invite preview pages) and `authenticated` (accept flow).
--      This intentionally only exposes one specific code per call - no
--      enumeration.
--
-- Client follow-up: update `src/services/inviteService.ts`
--   - `acceptInvite`: replace `from('invites').select('*').eq('code', code)`
--     with `rpc('lookup_invite_by_code', { p_code: code })`.
--   - `getInviteDetails`: same pattern.
--   - `ServerInviteCard.vue` preview: same pattern.
--
-- Idempotent: DROP POLICY / CREATE OR REPLACE FUNCTION are no-ops on re-run.
-- ---------------------------------------------------------------------------
BEGIN;

-- The deployed `public.invites` schema in some environments predates the
-- `max_uses` and `channel_id` columns defined in
-- `db_schema/init/04_tables_servers.sql`. The lookup RPC below references
-- `max_uses`, and the client (`inviteService.acceptInvite`) treats both as
-- optional. Add them defensively here so the RPC compiles regardless of
-- which historic schema the target DB has.
ALTER TABLE public.invites ADD COLUMN IF NOT EXISTS max_uses integer;
ALTER TABLE public.invites ADD COLUMN IF NOT EXISTS channel_id uuid REFERENCES public.channels(id) ON DELETE SET NULL;

-- Ensure `is_current_user_admin()` exists. This is the canonical definition
-- from `31_rls_policies_extended.sql`; we re-declare it here defensively in
-- case the extended-RLS init script hasn't been applied to the target DB.
-- `CREATE OR REPLACE` is a no-op when the function already exists with this
-- signature.
CREATE OR REPLACE FUNCTION public.is_current_user_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT is_admin FROM public.profiles WHERE auth_user_id = auth.uid()),
        false
    );
$$;

DROP POLICY IF EXISTS "invites_select_public" ON public.invites;
DROP POLICY IF EXISTS "invites_select_all" ON public.invites;

-- Creator can read their own invites.
DROP POLICY IF EXISTS "invites_select_creator" ON public.invites;
CREATE POLICY "invites_select_creator" ON public.invites
    FOR SELECT
    USING (created_by = public.get_current_profile_id());

-- Instance admins can read all invites for moderation / debugging.
DROP POLICY IF EXISTS "invites_select_instance_admin" ON public.invites;
CREATE POLICY "invites_select_instance_admin" ON public.invites
    FOR SELECT
    USING (public.is_current_user_admin());

-- ---------------------------------------------------------------------------
-- Lookup RPC - single-code, no enumeration.
--
-- Returns the join-relevant columns of one invite plus the resolved server
-- display fields, so the existing `getInviteDetails` / preview flows can
-- drop their `servers!inner(...)` join.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lookup_invite_by_code(p_code text)
RETURNS TABLE (
    id uuid,
    code text,
    server_id uuid,
    created_by uuid,
    uses integer,
    max_uses integer,
    used boolean,
    temporary boolean,
    expires_at timestamptz,
    created_at timestamptz,
    server_name text,
    server_icon text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
    -- NOTE: `servers.icon` stores a relative path (e.g. '/default_server.webp').
    -- The deployed schema does not have an `icon_url` column - the existing
    -- client code (ServerInviteCard.vue) resolves the display URL itself via
    -- `getServerIconUrl(server.icon)`. We return the raw `icon` field here.
    SELECT
        i.id,
        i.code,
        i.server_id,
        i.created_by,
        i.uses,
        i.max_uses,
        i.used,
        i.temporary,
        i.expires_at,
        i.created_at,
        s.name AS server_name,
        s.icon AS server_icon
    FROM public.invites i
    LEFT JOIN public.servers s ON s.id = i.server_id
    WHERE i.code = p_code
    LIMIT 1;
$$;

COMMENT ON FUNCTION public.lookup_invite_by_code(text) IS
    'Public-facing invite-code → invite-row lookup. Bypasses RLS so the accept-flow can validate an invite before the user joins. Single-row, no enumeration.';

GRANT EXECUTE ON FUNCTION public.lookup_invite_by_code(text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
