-- 20261025100003_auth_triggers_converge.sql: GoTrue's tables carry the security-notice triggers
-- after the chain.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(4);

SELECT has_trigger('auth', 'sessions', 'harmony_session_created', 'a new sign-in raises a notice');
SELECT has_trigger('auth', 'sessions', 'harmony_session_deleted', 'a removed session is seen');
SELECT has_trigger('auth', 'mfa_factors', 'harmony_mfa_factor_verified', 'a verified second factor raises a notice');
SELECT has_trigger('auth', 'mfa_factors', 'harmony_mfa_factor_deleted', 'a removed second factor raises a notice');

SELECT * FROM finish();
ROLLBACK;
