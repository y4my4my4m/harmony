-- Real manager/service role tests; rolled back. No demo services or state are used.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT no_plan();
GRANT USAGE ON SCHEMA tests TO service_role;
CREATE FUNCTION pg_temp.mid(name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$SELECT md5('matrix-rooms-248-'||name)::uuid$$;
INSERT INTO public.servers(id,name,owner) VALUES
 (pg_temp.mid('server'),'Matrix modes','11111111-0000-0000-0000-000000000001'),
 (pg_temp.mid('other'),'Other matrix modes','11111111-0000-0000-0000-000000000001');
INSERT INTO public.channels(id,server_id,name,type) VALUES
 (pg_temp.mid('channel'),pg_temp.mid('server'),'general',0),
 (pg_temp.mid('second'),pg_temp.mid('server'),'second',0),
 (pg_temp.mid('unregistered'),pg_temp.mid('server'),'unregistered',0),
 (pg_temp.mid('foreign'),pg_temp.mid('other'),'foreign',0);
INSERT INTO public.user_servers(user_id,server_id,status,nickname) VALUES
 ('11111111-0000-0000-0000-000000000001',pg_temp.mid('server'),'accepted',NULL),
 ('22222222-0000-0000-0000-000000000002',pg_temp.mid('server'),'accepted','Server Bob'),
 ('33333333-0000-0000-0000-000000000003',pg_temp.mid('server'),'pending',NULL),
 ('11111111-0000-0000-0000-000000000001',pg_temp.mid('other'),'accepted',NULL);
INSERT INTO public.bots(id,username,owner_id,bot_type) VALUES
 (pg_temp.mid('matrix'),'matrix-modes-248','11111111-0000-0000-0000-000000000001','bot'),
 (pg_temp.mid('other-matrix'),'other-matrix-modes-248','11111111-0000-0000-0000-000000000001','bot'),
 (pg_temp.mid('discord'),'discord-modes-248','11111111-0000-0000-0000-000000000001','bridge');
INSERT INTO public.bot_server_permissions(bot_id,server_id,installed_by,is_active,read_messages,send_messages,allowed_channel_ids) VALUES
 (pg_temp.mid('matrix'),pg_temp.mid('server'),'11111111-0000-0000-0000-000000000001',true,true,true,ARRAY[pg_temp.mid('channel'),pg_temp.mid('second')]),
 (pg_temp.mid('other-matrix'),pg_temp.mid('other'),'11111111-0000-0000-0000-000000000001',true,true,true,ARRAY[pg_temp.mid('foreign')]),
 (pg_temp.mid('discord'),pg_temp.mid('server'),'11111111-0000-0000-0000-000000000001',true,true,true,NULL);

SELECT ok(NOT has_function_privilege('authenticated','public.matrix_bridge_bind_room(uuid,uuid,text,text)','EXECUTE')
 AND NOT has_function_privilege('anon','public.matrix_bridge_bind_room(uuid,uuid,text,text)','EXECUTE')
 AND has_function_privilege('service_role','public.matrix_bridge_bind_room(uuid,uuid,text,text)','EXECUTE'),'bind is service only');
SELECT ok(NOT has_function_privilege('authenticated','public.matrix_bridge_room(uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('anon','public.matrix_bridge_channel_members(uuid,uuid)','EXECUTE')
 AND has_function_privilege('service_role','public.matrix_bridge_channel_members(uuid,uuid)','EXECUTE'),'room and eligible member lookup service only');
SELECT ok(NOT has_function_privilege('service_role','public.get_server_matrix_bridges(uuid)','EXECUTE')
 AND NOT has_function_privilege('anon','public.set_matrix_bridge_sender_mode(uuid,uuid,text)','EXECUTE')
 AND has_function_privilege('authenticated','public.set_matrix_bridge_sender_mode(uuid,uuid,text)','EXECUTE'),'manager functions have no public/service bypass');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.configure_matrix_bridge(pg_temp.mid('matrix'),pg_temp.mid('server'),ARRAY[pg_temp.mid('channel'),pg_temp.mid('second')]),true,'manager registers two channels');
SELECT is(public.configure_matrix_bridge(pg_temp.mid('other-matrix'),pg_temp.mid('other'),ARRAY[pg_temp.mid('foreign')]),true,'manager registers separate server');
SELECT is((SELECT count(*)::integer FROM public.get_server_matrix_bridges(pg_temp.mid('server'))),2,'list contains only requested server registrations');
SELECT is((SELECT sender_mode FROM public.get_server_matrix_bridges(pg_temp.mid('server')) WHERE channel_id=pg_temp.mid('channel')),'relay','existing unbound registration defaults to relay');
SELECT is((SELECT room_id FROM public.get_server_matrix_bridges(pg_temp.mid('server')) WHERE channel_id=pg_temp.mid('channel')),NULL::text,'unbound room is explicitly null');
SELECT throws_ok($$SELECT public.set_matrix_bridge_sender_mode(pg_temp.mid('matrix'),pg_temp.mid('channel'),'invalid')$$,'22023',NULL,'manager cannot set invalid mode');
SELECT throws_ok($$SELECT public.set_matrix_bridge_sender_mode(pg_temp.mid('matrix'),pg_temp.mid('channel'),NULL)$$,'22023',NULL,'manager cannot set null mode');
SELECT throws_ok($$SELECT public.set_matrix_bridge_sender_mode(pg_temp.mid('matrix'),pg_temp.mid('unregistered'),'ghost')$$,'P0002',NULL,'unregistered channel has no mode');
SELECT throws_ok($$UPDATE public.bridge_channels SET sender_mode='ghost' WHERE channel_id=pg_temp.mid('channel')$$,'42501',NULL,'manager cannot bypass mode RPC through direct table writes');
SELECT is(public.set_matrix_bridge_sender_mode(pg_temp.mid('matrix'),pg_temp.mid('channel'),'relay'),jsonb_build_object('bot_id',pg_temp.mid('matrix'),'channel_id',pg_temp.mid('channel'),'channel_name','general','room_id',NULL,'sender_mode','relay'),'explicit pre-bind relay returns canonical row with null room');
SELECT is(public.set_matrix_bridge_sender_mode(pg_temp.mid('matrix'),pg_temp.mid('second'),'ghost'),jsonb_build_object('bot_id',pg_temp.mid('matrix'),'channel_id',pg_temp.mid('second'),'channel_name','second','room_id',NULL,'sender_mode','ghost'),'explicit pre-bind ghost returns canonical row with null room');
SELECT throws_ok($$SELECT public.set_matrix_bridge_sender_mode(pg_temp.mid('discord'),pg_temp.mid('channel'),'ghost')$$,'P0002',NULL,'Discord bot cannot set mode on an unbound Matrix registration');
SELECT throws_ok($$SELECT public.set_matrix_bridge_sender_mode(pg_temp.mid('matrix'),pg_temp.mid('foreign'),'ghost')$$,'P0002',NULL,'wrong server/pair cannot inherit another unbound registration');
SELECT is(public.configure_matrix_bridge(pg_temp.mid('matrix'),pg_temp.mid('server'),ARRAY[pg_temp.mid('channel'),pg_temp.mid('second')]),true,'reconfigure preserves unbound per-pair manager choices');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($$SELECT * FROM public.get_server_matrix_bridges(pg_temp.mid('server'))$$,'42501',NULL,'ordinary member cannot list manager settings');
SELECT throws_ok($$SELECT public.set_matrix_bridge_sender_mode(pg_temp.mid('matrix'),pg_temp.mid('channel'),'ghost')$$,'42501',NULL,'ordinary member cannot change sender mode');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($$SELECT * FROM public.get_server_matrix_bridges(pg_temp.mid('server'))$$,'42501',NULL,'pending/non-manager membership cannot enumerate settings');
SELECT throws_ok($$SELECT public.set_matrix_bridge_sender_mode(pg_temp.mid('matrix'),pg_temp.mid('second'),'relay')$$,'42501',NULL,'pending/non-manager cannot override pre-bind choice');
SELECT tests.clear_authentication();
UPDATE public.bot_server_permissions SET is_active=false WHERE bot_id=pg_temp.mid('matrix');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($$SELECT public.set_matrix_bridge_sender_mode(pg_temp.mid('matrix'),pg_temp.mid('second'),'relay')$$,'P0002',NULL,'disabled install cannot change pre-bind manager choice');
SELECT tests.clear_authentication();
UPDATE public.bot_server_permissions SET is_active=true WHERE bot_id=pg_temp.mid('matrix');
UPDATE public.bots SET is_active=false WHERE id=pg_temp.mid('matrix');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($$SELECT public.set_matrix_bridge_sender_mode(pg_temp.mid('matrix'),pg_temp.mid('second'),'relay')$$,'P0002',NULL,'inactive bot cannot change pre-bind manager choice');
SELECT tests.clear_authentication();
UPDATE public.bots SET is_active=true WHERE id=pg_temp.mid('matrix');

SET LOCAL ROLE service_role;
SELECT is(public.matrix_bridge_room(pg_temp.mid('matrix'),pg_temp.mid('channel')),'{"room_id":null,"sender_mode":"relay"}'::jsonb,'service sees explicit pre-bind relay choice');
SELECT is(public.matrix_bridge_room(pg_temp.mid('matrix'),pg_temp.mid('second')),'{"room_id":null,"sender_mode":"ghost"}'::jsonb,'service sees explicit pre-bind ghost choice');
SELECT is(public.matrix_bridge_bind_room(pg_temp.mid('matrix'),pg_temp.mid('channel'),'!demo:example.org','ghost'),'{"room_id":"!demo:example.org","sender_mode":"relay"}'::jsonb,'explicit pre-bind relay wins over config ghost, even though relay equals legacy default');
SELECT is(public.matrix_bridge_bind_room(pg_temp.mid('matrix'),pg_temp.mid('channel'),'!demo:example.org','ghost')->>'sender_mode','relay','repeat bind cannot overwrite stored explicit manager choice');
SELECT is(public.matrix_bridge_bind_room(pg_temp.mid('matrix'),pg_temp.mid('second'),'!opaqueRoomV12','relay')->>'sender_mode','ghost','explicit pre-bind ghost wins over config relay; opaque v12 room supported');
SELECT is(public.matrix_bridge_bind_room(pg_temp.mid('other-matrix'),pg_temp.mid('foreign'),'!other:example.org')->>'sender_mode','relay','omitted initial mode preserves legacy relay default');
SELECT throws_ok($$SELECT public.matrix_bridge_bind_room(pg_temp.mid('matrix'),pg_temp.mid('channel'),'!different:example.org','ghost')$$,'22023',NULL,'room reassignment requires explicit unpair');
SELECT throws_ok($$SELECT public.matrix_bridge_bind_room(pg_temp.mid('matrix'),pg_temp.mid('channel'),'bad-room','ghost')$$,'22023',NULL,'invalid room rejected');
SELECT throws_ok($$SELECT public.matrix_bridge_bind_room(pg_temp.mid('matrix'),pg_temp.mid('channel'),'!bad/room','ghost')$$,'22023',NULL,'slash in opaque room ID rejected');
SELECT throws_ok($$SELECT public.matrix_bridge_bind_room(pg_temp.mid('matrix'),pg_temp.mid('channel'),'!demo:example.org',NULL)$$,'22023',NULL,'null initial mode rejected');
SELECT throws_ok($$SELECT public.matrix_bridge_room(pg_temp.mid('discord'),pg_temp.mid('channel'))$$,'42501',NULL,'Discord cannot access Matrix binding');
SELECT throws_ok($$SELECT public.matrix_bridge_bind_room(pg_temp.mid('matrix'),pg_temp.mid('foreign'),'!stolen:example.org','relay')$$,'42501',NULL,'cross-server/unregistered pair cannot bind');
SELECT throws_ok($$SELECT * FROM public.matrix_bridge_channel_members(pg_temp.mid('missing'),pg_temp.mid('channel'))$$,'42501',NULL,'unknown bot cannot enumerate native members');
SELECT throws_ok($$SELECT * FROM public.matrix_bridge_channel_members(pg_temp.mid('discord'),pg_temp.mid('channel'))$$,'42501',NULL,'Discord member paths are not generalized by this RPC');
RESET ROLE;

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.set_matrix_bridge_sender_mode(pg_temp.mid('matrix'),pg_temp.mid('channel'),'relay'),jsonb_build_object('bot_id',pg_temp.mid('matrix'),'channel_id',pg_temp.mid('channel'),'channel_name','general','room_id','!demo:example.org','sender_mode','relay'),'mode setter returns canonical full settings object');
SELECT is(public.set_matrix_bridge_sender_mode(pg_temp.mid('matrix'),pg_temp.mid('second'),'ghost')->>'sender_mode','ghost','manager changes a valid bound second pair');
SELECT is(public.configure_matrix_bridge(pg_temp.mid('matrix'),pg_temp.mid('server'),ARRAY[pg_temp.mid('channel'),pg_temp.mid('second')]),true,'routine manager reconfigure succeeds');
SELECT tests.clear_authentication();
SELECT is(public.matrix_bridge_bind_room(pg_temp.mid('matrix'),pg_temp.mid('channel'),'!demo:example.org','ghost')->>'sender_mode','relay','admin relay choice survives reconfigure and service restart');
SELECT is(public.matrix_bridge_room(pg_temp.mid('matrix'),pg_temp.mid('second'))->>'room_id','!opaqueRoomV12','retained second binding survives reconfigure');

