-- Real SQL/RLS/trigger tests: no gateway mocks, no changes survive this transaction.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT no_plan();
GRANT USAGE ON SCHEMA tests TO service_role;
CREATE FUNCTION pg_temp.bid(name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
 SELECT md5('bridge-consent-246-' || name)::uuid;
$$;

INSERT INTO public.servers(id,name,owner) VALUES
 (pg_temp.bid('server'),'Bridge consent','11111111-0000-0000-0000-000000000001'),
 (pg_temp.bid('other'),'Other bridge','11111111-0000-0000-0000-000000000001');
INSERT INTO public.channels(id,server_id,name,type) VALUES
 (pg_temp.bid('channel'),pg_temp.bid('server'),'paired',0),
 (pg_temp.bid('unpaired'),pg_temp.bid('server'),'unpaired',0),
 (pg_temp.bid('foreign'),pg_temp.bid('other'),'foreign',0);
INSERT INTO public.user_servers(user_id,server_id,status) VALUES
 ('11111111-0000-0000-0000-000000000001',pg_temp.bid('server'),'accepted'),
 ('22222222-0000-0000-0000-000000000002',pg_temp.bid('server'),'accepted'),
 ('11111111-0000-0000-0000-000000000001',pg_temp.bid('other'),'accepted');
INSERT INTO public.bots(id,username,owner_id,bot_type) VALUES
 (pg_temp.bid('matrix'),'matrix-consent-246','11111111-0000-0000-0000-000000000001','bot'),
 (pg_temp.bid('plain'),'plain-consent-246','11111111-0000-0000-0000-000000000001','bot'),
 (pg_temp.bid('legacy'),'legacy-consent-246','11111111-0000-0000-0000-000000000001','bridge'),
 (pg_temp.bid('v2'),'v2-consent-246','11111111-0000-0000-0000-000000000001','bridge');
INSERT INTO public.bot_server_permissions(bot_id,server_id,installed_by,read_messages,send_messages,is_active,allowed_channel_ids) VALUES
 (pg_temp.bid('matrix'),pg_temp.bid('server'),'11111111-0000-0000-0000-000000000001',true,true,true,ARRAY[pg_temp.bid('channel'),pg_temp.bid('foreign')]),
 (pg_temp.bid('plain'),pg_temp.bid('server'),'11111111-0000-0000-0000-000000000001',true,true,true,NULL),
 (pg_temp.bid('legacy'),pg_temp.bid('server'),'11111111-0000-0000-0000-000000000001',true,true,true,NULL),
 (pg_temp.bid('v2'),pg_temp.bid('other'),'11111111-0000-0000-0000-000000000001',true,true,true,NULL);
INSERT INTO public.discord_bridge_pairings(server_id,pairing_code,created_by)
 VALUES(pg_temp.bid('server'),'HRM-2460-2460','11111111-0000-0000-0000-000000000001');
INSERT INTO public.discord_bridges(id,server_id,bot_id,mode,created_by)
 VALUES(pg_temp.bid('v2bridge'),pg_temp.bid('other'),pg_temp.bid('v2'),'self','11111111-0000-0000-0000-000000000001');
INSERT INTO public.discord_bridge_channels(bridge_id,harmony_channel_id,discord_channel_id)
 VALUES(pg_temp.bid('v2bridge'),pg_temp.bid('foreign'),'123456789');

SELECT ok(NOT has_function_privilege('authenticated','public.bridge_channel_platform(uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('anon','public.bridge_channel_platform(uuid,uuid)','EXECUTE')
 AND has_function_privilege('service_role','public.bridge_channel_platform(uuid,uuid)','EXECUTE'), 'platform lookup service only');
SELECT ok(NOT has_function_privilege('authenticated','public.can_bridge_member_messages(uuid,uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('anon','public.bridge_visible_message_ids(uuid,uuid[])','EXECUTE')
 AND NOT has_function_privilege('authenticated','public.bridge_message_recipients(uuid[],uuid)','EXECUTE')
 AND has_function_privilege('service_role','public.bridge_visible_message_ids(uuid,uuid[])','EXECUTE')
 AND has_function_privilege('service_role','public.bridge_message_recipients(uuid[],uuid)','EXECUTE'), 'privacy filters service only');
SELECT ok(NOT has_function_privilege('anon','public.set_server_bridge_opt_out(uuid,boolean)','EXECUTE')
 AND NOT has_function_privilege('service_role','public.configure_matrix_bridge(uuid,uuid,uuid[])','EXECUTE'), 'self and manager RPC grants are restricted');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.get_server_bridge_opt_out(pg_temp.bid('server')),false,'consent defaults to allowed');
SELECT throws_ok($$UPDATE public.user_servers SET bridge_opt_out=true WHERE server_id=pg_temp.bid('server') AND user_id='22222222-0000-0000-0000-000000000002'$$,'42501',NULL,'direct own preference update refused');
SELECT throws_ok($$SELECT public.set_server_bridge_opt_out(pg_temp.bid('server'),NULL)$$,'22023',NULL,'null preference refused');
SELECT throws_ok($$SELECT public.configure_matrix_bridge(pg_temp.bid('matrix'),pg_temp.bid('server'),ARRAY[pg_temp.bid('channel')])$$,'42501',NULL,'member cannot configure a bridge');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($$SELECT public.get_server_bridge_opt_out(pg_temp.bid('server'))$$,'42501',NULL,'nonmember cannot read preference');
SELECT throws_ok($$SELECT public.set_server_bridge_opt_out(pg_temp.bid('server'),true)$$,'42501',NULL,'nonmember cannot write preference');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT throws_ok($$SELECT public.get_server_bridge_opt_out('55555555-0000-0000-0000-000000000005')$$,'42501',NULL,'banned membership is not accepted');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($$UPDATE public.user_servers SET bridge_opt_out=true WHERE server_id=pg_temp.bid('server') AND user_id='22222222-0000-0000-0000-000000000002'$$,'42501',NULL,'manager cannot change another member consent');
SELECT throws_ok($$UPDATE public.bots SET bridge_platform='matrix' WHERE id=pg_temp.bid('plain')$$,'42501',NULL,'client cannot stamp protocol directly');
SELECT throws_ok($$SELECT public.configure_matrix_bridge(pg_temp.bid('matrix'),pg_temp.bid('server'),ARRAY[pg_temp.bid('foreign')])$$,'22023',NULL,'cross-server channel refused even if present in install allowlist');
SELECT throws_ok($$SELECT public.configure_matrix_bridge(pg_temp.bid('matrix'),pg_temp.bid('server'),ARRAY[pg_temp.bid('unpaired')])$$,'22023',NULL,'channel outside install allowlist refused');
SELECT throws_ok($$SELECT public.configure_matrix_bridge(pg_temp.bid('matrix'),pg_temp.bid('server'),NULL)$$,'22023',NULL,'null bindings refused');
SELECT throws_ok($$SELECT public.configure_matrix_bridge(pg_temp.bid('matrix'),pg_temp.bid('server'),ARRAY[NULL::uuid])$$,'22023',NULL,'null channel refused');
SELECT throws_ok($$SELECT public.configure_matrix_bridge(pg_temp.bid('v2'),pg_temp.bid('other'),'{}')$$,'22023',NULL,'Discord v2 cannot be converted');
SELECT throws_ok($$SELECT public.configure_matrix_bridge(pg_temp.bid('legacy'),pg_temp.bid('server'),'{}')$$,'22023',NULL,'legacy bridge cannot be converted');
SELECT is(public.configure_matrix_bridge(pg_temp.bid('matrix'),pg_temp.bid('server'),ARRAY[pg_temp.bid('channel'),pg_temp.bid('channel')]),true,'owner registers Matrix with duplicate IDs harmless');
SELECT throws_ok($$UPDATE public.bots SET bot_type='bot' WHERE id=pg_temp.bid('matrix')$$,'42501',NULL,'client cannot downgrade registered Matrix bot to bypass consent');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::integer FROM public.bridge_channels WHERE bot_id=pg_temp.bid('matrix')),1,'one durable binding');
SELECT is((SELECT bot_type FROM public.bots WHERE id=pg_temp.bid('matrix')),'bridge','Matrix registration marks bridge type');

