-- Drops two INSERT policies whose WITH CHECK is `true` with no TO clause, and revokes the
-- write grants behind them.
--
-- The image's schema-wide default privileges give anon and authenticated arwdDxt on every
-- table in public, so the policy was the whole gate.
--
-- federated_voice_calls: a row is an authorization input, not a log - LiveKitService admits
-- a remote actor to a LiveKit room when a row matches its room_name and caller_federated_id.
-- Verified forgeable on a fresh init build by a caller party to no conversation. Every
-- legitimate writer is federation-backend on the service role, which bypasses both RLS and
-- grants. The REVOKE is what closes UPDATE and DELETE; the SELECT grant stays.
--
-- encryption_audit_log: production only. init/ declares
-- encryption_audit_log_insert_system with WITH CHECK (user_id = get_current_profile_id()),
-- and permissive policies for one command are OR'd, so the open one decided and audit rows
-- were forgeable against any user_id. Grants are left alone here.
--
-- 20260818000005 recreates the federated_voice_calls policy while reproducing production's
-- shape and runs first; this file leaves it dropped.

BEGIN;

DROP POLICY IF EXISTS "System can insert calls" ON public.federated_voice_calls;

REVOKE ALL ON public.federated_voice_calls FROM anon;
REVOKE ALL ON public.federated_voice_calls FROM authenticated;
GRANT SELECT ON public.federated_voice_calls TO authenticated;

DROP POLICY IF EXISTS "System can insert audit logs" ON public.encryption_audit_log;

COMMIT;

NOTIFY pgrst, 'reload schema';
