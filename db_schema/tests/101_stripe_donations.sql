-- 20261009800001_stripe_donations.sql: the Stripe signing secret is reachable only through
-- the admin RPCs and the webhook's service_role; the customer map is service_role only.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(11);

SELECT ok(NOT has_column_privilege('authenticated', 'public.instance_funding', 'stripe_webhook_secret', 'SELECT')
          AND NOT has_column_privilege('authenticated', 'public.instance_funding', 'stripe_webhook_secret', 'UPDATE')
          AND NOT has_column_privilege('authenticated', 'public.instance_funding', 'stripe_webhook_secret', 'INSERT'),
  'clients hold no privilege on the Stripe signing secret');
SELECT ok(has_column_privilege('authenticated', 'public.instance_funding', 'stripe_auto_assign_tier', 'SELECT')
          AND has_column_privilege('authenticated', 'public.instance_funding', 'stripe_auto_assign_tier', 'UPDATE')
          AND has_column_privilege('service_role', 'public.instance_funding', 'stripe_webhook_secret', 'SELECT'),
  'admins write the auto-assign flag and the webhook reads the secret');

SELECT ok(NOT has_table_privilege('authenticated', 'public.instance_stripe_customers', 'SELECT')
          AND NOT has_table_privilege('anon', 'public.instance_stripe_customers', 'SELECT')
          AND has_table_privilege('service_role', 'public.instance_stripe_customers', 'SELECT, INSERT, UPDATE')
          AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.instance_stripe_customers'::regclass),
  'the customer map is service_role only, under RLS');
SELECT ok(NOT has_function_privilege('anon', 'public.get_stripe_webhook_secret()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.set_stripe_webhook_secret(text)', 'EXECUTE'),
  'anon cannot execute the secret RPCs');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.set_stripe_webhook_secret('  whsec_test101  ')$q$, 'an admin sets the secret');
SELECT is(public.get_stripe_webhook_secret(), 'whsec_test101', 'an admin reads the trimmed secret');
SELECT throws_ok($q$SELECT public.set_stripe_webhook_secret('sk_live_x')$q$, '22023', NULL,
  'a value that is not a signing secret is refused');
SELECT lives_ok($q$SELECT public.set_stripe_webhook_secret('')$q$, 'an empty secret disables the webhook');
SELECT is(public.get_stripe_webhook_secret(), NULL, 'the disabled secret reads as NULL');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.get_stripe_webhook_secret()$q$, '42501', NULL,
  'a non-admin cannot read the secret');
SELECT throws_ok($q$SELECT public.set_stripe_webhook_secret('whsec_x')$q$, '42501', NULL,
  'a non-admin cannot set the secret');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