UPDATE public.bot_server_permissions SET allowed_channel_ids=NULL WHERE bot_id=pg_temp.bid('plain');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($$SELECT public.configure_matrix_bridge(pg_temp.bid('plain'),pg_temp.bid('server'),'{}')$$,'42501',NULL,'unscoped install cannot be registered as Matrix');
SELECT throws_ok($$INSERT INTO public.bridge_channels VALUES(pg_temp.bid('plain'),pg_temp.bid('channel'),'matrix')$$,'42501',NULL,'manager cannot bypass configuration RPC with table writes');
SELECT tests.clear_authentication();
UPDATE public.bot_server_permissions SET send_messages=false WHERE bot_id=pg_temp.bid('matrix');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($$SELECT public.configure_matrix_bridge(pg_temp.bid('matrix'),pg_temp.bid('server'),ARRAY[pg_temp.bid('channel')])$$,'42501',NULL,'read-only install cannot configure a bridge');
SELECT tests.clear_authentication();
UPDATE public.bot_server_permissions SET send_messages=true WHERE bot_id=pg_temp.bid('matrix');

SET LOCAL ROLE service_role;
SELECT is(public.bridge_channel_platform(pg_temp.bid('matrix'),pg_temp.bid('channel')),'matrix','registered Matrix channel resolves');
SELECT is(public.bridge_channel_platform(pg_temp.bid('matrix'),pg_temp.bid('unpaired')),NULL::text,'Matrix never falls back to legacy server pairing');
SELECT is(public.bridge_channel_platform(pg_temp.bid('legacy'),pg_temp.bid('channel')),'discord','legacy pairing resolves');
SELECT is(public.bridge_channel_platform(pg_temp.bid('v2'),pg_temp.bid('foreign')),'discord','Discord v2 exact pair resolves');
SELECT is(public.bridge_channel_platform(pg_temp.bid('v2'),pg_temp.bid('channel')),NULL::text,'v2 does not inherit another server pairing');
SELECT is(public.bridge_channel_platform(pg_temp.bid('plain'),pg_temp.bid('channel')),NULL::text,'normal bot is not registered bridge');
SELECT ok(public.can_bridge_member_messages(pg_temp.bid('matrix'),pg_temp.bid('channel'),'22222222-0000-0000-0000-000000000002'),'accepted member allowed');
SELECT ok(NOT public.can_bridge_member_messages(pg_temp.bid('matrix'),pg_temp.bid('channel'),'33333333-0000-0000-0000-000000000003'),'missing membership fails closed');
RESET ROLE;
UPDATE public.bot_server_permissions SET is_active=false WHERE bot_id=pg_temp.bid('matrix');
SELECT is(public.bridge_channel_platform(pg_temp.bid('matrix'),pg_temp.bid('channel')),NULL::text,'disabled install revokes pairing');
UPDATE public.bot_server_permissions SET is_active=true WHERE bot_id=pg_temp.bid('matrix');

