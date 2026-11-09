-- Quiet import: a transaction-local flag that makes inserts of imported Discord history leave no
-- side effects. The import function (a later migration) runs
--   set_config('harmony.history_import', 'true', true)
-- and inserts its rows; every trigger below that would notify, count unread, federate, broadcast,
-- moderate or move "last activity" returns early. The flag is read only through
-- public.is_history_import(), except in three trigger functions that run as the calling role
-- (automod_message_guard, handle_messages_updated_at, update_threads_updated_at): a client role
-- cannot execute is_history_import(), so they read the setting directly, as they already do for
-- harmony.silent_content_update. No client can set it: set_config is not reachable through the API,
-- and the import function is granted to the service role alone.
--
-- Last activity (spec, "Quiet import") lives in message_heads (message_seq, last_message_id,
-- last_message_at, written by the unread triggers) and in threads (last_message_id, last_message_at,
-- updated_at, archived). Channels have no last-message column. Backdated rows must not move any of
-- them, so the unread triggers are skipped whole and thread_message_handler counts the reply
-- without touching them.
--
-- Trigger audit. Every non-internal trigger on public.messages and public.threads, plus the
-- triggers on public.notifications that a message insert can reach.
--
--   SKIP = returns at the top under the flag. KEEP = unchanged.
--
-- public.messages
--   a_messages_attach_files              enforce_message_attach_files          KEEP  validation
--   a_messages_client_write_guard        guard_message_client_write            KEEP  permission guard
--   a_messages_content_emoji_parts       check_content_emoji_parts             KEEP  validation
--   a_messages_content_permissions       enforce_message_content_permissions   KEEP  permission guard
--   a_messages_deleted_recipient_guard   refuse_message_to_deleted_recipient   KEEP  integrity (DMs)
--   a_messages_media_path_guard          guard_message_media_paths             KEEP  media guard
--   a_messages_poll_guard                guard_message_poll_parts              KEEP  validation
--   a_messages_reply_scope               enforce_message_reply_scope           KEEP  integrity
--   a_messages_rules_acceptance          enforce_server_rules_acceptance       KEEP  permission guard
--   a_messages_server_suspension_guard   refuse_message_in_suspended_server    KEEP  integrity
--   a_messages_system_part_guard         refuse_client_system_parts            KEEP  validation
--   a_messages_system_row_guard          guard_system_message_removal          KEEP  integrity (update/delete)
--   check_message_sticker_parts          check_message_sticker_parts           KEEP  validation
--   handle_updated_at                    handle_messages_updated_at            CHANGED  on INSERT under the flag keeps a
--                                                                                   supplied updated_at >= created_at
--   smart_route_channel_message          route_channel_message                 KEEP  no-op (comment only)
--   trg_enforce_channel_encryption       enforce_channel_message_encryption    KEEP  integrity
--   trg_enforce_conversation_encryption  enforce_conversation_message_encryption  KEEP  integrity
--   trg_enforce_message_length           enforce_message_length                KEEP  validation
--   trg_handle_message_federation        handle_message_federation             SKIP  mention and DM notifications
--   trg_moderate_message                 automod_message_guard                 SKIP  AutoMod (also writes its activity log)
--   trg_newcomer_first_message           handle_newcomer_first_message         SKIP  staff alert and server_first_messages
--   trg_process_local_link_previews      process_local_link_previews           SKIP  link-preview fetch
--   trg_profile_message_counter_del      tg_profile_message_counter            KEEP  derived count (delete)
--   trg_profile_message_counter_ins      tg_profile_message_counter            KEEP  derived count; bot rows have no profile
--   trg_role_mention_permission          enforce_message_role_mentions         KEEP  permission guard
--   trigger_broadcast_message_delete     broadcast_message_event               SKIP  realtime (one function, all three)
--   trigger_broadcast_message_insert     broadcast_message_event               SKIP  realtime
--   trigger_broadcast_message_update     broadcast_message_event               SKIP  realtime
--   trigger_enforce_channel_slowmode     enforce_channel_slowmode              SKIP  slowmode
--   trigger_federate_channel_message     trigger_queue_channel_message_federation  SKIP  federation; row set to 'skipped'
--   trigger_federate_channel_message_delete  trigger_queue_channel_message_delete_federation  SKIP  federation
--   trigger_federate_channel_message_edit    trigger_queue_channel_message_edit_federation    SKIP  federation
--   trigger_federate_dm                  trigger_queue_dm_federation           SKIP  federation; row set to 'skipped'
--   trigger_index_message                index_message                         KEEP  search index (import must be findable)
--   trigger_new_dm_unread                handle_new_dm_unread                  SKIP  unread, message_heads, realtime
--   trigger_new_message_unread           handle_new_message_unread             SKIP  unread, message_heads (last activity), realtime
--   trigger_remove_message_index         remove_message_from_index             KEEP  search index (delete)
--   trigger_role_mention_notifications   handle_role_mention_notifications     SKIP  role, @everyone and @here notifications
--   trigger_thread_message_delete        thread_message_delete_handler         KEEP  derived thread data; recomputes from real rows
--   trigger_thread_message_insert        thread_message_handler                CHANGED  member and message counts kept;
--                                                                                     last message, updated_at, unarchive skipped
--   trigger_thread_reply_notification    handle_thread_reply_notification      SKIP  thread reply notifications
--   trigger_unpin_on_delete              handle_pinned_message_delete          KEEP  integrity
--   z_messages_channel_message_notifications  handle_channel_message_notifications  SKIP  channel-level notifications
--   z_messages_drive_name                drive_name_from_message               KEEP  derived name of the author's own upload; bot rows return
--   z_messages_empty_thread_delete       delete_emptied_thread                 KEEP  integrity (delete)
--   z_messages_media_cleanup             queue_message_media_cleanup           KEEP  storage hygiene (update/delete)
--   z_messages_moderator_delete_audit    server_audit_message_delete           KEEP  audit (delete)
--   z_messages_pin_federation            trigger_queue_channel_pin_federation  SKIP  federation of pins
--
-- public.threads
--   sanitize_thread_name_trigger         sanitize_entity_name                  KEEP  validation
--   trg_broadcast_thread_change          broadcast_thread_change               SKIP  realtime
--   trigger_federate_thread              trigger_queue_thread_federation       SKIP  federation; row set to 'skipped'
--   trigger_federate_thread_delete       trigger_queue_thread_delete_federation  SKIP  federation
--   trigger_threads_updated_at           update_threads_updated_at             SKIP  last activity: updated_at stays as supplied
--
-- public.notifications (reached only through a notification, which no skipped trigger creates; guarded
-- as a second line)
--   trigger_send_push_notification       trigger_queue_push_notification       SKIP  push job
--   trg_redact_encrypted_notification_preview  redact_encrypted_notification_preview  KEEP  privacy
--                                                                  redaction; it has no side effect, and skipping it would
--                                                                  only matter if an encrypted preview were ever created
--   trg_broadcast_notification, trg_broadcast_notification_delete, trg_queue_push_dismissal_on_*,
--   trigger_increment_unread_mentions: KEEP (they act on notification rows, which are never inserted
--   under the flag; a notification created under it by mistake would still be delivered, so the
--   senders above are the guard)
--
-- Later edits, deletions and pins of an imported message by a user, outside the flag, behave as for
-- any message.

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.is_history_import()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(current_setting('harmony.history_import', true) = 'true', false);
$$;

REVOKE ALL ON FUNCTION public.is_history_import() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_history_import() TO service_role;

-- On INSERT under the flag a supplied updated_at survives when it is not before created_at (the
-- Discord edit time). A value equal to now() is the column default, not a supplied one. Everything
-- else is unchanged.
CREATE OR REPLACE FUNCTION public.handle_messages_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Read inline: this trigger function runs as the caller, who cannot execute the flag reader.
        IF current_setting('harmony.history_import', true) = 'true'
           AND NEW.updated_at > COALESCE(NEW.created_at, NOW())
           AND NEW.updated_at <> NOW() THEN
            RETURN NEW;
        END IF;
        NEW.updated_at := COALESCE(NEW.created_at, NOW());
        RETURN NEW;
    END IF;

    -- Bridge attachment URL refresh: patch content without "(edited)" badge.
    IF current_setting('harmony.silent_content_update', true) = 'true' THEN
        NEW.updated_at := OLD.updated_at;
        RETURN NEW;
    END IF;

    IF OLD.content IS DISTINCT FROM NEW.content
       OR (NEW.is_deleted IS TRUE AND OLD.is_deleted IS NOT TRUE) THEN
        NEW.updated_at := NOW();
    END IF;
    RETURN NEW;
