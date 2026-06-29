-- Consolidated fixes: ephemeral reaction URLs, federation NULL sender, reaction broadcast.
-- Safe to run after 20260618–20260621 (idempotent CREATE OR REPLACE).

BEGIN;

-- ---------------------------------------------------------------------------
-- Message reaction RPCs: surface URL-only remote emoji from metadata
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_batch_message_reactions(message_ids uuid[])
RETURNS TABLE(
    message_id uuid,
    emoji_id uuid,
    emoji_name character varying,
    emoji_url character varying,
    custom_emoji_content text,
    reaction_count bigint,
    current_user_reacted boolean,
    users jsonb
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        r.message_id,
        r.emoji_id,
        COALESCE(e.name, r.custom_emoji_content)::varchar as emoji_name,
        COALESCE(e.url::text, MAX(r.metadata->>'remote_emoji_url'))::varchar as emoji_url,
        r.custom_emoji_content,
        COUNT(r.id)::bigint as reaction_count,
        bool_or(r.user_id = public.get_current_profile_id()) as current_user_reacted,
        jsonb_agg(
            jsonb_build_object(
                'user_id', r.user_id,
                'bot_id', r.bot_id,
                'metadata', r.metadata
            )
        ) as users
    FROM reactions r
    LEFT JOIN emojis e ON r.emoji_id = e.id
    WHERE r.message_id = ANY(get_batch_message_reactions.message_ids)
    GROUP BY r.message_id, r.emoji_id, e.name, e.url, r.custom_emoji_content
    ORDER BY r.message_id, MIN(r.created_at) ASC;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_message_reactions(message_id uuid)
RETURNS TABLE(count bigint, emoji jsonb, reactions jsonb, current_user_reacted boolean, message_id_of_reactions uuid)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(r.id)::bigint as count,
        CASE
            WHEN r.emoji_id IS NOT NULL THEN
                jsonb_build_object(
                    'id', e.id,
                    'name', e.name,
                    'url', e.url,
                    'is_native', false
                )
            ELSE
                jsonb_build_object(
                    'id', r.custom_emoji_content,
                    'name', COALESCE(
                        NULLIF(MAX(r.metadata->>'remote_emoji_name'), ''),
                        r.custom_emoji_content
                    ),
                    'url', MAX(r.metadata->>'remote_emoji_url'),
                    'content', r.custom_emoji_content,
                    'is_native', (MAX(r.metadata->>'remote_emoji_url') IS NULL)
                )
        END as emoji,
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'user_id', r2.user_id,
                    'bot_id', r2.bot_id,
                    'metadata', r2.metadata,
                    'username', p.username,
                    'display_name', p.display_name,
                    'avatar_url', p.avatar_url
                )
            )
            FROM reactions r2
            LEFT JOIN profiles p ON r2.user_id = p.id
            WHERE r2.message_id = get_message_reactions.message_id
            AND (
                (r2.emoji_id IS NOT DISTINCT FROM r.emoji_id)
                AND (r2.custom_emoji_content IS NOT DISTINCT FROM r.custom_emoji_content)
            )
        ) as reactions,
        bool_or(r.user_id = public.get_current_profile_id()) as current_user_reacted,
        r.message_id as message_id_of_reactions
    FROM reactions r
    LEFT JOIN emojis e ON r.emoji_id = e.id
    WHERE r.message_id = get_message_reactions.message_id
    GROUP BY r.message_id, r.emoji_id, e.id, e.name, e.url, r.custom_emoji_content
    ORDER BY MIN(r.created_at) ASC;
END;
$$;

