-- Argument and return contracts for the RPCs the application calls.
--
-- scripts/check-rpc-coverage.sh asserts each called name EXISTS. Existence is
-- the weakest half of the contract. PostgREST dispatches `.rpc(name, {...})` by
-- argument NAME: renaming p_before to p_cursor, or dropping a DEFAULT so an
-- omitted key no longer resolves, produces "function does not exist" at
-- runtime with the function plainly present in the catalog. On the return side
-- the client destructures a fixed shape -- `data.messages`, `Array.isArray(data)`,
-- `permissions[PERM] === true` -- and a jsonb turned into a SETOF, or a renamed
-- TABLE column, reads as undefined rather than as an error.
--
-- Every literal below is the shape the call sites in src/,
-- federation-backend/src/ and bot-gateway/src/ actually send and read.
--
-- Signatures alone still pass while a body is broken, so each cheap,
-- side-effect-free RPC is also called and its result asserted. verify_bot_token
-- is the one exception; see the note on it below.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(55);

CREATE OR REPLACE FUNCTION pg_temp.args(p_name text) RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT pg_get_function_arguments(p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = p_name;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.res(p_name text) RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT pg_get_function_result(p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = p_name;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.sig(p_name text) RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT pg_temp.args(p_name) || ' -> ' || pg_temp.res(p_name);
$fn$;

-- The named grantee in proacl, not has_function_privilege. Every function
-- postgres creates in public also carries the PUBLIC entry =X/postgres, and
-- has_function_privilege is satisfied by that alone: a REVOKE aimed at one role
-- leaves it answering true. A NULL proacl means owner and PUBLIC only, so
-- aclexplode yielding nothing is the correct negative.
CREATE OR REPLACE FUNCTION pg_temp.granted_execute(p_name text, p_role text)
RETURNS boolean LANGUAGE sql STABLE AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(p.proacl) a
    WHERE n.nspname = 'public' AND p.proname = p_name
      AND a.grantee = p_role::regrole
      AND a.privilege_type = 'EXECUTE'
  );
$fn$;

-- Dispatch surface ------------------------------------------------------------
-- pg_temp.args/res return the first matching row, so a second overload would
-- make every signature assertion below read whichever body sorted first. A
-- second overload is also a runtime fault in its own right: PostgREST resolves
-- by the JSON body keys and answers "Could not choose the best candidate
-- function" when two candidates accept the same key set. One row per name is
-- both the precondition for this file and the contract.
SELECT is((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY[
              'get_home_timeline_page', 'get_message_page', 'get_user_conversations',
              'get_user_permissions', 'has_permission', 'lookup_invite_by_code',
              'get_current_profile_id', 'is_current_user_admin',
              'get_user_push_subscriptions', 'record_push_success', 'record_push_failure',
              'verify_bot_token', 'queue_federation_job'])), 13::bigint,
          'each contracted RPC exists exactly once, so PostgREST has one candidate');

-- Timeline and message page readers -------------------------------------------
-- Three round-trip collapsers, each with a legacy multi-query fallback the
-- client silently drops into when the RPC errors. A broken contract therefore
-- does not surface as a failure; it surfaces as the waterfall the RPC was
-- written to remove, plus a debug.warn nobody reads.

-- activityPubService.ts sends { p_limit, p_before } and requires a jsonb ARRAY:
-- it tests Array.isArray(rpcData) and falls back when false.
SELECT is(pg_temp.sig('get_home_timeline_page'),
          'p_limit integer DEFAULT 20, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone -> jsonb',
          'get_home_timeline_page takes p_limit/p_before and returns jsonb');

-- CoreMessageService.ts sends all four keys, passing null for whichever id it
-- does not have, and reads data.messages / data.reactions off a jsonb OBJECT.
SELECT is(pg_temp.sig('get_message_page'),
          'p_channel_id uuid DEFAULT NULL::uuid, p_conversation_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 20, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone -> jsonb',
          'get_message_page takes both ids plus p_limit/p_before and returns jsonb');

-- useDM.ts calls it with no arguments. Any parameter without a DEFAULT breaks
-- the empty-body call.
SELECT is(pg_temp.sig('get_user_conversations'), ' -> jsonb',
          'get_user_conversations takes no arguments and returns jsonb');

