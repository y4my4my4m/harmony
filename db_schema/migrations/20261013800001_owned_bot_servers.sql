-- Servers each of the caller's bots is installed in, named, for the My bots list.
-- servers is readable only by members (or when public), so an owner cannot name a
-- private server their bot was added to without being a member themselves; the
-- bridge bot of a server set up by someone else is one such case.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_owned_bot_servers()
RETURNS TABLE (bot_id uuid, server_id uuid, server_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT b.id, s.id, s.name
      FROM public.bots b
      JOIN public.bot_server_permissions p
        ON p.bot_id = b.id AND p.is_active
      JOIN public.servers s
        ON s.id = p.server_id
     WHERE b.owner_id = (SELECT public.get_current_profile_id())
     ORDER BY b.id, lower(s.name), s.id;
$$;

REVOKE ALL ON FUNCTION public.get_owned_bot_servers() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_owned_bot_servers() TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
