-- 20261106100001_supporter_messages.sql: supporter message validation, the 24-hour attach to a
-- donation, admin review, who sees what, and the funding summary.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(56);

-- Fixture: alice is an instance admin, bob is not; funding on with messages on and public.
UPDATE public.profiles SET is_admin = (id = '11111111-0000-0000-0000-000000000001')
 WHERE id IN ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002');
DELETE FROM public.instance_funding;
INSERT INTO public.instance_funding (enabled, goal_amount, goal_currency, funding_period)
VALUES (true, 100, 'USD', 'monthly');
INSERT INTO public.instance_supporters (user_id, is_active)
VALUES ('22222222-0000-0000-0000-000000000002', true),
       ('33333333-0000-0000-0000-000000000003', true);
UPDATE public.instance_supporters SET expires_at = now() - interval '1 day'
 WHERE user_id = '33333333-0000-0000-0000-000000000003';

-- Privileges
SELECT ok(NOT has_table_privilege('authenticated', 'public.instance_supporter_messages', 'SELECT')
          AND NOT has_table_privilege('authenticated', 'public.instance_supporter_messages', 'INSERT')
          AND NOT has_table_privilege('authenticated', 'public.instance_supporter_messages', 'UPDATE')
          AND NOT has_table_privilege('anon', 'public.instance_supporter_messages', 'SELECT')
          AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.instance_supporter_messages'::regclass),
  'clients hold no table privilege on supporter messages, which are under RLS');
SELECT ok(has_function_privilege('anon', 'public.get_public_supporter_messages(integer)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.get_funding_summary()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.set_supporter_message(text, boolean)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.admin_review_supporter_message(uuid, text)', 'EXECUTE'),
  'anon executes the public message list and nothing else of the feature');
SELECT ok(has_column_privilege('authenticated', 'public.instance_funding', 'supporter_messages_public', 'UPDATE')
          AND has_column_privilege('authenticated', 'public.instance_funding', 'supporter_messages_enabled', 'SELECT'),
  'admins write the message switches through the column grants');

-- Validation rules
SELECT is(public.supporter_message_problem(''), 'empty', 'an empty message is refused');
SELECT is(public.supporter_message_problem(repeat('a', 51)), 'length', '51 code points are refused');
SELECT is(public.supporter_message_problem(repeat('a', 50)), NULL, '50 code points are accepted');
SELECT is(public.supporter_message_problem(repeat('é', 50)), NULL, 'a code point counts once, whatever its byte length');
SELECT is(public.supporter_message_problem('e' || U&'\0301'), 'normalization', 'a decomposed (not NFC) message is refused');
SELECT is(public.supporter_message_problem(' hi'), 'whitespace', 'a leading space is refused');
SELECT is(public.supporter_message_problem('two' || chr(10) || 'lines'), 'control', 'a newline is refused');
SELECT is(public.supporter_message_problem('tab' || chr(9) || 'bed'), 'control', 'a tab is refused');
SELECT is(public.supporter_message_problem('nel' || U&'\0085'), 'control', 'a C1 control (NEL) is refused');
SELECT is(public.supporter_message_problem('line' || U&'\2028' || 'sep'), 'control', 'a line separator is refused');
SELECT is(public.supporter_message_problem(U&'\202Egnp.exe'), 'bidi', 'a right-to-left override is refused');
SELECT is(public.supporter_message_problem(U&'a\2066b\2069'), 'bidi', 'a bidi isolate is refused');
SELECT is(public.supporter_message_problem(U&'a\200Fb'), 'bidi', 'a right-to-left mark is refused');
SELECT is(public.supporter_message_problem(U&'a\061Cb'), 'bidi', 'an Arabic letter mark is refused');
SELECT is(public.supporter_message_problem(normalize(U&'Z\0351\0353\036B', NFC)), 'marks', 'three combining marks on one base are refused');
SELECT is(public.supporter_message_problem(U&'a\0331\0332 b'), NULL, 'two combining marks on one base are accepted');
SELECT is(public.supporter_message_problem('<img src=x onerror=alert(1)>'), NULL,
  'markup is text: accepted as written, never interpreted');
SELECT throws_ok($q$INSERT INTO public.instance_supporter_messages (user_id, body)
                   VALUES ('11111111-0000-0000-0000-000000000001', U&'\202Eabc')$q$,
  '23514', NULL, 'the table CHECK refuses an invalid body written past the RPC');