-- Permissions ------------------------------------------------------------------
-- RoleService.ts casts the result to Record<Permission, boolean> and indexes it
-- directly, so the return must be a jsonb object, not a row set.
SELECT is(pg_temp.sig('get_user_permissions'),
          'p_user_id uuid, p_server_id uuid, p_channel_id uuid DEFAULT NULL::uuid -> jsonb',
          'get_user_permissions takes user/server/channel and returns jsonb');

-- Not reached over PostgREST. Called from storage RLS and from other function
-- bodies, positionally, with the fourth argument omitted.
SELECT is(pg_temp.sig('has_permission'),
          'p_user_id uuid, p_server_id uuid, p_permission text, p_channel_id uuid DEFAULT NULL::uuid -> boolean',
          'has_permission takes user/server/permission plus an optional channel');

-- Auth and session helpers ------------------------------------------------------
-- Zero-argument by design: the caller is resolved from the JWT, never passed.
-- A parameter added here would be silently unfilled by every policy predicate
-- that calls them bare.
SELECT is(pg_temp.sig('get_current_profile_id'), ' -> uuid',
          'get_current_profile_id takes no arguments and returns uuid');
SELECT is(pg_temp.sig('is_current_user_admin'), ' -> boolean',
          'is_current_user_admin takes no arguments and returns boolean');

-- Invite accept -----------------------------------------------------------------
-- inviteService.ts and BotRestAPI.ts both do `Array.isArray(rows) ? rows[0] : null`,
-- which needs a SETOF, and then read used / expires_at / uses / max_uses /
-- server_id / server_name / server_icon off it. The column names are the
-- contract; the two server_* columns come from the join, not the invites table.
SELECT is(pg_temp.args('lookup_invite_by_code'), 'p_code text',
          'lookup_invite_by_code takes p_code');
SELECT is(pg_temp.res('lookup_invite_by_code'),
          'TABLE(id uuid, code text, server_id uuid, created_by uuid, uses integer,'
          || ' max_uses integer, used boolean, temporary boolean,'
          || ' expires_at timestamp with time zone, created_at timestamp with time zone,'
          || ' server_name text, server_icon text)',
          'lookup_invite_by_code returns the row shape the accept flow destructures');

-- Push delivery -------------------------------------------------------------------
-- PushNotificationService.ts reads subscription_id / endpoint / p256dh / auth off
-- each row and hands the last three straight to web-push, then feeds
-- subscription_id back into record_push_success / record_push_failure.
SELECT is(pg_temp.args('get_user_push_subscriptions'), 'p_user_id uuid',
          'get_user_push_subscriptions takes p_user_id');
SELECT is(pg_temp.res('get_user_push_subscriptions'),
          'TABLE(subscription_id uuid, endpoint text, p256dh text, auth text,'
          || ' push_enabled boolean, push_offline_only boolean)',
          'get_user_push_subscriptions returns the columns web-push is fed from');
SELECT is(pg_temp.sig('record_push_success'), 'p_subscription_id uuid -> void',
          'record_push_success takes p_subscription_id');
SELECT is(pg_temp.sig('record_push_failure'),
          'p_subscription_id uuid, p_reason text DEFAULT NULL::text -> void',
          'record_push_failure takes p_subscription_id and an optional p_reason');

-- Bot auth --------------------------------------------------------------------------
-- BotAuthMiddleware.ts and WebSocketGateway.ts both hash the bearer token and
-- read verification.valid / .bot_id / .username / .scopes off a jsonb object.
--
-- Signature only. The body selects `WHERE is_active = true` and increments
-- uses_count; bot_tokens carries neither column, so every call raises 42703
-- undefined_column. Asserting the current outcome would pin the fault, so the
-- result shape is left unasserted until the body and the table agree.
SELECT is(pg_temp.sig('verify_bot_token'), 'p_token_hash text -> jsonb',
          'verify_bot_token takes p_token_hash and returns jsonb');

-- Federation job queue ----------------------------------------------------------------
-- Reached from 33 trigger bodies, positionally, almost all with the two
-- required arguments only. Losing a DEFAULT breaks every one of them at the
-- point of the write that fired the trigger, not at deploy time.
SELECT is(pg_temp.sig('queue_federation_job'),
          'p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,'
          || ' p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600 -> uuid',
          'queue_federation_job takes name/data plus three defaulted tuning arguments');