-- Two bots on one channel must retain independent modes and rooms.
INSERT INTO public.bot_server_permissions(bot_id,server_id,installed_by,is_active,read_messages,send_messages,allowed_channel_ids)
 VALUES(pg_temp.mid('other-matrix'),pg_temp.mid('server'),'11111111-0000-0000-0000-000000000001',true,true,true,ARRAY[pg_temp.mid('channel')]);
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.configure_matrix_bridge(pg_temp.mid('other-matrix'),pg_temp.mid('server'),ARRAY[pg_temp.mid('channel')]),true,'separate Matrix bot can register same channel explicitly');
SELECT tests.clear_authentication();
SELECT is(public.matrix_bridge_bind_room(pg_temp.mid('other-matrix'),pg_temp.mid('channel'),'!parallel:example.org','ghost')->>'sender_mode','ghost','second explicit registration has its own room');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.set_matrix_bridge_sender_mode(pg_temp.mid('other-matrix'),pg_temp.mid('channel'),'relay')->>'bot_id',pg_temp.mid('other-matrix')::text,'setter returns exact targeted pair, not first bot on channel');
SELECT is(public.set_matrix_bridge_sender_mode(pg_temp.mid('matrix'),pg_temp.mid('channel'),'ghost')->>'sender_mode','ghost','first pair mode changes independently');
SELECT throws_ok($$SELECT public.set_matrix_bridge_sender_mode(pg_temp.mid('other-matrix'),pg_temp.mid('second'),'relay')$$,'P0002',NULL,'wrong bot cannot address another registered pair');
SELECT tests.clear_authentication();
SELECT is(public.matrix_bridge_room(pg_temp.mid('other-matrix'),pg_temp.mid('channel'))->>'sender_mode','relay','changing first pair leaves second pair mode untouched');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.configure_matrix_bridge(pg_temp.mid('other-matrix'),pg_temp.mid('server'),'{}'),true,'manager explicitly removes second bot pair');
SELECT tests.clear_authentication();
SELECT is(public.matrix_bridge_room(pg_temp.mid('matrix'),pg_temp.mid('channel'))->>'sender_mode','ghost','unpairing second bot leaves first pair mode untouched');
SELECT is(public.matrix_bridge_room(pg_temp.mid('other-matrix'),pg_temp.mid('foreign'))->>'room_id','!other:example.org','unpairing one server preserves other server registration');

