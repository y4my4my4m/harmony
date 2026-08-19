-- Two INSERT policies with WITH CHECK `true` and no TO clause. The image grants anon and
-- authenticated arwdDxt on every table in public, so the policy was the whole gate.
--
-- A federated_voice_calls row is an authorization input: a remote actor is admitted to a
-- LiveKit room when a row matches its room_name and caller_federated_id. Legitimate writes
-- come from the service role, which bypasses RLS and grants. The REVOKE closes UPDATE and
-- DELETE; SELECT stays.
--
-- encryption_audit_log is production-only. init/ constrains the insert to
-- user_id = get_current_profile_id(), and permissive policies are OR'd, so the open one
-- decided and audit rows were forgeable against any user_id.

BEGIN;

DROP POLICY IF EXISTS "System can insert calls" ON public.federated_voice_calls;

REVOKE ALL ON public.federated_voice_calls FROM anon;
REVOKE ALL ON public.federated_voice_calls FROM authenticated;
GRANT SELECT ON public.federated_voice_calls TO authenticated;

DROP POLICY IF EXISTS "System can insert audit logs" ON public.encryption_audit_log;

COMMIT;

NOTIFY pgrst, 'reload schema';
