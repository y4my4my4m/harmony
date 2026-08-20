-- Production has a 12-value allowlist on bot_audit_log.action_type; init/ declares the
-- column plain text. bot-gateway writes five values the allowlist omits, and those
-- inserts fail 23514 on production only.
--
-- Dropped rather than widened: an allowlist over action names costs a migration per new
-- action.

BEGIN;

ALTER TABLE public.bot_audit_log
    DROP CONSTRAINT IF EXISTS bot_audit_log_action_type_check;

COMMIT;

NOTIFY pgrst, 'reload schema';