-- Members are native profiles, accepted, opted in and able to view this channel.
UPDATE public.profiles SET avatar_url='/avatars/bob.webp' WHERE id='22222222-0000-0000-0000-000000000002';
SELECT is((SELECT array_agg(id ORDER BY id) FROM public.matrix_bridge_channel_members(pg_temp.mid('matrix'),pg_temp.mid('channel'))),ARRAY['11111111-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000002']::uuid[],'eligible roster includes accepted owner/member, not pending membership');
SELECT is((SELECT display_name FROM public.matrix_bridge_channel_members(pg_temp.mid('matrix'),pg_temp.mid('channel')) WHERE id='22222222-0000-0000-0000-000000000002'),'Server Bob','server nickname is effective display name');
SELECT is((SELECT nickname FROM public.matrix_bridge_channel_members(pg_temp.mid('matrix'),pg_temp.mid('channel')) WHERE id='22222222-0000-0000-0000-000000000002'),'Server Bob','native nickname also returned separately');
SELECT is((SELECT username FROM public.matrix_bridge_channel_members(pg_temp.mid('matrix'),pg_temp.mid('channel')) WHERE id='22222222-0000-0000-0000-000000000002'),'bob','stable native username remains distinct from display name');
SELECT is((SELECT avatar_url FROM public.matrix_bridge_channel_members(pg_temp.mid('matrix'),pg_temp.mid('channel')) WHERE id='22222222-0000-0000-0000-000000000002'),'/avatars/bob.webp','native avatar path returned without unsafe URL rewriting');
SELECT is((SELECT domain FROM public.matrix_bridge_channel_members(pg_temp.mid('matrix'),pg_temp.mid('channel')) WHERE id='22222222-0000-0000-0000-000000000002'),(SELECT domain FROM public.profiles WHERE id='22222222-0000-0000-0000-000000000002'),'native domain returned unchanged');
SELECT is((SELECT is_local FROM public.matrix_bridge_channel_members(pg_temp.mid('matrix'),pg_temp.mid('channel')) WHERE id='22222222-0000-0000-0000-000000000002'),true,'local/native flag included');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.set_server_bridge_opt_out(pg_temp.mid('server'),true),true,'native member opts out');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::integer FROM public.matrix_bridge_channel_members(pg_temp.mid('matrix'),pg_temp.mid('channel'))),1,'opted-out member is absent from ghost-sync roster');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.set_server_bridge_opt_out(pg_temp.mid('server'),false),false,'native member opts back in');
SELECT tests.clear_authentication();
INSERT INTO public.channel_permission_overrides(channel_id,target_type,user_id,allow_permissions,deny_permissions)
 VALUES(pg_temp.mid('channel'),'user','22222222-0000-0000-0000-000000000002',0,2);
