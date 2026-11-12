-- Migrate from Discord: member channel overrides, the follow-up rules.
--
-- 1. A member whose link stops being active, or who stops being an accepted member (Discord leave or
--    ban, Harmony kick or ban, unlink), loses the overrides the migration made for them. Triggers on
--    user_servers and discord_migration_links call discord_migration_release_member_overrides; the apply
--    function calls it too for anyone who is no longer eligible.
-- 2. discord_migration_applied_overrides records the allow and deny bits the migration applied. A live
--    override that differs was edited by an admin: the migration stops managing it (the tracking row is
--    dismissed), never overwrites it and never deletes it.
-- 3. An admin who deletes a migration-made override is not undone: the delete trigger tombstones the
--    tracking row (dismissed_at) instead of letting it cascade away, and tombstoned (channel, member)
--    pairs are skipped. The tombstone goes when Discord no longer has the overwrite.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.discord_migration_applied_overrides
    ADD COLUMN IF NOT EXISTS applied_allow bigint,
    ADD COLUMN IF NOT EXISTS applied_deny bigint,
    ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;

UPDATE public.discord_migration_applied_overrides a
   SET applied_allow = COALESCE(o.allow_permissions, 0), applied_deny = COALESCE(o.deny_permissions, 0)
  FROM public.channel_permission_overrides o
 WHERE o.id = a.override_id AND a.applied_allow IS NULL;
UPDATE public.discord_migration_applied_overrides SET applied_allow = 0 WHERE applied_allow IS NULL;
UPDATE public.discord_migration_applied_overrides SET applied_deny = 0 WHERE applied_deny IS NULL;
ALTER TABLE public.discord_migration_applied_overrides
    ALTER COLUMN applied_allow SET NOT NULL, ALTER COLUMN applied_allow SET DEFAULT 0,
    ALTER COLUMN applied_deny SET NOT NULL, ALTER COLUMN applied_deny SET DEFAULT 0;

-- The tracking row outlives its override: deleting the override nulls the link and the trigger below says why.
ALTER TABLE public.discord_migration_applied_overrides ALTER COLUMN override_id DROP NOT NULL;
ALTER TABLE public.discord_migration_applied_overrides
    DROP CONSTRAINT IF EXISTS discord_migration_applied_overrides_override_id_fkey;
