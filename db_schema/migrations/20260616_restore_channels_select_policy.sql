-- ---------------------------------------------------------------------------
-- Recovery: restore the canonical read-path SELECT policies.
--
-- 20260616_consolidate_duplicate_policies_batch3.sql dropped channels_*_policy
-- on the assumption the canonical get_current_profile_id() twins (e.g.
-- channels_select_member) already existed. On a dev DB that only had the legacy
-- channels_select_policy (prod/local policy drift), that drop left public.channels
-- with NO SELECT policy, so RLS denied all reads: empty channel list, and the
-- selected channel could not resolve so messages did not load either.
--
-- This re-asserts the canonical SELECT policies verbatim from db_schema/init
-- (30_rls_policies.sql). Idempotent (DROP IF EXISTS + CREATE) and safe to run
-- even where the policies already exist; effective access matches init exactly.
-- ---------------------------------------------------------------------------

BEGIN;

-- channels: members of the server (or the owner) can read its channels.
DROP POLICY IF EXISTS "channels_select_member" ON public.channels;
CREATE POLICY "channels_select_member" ON public.channels
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.user_servers us
            JOIN public.servers s ON s.id = us.server_id
            WHERE us.server_id = channels.server_id
            AND (us.user_id = public.get_current_profile_id() OR s.owner = public.get_current_profile_id())
            AND us.status = 'accepted'
        )
        OR EXISTS (
            SELECT 1 FROM public.servers
            WHERE id = channels.server_id
            AND owner = public.get_current_profile_id()
        )
    );

-- messages: channel members (and DM participants) can read.
DROP POLICY IF EXISTS "messages_select_channel_member" ON public.messages;
CREATE POLICY "messages_select_channel_member" ON public.messages
    FOR SELECT USING (
        (channel_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.channels c
            JOIN public.user_servers us ON us.server_id = c.server_id
            WHERE c.id = messages.channel_id
            AND us.user_id = public.get_current_profile_id()
            AND us.status = 'accepted'
        ))
        OR
        (conversation_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.conversation_participants cp
            WHERE cp.conversation_id = messages.conversation_id
            AND cp.user_id = public.get_current_profile_id()
            AND cp.left_at IS NULL
        ))
    );

COMMIT;