-- EXECUTE grants ------------------------------------------------------------------------
-- 98_enable_rls.sql revokes ALL on a long list of functions from PUBLIC, anon
-- and authenticated. Adding a contracted RPC to that list leaves the signature
-- intact and turns every call into "permission denied for function", which the
-- readers above answer by falling back to the legacy path and the rest answer
-- with a broken screen. That REVOKE names the role, so the role's own entry in
-- proacl is what disappears; the PUBLIC entry left behind by CREATE FUNCTION is
-- why the privilege has to be read per grantee.
--
-- Invocation does not substitute for that on a function still holding the PUBLIC
-- entry: a role-only REVOKE leaves the call working, so the behaviour assertions
-- below stay green. Functions 98_enable_rls.sql already revokes from PUBLIC --
-- record_push_failure among them -- do lose access, and there the two agree.
SELECT is_empty($q$
    SELECT f.fname, f.frole
    FROM (VALUES
        ('get_home_timeline_page', 'authenticated'),
        ('get_message_page',       'authenticated'),
        ('get_user_conversations', 'authenticated'),
        ('get_user_permissions',   'authenticated'),
        ('lookup_invite_by_code',  'authenticated'),
        ('get_current_profile_id', 'authenticated'),
        ('is_current_user_admin',  'authenticated')
    ) AS f(fname, frole)
    WHERE NOT pg_temp.granted_execute(f.fname, f.frole)
$q$, 'every browser-called RPC grants EXECUTE to authenticated by name');

-- getInviteDetails is documented as the anonymous shared-link preview path.
SELECT ok(pg_temp.granted_execute('lookup_invite_by_code', 'anon'),
          'lookup_invite_by_code grants EXECUTE to anon, which the link preview needs');

SELECT is_empty($q$
    SELECT f.fname
    FROM (VALUES
        ('get_user_push_subscriptions'), ('record_push_success'),
        ('record_push_failure'), ('verify_bot_token')
    ) AS f(fname)
    WHERE NOT pg_temp.granted_execute(f.fname, 'service_role')
$q$, 'the push and bot-auth RPCs grant EXECUTE to service_role by name');

-- ---------------------------------------------------------------------------
-- Behaviour. A signature can match while the body is broken.
-- ---------------------------------------------------------------------------

-- get_current_profile_id -----------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.get_current_profile_id(), '11111111-0000-0000-0000-000000000001'::uuid,
          'get_current_profile_id maps a JWT sub to the profile joined on auth_user_id');

-- Every RPC below that resolves its caller server-side goes through this. An
-- anon request must resolve to no profile at all; a non-null answer here would
-- hand the signed-out session somebody's rows.
SELECT tests.authenticate_as_anon();
SELECT is(public.get_current_profile_id(), NULL::uuid,
          'get_current_profile_id resolves to nothing for an anonymous caller');

-- is_current_user_admin ------------------------------------------------------
-- promote_first_user_to_admin sets is_admin on the first local profile, which
-- the fixture order makes alice. Guarded: if that stops happening the two
-- assertions below would agree at false and prove nothing.
SELECT tests.clear_authentication();
SELECT is((SELECT string_agg(is_admin::text, ',' ORDER BY username) FROM public.profiles
            WHERE username IN ('alice', 'mallory')), 'true,false',
          'the fixtures still carry one admin and one non-admin profile');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.is_current_user_admin(), true,
          'is_current_user_admin is true for the profile carrying is_admin');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.is_current_user_admin(), false,
          'is_current_user_admin is false for an ordinary profile');

-- COALESCE, not a bare column read: the admin gates spell this
-- `is_current_user_admin()` inside policy predicates where NULL denies quietly
-- but also poisons any OR it sits in.
SELECT tests.authenticate_as_anon();
SELECT is(public.is_current_user_admin(), false,
          'is_current_user_admin is false, never NULL, when no profile resolves');

-- get_user_conversations -----------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(jsonb_typeof(public.get_user_conversations()), 'array',
          'get_user_conversations returns a JSON array, which useDM tests for');

SELECT is((SELECT string_agg(e->>'conversation_id', ',')
             FROM jsonb_array_elements(public.get_user_conversations()) e),
          '77777777-0000-0000-0000-000000000007',
          'get_user_conversations returns the caller''s conversation, keyed conversation_id');