INSERT INTO public.messages(id,channel_id,user_id,content) VALUES
 (pg_temp.bid('bob-message'),pg_temp.bid('channel'),'22222222-0000-0000-0000-000000000002','[{"type":"text","text":"native member"}]'),
 (pg_temp.bid('outsider-message'),pg_temp.bid('channel'),'33333333-0000-0000-0000-000000000003','[{"type":"text","text":"historical outsider"}]');
INSERT INTO public.messages(id,channel_id,bot_id,content) VALUES
 (pg_temp.bid('bot-message'),pg_temp.bid('channel'),pg_temp.bid('plain'),'[{"type":"text","text":"ordinary bot"}]');

-- Public callbacks retain the native invoker's current consent despite user_id being NULL.
INSERT INTO public.messages(id,channel_id,bot_id,content,metadata) VALUES
 (pg_temp.bid('interaction-reply'),pg_temp.bid('channel'),pg_temp.bid('plain'),'[{"type":"text","text":"weather callback"}]',
  jsonb_build_object('interaction',jsonb_build_object('id',pg_temp.bid('interaction'),'name','weather','user_id','22222222-0000-0000-0000-000000000002')));
INSERT INTO public.messages(id,channel_id,user_id,content,metadata) VALUES
 (pg_temp.bid('native-precedence'),pg_temp.bid('channel'),'11111111-0000-0000-0000-000000000001','[{"type":"text","text":"native source wins"}]',
  '{"interaction":{"user_id":"22222222-0000-0000-0000-000000000002"}}');
CREATE TEMP TABLE interaction_cases(k text PRIMARY KEY,metadata jsonb);
GRANT SELECT ON interaction_cases TO service_role;
INSERT INTO interaction_cases VALUES
 ('missing-user','{"interaction":{"name":"weather"}}'),
 ('null-user','{"interaction":{"user_id":null}}'),
 ('bad-user','{"interaction":{"user_id":"not-a-uuid"}}'),
 ('numeric-user','{"interaction":{"user_id":42}}'),
 ('object-user','{"interaction":{"user_id":{}}}'),
 ('array-user','{"interaction":{"user_id":[]}}'),
 ('null-interaction','{"interaction":null}'),
 ('array-interaction','{"interaction":[]}'),
 ('string-interaction','{"interaction":"not-an-object"}'),
 ('unknown-invoker','{"interaction":{"user_id":"ffffffff-ffff-ffff-ffff-ffffffffffff"}}');
