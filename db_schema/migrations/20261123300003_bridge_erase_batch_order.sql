-- Bridge privacy: an erase batch and an opt-in or a Restore are ordered.
--
-- bridge_privacy_erase_tail and bridge_privacy_erase_continue read the opt-out row without a lock,
-- then erased a batch: an opt-in (bridge_privacy_set_optout) or a Restore
-- (bridge_privacy_restore_remote_user) that committed meanwhile did not stop it, and the batch
-- erased messages of a member who was back. Both now lock the row FOR UPDATE before the batch; the
-- opt-in's and the Restore's delete or update of the row waits for the batch to commit, or the
-- batch, started later, finds the row gone or changed. The first batch (bridge_privacy_erase,
-- bridge_privacy_remove_remote_user) holds the row already: INSERT ... ON CONFLICT DO UPDATE locks
-- the conflicting row whether or not its WHERE updates it.
--
--   bridge_privacy_erase_tail       as 20261115900001_review_round4.sql; FOR UPDATE on the row.
--   bridge_privacy_erase_continue   as 20261115900001_review_round4.sql; FOR UPDATE on the row.
-- Lock order: the opt-out row, then the messages the batch erases; the first batch takes the
-- author's advisory lock before the row, and neither function takes it.
-- Bodies otherwise, volatility, owners and grants as 20261115900001_review_round4.sql.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.bridge_privacy_erase_tail(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text,
    p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.bridge_remote_optouts;
BEGIN
    PERFORM public.bridge_privacy_check_subject(p_platform, p_remote_user_id);
    IF p_server_id IS NULL OR p_remote_user_id IS NULL THEN
        RAISE EXCEPTION 'invalid_remote_user' USING ERRCODE = '22023';
    END IF;
    -- The batches after the first, while the asker's decision stands: an opt-in or a restore
    -- meanwhile ends the erase, and is not undone. The row stays locked through the batch, so an
    -- opt-in or a restore waits for a batch already running.
    SELECT o.* INTO v_row FROM public.bridge_remote_optouts o
     WHERE o.server_id = p_server_id AND o.platform = p_platform AND o.remote_user_id = p_remote_user_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('opted_out', false, 'erased', 0, 'more', false);
    END IF;
    IF NOT public.bridge_privacy_erase_stands(v_row) THEN
        UPDATE public.bridge_remote_optouts o
           SET erase_pending = NULL
         WHERE o.server_id = p_server_id AND o.platform = p_platform
           AND o.remote_user_id = p_remote_user_id AND o.erase_pending IS NOT NULL;
        RETURN jsonb_build_object('opted_out', true, 'erased', 0, 'more', false);
    END IF;
    RETURN jsonb_build_object('opted_out', true)
           || public.bridge_privacy_mark_pending(p_server_id, p_platform, p_remote_user_id, v_row.erase_pending,
                  public.bridge_privacy_erase_core(p_server_id, p_platform, p_remote_user_id, p_limit));
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_privacy_erase_continue(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT (public.is_current_user_admin() OR public.can_manage_discord_bridge(p_server_id)) THEN
        RAISE EXCEPTION 'Only a manager of the server can remove a bridged user' USING ERRCODE = '42501';
    END IF;
    PERFORM public.bridge_privacy_check_subject(p_platform, p_remote_user_id);
    IF p_remote_user_id IS NULL THEN
        RAISE EXCEPTION 'invalid_remote_user' USING ERRCODE = '22023';
    END IF;
    -- The batches after a removal's first, while the removal stands: a restore ends them, and a
    -- user who only opted out is not erased from here. The row stays locked through the batch, so
    -- a restore waits for a batch already running.
    PERFORM 1 FROM public.bridge_remote_optouts o
     WHERE o.server_id = p_server_id AND o.platform = p_platform
       AND o.remote_user_id = p_remote_user_id AND o.source IN ('manager', 'admin')
       FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('erased', 0, 'more', false);
    END IF;
    RETURN public.bridge_privacy_mark_pending(p_server_id, p_platform, p_remote_user_id, 'manager',
               public.bridge_privacy_erase_core(p_server_id, p_platform, p_remote_user_id, 200));
END;
$$;

COMMIT;
