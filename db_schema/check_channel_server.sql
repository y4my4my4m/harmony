-- Check which server the bridged channel is in
SELECT 
    c.id as channel_id,
    c.name as channel_name,
    s.id as server_id,
    s.name as server_name,
    s.owner as server_owner_id
FROM public.channels c
JOIN public.servers s ON s.id = c.server_id
WHERE c.id = '2015a5fc-4b53-4e83-90aa-f6caee35fa05';

-- Check if bot has permissions for that server
SELECT 
    'Bot has permissions for this server:' as status,
    bsp.send_messages,
    bsp.is_active
FROM public.bot_server_permissions bsp
JOIN public.bots b ON b.id = bsp.bot_id
JOIN public.channels c ON c.server_id = bsp.server_id
WHERE b.username = 'discord-bridge'
AND c.id = '2015a5fc-4b53-4e83-90aa-f6caee35fa05';

