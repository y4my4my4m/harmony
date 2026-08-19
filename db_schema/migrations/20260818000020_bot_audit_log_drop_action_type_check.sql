-- Production carries a 12-value allowlist on bot_audit_log.action_type. bot-gateway
-- writes five values it does not name:
--   category_created  BotRestAPI.ts:765
--   role_created      BotRestAPI.ts:994
--   role_updated      BotRestAPI.ts:1060
--   role_deleted      BotRestAPI.ts:1098
--   emoji_created     BotRestAPI.ts:1623
-- Each insert fails 23514 on production and nowhere else; init/ declares action_type as
-- plain text. The audit row is lost, not the request that produced it.
--
-- Dropped rather than widened. init/ is canonical and has no such constraint, and an
-- allowlist over action names needs a migration per new action.
--
-- Dropping a CHECK cannot fail on existing rows.

BEGIN;

ALTER TABLE public.bot_audit_log
    DROP CONSTRAINT IF EXISTS bot_audit_log_action_type_check;

COMMIT;

NOTIFY pgrst, 'reload schema';
