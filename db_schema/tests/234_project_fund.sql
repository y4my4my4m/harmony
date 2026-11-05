-- 20261106400001_project_fund.sql: the fund of donations, pending donations and supporter
-- messages, project_funding and its privileges, messages attaching within their fund, the
-- instance's summary, tier and totals counting the instance's fund, and the project's summary.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(52);

-- Fixture: alice is an instance admin, bob and mallory are not. Instance funding on with
-- messages; bob holds an instance supporter row; one tier from 10.
UPDATE public.profiles SET is_admin = (id = '11111111-0000-0000-0000-000000000001')
 WHERE id IN ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002',
              '33333333-0000-0000-0000-000000000003');
DELETE FROM public.instance_funding;
DELETE FROM public.project_funding;
INSERT INTO public.instance_funding (enabled, goal_amount, goal_currency, funding_period)
VALUES (true, 100, 'USD', 'all');
INSERT INTO public.instance_supporter_tiers (name, min_amount) VALUES ('Gold 234', 10);
INSERT INTO public.instance_supporters (user_id, is_active)
VALUES ('22222222-0000-0000-0000-000000000002', true);

-- Columns and constraints
SELECT col_default_is('public', 'instance_donation_history', 'fund', 'instance'::text,
  'a donation is the instance''s unless it says otherwise');
SELECT col_default_is('public', 'instance_pending_donations', 'fund', 'instance'::text,
  'a pending donation is the instance''s unless it says otherwise');
SELECT col_default_is('public', 'instance_supporter_messages', 'fund', 'instance'::text,
  'a supporter message is the instance''s unless it says otherwise');
SELECT ok(NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'public' AND column_name = 'fund' AND is_nullable = 'YES'
                         AND table_name IN ('instance_donation_history', 'instance_pending_donations',
                                            'instance_supporter_messages')),
  'fund is never null');
INSERT INTO public.instance_donation_history (supporter_id, user_id, amount, currency, platform, external_reference)
SELECT s.id, s.user_id, 4, 'USD', 'stripe', 'pi_234_inst_a'
  FROM public.instance_supporters s WHERE s.user_id = '22222222-0000-0000-0000-000000000002';
SELECT is((SELECT fund FROM public.instance_donation_history WHERE external_reference = 'pi_234_inst_a'),
  'instance', 'a donation written as before 1.9.3 is the instance''s');
SELECT throws_ok($q$INSERT INTO public.instance_donation_history (user_id, amount, platform, fund)
                   VALUES ('22222222-0000-0000-0000-000000000002', 1, 'stripe', 'elsewhere')$q$,
  '23514', NULL, 'an unknown fund is refused');
SELECT throws_ok($q$INSERT INTO public.instance_donation_history (user_id, amount, platform, fund)
                   VALUES ('22222222-0000-0000-0000-000000000002', 1, 'stripe', 'instance')$q$,
  '23514', NULL, 'an instance donation has a supporter row');
SELECT throws_ok($q$INSERT INTO public.instance_donation_history (supporter_id, user_id, amount, platform, fund)
                   SELECT s.id, s.user_id, 1, 'stripe', 'project' FROM public.instance_supporters s
                    WHERE s.user_id = '22222222-0000-0000-0000-000000000002'$q$,
  '23514', NULL, 'a project donation has no supporter row');

-- project_funding privileges
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.project_funding'::regclass),
  'project_funding is under RLS');
SELECT ok(NOT has_table_privilege('anon', 'public.project_funding', 'SELECT')
          AND NOT has_any_column_privilege('anon', 'public.project_funding', 'SELECT'),
  'anon holds no privilege on project_funding');
SELECT ok(has_column_privilege('authenticated', 'public.project_funding', 'goal_amount', 'SELECT')
          AND has_column_privilege('authenticated', 'public.project_funding', 'stripe_payment_links', 'UPDATE')
          AND has_column_privilege('authenticated', 'public.project_funding', 'id', 'UPDATE')
          AND NOT has_column_privilege('authenticated', 'public.project_funding', 'kofi_webhook_token', 'SELECT')
          AND NOT has_column_privilege('authenticated', 'public.project_funding', 'kofi_webhook_token', 'UPDATE'),
  'signed-in clients read and write the settings and nothing of the Ko-fi token');
SELECT ok(has_table_privilege('service_role', 'public.project_funding', 'SELECT'),
  'the federation backend reads project_funding as service_role');
SELECT ok(has_function_privilege('service_role', 'public.get_project_funding_summary()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.get_project_funding_summary()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.get_project_funding_summary()', 'EXECUTE'),
  'only the federation backend reads the project summary');
SELECT ok(has_function_privilege('authenticated', 'public.set_supporter_message(text, boolean, text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.set_supporter_message(text, boolean, text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.get_project_kofi_webhook_token()', 'EXECUTE'),
  'anon writes no message to either fund and reads no token');
