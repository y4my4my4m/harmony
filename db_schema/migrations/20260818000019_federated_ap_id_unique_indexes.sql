-- Two upserts infer a unique index that does not exist, so Postgres raises 42P10:
--   ServerDiscoveryService.syncRemoteServer  channels     ON CONFLICT (ap_id)
--   RoleActivityHandler                      server_roles ON CONFLICT (ap_id)
-- The channels call sits inside a catch that only logs, so remote server sync fails
-- without surfacing.
--
-- Indexes are full, not partial: ON CONFLICT infers only a full index. ap_id is nullable
-- and NULLs are distinct, so local rows stay unconstrained.
--
-- Duplicates are reported, not deleted. channels cascades to messages and server_roles
-- to user_roles; removing a row here would take user data with it.

BEGIN;

DO $$
DECLARE
    v_dupes bigint;
BEGIN
    SELECT count(*) INTO v_dupes FROM (
        SELECT ap_id FROM public.channels
         WHERE ap_id IS NOT NULL GROUP BY ap_id HAVING count(*) > 1
    ) d;
    IF v_dupes > 0 THEN
        RAISE EXCEPTION
            'cannot add idx_channels_ap_id: % ap_id value(s) appear on more than one channel. Resolve by hand; deleting a channel deletes its messages.', v_dupes;
    END IF;

    SELECT count(*) INTO v_dupes FROM (
        SELECT ap_id FROM public.server_roles
         WHERE ap_id IS NOT NULL GROUP BY ap_id HAVING count(*) > 1
    ) d;
    IF v_dupes > 0 THEN
        RAISE EXCEPTION
            'cannot add idx_server_roles_ap_id: % ap_id value(s) appear on more than one role. Resolve by hand; deleting a role deletes its user_roles.', v_dupes;
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_ap_id ON public.channels(ap_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_server_roles_ap_id ON public.server_roles(ap_id);

COMMIT;
