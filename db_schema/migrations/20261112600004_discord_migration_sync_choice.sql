-- Migrate from Discord: remember that a member made a profile sync choice.
--
-- sync_fields = '{}' means both "copy nothing" and "never chose", so the panel could not tell
-- whether to pre-tick every field. discord_migration_links.sync_chosen_at is set when the member
-- saves their choice (discord_migration_set_my_sync); discord_migration_my_link returns it as
-- sync_chosen. Links that already copy something count as chosen.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.discord_migration_links ADD COLUMN IF NOT EXISTS sync_chosen_at timestamptz;

UPDATE public.discord_migration_links
   SET sync_chosen_at = COALESCE(last_synced_at, linked_at)
 WHERE sync_chosen_at IS NULL AND cardinality(sync_fields) > 0;

CREATE OR REPLACE FUNCTION public.discord_migration_set_my_sync(p_server_id uuid, p_fields text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_fields text[];
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    v_fields := COALESCE((SELECT array_agg(DISTINCT f ORDER BY f) FROM unnest(COALESCE(p_fields, '{}')) f), '{}');
    IF NOT (v_fields <@ ARRAY['avatar', 'display_name', 'banner', 'accent_color',
                              'server_nickname', 'server_avatar', 'server_banner']::text[]) THEN
        RAISE EXCEPTION 'invalid_sync_field' USING ERRCODE = '22023';
    END IF;
    UPDATE public.discord_migration_links l
       SET sync_fields = v_fields, sync_chosen_at = now(), last_synced_at = NULL
     WHERE l.server_id = p_server_id AND l.user_id = v_me;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'link_not_found' USING ERRCODE = 'P0002';
    END IF;
END;
$$;

-- The caller's own link {status, sync_fields, sync_chosen, discord_joined_at}, or null.
CREATE OR REPLACE FUNCTION public.discord_migration_my_link(p_server_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
    SELECT jsonb_build_object('status', l.status, 'sync_fields', to_jsonb(l.sync_fields),
                              'sync_chosen', l.sync_chosen_at IS NOT NULL,
                              'discord_joined_at', l.discord_joined_at)
      FROM public.discord_migration_links l
     WHERE l.server_id = p_server_id AND l.user_id = public.get_current_profile_id()
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