INSERT INTO public.messages(id,channel_id,bot_id,content,metadata)
 SELECT pg_temp.bid('interaction-'||k),pg_temp.bid('channel'),pg_temp.bid('plain'),'[{"type":"text","text":"invalid callback"}]',metadata FROM interaction_cases;
CREATE FUNCTION pg_temp.bridge_source(message_id uuid) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('user_id',m.user_id,'bot_id',m.bot_id,'metadata',m.metadata) FROM public.messages m WHERE m.id=message_id;
$$;
CREATE TEMP TABLE callback_snapshot AS SELECT pg_temp.bridge_source(pg_temp.bid('interaction-reply')) AS source;
GRANT SELECT ON callback_snapshot TO service_role;
SET LOCAL ROLE service_role;
SELECT is(public.bridge_visible_message_ids(pg_temp.bid('matrix'),ARRAY[pg_temp.bid('interaction-reply')]),ARRAY[pg_temp.bid('interaction-reply')],'consenting invoker callback is initially visible in history');
SELECT is(public.bridge_message_recipients(ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('legacy')],pg_temp.bid('interaction-reply')),ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('legacy')],'consenting invoker callback initially reaches ordinary and bridge live recipients');
SELECT is(public.bridge_source_recipients(ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('legacy')],pg_temp.bid('channel'),(SELECT source FROM callback_snapshot)),ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('legacy')],'consenting callback snapshot supports reaction/delete delivery');
SELECT ok(NOT has_function_privilege('authenticated','public.bridge_native_source_user_id(uuid,uuid,jsonb)','EXECUTE')
 AND NOT has_function_privilege('service_role','public.bridge_native_source_user_id(uuid,uuid,jsonb)','EXECUTE'),'source extraction is private, not a public RPC');
SELECT ok(NOT has_function_privilege('authenticated','public.bridge_source_recipients(uuid[],uuid,jsonb)','EXECUTE')
 AND NOT has_function_privilege('anon','public.bridge_source_recipients(uuid[],uuid,jsonb)','EXECUTE')
 AND has_function_privilege('service_role','public.bridge_source_recipients(uuid[],uuid,jsonb)','EXECUTE'),'source snapshot filtering is service only');