END;
$function$;

-- A reply under the flag is counted (message_count, member_count, thread_members) but moves
-- nothing else: not the last message, updated_at, nor the archived state of an imported thread.
CREATE OR REPLACE FUNCTION public.thread_message_handler()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF NEW.thread_id IS NOT NULL THEN
        -- A bot author has no profile to enrol.
        IF NEW.user_id IS NOT NULL THEN
            INSERT INTO public.thread_members (thread_id, user_id)
            VALUES (NEW.thread_id, NEW.user_id)
            ON CONFLICT (thread_id, user_id) DO NOTHING;
        END IF;
        IF public.is_history_import() THEN
            UPDATE public.threads
            SET message_count = message_count + 1
            WHERE id = NEW.thread_id;
        ELSE
            UPDATE public.threads
            SET
                message_count = message_count + 1,
                last_message_id = NEW.id,
                last_message_at = NEW.created_at,
                updated_at = NOW(),
                archived = CASE WHEN locked THEN archived ELSE false END,
                archived_at = CASE WHEN locked THEN archived_at ELSE NULL END
            WHERE id = NEW.thread_id;
        END IF;
        UPDATE public.threads t
        SET member_count = (
            SELECT COUNT(*) FROM public.thread_members tm WHERE tm.thread_id = t.id
        )
        WHERE t.id = NEW.thread_id;
    END IF;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.automod_message_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    -- Imported history is not moderated. Read inline: this trigger function runs as the caller, who cannot execute the flag reader.
    IF current_setting('harmony.history_import', true) = 'true' THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.content IS NOT DISTINCT FROM OLD.content THEN
        RETURN NEW;
    END IF;
    -- anon never passes messages_insert_member; RLS rejects the row.
    IF current_user = 'anon' THEN
        RETURN NEW;
    END IF;
    IF public.automod_check_message(NEW, TG_OP, current_user::text) THEN
        RETURN NEW;
    END IF;
    RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.broadcast_message_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rec      record;
  v_topic    text;
  v_row      jsonb;
  v_server   uuid;
  v_redact   boolean := false;
BEGIN
    IF public.is_history_import() THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
  IF TG_OP = 'DELETE' THEN
    v_rec := OLD;
  ELSE
    v_rec := NEW;
  END IF;

  IF v_rec.conversation_id IS NOT NULL THEN
    v_topic := 'dm-conversation-' || v_rec.conversation_id::text;
  ELSIF v_rec.channel_id IS NOT NULL THEN
    v_topic := 'channel-messages-' || v_rec.channel_id::text;
    -- A row created in this transaction postdates every subscriber's view start.
    IF v_rec.created_at < now() THEN
      SELECT c.server_id INTO v_server
        FROM public.channels c
        JOIN public.servers s ON s.id = c.server_id
       WHERE c.id = v_rec.channel_id
         AND s.is_local_server IS NOT FALSE;
      v_redact := v_server IS NOT NULL
                  AND NOT public.channel_grants_everyone(v_rec.channel_id, 4194304);
    END IF;
  ELSE
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF v_redact THEN
    v_row := jsonb_build_object(
      'id',         v_rec.id,
      'created_at', v_rec.created_at,
      'updated_at', v_rec.updated_at,
      'channel_id', v_rec.channel_id,
      'thread_id',  v_rec.thread_id,
      'is_deleted', v_rec.is_deleted,
      'restricted', true
    );
  ELSE
    v_row := jsonb_build_object(
      'id',                  v_rec.id,
      'created_at',          v_rec.created_at,
      'updated_at',          v_rec.updated_at,
      'user_id',             v_rec.user_id,
      'bot_id',              v_rec.bot_id,
      'channel_id',          v_rec.channel_id,
      'conversation_id',     v_rec.conversation_id,
      'thread_id',           v_rec.thread_id,
      'reply_to',            v_rec.reply_to,
      'content',             v_rec.content,
      'is_deleted',          v_rec.is_deleted,
      'is_system',           v_rec.is_system,
      'is_pinned',           v_rec.is_pinned,
      'encrypted',           v_rec.encrypted,
      'encryption_metadata', v_rec.encryption_metadata,
      'megolm_session_id',   v_rec.megolm_session_id,
      'metadata',            COALESCE(v_rec.metadata, '{}'::jsonb)
    );
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'op',  TG_OP,
      'new', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE v_row END,
      'old', CASE WHEN TG_OP = 'DELETE' THEN v_row ELSE NULL END
    ),
    'message_event',
    v_topic,
    true
  );

  IF v_rec.thread_id IS NOT NULL THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'op',  TG_OP,
        'new', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE v_row END,
        'old', CASE WHEN TG_OP = 'DELETE' THEN v_row ELSE NULL END
      ),
      'message_event',
      'thread-messages-' || v_rec.thread_id::text,
      true
    );
  END IF;

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  -- Delivery is best-effort; the write must not fail because realtime is
  -- unavailable. Clients reconcile against the table on reconnect.
  RAISE WARNING 'broadcast_message_event failed: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_channel_slowmode()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_slowmode integer;
    v_server_id uuid;
    v_is_local boolean;
    v_last_at timestamptz;
    v_wait integer;
BEGIN
    IF public.is_history_import() THEN
        RETURN NEW;
    END IF;
    IF NEW.channel_id IS NULL OR NEW.user_id IS NULL OR COALESCE(NEW.is_system, false) THEN
        RETURN NEW;
    END IF;

    SELECT c.slowmode_seconds, c.server_id
    INTO v_slowmode, v_server_id
    FROM public.channels c
    WHERE c.id = NEW.channel_id;

    IF COALESCE(v_slowmode, 0) <= 0 THEN
        RETURN NEW;
    END IF;

    -- Slowmode is a local moderation rule; never reject federated traffic.
    SELECT p.is_local INTO v_is_local FROM public.profiles p WHERE p.id = NEW.user_id;
    IF v_is_local IS DISTINCT FROM true THEN
        RETURN NEW;
    END IF;

    IF public.has_permission(NEW.user_id, v_server_id, 'MANAGE_MESSAGES', NEW.channel_id) THEN
        RETURN NEW;
    END IF;

    SELECT max(m.created_at) INTO v_last_at
    FROM public.messages m
    WHERE m.channel_id = NEW.channel_id
      AND m.user_id = NEW.user_id
      AND m.created_at > now() - make_interval(secs => v_slowmode);

    IF v_last_at IS NOT NULL THEN
        v_wait := GREATEST(1, CEIL(v_slowmode - EXTRACT(EPOCH FROM (now() - v_last_at)))::integer);
        RAISE EXCEPTION 'SLOWMODE_ACTIVE:%', v_wait
            USING ERRCODE = 'P0001',
                  HINT = format('Slowmode is enabled - wait %s more second(s)', v_wait);
    END IF;

    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.handle_channel_message_notifications()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_server uuid;
    v_category uuid;
    v_channel_name text;
    v_server_name text;
    v_default text;
    v_candidates uuid[];
    v_sender_profile profiles%ROWTYPE;
    v_sender_json jsonb;
    v_preview text;
