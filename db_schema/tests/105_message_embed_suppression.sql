-- 20261010200001_message_embed_suppression.sql: the author, or MANAGE_MESSAGES in a server
-- channel, hides a message's embeds; the flag is reserved for the RPC.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(9);

-- alice owns the server and wrote 8888 (channel) and 9999 (DM with bob); bob writes f105...b1.
INSERT INTO public.messages (id, channel_id, user_id, content)
VALUES ('f1050000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006',
        '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"https://example.com"}]'::jsonb);
CREATE TEMP TABLE before (updated_at timestamptz);
INSERT INTO before SELECT updated_at FROM public.messages WHERE id = '88888888-0000-0000-0000-000000000008';

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.set_message_embeds_suppressed('88888888-0000-0000-0000-000000000008', true)$q$,
                 '42501', NULL, 'a member without MANAGE_MESSAGES cannot hide another member''s embeds');
SELECT throws_ok($q$SELECT public.set_message_embeds_suppressed('99999999-0000-0000-0000-000000000009', true)$q$,
                 '42501', NULL, 'in a DM only the author hides embeds');
SELECT throws_ok($q$UPDATE public.messages SET metadata = '{"suppress_embeds": true}'::jsonb
                    WHERE id = 'f1050000-0000-0000-0000-0000000000b1'$q$,
                 '42501', NULL, 'suppress_embeds is reserved for the RPC');
SELECT is(public.set_message_embeds_suppressed('f1050000-0000-0000-0000-0000000000b1', true), true,
          'the author hides their own embeds');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.set_message_embeds_suppressed('88888888-0000-0000-0000-000000000008', true)$q$,
                'the author hides embeds on a channel message');
SELECT lives_ok($q$SELECT public.set_message_embeds_suppressed('f1050000-0000-0000-0000-0000000000b1', false)$q$,
                'the owner (MANAGE_MESSAGES) restores another member''s embeds');
SELECT tests.clear_authentication();

SELECT results_eq(
    $q$SELECT id::text, metadata ? 'suppress_embeds' FROM public.messages
        WHERE id IN ('88888888-0000-0000-0000-000000000008', 'f1050000-0000-0000-0000-0000000000b1') ORDER BY id$q$,
    $q$VALUES ('88888888-0000-0000-0000-000000000008', true), ('f1050000-0000-0000-0000-0000000000b1', false)$q$,
    'the flag is set on one message and cleared on the other');
SELECT is((SELECT updated_at FROM public.messages WHERE id = '88888888-0000-0000-0000-000000000008'),
          (SELECT updated_at FROM before), 'hiding embeds does not mark the message edited');
SELECT ok(NOT has_function_privilege('anon', 'public.set_message_embeds_suppressed(uuid, boolean)', 'EXECUTE'),
          'anon cannot call set_message_embeds_suppressed');

SELECT * FROM finish();
ROLLBACK;