-- useDM reads each of these off the row. A key dropped from the
-- jsonb_build_object is undefined on the client, not an error: hidden_at going
-- missing un-dismisses every dismissed conversation, is_muted going missing
-- un-mutes every muted one.
-- COALESCE around the `?`: an absent row makes `NULL ? k` NULL, which would
-- drop every key from the result and pass this on an empty array.
SELECT is_empty($q$
    SELECT k FROM unnest(ARRAY['conversation_id','created_at','updated_at','type','name',
                               'created_by','is_active','metadata','hidden_at','user_role',
                               'user_joined_at','other_participants','last_message',
                               'unread_messages','unread_mentions','is_muted']) k
    WHERE NOT COALESCE((public.get_user_conversations()->0) ? k, false)
$q$, 'a conversation row carries every key useDM destructures');

-- COALESCE to '[]', not NULL: useDM iterates the result directly.
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.get_user_conversations(), '[]'::jsonb,
          'a caller with no conversations gets an empty array rather than NULL');

-- get_home_timeline_page -----------------------------------------------------
SELECT tests.clear_authentication();
INSERT INTO public.posts (id, author_id, content, visibility) VALUES
  ('c0000000-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"tl1"}]', 'public'),
  ('c0000000-0000-0000-0000-0000000000a2', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"tl2"}]', 'public'),
  ('c0000000-0000-0000-0000-0000000000a3', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"tl3"}]', 'public');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(jsonb_typeof(public.get_home_timeline_page(20, NULL)), 'array',
          'get_home_timeline_page returns a JSON array, which the client tests for');

-- The client reads post.author?.is_suspended to filter and post.my_interactions
-- to derive is_bookmarked / is_favorited / is_reblogged. Without the author
-- embed every suspended author's posts render; without my_interactions every
-- button renders un-pressed.
--
-- Counted against the three posts inserted above rather than asserted as the
-- absence of malformed rows, which an empty array would satisfy.
SELECT is((SELECT count(*)::int
             FROM jsonb_array_elements(public.get_home_timeline_page(20, NULL)) e
            WHERE e->>'id' LIKE 'c0000000-%'
              AND (e->'author')->>'username' = 'alice'
              AND (e->'author') ? 'is_suspended'
              AND jsonb_typeof(e->'my_interactions') = 'array'), 3,
          'every timeline row carries the author embed and an array of my_interactions');

-- Pagination is driven by rawData.length >= limit. A p_limit the body ignores
-- makes that test true forever and the feed never stops loading.
SELECT is(jsonb_array_length(public.get_home_timeline_page(2, NULL)), 2,
          'p_limit caps the number of rows returned');

-- get_message_page -----------------------------------------------------------
-- Exactly two top-level keys. Returning a row set instead leaves data.messages
-- undefined and the chat silently empty, with no error for the client to fall
-- back on.
SELECT is((SELECT string_agg(k, ',' ORDER BY k)
             FROM jsonb_object_keys(
               public.get_message_page('66666666-0000-0000-0000-000000000006', NULL, 20, NULL)) k),
          'messages,reactions',
          'get_message_page returns an object keyed messages and reactions');

SELECT is((SELECT string_agg(e->>'id', ',') FROM jsonb_array_elements(
             public.get_message_page('66666666-0000-0000-0000-000000000006', NULL, 20, NULL)
             ->'messages') e),
          '88888888-0000-0000-0000-000000000008',
          'the channel page returns the messages RLS lets the caller read');

SELECT is((SELECT string_agg(e->>'id', ',') FROM jsonb_array_elements(
             public.get_message_page(NULL, '77777777-0000-0000-0000-000000000007', 20, NULL)
             ->'messages') e),
          '99999999-0000-0000-0000-000000000009',
          'the conversation page returns the DM the caller participates in');

-- The client always sends both keys with one set to null. Both-null and
-- both-set are caller bugs the body refuses rather than answering with the
-- wrong page; without the raise, both-null returns an empty channel page and
-- reads as an empty channel.
SELECT throws_ok(
    $q$SELECT public.get_message_page(NULL, NULL, 20, NULL)$q$,
    'P0001', 'get_message_page: provide exactly one of p_channel_id / p_conversation_id',
    'get_message_page refuses a call with neither id');

SELECT throws_ok(
    $q$SELECT public.get_message_page('66666666-0000-0000-0000-000000000006',
                                      '77777777-0000-0000-0000-000000000007', 20, NULL)$q$,
    'P0001', 'get_message_page: provide exactly one of p_channel_id / p_conversation_id',
    'get_message_page refuses a call with both ids');

-- get_user_permissions / has_permission --------------------------------------
SELECT is(jsonb_typeof(public.get_user_permissions(
            '22222222-0000-0000-0000-000000000002',
            '55555555-0000-0000-0000-000000000005', NULL)), 'object',
          'get_user_permissions returns an object RoleService can index');