BEGIN
    IF public.is_history_import() THEN
        RETURN NULL;
    END IF;
    SELECT c.server_id, c.category, c.name INTO v_server, v_category, v_channel_name
      FROM channels c WHERE c.id = NEW.channel_id;
    IF v_server IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT ss.default_message_notifications INTO v_default
      FROM server_settings ss WHERE ss.server_id = v_server;

    v_candidates := ARRAY(
        SELECT nc.user_id FROM notification_channels nc
         WHERE nc.channel_id = NEW.channel_id AND nc.notification_level = 'all'
        UNION
        SELECT nc.user_id FROM notification_channels nc
         WHERE nc.category_id = v_category AND nc.notification_level = 'all'
        UNION
        SELECT ns.user_id FROM notification_servers ns
         WHERE ns.server_id = v_server AND ns.notification_level = 'all'
        UNION
        SELECT us.user_id FROM user_servers us
         WHERE v_default = 'all' AND us.server_id = v_server AND us.status = 'accepted'
        EXCEPT
        SELECT n.user_id FROM notifications n
         WHERE n.created_at = now() AND n.type = 'mention'
           AND n.data->>'message_id' = NEW.id::text
    );
    IF NEW.user_id IS NOT NULL THEN
        v_candidates := array_remove(v_candidates, NEW.user_id);
    END IF;
    IF cardinality(v_candidates) = 0 THEN
        RETURN NULL;
    END IF;

    SELECT s.name INTO v_server_name FROM servers s WHERE s.id = v_server;
    SELECT * INTO v_sender_profile FROM profiles WHERE id = NEW.user_id;
    v_sender_json := message_notification_sender_json(NEW.user_id, NEW.bot_id, NEW.metadata, v_sender_profile);

    v_preview := TRIM(extract_message_text(NEW.content));
    IF LENGTH(v_preview) > 100 THEN
        v_preview := LEFT(v_preview, 100) || '...';
    END IF;
    IF v_preview = '' OR v_preview IS NULL THEN
        v_preview := 'New message';
    END IF;

    PERFORM send_notification(
        'channel_message',
        v_candidates,
        jsonb_build_object(
            'sender', v_sender_json,
            'message', jsonb_build_object('id', NEW.id, 'content_preview', v_preview),
            'location', jsonb_build_object(
                'server_id', v_server::text,
                'server_name', v_server_name,
                'channel_id', NEW.channel_id::text,
                'channel_name', v_channel_name
            ),
            'message_id', NEW.id,
            'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
            'sender_display_name', COALESCE(v_sender_json->>'display_name', v_sender_profile.display_name),
            'server_name', v_server_name,
            'channel_name', v_channel_name,
            'preview', v_preview
        ),
        v_server, NEW.channel_id, NULL, NEW.user_id, 'normal'
    );
    RETURN NULL;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'channel message notifications for % failed: % (%)', NEW.id, SQLERRM, SQLSTATE;
    RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.handle_message_federation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_federation_type TEXT;
    v_sender_profile profiles%ROWTYPE;
    content_part JSONB;
    mentioned_user_id UUID;
    current_domain TEXT;
    v_channel_id uuid;
    v_server_id uuid;
    v_channel_name TEXT;
    v_server_name TEXT;
    content_preview TEXT;
    v_sender_json jsonb;
    -- A system row has no author; its actor sends the notification.
    v_sender_id uuid := NEW.user_id;
BEGIN
    IF public.is_history_import() THEN
        RETURN NEW;
    END IF;
    v_federation_type := determine_message_federation_type(NEW.id);

    IF NEW.is_system IS TRUE AND NEW.metadata ->> 'actor_id'
       ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_sender_id := (NEW.metadata ->> 'actor_id')::uuid;
    END IF;

    SELECT * INTO v_sender_profile FROM profiles WHERE id = v_sender_id;

    content_preview := extract_message_text(NEW.content);
    content_preview := TRIM(content_preview);
    IF LENGTH(content_preview) > 100 THEN
        content_preview := LEFT(content_preview, 100) || '...';
    END IF;
    IF content_preview = '' OR content_preview IS NULL THEN
        content_preview := 'New message';
    END IF;

    v_sender_json := message_notification_sender_json(
        v_sender_id, NEW.bot_id, NEW.metadata, v_sender_profile
    );

    -- Channel mention notifications (includes federated messages)
    IF NEW.channel_id IS NOT NULL AND NOT NEW.is_system THEN
        v_channel_id := NEW.channel_id;

        SELECT c.name, c.server_id INTO v_channel_name, v_server_id
        FROM channels c WHERE c.id = v_channel_id;

        IF FOUND AND v_server_id IS NOT NULL THEN
            SELECT s.name INTO v_server_name FROM servers s WHERE s.id = v_server_id;
        END IF;

        SELECT trim(both '"' from config_value::text) INTO current_domain
        FROM instance_config WHERE config_key = 'domain' LIMIT 1;

        IF jsonb_typeof(NEW.content) = 'array' THEN
            FOR content_part IN SELECT jsonb_array_elements(NEW.content)
            LOOP
                IF content_part->>'type' = 'mention' THEN
                    mentioned_user_id := resolve_mention_profile_id(
                        content_part, NEW.user_id, current_domain
                    );

                    IF mentioned_user_id IS NOT NULL THEN
                        PERFORM send_notification_to_user(
                            'mention',
                            mentioned_user_id,
                            jsonb_build_object(
                                'sender', v_sender_json,
                                'message', jsonb_build_object(
                                    'id', NEW.id,
                                    'content_preview', content_preview
                                ),
                                'location', jsonb_build_object(
                                    'server_id', COALESCE(v_server_id::text, NULL),
                                    'server_name', COALESCE(v_server_name, NULL),
                                    'channel_id', COALESCE(v_channel_id::text, NULL),
                                    'channel_name', COALESCE(v_channel_name, NULL)
                                ),
                                'message_id', NEW.id,
                                'mentioned_by', NEW.user_id,
                                'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
                                'sender_display_name', COALESCE(
                                    v_sender_json->>'display_name',
                                    v_sender_profile.display_name
                                ),
                                'server_id', COALESCE(v_server_id::text, NULL),
                                'server_name', COALESCE(v_server_name, NULL),
                                'channel_id', COALESCE(v_channel_id::text, NULL),
                                'channel_name', COALESCE(v_channel_name, NULL),
                                'preview', content_preview
                            ),
                            v_server_id,
                            v_channel_id,
                            NULL,
                            NEW.user_id,
                            'normal'
                        );
                    END IF;
                END IF;
            END LOOP;
        END IF;
    END IF;

    -- DM / group chat notifications
    CASE v_federation_type
        WHEN 'chat_local_only' THEN
            PERFORM send_notification(
                'chat_message',
                ARRAY(
                    SELECT cp.user_id
                    FROM conversation_participants cp
                    JOIN profiles p ON p.id = cp.user_id
                    WHERE cp.conversation_id = NEW.conversation_id
                    AND (v_sender_id IS NULL OR cp.user_id <> v_sender_id)
                    AND cp.left_at IS NULL
                    AND p.is_local = true
                ),
                jsonb_build_object(
                    'sender', v_sender_json,
                    'message', jsonb_build_object(
                        'id', NEW.id,
                        'content_preview', content_preview
                    ),
                    'conversation', jsonb_build_object(
                        'id', NEW.conversation_id
                    ),
                    'message_id', NEW.id,
                    'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
                    'sender_display_name', COALESCE(
                        v_sender_json->>'display_name',
                        v_sender_profile.display_name
                    ),
                    'conversation_id', NEW.conversation_id,
                    'preview', content_preview
                ),
                NULL, NULL, NEW.conversation_id, v_sender_id, 'normal'
            );

        WHEN 'dm_local_only' THEN
            PERFORM send_notification(
                'dm',
                ARRAY(
                    SELECT cp.user_id
                    FROM conversation_participants cp
                    JOIN profiles p ON p.id = cp.user_id
                    WHERE cp.conversation_id = NEW.conversation_id
                    AND (v_sender_id IS NULL OR cp.user_id <> v_sender_id)
                    AND cp.left_at IS NULL
                    AND p.is_local = true
                ),
                jsonb_build_object(
                    'sender', v_sender_json,
                    'message', jsonb_build_object(
                        'id', NEW.id,
                        'content_preview', content_preview
                    ),
                    'conversation', jsonb_build_object(
                        'id', NEW.conversation_id
                    ),
                    'message_id', NEW.id,
                    'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
                    'sender_display_name', COALESCE(
                        v_sender_json->>'display_name',
                        v_sender_profile.display_name
                    ),
                    'conversation_id', NEW.conversation_id,
                    'preview', content_preview
                ),
                NULL, NULL, NEW.conversation_id, v_sender_id, 'normal'
            );

        WHEN 'dm_federated' THEN
            PERFORM send_notification(
                'dm',
                ARRAY(
                    SELECT cp.user_id
                    FROM conversation_participants cp
                    JOIN profiles p ON p.id = cp.user_id
                    WHERE cp.conversation_id = NEW.conversation_id
                    AND (v_sender_id IS NULL OR cp.user_id <> v_sender_id)
                    AND cp.left_at IS NULL
                    AND p.is_local = true
                ),
                jsonb_build_object(
                    'sender', v_sender_json,
                    'message', jsonb_build_object(
                        'id', NEW.id,
                        'content_preview', content_preview
                    ),
                    'conversation', jsonb_build_object(
                        'id', NEW.conversation_id
                    ),
                    'message_id', NEW.id,
                    'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
                    'sender_display_name', COALESCE(
                        v_sender_json->>'display_name',
                        v_sender_profile.display_name
                    ),
                    'conversation_id', NEW.conversation_id,
                    'preview', content_preview,
                    'federated', true
                ),
                NULL, NULL, NEW.conversation_id, v_sender_id, 'normal'
            );
    END CASE;

    RETURN NEW;

EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Message federation processing failed for %: %', NEW.id, SQLERRM;
        RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.handle_new_dm_unread()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_created timestamptz;
    v_prev    bigint;
    v_seq     bigint;
    v_origin  timestamptz;