RESET ROLE;

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.set_server_bridge_opt_out(pg_temp.bid('server'),true),true,'member opts out');
SELECT is(public.get_server_bridge_opt_out(pg_temp.bid('server')),true,'preference persisted');
SELECT throws_ok($$INSERT INTO public.messages(channel_id,user_id,content,metadata) VALUES(pg_temp.bid('channel'),'22222222-0000-0000-0000-000000000002','[{"type":"text","text":"forged"}]','{"bridge_author":{"platform":"matrix","id":"@a:example.org","username":"a"}}')$$,'42501',NULL,'native client cannot forge bridge_author');
SELECT throws_ok($$UPDATE public.messages SET metadata='{"bridge_author":null}' WHERE id=pg_temp.bid('bob-message')$$,'42501',NULL,'client cannot add null bridge_author on edit');
SELECT is((SELECT count(*)::integer FROM public.messages WHERE id=pg_temp.bid('bob-message')),1,'opt-out changes no native message visibility');
SELECT throws_ok($$INSERT INTO public.reactions(message_id,user_id,custom_emoji_content,metadata) VALUES(pg_temp.bid('bob-message'),'22222222-0000-0000-0000-000000000002','🎉','{"bridge_author":{"platform":"matrix","id":"@x:example.org","username":"x"}}')$$,'42501',NULL,'native reaction cannot forge generic bridge author');
INSERT INTO public.reactions(id,message_id,user_id,custom_emoji_content) VALUES(pg_temp.bid('native-reaction'),pg_temp.bid('bob-message'),'22222222-0000-0000-0000-000000000002','🎉');
SELECT lives_ok($$UPDATE public.reactions SET metadata='{"bridge_author":null}' WHERE id=pg_temp.bid('native-reaction')$$,'native reaction edit is a no-op under existing UPDATE RLS');
SELECT ok(NOT (SELECT metadata ? 'bridge_author' FROM public.reactions WHERE id=pg_temp.bid('native-reaction')),'native reaction edit cannot persist even null generic author');
SELECT tests.clear_authentication();
SET LOCAL ROLE service_role;
SELECT is(public.bridge_visible_message_ids(pg_temp.bid('matrix'),ARRAY[pg_temp.bid('bob-message')]),'{}'::uuid[],'Matrix bridge sees no opted-out native content');
SELECT is(public.bridge_visible_message_ids(pg_temp.bid('legacy'),ARRAY[pg_temp.bid('bob-message')]),'{}'::uuid[],'opt-out applies to legacy Discord too');
SELECT is(public.bridge_visible_message_ids(pg_temp.bid('plain'),ARRAY[pg_temp.bid('bob-message'),pg_temp.bid('outsider-message')]),ARRAY[pg_temp.bid('bob-message'),pg_temp.bid('outsider-message')],'ordinary bot content unchanged');
SELECT is(public.bridge_visible_message_ids(pg_temp.bid('matrix'),ARRAY[pg_temp.bid('outsider-message')]),'{}'::uuid[],'native author without membership fails closed');
SELECT is(public.bridge_visible_message_ids(pg_temp.bid('missing'),ARRAY[pg_temp.bid('bot-message')]),'{}'::uuid[],'unknown bot sees nothing');
SELECT is(public.bridge_message_recipients(ARRAY[pg_temp.bid('matrix'),pg_temp.bid('missing'),pg_temp.bid('plain'),pg_temp.bid('legacy'),pg_temp.bid('plain')],pg_temp.bid('bob-message')),ARRAY[pg_temp.bid('plain')],'batch recipients filters opted-out native authors and unknown bots, dedupes');
SELECT is(public.bridge_message_recipients(ARRAY[pg_temp.bid('matrix')],pg_temp.bid('missing')),'{}'::uuid[],'unknown message yields no recipients');
SELECT ok(NOT has_function_privilege('authenticated','public.bridge_member_recipients(uuid[],uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('anon','public.bridge_member_recipients(uuid[],uuid,uuid)','EXECUTE')
 AND has_function_privilege('service_role','public.bridge_member_recipients(uuid[],uuid,uuid)','EXECUTE'),'snapshot recipient filtering service only');
SELECT is(public.bridge_member_recipients(ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('missing'),pg_temp.bid('legacy')],pg_temp.bid('channel'),'22222222-0000-0000-0000-000000000002'),ARRAY[pg_temp.bid('plain')],'snapshot recipients hide opted-out native sources from all bridges');
SELECT is(public.bridge_member_recipients(ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('missing'),pg_temp.bid('legacy'),pg_temp.bid('matrix')],pg_temp.bid('channel'),NULL),ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('legacy')],'null system/bot source unchanged, unknown bots ignored and duplicate IDs collapsed');
SELECT is(public.bridge_member_recipients(ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain')],pg_temp.bid('channel'),'33333333-0000-0000-0000-000000000003'),ARRAY[pg_temp.bid('plain')],'snapshot recipients fail closed on missing native membership');
SELECT is(public.bridge_visible_message_ids(pg_temp.bid('matrix'),ARRAY[pg_temp.bid('bot-message'),pg_temp.bid('bot-message')]),ARRAY[pg_temp.bid('bot-message')],'non-native rows unaffected and deduplicated');
SELECT is(public.bridge_visible_message_ids(pg_temp.bid('matrix'),ARRAY[pg_temp.bid('interaction-reply')]),'{}'::uuid[],'opt-out after initial visibility hides public callback history');
SELECT is(public.bridge_visible_message_ids(pg_temp.bid('legacy'),ARRAY[pg_temp.bid('interaction-reply')]),'{}'::uuid[],'Discord callback history also honors native invoker opt-out');
SELECT is(public.bridge_visible_message_ids(pg_temp.bid('plain'),ARRAY[pg_temp.bid('interaction-reply')]),ARRAY[pg_temp.bid('interaction-reply')],'ordinary bot callback access remains unchanged');
SELECT is(public.bridge_message_recipients(ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('legacy')],pg_temp.bid('interaction-reply')),ARRAY[pg_temp.bid('plain')],'current invoker opt-out hides callback create/update from bridges');
SELECT is(public.bridge_source_recipients(ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('legacy')],pg_temp.bid('channel'),(SELECT source FROM callback_snapshot)),ARRAY[pg_temp.bid('plain')],'previously retained reaction/delete snapshot rechecks current invoker opt-out');
SELECT is(public.bridge_visible_message_ids(pg_temp.bid('matrix'),ARRAY[pg_temp.bid('native-precedence')]),ARRAY[pg_temp.bid('native-precedence')],'native user_id takes precedence over opted-out metadata claim in history');
SELECT is(public.bridge_source_recipients(ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('legacy')],pg_temp.bid('channel'),pg_temp.bridge_source(pg_temp.bid('native-precedence'))),ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('legacy')],'native user_id takes precedence in source snapshots');
SELECT is(public.bridge_source_recipients(ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('legacy')],pg_temp.bid('channel'),pg_temp.bridge_source(pg_temp.bid('bot-message'))),ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('legacy')],'known bot with absent interaction retains prior visibility');
SELECT is(public.bridge_source_recipients(ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('legacy')],pg_temp.bid('channel'),'{"user_id":null,"bot_id":null,"metadata":{}}'),ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('legacy')],'complete known system row is not an unavailable source');
SELECT is(public.bridge_visible_message_ids(pg_temp.bid('matrix'),ARRAY(SELECT pg_temp.bid('interaction-'||k) FROM interaction_cases ORDER BY k)),'{}'::uuid[],'all malformed or missing invokers are denied without UUID casts in history');
SELECT is(public.bridge_visible_message_ids(pg_temp.bid('plain'),ARRAY(SELECT pg_temp.bid('interaction-'||k) FROM interaction_cases ORDER BY k)),ARRAY(SELECT pg_temp.bid('interaction-'||k) FROM interaction_cases ORDER BY k),'malformed callback metadata does not change ordinary bot visibility');
SELECT ok(bool_and(public.bridge_message_recipients(ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('legacy')],pg_temp.bid('interaction-'||k))=ARRAY[pg_temp.bid('plain')]),'all malformed/missing invokers fail closed for live bridge recipients') FROM interaction_cases;
SELECT ok(bool_and(public.bridge_source_recipients(ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('legacy')],pg_temp.bid('channel'),pg_temp.bridge_source(pg_temp.bid('interaction-'||k)))=ARRAY[pg_temp.bid('plain')]),'all malformed/missing invokers fail closed in reaction/delete snapshots') FROM interaction_cases;
SELECT ok(bool_and(public.bridge_source_recipients(ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('legacy'),pg_temp.bid('missing')],pg_temp.bid('channel'),source)=ARRAY[pg_temp.bid('plain')]),'unavailable/incomplete/malformed snapshots deny bridges, retain ordinary bots, and never cast invalid UUIDs')
 FROM (VALUES(NULL::jsonb),('null'::jsonb),('{}'::jsonb),('[]'::jsonb),
 ('{"user_id":null,"bot_id":null}'::jsonb),
 ('{"user_id":"not-uuid","bot_id":null,"metadata":{}}'::jsonb),
 ('{"user_id":null,"bot_id":"not-uuid","metadata":{}}'::jsonb),
 ('{"user_id":null,"bot_id":null,"metadata":[]}'::jsonb)) invalid(source);
