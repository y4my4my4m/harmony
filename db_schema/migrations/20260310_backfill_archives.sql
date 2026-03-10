BEGIN;

-- =============================================================================
-- Backfill missing items from archives into existing deployments
-- All operations are idempotent (safe to re-run)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Federation endpoint health table: add missing columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.federation_endpoint_health
    ADD COLUMN IF NOT EXISTS domain text,
    ADD COLUMN IF NOT EXISTS first_failure_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS consecutive_failures integer DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_failures integer DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_successes integer DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_http_status integer,
    ADD COLUMN IF NOT EXISTS last_error_message text;

-- Backfill domain from endpoint_url for existing rows
UPDATE public.federation_endpoint_health
SET domain = regexp_replace(endpoint_url, '^https?://([^/]+).*$', '\1')
WHERE domain IS NULL AND endpoint_url IS NOT NULL;

-- Make domain NOT NULL after backfill (skip if constraint already exists)
DO $$ BEGIN
    ALTER TABLE public.federation_endpoint_health ALTER COLUMN domain SET NOT NULL;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_federation_endpoint_health_domain ON public.federation_endpoint_health(domain);

-- ---------------------------------------------------------------------------
-- 2. cleanup_dead_endpoint_users function
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cleanup_dead_endpoint_users(p_endpoint_url text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_dead_profiles RECORD;
    v_follows_removed integer := 0;
BEGIN
    FOR v_dead_profiles IN
        SELECT id, username, domain, inbox_url, shared_inbox_url
        FROM profiles
        WHERE (inbox_url = p_endpoint_url OR shared_inbox_url = p_endpoint_url)
        AND is_local = false
    LOOP
        DELETE FROM follows WHERE following_id = v_dead_profiles.id;
        GET DIAGNOSTICS v_follows_removed = ROW_COUNT;
        DELETE FROM follows WHERE follower_id = v_dead_profiles.id;
        UPDATE profiles SET inbox_url = NULL, shared_inbox_url = NULL, updated_at = NOW()
        WHERE id = v_dead_profiles.id;
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. trigger_cleanup_dead_endpoint (replace stub with real impl)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_cleanup_dead_endpoint()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
    IF NEW.is_dead = true AND (OLD.is_dead IS NULL OR OLD.is_dead = false) THEN
        PERFORM cleanup_dead_endpoint_users(NEW.endpoint_url);
    END IF;
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. update_endpoint_health RPC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_endpoint_health(
    p_endpoint_url text, p_domain text, p_success boolean,
    p_http_status integer DEFAULT NULL, p_error_message text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_health_record RECORD;
    v_is_permanent_error boolean;
BEGIN
    v_is_permanent_error := p_http_status IN (404, 410);
    SELECT * INTO v_health_record FROM federation_endpoint_health WHERE endpoint_url = p_endpoint_url FOR UPDATE;
    IF NOT FOUND THEN
        INSERT INTO federation_endpoint_health (
            endpoint_url, domain, is_dead, first_failure_at, last_success_at, last_failure_at,
            consecutive_failures, total_failures, total_successes, last_http_status, last_error_message
        ) VALUES (
            p_endpoint_url, p_domain, false,
            CASE WHEN NOT p_success THEN NOW() ELSE NULL END,
            CASE WHEN p_success THEN NOW() ELSE NULL END,
            CASE WHEN NOT p_success THEN NOW() ELSE NULL END,
            CASE WHEN NOT p_success THEN 1 ELSE 0 END,
            CASE WHEN NOT p_success THEN 1 ELSE 0 END,
            CASE WHEN p_success THEN 1 ELSE 0 END,
            p_http_status, p_error_message
        );
        RETURN;
    END IF;
    IF p_success THEN
        UPDATE federation_endpoint_health SET
            is_dead = false, last_success_at = NOW(), consecutive_failures = 0,
            total_successes = total_successes + 1, last_http_status = p_http_status,
            last_error_message = NULL, first_failure_at = NULL, updated_at = NOW()
        WHERE endpoint_url = p_endpoint_url;
    ELSE
        UPDATE federation_endpoint_health SET
            last_failure_at = NOW(), consecutive_failures = consecutive_failures + 1,
            total_failures = total_failures + 1, last_http_status = p_http_status,
            last_error_message = p_error_message,
            first_failure_at = COALESCE(first_failure_at, NOW()), updated_at = NOW()
        WHERE endpoint_url = p_endpoint_url
        RETURNING * INTO v_health_record;
        IF v_health_record.first_failure_at IS NOT NULL THEN
            IF (v_is_permanent_error AND NOW() - v_health_record.first_failure_at >= INTERVAL '24 hours')
                OR (NOW() - v_health_record.first_failure_at >= INTERVAL '48 hours') THEN
                UPDATE federation_endpoint_health SET is_dead = true, updated_at = NOW()
                WHERE endpoint_url = p_endpoint_url;
            END IF;
        END IF;
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Improved create_federated_profile (with domain protection, public_key, shared_inbox_url)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.create_federated_profile(text, text, text, text, text, text, text, text, text, text, text);
CREATE OR REPLACE FUNCTION public.create_federated_profile(
    p_username text, p_display_name text DEFAULT NULL, p_domain text DEFAULT NULL,
    p_avatar_url text DEFAULT NULL, p_banner_url text DEFAULT NULL,
    p_federated_id text DEFAULT NULL, p_bio text DEFAULT NULL,
    p_inbox_url text DEFAULT NULL, p_outbox_url text DEFAULT NULL,
    p_followers_url text DEFAULT NULL, p_following_url text DEFAULT NULL,
    p_public_key text DEFAULT NULL, p_shared_inbox_url text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_profile_id uuid;
    v_instance_domain text;
BEGIN
    SELECT COALESCE(
        (SELECT trim(both '"' from config_value::text) FROM instance_config WHERE config_key = 'domain'),
        'localhost'
    ) INTO v_instance_domain;
    IF p_domain = v_instance_domain THEN
        RAISE WARNING 'Refusing to create federated profile for local domain: %@%', p_username, p_domain;
        SELECT id INTO v_profile_id FROM profiles WHERE username = p_username AND domain = p_domain AND is_local = true;
        RETURN v_profile_id;
    END IF;
    INSERT INTO profiles (
        username, display_name, domain, avatar_url, banner_url, federated_id, bio,
        inbox_url, outbox_url, followers_url, following_url, public_key, shared_inbox_url,
        is_local, last_synced_at
    ) VALUES (
        p_username, COALESCE(p_display_name, p_username), p_domain, p_avatar_url, p_banner_url,
        p_federated_id, p_bio, p_inbox_url, p_outbox_url, p_followers_url, p_following_url,
        p_public_key, p_shared_inbox_url, false, NOW()
    )
    ON CONFLICT (username, domain) DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, profiles.display_name),
        avatar_url = COALESCE(EXCLUDED.avatar_url, profiles.avatar_url),
        banner_url = COALESCE(EXCLUDED.banner_url, profiles.banner_url),
        federated_id = COALESCE(EXCLUDED.federated_id, profiles.federated_id),
        bio = COALESCE(EXCLUDED.bio, profiles.bio),
        inbox_url = COALESCE(EXCLUDED.inbox_url, profiles.inbox_url),
        outbox_url = COALESCE(EXCLUDED.outbox_url, profiles.outbox_url),
        followers_url = COALESCE(EXCLUDED.followers_url, profiles.followers_url),
        following_url = COALESCE(EXCLUDED.following_url, profiles.following_url),
        public_key = COALESCE(EXCLUDED.public_key, profiles.public_key),
        shared_inbox_url = COALESCE(EXCLUDED.shared_inbox_url, profiles.shared_inbox_url),
        last_synced_at = NOW(), updated_at = NOW()
    WHERE profiles.is_local = false
    RETURNING id INTO v_profile_id;
    IF v_profile_id IS NULL THEN
        SELECT id INTO v_profile_id FROM profiles WHERE username = p_username AND domain = p_domain;
    END IF;
    RETURN v_profile_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. safe_upsert_remote_profile
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.safe_upsert_remote_profile(
    p_username text, p_domain text,
    p_federated_id text DEFAULT NULL, p_display_name text DEFAULT NULL,
    p_avatar_url text DEFAULT NULL, p_banner_url text DEFAULT NULL,
    p_bio text DEFAULT NULL, p_public_key text DEFAULT NULL,
    p_inbox_url text DEFAULT NULL, p_outbox_url text DEFAULT NULL,
    p_followers_url text DEFAULT NULL, p_following_url text DEFAULT NULL,
    p_shared_inbox_url text DEFAULT NULL
) RETURNS TABLE(profile_id uuid, was_created boolean, was_updated boolean, is_local_user boolean)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_profile_id uuid; v_was_created boolean := false;
    v_was_updated boolean := false; v_is_local_user boolean := false;
    v_instance_domain text;
BEGIN
    SELECT COALESCE(
        (SELECT trim(both '"' from config_value::text) FROM instance_config WHERE config_key = 'domain'),
        'localhost'
    ) INTO v_instance_domain;
    IF p_domain = v_instance_domain THEN
        SELECT id, true INTO v_profile_id, v_is_local_user
        FROM profiles WHERE username = p_username AND domain = p_domain AND is_local = true;
        RETURN QUERY SELECT v_profile_id, false, false, true;
        RETURN;
    END IF;
    SELECT id, is_local INTO v_profile_id, v_is_local_user
    FROM profiles WHERE username = p_username AND domain = p_domain;
    IF v_profile_id IS NULL THEN
        INSERT INTO profiles (
            username, domain, federated_id, display_name, avatar_url, banner_url,
            bio, public_key, inbox_url, outbox_url, followers_url, following_url,
            shared_inbox_url, is_local, last_synced_at
        ) VALUES (
            p_username, p_domain, p_federated_id, COALESCE(p_display_name, p_username),
            p_avatar_url, p_banner_url, p_bio, p_public_key, p_inbox_url, p_outbox_url,
            p_followers_url, p_following_url, p_shared_inbox_url, false, NOW()
        ) RETURNING id INTO v_profile_id;
        v_was_created := true;
    ELSIF NOT v_is_local_user THEN
        UPDATE profiles SET
            federated_id = COALESCE(p_federated_id, federated_id),
            display_name = COALESCE(p_display_name, display_name),
            avatar_url = COALESCE(p_avatar_url, avatar_url),
            banner_url = COALESCE(p_banner_url, banner_url),
            bio = COALESCE(p_bio, bio),
            public_key = COALESCE(p_public_key, public_key),
            inbox_url = COALESCE(p_inbox_url, inbox_url),
            outbox_url = COALESCE(p_outbox_url, outbox_url),
            followers_url = COALESCE(p_followers_url, followers_url),
            following_url = COALESCE(p_following_url, following_url),
            shared_inbox_url = COALESCE(p_shared_inbox_url, shared_inbox_url),
            last_synced_at = NOW(), updated_at = NOW()
        WHERE id = v_profile_id;
        v_was_updated := true;
    END IF;
    RETURN QUERY SELECT v_profile_id, v_was_created, v_was_updated, v_is_local_user;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. clear_orphaned_public_keys
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.clear_orphaned_public_keys()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE cleared_count INTEGER;
BEGIN
    UPDATE profiles p SET public_key = NULL
    WHERE p.is_local = true AND p.public_key IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM user_private_keys upk WHERE upk.user_id = p.id);
    GET DIAGNOSTICS cleared_count = ROW_COUNT;
    RETURN cleared_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. get_voice_channel_participants
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_voice_channel_participants(p_channel_id UUID)
RETURNS TABLE (
    user_id UUID, username TEXT, display_name TEXT, avatar_url TEXT,
    is_federated BOOLEAN, federated_domain TEXT, joined_at TIMESTAMPTZ,
    is_muted BOOLEAN, is_deafened BOOLEAN, is_video_enabled BOOLEAN,
    is_screen_sharing BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT vcp.user_id, p.username, p.display_name, p.avatar_url,
        vcp.is_federated, p.domain AS federated_domain, vcp.joined_at,
        vcp.is_muted, vcp.is_deafened, vcp.is_video_enabled, vcp.is_screen_sharing
    FROM public.voice_channel_participants vcp
    JOIN public.profiles p ON p.id = vcp.user_id
    WHERE vcp.channel_id = p_channel_id
    ORDER BY vcp.joined_at ASC;
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. get_next_folder_position / get_next_server_position
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_next_folder_position(p_user_id UUID)
RETURNS INTEGER LANGUAGE plpgsql STABLE AS $$
DECLARE max_position INTEGER;
BEGIN
    SELECT COALESCE(MAX(position), -1) + 1 INTO max_position
    FROM server_folders WHERE user_id = p_user_id;
    RETURN max_position;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_next_server_position(p_user_id UUID, p_folder_id UUID DEFAULT NULL)
RETURNS INTEGER LANGUAGE plpgsql STABLE AS $$
DECLARE max_position INTEGER;
BEGIN
    IF p_folder_id IS NULL THEN
        SELECT COALESCE(MAX(position), -1) + 1 INTO max_position
        FROM user_servers WHERE user_id = p_user_id AND folder_id IS NULL;
    ELSE
        SELECT COALESCE(MAX(position), -1) + 1 INTO max_position
        FROM user_servers WHERE user_id = p_user_id AND folder_id = p_folder_id;
    END IF;
    RETURN max_position;
END;
$$;

-- ---------------------------------------------------------------------------
-- 10. record_metric
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_metric(
    p_metric_type text, p_metric_name text, p_value double precision,
    p_unit text DEFAULT 'ms', p_labels jsonb DEFAULT '{}'::jsonb,
    p_source text DEFAULT 'backend'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE v_id uuid;
BEGIN
    INSERT INTO public.performance_metrics (
        metric_type, metric_name, value, unit, labels, source
    ) VALUES (
        p_metric_type, p_metric_name, p_value, p_unit, p_labels, p_source
    ) RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 11. Federation status indexes on channels/channel_categories
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_channels_federation_status ON public.channels(federation_status) WHERE federation_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_channel_categories_federation_status ON public.channel_categories(federation_status) WHERE federation_status = 'pending';

-- ---------------------------------------------------------------------------
-- 12. Profile federation trigger with custom_status support
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_queue_profile_federation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_job_id uuid;
    v_has_pgboss boolean := false;
BEGIN
    IF NEW.is_local != true THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' THEN
        IF (
            OLD.display_name IS NOT DISTINCT FROM NEW.display_name AND
            OLD.bio IS NOT DISTINCT FROM NEW.bio AND
            OLD.avatar_url IS NOT DISTINCT FROM NEW.avatar_url AND
            OLD.banner_url IS NOT DISTINCT FROM NEW.banner_url AND
            OLD.custom_status IS NOT DISTINCT FROM NEW.custom_status
        ) THEN RETURN NEW; END IF;
    END IF;
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_schema = 'pgboss' AND table_name = 'job'
    ) INTO v_has_pgboss;
    IF v_has_pgboss THEN
        INSERT INTO pgboss.job (id, name, data, priority, retry_limit, expire_in, created_on, state)
        VALUES (gen_random_uuid(), 'federate-profile',
            jsonb_build_object(
                'type', CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END,
                'profile_id', NEW.id, 'username', NEW.username,
                'display_name', NEW.display_name, 'bio', NEW.bio,
                'avatar_url', NEW.avatar_url, 'banner_url', NEW.banner_url,
                'custom_status', NEW.custom_status
            ), 3, 5, interval '1 hour', now(), 'created'
        ) RETURNING id INTO v_job_id;
    END IF;
    RETURN NEW;
EXCEPTION
    WHEN undefined_table THEN RETURN NEW;
    WHEN OTHERS THEN
        RAISE LOG 'Profile federation error: %', SQLERRM;
        RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 13. Thread federation trigger + trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_queue_thread_federation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_server_id UUID; v_server_is_local BOOLEAN; v_creator_is_local BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT c.server_id, s.is_local_server INTO v_server_id, v_server_is_local
        FROM public.channels c JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;
        SELECT is_local INTO v_creator_is_local FROM public.profiles WHERE id = NEW.created_by;
        IF v_creator_is_local IS NOT TRUE THEN
            NEW.federation_status := 'skipped'; RETURN NEW;
        END IF;
        NEW.federation_status := 'queued';
        PERFORM public.queue_federation_job('federate-thread',
            jsonb_build_object('type', 'create', 'thread_id', NEW.id, 'channel_id', NEW.channel_id,
                'server_id', v_server_id, 'server_is_local', COALESCE(v_server_is_local, true),
                'created_by', NEW.created_by, 'created_at', NEW.created_at),
            5, 5, 900);
    ELSIF TG_OP = 'UPDATE' THEN
        IF (OLD.name IS NOT DISTINCT FROM NEW.name AND OLD.archived IS NOT DISTINCT FROM NEW.archived
            AND OLD.locked IS NOT DISTINCT FROM NEW.locked) THEN
            RETURN NEW;
        END IF;
        SELECT c.server_id, s.is_local_server INTO v_server_id, v_server_is_local
        FROM public.channels c JOIN public.servers s ON c.server_id = s.id WHERE c.id = NEW.channel_id;
        SELECT is_local INTO v_creator_is_local FROM public.profiles WHERE id = NEW.created_by;
        IF v_creator_is_local IS NOT TRUE THEN RETURN NEW; END IF;
        IF NEW.federation_status = 'local' OR NEW.federation_status IS NULL THEN
            NEW.federation_status := 'queued';
        END IF;
        PERFORM public.queue_federation_job('federate-thread',
            jsonb_build_object('type', 'update', 'thread_id', NEW.id, 'channel_id', NEW.channel_id,
                'server_id', v_server_id, 'server_is_local', COALESCE(v_server_is_local, true),
                'created_by', NEW.created_by),
            5, 5, 900);
    END IF;
    RETURN NEW;
EXCEPTION
    WHEN undefined_table THEN RETURN NEW;
    WHEN OTHERS THEN
        RAISE LOG 'Thread federation error: %', SQLERRM;
        RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_federate_thread ON public.threads;
CREATE TRIGGER trigger_federate_thread
    AFTER INSERT OR UPDATE ON public.threads
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_thread_federation();

-- ---------------------------------------------------------------------------
-- 14. Unpin-on-delete trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_pinned_message_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.is_deleted = true AND OLD.is_deleted = false THEN
        NEW.is_pinned := false;
        NEW.pinned_at := NULL;
        NEW.pinned_by := NULL;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_unpin_on_delete ON public.messages;
CREATE TRIGGER trigger_unpin_on_delete
    BEFORE UPDATE OF is_deleted ON public.messages
    FOR EACH ROW
    WHEN (NEW.is_deleted = true AND OLD.is_deleted = false AND OLD.is_pinned = true)
    EXECUTE FUNCTION public.handle_pinned_message_delete();

-- ---------------------------------------------------------------------------
-- 15. enable/disable federation triggers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enable_federation_triggers()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    ALTER TABLE public.posts ENABLE TRIGGER trigger_federate_post;
    ALTER TABLE public.post_interactions ENABLE TRIGGER trigger_federate_post_interaction;
    ALTER TABLE public.post_interactions ENABLE TRIGGER trigger_federate_post_interaction_delete;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow_delete;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_dm;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message_edit;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message_delete;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_message_reaction;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_message_reaction_delete;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_channel_reaction;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_channel_reaction_delete;
    ALTER TABLE public.user_blocks ENABLE TRIGGER trigger_federate_block;
    ALTER TABLE public.user_blocks ENABLE TRIGGER trigger_federate_block_delete;
    ALTER TABLE public.reports ENABLE TRIGGER trigger_federate_report;
    ALTER TABLE public.profiles ENABLE TRIGGER trigger_federate_profile;
    ALTER TABLE public.threads ENABLE TRIGGER trigger_federate_thread;
    ALTER TABLE public.voice_channel_participants ENABLE TRIGGER trigger_federate_voice_channel_join;
    ALTER TABLE public.voice_channel_participants ENABLE TRIGGER trigger_federate_voice_channel_leave;
END;
$$;

CREATE OR REPLACE FUNCTION public.disable_federation_triggers()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    ALTER TABLE public.posts DISABLE TRIGGER trigger_federate_post;
    ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_federate_post_interaction;
    ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_federate_post_interaction_delete;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow_delete;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_dm;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message_edit;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message_delete;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_message_reaction;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_message_reaction_delete;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_channel_reaction;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_channel_reaction_delete;
    ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block;
    ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block_delete;
    ALTER TABLE public.reports DISABLE TRIGGER trigger_federate_report;
    ALTER TABLE public.profiles DISABLE TRIGGER trigger_federate_profile;
    ALTER TABLE public.threads DISABLE TRIGGER trigger_federate_thread;
    ALTER TABLE public.voice_channel_participants DISABLE TRIGGER trigger_federate_voice_channel_join;
    ALTER TABLE public.voice_channel_participants DISABLE TRIGGER trigger_federate_voice_channel_leave;
END;
$$;

COMMIT;