BEGIN
    IF public.is_history_import() THEN
        RETURN NEW;
    END IF;
    IF NEW.user_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT cv.created_at INTO v_created FROM public.conversations cv WHERE cv.id = NEW.conversation_id;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    SELECT h.message_seq, h.origin_at INTO v_prev, v_origin
      FROM public.message_heads h WHERE h.conversation_id = NEW.conversation_id
       FOR UPDATE;
    IF FOUND THEN
        UPDATE public.message_heads
           SET message_seq = v_prev + 1, last_message_id = NEW.id, last_message_at = NEW.created_at
         WHERE conversation_id = NEW.conversation_id;
    ELSE
        INSERT INTO public.message_heads AS h (conversation_id, message_seq, last_message_id, last_message_at, origin_at)
        VALUES (NEW.conversation_id, 1, NEW.id, NEW.created_at, COALESCE(v_created, now()))
        ON CONFLICT (conversation_id) WHERE conversation_id IS NOT NULL DO UPDATE
           SET message_seq = h.message_seq + 1,
               last_message_id = EXCLUDED.last_message_id,
               last_message_at = EXCLUDED.last_message_at
        RETURNING h.message_seq - 1, h.origin_at INTO v_prev, v_origin;
    END IF;
    v_seq := v_prev + 1;

    UPDATE public.unread_counts u
       SET read_seq = CASE WHEN u.muted_at_seq - u.read_seq - u.skipped = 0 THEN v_prev ELSE u.read_seq END,
           skipped = CASE WHEN u.muted_at_seq - u.read_seq - u.skipped = 0 THEN 0
                          ELSE u.skipped + v_prev - u.muted_at_seq END,
           muted_at_seq = NULL
      FROM public.notification_channels nc
     WHERE nc.conversation_id = NEW.conversation_id
       AND nc.muted = true AND nc.muted_until IS NOT NULL AND nc.muted_until <= now()
       AND u.user_id = nc.user_id AND u.conversation_id = NEW.conversation_id
       AND u.muted_at_seq IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM public.notification_channels a
            WHERE a.user_id = nc.user_id AND a.conversation_id = NEW.conversation_id
              AND a.muted = true AND (a.muted_until IS NULL OR a.muted_until > now()));

    INSERT INTO public.unread_counts AS u (user_id, conversation_id, read_seq, skipped)
    VALUES (NEW.user_id, NEW.conversation_id,
            CASE WHEN v_prev = 0 THEN v_seq ELSE 0 END,
            CASE WHEN v_prev = 0 THEN 0 ELSE 1 END)
    ON CONFLICT (user_id, conversation_id) WHERE conversation_id IS NOT NULL DO UPDATE SET
        read_seq = CASE WHEN u.muted_at_seq IS NULL AND u.read_seq + u.skipped = v_prev
                        THEN v_seq ELSE u.read_seq END,
        skipped = CASE WHEN u.muted_at_seq IS NOT NULL THEN u.skipped
                       WHEN u.read_seq + u.skipped = v_prev THEN 0
                       ELSE u.skipped + 1 END;

    BEGIN
        PERFORM realtime.send(
            public.unread_change_payload('upsert', t.id, t.user_id, NULL, NULL, NEW.conversation_id,
                                         v_seq - COALESCE(t.read_seq, 0) - COALESCE(t.skipped, 0),
                                         t.unread_mentions, t.last_read_message_id,
                                         COALESCE(t.last_read_at, GREATEST(t.joined_at, v_origin))),
            'user_event', 'user:' || t.user_id::text, true)
          FROM (
              SELECT cp.user_id, min(cp.joined_at) AS joined_at, u.id, u.read_seq, u.skipped,
                     u.unread_mentions, u.last_read_message_id, u.last_read_at
                FROM public.conversation_participants cp
                LEFT JOIN public.unread_counts u
                  ON u.user_id = cp.user_id AND u.conversation_id = NEW.conversation_id
               WHERE cp.conversation_id = NEW.conversation_id
                 AND cp.left_at IS NULL
                 AND cp.user_id <> NEW.user_id
                 AND u.muted_at_seq IS NULL
               GROUP BY cp.user_id, u.id
          ) t;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'handle_new_dm_unread broadcast failed: %', SQLERRM;
    END;

    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.handle_new_message_unread()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_server   uuid;
    v_category uuid;
    v_created  timestamptz;
    v_prev     bigint;
    v_seq      bigint;
    v_origin   timestamptz;
BEGIN
    IF public.is_history_import() THEN
        RETURN NEW;
    END IF;
    SELECT c.server_id, c.category, c.created_at INTO v_server, v_category, v_created
      FROM public.channels c WHERE c.id = NEW.channel_id;
    IF v_server IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT h.message_seq, h.origin_at INTO v_prev, v_origin
      FROM public.message_heads h WHERE h.channel_id = NEW.channel_id
       FOR UPDATE;
    IF FOUND THEN
        UPDATE public.message_heads
           SET message_seq = v_prev + 1, last_message_id = NEW.id, last_message_at = NEW.created_at
         WHERE channel_id = NEW.channel_id;
    ELSE
        INSERT INTO public.message_heads AS h (channel_id, message_seq, last_message_id, last_message_at, origin_at)
        VALUES (NEW.channel_id, 1, NEW.id, NEW.created_at, v_created)
        ON CONFLICT (channel_id) WHERE channel_id IS NOT NULL DO UPDATE
           SET message_seq = h.message_seq + 1,
               last_message_id = EXCLUDED.last_message_id,
               last_message_at = EXCLUDED.last_message_at
        RETURNING h.message_seq - 1, h.origin_at INTO v_prev, v_origin;
    END IF;
    v_seq := v_prev + 1;

    -- Mutes that lapsed by muted_until end at v_prev: nothing was posted since.
    UPDATE public.unread_counts u
       SET read_seq = CASE WHEN u.muted_at_seq - u.read_seq - u.skipped = 0 THEN v_prev ELSE u.read_seq END,
           skipped = CASE WHEN u.muted_at_seq - u.read_seq - u.skipped = 0 THEN 0
                          ELSE u.skipped + v_prev - u.muted_at_seq END,
           muted_at_seq = NULL
      FROM (SELECT nc.user_id FROM public.notification_channels nc
             WHERE nc.channel_id = NEW.channel_id
               AND nc.muted = true AND nc.muted_until IS NOT NULL AND nc.muted_until <= now()
            UNION
            SELECT nc.user_id FROM public.notification_channels nc
             WHERE nc.category_id = v_category
               AND nc.muted = true AND nc.muted_until IS NOT NULL AND nc.muted_until <= now()) l
     WHERE u.user_id = l.user_id AND u.channel_id = NEW.channel_id
       AND u.muted_at_seq IS NOT NULL
       AND NOT public.channel_mute_active(l.user_id, NEW.channel_id);

    IF NEW.user_id IS NOT NULL THEN
        INSERT INTO public.unread_counts AS u (user_id, server_id, channel_id, read_seq, skipped)
        VALUES (NEW.user_id, v_server, NEW.channel_id,
                CASE WHEN v_prev = 0 THEN v_seq ELSE 0 END,
                CASE WHEN v_prev = 0 THEN 0 ELSE 1 END)
        ON CONFLICT (user_id, channel_id) WHERE channel_id IS NOT NULL DO UPDATE SET
            read_seq = CASE WHEN u.muted_at_seq IS NULL AND u.read_seq + u.skipped = v_prev
                            THEN v_seq ELSE u.read_seq END,
            skipped = CASE WHEN u.muted_at_seq IS NOT NULL THEN u.skipped
                           WHEN u.read_seq + u.skipped = v_prev THEN 0
                           ELSE u.skipped + 1 END;
    END IF;

    -- Members whose count goes from 0 to 1. channel_is_restricted() runs as an InitPlan, only
    -- once a candidate exists.
    BEGIN
        IF v_prev = 0 THEN
            PERFORM realtime.send(
                public.unread_change_payload('upsert', t.id, t.user_id, v_server, NEW.channel_id, NULL,
                                             1, t.unread_mentions, t.last_read_message_id,
                                             COALESCE(t.last_read_at, GREATEST(t.member_since, v_origin))),
                'user_event', 'user:' || t.user_id::text, true)
              FROM (
                  SELECT us.user_id, us.created_at AS member_since, u.id, u.unread_mentions,
                         u.last_read_message_id, u.last_read_at
                    FROM public.user_servers us
                    LEFT JOIN public.unread_counts u
                      ON u.user_id = us.user_id AND u.channel_id = NEW.channel_id
                   WHERE us.server_id = v_server
                     AND us.status = 'accepted'
                     AND us.user_id IS DISTINCT FROM NEW.user_id
                     AND (u.id IS NULL OR (u.read_seq = 0 AND u.skipped = 0 AND u.muted_at_seq IS NULL))
              ) t
             WHERE NOT (SELECT public.channel_is_restricted(NEW.channel_id))
                OR t.user_id IN (SELECT public.channel_viewer_ids(NEW.channel_id));
        ELSE
            PERFORM realtime.send(
                public.unread_change_payload('upsert', t.id, t.user_id, v_server, NEW.channel_id, NULL,
                                             1, t.unread_mentions, t.last_read_message_id,
                                             COALESCE(t.last_read_at, GREATEST(t.member_since, v_origin))),
                'user_event', 'user:' || t.user_id::text, true)
              FROM (
                  SELECT u.user_id, us.created_at AS member_since, u.id, u.unread_mentions,
                         u.last_read_message_id, u.last_read_at
                    FROM public.unread_counts u
                   -- LIMIT keeps this a probe per candidate; a join hashes every member.
                   CROSS JOIN LATERAL (
                       SELECT m.created_at
                         FROM public.user_servers m
                        WHERE m.user_id = u.user_id AND m.server_id = v_server AND m.status = 'accepted'
                        LIMIT 1
                   ) us
                   WHERE u.channel_id = NEW.channel_id
                     AND u.read_seq = v_prev
                     AND u.skipped = 0
                     AND u.muted_at_seq IS NULL
                     AND u.user_id IS DISTINCT FROM NEW.user_id
              ) t
             WHERE NOT (SELECT public.channel_is_restricted(NEW.channel_id))
                OR public.can_view_channel(t.user_id, NEW.channel_id);
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'handle_new_message_unread broadcast failed: %', SQLERRM;
    END;

    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.handle_newcomer_first_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_server_id uuid;
    v_server_name text;
    v_owner uuid;
    v_joined_at timestamp with time zone;
    v_restricted boolean;
    v_everyone_staff boolean;
    v_candidate uuid;
    v_recipients uuid[] := '{}'::uuid[];
    v_author public.profiles%ROWTYPE;
    v_channel_name text;
    v_text text;
    v_preview text;
