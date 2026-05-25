BEGIN;

-- Fix @everyone role permissions for ALL servers
-- The old default value (104324161) incorrectly included:
--   ADMINISTRATOR (bit 0), MANAGE_WEBHOOKS (bit 6), BAN_MEMBERS (bit 10),
--   TIMEOUT_MEMBERS (bit 11), MENTION_EVERYONE (bit 20), MANAGE_MESSAGES (bit 21)
-- and was missing:
--   VIEW_CHANNEL (bit 1), CREATE_INVITE (bit 8), SEND_MESSAGES_IN_THREADS (bit 13),
--   USE_EXTERNAL_EMOJIS (bit 19), READ_MESSAGE_HISTORY (bit 22), CONNECT (bit 24)
--
-- New correct default: 122646786
-- Includes: VIEW_CHANNEL, CREATE_INVITE, SEND_MESSAGES, SEND_MESSAGES_IN_THREADS,
--   CREATE_PUBLIC_THREADS, EMBED_LINKS, ATTACH_FILES, ADD_REACTIONS,
--   USE_EXTERNAL_EMOJIS, READ_MESSAGE_HISTORY, CONNECT, SPEAK, STREAM

-- Step 1: Fix @everyone roles that still have the exact broken default value
UPDATE public.server_roles
SET permissions = 122646786
WHERE is_default = true
  AND permissions = 104324161;

-- Step 2: For any @everyone role that was customized but still has ADMINISTRATOR bit set,
-- clear the ADMINISTRATOR bit (bit 0). @everyone should NEVER have ADMINISTRATOR.
UPDATE public.server_roles
SET permissions = permissions & ~(1::bigint)
WHERE is_default = true
  AND (permissions & 1::bigint) != 0;

-- Also update the trigger function to use the correct default
CREATE OR REPLACE FUNCTION public.create_default_server_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    everyone_role_id uuid;
    admin_role_id uuid;
BEGIN
    -- Create @everyone role (default for all members)
    INSERT INTO server_roles (
        server_id,
        name,
        color,
        position,
        is_default,
        is_admin,
        permissions
    ) VALUES (
        NEW.id,
        'everyone',
        '#99AAB5',
        0,
        true,
        false,
        122646786  -- Default permissions: VIEW_CHANNEL, CREATE_INVITE, SEND_MESSAGES, SEND_MESSAGES_IN_THREADS, CREATE_PUBLIC_THREADS, EMBED_LINKS, ATTACH_FILES, ADD_REACTIONS, USE_EXTERNAL_EMOJIS, READ_MESSAGE_HISTORY, CONNECT, SPEAK, STREAM
    ) RETURNING id INTO everyone_role_id;
    
    -- Create Admin role for the owner (highest position, all permissions)
    INSERT INTO server_roles (
        server_id,
        name,
        color,
        position,
        is_default,
        is_admin,
        permissions
    ) VALUES (
        NEW.id,
        'Admin',
        '#e74c3c',
        999,
        false,
        true,
        2199023255551  -- All permissions (ADMINISTRATOR)
    ) RETURNING id INTO admin_role_id;
    
    -- Assign the Admin role to the server owner
    INSERT INTO user_roles (user_id, role_id, server_id)
    VALUES (NEW.owner, admin_role_id, NEW.id)
    ON CONFLICT (user_id, role_id) DO NOTHING;
    
    RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