ALTER TABLE public.discord_migration_applied_overrides
    ADD CONSTRAINT discord_migration_applied_overrides_override_id_fkey
    FOREIGN KEY (override_id) REFERENCES public.channel_permission_overrides(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.discord_migration_override_deleted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_setting('harmony.via', true) IS DISTINCT FROM 'discord_migration' THEN
        UPDATE public.discord_migration_applied_overrides a
           SET dismissed_at = now()
         WHERE a.override_id = OLD.id AND a.dismissed_at IS NULL;
    END IF;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS a_channel_overrides_discord_migration ON public.channel_permission_overrides;
CREATE TRIGGER a_channel_overrides_discord_migration
    BEFORE DELETE ON public.channel_permission_overrides
    FOR EACH ROW EXECUTE FUNCTION public.discord_migration_override_deleted();

-- Drops the migration's tracking of this member's overrides on every channel except p_keep. A migration-made
-- override that is still as applied is deleted; one an admin edited or already dismissed is left alone.
-- Returns how many overrides it deleted.
CREATE OR REPLACE FUNCTION public.discord_migration_release_member_overrides(
    p_server_id uuid, p_user_id uuid, p_keep uuid[] DEFAULT '{}')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_prev_via text := current_setting('harmony.via', true);
    v_row record;
    v_live public.channel_permission_overrides;
    v_removed integer := 0;
BEGIN
    PERFORM set_config('harmony.via', 'discord_migration', true);
    FOR v_row IN
        SELECT a.* FROM public.discord_migration_applied_overrides a
         WHERE a.server_id = p_server_id AND a.user_id = p_user_id
           AND NOT (a.harmony_channel_id = ANY (COALESCE(p_keep, '{}')))
    LOOP
        IF v_row.override_id IS NOT NULL AND v_row.dismissed_at IS NULL THEN
            SELECT * INTO v_live FROM public.channel_permission_overrides o WHERE o.id = v_row.override_id;
            IF FOUND AND COALESCE(v_live.allow_permissions, 0) = v_row.applied_allow
               AND COALESCE(v_live.deny_permissions, 0) = v_row.applied_deny THEN
                DELETE FROM public.channel_permission_overrides o WHERE o.id = v_row.override_id;
                v_removed := v_removed + 1;
                -- The generic audit trigger stays quiet inside another trigger: write the row here.
                IF pg_trigger_depth() > 0 THEN
                    PERFORM public.server_audit_write(p_server_id, 'override.delete', 'channel',
                        v_row.harmony_channel_id::text,
                        (SELECT c.name FROM public.channels c WHERE c.id = v_row.harmony_channel_id),
                        NULL,
                        jsonb_build_object('override_type', 'user', 'user_id', p_user_id,
                            'user_name', (SELECT p.username FROM public.profiles p WHERE p.id = p_user_id),
                            'via', 'discord_migration'),
                        NULL, NULL, 'system');
                END IF;
            END IF;
        END IF;
        DELETE FROM public.discord_migration_applied_overrides a
         WHERE a.server_id = v_row.server_id AND a.user_id = v_row.user_id
           AND a.harmony_channel_id = v_row.harmony_channel_id;
    END LOOP;
    PERFORM set_config('harmony.via', COALESCE(v_prev_via, ''), true);
    RETURN v_removed;
END;
$$;

REVOKE ALL ON FUNCTION public.discord_migration_release_member_overrides(uuid, uuid, uuid[])
    FROM PUBLIC, anon, authenticated, service_role;

-- A member who leaves, is kicked or banned, or whose link stops being active loses the migration's overrides.
CREATE OR REPLACE FUNCTION public.discord_migration_release_on_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.status = 'accepted' AND (TG_OP = 'DELETE' OR NEW.status IS DISTINCT FROM 'accepted') THEN
        IF EXISTS (SELECT 1 FROM public.discord_migration_applied_overrides a
                    WHERE a.server_id = OLD.server_id AND a.user_id = OLD.user_id) THEN
            PERFORM public.discord_migration_release_member_overrides(OLD.server_id, OLD.user_id, '{}');
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_user_servers_discord_migration_overrides ON public.user_servers;
CREATE TRIGGER z_user_servers_discord_migration_overrides
    AFTER UPDATE OR DELETE ON public.user_servers
    FOR EACH ROW EXECUTE FUNCTION public.discord_migration_release_on_membership();

CREATE OR REPLACE FUNCTION public.discord_migration_release_on_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.status = 'active' AND (TG_OP = 'DELETE' OR NEW.status IS DISTINCT FROM 'active') THEN
        PERFORM public.discord_migration_release_member_overrides(OLD.server_id, OLD.user_id, '{}');
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_discord_migration_links_overrides ON public.discord_migration_links;
CREATE TRIGGER z_discord_migration_links_overrides
    AFTER UPDATE OR DELETE ON public.discord_migration_links
    FOR EACH ROW EXECUTE FUNCTION public.discord_migration_release_on_link();

REVOKE ALL ON FUNCTION public.discord_migration_override_deleted(), public.discord_migration_release_on_membership(),
    public.discord_migration_release_on_link() FROM PUBLIC, anon, authenticated, service_role;

-- Makes the member's channel overrides match the snapshot: for each Discord channel paired with a Harmony
-- channel of this server where the snapshot has an overwrite for the member's Discord account, the member
-- gets a user override with those bits; an override Discord no longer has is deleted. Only rows in
-- discord_migration_applied_overrides are ever changed or deleted, and only while the live override is still
-- as the migration applied it: an edit or a delete by an admin dismisses the row and the migration leaves
-- that pair alone. A user override an admin made on the same channel is skipped. The server owner is never
-- touched; a member who is not an accepted member with an active link loses what the migration made for
-- them. Returns {created, updated, removed, skipped}.
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
    v_t record;
    v_live record;
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
        v_removed := public.discord_migration_release_member_overrides(p_server_id, p_user_id, '{}');
        RETURN jsonb_build_object('created', 0, 'updated', 0, 'removed', v_removed, 'skipped', 0);
    END IF;
    SELECT l.discord_user_id INTO v_discord_user FROM public.discord_migration_links l
     WHERE l.server_id = p_server_id AND l.user_id = p_user_id AND l.status = 'active';
    IF NOT FOUND THEN
        v_removed := public.discord_migration_release_member_overrides(p_server_id, p_user_id, '{}');
        RETURN jsonb_build_object('created', 0, 'updated', 0, 'removed', v_removed, 'skipped', 0);
    END IF;

    SELECT COALESCE(array_agg(DISTINCT bc.harmony_channel_id), '{}') INTO v_keep
      FROM public.discord_migration_member_overrides o
      JOIN public.discord_bridge_channels bc ON bc.discord_channel_id = o.discord_channel_id
      JOIN public.discord_bridges b ON b.id = bc.bridge_id AND b.server_id = p_server_id
      JOIN public.channels c ON c.id = bc.harmony_channel_id AND c.server_id = p_server_id
     WHERE o.server_id = p_server_id AND o.discord_user_id = v_discord_user
       AND ((o.allow_harmony & ~(1::bigint)) <> 0 OR (o.deny_harmony & ~(1::bigint)) <> 0);

    v_removed := public.discord_migration_release_member_overrides(p_server_id, p_user_id, v_keep);
    PERFORM set_config('harmony.via', 'discord_migration', true);

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
        SELECT a.override_id, a.dismissed_at, a.applied_allow, a.applied_deny INTO v_t
          FROM public.discord_migration_applied_overrides a
         WHERE a.server_id = p_server_id AND a.user_id = p_user_id AND a.harmony_channel_id = v_row.harmony_channel_id;
        IF FOUND THEN
            IF v_t.dismissed_at IS NOT NULL THEN
                v_skipped := v_skipped + 1;
                CONTINUE;
            END IF;
            SELECT COALESCE(o.allow_permissions, 0) AS allow_p, COALESCE(o.deny_permissions, 0) AS deny_p INTO v_live
              FROM public.channel_permission_overrides o WHERE o.id = v_t.override_id;
            IF NOT FOUND OR v_live.allow_p <> v_t.applied_allow OR v_live.deny_p <> v_t.applied_deny THEN
                -- Gone or edited by an admin: theirs from now on.
                UPDATE public.discord_migration_applied_overrides a SET dismissed_at = now()
                 WHERE a.server_id = p_server_id AND a.user_id = p_user_id AND a.harmony_channel_id = v_row.harmony_channel_id;
                v_skipped := v_skipped + 1;
                CONTINUE;
            END IF;
            IF v_live.allow_p <> v_row.allow_p OR v_live.deny_p <> v_row.deny_p THEN
                UPDATE public.channel_permission_overrides o
                   SET allow_permissions = v_row.allow_p, deny_permissions = v_row.deny_p
                 WHERE o.id = v_t.override_id;
                GET DIAGNOSTICS v_n = ROW_COUNT;
                v_updated := v_updated + v_n;
            END IF;
            UPDATE public.discord_migration_applied_overrides a
               SET discord_channel_id = v_row.discord_channel_id,
                   applied_allow = v_row.allow_p, applied_deny = v_row.deny_p
             WHERE a.server_id = p_server_id AND a.user_id = p_user_id AND a.harmony_channel_id = v_row.harmony_channel_id;
        ELSIF EXISTS (SELECT 1 FROM public.channel_permission_overrides o
                       WHERE o.channel_id = v_row.harmony_channel_id AND o.user_id = p_user_id) THEN
            v_skipped := v_skipped + 1;
        ELSE
            INSERT INTO public.channel_permission_overrides
                (channel_id, target_type, user_id, allow_permissions, deny_permissions)
            VALUES (v_row.harmony_channel_id, 'user', p_user_id, v_row.allow_p, v_row.deny_p)
            RETURNING id INTO v_id;
            INSERT INTO public.discord_migration_applied_overrides
                (server_id, user_id, harmony_channel_id, override_id, discord_channel_id, applied_allow, applied_deny)
            VALUES (p_server_id, p_user_id, v_row.harmony_channel_id, v_id, v_row.discord_channel_id,
                    v_row.allow_p, v_row.deny_p);
            v_created := v_created + 1;
        END IF;
    END LOOP;

    PERFORM set_config('harmony.via', COALESCE(v_prev_via, ''), true);
    RETURN jsonb_build_object('created', v_created, 'updated', v_updated, 'removed', v_removed, 'skipped', v_skipped);
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