BEGIN
    IF public.is_history_import() THEN
        RETURN NULL;
    END IF;
    -- A lookup is 2 µs cheaper per message than a conflicting ON CONFLICT insert (header).
    IF EXISTS (SELECT 1
                 FROM public.channels c
                 JOIN public.server_first_messages f
                   ON f.server_id = c.server_id AND f.user_id = NEW.user_id
                WHERE c.id = NEW.channel_id) THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.server_first_messages (user_id, server_id, first_message_at)
    SELECT NEW.user_id, c.server_id, NEW.created_at
      FROM public.channels c
     WHERE c.id = NEW.channel_id
       AND c.server_id IS NOT NULL
    ON CONFLICT DO NOTHING
    RETURNING server_id INTO v_server_id;

    IF v_server_id IS NULL THEN
        RETURN NULL;
    END IF;

    -- A failure past this point loses the alert, never the message.
    BEGIN
        SELECT s.name, s.owner INTO v_server_name, v_owner
          FROM public.servers s
         WHERE s.id = v_server_id AND s.is_local_server IS NOT FALSE;
        IF NOT FOUND OR v_owner IS NOT DISTINCT FROM NEW.user_id THEN
            RETURN NULL;
        END IF;

        SELECT us.created_at INTO v_joined_at
          FROM public.user_servers us
         WHERE us.user_id = NEW.user_id
           AND us.server_id = v_server_id
           AND COALESCE(us.status, 'accepted') = 'accepted';
        IF v_joined_at IS NULL OR v_joined_at <= now() - interval '30 days' THEN
            RETURN NULL;
        END IF;

        IF NOT (public.server_newcomer_alerts_state(v_server_id) ->> 'enabled')::boolean THEN
            RETURN NULL;
        END IF;

        IF EXISTS (
            SELECT 1
              FROM public.channels c
              JOIN public.messages m ON m.channel_id = c.id AND m.user_id = NEW.user_id
             WHERE c.server_id = v_server_id
               AND m.id <> NEW.id
               AND m.is_system IS NOT TRUE
        ) THEN
            RETURN NULL;
        END IF;

        v_restricted := public.channel_is_restricted(NEW.channel_id);
        SELECT EXISTS (
            SELECT 1 FROM public.server_roles r
             WHERE r.server_id = v_server_id AND r.is_default
               AND (COALESCE(r.permissions, 0) & 3713) <> 0
        ) INTO v_everyone_staff;

        FOR v_candidate IN
            SELECT us.user_id
              FROM (
                  SELECT c.user_id, max(c.top_position) AS top_position
                    FROM (
                        SELECT v_owner AS user_id, NULL::integer AS top_position
                        UNION ALL
                        SELECT ur.user_id, sr.position
                          FROM public.server_roles sr
                          JOIN public.user_roles ur ON ur.role_id = sr.id
                         WHERE sr.server_id = v_server_id
                           AND NOT sr.is_default
                           AND (COALESCE(sr.permissions, 0) & 3713) <> 0
                        UNION ALL
                        SELECT m.user_id, NULL::integer
                          FROM public.user_servers m
                         WHERE v_everyone_staff AND m.server_id = v_server_id
                    ) c
                   WHERE c.user_id IS NOT NULL
                   GROUP BY c.user_id
              ) staff
              JOIN public.user_servers us
                ON us.user_id = staff.user_id AND us.server_id = v_server_id
              JOIN public.profiles p ON p.id = us.user_id
              LEFT JOIN public.notification_preferences np ON np.user_id = us.user_id
             WHERE COALESCE(us.status, 'accepted') = 'accepted'
               AND us.user_id <> NEW.user_id
               AND p.is_local IS NOT FALSE
               AND COALESCE(np.newcomer_alerts, true)
             ORDER BY (us.user_id = v_owner) DESC, staff.top_position DESC NULLS LAST,
                      us.created_at, us.user_id
        LOOP
            CONTINUE WHEN v_restricted
                AND NOT public.has_permission(v_candidate, v_server_id, 'VIEW_CHANNEL', NEW.channel_id);
            v_recipients := v_recipients || v_candidate;
            EXIT WHEN cardinality(v_recipients) >= 10;
        END LOOP;

        IF cardinality(v_recipients) = 0 THEN
            RETURN NULL;
        END IF;

        SELECT * INTO v_author FROM public.profiles WHERE id = NEW.user_id;
        SELECT c.name INTO v_channel_name FROM public.channels c WHERE c.id = NEW.channel_id;

        IF NEW.encrypted IS NOT TRUE THEN
            v_text := public.extract_message_text(NEW.content);
            v_preview := NULLIF(CASE WHEN length(v_text) > 100 THEN left(v_text, 99) || '…' ELSE v_text END, '');
        END IF;

        PERFORM public.send_notification(
            'newcomer_message',
            v_recipients,
            jsonb_strip_nulls(jsonb_build_object(
                'sender', public.notification_actor_json(v_author),
                'message', jsonb_build_object('id', NEW.id, 'content_preview', v_preview),
                'location', jsonb_build_object(
                    'server_id', v_server_id,
                    'server_name', v_server_name,
                    'channel_id', NEW.channel_id,
                    'channel_name', v_channel_name),
                'thread', CASE WHEN NEW.thread_id IS NOT NULL THEN jsonb_build_object('id', NEW.thread_id) END,
                'message_id', NEW.id,
                'server_name', v_server_name,
                'channel_id', NEW.channel_id,
                'channel_name', v_channel_name,
                'thread_id', NEW.thread_id,
                'preview', v_preview,
                'joined_at', v_joined_at)),
            v_server_id,
            NULL,
            NULL,
            NEW.user_id,
            'normal');
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'newcomer alert for message % failed: % (%)', NEW.id, SQLERRM, SQLSTATE;
    END;

    RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.handle_role_mention_notifications()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_server_id uuid;
    v_channel_name text;
    v_server_name text;
    v_sender_profile profiles%ROWTYPE;
    v_sender_json jsonb;
    v_can_mention_all boolean;
    v_everyone boolean;
    v_here boolean;
    v_here_ids uuid[] := '{}';
    v_direct_ids uuid[];
    v_roles uuid[];
    v_data jsonb;
    content_preview text;