SELECT ok(NOT public.can_view_channel('22222222-0000-0000-0000-000000000002',pg_temp.mid('channel')),'fixture denies VIEW_CHANNEL');
SELECT is((SELECT count(*)::integer FROM public.matrix_bridge_channel_members(pg_temp.mid('matrix'),pg_temp.mid('channel'))),1,'member who cannot view channel is absent');
DELETE FROM public.channel_permission_overrides WHERE channel_id=pg_temp.mid('channel');
UPDATE public.profiles SET is_local=false WHERE id='22222222-0000-0000-0000-000000000002';
SELECT is((SELECT count(*)::integer FROM public.matrix_bridge_channel_members(pg_temp.mid('matrix'),pg_temp.mid('channel'))),1,'remote profile is not a native ghost target');
UPDATE public.profiles SET is_local=true,deleted_at=now() WHERE id='22222222-0000-0000-0000-000000000002';
SELECT is((SELECT count(*)::integer FROM public.matrix_bridge_channel_members(pg_temp.mid('matrix'),pg_temp.mid('channel'))),1,'tombstoned account is not ghost-synced');
UPDATE public.profiles SET deleted_at=NULL WHERE id='22222222-0000-0000-0000-000000000002';
UPDATE public.user_servers SET status='banned' WHERE user_id='22222222-0000-0000-0000-000000000002' AND server_id=pg_temp.mid('server');
SELECT is((SELECT count(*)::integer FROM public.matrix_bridge_channel_members(pg_temp.mid('matrix'),pg_temp.mid('channel'))),1,'banned member is absent');
UPDATE public.bot_server_permissions SET is_active=false WHERE bot_id=pg_temp.mid('matrix');
SELECT throws_ok($$SELECT public.matrix_bridge_room(pg_temp.mid('matrix'),pg_temp.mid('channel'))$$,'42501',NULL,'disabled install blocks room lookup');
SELECT throws_ok($$SELECT public.matrix_bridge_bind_room(pg_temp.mid('matrix'),pg_temp.mid('channel'),'!demo:example.org','relay')$$,'42501',NULL,'disabled install blocks bind/report');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($$SELECT public.set_matrix_bridge_sender_mode(pg_temp.mid('matrix'),pg_temp.mid('channel'),'ghost')$$,'P0002',NULL,'manager cannot change mode for disabled pair');
SELECT tests.clear_authentication();
SELECT throws_ok($$SELECT * FROM public.matrix_bridge_channel_members(pg_temp.mid('matrix'),pg_temp.mid('channel'))$$,'42501',NULL,'disabled install blocks roster disclosure');
UPDATE public.bot_server_permissions SET is_active=true WHERE bot_id=pg_temp.mid('matrix');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.configure_matrix_bridge(pg_temp.mid('matrix'),pg_temp.mid('server'),ARRAY[pg_temp.mid('second')]),true,'manager explicitly unpairs first channel');
SELECT tests.clear_authentication();
SELECT throws_ok($$SELECT public.matrix_bridge_room(pg_temp.mid('matrix'),pg_temp.mid('channel'))$$,'42501',NULL,'unpaired room lookup fails closed');
SELECT throws_ok($$SELECT public.matrix_bridge_bind_room(pg_temp.mid('matrix'),pg_temp.mid('channel'),'!new:example.org','relay')$$,'42501',NULL,'service cannot recreate a manager-unpaired binding');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.configure_matrix_bridge(pg_temp.mid('matrix'),pg_temp.mid('server'),ARRAY[pg_temp.mid('channel'),pg_temp.mid('second')]),true,'manager explicitly re-pairs channel');
SELECT tests.clear_authentication();
SELECT is((SELECT sender_mode_set_by_manager FROM public.bridge_channels WHERE bot_id=pg_temp.mid('matrix') AND channel_id=pg_temp.mid('channel')),false,'explicit unpair/re-pair resets manager-choice marker');
SELECT is(public.matrix_bridge_bind_room(pg_temp.mid('matrix'),pg_temp.mid('channel'),'!new:example.org','relay'),'{"room_id":"!new:example.org","sender_mode":"relay"}'::jsonb,'explicit unpair/re-pair permits new room/config mode, discarding former admin ghost choice');
SELECT is(public.matrix_bridge_room(pg_temp.mid('matrix'),pg_temp.mid('second'))->>'sender_mode','ghost','unpairing another channel preserves retained admin choice');

SELECT * FROM finish();
ROLLBACK;