-- Writing as a donor
SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.set_supporter_message('hello', false)$q$, '42501', NULL,
  'a signed-out caller cannot write a message');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.set_supporter_message(repeat('x', 51), false)$q$, '22023', NULL,
  'the RPC refuses 51 code points');
SELECT throws_ok($q$SELECT public.set_supporter_message(U&'evil\202Etxt', false)$q$, '22023', NULL,
  'the RPC refuses a bidi override');
SELECT throws_ok($q$SELECT public.set_supporter_message(U&'Z\0351\0353\036B\0354', false)$q$, '22023', NULL,
  'the RPC refuses a Zalgo run');
SELECT is((public.set_supporter_message('  caf' || 'e' || U&'\0301' || '  ', false))->>'body', 'café',
  'the RPC trims and NFC-normalizes');
SELECT is((public.set_supporter_message('Thanks for Harmony!', false))->>'body', 'Thanks for Harmony!',
  'a second write replaces the unattached message');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.instance_supporter_messages
            WHERE user_id = '22222222-0000-0000-0000-000000000002'), 1,
  'one unattached message per profile');

-- Attaching
INSERT INTO public.instance_donation_history (supporter_id, user_id, amount, currency, platform, external_reference)
SELECT s.id, s.user_id, 5, 'USD', 'stripe', 'pi_231_a'
  FROM public.instance_supporters s WHERE s.user_id = '22222222-0000-0000-0000-000000000002';
SELECT is((SELECT d.external_reference FROM public.instance_supporter_messages m
             JOIN public.instance_donation_history d ON d.id = m.donation_id
            WHERE m.user_id = '22222222-0000-0000-0000-000000000002'), 'pi_231_a',
  'the next donation attaches the message');
SELECT is((SELECT review FROM public.instance_supporter_messages
            WHERE user_id = '22222222-0000-0000-0000-000000000002'), 'pending',
  'an attached message waits for review');
INSERT INTO public.instance_donation_history (supporter_id, user_id, amount, currency, platform, external_reference)
SELECT s.id, s.user_id, 5, 'USD', 'stripe', 'pi_231_b'
  FROM public.instance_supporters s WHERE s.user_id = '22222222-0000-0000-0000-000000000002';
SELECT is((SELECT count(*)::int FROM public.instance_supporter_messages
            WHERE user_id = '22222222-0000-0000-0000-000000000002'), 1,
  'a donation without a written message attaches nothing: one message per donation');

-- A message older than 24 hours stays unattached.
INSERT INTO public.instance_supporter_messages (user_id, body, anonymous, created_at)
VALUES ('33333333-0000-0000-0000-000000000003', 'too late', true, now() - interval '25 hours');
INSERT INTO public.instance_donation_history (supporter_id, user_id, amount, currency, platform, external_reference)
SELECT s.id, s.user_id, 1, 'USD', 'stripe', 'pi_231_c'
  FROM public.instance_supporters s WHERE s.user_id = '33333333-0000-0000-0000-000000000003';
SELECT ok((SELECT donation_id IS NULL FROM public.instance_supporter_messages
            WHERE user_id = '33333333-0000-0000-0000-000000000003'),
  'a message written more than 24 hours before the donation is not attached');
UPDATE public.instance_supporter_messages SET created_at = now()
 WHERE user_id = '33333333-0000-0000-0000-000000000003';
INSERT INTO public.instance_donation_history (supporter_id, user_id, amount, currency, platform, external_reference)
SELECT s.id, s.user_id, 1, 'USD', 'stripe', 'pi_231_d'
  FROM public.instance_supporters s WHERE s.user_id = '33333333-0000-0000-0000-000000000003';

SELECT set_config('tests.bob_msg', (SELECT id::text FROM public.instance_supporter_messages
                                     WHERE user_id = '22222222-0000-0000-0000-000000000002'), true);
SELECT set_config('tests.mallory_msg', (SELECT id::text FROM public.instance_supporter_messages
                                         WHERE user_id = '33333333-0000-0000-0000-000000000003'), true);