BEGIN
    IF public.is_history_import() THEN
        RETURN NEW;
    END IF;
    IF NEW.channel_id IS NULL OR NEW.is_system THEN
        RETURN NEW;
    END IF;

    SELECT c.server_id, c.name INTO v_server_id, v_channel_name
    FROM channels c WHERE c.id = NEW.channel_id;
    IF v_server_id IS NULL THEN RETURN NEW; END IF;

    IF jsonb_typeof(NEW.content) != 'array' THEN RETURN NEW; END IF;

    IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.content) elem
        WHERE elem->>'type' = 'role_mention'
    ) THEN
        RETURN NEW;
    END IF;

    IF NEW.bot_id IS NOT NULL THEN
        v_can_mention_all := check_bot_permission(NEW.bot_id, v_server_id, 'mention_everyone');
    ELSIF NEW.user_id IS NOT NULL THEN
        v_can_mention_all := has_permission(NEW.user_id, v_server_id, 'MENTION_EVERYONE', NEW.channel_id);
    ELSE
        RETURN NEW;
    END IF;

    -- @everyone (the is_default role) needs MENTION_EVERYONE; another role needs to be
    -- mentionable or MENTION_EVERYONE.
    SELECT bool_or(r.is_default), array_agg(r.id) FILTER (WHERE NOT r.is_default)
      INTO v_everyone, v_roles
      FROM server_roles r
     WHERE r.server_id = v_server_id
       AND r.id IN (SELECT (elem->>'roleId')::uuid
                      FROM jsonb_array_elements(NEW.content) elem
                     WHERE elem->>'type' = 'role_mention'
                       AND elem->>'roleId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       AND CASE WHEN r.is_default THEN v_can_mention_all
                ELSE COALESCE(r.mentionable, true) OR v_can_mention_all END;

    v_everyone := COALESCE(v_everyone, false);
    -- @here needs MENTION_EVERYONE.
    v_here := COALESCE(v_can_mention_all, false) AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.content) elem
         WHERE elem->>'type' = 'role_mention' AND elem->>'roleId' = 'here');
    IF NOT v_everyone AND NOT v_here AND v_roles IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT s.name INTO v_server_name FROM servers s WHERE s.id = v_server_id;

    SELECT * INTO v_sender_profile FROM profiles WHERE id = NEW.user_id;

    v_sender_json := message_notification_sender_json(
        NEW.user_id, NEW.bot_id, NEW.metadata, v_sender_profile
    );

    content_preview := LEFT(
        (SELECT string_agg(elem->>'text', ' ')
         FROM jsonb_array_elements(NEW.content) elem
         WHERE elem->>'type' = 'text'), 100);

    v_data := jsonb_build_object(
        'sender', v_sender_json,
        'message', jsonb_build_object('id', NEW.id, 'content_preview', content_preview),
        'location', jsonb_build_object(
            'server_id', v_server_id::text,
            'server_name', v_server_name,
            'channel_id', NEW.channel_id::text,
            'channel_name', v_channel_name
        ),
        'message_id', NEW.id,
        'mentioned_by', NEW.user_id,
        'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
        'sender_display_name', COALESCE(
            v_sender_json->>'display_name',
            v_sender_profile.display_name
        ),
        'server_id', v_server_id::text,
        'server_name', v_server_name,
        'channel_id', NEW.channel_id::text,
        'channel_name', v_channel_name,
        'preview', content_preview,
        'is_role_mention', true
    );

    -- Members a direct mention of this message already notified (trg_handle_message_federation
    -- fires first) get no second notification from @everyone, @here or a role.
    v_direct_ids := ARRAY(
        SELECT n.user_id FROM notifications n
         WHERE n.created_at = now() AND n.type = 'mention'
           AND n.data->>'message_id' = NEW.id::text);

    -- Suppressing members are left out here; send_notification applies the same flags.
    IF v_everyone THEN
        PERFORM send_notification(
            'mention',
            ARRAY(SELECT us.user_id FROM user_servers us
                    LEFT JOIN notification_servers ns
                      ON ns.user_id = us.user_id AND ns.server_id = us.server_id
                   WHERE us.server_id = v_server_id
                     AND us.status = 'accepted'
                     AND us.user_id IS DISTINCT FROM NEW.user_id
                     AND NOT COALESCE(ns.suppress_everyone, false)
                     AND us.user_id <> ALL (v_direct_ids)),
            v_data || jsonb_build_object('is_everyone', true),
            v_server_id, NEW.channel_id, NULL, NEW.user_id, 'normal'
        );
    END IF;

    -- Online members; members a mention of this message reached are left out.
    IF v_here AND NOT v_everyone THEN
        v_here_ids := ARRAY(
            SELECT us.user_id FROM user_servers us
              JOIN user_presence up ON up.profile_id = us.user_id
              LEFT JOIN notification_servers ns
                ON ns.user_id = us.user_id AND ns.server_id = us.server_id
             WHERE us.server_id = v_server_id
               AND us.status = 'accepted'
               AND us.user_id IS DISTINCT FROM NEW.user_id
               AND up.status IN (1, 2, 3)
               AND NOT COALESCE(ns.suppress_everyone, false)
               AND EXISTS (SELECT 1 FROM presence_devices d
                            WHERE d.profile_id = us.user_id
                              AND d.last_seen_at > now() - interval '150 seconds')
            EXCEPT
            SELECT unnest(v_direct_ids));
        PERFORM send_notification(
            'mention',
            v_here_ids,
            v_data || jsonb_build_object('is_everyone', true, 'is_here', true),
            v_server_id, NEW.channel_id, NULL, NEW.user_id, 'normal'
        );
    END IF;

    -- Holders @everyone or @here reached are left out.
    IF v_roles IS NOT NULL THEN
        PERFORM send_notification(
            'mention',
            ARRAY(SELECT DISTINCT ur.user_id FROM user_roles ur
                    LEFT JOIN notification_servers ns
                      ON ns.user_id = ur.user_id AND ns.server_id = ur.server_id
                   WHERE ur.server_id = v_server_id
                     AND ur.role_id = ANY (v_roles)
                     AND ur.user_id IS DISTINCT FROM NEW.user_id
                     AND NOT COALESCE(ns.suppress_roles, false)
                     AND (NOT v_everyone OR COALESCE(ns.suppress_everyone, false))
                     AND ur.user_id <> ALL (v_here_ids)
                     AND ur.user_id <> ALL (v_direct_ids)),
            v_data,
            v_server_id, NEW.channel_id, NULL, NEW.user_id, 'normal'
        );
    END IF;

    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.handle_thread_reply_notification()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_thread record;
    v_sender_profile profiles%ROWTYPE;
    v_sender jsonb;
    v_channel_id uuid;
    v_server_id uuid;
    v_channel_name text;
    v_server_name text;
    content_preview text;
    v_recipient uuid;
BEGIN
    IF public.is_history_import() THEN
        RETURN NEW;
    END IF;
    IF NEW.thread_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT t.id, t.parent_message_id, t.channel_id, t.created_by
    INTO v_thread
    FROM threads t WHERE t.id = NEW.thread_id;

    IF NOT FOUND THEN RETURN NEW; END IF;

    v_channel_id := v_thread.channel_id;

    SELECT c.server_id, c.name INTO v_server_id, v_channel_name
    FROM channels c WHERE c.id = v_channel_id;

    IF v_server_id IS NOT NULL THEN
        SELECT s.name INTO v_server_name FROM servers s WHERE s.id = v_server_id;
    END IF;

    IF NEW.user_id IS NOT NULL THEN
        SELECT * INTO v_sender_profile FROM profiles p WHERE p.id = NEW.user_id;
    END IF;
    -- A bridged Discord author or a bot reads as itself, not as an empty profile.
    v_sender := message_notification_sender_json(NEW.user_id, NEW.bot_id, NEW.metadata, v_sender_profile);
    IF NEW.user_id IS NOT NULL THEN
        v_sender := v_sender || jsonb_build_object('user_id', NEW.user_id);
    END IF;

    content_preview := TRIM(extract_message_text(NEW.content));
    IF LENGTH(content_preview) > 100 THEN
        content_preview := LEFT(content_preview, 100) || '...';
    END IF;
    IF content_preview = '' OR content_preview IS NULL THEN
        content_preview := 'New thread reply';
    END IF;

    -- Thread members, and the creator when not a member.
    FOR v_recipient IN
        SELECT tm.user_id
          FROM thread_members tm
         WHERE tm.thread_id = NEW.thread_id
           AND tm.user_id IS DISTINCT FROM NEW.user_id
           AND COALESCE(tm.muted, false) = false
        UNION
        SELECT v_thread.created_by
         WHERE v_thread.created_by IS NOT NULL
           AND v_thread.created_by IS DISTINCT FROM NEW.user_id
           AND NOT EXISTS (
               SELECT 1 FROM thread_members
                WHERE thread_id = NEW.thread_id AND user_id = v_thread.created_by
           )
    LOOP
        PERFORM send_notification_to_user(
            'thread_reply',
            v_recipient,
            jsonb_build_object(
                'sender', v_sender,
                'message', jsonb_build_object(
                    'id', NEW.id,
                    'content_preview', content_preview
                ),
                'thread', jsonb_build_object(
                    'id', NEW.thread_id,
                    'parent_message_id', v_thread.parent_message_id
                ),
                'location', jsonb_build_object(
                    'server_id', v_server_id::text,
                    'server_name', v_server_name,
                    'channel_id', v_channel_id::text,
                    'channel_name', v_channel_name
                ),
                'message_id', NEW.id,
                'thread_id', NEW.thread_id,
                'server_id', v_server_id::text,
                'channel_id', v_channel_id::text,
                'preview', content_preview
            ),
            v_server_id,
            v_channel_id,
            NULL,
            NEW.user_id,
            'normal'
        );
    END LOOP;

    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.process_local_link_previews()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_instance_domain text;
  v_embed_map jsonb := coalesce(NEW.metadata->'embeds', '{}'::jsonb);
  v_original_map jsonb := v_embed_map;
  v_part jsonb;
  v_normalized_url text;
  v_embed jsonb;