RESET ROLE;
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.set_server_bridge_opt_out(pg_temp.bid('server'),false),false,'member opts back in');
SELECT tests.clear_authentication();
SELECT is(public.bridge_message_recipients(ARRAY[pg_temp.bid('matrix'),pg_temp.bid('legacy')],pg_temp.bid('bob-message')),ARRAY[pg_temp.bid('matrix'),pg_temp.bid('legacy')],'opt-in takes effect immediately in recipient batch');
SELECT is(public.bridge_visible_message_ids(pg_temp.bid('matrix'),ARRAY[pg_temp.bid('bob-message')]),ARRAY[pg_temp.bid('bob-message')],'ID filter agrees with batch');
SELECT is(public.bridge_visible_message_ids(pg_temp.bid('matrix'),ARRAY[pg_temp.bid('interaction-reply')]),ARRAY[pg_temp.bid('interaction-reply')],'callback history becomes visible immediately after invoker opt-in');
SELECT is(public.bridge_source_recipients(ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('legacy')],pg_temp.bid('channel'),(SELECT source FROM callback_snapshot)),ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('legacy')],'retained callback snapshot becomes allowed immediately after invoker opt-in');
SELECT is(public.bridge_member_recipients(ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('legacy')],pg_temp.bid('channel'),'22222222-0000-0000-0000-000000000002'),ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('legacy')],'snapshot recipients include opted-in member for normal and bridge bots');
UPDATE public.user_servers SET status='pending' WHERE user_id='22222222-0000-0000-0000-000000000002' AND server_id=pg_temp.bid('server');
SELECT is(public.bridge_message_recipients(ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain')],pg_temp.bid('bob-message')),ARRAY[pg_temp.bid('plain')],'pending native member fails closed for bridges');
SELECT is(public.bridge_message_recipients(ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain')],pg_temp.bid('interaction-reply')),ARRAY[pg_temp.bid('plain')],'pending callback invoker fails closed despite bot authorship');
SELECT is(public.bridge_source_recipients(ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain')],pg_temp.bid('channel'),(SELECT source FROM callback_snapshot)),ARRAY[pg_temp.bid('plain')],'callback source snapshot rechecks current accepted membership');
UPDATE public.user_servers SET status='accepted' WHERE user_id='22222222-0000-0000-0000-000000000002' AND server_id=pg_temp.bid('server');
DELETE FROM public.messages WHERE id=pg_temp.bid('interaction-reply');
SELECT is(public.bridge_source_recipients(ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('legacy')],pg_temp.bid('channel'),(SELECT source FROM callback_snapshot)),ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('legacy')],'reaction/delete snapshot remains usable after parent callback is deleted');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.set_server_bridge_opt_out(pg_temp.bid('server'),true),true,'deleted callback invoker opts out after snapshot capture');
SELECT tests.clear_authentication();
SELECT is(public.bridge_source_recipients(ARRAY[pg_temp.bid('matrix'),pg_temp.bid('plain'),pg_temp.bid('legacy')],pg_temp.bid('channel'),(SELECT source FROM callback_snapshot)),ARRAY[pg_temp.bid('plain')],'deleted-parent snapshot rechecks current opt-out without querying the deleted message');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.set_server_bridge_opt_out(pg_temp.bid('server'),false),false,'restore consent after deleted-parent regression');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.set_server_bridge_opt_out(pg_temp.bid('other'),true),true,'owner may opt out in Discord v2 server');
SELECT tests.clear_authentication();
SELECT ok(NOT public.can_bridge_member_messages(pg_temp.bid('v2'),pg_temp.bid('foreign'),'11111111-0000-0000-0000-000000000001'),'Discord v2 also honors opt-out');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.set_server_bridge_opt_out(pg_temp.bid('other'),false),false,'opt-out is per server');
SELECT tests.clear_authentication();

