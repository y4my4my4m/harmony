-- 20261123100001_bridge_mirror_claims.sql: a mirror outcome applies only to the claim that
-- produced it. A message queued again while the worker downloads keeps its row.
--
--   bot b1  bridge bot of server_1 (in discord_bridges)
--   a001, a002  messages of b1 with a Discord CDN link
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(20);

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('30900000-0000-0000-0000-0000000000b1', 'bridge-309', 'Bridge 309', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.discord_bridges (server_id, bot_id, mode, discord_guild_id, created_by)
VALUES ('55555555-0000-0000-0000-000000000005', '30900000-0000-0000-0000-0000000000b1', 'instance',
        '900000000000000309', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.messages (id, channel_id, bot_id, user_id, content) VALUES
  ('30900000-0000-0000-0000-00000000a001', '66666666-0000-0000-0000-000000000006', '30900000-0000-0000-0000-0000000000b1', NULL,
   '[{"type": "file", "url": "https://cdn.discordapp.com/attachments/1/2/a.png"}]'),
  ('30900000-0000-0000-0000-00000000a002', '66666666-0000-0000-0000-000000000006', '30900000-0000-0000-0000-0000000000b1', NULL,
   '[{"type": "file", "url": "https://cdn.discordapp.com/attachments/1/2/b.png"}]');

-- Access ------------------------------------------------------------------------------------------
SELECT ok(has_function_privilege('service_role', 'public.bridge_mirror_finish(uuid, text, integer, integer, bigint, text, uuid)', 'EXECUTE'),
          'service_role can finish with a claim');
SELECT ok(NOT has_function_privilege('authenticated', 'public.bridge_mirror_finish(uuid, text, integer, integer, bigint, text, uuid)', 'EXECUTE'),
          'authenticated cannot finish');
SELECT ok(NOT has_function_privilege('anon', 'public.bridge_mirror_claim(integer)', 'EXECUTE'), 'anon cannot claim');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname = 'bridge_mirror_finish' AND pronamespace = 'public'::regnamespace),
          1, 'one bridge_mirror_finish: the six-argument form is gone');

-- A claim and its outcome -------------------------------------------------------------------------
CREATE TEMP TABLE claims (n int, message_id uuid, claim_id uuid);
SELECT is(public.bridge_mirror_enqueue(ARRAY['30900000-0000-0000-0000-00000000a001']::uuid[]), 1, 'a001 is queued');
INSERT INTO claims SELECT 1, c.message_id, c.claim_id FROM public.bridge_mirror_claim(60) c;
SELECT isnt((SELECT claim_id FROM claims WHERE n = 1), NULL, 'a claim returns its claim_id');
SELECT is((SELECT q.claim_id FROM public.bridge_mirror_queue q WHERE q.message_id = '30900000-0000-0000-0000-00000000a001'),
          (SELECT claim_id FROM claims WHERE n = 1), 'and stores it on the row');
SELECT public.bridge_mirror_finish('30900000-0000-0000-0000-00000000a001', 'queued', 1, 0, NULL, 'x',
                                   (SELECT claim_id FROM claims WHERE n = 1));
SELECT results_eq($$SELECT state, attempts, last_error FROM public.bridge_mirror_queue WHERE message_id = '30900000-0000-0000-0000-00000000a001'$$,
                  $$VALUES ('queued'::text, 1, 'x'::text)$$, 'the outcome of the claim the row holds applies');

-- Queued again while the claim downloads ----------------------------------------------------------
INSERT INTO claims SELECT 2, c.message_id, c.claim_id FROM public.bridge_mirror_claim(60) c;
SELECT isnt((SELECT claim_id FROM claims WHERE n = 2), (SELECT claim_id FROM claims WHERE n = 1),
            'each claim has a new claim_id');
UPDATE public.bridge_mirror_queue SET attempts = 3 WHERE message_id = '30900000-0000-0000-0000-00000000a001';
SELECT is(public.bridge_mirror_enqueue(ARRAY['30900000-0000-0000-0000-00000000a001']::uuid[]), 1,
          'an edit queues the claimed message again');
SELECT is((SELECT claim_id FROM public.bridge_mirror_queue WHERE message_id = '30900000-0000-0000-0000-00000000a001'), NULL,
          'and clears its claim_id');