begin
    IF public.is_history_import() THEN
        RETURN NEW;
    END IF;
  if coalesce(NEW.metadata->>'federated', 'false') = 'true' then
    return NEW;
  end if;

  if jsonb_typeof(NEW.content) <> 'array' then
    return NEW;
  end if;

  select trim(both '"' from config_value::text)
    into v_instance_domain
    from public.instance_config
    where config_key = 'domain'
    limit 1;

  for v_part in
    select value from jsonb_array_elements(NEW.content)
  loop
    if coalesce(v_part->>'type', '') <> 'url' then
      continue;
    end if;
    if coalesce(v_part->>'preview', 'true') = 'false' then
      continue;
    end if;

    v_normalized_url := public.normalize_embed_url(v_part->>'url');
    if v_normalized_url is null or v_embed_map ? v_normalized_url then
      continue;
    end if;

    begin
      if v_instance_domain is not null
         and public.extract_url_host(v_normalized_url) = lower(v_instance_domain) then
        v_embed := public.fetch_link_preview(v_normalized_url);
        
        if v_embed is not null then
          v_embed_map := v_embed_map || jsonb_build_object(v_normalized_url, v_embed);
        end if;
      end if;
    exception
      when others then
        raise notice 'Failed to fetch local preview for %: %', v_normalized_url, SQLERRM;
    end;
  end loop;

  if v_embed_map <> v_original_map then
    NEW.metadata := coalesce(NEW.metadata, '{}'::jsonb) || jsonb_build_object('embeds', v_embed_map);
  end if;

  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_federation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_author_is_local BOOLEAN;
BEGIN
    -- Imported history is never federated. A terminal status keeps the row out of any sweep of pending rows.
    IF public.is_history_import() THEN
        NEW.federation_status := 'skipped';
        RETURN NEW;
    END IF;
    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        IF NEW.metadata ? 'federated' THEN
            NEW.federation_status := 'skipped';
            RETURN NEW;
        END IF;

        IF NEW.encrypted IS TRUE OR public.channel_messages_encrypted(NEW.channel_id) THEN
            NEW.federation_status := 'skipped';
            RETURN NEW;
        END IF;

        -- A system row has no author. Member events of a local server go out as its Group's
        -- (LIVE_SYSTEM_NOTE_TYPES in federation-backend systemNotes.ts); other notices stay here.
        IF NEW.is_system IS TRUE THEN
            IF COALESCE(NEW.metadata ->> 'type', '') NOT IN ('member_join', 'member_leave', 'member_kick', 'member_ban') THEN
                NEW.federation_status := 'skipped';
                RETURN NEW;
            END IF;
        ELSIF NEW.user_id IS NULL THEN
            -- A bot, webhook or bridged message: its server's Group speaks for it (local servers,
            -- below; federation-backend groupAuthor.ts).
            IF NEW.bot_id IS NULL THEN
                NEW.federation_status := 'skipped';
                RETURN NEW;
            END IF;
        ELSE
            SELECT is_local INTO v_author_is_local
            FROM public.profiles
            WHERE id = NEW.user_id;

            IF v_author_is_local IS NOT TRUE THEN
                NEW.federation_status := 'skipped';
                RETURN NEW;
            END IF;
        END IF;

        SELECT c.server_id, s.is_local_server
        INTO v_server_id, v_server_is_local
        FROM public.channels c
        JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;

        IF (NEW.is_system IS TRUE OR NEW.user_id IS NULL) AND v_server_is_local IS NOT TRUE THEN
            NEW.federation_status := 'skipped';
            RETURN NEW;
        END IF;

        NEW.federation_status := 'queued';

        PERFORM public.queue_federation_job(
            'federate-channel-message',
            jsonb_build_object(
                'type', 'create',
                'message_id', NEW.id,
                'channel_id', NEW.channel_id,
                'user_id', NEW.user_id,
                'server_id', v_server_id,
                'server_is_local', COALESCE(v_server_is_local, true),
                'created_at', NEW.created_at
            ),
            5, 5, 900
        );
    END IF;

    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_queue_dm_federation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
    -- Imported history is never federated. A terminal status keeps the row out of any sweep of pending rows.
    IF public.is_history_import() THEN
        NEW.federation_status := 'skipped';
        RETURN NEW;
    END IF;
    IF NEW.conversation_id IS NOT NULL
       AND NOT (NEW.metadata ? 'federated')
       AND NOT (COALESCE(NEW.is_system, false) = true)
    THEN
        NEW.federation_status := 'queued';

        PERFORM public.queue_federation_job(
            'federate-dm',
            jsonb_build_object(
                'type', 'create',
                'message_id', NEW.id,
                'conversation_id', NEW.conversation_id,
                'user_id', NEW.user_id,
                'created_at', NEW.created_at
            ),
            5, 5, 3600
        );
    ELSE
        NEW.federation_status := 'skipped';
    END IF;

    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_edit_federation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_federation_enabled BOOLEAN;
    v_author_is_local BOOLEAN;
BEGIN
    IF public.is_history_import() THEN
        RETURN NEW;
    END IF;
    IF current_setting('harmony.silent_content_update', true) = 'true' THEN
        RETURN NEW;
    END IF;

    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        IF OLD.content IS NOT DISTINCT FROM NEW.content THEN RETURN NEW; END IF;

        IF NEW.encrypted IS TRUE OR OLD.encrypted IS TRUE
           OR public.channel_messages_encrypted(NEW.channel_id) THEN
            RETURN NEW;
        END IF;

        SELECT c.server_id, s.is_local_server, s.federation_enabled
        INTO v_server_id, v_server_is_local, v_federation_enabled
        FROM public.channels c JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;

        IF v_server_is_local IS TRUE THEN
            IF v_federation_enabled IS NOT TRUE THEN RETURN NEW; END IF;
        ELSE
            IF NEW.metadata ? 'federated' THEN RETURN NEW; END IF;
            SELECT is_local INTO v_author_is_local FROM public.profiles WHERE id = NEW.user_id;
            IF v_author_is_local IS NOT TRUE THEN RETURN NEW; END IF;
        END IF;

        PERFORM public.queue_federation_job(
            'federate-channel-message-edit',
            jsonb_build_object(
                'type', 'update',
                'message_id', NEW.id,
                'channel_id', NEW.channel_id,
                'user_id', NEW.user_id,
                'server_id', v_server_id,
                'server_is_local', COALESCE(v_server_is_local, true)
            ), 5, 5, 900
        );
    END IF;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_delete_federation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_federation_enabled BOOLEAN;
    v_author_is_local BOOLEAN;
    v_deleter UUID;