-- Who sees what before review
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(jsonb_array_length(public.get_funding_summary()->'messages'), 0,
  'an unreviewed message is not shown to other members');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((public.get_funding_summary()->'me'->'messages'->0->>'review'), 'pending',
  'its author sees it, awaiting review');
SELECT tests.authenticate_as_anon();
SELECT is(jsonb_array_length(public.get_public_supporter_messages(6)), 0, 'signed out sees nothing unreviewed');

-- Review
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(format($q$SELECT public.admin_review_supporter_message(%L, 'approved')$q$,
                        current_setting('tests.bob_msg')),
  '42501', NULL, 'a non-admin cannot approve');
SELECT throws_ok($q$SELECT public.admin_list_supporter_messages()$q$, '42501', NULL,
  'a non-admin cannot list the review queue');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(jsonb_array_length(public.admin_list_supporter_messages()), 2, 'the admin queue lists both attached messages');
SELECT lives_ok(format($q$SELECT public.admin_review_supporter_message(%L, 'approved')$q$,
                       current_setting('tests.bob_msg')),
  'an admin approves a message');
SELECT lives_ok(format($q$SELECT public.admin_review_supporter_message(%L, 'approved')$q$,
                       current_setting('tests.mallory_msg')),
  'an admin approves the anonymous message');
SELECT throws_ok($q$SELECT public.admin_review_supporter_message(gen_random_uuid(), 'approved')$q$,
  'P0002', NULL, 'only attached messages are reviewed');
SELECT throws_ok(format($q$SELECT public.admin_review_supporter_message(%L, 'shown')$q$,
                        current_setting('tests.bob_msg')),
  '22023', NULL, 'a review is approved or hidden');
SELECT is((SELECT array_agg(x->>'body' ORDER BY x->>'body') FROM jsonb_array_elements(public.get_funding_summary()->'messages') x),
  ARRAY['Thanks for Harmony!', 'too late'], 'approved messages show to every member');
SELECT is((SELECT x - 'at' - 'id' FROM jsonb_array_elements(public.get_funding_summary()->'messages') x WHERE x->>'body' = 'too late'),
  '{"body": "too late", "name": null, "user_id": null, "anonymous": true, "avatar_url": null}'::jsonb,
  'an anonymous message carries no name, avatar or profile id');

SELECT tests.authenticate_as_anon();
SELECT is((SELECT array_agg(x->>'name' ORDER BY x->>'body') FROM jsonb_array_elements(public.get_public_supporter_messages(6)) x),
  ARRAY['Bob', NULL], 'signed out sees approved messages, named or anonymous');
SELECT ok(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.get_public_supporter_messages(6)) x
                       WHERE x ? 'user_id' OR x ? 'avatar_url' OR x::text LIKE '%33333333%'),
  'the public list holds no profile id');

SELECT tests.clear_authentication();
UPDATE public.instance_funding SET supporter_messages_public = false;
SELECT tests.authenticate_as_anon();
SELECT is(jsonb_array_length(public.get_public_supporter_messages(6)), 0,
  'public display off: signed out sees none');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(jsonb_array_length(public.get_funding_summary()->'messages'), 2,
  'public display off: members still see approved messages');

SELECT lives_ok(format($q$SELECT public.admin_review_supporter_message(%L, 'hidden')$q$,
                       current_setting('tests.bob_msg')),
  'an admin hides a message');
SELECT is(jsonb_array_length(public.get_funding_summary()->'messages'), 1, 'a hidden message leaves the list');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((public.get_funding_summary()->'me'->'messages'->0->>'review'), 'hidden', 'its author sees it hidden');
SELECT is(public.delete_supporter_message(current_setting('tests.mallory_msg')::uuid), false,
  'a donor cannot delete another donor''s message');

-- Summary
SELECT is((public.get_funding_summary()->>'period_end')::timestamptz,
          (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC',
  'a monthly period ends at the next UTC month start');
SELECT is((public.get_funding_summary()->>'supporter_count')::int, 1,
  'the supporter count leaves out a supporter whose time ran out');
SELECT is((public.get_funding_summary()->>'displayed_amount')::numeric, 12::numeric,
  'the period total sums this month''s donations');

SELECT tests.clear_authentication();
UPDATE public.instance_funding SET supporter_messages_enabled = false;
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.set_supporter_message('hello again', false)$q$, '55000', NULL,
  'messages off: the RPC refuses new messages');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
