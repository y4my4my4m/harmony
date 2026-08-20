-- channels and server_roles are upserted ON CONFLICT (ap_id) with no unique index to
-- infer, which raises 42P10.
--
-- Full, not partial: ON CONFLICT infers only a full index. ap_id is nullable and NULLs
-- are distinct, so local rows stay unconstrained.
--
-- Duplicates abort rather than being deleted: channels cascades to messages and
-- server_roles to user_roles.

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