-- alice owns the fixture server; bob is a plain accepted member.
SELECT is(public.get_user_permissions('11111111-0000-0000-0000-000000000001',
                                      '55555555-0000-0000-0000-000000000005', NULL)
            ->>'ADMINISTRATOR', 'true',
          'the server owner is granted ADMINISTRATOR');

SELECT is(public.get_user_permissions('22222222-0000-0000-0000-000000000002',
                                      '55555555-0000-0000-0000-000000000005', NULL)
            ->>'ADMINISTRATOR', 'false',
          'a plain member is not granted ADMINISTRATOR');

-- RoleService denies on `permissions[p] === true`, so a key the body omits is
-- indistinguishable from a denial. The object must name all 30 bits for a
-- member, not only the ones that happen to be set.
SELECT is((SELECT count(*)::int FROM jsonb_object_keys(public.get_user_permissions(
             '22222222-0000-0000-0000-000000000002',
             '55555555-0000-0000-0000-000000000005', NULL))), 30,
          'the permission object names every bit rather than only the granted ones');

SELECT is(public.has_permission('11111111-0000-0000-0000-000000000001',
                                '55555555-0000-0000-0000-000000000005', 'ADMINISTRATOR'), true,
          'has_permission agrees with get_user_permissions for the owner');

SELECT is(public.has_permission('22222222-0000-0000-0000-000000000002',
                                '55555555-0000-0000-0000-000000000005', 'ADMINISTRATOR'), false,
          'has_permission denies the member the owner is granted');

-- Storage RLS spells this bare inside USING clauses. An unknown or renamed
-- permission name must read false, not NULL, or it poisons the surrounding OR.
SELECT is(public.has_permission('11111111-0000-0000-0000-000000000001',
                                '55555555-0000-0000-0000-000000000005', 'NO_SUCH_PERMISSION'), false,
          'has_permission answers false, never NULL, for a name it does not know');

-- lookup_invite_by_code ------------------------------------------------------
SELECT tests.clear_authentication();
INSERT INTO public.invites (id, code, server_id, created_by, max_uses)
VALUES ('c0000000-0000-0000-0000-0000000000b1', 'RPCCONTRACT',
        '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', 5);

SELECT results_eq(
    $q$SELECT code, server_id, uses, max_uses, used, server_name
         FROM public.lookup_invite_by_code('RPCCONTRACT')$q$,
    $q$VALUES ('RPCCONTRACT'::text, '55555555-0000-0000-0000-000000000005'::uuid,
               0, 5, false, 'Test Server'::text)$q$,
    'lookup_invite_by_code returns the invite joined to its server name');

-- The accept flow treats zero rows as "invalid code". An exception instead
-- would surface as a failed request rather than a rejected invite.
SELECT is_empty($q$SELECT id FROM public.lookup_invite_by_code('NO-SUCH-CODE')$q$,
                'an unknown code yields no rows rather than an error');

-- SELECT on invites is restricted to the creator and instance admins, so the
-- negative comes first: without the SECURITY DEFINER RPC an anonymous link
-- preview sees nothing at all.
SELECT tests.authenticate_as_anon();
SELECT is((SELECT count(*)::int FROM public.invites WHERE code = 'RPCCONTRACT'), 0,
          'anon reads no invite rows directly');
SELECT is((SELECT count(*)::int FROM public.lookup_invite_by_code('RPCCONTRACT')), 1,
          'anon reads that same invite through the RPC, which is why it is DEFINER');

-- get_user_push_subscriptions ------------------------------------------------
-- notification_preferences is auto-created per profile, so the row is dropped
-- here: the LEFT JOIN plus COALESCE is what the backend relies on for a user
-- who has never touched notification settings. Both flags reaching the backend
-- as null would be falsy in JS and stop push for that user entirely.
SELECT tests.clear_authentication();
DELETE FROM public.notification_preferences WHERE user_id = '11111111-0000-0000-0000-000000000001';
INSERT INTO public.push_subscriptions (id, user_id, endpoint, p256dh, auth, failure_count) VALUES
  ('c0000000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001',
   'https://push.test/live', 'key-live', 'auth-live', 0),
  ('c0000000-0000-0000-0000-0000000000c2', '11111111-0000-0000-0000-000000000001',
   'https://push.test/dead', 'key-dead', 'auth-dead', 5);