SELECT public.bridge_mirror_finish('30900000-0000-0000-0000-00000000a001', 'done', 3, NULL, NULL, NULL,
                                   (SELECT claim_id FROM claims WHERE n = 2));
SELECT results_eq($$SELECT state, attempts, next_attempt_at <= now() FROM public.bridge_mirror_queue WHERE message_id = '30900000-0000-0000-0000-00000000a001'$$,
                  $$VALUES ('queued'::text, 0, true)$$,
                  'done from the earlier claim leaves the requeued row: queued, due, no attempts');
SELECT public.bridge_mirror_finish('30900000-0000-0000-0000-00000000a001', 'failed', 5, NULL, NULL, 'message kept changing',
                                   (SELECT claim_id FROM claims WHERE n = 2));
SELECT is((SELECT state FROM public.bridge_mirror_queue WHERE message_id = '30900000-0000-0000-0000-00000000a001'), 'queued',
          'and so does any other outcome of it');
INSERT INTO claims SELECT 3, c.message_id, c.claim_id FROM public.bridge_mirror_claim(60) c;
SELECT is((SELECT message_id FROM claims WHERE n = 3), '30900000-0000-0000-0000-00000000a001'::uuid,
          'the requeued row is claimed again at once');
SELECT public.bridge_mirror_finish('30900000-0000-0000-0000-00000000a001', 'done', 0, NULL, NULL, NULL,
                                   (SELECT claim_id FROM claims WHERE n = 3));
SELECT is((SELECT count(*)::int FROM public.bridge_mirror_queue WHERE message_id = '30900000-0000-0000-0000-00000000a001'), 0,
          'done from the claim the row holds deletes it');

-- Claimed again past the lease --------------------------------------------------------------------
SELECT public.bridge_mirror_enqueue(ARRAY['30900000-0000-0000-0000-00000000a002']::uuid[]);
INSERT INTO claims SELECT 4, c.message_id, c.claim_id FROM public.bridge_mirror_claim(60) c;
UPDATE public.bridge_mirror_queue SET next_attempt_at = now() - interval '1 second'
 WHERE message_id = '30900000-0000-0000-0000-00000000a002';
INSERT INTO claims SELECT 5, c.message_id, c.claim_id FROM public.bridge_mirror_claim(60) c;
SELECT is((SELECT message_id FROM claims WHERE n = 5), '30900000-0000-0000-0000-00000000a002'::uuid,
          'a row whose lease ran out is claimed again');
SELECT public.bridge_mirror_finish('30900000-0000-0000-0000-00000000a002', 'too_large', 0, NULL, 99, NULL,
                                   (SELECT claim_id FROM claims WHERE n = 4));
SELECT is((SELECT state FROM public.bridge_mirror_queue WHERE message_id = '30900000-0000-0000-0000-00000000a002'), 'queued',
          'the first claim''s outcome no longer applies');
SELECT public.bridge_mirror_finish('30900000-0000-0000-0000-00000000a002', 'too_large', 0, NULL, 99, NULL,
                                   (SELECT claim_id FROM claims WHERE n = 5));
SELECT results_eq($$SELECT state, largest_bytes FROM public.bridge_mirror_queue WHERE message_id = '30900000-0000-0000-0000-00000000a002'$$,
                  $$VALUES ('too_large'::text, 99::bigint)$$, 'the second claim''s does');

-- A gateway before 1.9.8 ---------------------------------------------------------------------------
SELECT public.bridge_mirror_finish('30900000-0000-0000-0000-00000000a002', 'failed', 2, NULL, NULL, 'old');
SELECT is((SELECT state FROM public.bridge_mirror_queue WHERE message_id = '30900000-0000-0000-0000-00000000a002'), 'failed',
          'without a claim_id the outcome applies as before');
SELECT public.bridge_mirror_finish('30900000-0000-0000-0000-00000000a002', 'done', 2, NULL, NULL, NULL);
SELECT is((SELECT count(*)::int FROM public.bridge_mirror_queue WHERE message_id = '30900000-0000-0000-0000-00000000a002'), 0,
          'and done deletes the row');

SELECT * FROM finish();
ROLLBACK;
