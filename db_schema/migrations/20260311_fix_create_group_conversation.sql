BEGIN;

-- Drop the old overload that uses (creator_user_id, participant_user_ids, conversation_name, is_private)
DROP FUNCTION IF EXISTS public.create_group_conversation(uuid, uuid[], text, boolean);

-- Drop the stale overload that uses (creator_user_id, conversation_name, participant_ids, initial_metadata)
-- (note the different parameter order from the one we want)
DROP FUNCTION IF EXISTS public.create_group_conversation(uuid, text, uuid[], jsonb);

-- Drop the init-era overload that uses (creator_user_id, participant_ids, conversation_name, initial_metadata)
DROP FUNCTION IF EXISTS public.create_group_conversation(uuid, uuid[], text, jsonb);

-- Drop unused dead function (never called from frontend or backend)
DROP FUNCTION IF EXISTS public.create_or_get_multi_conversation(uuid[], text, text, uuid);

-- Recreate with proper parameter names (p_ prefix per conventions)
CREATE OR REPLACE FUNCTION public.create_group_conversation(
    p_creator_user_id uuid,
    p_participant_ids uuid[] DEFAULT '{}',
    p_conversation_name text DEFAULT NULL,
    p_is_private boolean DEFAULT true
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_conversation_id uuid;
    v_participant_id uuid;
BEGIN
    -- SECURITY: Verify the caller is the creator
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = p_creator_user_id AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: You can only create conversations as yourself';
    END IF;

    INSERT INTO conversations (type, name, created_by, metadata)
    VALUES (
        'group',
        p_conversation_name,
        p_creator_user_id,
        jsonb_build_object('is_private', p_is_private)
    )
    RETURNING id INTO v_conversation_id;

    -- Add creator as admin
    INSERT INTO conversation_participants (conversation_id, user_id, role)
    VALUES (v_conversation_id, p_creator_user_id, 'admin');

    -- Add other participants
    IF p_participant_ids IS NOT NULL THEN
        FOREACH v_participant_id IN ARRAY p_participant_ids
        LOOP
            IF v_participant_id != p_creator_user_id THEN
                INSERT INTO conversation_participants (conversation_id, user_id, role)
                VALUES (v_conversation_id, v_participant_id, 'member')
                ON CONFLICT (conversation_id, user_id) DO NOTHING;
            END IF;
        END LOOP;
    END IF;

    RETURN v_conversation_id;
END;
$$;

-- Ensure RPC access
GRANT EXECUTE ON FUNCTION public.create_group_conversation(uuid, uuid[], text, boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