BEGIN
    IF public.is_history_import() THEN
        RETURN NEW;
    END IF;
    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        IF OLD.is_deleted = TRUE OR NEW.is_deleted = FALSE THEN RETURN NEW; END IF;

        IF NEW.federation_status = 'skipped'
           AND NOT (NEW.metadata ? 'federated')
           AND (NEW.encrypted IS TRUE OR public.channel_messages_encrypted(NEW.channel_id)) THEN
            RETURN NEW;
        END IF;

        SELECT c.server_id, s.is_local_server, s.federation_enabled
        INTO v_server_id, v_server_is_local, v_federation_enabled
        FROM public.channels c JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;

        IF v_server_is_local IS TRUE THEN
            IF v_federation_enabled IS NOT TRUE THEN RETURN NEW; END IF;
        ELSE
            IF NEW.metadata ? 'federated' THEN RETURN NEW; END IF;
            SELECT is_local INTO v_author_is_local FROM public.profiles WHERE id = NEW.user_id;
            IF v_author_is_local IS NOT TRUE THEN RETURN NEW; END IF;
            v_deleter := public.get_current_profile_id();
            IF v_deleter IS NOT NULL AND v_deleter IS DISTINCT FROM NEW.user_id THEN RETURN NEW; END IF;
        END IF;

        PERFORM public.queue_federation_job(
            'federate-channel-message-delete',
            jsonb_build_object(
                'type', 'delete',
                'message_id', NEW.id,
                'channel_id', NEW.channel_id,
                'user_id', NEW.user_id,
                'ap_id', NEW.metadata->>'ap_id',
                'server_id', v_server_id,
                'server_is_local', COALESCE(v_server_is_local, true)
            ), 5, 5, 900
        );
    END IF;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_queue_channel_pin_federation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_server_id uuid;
BEGIN
    IF public.is_history_import() THEN
        RETURN NULL;
    END IF;
    IF NEW.channel_id IS NULL OR NEW.is_deleted IS TRUE
       OR NEW.is_pinned IS NOT DISTINCT FROM OLD.is_pinned THEN
        RETURN NULL;
    END IF;

    -- Notices other than member events have no Note (LIVE_SYSTEM_NOTE_TYPES, systemNotes.ts).
    IF NEW.is_system IS TRUE
       AND COALESCE(NEW.metadata ->> 'type', '') NOT IN ('member_join', 'member_leave', 'member_kick', 'member_ban') THEN
        RETURN NULL;
    END IF;

    IF NEW.encrypted IS TRUE OR public.channel_messages_encrypted(NEW.channel_id) THEN
        RETURN NULL;
    END IF;

    SELECT c.server_id INTO v_server_id
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id
     WHERE c.id = NEW.channel_id
       AND s.is_local_server IS TRUE
       AND s.federation_enabled IS TRUE;
    IF v_server_id IS NULL THEN
        RETURN NULL;
    END IF;

    PERFORM public.queue_federation_job(
        'federate-channel-pin',
        jsonb_build_object(
            'type', 'update',
            'message_id', NEW.id,
            'channel_id', NEW.channel_id,
            'server_id', v_server_id,
            'pinned', NEW.is_pinned IS TRUE
        ),
        5, 5, 900
    );
    RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_queue_push_notification()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_server text;
BEGIN
    IF public.is_history_import() THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' AND NEW.is_read = false THEN
        v_server := COALESCE(NULLIF(NEW.data->>'server_id', ''), NULLIF(NEW.data->'location'->>'server_id', ''));
        IF v_server ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           AND EXISTS (SELECT 1 FROM public.notification_servers ns
                        WHERE ns.user_id = NEW.user_id AND ns.server_id = v_server::uuid
                          AND NOT ns.push_notifications) THEN
            RETURN NEW;
        END IF;

        PERFORM public.queue_federation_job(
            'send-push-notification',
            jsonb_build_object(
                'notification_id', NEW.id,
                'user_id', NEW.user_id,
                'type', NEW.type,
                'data', COALESCE(NEW.data, '{}'::jsonb)
            ),
            5,
            3,
            300
        );
    END IF;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_queue_thread_federation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_creator_is_local BOOLEAN;
BEGIN
    IF public.is_history_import() THEN
        IF TG_OP = 'INSERT' THEN
            NEW.federation_status := 'skipped';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        -- Threads with ap_id already set came from federation (stub or ChatThread).
        IF NEW.ap_id IS NOT NULL THEN
            NEW.federation_status := CASE WHEN NEW.federation_status = 'stub' THEN 'stub' ELSE 'synced' END;
            RETURN NEW;
        END IF;

        SELECT c.server_id, s.is_local_server INTO v_server_id, v_server_is_local
        FROM public.channels c JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;

        SELECT is_local INTO v_creator_is_local FROM public.profiles WHERE id = NEW.created_by;

        IF v_creator_is_local IS NOT TRUE THEN
            NEW.federation_status := 'skipped';
            RETURN NEW;
        END IF;

        NEW.federation_status := 'queued';
        PERFORM public.queue_federation_job(
            'federate-thread',
            jsonb_build_object(
                'type', 'create', 'thread_id', NEW.id, 'channel_id', NEW.channel_id,
                'server_id', v_server_id, 'server_is_local', COALESCE(v_server_is_local, true),
                'created_by', NEW.created_by, 'created_at', NEW.created_at
            ), 5, 5, 900
        );
    ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.federation_status = 'stub' AND OLD.federation_status IS DISTINCT FROM 'stub' THEN
            NEW.federation_status := OLD.federation_status;
        END IF;

        IF (OLD.name IS NOT DISTINCT FROM NEW.name AND
            OLD.archived IS NOT DISTINCT FROM NEW.archived AND
            OLD.locked IS NOT DISTINCT FROM NEW.locked) THEN
            RETURN NEW;
        END IF;

        SELECT c.server_id, s.is_local_server INTO v_server_id, v_server_is_local
        FROM public.channels c JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;

        SELECT is_local INTO v_creator_is_local FROM public.profiles WHERE id = NEW.created_by;
        IF v_creator_is_local IS NOT TRUE THEN RETURN NEW; END IF;

        IF NEW.federation_status = 'local' OR NEW.federation_status IS NULL THEN
            NEW.federation_status := 'queued';
        END IF;

        PERFORM public.queue_federation_job(
            'federate-thread',
            jsonb_build_object(
                'type', 'update', 'thread_id', NEW.id, 'channel_id', NEW.channel_id,
                'server_id', v_server_id, 'server_is_local', COALESCE(v_server_is_local, true),
                'created_by', NEW.created_by
            ), 5, 5, 900
        );
    END IF;

    RETURN NEW;
EXCEPTION
    WHEN undefined_table THEN RETURN NEW;
    WHEN OTHERS THEN
        RAISE WARNING 'trigger_queue_thread_federation error: %', SQLERRM;
        RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_queue_thread_delete_federation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_server_id uuid;
BEGIN
    IF public.is_history_import() THEN
        RETURN NULL;
    END IF;
    SELECT s.id INTO v_server_id
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id
     WHERE c.id = OLD.channel_id
       AND s.is_local_server IS TRUE
       AND s.federation_enabled IS TRUE;
    IF v_server_id IS NULL THEN
        RETURN NULL;
    END IF;

    PERFORM public.queue_federation_job(
        'federate-thread',
        jsonb_build_object(
            'type', 'delete', 'thread_id', OLD.id, 'ap_id', OLD.ap_id,
            'channel_id', OLD.channel_id, 'server_id', v_server_id, 'server_is_local', true,
            'created_by', OLD.created_by
        ), 5, 5, 900
    );
    RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.broadcast_thread_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_channel_id uuid;
  v_server_id  uuid;
BEGIN
    IF public.is_history_import() THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
  IF TG_OP = 'DELETE' THEN
    v_channel_id := OLD.channel_id;
  ELSE
    v_channel_id := NEW.channel_id;
  END IF;

  SELECT server_id INTO v_server_id
  FROM channels
  WHERE id = v_channel_id;

  IF v_server_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF public.channel_is_restricted(v_channel_id) THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type', 'thread:' || lower(TG_OP),
        'restricted', true,
        'new', CASE WHEN TG_OP != 'DELETE' THEN jsonb_build_object(
                 'id', NEW.id, 'channel_id', NEW.channel_id) ELSE NULL END,
        'old', CASE WHEN TG_OP != 'INSERT' THEN jsonb_build_object(
                 'id', OLD.id, 'channel_id', OLD.channel_id) ELSE NULL END
      ),
      'server_event',
      'server-structure:' || v_server_id::text,
      true
    );
  ELSE
    PERFORM realtime.send(
      jsonb_build_object(
        'type', 'thread:' || lower(TG_OP),
        'new', CASE WHEN TG_OP != 'DELETE' THEN to_jsonb(NEW) ELSE NULL END,
        'old', CASE WHEN TG_OP != 'INSERT' THEN to_jsonb(OLD) ELSE NULL END
      ),
      'server_event',
      'server-structure:' || v_server_id::text,
      true
    );
  END IF;

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_threads_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
    -- A history import leaves the thread's updated_at as supplied. Read inline: this trigger function runs as the caller, who cannot execute the flag reader.
    IF current_setting('harmony.history_import', true) = 'true' THEN
        RETURN NEW;
    END IF;
    NEW.updated_at = now();
    RETURN NEW;
END;
$function$;

COMMIT;

NOTIFY pgrst, 'reload schema';
