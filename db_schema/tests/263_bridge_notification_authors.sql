-- Notification triggers snapshot the trusted author, never unrelated private metadata.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT no_plan();
GRANT USAGE ON SCHEMA tests TO service_role;
CREATE FUNCTION pg_temp.nid(name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$SELECT md5('bridge-notifications-247-'||name)::uuid$$;
CREATE FUNCTION pg_temp.author247() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT '{"platform":"matrix","id":"@sam:example.org","username":"sam","display_name":"Sam (Matrix)","avatar_url":"https://example.org/avatars/sam.png"}'::jsonb;
$$;
INSERT INTO public.bots(id,username,display_name,owner_id,bot_type,bridge_platform) VALUES
 (pg_temp.nid('matrix'),'matrix-notifications-247','Bridge Bot','11111111-0000-0000-0000-000000000001','bridge','matrix'),
 (pg_temp.nid('legacy'),'legacy-notifications-247','Legacy Bot','11111111-0000-0000-0000-000000000001','bridge',NULL),
 (pg_temp.nid('plain'),'plain-notifications-247','Plain Bot','11111111-0000-0000-0000-000000000001','bot',NULL);
INSERT INTO public.bot_server_permissions(bot_id,server_id,installed_by,read_messages,send_messages,mention_everyone,is_active,allowed_channel_ids)
 SELECT pg_temp.nid(n),'55555555-0000-0000-0000-000000000005','11111111-0000-0000-0000-000000000001',true,true,true,true,ARRAY['66666666-0000-0000-0000-000000000006']::uuid[]
 FROM unnest(ARRAY['matrix','legacy','plain']) n;
INSERT INTO public.bridge_channels VALUES(pg_temp.nid('matrix'),'66666666-0000-0000-0000-000000000006','matrix');
INSERT INTO public.server_settings(server_id,default_message_notifications)
 VALUES('55555555-0000-0000-0000-000000000005','all')
 ON CONFLICT(server_id) DO UPDATE SET default_message_notifications='all';
INSERT INTO public.threads(id,channel_id,name,created_by,parent_message_id) VALUES
 (pg_temp.nid('thread'),'66666666-0000-0000-0000-000000000006','Notification thread','11111111-0000-0000-0000-000000000001','88888888-0000-0000-0000-000000000008');
INSERT INTO public.thread_members(thread_id,user_id) VALUES(pg_temp.nid('thread'),'22222222-0000-0000-0000-000000000002') ON CONFLICT DO NOTHING;

SET LOCAL ROLE service_role;
INSERT INTO public.messages(id,channel_id,bot_id,content,metadata) VALUES
 (pg_temp.nid('channel'),'66666666-0000-0000-0000-000000000006',pg_temp.nid('matrix'),'[{"type":"text","text":"Matrix channel hello"}]',jsonb_build_object('bridge_author',pg_temp.author247(),'private_custom','not a notification field')),
 (pg_temp.nid('mention'),'66666666-0000-0000-0000-000000000006',pg_temp.nid('matrix'),'[{"type":"mention","userId":"22222222-0000-0000-0000-000000000002","username":"bob"}]',jsonb_build_object('bridge_author',pg_temp.author247())),
 (pg_temp.nid('role'),'66666666-0000-0000-0000-000000000006',pg_temp.nid('matrix'),jsonb_build_array(jsonb_build_object('type','role_mention','roleId',(SELECT id FROM public.server_roles WHERE server_id='55555555-0000-0000-0000-000000000005' AND is_default))),jsonb_build_object('bridge_author',pg_temp.author247()));
INSERT INTO public.messages(id,channel_id,thread_id,bot_id,content,metadata) VALUES
 (pg_temp.nid('reply'),'66666666-0000-0000-0000-000000000006',pg_temp.nid('thread'),pg_temp.nid('matrix'),'[{"type":"text","text":"Matrix thread hello"}]',jsonb_build_object('bridge_author',pg_temp.author247()));
INSERT INTO public.messages(id,channel_id,bot_id,content,metadata) VALUES
 (pg_temp.nid('legacy-message'),'66666666-0000-0000-0000-000000000006',pg_temp.nid('legacy'),'[{"type":"text","text":"Legacy hello"}]','{"discord_user":{"id":"123456789","username":"discordsam","display_name":"Discord Sam","avatar_url":"https://example.org/discord.png"}}'),
 (pg_temp.nid('plain-message'),'66666666-0000-0000-0000-000000000006',pg_temp.nid('plain'),'[{"type":"text","text":"Plain hello"}]','{}');
RESET ROLE;

SELECT ok(EXISTS(SELECT 1 FROM public.notifications WHERE type='channel_message' AND data->>'message_id'=pg_temp.nid('channel')::text),'real channel notification created');
SELECT ok(EXISTS(SELECT 1 FROM public.notifications WHERE type='mention' AND data->>'message_id'=pg_temp.nid('mention')::text),'real direct mention notification created');
SELECT ok(EXISTS(SELECT 1 FROM public.notifications WHERE type='mention' AND data->>'message_id'=pg_temp.nid('role')::text AND data->>'is_role_mention'='true'),'real role mention notification created');
SELECT ok(EXISTS(SELECT 1 FROM public.notifications WHERE type='thread_reply' AND data->>'message_id'=pg_temp.nid('reply')::text),'real thread notification created');
SELECT ok(NOT EXISTS(SELECT 1 FROM public.notifications WHERE data->>'message_id'=ANY(ARRAY[pg_temp.nid('channel'),pg_temp.nid('mention'),pg_temp.nid('role'),pg_temp.nid('reply')]::text[])
 AND data#>'{message,metadata,bridge_author}' IS DISTINCT FROM pg_temp.author247()),'all four notification builders snapshot authoritative generic author on message');
SELECT ok(NOT EXISTS(SELECT 1 FROM public.notifications WHERE data->>'message_id'=ANY(ARRAY[pg_temp.nid('channel'),pg_temp.nid('mention'),pg_temp.nid('role'),pg_temp.nid('reply')]::text[])
 AND data#>'{sender,metadata,bridge_author}' IS DISTINCT FROM pg_temp.author247()),'all four share the generic sender author helper');
SELECT is((SELECT data#>>'{sender,display_name}' FROM public.notifications WHERE data->>'message_id'=pg_temp.nid('channel')::text LIMIT 1),'Sam (Matrix)','notification sender names Matrix person, not bot');
SELECT is((SELECT data#>>'{sender,handle}' FROM public.notifications WHERE data->>'message_id'=pg_temp.nid('channel')::text LIMIT 1),'@sam:example.org','Matrix handle remains complete MXID');
SELECT is((SELECT data#>>'{sender,avatar_url}' FROM public.notifications WHERE data->>'message_id'=pg_temp.nid('channel')::text LIMIT 1),'https://example.org/avatars/sam.png','trusted avatar preserved');
SELECT ok(NOT EXISTS(SELECT 1 FROM public.notifications WHERE data->>'message_id'=pg_temp.nid('channel')::text AND data::text LIKE '%private_custom%'),'custom/private metadata not copied');
SELECT is((SELECT data#>>'{sender,display_name}' FROM public.notifications WHERE data->>'message_id'=pg_temp.nid('legacy-message')::text LIMIT 1),'Discord Sam','legacy Discord sender display name preserved');
SELECT is((SELECT data#>>'{sender,handle}' FROM public.notifications WHERE data->>'message_id'=pg_temp.nid('legacy-message')::text LIMIT 1),'@discordsam','legacy Discord handle preserved');
SELECT is((SELECT data#>>'{sender,display_name}' FROM public.notifications WHERE data->>'message_id'=pg_temp.nid('plain-message')::text LIMIT 1),'Plain Bot','ordinary bot sender unchanged');
SELECT is(public.message_notification_sender_json('11111111-0000-0000-0000-000000000001',pg_temp.nid('matrix'),jsonb_build_object('bridge_author',pg_temp.author247()),(SELECT p FROM public.profiles p WHERE id='11111111-0000-0000-0000-000000000001'))->>'display_name','Alice','native profile remains preferred over metadata');
SELECT is(public.message_notification_sender_json(NULL,pg_temp.nid('legacy'),'{"bridge_author":{"platform":"discord","id":"123456789","username":"genericdiscord","display_name":"Generic Discord"}}',NULL)->>'display_name','Generic Discord','generic Discord author understood too');

SELECT * FROM finish();
ROLLBACK;