-- AutoMod: Matrix people are not exempt bots; counters and audit identities are per Matrix ID.
CREATE FUNCTION pg_temp.matrix_say(author text, body text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
 INSERT INTO public.messages(channel_id,bot_id,content,metadata)
 VALUES(pg_temp.bid('channel'),pg_temp.bid('matrix'),jsonb_build_array(jsonb_build_object('type','text','text',body)),
 jsonb_build_object('bridge_author',jsonb_build_object('platform','matrix','id',author,'username','Matrix Person')));
 GET DIAGNOSTICS n=ROW_COUNT; RETURN n;
END;
$$;
CREATE TEMP TABLE result246(k text PRIMARY KEY,n integer); GRANT ALL ON result246 TO service_role;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($$SELECT public.upsert_server_automod_rule(pg_temp.bid('server'),'{"name":"Bridge words","rule_type":"keyword","config":{"keywords":["blockedword"]},"actions":{"block":true,"alert":false}}')$$,'owner adds content rule under default exempt_bots');
SELECT tests.clear_authentication();
UPDATE public.server_automod_rules SET enabled=true WHERE server_id=pg_temp.bid('server') AND rule_type='new_member';
SET LOCAL ROLE service_role;
SELECT throws_ok($$INSERT INTO public.messages(channel_id,bot_id,content,metadata) VALUES(pg_temp.bid('channel'),pg_temp.bid('plain'),'[{"type":"text","text":"fake"}]','{"bridge_author":{"platform":"matrix","id":"@x:example.org","username":"x"}}')$$,'22023',NULL,'ordinary bot cannot forge generic author');
SELECT throws_ok($$INSERT INTO public.messages(channel_id,bot_id,content,metadata) VALUES(pg_temp.bid('channel'),pg_temp.bid('matrix'),'[{"type":"text","text":"fake"}]','{"bridge_author":{"platform":"discord","id":"123","username":"x"}}')$$,'22023',NULL,'Matrix cannot spoof Discord protocol');
SELECT throws_ok($$SELECT pg_temp.matrix_say('not-a-matrix-id','hello')$$,'22023',NULL,'malformed Matrix ID rejected');
SELECT throws_ok($$SELECT pg_temp.matrix_say('@'||repeat('x',500)||':example.org','hello')$$,'22023',NULL,'generic author ID limit matches gateway 512');
SELECT throws_ok($$INSERT INTO public.reactions(message_id,bot_id,custom_emoji_content,metadata) VALUES(pg_temp.bid('bob-message'),pg_temp.bid('plain'),'🎉','{"bridge_author":{"platform":"matrix","id":"@x:example.org","username":"x"}}')$$,'22023',NULL,'ordinary bot reaction cannot forge generic author');
SELECT lives_ok($$INSERT INTO public.reactions(id,message_id,bot_id,custom_emoji_content,metadata) VALUES(pg_temp.bid('matrix-reaction'),pg_temp.bid('bob-message'),pg_temp.bid('matrix'),'🎉','{"bridge_author":{"platform":"matrix","id":"@reactor:example.org","username":"reactor"}}')$$,'registered Matrix reaction validates channel from parent before context population');
SELECT lives_ok($$UPDATE public.reactions SET metadata=jsonb_set(metadata,'{bridge_author,display_name}','"Reactor"') WHERE id=pg_temp.bid('matrix-reaction')$$,'generic reaction update does not access message-only trigger fields');
INSERT INTO public.messages(id,channel_id,user_id,content) VALUES(pg_temp.bid('unpaired-message'),pg_temp.bid('unpaired'),'11111111-0000-0000-0000-000000000001','[{"type":"text","text":"unpaired parent"}]');
SELECT throws_ok($$INSERT INTO public.reactions(message_id,channel_id,bot_id,custom_emoji_content,metadata) VALUES(pg_temp.bid('unpaired-message'),pg_temp.bid('channel'),pg_temp.bid('matrix'),'🎉','{"bridge_author":{"platform":"matrix","id":"@reactor:example.org","username":"reactor"}}')$$,'22023',NULL,'forged reaction channel cannot authorize unpaired parent');
INSERT INTO result246 VALUES('keyword',pg_temp.matrix_say('@keyword:example.org','blockedword'));
INSERT INTO result246 SELECT 'flood',sum(pg_temp.matrix_say('@flood:example.org','unique line '||g))::integer FROM generate_series(1,12) g;
INSERT INTO result246 VALUES('other-author',pg_temp.matrix_say('@other:example.org','another person'));
INSERT INTO result246 VALUES('unknown-age',pg_temp.matrix_say('@young:example.org','https://example.org/'));
RESET ROLE;
SELECT is((SELECT n FROM result246 WHERE k='keyword'),0,'Matrix people meet keyword rules even when bots exempt');
SELECT is((SELECT n FROM result246 WHERE k='flood'),10,'Matrix people meet per-person flood limit');
SELECT is((SELECT n FROM result246 WHERE k='other-author'),1,'different Matrix authors have separate counters');
SELECT is((SELECT n FROM result246 WHERE k='unknown-age'),1,'Matrix ID is never parsed as Discord age');
SELECT ok(EXISTS(SELECT 1 FROM public.automod_events WHERE server_id=pg_temp.bid('server') AND details->>'author_key'='matrix:@flood:example.org'),'audit stores actual Matrix person key');
SELECT is((SELECT count(*)::integer FROM public.server_member_timeouts WHERE server_id=pg_temp.bid('server')),0,'Matrix person cannot timeout native members');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.configure_matrix_bridge(pg_temp.bid('matrix'),pg_temp.bid('server'),'{}'),true,'owner unpairs all Matrix channels');
SELECT tests.clear_authentication();
SELECT is(public.bridge_channel_platform(pg_temp.bid('matrix'),pg_temp.bid('channel')),NULL::text,'unpaired Matrix bot cannot become legacy Discord');
SELECT is((SELECT bridge_platform FROM public.bots WHERE id=pg_temp.bid('matrix')),'matrix','protocol marker survives empty binding set');
SELECT is(public.bridge_channel_platform(pg_temp.bid('legacy'),pg_temp.bid('channel')),'discord','legacy registry unaffected by Matrix unpair');

SELECT * FROM finish();
ROLLBACK;