SELECT results_eq(
    $q$SELECT subscription_id, endpoint, p256dh, auth
         FROM public.get_user_push_subscriptions('11111111-0000-0000-0000-000000000001')$q$,
    $q$VALUES ('c0000000-0000-0000-0000-0000000000c1'::uuid, 'https://push.test/live'::text,
               'key-live'::text, 'auth-live'::text)$q$,
    'a live subscription is returned with the keys web-push is handed');

-- The dead endpoint is excluded by failure_count < 5. record_push_failure is
-- the only thing that raises that counter, so the two contracts are one loop.
--
-- Counted against what the table holds rather than asserted as the absence of
-- the dead endpoint: an is_empty over a function result is also satisfied by a
-- function that returns nothing at all.
SELECT results_eq(
    $q$SELECT (SELECT count(*) FROM public.get_user_push_subscriptions(
                 '11111111-0000-0000-0000-000000000001')),
              (SELECT count(*) FROM public.push_subscriptions
                WHERE user_id = '11111111-0000-0000-0000-000000000001')$q$,
    $q$VALUES (1::bigint, 2::bigint)$q$,
    'one of the two seeded subscriptions is withheld, the one at five failures');

SELECT results_eq(
    $q$SELECT push_enabled, push_offline_only
         FROM public.get_user_push_subscriptions('11111111-0000-0000-0000-000000000001')$q$,
    $q$VALUES (true, true)$q$,
    'both delivery flags default to true when the user has no preferences row');

-- record_push_failure / record_push_success ----------------------------------
SELECT public.record_push_failure('c0000000-0000-0000-0000-0000000000c1', 'gone');
SELECT results_eq(
    $q$SELECT failure_count, last_failure_reason, last_failure_at IS NOT NULL
         FROM public.push_subscriptions WHERE id = 'c0000000-0000-0000-0000-0000000000c1'$q$,
    $q$VALUES (1, 'gone'::text, true)$q$,
    'record_push_failure increments the counter and stores the reason');

-- Resets rather than decrements: a subscription that recovers must come back
-- from any failure count, or a transient outage retires it permanently.
SELECT public.record_push_success('c0000000-0000-0000-0000-0000000000c1');
SELECT results_eq(
    $q$SELECT failure_count, last_failure_reason, last_failure_at,
              last_successful_push IS NOT NULL
         FROM public.push_subscriptions WHERE id = 'c0000000-0000-0000-0000-0000000000c1'$q$,
    $q$VALUES (0, NULL::text, NULL::timestamptz, true)$q$,
    'record_push_success clears the failure state and stamps the success');

-- queue_federation_job -------------------------------------------------------
-- Trigger bodies call it with the two required arguments and use the returned
-- uuid as the job id. The uuid is generated on the first line of the body and
-- the EXCEPTION arm returns a non-NULL one too, so a non-NULL return asserts
-- nothing about the enqueue; only the fallback leaves an observable trace.
--
-- pg_notify refuses a payload of 8000 bytes or more with 22023, which is the
-- one failure reachable without altering the schema. The EXCEPTION arm then
-- writes the federation_delivery_queue row the delivery worker drains and
-- returns that row's id in place of the generated one.
CREATE TEMP TABLE contract_enqueue AS
SELECT public.queue_federation_job('federate-contract-probe',
         jsonb_build_object('probe', 'oversized',
                            'target_domain', 'contract.example',
                            'target_inbox', 'https://contract.example/users/probe/inbox',
                            'filler', repeat('x', 9000))) AS job_id;

SELECT results_eq(
    $q$SELECT q.id = (SELECT job_id FROM contract_enqueue),
              q.target_domain, q.target_inbox_url, q.status
         FROM public.federation_delivery_queue q
        WHERE q.activity_data->>'probe' = 'oversized'$q$,
    $q$VALUES (true, 'contract.example'::text,
               'https://contract.example/users/probe/inbox'::text, 'pending'::text)$q$,
    'an enqueue pg_notify refuses is written to the delivery queue and its id returned');

-- No target_domain, nothing to address the fallback to. NULL is how a dropped
-- job looks from inside a trigger.
SELECT is(public.queue_federation_job('federate-contract-probe',
            jsonb_build_object('filler', repeat('x', 9000))), NULL::uuid,
          'an enqueue pg_notify refuses with no target domain returns NULL');

SELECT * FROM finish();
ROLLBACK;
