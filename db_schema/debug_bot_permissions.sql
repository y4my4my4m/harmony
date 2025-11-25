-- Check what's actually in the bot_server_permissions table for your bot
SELECT 
    bsp.id,
    b.username as bot_username,
    s.name as server_name,
    bsp.read_messages,
    bsp.send_messages,
    bsp.manage_messages,
    bsp.embed_links,
    bsp.attach_files,
    bsp.is_active
FROM public.bot_server_permissions bsp
JOIN public.bots b ON b.id = bsp.bot_id
JOIN public.servers s ON s.id = bsp.server_id
WHERE b.username = 'discord-bridge'
ORDER BY bsp.installed_at DESC;