-- ---------------------------------------------------------------------------
-- Reaction broadcast: safe emoji fields + remote URL metadata
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broadcast_message_reaction_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rec             record;
  v_channel_id      uuid;
  v_conversation_id uuid;
  v_topic           text;
  v_actor           record;
  v_emoji_name      text;
  v_emoji_url       text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_rec := OLD;
  ELSE
    v_rec := NEW;
  END IF;

  v_channel_id := v_rec.channel_id;
  v_conversation_id := v_rec.conversation_id;

  IF v_channel_id IS NULL AND v_conversation_id IS NULL THEN
    SELECT channel_id, conversation_id
      INTO v_channel_id, v_conversation_id
    FROM public.messages WHERE id = v_rec.message_id;
  END IF;

  IF v_conversation_id IS NOT NULL THEN
    v_topic := 'dm-conversation-' || v_conversation_id::text;
  ELSIF v_channel_id IS NOT NULL THEN
    v_topic := 'channel-messages-' || v_channel_id::text;
  ELSE
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT username, display_name, avatar_url
    INTO v_actor
  FROM public.profiles WHERE id = v_rec.user_id;

  IF v_rec.emoji_id IS NOT NULL THEN
    SELECT name, url INTO v_emoji_name, v_emoji_url
    FROM public.emojis WHERE id = v_rec.emoji_id;
  ELSE
    v_emoji_name := COALESCE(v_rec.metadata->>'remote_emoji_name', v_rec.custom_emoji_content);
    v_emoji_url := v_rec.metadata->>'remote_emoji_url';
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'type',                 'reaction:' || lower(TG_OP),
      'op',                   TG_OP,
      'reaction_id',          v_rec.id,
      'message_id',           v_rec.message_id,
      'emoji_id',             v_rec.emoji_id,
      'emoji_name',           v_emoji_name,
      'emoji_url',            v_emoji_url,
      'custom_emoji_content', v_rec.custom_emoji_content,
      'user_id',              v_rec.user_id,
      'bot_id',               v_rec.bot_id,
      'metadata',             COALESCE(v_rec.metadata, '{}'::jsonb),
      'username',             COALESCE(
                                v_rec.metadata->'discord_user'->>'username',
                                v_actor.username
                              ),
      'display_name',         COALESCE(
                                v_rec.metadata->'discord_user'->>'display_name',
                                v_rec.metadata->'discord_user'->>'username',
                                v_actor.display_name
                              ),
      'avatar_url',           COALESCE(
                                v_rec.metadata->'discord_user'->>'avatar_url',
                                v_actor.avatar_url
                              )
    ),
    'reaction_event',
    v_topic,
    true
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'broadcast_message_reaction_event failed: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ---------------------------------------------------------------------------
-- create_federated_emoji: resolve uploader (bot owner or profile), not bot id
-- ---------------------------------------------------------------------------
-- The RETURNS TABLE columns change (old: created_by; new: uploader/scope), so
-- CREATE OR REPLACE cannot alter it in place — drop the old signature first.
DROP FUNCTION IF EXISTS public.create_federated_emoji(text, text, uuid, text);

CREATE OR REPLACE FUNCTION public.create_federated_emoji(
    p_name text,
    p_url text,
    p_created_by uuid,
    p_domain text DEFAULT NULL
)
RETURNS TABLE(id uuid, created_at timestamptz, name text, url text, server_id uuid, uploader uuid, domain text, scope text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    INSERT INTO emojis (name, url, uploader, domain, scope, server_id)
    VALUES (
        p_name,
        p_url,
        COALESCE(
            (SELECT owner_id FROM bots WHERE id = p_created_by),
            CASE
                WHEN EXISTS (SELECT 1 FROM profiles WHERE id = p_created_by) THEN p_created_by
                ELSE NULL
            END
        ),
        p_domain,
        'instance',
        NULL
    )
    RETURNING emojis.id, emojis.created_at, emojis.name::text, emojis.url::text, emojis.server_id,
              emojis.uploader, emojis.domain, emojis.scope;
END;
$$;

-- DROP removed the grant; re-add it (init grants the same signature).
GRANT EXECUTE ON FUNCTION public.create_federated_emoji(text, text, uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