SELECT is(public.get_project_funding_summary(), NULL::jsonb, 'without a project_funding row there is no project summary');

-- project_funding writes
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$INSERT INTO public.project_funding (id, enabled) VALUES (true, true)$q$,
  '42501', NULL, 'a member cannot create the project fund');
SELECT throws_ok($q$SELECT public.set_project_kofi_webhook_token('kofi-234')$q$,
  '42501', NULL, 'a member cannot set the project''s Ko-fi token');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$INSERT INTO public.project_funding (id, enabled, goal_amount, funding_period, funding_links,
                                                       stripe_payment_links)
                   VALUES (true, true, 500, 'all',
                           '[{"platform": "stripe", "url": "https://donate.stripe.com/p234", "label": "One-time"}]',
                           ARRAY['plink_234once', 'plink_234monthly'])
                   ON CONFLICT (id) DO UPDATE
                      SET id = EXCLUDED.id, enabled = EXCLUDED.enabled, goal_amount = EXCLUDED.goal_amount,
                          funding_period = EXCLUDED.funding_period, funding_links = EXCLUDED.funding_links,
                          stripe_payment_links = EXCLUDED.stripe_payment_links$q$,
  'an instance admin creates the project fund with an upsert as PostgREST writes it');
SELECT throws_ok($q$INSERT INTO public.project_funding (id) VALUES (false)$q$,
  '23514', NULL, 'there is one project_funding row');
SELECT throws_ok($q$UPDATE public.project_funding SET stripe_payment_links = ARRAY['https://buy.stripe.com/x']$q$,
  '23514', NULL, 'a payment link entry is a plink_ id');
SELECT lives_ok($q$SELECT public.set_project_kofi_webhook_token('  kofi-234  ')$q$,
  'an instance admin sets the project''s Ko-fi token');
SELECT is(public.get_project_kofi_webhook_token(), 'kofi-234', 'the token reads back trimmed');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT array_length(stripe_payment_links, 1) FROM public.project_funding), 2,
  'a member reads the project fund''s settings');
UPDATE public.project_funding SET goal_amount = 1;
SELECT tests.clear_authentication();
SELECT is((SELECT goal_amount FROM public.project_funding), 500::numeric(10,2),
  'a member''s update changes nothing');

-- Messages per fund
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.set_supporter_message('hi', false, 'elsewhere')$q$,
  '22023', NULL, 'a message names a known fund');
SELECT is((public.set_supporter_message('For the server', false))->>'fund', 'instance',
  'the two-argument form writes the instance''s message');
SELECT is((public.set_supporter_message('For Harmony 234', true, 'project'))->>'fund', 'project',
  'a donor writes a message for the project fund');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.instance_supporter_messages
            WHERE user_id = '22222222-0000-0000-0000-000000000002' AND donation_id IS NULL), 2,
  'one unattached message per fund');
UPDATE public.project_funding SET supporter_messages_enabled = false;
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.set_supporter_message('closed', false, 'project')$q$,
  '55000', NULL, 'the project fund''s messages off refuse a project message');
SELECT tests.clear_authentication();
UPDATE public.project_funding SET supporter_messages_enabled = true;

INSERT INTO public.instance_donation_history (user_id, amount, currency, platform, external_reference, fund)
VALUES ('22222222-0000-0000-0000-000000000002', 30, 'USD', 'stripe', 'pi_234_proj_a', 'project');
SELECT is((SELECT m.body FROM public.instance_supporter_messages m
             JOIN public.instance_donation_history d ON d.id = m.donation_id
            WHERE d.external_reference = 'pi_234_proj_a'), 'For Harmony 234',
  'a project donation attaches the donor''s project message');
SELECT ok((SELECT donation_id IS NULL FROM public.instance_supporter_messages
            WHERE user_id = '22222222-0000-0000-0000-000000000002' AND fund = 'instance'),
  'and leaves their instance message waiting');
INSERT INTO public.instance_donation_history (supporter_id, user_id, amount, currency, platform, external_reference)
SELECT s.id, s.user_id, 4, 'USD', 'stripe', 'pi_234_inst_b'
  FROM public.instance_supporters s WHERE s.user_id = '22222222-0000-0000-0000-000000000002';
SELECT is((SELECT d.external_reference FROM public.instance_supporter_messages m
             JOIN public.instance_donation_history d ON d.id = m.donation_id
            WHERE m.fund = 'instance' AND m.user_id = '22222222-0000-0000-0000-000000000002'), 'pi_234_inst_b',
  'an instance donation attaches the instance message');
UPDATE public.instance_supporter_messages SET review = 'approved'
 WHERE user_id = '22222222-0000-0000-0000-000000000002';

-- Tiers count the instance's fund: 8 of instance donations, 30 to the project.
SELECT is(public.recompute_supporter_tier('22222222-0000-0000-0000-000000000002'), NULL::uuid,
  'project donations do not reach an instance tier');
