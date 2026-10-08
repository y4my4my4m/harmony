-- 20261009200001_table_layout_convergence.sql: the columns, keys, constraints and indexes
-- production and staging lacked or carried beyond a fresh install. A fresh install already has
-- them; a converged live copy matches.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(30);

SELECT has_column('public', 'user_servers', 'nickname', 'user_servers has nickname');
SELECT has_column('public', 'user_servers', 'muted', 'user_servers has muted');
SELECT has_column('public', 'user_servers', 'muted_until', 'user_servers has muted_until');
SELECT has_column('public', 'user_servers', 'updated_at', 'user_servers has updated_at');
SELECT col_type_is('public', 'user_servers', 'id', 'uuid', 'user_servers.id is uuid');
SELECT has_trigger('public', 'user_servers', 'sanitize_member_nickname_trigger',
                   'nicknames pass through sanitize_member_nickname');
SELECT col_has_check('public', 'user_servers', 'nickname', 'nickname length is bounded');

SELECT has_column('public', 'servers', 'invite_code', 'servers has invite_code');
SELECT has_column('public', 'notification_preferences', 'push_replies', 'notification_preferences has push_replies');
SELECT has_column('public', 'conversation_encryption_settings', 'history_visibility',
                  'conversation_encryption_settings has history_visibility');
SELECT col_not_null('public', 'mfa_recovery_codes', 'batch_id', 'every recovery code belongs to a batch');
SELECT col_not_null('public', 'timeline_entries', 'position', 'every timeline entry has a position');

SELECT is_empty(
    $q$SELECT table_name || '.' || column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (
              ('ap_object_cache', 'ap_id'), ('files', 'owner'), ('bot_webhooks', 'max_retries'),
              ('bot_commands', 'category'), ('blocked_instances', 'block_type'),
              ('server_federation_events', 'server_domain'), ('voice_federation_events', 'session_id'),
              ('federation_delivery_queue', 'activity_json'), ('federation_delivery_queue', 'inbox_url'),
              ('megolm_key_backups', 'is_current'), ('user_key_pairs', 'identity_key'),
              ('conversation_encryption_settings', 'metadata'),
              ('post_hashtags', 'id'), ('timeline_entries', 'metadata'))$q$,
    'no column of a pre-baseline layout');

SELECT col_is_pk('public', 'bot_presence', 'id', 'bot_presence is keyed on id');
SELECT col_is_unique('public', 'bot_presence', 'bot_id', 'one presence row per bot');
SELECT col_is_pk('public', 'user_view_contexts', 'id', 'user_view_contexts is keyed on id');
SELECT col_is_pk('public', 'post_hashtags', ARRAY['post_id', 'hashtag_id'], 'post_hashtags is keyed on (post_id, hashtag_id)');
SELECT col_is_unique('public', 'megolm_session_shares', ARRAY['room_id', 'session_id', 'recipient_user_id'],
                     'the client''s session-share upsert has its arbiter');
SELECT col_is_unique('public', 'invites', 'code', 'invite codes are unique');
SELECT col_is_unique('public', 'timeline_entries', ARRAY['user_id', 'post_id', 'timeline_type'],
                     'timeline writers'' ON CONFLICT has its arbiter');

SELECT col_type_is('public', 'channel_categories', 'order', 'integer', 'channel_categories.order is integer');
SELECT col_type_is('public', 'invites', 'code', 'text', 'invites.code is text');
SELECT col_type_is('public', 'bot_commands', 'required_permissions', 'bigint', 'bot_commands.required_permissions is bigint');

SELECT is((SELECT confdeltype::text FROM pg_constraint
            WHERE conrelid = 'public.messages'::regclass AND conname = 'messages_reply_to_fkey'),
          'n', 'deleting a message keeps its replies');
SELECT is((SELECT confdeltype::text FROM pg_constraint
            WHERE conrelid = 'public.messages'::regclass AND conname = 'messages_thread_id_fkey'),
          'n', 'deleting a thread keeps its messages');
SELECT is((SELECT confdeltype::text FROM pg_constraint
            WHERE conrelid = 'public.servers'::regclass AND conname = 'servers_owner_fkey'),
          'n', 'deleting a profile keeps the servers it owns');
SELECT fk_ok('public', 'emoji_usage', 'user_id', 'public', 'profiles', 'id', 'emoji_usage names profiles');
SELECT fk_ok('public', 'mfa_recovery_codes', 'user_id', 'public', 'profiles', 'id', 'mfa_recovery_codes names profiles');

SELECT lives_ok(
    $q$INSERT INTO public.server_membership_events (server_id, user_id, event_type, payload)
       VALUES ('55555555-0000-0000-0000-000000000005', '44444444-0000-0000-0000-000000000004', 'unban', '{}')$q$,
    'an unban event is recorded');

SELECT is_empty(
    $q$SELECT k.conname FROM pg_constraint k
        WHERE k.conrelid = 'public.federation_delivery_queue'::regclass AND k.contype = 'c'
          AND pg_get_constraintdef(k.oid) LIKE '%inbox_url%' AND pg_get_constraintdef(k.oid) NOT LIKE '%target_inbox_url%'$q$,
    'federation_delivery_queue checks no legacy column');

SELECT * FROM finish();
ROLLBACK;