SELECT is((SELECT amount FROM public.instance_supporters WHERE user_id = '22222222-0000-0000-0000-000000000002'),
  8::numeric(10,2), 'the supporter''s cycle total is the instance''s donations');
SELECT is(public.get_funding_current_total('all'), 8::numeric, 'the instance''s total leaves the project''s out');

-- The instance's summary
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((public.get_funding_summary()->>'displayed_amount')::numeric, 8::numeric,
  'the instance''s progress counts the instance''s fund');
SELECT is((SELECT array_agg(x->>'body') FROM jsonb_array_elements(public.get_funding_summary()->'messages') x),
  ARRAY['For the server'], 'the instance''s wall shows the instance''s messages');
SELECT is(jsonb_array_length(public.get_funding_summary()->'me'->'donations'), 2,
  'the donor''s instance donations');
SELECT is((public.get_funding_summary()->'me'->'project'->'donations'->0->>'amount')::numeric, 30::numeric,
  'the donor''s project donation is listed apart');
SELECT is((public.get_funding_summary()->'me'->'project'->'messages'->0->>'body'), 'For Harmony 234',
  'the donor''s project message is listed apart');
SELECT is((public.get_funding_summary()->>'project_messages_enabled')::boolean, true,
  'the summary says the project fund takes messages');
SELECT tests.authenticate_as_anon();
SELECT is((SELECT array_agg(x->>'body') FROM jsonb_array_elements(public.get_public_supporter_messages(6)) x),
  ARRAY['For the server'], 'the sign-in page shows the instance''s messages only');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT array_agg(x->>'fund' ORDER BY x->>'fund') FROM jsonb_array_elements(public.admin_list_supporter_messages()) x),
  ARRAY['instance', 'project'], 'the admin queue names each message''s fund');
SELECT tests.clear_authentication();

-- Pending project donations
INSERT INTO public.instance_pending_donations (id, platform, external_reference, amount, currency, donor_email, raw_payload, fund)
VALUES ('f2340000-0000-0000-0000-000000000001', 'stripe', 'pi_234_pend_a', 7, 'USD', 'Ann@Example.org', '{}', 'project'),
       ('f2340000-0000-0000-0000-000000000002', 'stripe', 'in_234_pend_b', 5, 'USD', 'ann@example.org ', '{}', 'project'),
       ('f2340000-0000-0000-0000-000000000003', 'stripe', 'pi_234_pend_c', 11, 'USD', NULL, '{}', 'project'),
       ('f2340000-0000-0000-0000-000000000004', 'stripe', 'pi_234_pend_i', 50, 'USD', 'x@example.org', '{}', 'instance');
SELECT is((SELECT data->>'fund' FROM public.notifications
            WHERE type = 'admin_pending_donation'
              AND data->>'pending_donation_id' = 'f2340000-0000-0000-0000-000000000001' LIMIT 1),
  'project', 'the admins'' notification names the fund');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT isnt(public.admin_resolve_pending_donation('f2340000-0000-0000-0000-000000000003',
                                                  '33333333-0000-0000-0000-000000000003'),
            NULL, 'an admin attributes a project donation');
UPDATE public.instance_pending_donations SET resolved_at = now()
 WHERE id = 'f2340000-0000-0000-0000-000000000002';
SELECT tests.clear_authentication();
SELECT is((SELECT row(fund, supporter_id IS NULL, amount)::text FROM public.instance_donation_history
            WHERE external_reference = 'pi_234_proj_a' OR external_reference = 'pi_234_pend_c'
            ORDER BY amount LIMIT 1),
  '(project,t,11.00)', 'the attributed project donation is the project''s, with no supporter row');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.instance_supporters
                       WHERE user_id = '33333333-0000-0000-0000-000000000003'),
  'attributing a project donation makes nobody an instance supporter');

-- The project's summary: 30 + 11 attributed, 7 + 5 unattributed (one dismissed), the instance's
-- 50 left out; donors bob, mallory, ann@example.org.
SELECT is((public.get_project_funding_summary()->>'displayed_amount')::numeric, 53::numeric,
  'the project''s total counts its attributed and unattributed donations once each');
SELECT is((public.get_project_funding_summary()->>'supporter_count')::int, 3,
  'the project''s supporters are its distinct donors');
SELECT is((SELECT array_agg(x->>'body') FROM jsonb_array_elements(public.get_project_funding_summary()->'messages') x),
  ARRAY['For Harmony 234'], 'the project''s wall shows the project''s approved messages');
SELECT is((public.get_project_funding_summary()->'messages'->0->>'name'), NULL,
  'an anonymous project message has no name');
UPDATE public.project_funding SET supporter_messages_enabled = false;
SELECT is(jsonb_array_length(public.get_project_funding_summary()->'messages'), 0,
  'with the project''s messages off its summary carries none');

SELECT * FROM finish();
ROLLBACK;
