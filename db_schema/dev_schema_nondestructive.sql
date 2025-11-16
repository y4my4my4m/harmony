--
-- PostgreSQL database dump
--

-- Dumped from database version 15.8
-- Dumped by pg_dump version 15.8

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: _realtime; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA _realtime;


--
-- Name: auth; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA auth;


--
-- Name: pg_cron; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;


--
-- Name: EXTENSION pg_cron; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_cron IS 'Job scheduler for PostgreSQL';


--
-- Name: extensions; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA extensions;


--
-- Name: graphql; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA graphql;


--
-- Name: graphql_public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA graphql_public;


--
-- Name: pg_net; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;


--
-- Name: EXTENSION pg_net; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_net IS 'Async HTTP';


--
-- Name: pgbouncer; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA pgbouncer;


--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: realtime; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA realtime;


--
-- Name: storage; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA storage;


--
-- Name: supabase_functions; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA supabase_functions;


--
-- Name: vault; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA vault;


--
-- Name: plv8; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS plv8 WITH SCHEMA pg_catalog;


--
-- Name: EXTENSION plv8; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION plv8 IS 'PL/JavaScript (v8) trusted procedural language';


--
-- Name: http; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA extensions;


--
-- Name: EXTENSION http; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION http IS 'HTTP client for PostgreSQL, allows web page retrieval inside the database.';


--
-- Name: pg_graphql; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_graphql WITH SCHEMA graphql;


--
-- Name: EXTENSION pg_graphql; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_graphql IS 'pg_graphql: GraphQL support';


--
-- Name: pg_stat_statements; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;


--
-- Name: EXTENSION pg_stat_statements; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_stat_statements IS 'track planning and execution statistics of all SQL statements executed';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: pgjwt; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgjwt WITH SCHEMA extensions;


--
-- Name: EXTENSION pgjwt; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgjwt IS 'JSON Web Token API for Postgresql';


--
-- Name: supabase_vault; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;


--
-- Name: EXTENSION supabase_vault; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION supabase_vault IS 'Supabase Vault Extension';


--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: aal_level; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.aal_level AS ENUM (
    'aal1',
    'aal2',
    'aal3'
);


--
-- Name: code_challenge_method; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.code_challenge_method AS ENUM (
    's256',
    'plain'
);


--
-- Name: factor_status; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.factor_status AS ENUM (
    'unverified',
    'verified'
);


--
-- Name: factor_type; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.factor_type AS ENUM (
    'totp',
    'webauthn',
    'phone'
);


--
-- Name: one_time_token_type; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.one_time_token_type AS ENUM (
    'confirmation_token',
    'reauthentication_token',
    'recovery_token',
    'email_change_token_new',
    'email_change_token_current',
    'phone_change_token'
);


--
-- Name: action; Type: TYPE; Schema: realtime; Owner: -
--

CREATE TYPE realtime.action AS ENUM (
    'INSERT',
    'UPDATE',
    'DELETE',
    'TRUNCATE',
    'ERROR'
);


--
-- Name: equality_op; Type: TYPE; Schema: realtime; Owner: -
--

CREATE TYPE realtime.equality_op AS ENUM (
    'eq',
    'neq',
    'lt',
    'lte',
    'gt',
    'gte',
    'in'
);


--
-- Name: user_defined_filter; Type: TYPE; Schema: realtime; Owner: -
--

CREATE TYPE realtime.user_defined_filter AS (
	column_name text,
	op realtime.equality_op,
	value text
);


--
-- Name: wal_column; Type: TYPE; Schema: realtime; Owner: -
--

CREATE TYPE realtime.wal_column AS (
	name text,
	type_name text,
	type_oid oid,
	value jsonb,
	is_pkey boolean,
	is_selectable boolean
);


--
-- Name: wal_rls; Type: TYPE; Schema: realtime; Owner: -
--

CREATE TYPE realtime.wal_rls AS (
	wal jsonb,
	is_rls_enabled boolean,
	subscription_ids uuid[],
	errors text[]
);


--
-- Name: email(); Type: FUNCTION; Schema: auth; Owner: -
--

CREATE FUNCTION auth.email() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;


--
-- Name: FUNCTION email(); Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON FUNCTION auth.email() IS 'Deprecated. Use auth.jwt() -> ''email'' instead.';


--
-- Name: jwt(); Type: FUNCTION; Schema: auth; Owner: -
--

CREATE FUNCTION auth.jwt() RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  select 
    coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
$$;


--
-- Name: role(); Type: FUNCTION; Schema: auth; Owner: -
--

CREATE FUNCTION auth.role() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;


--
-- Name: FUNCTION role(); Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON FUNCTION auth.role() IS 'Deprecated. Use auth.jwt() -> ''role'' instead.';


--
-- Name: uid(); Type: FUNCTION; Schema: auth; Owner: -
--

CREATE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;


--
-- Name: FUNCTION uid(); Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON FUNCTION auth.uid() IS 'Deprecated. Use auth.jwt() -> ''sub'' instead.';


--
-- Name: grant_pg_cron_access(); Type: FUNCTION; Schema: extensions; Owner: -
--

CREATE FUNCTION extensions.grant_pg_cron_access() RETURNS event_trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (
    SELECT
    FROM pg_event_trigger_ddl_commands() AS ev
    JOIN pg_extension AS ext
    ON ev.objid = ext.oid
    WHERE ext.extname = 'pg_cron'
  )
  THEN
    grant usage on schema cron to postgres with grant option;

    alter default privileges in schema cron grant all on tables to postgres with grant option;
    alter default privileges in schema cron grant all on functions to postgres with grant option;
    alter default privileges in schema cron grant all on sequences to postgres with grant option;

    alter default privileges for user supabase_admin in schema cron grant all
        on sequences to postgres with grant option;
    alter default privileges for user supabase_admin in schema cron grant all
        on tables to postgres with grant option;
    alter default privileges for user supabase_admin in schema cron grant all
        on functions to postgres with grant option;

    grant all privileges on all tables in schema cron to postgres with grant option;
    revoke all on table cron.job from postgres;
    grant select on table cron.job to postgres with grant option;
  END IF;
END;
$$;


--
-- Name: FUNCTION grant_pg_cron_access(); Type: COMMENT; Schema: extensions; Owner: -
--

COMMENT ON FUNCTION extensions.grant_pg_cron_access() IS 'Grants access to pg_cron';


--
-- Name: grant_pg_graphql_access(); Type: FUNCTION; Schema: extensions; Owner: -
--

CREATE FUNCTION extensions.grant_pg_graphql_access() RETURNS event_trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
    func_is_graphql_resolve bool;
BEGIN
    func_is_graphql_resolve = (
        SELECT n.proname = 'resolve'
        FROM pg_event_trigger_ddl_commands() AS ev
        LEFT JOIN pg_catalog.pg_proc AS n
        ON ev.objid = n.oid
    );

    IF func_is_graphql_resolve
    THEN
        -- Update public wrapper to pass all arguments through to the pg_graphql resolve func
        DROP FUNCTION IF EXISTS graphql_public.graphql;
        create or replace function graphql_public.graphql(
            "operationName" text default null,
            query text default null,
            variables jsonb default null,
            extensions jsonb default null
        )
            returns jsonb
            language sql
        as $$
            select graphql.resolve(
                query := query,
                variables := coalesce(variables, '{}'),
                "operationName" := "operationName",
                extensions := extensions
            );
        $$;

        -- This hook executes when `graphql.resolve` is created. That is not necessarily the last
        -- function in the extension so we need to grant permissions on existing entities AND
        -- update default permissions to any others that are created after `graphql.resolve`
        grant usage on schema graphql to postgres, anon, authenticated, service_role;
        grant select on all tables in schema graphql to postgres, anon, authenticated, service_role;
        grant execute on all functions in schema graphql to postgres, anon, authenticated, service_role;
        grant all on all sequences in schema graphql to postgres, anon, authenticated, service_role;
        alter default privileges in schema graphql grant all on tables to postgres, anon, authenticated, service_role;
        alter default privileges in schema graphql grant all on functions to postgres, anon, authenticated, service_role;
        alter default privileges in schema graphql grant all on sequences to postgres, anon, authenticated, service_role;

        -- Allow postgres role to allow granting usage on graphql and graphql_public schemas to custom roles
        grant usage on schema graphql_public to postgres with grant option;
        grant usage on schema graphql to postgres with grant option;
    END IF;

END;
$_$;


--
-- Name: FUNCTION grant_pg_graphql_access(); Type: COMMENT; Schema: extensions; Owner: -
--

COMMENT ON FUNCTION extensions.grant_pg_graphql_access() IS 'Grants access to pg_graphql';


--
-- Name: grant_pg_net_access(); Type: FUNCTION; Schema: extensions; Owner: -
--

CREATE FUNCTION extensions.grant_pg_net_access() RETURNS event_trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_event_trigger_ddl_commands() AS ev
    JOIN pg_extension AS ext
    ON ev.objid = ext.oid
    WHERE ext.extname = 'pg_net'
  )
  THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_roles
      WHERE rolname = 'supabase_functions_admin'
    )
    THEN
      CREATE USER supabase_functions_admin NOINHERIT CREATEROLE LOGIN NOREPLICATION;
    END IF;

    GRANT USAGE ON SCHEMA net TO supabase_functions_admin, postgres, anon, authenticated, service_role;

    IF EXISTS (
      SELECT FROM pg_extension
      WHERE extname = 'pg_net'
      -- all versions in use on existing projects as of 2025-02-20
      -- version 0.12.0 onwards don't need these applied
      AND extversion IN ('0.2', '0.6', '0.7', '0.7.1', '0.8', '0.10.0', '0.11.0')
    ) THEN
      ALTER function net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) SECURITY DEFINER;
      ALTER function net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) SECURITY DEFINER;

      ALTER function net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) SET search_path = net;
      ALTER function net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) SET search_path = net;

      REVOKE ALL ON FUNCTION net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) FROM PUBLIC;
      REVOKE ALL ON FUNCTION net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) FROM PUBLIC;

      GRANT EXECUTE ON FUNCTION net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) TO supabase_functions_admin, postgres, anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) TO supabase_functions_admin, postgres, anon, authenticated, service_role;
    END IF;
  END IF;
END;
$$;


--
-- Name: FUNCTION grant_pg_net_access(); Type: COMMENT; Schema: extensions; Owner: -
--

COMMENT ON FUNCTION extensions.grant_pg_net_access() IS 'Grants access to pg_net';


--
-- Name: pgrst_ddl_watch(); Type: FUNCTION; Schema: extensions; Owner: -
--

CREATE FUNCTION extensions.pgrst_ddl_watch() RETURNS event_trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN SELECT * FROM pg_event_trigger_ddl_commands()
  LOOP
    IF cmd.command_tag IN (
      'CREATE SCHEMA', 'ALTER SCHEMA'
    , 'CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'ALTER TABLE'
    , 'CREATE FOREIGN TABLE', 'ALTER FOREIGN TABLE'
    , 'CREATE VIEW', 'ALTER VIEW'
    , 'CREATE MATERIALIZED VIEW', 'ALTER MATERIALIZED VIEW'
    , 'CREATE FUNCTION', 'ALTER FUNCTION'
    , 'CREATE TRIGGER'
    , 'CREATE TYPE', 'ALTER TYPE'
    , 'CREATE RULE'
    , 'COMMENT'
    )
    -- don't notify in case of CREATE TEMP table or other objects created on pg_temp
    AND cmd.schema_name is distinct from 'pg_temp'
    THEN
      NOTIFY pgrst, 'reload schema';
    END IF;
  END LOOP;
END; $$;


--
-- Name: pgrst_drop_watch(); Type: FUNCTION; Schema: extensions; Owner: -
--

CREATE FUNCTION extensions.pgrst_drop_watch() RETURNS event_trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_dropped_objects()
  LOOP
    IF obj.object_type IN (
      'schema'
    , 'table'
    , 'foreign table'
    , 'view'
    , 'materialized view'
    , 'function'
    , 'trigger'
    , 'type'
    , 'rule'
    )
    AND obj.is_temporary IS false -- no pg_temp objects
    THEN
      NOTIFY pgrst, 'reload schema';
    END IF;
  END LOOP;
END; $$;


--
-- Name: set_graphql_placeholder(); Type: FUNCTION; Schema: extensions; Owner: -
--

CREATE FUNCTION extensions.set_graphql_placeholder() RETURNS event_trigger
    LANGUAGE plpgsql
    AS $_$
    DECLARE
    graphql_is_dropped bool;
    BEGIN
    graphql_is_dropped = (
        SELECT ev.schema_name = 'graphql_public'
        FROM pg_event_trigger_dropped_objects() AS ev
        WHERE ev.schema_name = 'graphql_public'
    );

    IF graphql_is_dropped
    THEN
        create or replace function graphql_public.graphql(
            "operationName" text default null,
            query text default null,
            variables jsonb default null,
            extensions jsonb default null
        )
            returns jsonb
            language plpgsql
        as $$
            DECLARE
                server_version float;
            BEGIN
                server_version = (SELECT (SPLIT_PART((select version()), ' ', 2))::float);

                IF server_version >= 14 THEN
                    RETURN jsonb_build_object(
                        'errors', jsonb_build_array(
                            jsonb_build_object(
                                'message', 'pg_graphql extension is not enabled.'
                            )
                        )
                    );
                ELSE
                    RETURN jsonb_build_object(
                        'errors', jsonb_build_array(
                            jsonb_build_object(
                                'message', 'pg_graphql is only available on projects running Postgres 14 onwards.'
                            )
                        )
                    );
                END IF;
            END;
        $$;
    END IF;

    END;
$_$;


--
-- Name: FUNCTION set_graphql_placeholder(); Type: COMMENT; Schema: extensions; Owner: -
--

COMMENT ON FUNCTION extensions.set_graphql_placeholder() IS 'Reintroduces placeholder function for graphql_public.graphql';


--
-- Name: get_auth(text); Type: FUNCTION; Schema: pgbouncer; Owner: -
--

CREATE FUNCTION pgbouncer.get_auth(p_usename text) RETURNS TABLE(username text, password text)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    RAISE WARNING 'PgBouncer auth request: %', p_usename;

    RETURN QUERY
    SELECT usename::TEXT, passwd::TEXT FROM pg_catalog.pg_shadow
    WHERE usename = p_usename;
END;
$$;


--
-- Name: add_existing_posts_to_new_follower_timeline(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_existing_posts_to_new_follower_timeline() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    post_record RECORD;
    added_count INTEGER := 0;
BEGIN
    -- Only process accepted follows
    IF NEW.status = 'accepted' THEN
        -- Add recent public posts from the followed user to follower's home timeline
        FOR post_record IN 
            SELECT id, created_at
            FROM posts 
            WHERE author_id = NEW.following_id
              AND visibility = 'public'
              AND NOT COALESCE(is_deleted, false)
              AND created_at > NOW() - INTERVAL '7 days'  -- Only last 7 days for new follows
            ORDER BY created_at DESC
            LIMIT 50  -- Reasonable limit to avoid overwhelming
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (
                NEW.follower_id,
                post_record.id,
                'home',
                EXTRACT(epoch FROM post_record.created_at) * 1000000
            )
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
            
            added_count := added_count + 1;
        END LOOP;
        
        RAISE NOTICE 'Added % recent posts to new follower timeline', added_count;
    END IF;
    
    RETURN NEW;
END;
$$;


--
-- Name: add_post_emoji_reaction(uuid, uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_post_emoji_reaction(p_user_id uuid, p_post_id uuid, p_emoji_id uuid DEFAULT NULL::uuid, p_custom_emoji_content text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_interaction_id uuid;
BEGIN
    -- Must provide either emoji_id or custom_emoji_content
    IF p_emoji_id IS NULL AND p_custom_emoji_content IS NULL THEN
        RAISE EXCEPTION 'Must provide either emoji_id or custom_emoji_content';
    END IF;
    
    -- Insert emoji reaction
    INSERT INTO post_interactions (
        user_id,
        post_id,
        interaction_type,
        emoji_id,
        custom_emoji_content,
        is_local,
        metadata
    ) VALUES (
        p_user_id,
        p_post_id,
        'emoji_reaction',
        p_emoji_id,
        p_custom_emoji_content,
        true,
        jsonb_build_object(
            'reaction_type', CASE WHEN p_emoji_id IS NOT NULL THEN 'custom_emoji' ELSE 'unicode_emoji' END,
            'created_at', NOW()
        )
    ) RETURNING id INTO v_interaction_id;
    
    RETURN v_interaction_id;
END;
$$;


--
-- Name: FUNCTION add_post_emoji_reaction(p_user_id uuid, p_post_id uuid, p_emoji_id uuid, p_custom_emoji_content text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.add_post_emoji_reaction(p_user_id uuid, p_post_id uuid, p_emoji_id uuid, p_custom_emoji_content text) IS 'Add Misskey-style emoji reaction to posts. Supports both custom emojis and unicode content.';


--
-- Name: add_user_to_conversation(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_user_to_conversation(conversation_uuid uuid, user_uuid uuid, user_role text DEFAULT 'member'::text) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
  participant_id UUID;
BEGIN
  INSERT INTO conversation_participants (conversation_id, user_id, role)
  VALUES (conversation_uuid, user_uuid, user_role)
  ON CONFLICT (conversation_id, user_id) 
  DO UPDATE SET 
    left_at = NULL,
    role = user_role,
    updated_at = CURRENT_TIMESTAMP
  RETURNING id INTO participant_id;
  
  RETURN participant_id;
END;
$$;


--
-- Name: backfill_timeline_entries(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.backfill_timeline_entries() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    processed_count INTEGER := 0;
    post_record RECORD;
    follower_record RECORD;
BEGIN
    RAISE NOTICE 'Starting timeline backfill for existing posts...';
    
    -- Process all public posts that might be missing from follower timelines
    FOR post_record IN 
        SELECT id, author_id, created_at
        FROM posts 
        WHERE visibility = 'public' 
          AND NOT COALESCE(is_deleted, false)
          AND created_at > NOW() - INTERVAL '30 days'  -- Only last 30 days to avoid overwhelming
        ORDER BY created_at DESC
    LOOP
        -- Add to all current followers' home timelines
        FOR follower_record IN 
            SELECT f.follower_id 
            FROM follows f 
            WHERE f.following_id = post_record.author_id 
              AND f.status = 'accepted'
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (
                follower_record.follower_id, 
                post_record.id, 
                'home', 
                EXTRACT(epoch FROM post_record.created_at) * 1000000
            )
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
        END LOOP;
        
        processed_count := processed_count + 1;
        
        -- Progress logging every 100 posts
        IF processed_count % 100 = 0 THEN
            RAISE NOTICE 'Processed % posts...', processed_count;
        END IF;
    END LOOP;
    
    RAISE NOTICE 'Timeline backfill completed. Processed % posts.', processed_count;
    RETURN processed_count;
END;
$$;


--
-- Name: backfill_timeline_on_follow(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.backfill_timeline_on_follow() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    post_record RECORD;
BEGIN
    -- Only backfill when follow is accepted and follower is local
    IF NEW.status != 'accepted' THEN
        RETURN NEW;
    END IF;
    
    -- Only backfill for local followers
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = NEW.follower_id AND is_local = true) THEN
        RETURN NEW;
    END IF;
    
    -- Add recent posts from followed user to follower's home timeline
    FOR post_record IN
        SELECT id, created_at
        FROM posts
        WHERE author_id = NEW.following_id
          AND visibility IN ('public', 'unlisted')
          AND NOT COALESCE(is_deleted, false)
        ORDER BY created_at DESC
        LIMIT 20
    LOOP
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        VALUES (NEW.follower_id, post_record.id, 'home', EXTRACT(epoch FROM post_record.created_at) * 1000000)
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    END LOOP;
    
    RETURN NEW;
END;
$$;


--
-- Name: FUNCTION backfill_timeline_on_follow(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.backfill_timeline_on_follow() IS 'Backfills home timeline with recent posts when accepting a follow';


--
-- Name: build_emoji_reaction_activity(uuid, uuid, uuid, uuid, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.build_emoji_reaction_activity(p_interaction_id uuid, p_user_id uuid, p_post_id uuid, p_emoji_id uuid DEFAULT NULL::uuid, p_custom_emoji_content text DEFAULT NULL::text, p_is_undo boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    v_sender_profile RECORD;
    v_target_post RECORD;
    v_instance_domain text;
    v_emoji_info RECORD;
    v_activity_id text;
    v_sender_url text;
    v_post_url text;
    v_activity jsonb;
    v_emoji_object jsonb;
    v_reaction_content text;
BEGIN
    -- Get instance domain
    SELECT config_value::text INTO v_instance_domain
    FROM instance_config 
    WHERE config_key = 'domain';
    
    -- Remove JSON quotes if present
    v_instance_domain := trim(both '"' from v_instance_domain);
    
    -- Get sender profile
    SELECT * INTO v_sender_profile 
    FROM profiles 
    WHERE id = p_user_id AND is_local = true;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Local user profile not found: %', p_user_id;
    END IF;
    
    -- Get target post
    SELECT * INTO v_target_post
    FROM posts
    WHERE id = p_post_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Target post not found: %', p_post_id;
    END IF;
    
    -- Build URLs
    v_sender_url := 'https://' || v_instance_domain || '/users/' || v_sender_profile.username;
    v_post_url := COALESCE(v_target_post.ap_id, 'https://' || v_instance_domain || '/posts/' || v_target_post.id);
    
    -- Handle emoji information first to build a specific activity ID
    IF p_emoji_id IS NOT NULL THEN
        -- Custom server emoji
        SELECT * INTO v_emoji_info
        FROM emojis
        WHERE id = p_emoji_id;
        
        IF FOUND THEN
            -- Use the clean emoji name for federation
            v_reaction_content := ':' || v_emoji_info.name || ':';
            v_emoji_object := jsonb_build_object(
                'type', 'Emoji',
                'name', ':' || v_emoji_info.name || ':',
                'icon', jsonb_build_object(
                    'type', 'Image',
                    'url', v_emoji_info.url,
                    'mediaType', 'image/png'
                )
            );
            
            -- Build activity ID with emoji name for uniqueness
            v_activity_id := v_sender_url || '#emoji-reaction-' || v_emoji_info.name || '-' || p_interaction_id;
        ELSE
            RAISE EXCEPTION 'Custom emoji not found: %', p_emoji_id;
        END IF;
    ELSIF p_custom_emoji_content IS NOT NULL THEN
        -- Unicode or text emoji
        v_reaction_content := p_custom_emoji_content;
        v_emoji_object := NULL;
        
        -- Build activity ID with emoji content for uniqueness  
        v_activity_id := v_sender_url || '#emoji-reaction-' || 
            regexp_replace(p_custom_emoji_content, '[^a-zA-Z0-9]', '', 'g') || '-' || p_interaction_id;
    ELSE
        RAISE EXCEPTION 'Either emoji_id or custom_emoji_content must be provided';
    END IF;
    
    -- Build the ActivityPub activity
    IF p_is_undo THEN
        -- Undo activity for reaction removal
        v_activity := jsonb_build_object(
            '@context', 'https://www.w3.org/ns/activitystreams',
            'id', v_activity_id || '-undo',
            'type', 'Undo',
            'actor', v_sender_url,
            'published', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'object', jsonb_build_object(
                'id', v_activity_id,
                'type', 'EmojiReact',
                'actor', v_sender_url,
                'object', v_post_url,
                'content', v_reaction_content
            )
        );
    ELSE
        -- Create EmojiReact activity
        v_activity := jsonb_build_object(
            '@context', jsonb_build_array(
                'https://www.w3.org/ns/activitystreams',
                jsonb_build_object(
                    'EmojiReact', 'as:EmojiReact',
                    'toot', 'http://joinmastodon.org/ns#',
                    'Emoji', 'toot:Emoji'
                )
            ),
            'id', v_activity_id,
            'type', 'EmojiReact',
            'actor', v_sender_url,
            'object', v_post_url,
            'published', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'content', v_reaction_content
        );
        
        -- Add custom emoji tag if present
        IF v_emoji_object IS NOT NULL THEN
            v_activity := v_activity || jsonb_build_object(
                'tag', jsonb_build_array(v_emoji_object)
            );
        END IF;
        
        -- Add Misskey compatibility field
        v_activity := v_activity || jsonb_build_object(
            '_misskey_reaction', v_reaction_content
        );
    END IF;
    
    RETURN v_activity;
END;
$$;


--
-- Name: FUNCTION build_emoji_reaction_activity(p_interaction_id uuid, p_user_id uuid, p_post_id uuid, p_emoji_id uuid, p_custom_emoji_content text, p_is_undo boolean); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.build_emoji_reaction_activity(p_interaction_id uuid, p_user_id uuid, p_post_id uuid, p_emoji_id uuid, p_custom_emoji_content text, p_is_undo boolean) IS 'Builds ActivityPub EmojiReact activity from local emoji reaction. Supports both custom and unicode emojis with Misskey/Pleroma compatibility.';


--
-- Name: can_manage_group_icon(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_manage_group_icon(conversation_uuid uuid, user_profile_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  -- Check if user is a participant in the conversation
  RETURN EXISTS (
    SELECT 1 FROM conversation_participants cp
    WHERE cp.conversation_id = conversation_uuid
      AND cp.user_id = user_profile_id
      AND cp.left_at IS NULL
  );
END;
$$;


--
-- Name: check_emoji_reaction_limit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_emoji_reaction_limit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_emoji_count integer;
BEGIN
    IF NEW.interaction_type = 'emoji_reaction' THEN
        -- Count unique emoji reactions for this post
        SELECT COUNT(DISTINCT COALESCE(emoji_id::text, custom_emoji_content))
        INTO v_emoji_count
        FROM post_interactions 
        WHERE post_id = NEW.post_id 
          AND interaction_type = 'emoji_reaction';
        
        -- Allow max 20 different emoji types per post
        IF v_emoji_count >= 20 THEN
            RAISE EXCEPTION 'Maximum of 20 different emoji types allowed per post';
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;


--
-- Name: check_message_emoji_reaction_limit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_message_emoji_reaction_limit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_emoji_count integer;
BEGIN
    -- Count unique emoji reactions for this message
    SELECT COUNT(DISTINCT emoji_id)
    INTO v_emoji_count
    FROM reactions 
    WHERE message_id = NEW.message_id;
    
    -- Allow max 20 different emoji types per message
    IF v_emoji_count >= 20 THEN
        RAISE EXCEPTION 'Maximum of 20 different emoji types allowed per message';
    END IF;
    
    RETURN NEW;
END;
$$;


--
-- Name: check_timeline_health(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_timeline_health(p_user_id uuid) RETURNS TABLE(timeline_type text, total_entries integer, recent_entries integer, following_count integer, recommendations text)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    WITH timeline_stats AS (
        SELECT 
            'home' as timeline_type,
            COUNT(*)::INTEGER as total_entries,
            COUNT(*) FILTER (WHERE te.created_at > NOW() - INTERVAL '7 days')::INTEGER as recent_entries
        FROM timeline_entries te
        WHERE te.user_id = p_user_id AND te.timeline_type = 'home'
    ),
    follow_stats AS (
        SELECT COUNT(*)::INTEGER as following_count
        FROM follows f
        WHERE f.follower_id = p_user_id AND f.status = 'accepted'
    )
    SELECT 
        ts.timeline_type,
        ts.total_entries,
        ts.recent_entries,
        fs.following_count,
        CASE 
            WHEN ts.total_entries = 0 THEN 'No timeline entries found - run backfill'
            WHEN ts.recent_entries < fs.following_count / 2 THEN 'Low recent activity - check if followed users are posting'
            ELSE 'Timeline looks healthy'
        END as recommendations
    FROM timeline_stats ts, follow_stats fs;
END;
$$;


--
-- Name: FUNCTION check_timeline_health(p_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.check_timeline_health(p_user_id uuid) IS 'Checks the health of a users timeline and provides recommendations';


--
-- Name: classify_activitypub_activity(jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.classify_activitypub_activity(p_activity_data jsonb, p_instance_domain text) RETURNS TABLE(is_direct_message boolean, confidence numeric)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  v_object JSONB;
  v_to JSONB;
  v_cc JSONB;
  v_all_recipients TEXT[];
BEGIN
  v_object := CASE 
    WHEN jsonb_typeof(p_activity_data->'object') = 'string' THEN 
      jsonb_build_object('to', '[]'::jsonb, 'cc', '[]'::jsonb)
    ELSE 
      p_activity_data->'object'
  END;
  
  v_to := COALESCE(v_object->'to', '[]'::jsonb);
  v_cc := COALESCE(v_object->'cc', '[]'::jsonb);
  
  -- Extract all recipients
  SELECT array_agg(value::text)
  INTO v_all_recipients
  FROM jsonb_array_elements_text(v_to || v_cc);
  
  -- Rule 1: Contains 'Public' in 'to' → Public Post
  IF v_to ? 'https://www.w3.org/ns/activitystreams#Public' THEN
    RETURN QUERY SELECT false::boolean, 1.0::numeric;
    RETURN;
  END IF;
  
  -- Rule 2: Contains 'Public' in 'cc' → Unlisted Post (still public)
  IF v_cc ? 'https://www.w3.org/ns/activitystreams#Public' THEN
    RETURN QUERY SELECT false::boolean, 1.0::numeric;
    RETURN;
  END IF;
  
  -- Rule 3: Contains followers collection URL → Followers-only Post
  IF EXISTS (
    SELECT 1 FROM unnest(v_all_recipients) AS addr
    WHERE addr LIKE '%/followers'
  ) THEN
    RETURN QUERY SELECT false::boolean, 1.0::numeric;
    RETURN;
  END IF;
  
  -- Rule 4: Check for local recipients (direct message)
  IF EXISTS (
    SELECT 1 FROM unnest(v_all_recipients) AS addr
    WHERE addr LIKE '%' || p_instance_domain || '%'
  ) THEN
    RETURN QUERY SELECT true::boolean, 1.0::numeric;
    RETURN;
  END IF;
  
  -- Rule 5: No local recipients → Not our concern (treat as public)
  RETURN QUERY SELECT false::boolean, 0.1::numeric;
END;
$$;


--
-- Name: FUNCTION classify_activitypub_activity(p_activity_data jsonb, p_instance_domain text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.classify_activitypub_activity(p_activity_data jsonb, p_instance_domain text) IS 'Classifies ActivityPub activities according to specification - compatible with Mastodon, Misskey, Pleroma';


--
-- Name: cleanup_old_federation_deliveries(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_old_federation_deliveries() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    cleanup_count INTEGER := 0;
    delivered_count INTEGER;
    failed_count INTEGER;
BEGIN
    -- Delete delivered items older than 7 days
    DELETE FROM federation_delivery_queue 
    WHERE status = 'delivered' 
    AND delivered_at < NOW() - INTERVAL '7 days';
    
    GET DIAGNOSTICS delivered_count = ROW_COUNT;
    cleanup_count := delivered_count;
    
    -- Delete permanently failed items older than 30 days
    DELETE FROM federation_delivery_queue 
    WHERE status = 'failed' 
    AND updated_at < NOW() - INTERVAL '30 days';
    
    GET DIAGNOSTICS failed_count = ROW_COUNT;
    cleanup_count := cleanup_count + failed_count;
    
    RAISE NOTICE 'Cleaned up % delivered and % failed federation delivery records', delivered_count, failed_count;
    
    RETURN cleanup_count;
END;
$$;


--
-- Name: cleanup_old_notifications(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_old_notifications() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  -- Delete read notifications older than 30 days
  DELETE FROM notifications
  WHERE is_read = true
    AND created_at < NOW() - INTERVAL '30 days';
    
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  RAISE NOTICE 'Deleted % old notifications', deleted_count;
  RETURN deleted_count;
END;
$$;


--
-- Name: FUNCTION cleanup_old_notifications(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.cleanup_old_notifications() IS 'Delete old read notifications (run via cron)';


--
-- Name: cleanup_old_trending_data(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_old_trending_data() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    deleted_count INTEGER := 0;
    temp_count INTEGER;
BEGIN
    -- Clean up trending posts older than 30 days
    DELETE FROM trending_posts 
    WHERE period_start < NOW() - INTERVAL '30 days';
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    
    -- Clean up trending users older than 30 days
    DELETE FROM trending_users 
    WHERE period_start < NOW() - INTERVAL '30 days';
    
    GET DIAGNOSTICS temp_count = ROW_COUNT;
    deleted_count := deleted_count + temp_count;
    
    RAISE NOTICE 'Trending data cleanup completed. Deleted % old records.', deleted_count;
    RETURN deleted_count;
END;
$$;


--
-- Name: FUNCTION cleanup_old_trending_data(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.cleanup_old_trending_data() IS 'Removes trending posts and users data older than 30 days';


--
-- Name: convert_ap_to_jsonb(text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.convert_ap_to_jsonb(html_content text, tags jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    v_result JSONB := '[]'::jsonb;
    v_working_content TEXT;
    v_tag JSONB;
    v_username TEXT;
    v_mention_text TEXT;
    v_pos INTEGER;
    v_before_text TEXT;
    v_after_text TEXT;
    v_emoji_name TEXT;
    v_emoji_url TEXT;
BEGIN
    -- If no content, return empty array
    IF html_content IS NULL OR html_content = '' THEN
        RETURN '[]'::jsonb;
    END IF;

    -- Clean HTML thoroughly
    v_working_content := html_content;
    WHILE v_working_content ~ '<[^>]*>' LOOP
        v_working_content := regexp_replace(v_working_content, '<[^>]*>', '', 'g');
    END LOOP;
    v_working_content := regexp_replace(v_working_content, '&[a-zA-Z0-9#]+;', ' ', 'g');
    v_working_content := regexp_replace(v_working_content, '\s+', ' ', 'g');
    v_working_content := trim(v_working_content);

    -- If no tags, just return the cleaned text
    IF tags IS NULL OR jsonb_typeof(tags) != 'array' THEN
        IF v_working_content != '' THEN
            v_result := v_result || jsonb_build_object(
                'type', 'text',
                'text', v_working_content
            );
        END IF;
        RETURN v_result;
    END IF;

    -- Process all tags in a single pass to maintain proper order
    DECLARE
        tag_positions JSONB := '[]'::jsonb;
        v_tag_data JSONB;
        i INTEGER;
    BEGIN
        -- Find positions of all tags in content
        FOR v_tag IN SELECT * FROM jsonb_array_elements(tags)
        LOOP
            v_mention_text := NULL;
            v_pos := 0;
            
            IF v_tag->>'type' = 'Emoji' THEN
                -- Extract emoji name (remove colons if present)
                v_emoji_name := v_tag->>'name';
                IF v_emoji_name LIKE ':%' AND v_emoji_name LIKE '%:' THEN
                    v_emoji_name := substring(v_emoji_name from 2 for length(v_emoji_name) - 2);
                END IF;
                
                v_mention_text := ':' || v_emoji_name || ':';
                v_pos := position(v_mention_text in v_working_content);
                
            ELSIF v_tag->>'type' = 'Mention' THEN
                v_username := v_tag->>'name';
                IF v_username LIKE '@%' THEN
                    v_username := substring(v_username from 2);
                END IF;
                
                -- Try @username@domain format first
                IF v_username LIKE '%@%' THEN
                    v_mention_text := '@' || v_username;
                    v_pos := position(v_mention_text in v_working_content);
                END IF;
                
                -- If not found, try @username format
                IF v_pos = 0 THEN
                    v_mention_text := '@' || split_part(v_username, '@', 1);
                    v_pos := position(v_mention_text in v_working_content);
                END IF;
                
                -- If still not found, try just username
                IF v_pos = 0 THEN
                    v_mention_text := split_part(v_username, '@', 1);
                    v_pos := position(v_mention_text in v_working_content);
                END IF;
                
            ELSIF v_tag->>'type' = 'Hashtag' THEN
                v_mention_text := '#' || (v_tag->>'name');
                v_pos := position(v_mention_text in v_working_content);
            END IF;
            
            -- Store tag position and data if found
            IF v_pos > 0 THEN
                tag_positions := tag_positions || jsonb_build_object(
                    'position', v_pos,
                    'length', length(v_mention_text),
                    'tag', v_tag,
                    'text', v_mention_text
                );
            END IF;
        END LOOP;
        
        -- Sort tags by position
        SELECT jsonb_agg(value ORDER BY (value->>'position')::integer)
        INTO tag_positions
        FROM jsonb_array_elements(tag_positions);
        
        -- Process tags in order
        i := 0;
        FOR v_tag_data IN SELECT * FROM jsonb_array_elements(COALESCE(tag_positions, '[]'::jsonb))
        LOOP
            v_pos := (v_tag_data->>'position')::integer - i;
            v_mention_text := v_tag_data->>'text';
            v_tag := v_tag_data->'tag';
            
            -- Adjust position for previous removals
            v_before_text := substring(v_working_content from 1 for v_pos - 1);
            v_after_text := substring(v_working_content from v_pos + length(v_mention_text));
            
            -- Add text before this tag
            IF trim(v_before_text) != '' THEN
                v_result := v_result || jsonb_build_object(
                    'type', 'text',
                    'text', v_before_text
                );
            END IF;
            
            -- Add the tag based on its type - USING UNIVERSAL FORMAT
            IF v_tag->>'type' = 'Emoji' THEN
                v_emoji_name := v_tag->>'name';
                IF v_emoji_name LIKE ':%' AND v_emoji_name LIKE '%:' THEN
                    v_emoji_name := substring(v_emoji_name from 2 for length(v_emoji_name) - 2);
                END IF;
                v_emoji_url := COALESCE(v_tag->'icon'->>'url', v_tag->>'icon');
                
                v_result := v_result || jsonb_build_object(
                    'type', 'emoji',
                    'emoji', jsonb_build_object(
                        'name', v_emoji_name,
                        'url', v_emoji_url,
                        'id', COALESCE(v_tag->>'id', 'remote-' || v_emoji_name),
                        'server_id', 'remote'
                    )
                );
                
            ELSIF v_tag->>'type' = 'Mention' THEN
                v_username := v_tag->>'name';
                IF v_username LIKE '@%' THEN
                    v_username := substring(v_username from 2);
                END IF;
                
                -- UNIVERSAL MENTION FORMAT - matches your examples
                v_result := v_result || jsonb_build_object(
                    'type', 'mention',
                    'username', split_part(v_username, '@', 1),
                    'domain', CASE 
                        WHEN position('@' in v_username) > 0 THEN split_part(v_username, '@', 2)
                        ELSE NULL 
                    END,
                    'url', v_tag->>'href',
                    'userId', CASE 
                        WHEN position('@' in v_username) > 0 THEN 'remote-' || v_username
                        ELSE NULL
                    END,
                    'isLocal', CASE 
                        WHEN position('@' in v_username) > 0 THEN false
                        ELSE true
                    END
                );
                
            ELSIF v_tag->>'type' = 'Hashtag' THEN
                v_result := v_result || jsonb_build_object(
                    'type', 'hashtag',
                    'hashtag', v_tag->>'name'
                );
            END IF;
            
            -- Update working content for next iteration
            v_working_content := v_after_text;
            i := i + length(v_mention_text);
        END LOOP;
        
        -- Add any remaining text
        IF trim(v_working_content) != '' THEN
            v_result := v_result || jsonb_build_object(
                'type', 'text',
                'text', v_working_content
            );
        END IF;
    END;

    RETURN v_result;
END;
$$;


--
-- Name: FUNCTION convert_ap_to_jsonb(html_content text, tags jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.convert_ap_to_jsonb(html_content text, tags jsonb) IS 'UNIVERSAL converter: ActivityPub HTML → Harmony unified JSONB format. Works for posts, messages, DMs - everything.';


--
-- Name: convert_jsonb_to_ap(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.convert_jsonb_to_ap(content jsonb) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    content_part JSONB;
    html_content TEXT := '';
    part_type TEXT;
    part_text TEXT;
    part_url TEXT;
    part_shortcode TEXT;
    -- Variables for mention handling
    mention_username TEXT;
    mention_domain TEXT;
    mention_href TEXT;
    mention_text TEXT;
    current_instance_domain TEXT;
BEGIN
    -- Handle null or empty content
    IF content IS NULL THEN
        RETURN '';
    END IF;
    
    -- Handle string content (legacy format)
    IF jsonb_typeof(content) = 'string' THEN
        RETURN content #>> '{}';
    END IF;
    
    -- Get current instance domain for local mention detection
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    -- Handle array content (your universal format)
    IF jsonb_typeof(content) = 'array' THEN
        FOR content_part IN SELECT jsonb_array_elements(content)
        LOOP
            part_type := content_part->>'type';
            
            CASE part_type
                WHEN 'text' THEN
                    part_text := content_part->>'text';
                    IF part_text IS NOT NULL THEN
                        -- Escape HTML entities in text content for safety
                        part_text := replace(replace(replace(part_text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
                        html_content := html_content || part_text;
                    END IF;
                    
                WHEN 'mention' THEN
                    -- Extract mention data from your universal format
                    mention_username := content_part->>'username';
                    mention_domain := content_part->>'domain';
                    
                    IF mention_username IS NOT NULL THEN
                        -- Always build full mention format for federation compatibility
                        IF mention_domain IS NOT NULL THEN
                            -- Use provided domain
                            mention_href := 'https://' || mention_domain || '/@' || mention_username;
                            mention_text := '@' || mention_username || '@' || mention_domain;
                        ELSE
                            -- Fallback to current instance domain for local users
                            mention_href := 'https://' || current_instance_domain || '/@' || mention_username;
                            mention_text := '@' || mention_username || '@' || current_instance_domain;
                        END IF;
                        
                        -- Create the HTML mention link
                        html_content := html_content || format('<a href="%s" class="mention">%s</a>', 
                            mention_href, mention_text);
                    END IF;
                    
                WHEN 'emoji' THEN
                    -- Handle custom emojis - use shortcode format for ActivityPub compatibility
                    part_shortcode := content_part->'emoji'->>'name';
                    
                    IF part_shortcode IS NOT NULL THEN
                        -- Always render as shortcode - emoji metadata goes in ActivityPub tags
                        html_content := html_content || ':' || part_shortcode || ':';
                    END IF;
                    
                WHEN 'file' THEN
                    -- Files should not be inline in ActivityPub content (handled as attachments)
                    CONTINUE;
                    
                WHEN 'url' THEN
                    -- Handle URLs
                    part_url := content_part->>'url';
                    IF part_url IS NOT NULL THEN
                        -- Escape URL for safety and create link
                        part_url := replace(replace(replace(part_url, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
                        html_content := html_content || format('<a href="%s" rel="noopener noreferrer" target="_blank">%s</a>', 
                            part_url, part_url);
                    END IF;
                    
                ELSE
                    -- Unknown type, try to extract text and escape it
                    part_text := content_part->>'text';
                    IF part_text IS NOT NULL THEN
                        part_text := replace(replace(replace(part_text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
                        html_content := html_content || part_text;
                    END IF;
            END CASE;
        END LOOP;
        
        RETURN html_content;
    END IF;
    
    -- Fallback: convert to text and escape
    part_text := content::TEXT;
    part_text := replace(replace(replace(part_text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
    RETURN part_text;
END;
$$;


--
-- Name: FUNCTION convert_jsonb_to_ap(content jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.convert_jsonb_to_ap(content jsonb) IS 'UNIVERSAL converter: Harmony unified JSONB format → ActivityPub HTML. Works for posts, messages, DMs - everything.';


--
-- Name: create_activitypub_note_activity(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_activitypub_note_activity(post_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_post posts%ROWTYPE;
    v_sender_url text;
    v_post_url text;
    v_activity_id text;
    v_mentioned_actor_urls text[];
    v_note_object jsonb;
    v_activity jsonb;
    v_followers_url text;
BEGIN
    -- Get post data
    SELECT * INTO v_post FROM posts WHERE id = post_id;
    
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    
    -- Build sender and post URLs (FIXED: profiles instead of users)
    SELECT 'https://' || trim(both '"' from config_value::text) || '/users/' || p.id
    INTO v_sender_url
    FROM profiles p, instance_config 
    WHERE p.id = v_post.author_id AND config_key = 'domain';
    
    SELECT 'https://' || trim(both '"' from config_value::text) || '/posts/' || v_post.id
    INTO v_post_url
    FROM instance_config 
    WHERE config_key = 'domain';
    
    v_activity_id := v_post_url || '#activity';
    v_followers_url := v_sender_url || '/followers';
    
    -- Extract mentioned actor URLs for addressing
    SELECT array_agg(mention->>'href') 
    INTO v_mentioned_actor_urls
    FROM jsonb_array_elements(v_post.content) content_item,
         jsonb_array_elements(COALESCE(content_item->'mentions', '[]'::jsonb)) mention
    WHERE mention->>'href' IS NOT NULL;
    
    -- Create Note object with unified content processing
    SELECT convert_jsonb_to_ap(v_post.content) INTO v_note_object;
    
    -- Add standard ActivityPub Note fields
    v_note_object := v_note_object || jsonb_build_object(
        'id', v_post_url,
        'type', 'Note',
        'published', v_post.created_at::text,
        'attributedTo', v_sender_url,
        'content', v_note_object->>'content',
        'url', v_post_url,
        'to', CASE 
            WHEN v_post.visibility = 'public' THEN '["https://www.w3.org/ns/activitystreams#Public"]'::jsonb
            WHEN v_post.visibility = 'followers' THEN jsonb_build_array(v_followers_url)
            ELSE '[]'::jsonb
        END,
        'cc', CASE 
            WHEN v_post.visibility = 'public' THEN jsonb_build_array(v_followers_url)
            ELSE '[]'::jsonb
        END || COALESCE(to_jsonb(v_mentioned_actor_urls), '[]'::jsonb)
    );
    
    -- Add reply context if this is a reply
    IF v_post.in_reply_to IS NOT NULL THEN
        v_note_object := v_note_object || jsonb_build_object(
            'inReplyTo', (SELECT 'https://' || trim(both '"' from config_value::text) || '/posts/' || v_post.in_reply_to FROM instance_config WHERE config_key = 'domain')
        );
    END IF;
    
    -- Create Activity wrapper
    v_activity := jsonb_build_object(
        'id', v_activity_id,
        'type', 'Create',
        'actor', v_sender_url,
        'published', v_post.created_at::text,
        'object', v_note_object,
        'to', v_note_object->'to',
        'cc', v_note_object->'cc'
    );
    
    RETURN v_activity;
END;
$$;


--
-- Name: FUNCTION create_activitypub_note_activity(post_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.create_activitypub_note_activity(post_id uuid) IS 'FIXED: Creates a complete ActivityPub Create activity for a post with unified mention and emoji tag support. Now uses profiles table instead of users.';


--
-- Name: create_comprehensive_timeline_entries(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_comprehensive_timeline_entries() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    follower_record RECORD;
    local_user_record RECORD;
BEGIN
    -- Skip deleted posts
    IF COALESCE(NEW.is_deleted, false) THEN
        RETURN NEW;
    END IF;
    
    -- Add to author's own home timeline (local authors only)
    IF NEW.is_local THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        VALUES (NEW.author_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000)
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    END IF;
    
    -- Add to followers' home timelines (for all posts - local and federated)
    IF NEW.visibility IN ('public', 'unlisted') THEN
        FOR follower_record IN 
            SELECT f.follower_id 
            FROM follows f 
            JOIN profiles p ON f.follower_id = p.id
            WHERE f.following_id = NEW.author_id 
              AND f.status = 'accepted'
              AND p.is_local = true
              AND f.follower_id != NEW.author_id
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (follower_record.follower_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000)
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
        END LOOP;
    END IF;
    
    -- Add to ALL local users' public timeline (for public posts only)
    IF NEW.visibility = 'public' THEN
        FOR local_user_record IN
            SELECT id FROM profiles WHERE is_local = true
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (local_user_record.id, NEW.id, 'public', EXTRACT(epoch FROM NEW.created_at) * 1000000)
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
        END LOOP;
    END IF;
    
    RETURN NEW;
END;
$$;


--
-- Name: FUNCTION create_comprehensive_timeline_entries(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.create_comprehensive_timeline_entries() IS 'Creates timeline entries for both local and federated posts';


--
-- Name: create_default_notification_preferences(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_default_notification_preferences(p_user_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    AS $$
INSERT INTO notification_preferences (user_id)
VALUES (p_user_id)
ON CONFLICT (user_id) DO NOTHING;
$$;


--
-- Name: FUNCTION create_default_notification_preferences(p_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.create_default_notification_preferences(p_user_id uuid) IS 'SECURITY DEFINER: Creates default notification preferences for any user with elevated privileges.';


--
-- Name: create_default_server_structure(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_default_server_structure(p_server_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  -- Create default category
  INSERT INTO categories (server_id, name, position)
  VALUES (p_server_id, 'Text Channels', 0);

  -- Create general channel
  INSERT INTO channels (server_id, name, type, position)
  VALUES (p_server_id, 'general', 'text', 0);

  RAISE NOTICE 'Created default structure for server %', p_server_id;
END;
$$;


--
-- Name: FUNCTION create_default_server_structure(p_server_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.create_default_server_structure(p_server_id uuid) IS 'Create default channels/categories when server is created';


--
-- Name: create_group_conversation(uuid, uuid[], text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_group_conversation(creator_user_id uuid, participant_user_ids uuid[], conversation_name text DEFAULT NULL::text, is_private boolean DEFAULT true) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  conversation_uuid UUID;
  participant_id UUID;
BEGIN
  -- Create the conversation
  INSERT INTO conversations (type, name, created_by, is_active, metadata)
  VALUES (
    'group',
    conversation_name,
    creator_user_id,
    TRUE,
    jsonb_build_object('is_private', is_private)
  )
  RETURNING id INTO conversation_uuid;
  
  -- Add all participants
  FOREACH participant_id IN ARRAY participant_user_ids
  LOOP
    INSERT INTO conversation_participants (conversation_id, user_id, role, joined_at)
    VALUES (conversation_uuid, participant_id, 'member', CURRENT_TIMESTAMP)
    ON CONFLICT (conversation_id, user_id) DO NOTHING;
  END LOOP;
  
  RETURN conversation_uuid;
END;
$$;


--
-- Name: create_group_conversation(uuid, text, uuid[], jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_group_conversation(creator_user_id uuid, conversation_name text DEFAULT NULL::text, participant_ids uuid[] DEFAULT '{}'::uuid[], initial_metadata jsonb DEFAULT '{}'::jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  new_conversation_id UUID;
  participant_id UUID;
BEGIN
  -- Create the conversation
  INSERT INTO conversations (
    created_by,
    name,
    type,
    metadata,
    is_active
  ) VALUES (
    creator_user_id,
    conversation_name,
    'group',
    initial_metadata,
    true
  )
  RETURNING id INTO new_conversation_id;

  -- Add creator as participant
  INSERT INTO conversation_participants (
    conversation_id,
    user_id,
    joined_at
  ) VALUES (
    new_conversation_id,
    creator_user_id,
    CURRENT_TIMESTAMP
  );

  -- Add other participants
  FOREACH participant_id IN ARRAY participant_ids
  LOOP
    -- Skip creator (already added)
    IF participant_id != creator_user_id THEN
      INSERT INTO conversation_participants (
        conversation_id,
        user_id,
        joined_at
      ) VALUES (
        new_conversation_id,
        participant_id,
        CURRENT_TIMESTAMP
      );
    END IF;
  END LOOP;

  RETURN new_conversation_id;
END;
$$;


--
-- Name: create_notification_preferences(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_notification_preferences() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Only create notification preferences for local users
    -- Remote federated users manage their notifications on their own instances
    IF NEW.is_local = true OR NEW.is_local IS NULL THEN
        INSERT INTO notification_preferences (user_id)
        VALUES (NEW.id);
    END IF;
    
    RETURN NEW;
END;
$$;


--
-- Name: FUNCTION create_notification_preferences(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.create_notification_preferences() IS 'Creates notification preferences only for local users. Remote federated users manage notifications on their own instances.';


--
-- Name: create_notification_structured(uuid, character varying, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_notification_structured(p_user_id uuid, p_type character varying, p_data jsonb DEFAULT '{}'::jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  notification_id UUID;
BEGIN
  -- Simple notification creation
  INSERT INTO notifications (user_id, type, data, created_at, is_read)
  VALUES (p_user_id, p_type, p_data, NOW(), false)
  RETURNING id INTO notification_id;

  RETURN notification_id;
END;
$$;


--
-- Name: FUNCTION create_notification_structured(p_user_id uuid, p_type character varying, p_data jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.create_notification_structured(p_user_id uuid, p_type character varying, p_data jsonb) IS 'Create notification with structured data';


--
-- Name: create_notification_with_spam_prevention(uuid, text, uuid, text, text, jsonb, uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_notification_with_spam_prevention(p_user_id uuid, p_type text, p_source_user_id uuid, p_title text DEFAULT NULL::text, p_message text DEFAULT NULL::text, p_data jsonb DEFAULT '{}'::jsonb, p_server_id uuid DEFAULT NULL::uuid, p_channel_id uuid DEFAULT NULL::uuid, p_conversation_id uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_notification_id uuid;
    v_rate_limit RECORD;
    v_should_suppress boolean := false;
    v_time_threshold timestamp with time zone := NOW() - INTERVAL '2 minutes';
BEGIN
    -- Check for rate limiting (only for reaction notifications for now)
    IF p_type = 'reaction' AND p_source_user_id IS NOT NULL THEN
        
        -- Get or create rate limit record
        INSERT INTO notification_rate_limits (user_id, notification_type, source_user_id)
        VALUES (p_user_id, p_type, p_source_user_id)
        ON CONFLICT (user_id, notification_type, source_user_id)
        DO UPDATE SET 
            notification_count = notification_rate_limits.notification_count + 1,
            last_notification_at = NOW()
        RETURNING * INTO v_rate_limit;
        
        -- Check if we should suppress (more than 3 notifications or within 2 minute window)
        SELECT 
            (notification_count > 3) OR 
            (notification_count > 1 AND last_notification_at > v_time_threshold) OR
            (suppressed_until IS NOT NULL AND suppressed_until > NOW())
        INTO v_should_suppress
        FROM notification_rate_limits
        WHERE user_id = p_user_id AND notification_type = p_type AND source_user_id = p_source_user_id;
        
        IF v_should_suppress THEN
            -- Update suppression time
            UPDATE notification_rate_limits 
            SET suppressed_until = NOW() + INTERVAL '2 minutes'
            WHERE user_id = p_user_id AND notification_type = p_type AND source_user_id = p_source_user_id;
            
            RETURN NULL; -- Suppress notification
        END IF;
    END IF;
    
    -- Create notification normally using the unified send_notification_to_user function
    SELECT send_notification_to_user(
        p_type,
        p_user_id,
        p_data,
        p_server_id,
        p_channel_id,
        p_conversation_id,
        p_source_user_id,
        'normal'
    ) INTO v_notification_id;
    
    RETURN v_notification_id;
END;
$$;


--
-- Name: FUNCTION create_notification_with_spam_prevention(p_user_id uuid, p_type text, p_source_user_id uuid, p_title text, p_message text, p_data jsonb, p_server_id uuid, p_channel_id uuid, p_conversation_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.create_notification_with_spam_prevention(p_user_id uuid, p_type text, p_source_user_id uuid, p_title text, p_message text, p_data jsonb, p_server_id uuid, p_channel_id uuid, p_conversation_id uuid) IS 'Creates notifications with spam prevention. Suppresses repeated notifications from same source within time windows.';


--
-- Name: create_or_get_direct_conversation(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_or_get_direct_conversation(user1_uuid uuid, user2_uuid uuid) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
  conversation_uuid UUID;
BEGIN
  -- Try to find existing direct conversation between these two users
  SELECT c.id INTO conversation_uuid
  FROM conversations c
  WHERE c.type = 'direct'
    AND EXISTS (
      SELECT 1 FROM conversation_participants cp1 
      WHERE cp1.conversation_id = c.id 
        AND cp1.user_id = user1_uuid 
        AND cp1.left_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM conversation_participants cp2 
      WHERE cp2.conversation_id = c.id 
        AND cp2.user_id = user2_uuid 
        AND cp2.left_at IS NULL
    )
    -- Ensure it's exactly 2 participants
    AND (
      SELECT COUNT(*) FROM conversation_participants cp3 
      WHERE cp3.conversation_id = c.id 
        AND cp3.left_at IS NULL
    ) = 2;
  
  -- If not found, create new conversation
  IF conversation_uuid IS NULL THEN
    INSERT INTO conversations (type, created_by, is_active)
    VALUES ('direct', user1_uuid, TRUE)
    RETURNING id INTO conversation_uuid;
    
    -- Add both users as participants
    PERFORM add_user_to_conversation(conversation_uuid, user1_uuid, 'member');
    PERFORM add_user_to_conversation(conversation_uuid, user2_uuid, 'member');
  END IF;
  
  RETURN conversation_uuid;
END;
$$;


--
-- Name: create_or_get_multi_conversation(uuid[], text, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_or_get_multi_conversation(participant_ids uuid[], conversation_type text DEFAULT 'direct'::text, conversation_name text DEFAULT NULL::text, created_by_id uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_conversation_id UUID;
    participant_id UUID;
BEGIN
    -- Validate inputs
    IF participant_ids IS NULL OR array_length(participant_ids, 1) < 2 THEN
        RAISE EXCEPTION 'At least 2 participants required for conversation';
    END IF;
    
    -- Try to find existing conversation with exact same participants
    SELECT DISTINCT c.id INTO v_conversation_id
    FROM conversations c
    WHERE (
        -- Count must match exactly
        (SELECT COUNT(*) FROM conversation_participants cp WHERE cp.conversation_id = c.id AND cp.left_at IS NULL) = array_length(participant_ids, 1)
        AND
        -- All participants must be present
        NOT EXISTS (
            SELECT 1 FROM unnest(participant_ids) AS required_participant(participant_id)
            WHERE NOT EXISTS (
                SELECT 1 FROM conversation_participants cp 
                WHERE cp.conversation_id = c.id 
                  AND cp.user_id = required_participant.participant_id 
                  AND cp.left_at IS NULL
            )
        )
    )
    LIMIT 1;

    -- Create new conversation if not found
    IF v_conversation_id IS NULL THEN
        INSERT INTO conversations (
            name,
            type,
            created_by,
            created_at
        ) VALUES (
            CASE 
                WHEN array_length(participant_ids, 1) = 2 AND conversation_name IS NULL THEN NULL
                ELSE COALESCE(conversation_name, 'Group Chat')
            END,
            CASE 
                WHEN array_length(participant_ids, 1) = 2 THEN 'direct'
                ELSE COALESCE(conversation_type, 'group')
            END,
            COALESCE(created_by_id, participant_ids[1]),
            NOW()
        )
        RETURNING id INTO v_conversation_id;
        
        -- Add all participants
        INSERT INTO conversation_participants (conversation_id, user_id, joined_at, role)
        SELECT v_conversation_id, participant_id, NOW(), 'member'
        FROM unnest(participant_ids) AS participants(participant_id);
        
        RAISE NOTICE '🆕 Created new % conversation % with % participants', 
            CASE WHEN array_length(participant_ids, 1) = 2 THEN 'direct' ELSE 'group' END,
            v_conversation_id, 
            array_length(participant_ids, 1);
    END IF;

    RETURN v_conversation_id;
END;
$$;


--
-- Name: create_system_message(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_system_message(p_channel_id uuid, p_message_type text, p_data jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  message_id UUID;
  system_content JSONB;
BEGIN
  -- Create content based on message type
  system_content := jsonb_build_array(
    jsonb_build_object(
      'type', 'system',
      'systemType', p_message_type,
      'data', p_data
    )
  );

  INSERT INTO messages (channel_id, content, is_system, created_at)
  VALUES (p_channel_id, system_content, true, NOW())
  RETURNING id INTO message_id;

  RETURN message_id;
END;
$$;


--
-- Name: FUNCTION create_system_message(p_channel_id uuid, p_message_type text, p_data jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.create_system_message(p_channel_id uuid, p_message_type text, p_data jsonb) IS 'Create system message (user joined, user left, etc.)';


--
-- Name: delete_server_with_cleanup(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_server_with_cleanup(p_server_id uuid, p_owner_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    -- Verify ownership
    IF NOT EXISTS(SELECT 1 FROM servers WHERE id = p_server_id AND owner = p_owner_id) THEN
        RAISE EXCEPTION 'Server not found or you are not the owner';
    END IF;
    
    -- Delete in proper order to avoid foreign key issues
    -- The CASCADE constraints will handle most cleanup, but we'll be explicit about the order
    
    -- 1. Delete server membership events first (to avoid trigger issues)
    DELETE FROM server_membership_events WHERE server_id = p_server_id;
    
    -- 2. Delete the server (CASCADE will handle the rest)
    DELETE FROM servers WHERE id = p_server_id AND owner = p_owner_id;
    
    -- If we get here, everything succeeded
END;$$;


--
-- Name: determine_message_federation_type(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.determine_message_federation_type(p_message_id uuid) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  v_message_type TEXT;
  v_channel_id UUID;
  v_conversation_id UUID;
  v_remote_participant_count INTEGER := 0;
BEGIN
  -- Get message context
  SELECT channel_id, conversation_id 
  INTO v_channel_id, v_conversation_id
  FROM messages 
  WHERE id = p_message_id;
  
  -- Classification logic
  IF v_channel_id IS NOT NULL THEN
    -- Server chat message → Never federate
    v_message_type := 'chat_local_only';
    
  ELSIF v_conversation_id IS NOT NULL THEN
    -- DM message → Check for remote participants
    SELECT COUNT(DISTINCT cp.user_id)
    INTO v_remote_participant_count
    FROM conversation_participants cp
    JOIN profiles p ON cp.user_id = p.id
    WHERE cp.conversation_id = v_conversation_id
      AND NOT p.is_local
      AND cp.left_at IS NULL;
    
    IF v_remote_participant_count > 0 THEN
      v_message_type := 'dm_federated';
    ELSE
      v_message_type := 'dm_local_only';
    END IF;
    
  ELSE
    -- Orphaned message
    v_message_type := 'unknown';
  END IF;
  
  RETURN v_message_type;
END;
$$;


--
-- Name: FUNCTION determine_message_federation_type(p_message_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.determine_message_federation_type(p_message_id uuid) IS 'Determines federation type for a message based on context (chat/DM) and participants';


--
-- Name: extract_activitypub_emoji_tags(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.extract_activitypub_emoji_tags(content jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    content_part JSONB;
    emoji_tags JSONB := '[]'::JSONB;
    part_type TEXT;
    emoji_name TEXT;
    emoji_url TEXT;
    emoji_id TEXT;
    emoji_tag JSONB;
    current_instance_domain TEXT;
BEGIN
    -- Handle null or empty content
    IF content IS NULL OR jsonb_typeof(content) != 'array' THEN
        RETURN '[]'::JSONB;
    END IF;
    
    -- Get current instance domain
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    FOR content_part IN SELECT jsonb_array_elements(content)
    LOOP
        part_type := content_part->>'type';
        
        IF part_type = 'emoji' THEN
            emoji_name := content_part->'emoji'->>'name';
            emoji_url := content_part->'emoji'->>'url';
            emoji_id := content_part->'emoji'->>'id';
            
            IF emoji_name IS NOT NULL AND emoji_url IS NOT NULL THEN
                -- Build the ActivityPub Emoji tag
                emoji_tag := jsonb_build_object(
                    'type', 'Emoji',
                    'name', ':' || emoji_name || ':',
                    'icon', jsonb_build_object(
                        'type', 'Image',
                        'url', emoji_url
                    )
                );
                
                -- Add id if available
                IF emoji_id IS NOT NULL THEN
                    emoji_tag := emoji_tag || jsonb_build_object('id', 'https://' || current_instance_domain || '/emojis/' || emoji_id);
                END IF;
                
                -- Add to tags array
                emoji_tags := emoji_tags || jsonb_build_array(emoji_tag);
            END IF;
        END IF;
    END LOOP;
    
    RETURN emoji_tags;
END;
$$;


--
-- Name: FUNCTION extract_activitypub_emoji_tags(content jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.extract_activitypub_emoji_tags(content jsonb) IS 'Extracts emoji tags from MessagePart[] content as ActivityPub Emoji objects for proper federation compatibility';


--
-- Name: extract_activitypub_hashtag_tags(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.extract_activitypub_hashtag_tags(content jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    content_part JSONB;
    hashtag_tags JSONB := '[]'::JSONB;
    part_type TEXT;
    hashtag_name TEXT;
    hashtag_href TEXT;
    hashtag_tag JSONB;
    current_instance_domain TEXT;
BEGIN
    -- Handle null or empty content
    IF content IS NULL OR jsonb_typeof(content) != 'array' THEN
        RETURN '[]'::JSONB;
    END IF;
    
    -- Get current instance domain for hashtag URLs
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    FOR content_part IN SELECT jsonb_array_elements(content)
    LOOP
        part_type := content_part->>'type';
        
        IF part_type = 'hashtag' THEN
            hashtag_name := content_part->>'name';
            
            IF hashtag_name IS NOT NULL THEN
                -- Build hashtag URL - ActivityPub standard format
                hashtag_href := 'https://' || current_instance_domain || '/tags/' || hashtag_name;
                
                -- Ensure hashtag name starts with # for ActivityPub format
                IF NOT starts_with(hashtag_name, '#') THEN
                    hashtag_name := '#' || hashtag_name;
                END IF;
                
                -- Build the ActivityPub Hashtag tag
                hashtag_tag := jsonb_build_object(
                    'type', 'Hashtag',
                    'href', hashtag_href,
                    'name', hashtag_name
                );
                
                -- Add to tags array
                hashtag_tags := hashtag_tags || jsonb_build_array(hashtag_tag);
            END IF;
        END IF;
    END LOOP;
    
    RETURN hashtag_tags;
END;
$$;


--
-- Name: FUNCTION extract_activitypub_hashtag_tags(content jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.extract_activitypub_hashtag_tags(content jsonb) IS 'Extracts hashtag tags from MessagePart[] content as ActivityPub Hashtag objects for proper federation. Handles hashtag data structure: {"type": "hashtag", "name": "cats"} and generates proper ActivityPub format: {"type": "Hashtag", "name": "#cats", "href": "https://domain.com/tags/cats"}';


--
-- Name: extract_activitypub_tags(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.extract_activitypub_tags(content jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    mention_tags JSONB;
    emoji_tags JSONB;
    all_tags JSONB := '[]'::JSONB;
BEGIN
    -- Get mention tags
    mention_tags := extract_activitypub_mention_tags(content);
    
    -- Get emoji tags  
    emoji_tags := extract_activitypub_emoji_tags(content);
    
    -- Combine them
    IF jsonb_array_length(mention_tags) > 0 THEN
        all_tags := all_tags || mention_tags;
    END IF;
    
    IF jsonb_array_length(emoji_tags) > 0 THEN
        all_tags := all_tags || emoji_tags;
    END IF;
    
    RETURN all_tags;
END;
$$;


--
-- Name: FUNCTION extract_activitypub_tags(content jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.extract_activitypub_tags(content jsonb) IS 'Extracts all ActivityPub tags (mentions and emojis) from MessagePart[] content for proper federation';


--
-- Name: extract_custom_emoji_for_federation(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.extract_custom_emoji_for_federation(content_text text) RETURNS TABLE(emoji_id uuid, emoji_name text, emoji_url text)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.id,
        e.name,
        e.url
    FROM emojis e
    WHERE content_text ~ (':' || e.name || ':') 
       OR content_text ~ (':' || e.id::text || ':');
END;
$$;


--
-- Name: FUNCTION extract_custom_emoji_for_federation(content_text text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.extract_custom_emoji_for_federation(content_text text) IS 'Extract custom emoji data from content for ActivityPub federation tags';


--
-- Name: extract_hashtags_from_content(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.extract_hashtags_from_content(p_content jsonb) RETURNS text[]
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
  hashtags TEXT[] := ARRAY[]::TEXT[];
  item JSONB;
  text_content TEXT;
  matches TEXT[];
BEGIN
  -- Extract from JSONB array format
  IF jsonb_typeof(p_content) = 'array' THEN
    FOR item IN SELECT * FROM jsonb_array_elements(p_content)
    LOOP
      IF item->>'type' = 'text' THEN
        text_content := item->>'text';
        -- Extract hashtags (#word)
        matches := regexp_matches(text_content, '#([a-zA-Z0-9_]+)', 'g');
        IF matches IS NOT NULL THEN
          hashtags := hashtags || matches;
        END IF;
      END IF;
    END LOOP;
  END IF;

  RETURN array_remove(hashtags, NULL);
END;
$$;


--
-- Name: FUNCTION extract_hashtags_from_content(p_content jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.extract_hashtags_from_content(p_content jsonb) IS 'Extract hashtags from JSONB content array';


--
-- Name: extract_mentions(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.extract_mentions(content jsonb) RETURNS text[]
    LANGUAGE plpgsql
    AS $$
DECLARE
    mentions TEXT[] := '{}';
    item JSONB;
BEGIN
    -- Handle array content (rich text)
    IF jsonb_typeof(content) = 'array' THEN
        FOR item IN SELECT jsonb_array_elements(content)
        LOOP
            IF item->>'type' = 'mention' AND item->>'mention' IS NOT NULL THEN
                mentions := array_append(mentions, item->>'mention');
            END IF;
        END LOOP;
    END IF;
    
    RETURN mentions;
END;
$$;


--
-- Name: FUNCTION extract_mentions(content jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.extract_mentions(content jsonb) IS 'Extracts mention usernames from JSONB message content';


--
-- Name: get_batch_message_reactions(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_batch_message_reactions(message_ids uuid[]) RETURNS TABLE(message_id uuid, emoji_id uuid, emoji_name character varying, emoji_url character varying, reaction_count bigint, users jsonb)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        r.message_id,
        r.emoji_id,
        e.name as emoji_name,  -- No cast needed - already character varying
        e.url as emoji_url,    -- No cast needed - already character varying
        COUNT(r.user_id) as reaction_count,  -- Match existing function behavior
        COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'reaction_id', r.id::text,
                    'user_id', r.user_id::text
                ) ORDER BY r.created_at
            ) FILTER (WHERE r.user_id IS NOT NULL),
            '[]'::jsonb
        ) as users
    FROM reactions r
    LEFT JOIN emojis e ON r.emoji_id = e.id
    WHERE r.message_id = ANY(get_batch_message_reactions.message_ids)
    GROUP BY r.message_id, r.emoji_id, e.name, e.url
    ORDER BY r.message_id, MIN(r.created_at);
END;
$$;


--
-- Name: FUNCTION get_batch_message_reactions(message_ids uuid[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_batch_message_reactions(message_ids uuid[]) IS 'FIXED: Batch reaction fetching with proper user_id handling and correct column types';


--
-- Name: get_batch_post_emoji_reactions(uuid[], integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_batch_post_emoji_reactions(p_post_ids uuid[], p_user_limit integer DEFAULT 5) RETURNS TABLE(post_id uuid, emoji_id uuid, emoji_name text, emoji_url text, custom_emoji_content text, reaction_count bigint, user_reactions jsonb, current_user_reacted boolean)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    current_user_id uuid;
BEGIN
    -- Get current user ID from session (if authenticated)
    current_user_id := auth.uid();
    
    RETURN QUERY
    SELECT 
        pi.post_id,
        pi.emoji_id,
        e.name::text as emoji_name,
        -- ONLY CHANGE: Support remote emoji URLs from metadata
        COALESCE(e.url::text, MAX(pi.metadata->>'remote_emoji_url')) as emoji_url,
        pi.custom_emoji_content,
        COUNT(*)::bigint as reaction_count,
        -- Limited user data for tooltips
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'user_id', sub_pi.user_id,
                    'username', sub_p.username,
                    'display_name', sub_p.display_name,
                    'avatar_url', sub_p.avatar_url,
                    'created_at', sub_pi.created_at
                )
                ORDER BY sub_pi.created_at DESC
            )
            FROM post_interactions sub_pi
            LEFT JOIN profiles sub_p ON sub_pi.user_id = sub_p.id
            WHERE sub_pi.post_id = pi.post_id
              AND sub_pi.interaction_type = 'emoji_reaction'
              AND (
                  (pi.emoji_id IS NOT NULL AND sub_pi.emoji_id = pi.emoji_id) OR
                  (pi.custom_emoji_content IS NOT NULL AND sub_pi.custom_emoji_content = pi.custom_emoji_content)
              )
            LIMIT p_user_limit
        ) as user_reactions,
        -- Check if current user has reacted
        CASE 
            WHEN current_user_id IS NULL THEN false
            ELSE EXISTS(
                SELECT 1 FROM post_interactions check_pi
                WHERE check_pi.post_id = pi.post_id
                  AND check_pi.user_id = current_user_id
                  AND check_pi.interaction_type = 'emoji_reaction'
                  AND (
                      (pi.emoji_id IS NOT NULL AND check_pi.emoji_id = pi.emoji_id) OR
                      (pi.custom_emoji_content IS NOT NULL AND check_pi.custom_emoji_content = pi.custom_emoji_content)
                  )
            )
        END as current_user_reacted
    FROM post_interactions pi
    LEFT JOIN emojis e ON pi.emoji_id = e.id
    WHERE pi.post_id = ANY(p_post_ids)
      AND pi.interaction_type = 'emoji_reaction'
    GROUP BY pi.post_id, pi.emoji_id, e.name, e.url, pi.custom_emoji_content
    ORDER BY pi.post_id, reaction_count DESC, MIN(pi.created_at) ASC;
END;
$$;


--
-- Name: get_batch_post_reactions(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_batch_post_reactions(post_ids uuid[]) RETURNS TABLE(post_id uuid, emoji_id uuid, emoji_name character varying, emoji_url character varying, reaction_count bigint, users jsonb)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        pi.post_id,
        pi.emoji_id,
        e.name as emoji_name,
        e.url as emoji_url,
        COUNT(pi.user_id) as reaction_count,
        jsonb_agg(
            jsonb_build_object(
                'id', p.id,
                'username', p.username,
                'display_name', p.display_name,
                'avatar_url', p.avatar_url
            ) ORDER BY pi.created_at
        ) as users
    FROM post_interactions pi
    INNER JOIN emojis e ON pi.emoji_id = e.id
    INNER JOIN profiles p ON pi.user_id = p.id
    WHERE pi.post_id = ANY(post_ids)
    AND pi.interaction_type = 'emoji_reaction'
    GROUP BY pi.post_id, pi.emoji_id, e.name, e.url
    ORDER BY pi.post_id, MIN(pi.created_at);
END;
$$;


--
-- Name: FUNCTION get_batch_post_reactions(post_ids uuid[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_batch_post_reactions(post_ids uuid[]) IS 'Optimized function to fetch reactions for multiple posts in a single query, eliminating N+1 performance issues.';


--
-- Name: get_conversation_context(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_conversation_context(in_post_id uuid, in_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    conversation_root_id uuid;
    result jsonb;
BEGIN
    -- Get the conversation root ID for this post
    SELECT COALESCE(p.conversation_root_id, p.id)
    INTO conversation_root_id
    FROM posts p
    WHERE p.id = in_post_id
      AND p.deleted_at IS NULL;
    
    -- If post not found, return empty object
    IF conversation_root_id IS NULL THEN
        RETURN '{}'::jsonb;
    END IF;
    
    -- Get all posts in conversation ordered chronologically
    WITH conversation_posts AS (
        SELECT 
            p.id,
            p.content,
            p.created_at,
            p.in_reply_to,
            jsonb_build_object(
                'id', pr.id,
                'username', pr.username,
                'display_name', pr.display_name,
                'avatar_url', pr.avatar_url,
                'domain', pr.domain
            ) as author,
            p.visibility,
            p.favorites_count,
            p.reblogs_count,
            p.replies_count,
            p.media_attachments,
            p.content_warning,
            p.is_sensitive,
            p.url,
            CASE 
                WHEN pi_fav.user_id IS NOT NULL THEN true 
                ELSE false 
            END as is_favorited,
            CASE 
                WHEN pi_reb.user_id IS NOT NULL THEN true 
                ELSE false 
            END as is_reblogged,
            CASE 
                WHEN pi_book.user_id IS NOT NULL THEN true 
                ELSE false 
            END as is_bookmarked
        FROM posts p
        JOIN profiles pr ON p.author_id = pr.id
        LEFT JOIN post_interactions pi_fav ON p.id = pi_fav.post_id 
            AND pi_fav.user_id = in_user_id 
            AND pi_fav.interaction_type = 'favorite'
        LEFT JOIN post_interactions pi_reb ON p.id = pi_reb.post_id 
            AND pi_reb.user_id = in_user_id 
            AND pi_reb.interaction_type = 'reblog'
        LEFT JOIN post_interactions pi_book ON p.id = pi_book.post_id 
            AND pi_book.user_id = in_user_id 
            AND pi_book.interaction_type = 'bookmark'
        WHERE COALESCE(p.conversation_root_id, p.id) = conversation_root_id
          AND p.deleted_at IS NULL
        ORDER BY p.created_at ASC
    )
    SELECT jsonb_build_object(
        'ancestors', COALESCE(jsonb_agg(
            jsonb_build_object(
                'id', cp.id,
                'content', cp.content,
                'created_at', cp.created_at,
                'author', cp.author,
                'visibility', cp.visibility,
                'favorites_count', cp.favorites_count,
                'reblogs_count', cp.reblogs_count,
                'replies_count', cp.replies_count,
                'media_attachments', cp.media_attachments,
                'content_warning', cp.content_warning,
                'is_sensitive', cp.is_sensitive,
                'url', cp.url,
                'is_favorited', cp.is_favorited,
                'is_reblogged', cp.is_reblogged,
                'is_bookmarked', cp.is_bookmarked
            )
        ) FILTER (WHERE cp.created_at < (SELECT created_at FROM posts WHERE id = in_post_id)), '[]'::jsonb),
        'descendants', COALESCE(jsonb_agg(
            jsonb_build_object(
                'id', cp.id,
                'content', cp.content,
                'created_at', cp.created_at,
                'author', cp.author,
                'visibility', cp.visibility,
                'favorites_count', cp.favorites_count,
                'reblogs_count', cp.reblogs_count,
                'replies_count', cp.replies_count,
                'media_attachments', cp.media_attachments,
                'content_warning', cp.content_warning,
                'is_sensitive', cp.is_sensitive,
                'url', cp.url,
                'is_favorited', cp.is_favorited,
                'is_reblogged', cp.is_reblogged,
                'is_bookmarked', cp.is_bookmarked
            )
        ) FILTER (WHERE cp.created_at > (SELECT created_at FROM posts WHERE id = in_post_id)), '[]'::jsonb),
        'conversation_id', conversation_root_id
    ) INTO result
    FROM conversation_posts cp;
    
    RETURN COALESCE(result, jsonb_build_object(
        'ancestors', '[]'::jsonb,
        'descendants', '[]'::jsonb,
        'conversation_id', conversation_root_id
    ));
END;
$$;


--
-- Name: get_conversation_participants(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_conversation_participants(conversation_uuid uuid) RETURNS TABLE(user_id uuid, role text, joined_at timestamp with time zone, is_muted boolean, last_read_at timestamp with time zone)
    LANGUAGE sql STABLE
    AS $$
  SELECT 
    cp.user_id,
    cp.role,
    cp.joined_at,
    cp.is_muted,
    cp.last_read_at
  FROM conversation_participants cp
  WHERE cp.conversation_id = conversation_uuid 
    AND cp.left_at IS NULL
  ORDER BY cp.joined_at;
$$;


--
-- Name: get_conversation_thread(text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_conversation_thread(p_conversation_id text, p_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  root_post jsonb;
  thread_posts jsonb;
  reply_count integer;
  participant_count integer;
  last_updated timestamptz;
BEGIN
  -- Get the root post (the one that started the conversation)
  SELECT to_jsonb(tp.*) INTO root_post
  FROM timeline_posts tp
  WHERE tp.conversation_id = p_conversation_id
    AND tp.reply_context IS NULL
  ORDER BY tp.created_at ASC
  LIMIT 1;
  
  -- Get all posts in the conversation with user interaction state
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', tp.id,
      'content', tp.content,
      'author', tp.author,
      'created_at', tp.created_at,
      'reply_context', tp.reply_context,
      'replies_count', tp.replies_count,
      'reblogs_count', tp.reblogs_count,
      'favorites_count', tp.favorites_count,
      'is_favorited', COALESCE(fav.user_id IS NOT NULL, false),
      'is_reblogged', COALESCE(reb.user_id IS NOT NULL, false),
      'is_bookmarked', COALESCE(book.user_id IS NOT NULL, false)
    ) ORDER BY tp.created_at ASC
  ) INTO thread_posts
  FROM timeline_posts tp
  LEFT JOIN post_interactions fav ON tp.id = fav.post_id 
    AND fav.user_id = p_user_id AND fav.interaction_type = 'favorite'
  LEFT JOIN post_interactions reb ON tp.id = reb.post_id 
    AND reb.user_id = p_user_id AND reb.interaction_type = 'reblog'
  LEFT JOIN post_interactions book ON tp.id = book.post_id 
    AND book.user_id = p_user_id AND book.interaction_type = 'bookmark'
  WHERE tp.conversation_id = p_conversation_id;
  
  -- Get conversation stats
  SELECT 
    COUNT(*) - 1, -- Subtract 1 for root post
    COUNT(DISTINCT tp.author_id),
    MAX(tp.created_at)
  INTO reply_count, participant_count, last_updated
  FROM timeline_posts tp
  WHERE tp.conversation_id = p_conversation_id;
  
  RETURN jsonb_build_object(
    'root_post', root_post,
    'posts', COALESCE(thread_posts, '[]'::jsonb),
    'reply_count', COALESCE(reply_count, 0),
    'participant_count', COALESCE(participant_count, 0),
    'last_updated', last_updated
  );
END;
$$;


--
-- Name: get_default_channel(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_default_channel(p_server_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    channel_id UUID;
BEGIN
    -- Get the first text channel (type 0) named 'general' or the first text channel
    SELECT id INTO channel_id
    FROM channels 
    WHERE server_id = p_server_id 
      AND type = 0 
    ORDER BY 
        CASE WHEN name = 'general' THEN 0 ELSE 1 END,
        "order" ASC,
        created_at ASC
    LIMIT 1;
    
    RETURN channel_id;
END;
$$;


--
-- Name: get_emoji_metadata_bulk(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_emoji_metadata_bulk(server_ids uuid[]) RETURNS TABLE(server_id uuid, last_modified timestamp with time zone, emoji_count integer)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.server_id,
        COALESCE(MAX(e.updated_at), MAX(e.created_at)) as last_modified,
        COUNT(e.id)::integer as emoji_count
    FROM emojis e
    WHERE e.server_id = ANY(server_ids)
    GROUP BY e.server_id;
END;
$$;


--
-- Name: get_enhanced_timeline_posts(uuid, text, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_enhanced_timeline_posts(p_user_id uuid, p_timeline_type text DEFAULT 'home'::text, p_limit integer DEFAULT 20, p_max_id text DEFAULT NULL::text) RETURNS TABLE(id text, created_at timestamp with time zone, updated_at timestamp with time zone, content jsonb, content_warning text, language text, author_id text, ap_id text, ap_type text, url text, reply_context jsonb, conversation_id text, visibility text, is_local boolean, is_federated boolean, replies_count integer, reblogs_count integer, favorites_count integer, media_attachments jsonb, metadata jsonb, is_sensitive boolean, is_deleted boolean, deleted_at timestamp with time zone, author jsonb, is_favorited boolean, is_reblogged boolean, is_bookmarked boolean, reblog jsonb, reblog_author jsonb)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        tp.id::TEXT,
        tp.created_at,
        tp.updated_at,
        tp.content,
        tp.content_warning,
        'en'::TEXT as language,
        (tp.author->>'id')::TEXT as author_id,
        p.ap_id::TEXT,
        COALESCE(p.ap_type, 'Note')::TEXT as ap_type,
        tp.url,
        tp.reply_context,
        tp.conversation_id::TEXT,
        tp.visibility,
        (tp.author->>'is_local')::BOOLEAN as is_local,
        NOT (tp.author->>'is_local')::BOOLEAN as is_federated,
        tp.replies_count,
        tp.reblogs_count,
        tp.favorites_count,
        tp.media_attachments,
        COALESCE(p.metadata, '{}'::JSONB) as metadata,
        tp.is_sensitive,
        COALESCE(p.is_deleted, false) as is_deleted,
        p.deleted_at,
        tp.author,
        
        -- User interaction states
        COALESCE(fav.user_id IS NOT NULL, false) as is_favorited,
        COALESCE(reb.user_id IS NOT NULL, false) as is_reblogged,
        COALESCE(book.user_id IS NOT NULL, false) as is_bookmarked,
        
        -- Reblog fields
        tp.reblog,
        tp.reblog_author
        
    FROM timeline_posts tp
    JOIN posts p ON tp.id = p.id
    LEFT JOIN post_interactions fav ON tp.id = fav.post_id 
        AND fav.user_id = p_user_id 
        AND fav.interaction_type = 'favorite'
    LEFT JOIN post_interactions reb ON tp.id = reb.post_id 
        AND reb.user_id = p_user_id 
        AND reb.interaction_type = 'reblog'
    LEFT JOIN post_interactions book ON tp.id = book.post_id 
        AND book.user_id = p_user_id 
        AND book.interaction_type = 'bookmark'
    
    WHERE 
        CASE 
            -- HOME: Use timeline_entries for proper following logic
            WHEN p_timeline_type = 'home' THEN 
                EXISTS (
                    SELECT 1 FROM timeline_entries te 
                    WHERE te.user_id = p_user_id 
                      AND te.post_id = tp.id 
                      AND te.timeline_type = 'home'
                )
            
            -- LOCAL: Only public posts from local users
            WHEN p_timeline_type = 'local' THEN 
                tp.visibility = 'public' 
                AND (tp.author->>'is_local')::BOOLEAN = true
            
            -- PUBLIC/FEDERATED: All public posts (local + remote) - standard ActivityPub timeline
            WHEN p_timeline_type IN ('public', 'federated') THEN 
                tp.visibility = 'public'
                
            ELSE tp.visibility = 'public'
        END
        
        -- Pagination
        AND (p_max_id IS NULL OR tp.created_at < (
            SELECT tp2.created_at FROM timeline_posts tp2 WHERE tp2.id = p_max_id::UUID
        ))
    
    ORDER BY tp.created_at DESC
    LIMIT p_limit;
END;
$$;


--
-- Name: FUNCTION get_enhanced_timeline_posts(p_user_id uuid, p_timeline_type text, p_limit integer, p_max_id text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_enhanced_timeline_posts(p_user_id uuid, p_timeline_type text, p_limit integer, p_max_id text) IS 'Enhanced timeline function with proper home timeline support using timeline_entries and separate federated timeline';


--
-- Name: get_featured_posts_hybrid(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_featured_posts_hybrid(p_author_id uuid, p_limit integer DEFAULT 10) RETURNS TABLE(id uuid, content jsonb, created_at timestamp with time zone, updated_at timestamp with time zone, author_id uuid, engagement_count integer, replies_count integer, is_pinned boolean, ap_id text, ap_type text, visibility text, media_attachments jsonb, content_warning text, in_reply_to uuid, favorites_count integer, reblogs_count integer)
    LANGUAGE plpgsql
    AS $$
DECLARE
    pinned_count INT;
    remaining_limit INT;
BEGIN
    -- First, get pinned posts
    RETURN QUERY
    SELECT 
        p.id, p.content, p.created_at, p.updated_at, p.author_id,
        (p.favorites_count + p.reblogs_count + p.replies_count) as engagement_count,
        p.replies_count, p.is_pinned,
        p.ap_id, p.ap_type, p.visibility, p.media_attachments,
        p.content_warning, p.in_reply_to, p.favorites_count, p.reblogs_count
    FROM posts p
    WHERE p.author_id = p_author_id 
        AND p.is_pinned = true
        AND p.is_deleted = false
        AND p.visibility IN ('public', 'unlisted')
    ORDER BY p.created_at DESC
    LIMIT p_limit;

    -- Count how many pinned posts we got
    GET DIAGNOSTICS pinned_count = ROW_COUNT;
    remaining_limit := p_limit - pinned_count;

    -- If we have room for more, add popular posts
    IF remaining_limit > 0 THEN
        RETURN QUERY
        SELECT 
            p.id, p.content, p.created_at, p.updated_at, p.author_id,
            (p.favorites_count + p.reblogs_count + p.replies_count) as engagement_count,
            p.replies_count, p.is_pinned,
            p.ap_id, p.ap_type, p.visibility, p.media_attachments,
            p.content_warning, p.in_reply_to, p.favorites_count, p.reblogs_count
        FROM posts p
        WHERE p.author_id = p_author_id 
            AND p.is_pinned = false
            AND p.is_deleted = false
            AND p.visibility IN ('public', 'unlisted')
            AND (p.favorites_count + p.reblogs_count + p.replies_count) > 0
        ORDER BY (p.favorites_count + p.reblogs_count + p.replies_count) DESC, p.created_at DESC
        LIMIT remaining_limit;
    END IF;
END;
$$;


--
-- Name: get_federation_config(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_federation_config() RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    config jsonb;
BEGIN
    SELECT config_value INTO config
    FROM instance_config 
    WHERE config_key = 'federation_settings';
    
    -- Return defaults if no config exists
    IF config IS NULL THEN
        config := jsonb_build_object(
            'federation_enabled', true,
            'federation_auto_accept_follows', true,
            'federation_require_approval', false,
            'federation_max_delivery_attempts', 5,
            'federation_delivery_timeout_ms', 10000
        );
    END IF;
    
    RETURN config;
END;
$$;


--
-- Name: FUNCTION get_federation_config(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_federation_config() IS 'Get current federation configuration with sensible defaults';


--
-- Name: get_follow_status(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_follow_status(current_user_id uuid, target_user_id uuid) RETURNS TABLE(is_following boolean, is_followed_by boolean, follow_status text, followed_by_status text)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        -- Is current user following target user?
        EXISTS(
            SELECT 1 FROM follows 
            WHERE follower_id = current_user_id 
            AND following_id = target_user_id 
            AND status = 'accepted'
        ) as is_following,
        
        -- Is current user followed by target user?
        EXISTS(
            SELECT 1 FROM follows 
            WHERE follower_id = target_user_id 
            AND following_id = current_user_id 
            AND status = 'accepted'
        ) as is_followed_by,
        
        -- Follow request status (outgoing)
        COALESCE(
            (SELECT status FROM follows 
             WHERE follower_id = current_user_id 
             AND following_id = target_user_id 
             LIMIT 1), 
            'none'
        ) as follow_status,
        
        -- Follow request status (incoming)
        COALESCE(
            (SELECT status FROM follows 
             WHERE follower_id = target_user_id 
             AND following_id = current_user_id 
             LIMIT 1), 
            'none'
        ) as followed_by_status;
END;
$$;


--
-- Name: FUNCTION get_follow_status(current_user_id uuid, target_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_follow_status(current_user_id uuid, target_user_id uuid) IS 'Helper function to get complete follow relationship status between two users.
Uses correct following_id column names.
Returns: is_following, is_followed_by, follow_status, followed_by_status';


--
-- Name: get_instance_config(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_instance_config(p_key text DEFAULT NULL::text) RETURNS TABLE(config_key text, config_value jsonb, description text)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    IF p_key IS NOT NULL THEN
        RETURN QUERY
        SELECT ic.config_key, ic.config_value, ic.description
        FROM instance_config ic
        WHERE ic.config_key = p_key;
    ELSE
        RETURN QUERY
        SELECT ic.config_key, ic.config_value, ic.description
        FROM instance_config ic
        ORDER BY ic.config_key;
    END IF;
END;
$$;


--
-- Name: get_instance_domain(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_instance_domain() RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    domain_value text;
BEGIN
    -- Get domain from instance_config
    SELECT trim(both '"' from config_value::text) INTO domain_value
    FROM instance_config 
    WHERE config_key = 'domain';
    
    -- Return domain or fallback
    RETURN COALESCE(domain_value, 'localhost');
END;
$$;


--
-- Name: FUNCTION get_instance_domain(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_instance_domain() IS 'Get instance domain accessible to all users';


--
-- Name: get_message_reactions(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_message_reactions(message_id uuid) RETURNS TABLE(count bigint, emoji jsonb, reactions jsonb, message_id_of_reactions uuid)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(r.*) as count,
        to_jsonb(e.*) as emoji,
        COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'reaction_id', r.id::text,
                    'user_id', r.user_id::text
                ) ORDER BY r.created_at
            ) FILTER (WHERE r.user_id IS NOT NULL),
            '[]'::jsonb
        ) as reactions,
        get_message_reactions.message_id as message_id_of_reactions
    FROM reactions r
    LEFT JOIN emojis e ON r.emoji_id = e.id
    WHERE r.message_id = get_message_reactions.message_id
    GROUP BY r.emoji_id, e.id, r.message_id
    ORDER BY MIN(r.created_at);
END;
$$;


--
-- Name: FUNCTION get_message_reactions(message_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_message_reactions(message_id uuid) IS 'FIXED: Returns reaction groups with proper user_id handling, matching original return structure';


--
-- Name: get_or_create_conversation(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_or_create_conversation(user1_uuid uuid, user2_uuid uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  conversation_uuid UUID;
  sorted_users UUID[];
BEGIN
  -- Sort user IDs to ensure consistent ordering
  sorted_users := ARRAY[LEAST(user1_uuid, user2_uuid), GREATEST(user1_uuid, user2_uuid)];
  
  -- Find existing conversation with these exact participants
  SELECT cp1.conversation_id INTO conversation_uuid
  FROM conversation_participants cp1
  WHERE cp1.user_id = sorted_users[1]
    AND EXISTS (
      SELECT 1 FROM conversation_participants cp2
      WHERE cp2.conversation_id = cp1.conversation_id
        AND cp2.user_id = sorted_users[2]
    )
    AND NOT EXISTS (
      SELECT 1 FROM conversation_participants cp3
      WHERE cp3.conversation_id = cp1.conversation_id
        AND cp3.user_id NOT IN (sorted_users[1], sorted_users[2])
    )
  LIMIT 1;

  -- Create new conversation if not found
  IF conversation_uuid IS NULL THEN
    INSERT INTO conversations (is_group, created_at)
    VALUES (false, NOW())
    RETURNING id INTO conversation_uuid;

    INSERT INTO conversation_participants (conversation_id, user_id)
    VALUES 
      (conversation_uuid, user1_uuid),
      (conversation_uuid, user2_uuid);
      
    RAISE NOTICE 'Created new conversation: %', conversation_uuid;
  END IF;

  RETURN conversation_uuid;
END;
$$;


--
-- Name: FUNCTION get_or_create_conversation(user1_uuid uuid, user2_uuid uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_or_create_conversation(user1_uuid uuid, user2_uuid uuid) IS 'Get existing 1-to-1 conversation or create new one. Ensures consistent participant ordering.';


--
-- Name: get_or_create_dm_conversation(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_or_create_dm_conversation(p_user1_id uuid, p_user2_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_conversation_id UUID;
BEGIN
  -- Try to find existing conversation between these users
  SELECT c.id INTO v_conversation_id
  FROM conversations c
  WHERE c.type = 'direct'
    AND EXISTS (
      SELECT 1 FROM conversation_participants cp1
      WHERE cp1.conversation_id = c.id 
        AND cp1.user_id = p_user1_id 
        AND cp1.left_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM conversation_participants cp2
      WHERE cp2.conversation_id = c.id 
        AND cp2.user_id = p_user2_id 
        AND cp2.left_at IS NULL
    )
    -- Ensure it's exactly 2 participants (direct conversation)
    AND (
      SELECT COUNT(*) FROM conversation_participants cp3
      WHERE cp3.conversation_id = c.id 
        AND cp3.left_at IS NULL
    ) = 2;
  
  -- If not found, create new conversation
  IF v_conversation_id IS NULL THEN
    INSERT INTO conversations (type, created_by, is_active)
    VALUES ('direct', p_user1_id, TRUE)
    RETURNING id INTO v_conversation_id;
    
    -- Add both participants
    INSERT INTO conversation_participants (conversation_id, user_id, role, joined_at)
    VALUES 
      (v_conversation_id, p_user1_id, 'member', NOW()),
      (v_conversation_id, p_user2_id, 'member', NOW());
      
    RAISE NOTICE 'Created new DM conversation % between users % and %', 
      v_conversation_id, p_user1_id, p_user2_id;
  END IF;
  
  RETURN v_conversation_id;
END;
$$;


--
-- Name: FUNCTION get_or_create_dm_conversation(p_user1_id uuid, p_user2_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_or_create_dm_conversation(p_user1_id uuid, p_user2_id uuid) IS 'Gets existing or creates new DM conversation between two users using conversation_participants system';


--
-- Name: get_post_emoji_reactions(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_post_emoji_reactions(p_post_id uuid, p_user_limit integer DEFAULT 5) RETURNS TABLE(emoji_id uuid, emoji_name text, emoji_url text, custom_emoji_content text, reaction_count bigint, user_reactions jsonb, current_user_reacted boolean)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    current_user_id uuid;
BEGIN
    -- Get current user ID from session (if authenticated)
    current_user_id := auth.uid();
    
    RETURN QUERY
    SELECT 
        pi.emoji_id,
        e.name::text as emoji_name,
        -- ONLY CHANGE: Support remote emoji URLs from metadata
        COALESCE(e.url::text, MAX(pi.metadata->>'remote_emoji_url')) as emoji_url,
        pi.custom_emoji_content,
        COUNT(*)::bigint as reaction_count,
        -- Only include limited user data for tooltips
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'user_id', sub_pi.user_id,
                    'username', sub_p.username,
                    'display_name', sub_p.display_name,
                    'avatar_url', sub_p.avatar_url,
                    'created_at', sub_pi.created_at
                )
                ORDER BY sub_pi.created_at DESC
            )
            FROM post_interactions sub_pi
            LEFT JOIN profiles sub_p ON sub_pi.user_id = sub_p.id
            WHERE sub_pi.post_id = p_post_id
              AND sub_pi.interaction_type = 'emoji_reaction'
              AND (
                  (pi.emoji_id IS NOT NULL AND sub_pi.emoji_id = pi.emoji_id) OR
                  (pi.custom_emoji_content IS NOT NULL AND sub_pi.custom_emoji_content = pi.custom_emoji_content)
              )
            LIMIT p_user_limit
        ) as user_reactions,
        -- Check if current user has reacted with this emoji
        CASE 
            WHEN current_user_id IS NULL THEN false
            ELSE EXISTS(
                SELECT 1 FROM post_interactions check_pi
                WHERE check_pi.post_id = p_post_id
                  AND check_pi.user_id = current_user_id
                  AND check_pi.interaction_type = 'emoji_reaction'
                  AND (
                      (pi.emoji_id IS NOT NULL AND check_pi.emoji_id = pi.emoji_id) OR
                      (pi.custom_emoji_content IS NOT NULL AND check_pi.custom_emoji_content = pi.custom_emoji_content)
                  )
            )
        END as current_user_reacted
    FROM post_interactions pi
    LEFT JOIN emojis e ON pi.emoji_id = e.id
    WHERE pi.post_id = p_post_id 
      AND pi.interaction_type = 'emoji_reaction'
    GROUP BY pi.emoji_id, e.name, e.url, pi.custom_emoji_content
    ORDER BY reaction_count DESC, MIN(pi.created_at) ASC;
END;
$$;


--
-- Name: get_post_with_context(uuid, uuid, text, uuid, integer, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_post_with_context(p_post_id uuid, p_user_id uuid, p_context_type text DEFAULT 'minimal'::text, p_highlight_reply uuid DEFAULT NULL::uuid, p_max_depth integer DEFAULT 10, p_include_interactions boolean DEFAULT true) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_main_post JSONB;
  v_ancestors JSONB := '[]'::jsonb;
  v_descendants JSONB := '[]'::jsonb;
  v_thread_info JSONB;
  v_thread_id UUID;
  v_root_post_id UUID;
  v_total_posts INTEGER := 1;
  v_participant_count INTEGER := 1;
  v_max_depth INTEGER := 0;
  v_last_activity TIMESTAMP WITH TIME ZONE;
BEGIN
  -- Get the main post with all required fields and user interaction states
  SELECT to_jsonb(post_data) INTO v_main_post
  FROM (
    SELECT 
      p.*,
      profiles.id as author_id,
      profiles.username as author_username,
      profiles.display_name as author_display_name,
      profiles.avatar_url as author_avatar_url,
      profiles.domain as author_domain,
      profiles.bio as author_bio,
      profiles.is_local as author_is_local,
      profiles.followers_count as author_followers_count,
      profiles.following_count as author_following_count,
      profiles.posts_count as author_posts_count,
      profiles.created_at as author_created_at,
      profiles.updated_at as author_updated_at,
      -- Generate handle from username and domain
      CASE 
        WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
          '@' || profiles.username || '@' || profiles.domain
        ELSE 
          '@' || profiles.username
      END as author_handle,
      -- User interaction states (only if p_include_interactions is true)
      CASE 
        WHEN p_include_interactions THEN
          EXISTS(SELECT 1 FROM post_interactions WHERE post_id = p.id AND user_id = p_user_id AND interaction_type = 'favorite')
        ELSE false
      END as is_favorited,
      CASE 
        WHEN p_include_interactions THEN
          EXISTS(SELECT 1 FROM post_interactions WHERE post_id = p.id AND user_id = p_user_id AND interaction_type = 'reblog')
        ELSE false
      END as is_reblogged,
      CASE 
        WHEN p_include_interactions THEN
          EXISTS(SELECT 1 FROM post_interactions WHERE post_id = p.id AND user_id = p_user_id AND interaction_type = 'bookmark')
        ELSE false
      END as is_bookmarked,
      -- Author object for nested structure
      jsonb_build_object(
        'id', profiles.id,
        'username', profiles.username,
        'display_name', profiles.display_name,
        'avatar_url', profiles.avatar_url,
        'domain', profiles.domain,
        'bio', profiles.bio,
        'is_local', profiles.is_local,
        'followers_count', profiles.followers_count,
        'following_count', profiles.following_count,
        'posts_count', profiles.posts_count,
        'created_at', profiles.created_at,
        'updated_at', profiles.updated_at,
        'handle', CASE 
          WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
            '@' || profiles.username || '@' || profiles.domain
          ELSE 
            '@' || profiles.username
        END
      ) as author
    FROM posts p
    JOIN profiles ON profiles.id = p.author_id
    WHERE p.id = p_post_id
      AND p.is_deleted = false
  ) as post_data;

  -- If main post not found, return error
  IF v_main_post IS NULL THEN
    RETURN jsonb_build_object('error', 'Post not found');
  END IF;

  -- Get thread_id for thread context (may be null, that's ok)
  SELECT conversation_id INTO v_thread_id 
  FROM posts 
  WHERE id = p_post_id;

  -- For non-minimal contexts, get thread data
  IF p_context_type != 'minimal' THEN
    -- Find root post of the thread by following in_reply_to chain upward
    WITH RECURSIVE thread_root AS (
      -- Base case: start with the current post
      SELECT id, in_reply_to, 0 as depth
      FROM posts 
      WHERE id = p_post_id
      
      UNION ALL
      
      -- Recursive case: follow in_reply_to chain upward
      SELECT p.id, p.in_reply_to, tr.depth + 1
      FROM posts p
      JOIN thread_root tr ON p.id = tr.in_reply_to
      WHERE tr.depth < 50 -- Prevent infinite recursion
    )
    SELECT id INTO v_root_post_id 
    FROM thread_root 
    WHERE in_reply_to IS NULL
    ORDER BY depth DESC 
    LIMIT 1;

    -- If no root found, current post is the root
    IF v_root_post_id IS NULL THEN
      v_root_post_id := p_post_id;
    END IF;

    -- Get thread statistics using the conversation_root_id chain instead of conversation_id
    WITH RECURSIVE all_thread_posts AS (
      -- Start from the root post
      SELECT id, in_reply_to, author_id, created_at, 0 as depth
      FROM posts 
      WHERE id = v_root_post_id
      
      UNION ALL
      
      -- Get all posts that are replies in this thread
      SELECT p.id, p.in_reply_to, p.author_id, p.created_at, atp.depth + 1
      FROM posts p
      JOIN all_thread_posts atp ON p.in_reply_to = atp.id
      WHERE atp.depth < 50 -- Prevent infinite recursion
        AND p.is_deleted = false
    )
    SELECT 
      COUNT(DISTINCT id),
      COUNT(DISTINCT author_id),
      MAX(created_at)
    INTO v_total_posts, v_participant_count, v_last_activity
    FROM all_thread_posts;

    -- Get ancestors (posts this is replying to) if requested
    IF p_context_type IN ('thread', 'ancestors') THEN
      WITH RECURSIVE ancestors AS (
        -- Base case: direct parent
        SELECT p.*, 0 as depth
        FROM posts p
        WHERE p.id = (SELECT in_reply_to FROM posts WHERE id = p_post_id)
          AND p.is_deleted = false
        
        UNION ALL
        
        -- Recursive case: follow the reply chain upward
        SELECT p.*, a.depth + 1
        FROM posts p
        JOIN ancestors a ON p.id = (SELECT in_reply_to FROM posts WHERE id = a.id)
        WHERE a.depth < p_max_depth
          AND p.is_deleted = false
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', a.id,
          'created_at', a.created_at,
          'updated_at', a.updated_at,
          'content', a.content,
          'content_warning', a.content_warning,
          'language', a.language,
          'author_id', a.author_id,
          'ap_id', a.ap_id,
          'ap_type', a.ap_type,
          'url', a.url,
          'conversation_id', a.conversation_id,
          'visibility', a.visibility,
          'is_local', a.is_local,
          'is_federated', a.is_federated,
          'replies_count', a.replies_count,
          'reblogs_count', a.reblogs_count,
          'favorites_count', a.favorites_count,
          'media_attachments', a.media_attachments,
          'metadata', a.metadata,
          'is_sensitive', a.is_sensitive,
          'is_deleted', a.is_deleted,
          'deleted_at', a.deleted_at,
          'is_favorited', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = a.id AND user_id = p_user_id AND interaction_type = 'favorite')
            ELSE false
          END,
          'is_reblogged', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = a.id AND user_id = p_user_id AND interaction_type = 'reblog')
            ELSE false
          END,
          'is_bookmarked', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = a.id AND user_id = p_user_id AND interaction_type = 'bookmark')
            ELSE false
          END,
          'author', jsonb_build_object(
            'id', profiles.id,
            'username', profiles.username,
            'display_name', profiles.display_name,
            'avatar_url', profiles.avatar_url,
            'domain', profiles.domain,
            'bio', profiles.bio,
            'is_local', profiles.is_local,
            'followers_count', profiles.followers_count,
            'following_count', profiles.following_count,
            'posts_count', profiles.posts_count,
            'created_at', profiles.created_at,
            'updated_at', profiles.updated_at,
            'handle', CASE 
              WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
                '@' || profiles.username || '@' || profiles.domain
              ELSE 
                '@' || profiles.username
            END
          )
        ) ORDER BY a.depth DESC -- Oldest ancestor first
      ) INTO v_ancestors
      FROM ancestors a
      JOIN profiles ON profiles.id = a.author_id;
    END IF;

    -- Get descendants (replies to this post) if requested
    IF p_context_type IN ('thread', 'descendants') THEN
      WITH RECURSIVE descendants AS (
        -- Base case: direct replies
        SELECT p.*, 0 as depth, ARRAY[p.created_at::text, p.id::text] as sort_path
        FROM posts p
        WHERE p.in_reply_to = p_post_id
          AND p.is_deleted = false
        
        UNION ALL
        
        -- Recursive case: follow reply chains downward
        SELECT p.*, d.depth + 1, d.sort_path || ARRAY[p.created_at::text, p.id::text]
        FROM posts p
        JOIN descendants d ON p.in_reply_to = d.id
        WHERE d.depth < p_max_depth
          AND p.is_deleted = false
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', d.id,
          'created_at', d.created_at,
          'updated_at', d.updated_at,
          'content', d.content,
          'content_warning', d.content_warning,
          'language', d.language,
          'author_id', d.author_id,
          'ap_id', d.ap_id,
          'ap_type', d.ap_type,
          'url', d.url,
          'conversation_id', d.conversation_id,
          'visibility', d.visibility,
          'is_local', d.is_local,
          'is_federated', d.is_federated,
          'replies_count', d.replies_count,
          'reblogs_count', d.reblogs_count,
          'favorites_count', d.favorites_count,
          'media_attachments', d.media_attachments,
          'metadata', d.metadata,
          'is_sensitive', d.is_sensitive,
          'is_deleted', d.is_deleted,
          'deleted_at', d.deleted_at,
          'depth', d.depth,
          'is_favorited', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = d.id AND user_id = p_user_id AND interaction_type = 'favorite')
            ELSE false
          END,
          'is_reblogged', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = d.id AND user_id = p_user_id AND interaction_type = 'reblog')
            ELSE false
          END,
          'is_bookmarked', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = d.id AND user_id = p_user_id AND interaction_type = 'bookmark')
            ELSE false
          END,
          'author', jsonb_build_object(
            'id', profiles.id,
            'username', profiles.username,
            'display_name', profiles.display_name,
            'avatar_url', profiles.avatar_url,
            'domain', profiles.domain,
            'bio', profiles.bio,
            'is_local', profiles.is_local,
            'followers_count', profiles.followers_count,
            'following_count', profiles.following_count,
            'posts_count', profiles.posts_count,
            'created_at', profiles.created_at,
            'updated_at', profiles.updated_at,
            'handle', CASE 
              WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
                '@' || profiles.username || '@' || profiles.domain
              ELSE 
                '@' || profiles.username
            END
          )
        ) ORDER BY d.sort_path -- Chronological order preserving thread structure
      ) INTO v_descendants
      FROM descendants d
      JOIN profiles ON profiles.id = d.author_id;
    END IF;

    -- Calculate max depth for thread info using reply chain instead of conversation_id
    WITH RECURSIVE depth_calc AS (
      SELECT id, 0 as depth
      FROM posts 
      WHERE id = v_root_post_id
      
      UNION ALL
      
      SELECT p.id, dc.depth + 1
      FROM posts p
      JOIN depth_calc dc ON p.in_reply_to = dc.id
      WHERE dc.depth < 50 -- Prevent infinite recursion
        AND p.is_deleted = false
    )
    SELECT COALESCE(MAX(depth), 0) INTO v_max_depth
    FROM depth_calc;
  END IF;

  -- Build thread info
  v_thread_info := jsonb_build_object(
    'totalPosts', COALESCE(v_total_posts, 1),
    'participantCount', COALESCE(v_participant_count, 1),
    'depth', COALESCE(v_max_depth, 0),
    'rootPostId', COALESCE(v_root_post_id, p_post_id),
    'lastActivity', COALESCE(v_last_activity, (v_main_post->>'created_at')::timestamp with time zone)
  );

  -- Return the complete result
  RETURN jsonb_build_object(
    'mainPost', v_main_post,
    'ancestors', COALESCE(v_ancestors, '[]'::jsonb),
    'descendants', COALESCE(v_descendants, '[]'::jsonb),
    'threadInfo', v_thread_info
  );

EXCEPTION WHEN OTHERS THEN
  -- Log error and return structured error response
  RAISE LOG 'Error in get_post_with_context: %', SQLERRM;
  RETURN jsonb_build_object(
    'error', 'Database error: ' || SQLERRM,
    'mainPost', null,
    'ancestors', '[]'::jsonb,
    'descendants', '[]'::jsonb,
    'threadInfo', jsonb_build_object(
      'totalPosts', 0,
      'participantCount', 0,
      'depth', 0,
      'rootPostId', null,
      'lastActivity', null
    )
  );
END;
$$;


--
-- Name: FUNCTION get_post_with_context(p_post_id uuid, p_user_id uuid, p_context_type text, p_highlight_reply uuid, p_max_depth integer, p_include_interactions boolean); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_post_with_context(p_post_id uuid, p_user_id uuid, p_context_type text, p_highlight_reply uuid, p_max_depth integer, p_include_interactions boolean) IS 'Unified function to get posts with configurable thread context (minimal, thread, ancestors, descendants). Replaces separate post detail and thread view functions.';


--
-- Name: get_public_federation_settings(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_public_federation_settings() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    federation_settings jsonb;
BEGIN
    -- Get federation settings from instance_config
    SELECT config_value INTO federation_settings
    FROM instance_config 
    WHERE config_key = 'federation_settings';
    
    -- Return safe subset of federation settings (no sensitive data)
    IF federation_settings IS NULL THEN
        RETURN jsonb_build_object(
            'federation_enabled', true,
            'federation_auto_accept_follows', true
        );
    END IF;
    
    -- Return only public federation settings
    RETURN jsonb_build_object(
        'federation_enabled', COALESCE((federation_settings->>'federation_enabled')::boolean, true),
        'federation_auto_accept_follows', COALESCE((federation_settings->>'federation_auto_accept_follows')::boolean, true)
    );
END;
$$;


--
-- Name: FUNCTION get_public_federation_settings(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_public_federation_settings() IS 'Get public federation settings accessible to all users';


--
-- Name: get_public_instance_info(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_public_instance_info() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    instance_name text;
    instance_description text;
    domain_value text;
    open_registration boolean;
    approval_required boolean;
BEGIN
    -- Get various config values
    SELECT trim(both '"' from config_value::text) INTO instance_name
    FROM instance_config WHERE config_key = 'instance_name';
    
    SELECT trim(both '"' from config_value::text) INTO instance_description
    FROM instance_config WHERE config_key = 'instance_description';
    
    SELECT trim(both '"' from config_value::text) INTO domain_value
    FROM instance_config WHERE config_key = 'domain';
    
    SELECT (config_value)::boolean INTO open_registration
    FROM instance_config WHERE config_key = 'open_registration';
    
    SELECT (config_value)::boolean INTO approval_required
    FROM instance_config WHERE config_key = 'approval_required';
    
    -- Return public instance information
    RETURN jsonb_build_object(
        'name', COALESCE(instance_name, 'Harmony Instance'),
        'description', COALESCE(instance_description, 'A federated social platform'),
        'domain', COALESCE(domain_value, 'localhost'),
        'open_registration', COALESCE(open_registration, true),
        'approval_required', COALESCE(approval_required, false)
    );
END;
$$;


--
-- Name: FUNCTION get_public_instance_info(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_public_instance_info() IS 'Get public instance information accessible to all users';


--
-- Name: get_recent_admin_activity(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_recent_admin_activity(p_limit integer DEFAULT 20) RETURNS TABLE(id uuid, admin_username text, action_type text, target_type text, target_id text, action_details jsonb, created_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        aal.id,
        p.username as admin_username,
        aal.action_type,
        aal.target_type,
        aal.target_id,
        aal.action_details,
        aal.created_at
    FROM admin_audit_log aal
    JOIN profiles p ON aal.admin_id = p.id
    ORDER BY aal.created_at DESC
    LIMIT p_limit;
END;
$$;


--
-- Name: get_server_members_by_instance(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_server_members_by_instance(p_server_id uuid) RETURNS TABLE(instance text, member_ids uuid[], member_ap_ids text[], member_count integer)
    LANGUAGE sql STABLE
    AS $$
  SELECT 
    COALESCE(p.domain, 'local') as instance,
    array_agg(p.id) as member_ids,
    array_agg(p.federated_id) as member_ap_ids,
    COUNT(*)::INT as member_count
  FROM user_servers us
  JOIN profiles p ON us.user_id = p.id
  WHERE us.server_id = p_server_id
  GROUP BY COALESCE(p.domain, 'local');
$$;


--
-- Name: FUNCTION get_server_members_by_instance(p_server_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_server_members_by_instance(p_server_id uuid) IS 'Get server members grouped by instance domain for efficient batch delivery';


--
-- Name: get_system_stats(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_system_stats() RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  SELECT jsonb_build_object(
    'users_total', (SELECT COUNT(*) FROM profiles WHERE is_local = true),
    'posts_total', (SELECT COUNT(*) FROM posts WHERE is_local = true),
    'servers_total', (SELECT COUNT(*) FROM servers),
    'messages_today', (SELECT COUNT(*) FROM messages WHERE created_at > CURRENT_DATE),
    'active_users_week', (SELECT COUNT(DISTINCT author_id) FROM posts WHERE created_at > NOW() - INTERVAL '7 days')
  );
$$;


--
-- Name: FUNCTION get_system_stats(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_system_stats() IS 'Get system statistics for admin dashboard';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    content jsonb NOT NULL,
    content_warning text,
    language text DEFAULT 'en'::text,
    author_id uuid NOT NULL,
    ap_id text,
    ap_type text DEFAULT 'Note'::text,
    url text,
    in_reply_to uuid,
    conversation_id uuid,
    visibility text DEFAULT 'public'::text,
    is_local boolean DEFAULT true,
    is_federated boolean DEFAULT true,
    replies_count integer DEFAULT 0,
    reblogs_count integer DEFAULT 0,
    favorites_count integer DEFAULT 0,
    media_attachments jsonb DEFAULT '[]'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    is_sensitive boolean DEFAULT false,
    is_deleted boolean DEFAULT false,
    deleted_at timestamp with time zone,
    edit_history jsonb DEFAULT '[]'::jsonb,
    voice_attachments jsonb DEFAULT '[]'::jsonb,
    federated_to text[] DEFAULT '{}'::text[],
    federation_status text DEFAULT 'pending'::text,
    last_federated_at timestamp with time zone,
    conversation_root_id uuid,
    is_favorited boolean DEFAULT false,
    is_reblogged boolean DEFAULT false,
    is_bookmarked boolean DEFAULT false,
    reblog jsonb,
    reblog_author jsonb,
    is_pinned boolean DEFAULT false,
    CONSTRAINT posts_content_is_array CHECK ((jsonb_typeof(content) = 'array'::text)),
    CONSTRAINT posts_content_not_empty CHECK (((jsonb_array_length(content) > 0) OR (reblog IS NOT NULL))),
    CONSTRAINT posts_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'unlisted'::text, 'followers'::text, 'direct'::text])))
);


--
-- Name: COLUMN posts.conversation_root_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.posts.conversation_root_id IS 'UUID of the root post in this ActivityPub conversation thread. Enables O(1) conversation lookups.';


--
-- Name: COLUMN posts.is_favorited; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.posts.is_favorited IS 'Whether the current user has favorited this post';


--
-- Name: COLUMN posts.is_reblogged; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.posts.is_reblogged IS 'Whether the current user has reblogged this post';


--
-- Name: COLUMN posts.is_bookmarked; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.posts.is_bookmarked IS 'Whether the current user has bookmarked this post';


--
-- Name: CONSTRAINT posts_content_not_empty ON posts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT posts_content_not_empty ON public.posts IS 'Ensures posts have content OR are reblogs. Pure reblogs can have empty content if reblog field is present.';


--
-- Name: get_timeline(uuid, integer, timestamp without time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_timeline(p_user_id uuid, p_limit integer DEFAULT 50, p_before timestamp without time zone DEFAULT now()) RETURNS SETOF public.posts
    LANGUAGE sql STABLE
    AS $$
  SELECT p.*
  FROM posts p
  WHERE p.author_id IN (
    SELECT following_id 
    FROM follows 
    WHERE follower_id = p_user_id AND status = 'accepted'
  )
  AND p.created_at < p_before
  ORDER BY p.created_at DESC
  LIMIT p_limit;
$$;


--
-- Name: FUNCTION get_timeline(p_user_id uuid, p_limit integer, p_before timestamp without time zone); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_timeline(p_user_id uuid, p_limit integer, p_before timestamp without time zone) IS 'Get timeline posts from followed users (home feed)';


--
-- Name: get_trending_hashtags(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_trending_hashtags(p_days integer DEFAULT 7, p_limit integer DEFAULT 20) RETURNS TABLE(tag text, uses_count bigint, unique_users bigint)
    LANGUAGE sql STABLE
    AS $$
  SELECT 
    h.tag,
    COUNT(*) as uses_count,
    COUNT(DISTINCT p.author_id) as unique_users
  FROM post_hashtags ph
  JOIN hashtags h ON ph.hashtag_id = h.id
  JOIN posts p ON ph.post_id = p.id
  WHERE ph.created_at > NOW() - (p_days || ' days')::INTERVAL
  GROUP BY h.tag
  ORDER BY uses_count DESC
  LIMIT p_limit;
$$;


--
-- Name: FUNCTION get_trending_hashtags(p_days integer, p_limit integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_trending_hashtags(p_days integer, p_limit integer) IS 'Get trending hashtags over specified period';


--
-- Name: get_unread_notification_count(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_unread_notification_count(p_user_id uuid) RETURNS integer
    LANGUAGE sql STABLE
    AS $$
  SELECT COUNT(*)::INTEGER
  FROM notifications
  WHERE user_id = p_user_id AND is_read = false;
$$;


--
-- Name: FUNCTION get_unread_notification_count(p_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_unread_notification_count(p_user_id uuid) IS 'Get count of unread notifications for user';


--
-- Name: get_user_conversations_with_participants(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_conversations_with_participants(user_uuid uuid) RETURNS TABLE(conversation_id uuid, conversation_name text, conversation_type text, is_active boolean, created_at timestamp with time zone, updated_at timestamp with time zone, participant_count bigint, other_participants jsonb, user_role text, user_joined_at timestamp with time zone, user_last_read_at timestamp with time zone)
    LANGUAGE sql STABLE
    AS $$
  SELECT 
    c.id as conversation_id,
    c.name as conversation_name,
    c.type as conversation_type,
    c.is_active,
    c.created_at,
    c.updated_at,
    (
      SELECT COUNT(*) FROM conversation_participants cp_count
      WHERE cp_count.conversation_id = c.id AND cp_count.left_at IS NULL
    ) as participant_count,
    (
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'user_id', cp_others.user_id,
            'role', cp_others.role,
            'joined_at', cp_others.joined_at
          )
        ),
        '[]'::jsonb
      )
      FROM conversation_participants cp_others
      WHERE cp_others.conversation_id = c.id 
        AND cp_others.user_id != user_uuid
        AND cp_others.left_at IS NULL
    ) as other_participants,
    cp_user.role as user_role,
    cp_user.joined_at as user_joined_at,
    cp_user.last_read_at as user_last_read_at
  FROM conversations c
  INNER JOIN conversation_participants cp_user ON c.id = cp_user.conversation_id
  WHERE cp_user.user_id = user_uuid 
    AND cp_user.left_at IS NULL
    AND c.is_active = TRUE
  ORDER BY c.updated_at DESC;
$$;


--
-- Name: FUNCTION get_user_conversations_with_participants(user_uuid uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_user_conversations_with_participants(user_uuid uuid) IS 'Returns all active conversations for a user with participant information. Used by service layer for conversation management.';


--
-- Name: get_user_featured_posts(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_featured_posts(p_author_id uuid, p_limit integer DEFAULT 10) RETURNS TABLE(id uuid, content jsonb, created_at timestamp with time zone, updated_at timestamp with time zone, author_id uuid, engagement_count integer, replies_count integer, is_pinned boolean, ap_id text, ap_type text, visibility text, media_attachments jsonb, content_warning text, in_reply_to uuid, favorites_count integer, reblogs_count integer)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id, p.content, p.created_at, p.updated_at, p.author_id,
        (p.favorites_count + p.reblogs_count + p.replies_count) as engagement_count,
        p.replies_count, p.is_pinned,
        p.ap_id, p.ap_type, p.visibility, p.media_attachments,
        p.content_warning, p.in_reply_to, p.favorites_count, p.reblogs_count
    FROM posts p
    WHERE p.author_id = p_author_id 
        AND p.is_deleted = false
        AND p.visibility IN ('public', 'unlisted')
    ORDER BY 
        CASE WHEN p.is_pinned THEN 1 ELSE 2 END,
        (p.favorites_count + p.reblogs_count + p.replies_count) DESC,
        p.created_at DESC
    LIMIT p_limit;
END;
$$;


--
-- Name: get_user_handle(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_handle(p_user_id uuid) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  SELECT username || '@' || domain
  FROM profiles
  WHERE id = p_user_id;
$$;


--
-- Name: FUNCTION get_user_handle(p_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_user_handle(p_user_id uuid) IS 'Get user handle in username@domain format';


--
-- Name: get_user_id_from_username(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_id_from_username(username_param text) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    user_id UUID;
BEGIN
    SELECT id INTO user_id
    FROM profiles
    WHERE username = username_param
    LIMIT 1;
    
    RETURN user_id;
END;
$$;


--
-- Name: FUNCTION get_user_id_from_username(username_param text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_user_id_from_username(username_param text) IS 'Gets user ID from username for mention processing';


--
-- Name: get_user_notifications(uuid, integer, integer, boolean, character varying[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_notifications(p_user_id uuid, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0, p_unread_only boolean DEFAULT false, p_notification_types character varying[] DEFAULT NULL::character varying[]) RETURNS TABLE(id uuid, user_id uuid, type character varying, data jsonb, is_read boolean, is_clicked boolean, created_at timestamp with time zone, updated_at timestamp with time zone, expires_at timestamp with time zone, read_at timestamp with time zone)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        n.id,
        n.user_id,
        n.type,
        n.data,
        n.is_read,
        n.is_clicked,
        n.created_at,
        n.updated_at,
        n.expires_at,
        n.read_at
    FROM notifications n
    WHERE n.user_id = p_user_id
    AND (NOT p_unread_only OR n.is_read = FALSE)
    AND (p_notification_types IS NULL OR n.type = ANY(p_notification_types))
    ORDER BY n.created_at DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;


--
-- Name: FUNCTION get_user_notifications(p_user_id uuid, p_limit integer, p_offset integer, p_unread_only boolean, p_notification_types character varying[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_user_notifications(p_user_id uuid, p_limit integer, p_offset integer, p_unread_only boolean, p_notification_types character varying[]) IS 'Get user notifications with filtering. Supports pagination and type filtering. Returns actual table structure with JSONB data field.';


--
-- Name: get_user_private_key(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_private_key(p_user_id uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_private_key TEXT;
BEGIN
    -- This function can only be called server-side
    -- Additional security: check if caller has proper permissions
    SELECT private_key INTO v_private_key
    FROM user_private_keys
    WHERE user_id = p_user_id;
    
    RETURN v_private_key;
END;
$$;


--
-- Name: handle_activitypub_activity_processing(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_activitypub_activity_processing() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'extensions', 'public', 'pg_temp'
    AS $$
DECLARE
    v_actor_profile RECORD;
    v_target_profile RECORD;
    v_activity_object JSONB;
    v_object_id TEXT;
    v_instance_domain TEXT;
    v_result JSONB;
BEGIN
    -- Process activities that are:
    -- 1. In 'processing' status (freshly validated by inbox)
    -- 2. In 'pending' status and ready for retry (next_attempt_at <= now)
    -- Skip if already processed
    IF OLD.status = 'processed' THEN
        RETURN NEW;
    END IF;

    IF NOT (
        (NEW.status = 'processing') OR 
        (NEW.status = 'pending' AND NEW.next_attempt_at IS NOT NULL AND NEW.next_attempt_at <= NOW())
    ) THEN
        RETURN NEW;
    END IF;

    -- Get instance domain
    SELECT trim(both '"' from config_value::text) INTO v_instance_domain 
    FROM instance_config 
    WHERE config_key = 'domain' 
    LIMIT 1;

    IF v_instance_domain IS NULL THEN
        v_instance_domain := 'har.mony.lol'; -- fallback
    END IF;

    -- Get actor profile by resolving from actor_ap_id using federated_id column
    SELECT * INTO v_actor_profile
    FROM profiles 
    WHERE federated_id = NEW.actor_ap_id;

    IF NOT FOUND THEN
        -- Try to get or create the remote profile
        RAISE NOTICE 'Actor profile not found for %s, attempting to create...', NEW.actor_ap_id;
        
        -- For now, we'll fail the activity if actor profile doesn't exist
        -- In a production system, you might want to fetch the actor and create the profile
        UPDATE ap_activities 
        SET status = 'failed', 
            error_message = 'Actor profile not found: ' || NEW.actor_ap_id,
            updated_at = NOW()
        WHERE id = NEW.id;
        RETURN NEW;
    END IF;

    -- Extract object from activity data
    v_activity_object := NEW.activity_data->'object';
    v_object_id := CASE 
        WHEN jsonb_typeof(v_activity_object) = 'string' THEN v_activity_object::text
        ELSE v_activity_object->>'id'
    END;

    RAISE NOTICE 'Processing % activity % from %', NEW.ap_type, NEW.ap_id, v_actor_profile.username;

    BEGIN
        -- Process based on activity type
        CASE NEW.ap_type
            WHEN 'Follow' THEN
                PERFORM process_follow_activity(NEW.id, NEW.activity_data, v_actor_profile, v_instance_domain);
                
            WHEN 'Accept' THEN
                PERFORM process_accept_activity(NEW.id, NEW.activity_data, v_actor_profile);
                
            WHEN 'Reject' THEN
                PERFORM process_reject_activity(NEW.id, NEW.activity_data, v_actor_profile);
            
            WHEN 'Undo' THEN
                PERFORM process_undo_activity(NEW.id, NEW.activity_data, v_actor_profile);
            
            WHEN 'Create' THEN
                PERFORM process_create_activity(NEW.id, NEW.activity_data, v_actor_profile, v_instance_domain);
            
            WHEN 'Update' THEN
                PERFORM process_update_activity(NEW.id, NEW.activity_data, v_actor_profile);
            
            WHEN 'Delete' THEN
                PERFORM process_delete_activity(NEW.id, NEW.activity_data, v_actor_profile);
            
            WHEN 'Like' THEN
                PERFORM process_like_activity(NEW.id, NEW.activity_data, v_actor_profile);
            
            WHEN 'Announce' THEN
                PERFORM process_announce_activity(NEW.id, NEW.activity_data, v_actor_profile);
                
            ELSE
                RAISE WARNING 'Unhandled activity type: %', NEW.ap_type;
        END CASE;

        -- Mark as processed
        UPDATE ap_activities 
        SET status = 'processed', 
            updated_at = NOW()
        WHERE id = NEW.id;
        
        RAISE NOTICE '✅ Successfully processed % activity: %', NEW.ap_type, NEW.ap_id;

    EXCEPTION WHEN OTHERS THEN
        -- Implement retry logic for processing failures
        DECLARE
            v_new_attempts INTEGER := COALESCE(NEW.attempts, 0) + 1;
            v_max_attempts INTEGER := 5;
            v_next_retry_delay INTERVAL;
        BEGIN
            RAISE WARNING 'Error processing activity %: %', NEW.ap_id, SQLERRM;
            
            IF v_new_attempts >= v_max_attempts THEN
                -- Max attempts reached, mark as failed
                UPDATE ap_activities 
                SET status = 'failed',
                    error_message = SQLERRM,
                    attempts = v_new_attempts,
                    last_attempt_at = NOW(),
                    updated_at = NOW()
                WHERE id = NEW.id;
                
                RAISE NOTICE 'Activity % failed permanently after % attempts', NEW.ap_id, v_new_attempts;
            ELSE
                -- Calculate exponential backoff: 2^attempts minutes
                v_next_retry_delay := (POWER(2, v_new_attempts) || ' minutes')::INTERVAL;
                
                UPDATE ap_activities 
                SET status = 'pending',
                    error_message = SQLERRM,
                    attempts = v_new_attempts,
                    last_attempt_at = NOW(),
                    next_attempt_at = NOW() + v_next_retry_delay,
                    updated_at = NOW()
                WHERE id = NEW.id;
                
                RAISE NOTICE 'Activity % scheduled for retry #% in %', NEW.ap_id, v_new_attempts, v_next_retry_delay;
            END IF;
        END;
    END;

    RETURN NEW;
END;
$$;


--
-- Name: FUNCTION handle_activitypub_activity_processing(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_activitypub_activity_processing() IS 'Fixed unified ActivityPub activity processor that uses correct column names (federated_id instead of ap_id for profiles table).';


--
-- Name: handle_incoming_messages(uuid, jsonb, record, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_incoming_messages(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $_$
DECLARE
    v_object JSONB;
    v_content JSONB;
    v_conversation_id UUID;
    v_message_id UUID;
    v_in_reply_to TEXT;
    v_replied_message_id UUID;
    v_mentioned_users TEXT[];
    v_directly_addressed TEXT[];
    v_all_recipients TEXT[];
    v_username TEXT;
    v_local_user RECORD;
    v_all_participants UUID[];
    v_local_user_ids UUID[];
    v_is_dm BOOLEAN := false;
BEGIN
    RAISE NOTICE '📩 MODERN: Processing ActivityPub message from %@% (with reply support)', 
        actor_profile.username, actor_profile.domain;
    
    v_object := activity_data->'object';
    
    -- Check if this is actually a DM using the existing detection function
    v_is_dm := is_activitypub_direct_message(v_object, instance_domain);
    
    -- STEP 1: Check if this is a reply to an existing message
    v_in_reply_to := v_object->>'inReplyTo';
    
    IF v_in_reply_to IS NOT NULL THEN
        RAISE NOTICE '💬 Processing REPLY to: %', v_in_reply_to;
        
        -- Extract message UUID from inReplyTo URL
        IF v_in_reply_to LIKE 'https://' || instance_domain || '/messages/%' THEN
            v_replied_message_id := substring(v_in_reply_to from 'https://[^/]+/messages/([a-f0-9\-]{36})$')::uuid;
            
            -- Find the conversation from the original message
            SELECT conversation_id INTO v_conversation_id
            FROM messages 
            WHERE id = v_replied_message_id;
            
            IF FOUND THEN
                RAISE NOTICE '✅ Found existing conversation % for reply', v_conversation_id;
                
                -- Convert content 
                v_content := convert_ap_to_jsonb(
                    v_object->>'content', 
                    v_object->'tag'
                );
                
                -- 🔧 FIX: Strip redundant @user@domain mentions ONLY from DM reply content
                IF v_is_dm THEN
                    v_content := strip_mentions_from_dm_content(v_content);
                    RAISE NOTICE '🧹 Stripped mentions from DM reply content';
                ELSE
                    RAISE NOTICE '📢 Keeping mentions in non-DM reply';
                END IF;
                
                -- Insert the reply message
                INSERT INTO messages (
                    conversation_id,
                    user_id,
                    content,
                    created_at,
                    is_system,
                    reply_to,
                    metadata
                ) VALUES (
                    v_conversation_id,
                    actor_profile.id,
                    v_content,
                    COALESCE((v_object->>'published')::timestamptz, NOW()),
                    false,
                    v_replied_message_id,
                    jsonb_build_object(
                        'federated', true,
                        'ap_id', v_object->>'id',
                        'ap_type', 'Note',
                        'from_domain', actor_profile.domain,
                        'original_url', COALESCE(v_object->>'url', v_object->>'id'),
                        'actor_ap_id', actor_profile.federated_id,
                        'activity_id', activity_id,
                        'in_reply_to', v_in_reply_to,
                        'is_dm', v_is_dm
                    )
                ) RETURNING id INTO v_message_id;

                RAISE NOTICE '✅ Saved reply message %: %@% -> conversation %', 
                    v_message_id, actor_profile.username, actor_profile.domain, v_conversation_id;
                
                RETURN; -- Reply processed successfully
            ELSE
                RAISE WARNING '⚠️ Could not find original message % for reply, treating as new message', v_replied_message_id;
            END IF;
        ELSE
            RAISE WARNING '⚠️ inReplyTo URL format not recognized: %', v_in_reply_to;
        END IF;
    END IF;
    
    -- STEP 2: Process as new message/mention
    RAISE NOTICE '📧 Processing as new message/mention';
    
    -- Extract mentioned local users from tags
    SELECT ARRAY_AGG(DISTINCT username) INTO v_mentioned_users
    FROM (
        SELECT CASE 
            WHEN tag->>'href' LIKE 'https://' || instance_domain || '/users/%' THEN
                substring(tag->>'href' from 'https://' || instance_domain || '/users/([^/]+)')
            ELSE NULL
        END as username
        FROM jsonb_array_elements(COALESCE(v_object->'tag', '[]'::jsonb)) AS tag
        WHERE tag->>'type' = 'Mention'
    ) t 
    WHERE username IS NOT NULL;

    -- Also check direct addressing in 'to' and 'cc' fields
    SELECT ARRAY_AGG(DISTINCT username) INTO v_directly_addressed
    FROM (
        SELECT CASE 
            WHEN recipient LIKE 'https://' || instance_domain || '/users/%' THEN
                substring(recipient from 'https://' || instance_domain || '/users/([^/]+)')
            ELSE NULL
        END as username
        FROM (
            SELECT jsonb_array_elements_text(COALESCE(v_object->'to', '[]'::jsonb)) as recipient
            UNION ALL
            SELECT jsonb_array_elements_text(COALESCE(v_object->'cc', '[]'::jsonb)) as recipient
        ) recipients
    ) t 
    WHERE username IS NOT NULL;

    -- Combine all recipients and remove duplicates
    v_all_recipients := COALESCE(v_mentioned_users, ARRAY[]::TEXT[]) || COALESCE(v_directly_addressed, ARRAY[]::TEXT[]);
    SELECT ARRAY_AGG(DISTINCT username) INTO v_all_recipients FROM unnest(v_all_recipients) AS username;
    
    IF v_all_recipients IS NULL OR array_length(v_all_recipients, 1) = 0 THEN
        RAISE WARNING 'Message has no local recipients - skipping';
        RETURN;
    END IF;

    RAISE NOTICE '📧 Message mentions % local users: %', array_length(v_all_recipients, 1), v_all_recipients;
    
    -- Convert ActivityPub HTML content to our JSONB format
    v_content := convert_ap_to_jsonb(
        v_object->>'content', 
        v_object->'tag'
    );
    
    -- 🔧 FIX: Strip redundant @user@domain mentions ONLY from DM content
    IF v_is_dm THEN
        v_content := strip_mentions_from_dm_content(v_content);
        RAISE NOTICE '🧹 Stripped mentions from DM content';
    ELSE
        RAISE NOTICE '📢 Keeping mentions in non-DM message';
    END IF;
    
    -- Get all local user IDs that are mentioned
    SELECT ARRAY_AGG(p.id) INTO v_local_user_ids
    FROM profiles p
    WHERE p.username = ANY(v_all_recipients)
      AND p.is_local = true;

    IF v_local_user_ids IS NULL OR array_length(v_local_user_ids, 1) = 0 THEN
        RAISE WARNING 'No valid local users found from mentions: %', v_all_recipients;
        RETURN;
    END IF;

    RAISE NOTICE '📨 Found % valid local users', array_length(v_local_user_ids, 1);

    -- Create participant list: remote sender + all local recipients
    v_all_participants := ARRAY[actor_profile.id] || v_local_user_ids;

    RAISE NOTICE '🎯 Total conversation participants: %', array_length(v_all_participants, 1);

    -- Find existing conversation with EXACT same participants
    SELECT DISTINCT c.id INTO v_conversation_id
    FROM conversations c
    WHERE (
        -- For direct conversations (1:1)
        (c.type = 'direct' AND EXISTS (
            SELECT 1 FROM conversation_participants cp1
            WHERE cp1.conversation_id = c.id 
              AND cp1.user_id = actor_profile.id 
              AND cp1.left_at IS NULL
        ) AND EXISTS (
            SELECT 1 FROM conversation_participants cp2
            WHERE cp2.conversation_id = c.id 
              AND cp2.user_id = ANY(v_local_user_ids)
              AND cp2.left_at IS NULL
        ) AND (
            SELECT COUNT(*) FROM conversation_participants cp3
            WHERE cp3.conversation_id = c.id 
              AND cp3.left_at IS NULL
        ) = 2)
        
        OR
        
        -- For group conversations (multi-participant)
        (c.type = 'group' AND (
            SELECT ARRAY_AGG(cp.user_id ORDER BY cp.user_id) 
            FROM conversation_participants cp
            WHERE cp.conversation_id = c.id 
              AND cp.left_at IS NULL
        ) = (
            SELECT ARRAY_AGG(unnest ORDER BY unnest) 
            FROM unnest(v_all_participants)
        ))
    )
    LIMIT 1;

    IF v_conversation_id IS NULL THEN
        -- Create new conversation with proper type
        INSERT INTO conversations (
            type, 
            created_by, 
            is_active,
            created_at,
            updated_at
        ) VALUES (
            CASE 
                WHEN array_length(v_all_participants, 1) = 2 THEN 'direct'
                ELSE 'group'
            END,
            actor_profile.id,
            TRUE,
            NOW(),
            NOW()
        ) RETURNING id INTO v_conversation_id;
        
        -- Add all participants
        INSERT INTO conversation_participants (conversation_id, user_id, role, joined_at)
        SELECT v_conversation_id, unnest, 'member', NOW()
        FROM unnest(v_all_participants);
        
        RAISE NOTICE '🆕 Created new % conversation: %', 
            CASE WHEN array_length(v_all_participants, 1) = 2 THEN 'direct' ELSE 'group' END,
            v_conversation_id;
    ELSE
        RAISE NOTICE '📝 Found existing conversation: %', v_conversation_id;
    END IF;

    -- Insert the message (with mentions stripped only if DM)
    INSERT INTO messages (
        conversation_id,
        user_id,
        content,
        created_at,
        is_system,
        metadata
    ) VALUES (
        v_conversation_id,
        actor_profile.id,
        v_content,
        COALESCE((v_object->>'published')::timestamptz, NOW()),
        false,
        jsonb_build_object(
            'federated', true,
            'ap_id', v_object->>'id',
            'ap_type', 'Note',
            'from_domain', actor_profile.domain,
            'original_url', COALESCE(v_object->>'url', v_object->>'id'),
            'actor_ap_id', actor_profile.federated_id,
            'activity_id', activity_id,
            'mentioned_users', v_all_recipients,
            'participant_count', array_length(v_all_participants, 1),
            'is_dm', v_is_dm
        )
    ) RETURNING id INTO v_message_id;

    RAISE NOTICE '✅ Saved federated message %: %@% -> conversation % (% participants)', 
        v_message_id, actor_profile.username, actor_profile.domain, v_conversation_id, array_length(v_all_participants, 1);
    
    RAISE NOTICE '🎯 Completed message processing for activity %', activity_id;
END;
$_$;


--
-- Name: FUNCTION handle_incoming_messages(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_incoming_messages(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text) IS 'MODERN: Processes incoming ActivityPub messages with support for replies (inReplyTo), mentions, and multi-participant conversations using conversation_participants table. Handles both new messages and replies to existing conversations. Note: Message notifications are handled by existing message triggers - this function focuses on message creation only.';


--
-- Name: handle_local_post_mention_notifications(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_local_post_mention_notifications() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    content_part JSONB;
    mentioned_username TEXT;
    mentioned_user_id UUID;
    author_profile RECORD;
BEGIN
    -- Only handle new posts
    IF TG_OP = 'INSERT' THEN
        -- Get author profile for notification data
        SELECT id, username, display_name, avatar_url, domain, is_local
        INTO author_profile
        FROM profiles 
        WHERE id = NEW.author_id;
        
        -- Only process if author found and content exists
        IF FOUND AND NEW.content IS NOT NULL THEN
            -- Extract mentions from unified content format
            FOR content_part IN SELECT jsonb_array_elements(NEW.content)
            LOOP
                -- Check if this is a mention
                IF content_part->>'type' = 'mention' THEN
                    -- Extract username from mention
                    mentioned_username := content_part->>'username';
                    
                    -- Get the mentioned user ID (only local users)
                    SELECT id INTO mentioned_user_id
                    FROM profiles
                    WHERE username = mentioned_username
                      AND is_local = true
                      AND id != NEW.author_id; -- Don't notify self
                    
                    -- Create notification if mentioned user found
                    IF mentioned_user_id IS NOT NULL THEN
                        PERFORM create_simple_activitypub_notification(
                            mentioned_user_id,
                            'activitypub_mention',
                            jsonb_build_object(
                                'author', jsonb_build_object(
                                    'id', author_profile.id,
                                    'username', author_profile.username,
                                    'display_name', author_profile.display_name,
                                    'avatar_url', author_profile.avatar_url,
                                    'domain', author_profile.domain,
                                    'is_local', author_profile.is_local
                                ),
                                'post_id', NEW.id,
                                'post_content', NEW.content,
                                'timestamp', NEW.created_at
                            )
                        );
                        
                        RAISE NOTICE '✅ Created mention notification: % mentioned %', 
                            author_profile.username, mentioned_username;
                    END IF;
                END IF;
            END LOOP;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;


--
-- Name: FUNCTION handle_local_post_mention_notifications(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_local_post_mention_notifications() IS 'Creates notifications for local users mentioned in posts by other local users';


--
-- Name: handle_message_federation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_message_federation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_federation_type TEXT;
    v_is_federated_incoming BOOLEAN;
    v_sender_profile profiles%ROWTYPE;
BEGIN
    -- Determine federation type
    v_federation_type := determine_message_federation_type(NEW.id);
    
    -- Check if this is an incoming federated message
    v_is_federated_incoming := (NEW.metadata->>'federated' = 'true');
    
    -- Get sender profile for notifications
    SELECT * INTO v_sender_profile FROM profiles WHERE id = NEW.user_id;
    
    CASE v_federation_type
        WHEN 'chat_local_only' THEN
            -- Send local notifications for chat messages (ONLY to LOCAL users)
            PERFORM send_notification(
                'chat_message',
                ARRAY(
                    SELECT cp.user_id 
                    FROM conversation_participants cp 
                    JOIN profiles p ON p.id = cp.user_id  -- ✅ FIXED: Join with profiles
                    WHERE cp.conversation_id = NEW.conversation_id 
                    AND cp.user_id != NEW.user_id
                    AND cp.left_at IS NULL
                    AND p.is_local = true  -- ✅ FIXED: ONLY local users!
                ),
                -- ✅ STRUCTURED DATA for chat messages
                jsonb_build_object(
                    'sender', jsonb_build_object(
                        'user_id', v_sender_profile.id,
                        'username', v_sender_profile.username,
                        'display_name', v_sender_profile.display_name,
                        'avatar_url', v_sender_profile.avatar_url
                    ),
                    'message', jsonb_build_object(
                        'id', NEW.id,
                        'content_preview', LEFT(NEW.content::text, 100)
                    ),
                    'conversation', jsonb_build_object(
                        'id', NEW.conversation_id
                    ),
                    -- Legacy fields for compatibility
                    'message_id', NEW.id,
                    'sender_username', v_sender_profile.username,
                    'sender_display_name', v_sender_profile.display_name,
                    'conversation_id', NEW.conversation_id,
                    'preview', LEFT(NEW.content::text, 100)
                ),
                NULL, NULL, NEW.conversation_id, NEW.user_id, 'normal'
            );
            
        WHEN 'dm_local_only' THEN
            -- Send DM notifications for local-only DMs (ONLY to LOCAL users)
            PERFORM send_notification(
                'dm',
                ARRAY(
                    SELECT cp.user_id 
                    FROM conversation_participants cp 
                    JOIN profiles p ON p.id = cp.user_id  -- ✅ FIXED: Join with profiles
                    WHERE cp.conversation_id = NEW.conversation_id 
                    AND cp.user_id != NEW.user_id
                    AND cp.left_at IS NULL
                    AND p.is_local = true  -- ✅ FIXED: ONLY local users!
                ),
                -- ✅ STRUCTURED DATA: Match NotificationFormatter expectations
                jsonb_build_object(
                    'sender', jsonb_build_object(
                        'user_id', v_sender_profile.id,
                        'username', v_sender_profile.username,
                        'display_name', v_sender_profile.display_name,
                        'avatar_url', v_sender_profile.avatar_url
                    ),
                    'message', jsonb_build_object(
                        'id', NEW.id,
                        'content_preview', CASE 
                            WHEN jsonb_array_length(NEW.content) > 0 
                            THEN LEFT(NEW.content->0->>'text', 100)
                            ELSE 'New message'
                        END
                    ),
                    'conversation', jsonb_build_object(
                        'id', NEW.conversation_id
                    ),
                    -- Legacy fields for compatibility
                    'message_id', NEW.id,
                    'sender_username', v_sender_profile.username,
                    'sender_display_name', v_sender_profile.display_name,
                    'conversation_id', NEW.conversation_id,
                    'preview', LEFT(NEW.content::text, 100)
                ),
                NULL, NULL, NEW.conversation_id, NEW.user_id, 'normal'
            );
            
        WHEN 'dm_federated' THEN
            -- Send DM notifications for federated DMs (ONLY to LOCAL users)
            PERFORM send_notification(
                'dm',
                ARRAY(
                    SELECT cp.user_id 
                    FROM conversation_participants cp 
                    JOIN profiles p ON p.id = cp.user_id  -- ✅ FIXED: Join with profiles
                    WHERE cp.conversation_id = NEW.conversation_id 
                    AND cp.user_id != NEW.user_id
                    AND cp.left_at IS NULL
                    AND p.is_local = true  -- ✅ FIXED: ONLY local users!
                ),
                -- ✅ STRUCTURED DATA: Match NotificationFormatter expectations
                jsonb_build_object(
                    'sender', jsonb_build_object(
                        'user_id', v_sender_profile.id,
                        'username', v_sender_profile.username,
                        'display_name', v_sender_profile.display_name,
                        'avatar_url', v_sender_profile.avatar_url
                    ),
                    'message', jsonb_build_object(
                        'id', NEW.id,
                        'content_preview', CASE 
                            WHEN jsonb_array_length(NEW.content) > 0 
                            THEN LEFT(NEW.content->0->>'text', 100)
                            ELSE 'New message'
                        END
                    ),
                    'conversation', jsonb_build_object(
                        'id', NEW.conversation_id
                    ),
                    -- Legacy fields for compatibility
                    'message_id', NEW.id,
                    'sender_username', v_sender_profile.username,
                    'sender_display_name', v_sender_profile.display_name,
                    'conversation_id', NEW.conversation_id,
                    'preview', LEFT(NEW.content::text, 100),
                    'federated', true
                ),
                NULL, NULL, NEW.conversation_id, NEW.user_id, 'normal'
            );
    END CASE;
    
    RETURN NEW;
    
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Message federation processing failed for %: %', NEW.id, SQLERRM;
        RETURN NEW;
END;
$$;


--
-- Name: FUNCTION handle_message_federation(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_message_federation() IS 'FIXED: Creates structured notification data that matches NotificationFormatter expectations with nested sender, message, and conversation objects for both DM and chat notifications.';


--
-- Name: handle_outgoing_messages(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_outgoing_messages() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'extensions', 'public', 'pg_temp'
    AS $$
DECLARE
    -- Variables for notifications
    mentioned_usernames TEXT[];
    mentioned_user_id UUID;
    username_item TEXT;
    sender_profile profiles%ROWTYPE;
    channel_info channels%ROWTYPE;
    server_info servers%ROWTYPE;
    conversation_type TEXT;
    
    -- Variables for federation
    v_federation_type TEXT;
    v_instance_domain TEXT;
    v_sender_url TEXT;
    v_recipient_url TEXT;
    v_message_url TEXT;
    v_activity_id TEXT;
    v_html_content TEXT;
    v_attachments JSONB;
    v_tags JSONB;
    v_note_object JSONB;
    v_activity JSONB;
    v_activity_uuid UUID;
    v_recipient_profile RECORD;
    target_domains TEXT[];
BEGIN
    -- Get sender profile
    SELECT * INTO sender_profile FROM profiles WHERE id = NEW.user_id;
    
    -- Determine federation type
    v_federation_type := determine_message_federation_type(NEW.id);
    
    -- Send notifications for federated messages ONLY to LOCAL users
    IF v_federation_type = 'dm_federated' THEN
        -- Notify only LOCAL conversation participants with STRUCTURED data
        PERFORM send_notification(
            'dm',
            ARRAY(
                SELECT DISTINCT cp.user_id 
                FROM conversation_participants cp
                JOIN profiles p ON p.id = cp.user_id
                WHERE cp.conversation_id = NEW.conversation_id 
                  AND cp.user_id != NEW.user_id
                  AND cp.left_at IS NULL
                  AND p.is_local = true  -- ✅ ONLY LOCAL USERS
            ),
            -- ✅ STRUCTURED DATA: Match NotificationFormatter expectations
            jsonb_build_object(
                'sender', jsonb_build_object(
                    'user_id', sender_profile.id,
                    'username', sender_profile.username,
                    'display_name', sender_profile.display_name,
                    'avatar_url', sender_profile.avatar_url
                ),
                'message', jsonb_build_object(
                    'id', NEW.id,
                    'content_preview', CASE 
                        WHEN jsonb_array_length(NEW.content) > 0 
                        THEN LEFT(NEW.content->0->>'text', 100)
                        ELSE 'New message'
                    END
                ),
                'conversation', jsonb_build_object(
                    'id', NEW.conversation_id
                ),
                -- Additional metadata for compatibility
                'message_id', NEW.id,
                'conversation_id', NEW.conversation_id,
                'sender_id', NEW.user_id,
                'federated', true
            ),
            NULL, NULL, NEW.conversation_id, NEW.user_id, 'normal'
        );
    END IF;
    
    -- Handle federation for outgoing messages
    IF NEW.conversation_id IS NOT NULL AND sender_profile.is_local THEN
        -- Get instance domain from config
        SELECT trim(both '"' from config_value::text) INTO v_instance_domain 
        FROM instance_config 
        WHERE config_key = 'domain' 
        LIMIT 1;
        
        IF v_instance_domain IS NOT NULL THEN
            -- Find remote recipients using conversation_participants table
            FOR v_recipient_profile IN 
                SELECT p.id, p.username, p.domain, p.federated_id, p.is_local, p.inbox_url
                FROM conversation_participants cp
                JOIN profiles p ON p.id = cp.user_id
                WHERE cp.conversation_id = NEW.conversation_id 
                  AND cp.user_id != NEW.user_id
                  AND cp.left_at IS NULL
                  AND NOT p.is_local
                  AND p.domain IS NOT NULL
            LOOP
                -- Build URLs using federated_id when available, fallback to constructed URL
                v_sender_url := 'https://' || v_instance_domain || '/users/' || sender_profile.username;
                v_recipient_url := COALESCE(v_recipient_profile.federated_id, 'https://' || v_recipient_profile.domain || '/users/' || v_recipient_profile.username);
                v_message_url := 'https://' || v_instance_domain || '/messages/' || NEW.id::TEXT;
                v_activity_id := v_sender_url || '#dm-' || NEW.id::TEXT;
                
                -- Use modern content processing functions
                v_html_content := convert_jsonb_to_ap(NEW.content);
                v_attachments := extract_activitypub_attachments(NEW.content);
                v_tags := extract_all_activitypub_tags(NEW.content);
                
                -- ✅ CRITICAL FIX 1: Add recipient as mention tag (from working 073-074)
                v_tags := v_tags || jsonb_build_array(
                    jsonb_build_object(
                        'type', 'Mention',
                        'href', v_recipient_url,
                        'name', '@' || v_recipient_profile.username || '@' || v_recipient_profile.domain
                    )
                );
                
                -- Create Note object (DM format)
                v_note_object := jsonb_build_object(
                    'id', v_message_url,
                    'type', 'Note',
                    'attributedTo', v_sender_url,
                    'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                    'content', v_html_content,
                    'contentMap', jsonb_build_object('en', v_html_content),
                    'attachment', COALESCE(v_attachments, '[]'::jsonb),
                    'tag', v_tags,
                    'to', jsonb_build_array(v_recipient_url),  -- Direct addressing
                    'cc', '[]'::jsonb,                         -- Empty CC for DMs
                    'directMessage', true                      -- ✅ CRITICAL FIX 2: Explicit DM flag
                );
                
                -- Create ActivityPub Create activity
                v_activity := jsonb_build_object(
                    '@context', 'https://www.w3.org/ns/activitystreams',
                    'id', v_activity_id,
                    'type', 'Create',
                    'actor', v_sender_url,
                    'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                    'object', v_note_object,
                    'to', jsonb_build_array(v_recipient_url),  -- Direct addressing
                    'cc', '[]'::jsonb                          -- Empty CC for DMs
                );
                
                -- Store the ActivityPub activity record
                INSERT INTO ap_activities (
                    ap_id, ap_type, actor_id, actor_ap_id, object_id, object_type,
                    activity_data, status, to_addresses, is_local, origin_domain
                ) VALUES (
                    v_activity_id, 'Create', sender_profile.id, v_sender_url, v_message_url, 'Note',
                    v_activity, 'pending', ARRAY[v_recipient_url], true, v_instance_domain
                ) RETURNING id INTO v_activity_uuid;
                
                -- Build array of target domains for queue_activity_for_federation
                target_domains := ARRAY[v_recipient_profile.domain];
                
                -- Queue for federation delivery
                PERFORM queue_activity_for_federation(
                    v_activity_uuid,  -- The UUID from ap_activities 
                    target_domains,   -- Array of domains to deliver to
                    8,                -- High priority for DMs (1-10 scale, 8 is high)
                    true              -- Immediate delivery
                );
                
                RAISE NOTICE '📮 Queued DM for federation to: %@% (activity: %)', 
                    v_recipient_profile.username, v_recipient_profile.domain, v_activity_uuid;
                    
            END LOOP;
        END IF;
    END IF;
    
    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Error in handle_outgoing_messages for message %: % %', NEW.id, SQLSTATE, SQLERRM;
        RETURN NEW;
END;
$$;


--
-- Name: FUNCTION handle_outgoing_messages(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_outgoing_messages() IS 'FIXED: Creates structured notification data that matches NotificationFormatter expectations with nested sender, message, and conversation objects.';


--
-- Name: handle_post_interaction_federation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_post_interaction_federation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_activity jsonb;
    v_target_post RECORD;
    v_target_domains text[];
    v_is_undo boolean := false;
    v_interaction_record RECORD;
BEGIN
    -- Only process emoji reactions
    IF COALESCE(NEW.interaction_type, OLD.interaction_type) != 'emoji_reaction' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    
    -- Determine if this is an undo (DELETE) or create (INSERT)
    IF TG_OP = 'DELETE' THEN
        v_is_undo := true;
        v_interaction_record := OLD;
    ELSE
        v_interaction_record := NEW;
    END IF;
    
    -- Get target post info
    SELECT * INTO v_target_post
    FROM posts
    WHERE id = v_interaction_record.post_id;
    
    IF NOT FOUND THEN
        RAISE LOG 'Target post not found for reaction federation: %', v_interaction_record.post_id;
        RETURN COALESCE(NEW, OLD);
    END IF;
    
    -- Only federate reactions on local posts or when we're the actor
    -- (Don't relay reactions on remote posts to avoid loops)
    IF NOT v_target_post.is_local THEN
        RAISE LOG 'Skipping federation for reaction on remote post: %', v_target_post.id;
        RETURN COALESCE(NEW, OLD);
    END IF;
    
    -- Build ActivityPub activity
    BEGIN
        -- Get sender profile details for federation
        DECLARE
            v_sender_profile RECORD;
            v_instance_domain text;
        BEGIN
            -- Get sender profile
            SELECT * INTO v_sender_profile 
            FROM profiles 
            WHERE id = v_interaction_record.user_id AND is_local = true;
            
            IF NOT FOUND THEN
                RAISE LOG 'Sender profile not found for reaction federation: %', v_interaction_record.user_id;
                RETURN COALESCE(NEW, OLD);
            END IF;
            
            -- Get instance domain
            SELECT config_value::text INTO v_instance_domain
            FROM instance_config 
            WHERE config_key = 'domain';
            
            -- Remove JSON quotes if present
            v_instance_domain := trim(both '"' from v_instance_domain);
            
            v_activity := build_emoji_reaction_activity(
                v_interaction_record.id,
                v_interaction_record.user_id,
                v_interaction_record.post_id,
                v_interaction_record.emoji_id,
                v_interaction_record.custom_emoji_content,
                v_is_undo
            );
            
            -- Determine target domains for federation
            -- For now, federate to all known instances that might be interested
            SELECT ARRAY(
                SELECT DISTINCT domain
                FROM profiles 
                WHERE domain IS NOT NULL 
                AND domain != ''
                AND is_local = false
                LIMIT 50  -- Reasonable limit to avoid overwhelming the system
            ) INTO v_target_domains;
            
            -- Add to federation delivery queue (one row per target domain)
            IF array_length(v_target_domains, 1) > 0 THEN
                -- Get sender profile details for actor fields
                DECLARE
                    v_domain_inbox text;
                    v_target_domain text;
                BEGIN
                    FOREACH v_target_domain IN ARRAY v_target_domains LOOP
                        v_domain_inbox := 'https://' || v_target_domain || '/inbox';
                        
                        INSERT INTO federation_delivery_queue (
                            activity_data,
                            target_domain,
                            target_inbox_url,
                            actor_username,
                            actor_domain,
                            status,
                            priority,
                            attempts,
                            next_attempt_at
                        ) VALUES (
                            v_activity,
                            v_target_domain,
                            v_domain_inbox,
                            v_sender_profile.username,
                            v_instance_domain,
                            'pending',
                            5,
                            0,
                            NOW()
                        );
                    END LOOP;
                    
                    RAISE LOG 'Queued emoji reaction federation to % domains', 
                        array_length(v_target_domains, 1);
                END;
            END IF;
        END;
        
    EXCEPTION WHEN OTHERS THEN
        -- Log error but don't block the interaction
        RAISE LOG 'Failed to federate emoji reaction: %', SQLERRM;
    END;
    
    RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: FUNCTION handle_post_interaction_federation(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_post_interaction_federation() IS 'Handles automatic federation of emoji reactions. Triggers on post_interactions INSERT/DELETE for emoji_reaction type.';


--
-- Name: handle_post_reactions_federation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_post_reactions_federation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    user_federation_enabled boolean;
    current_instance_domain text;
    full_instance_url text;  -- NEW: Full URL with protocol
    activity_type text;
    target_object_id text;
    target_actor_id uuid;
    emoji_data record;
    reaction_content text;
    activity_content jsonb;
BEGIN
    -- Get instance domain and build full URL with protocol
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    full_instance_url := 'https://' || current_instance_domain;  -- NEW: Add protocol

    -- Check federation for user
    SELECT is_federation_enabled_for_user(COALESCE(NEW.user_id, OLD.user_id)) INTO user_federation_enabled;
    
    IF NOT user_federation_enabled THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Only federate reactions on post_interactions (not regular reactions table)
    IF TG_OP = 'INSERT' THEN
        activity_type := 'Like';
        target_object_id := (SELECT ap_id FROM posts WHERE id = NEW.post_id);
        target_actor_id := (SELECT author_id FROM posts WHERE id = NEW.post_id);
        
        -- Get emoji data for custom emoji federation
        SELECT name, url INTO emoji_data 
        FROM emojis WHERE id = NEW.emoji_id;
        
        -- Build reaction content
        reaction_content := CASE 
            WHEN emoji_data.name IS NOT NULL THEN ':' || emoji_data.name || ':'
            ELSE '❤️'  -- Default heart emoji
        END;
        
    ELSIF TG_OP = 'DELETE' THEN
        activity_type := 'Undo';
        target_object_id := (SELECT ap_id FROM posts WHERE id = OLD.post_id);
        target_actor_id := (SELECT author_id FROM posts WHERE id = OLD.post_id);
        
        -- For undo, we don't need emoji data
        reaction_content := NULL;
    END IF;

    -- Build activity content
    activity_content := jsonb_build_object(
        'type', activity_type,
        'actor', (SELECT federated_id FROM profiles WHERE id = COALESCE(NEW.user_id, OLD.user_id)),
        'object', target_object_id,
        'content', reaction_content,
        'tag', CASE 
            WHEN emoji_data.name IS NOT NULL AND emoji_data.url IS NOT NULL THEN
                jsonb_build_array(
                    jsonb_build_object(
                        'type', 'Emoji',
                        'name', reaction_content,
                        'icon', jsonb_build_object(
                            'type', 'Image',
                            'url', emoji_data.url
                        ),
                        'id', full_instance_url || '/emojis/' || COALESCE(NEW.emoji_id, OLD.emoji_id)  -- FIXED: Use full URL
                    )
                )
            ELSE '[]'::jsonb
        END
    );

    -- Create ActivityPub activity for federation
    INSERT INTO ap_activities (
        ap_id, ap_type, actor_id, actor_ap_id, object_id, object_type,
        target_id, target_type, activity_data, status, is_local
    ) VALUES (
        full_instance_url || '/activities/' || gen_random_uuid(),  -- FIXED: Use full URL
        activity_type,
        COALESCE(NEW.user_id, OLD.user_id),
        (SELECT federated_id FROM profiles WHERE id = COALESCE(NEW.user_id, OLD.user_id)),
        target_object_id, 'Note', target_actor_id, 'Person',
        activity_content,
        'pending', true
    );

    RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: FUNCTION handle_post_reactions_federation(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_post_reactions_federation() IS 'FIXED: ActivityPub URLs now include https:// protocol. Compatible with Pleroma/Misskey custom emoji federation.';


--
-- Name: handle_profile_update_federation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_profile_update_federation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    profile_changed BOOLEAN := FALSE;
    activity_id UUID;
    profile_actor_url TEXT;
    instance_domain TEXT;
    update_activity JSONB;
    profile_object JSONB;
BEGIN
    -- Only handle updates for local users
    IF TG_OP != 'UPDATE' OR NOT NEW.is_local THEN
        RETURN NEW;
    END IF;

    -- Check if any federation-relevant fields changed
    IF (OLD.username IS DISTINCT FROM NEW.username OR
        OLD.display_name IS DISTINCT FROM NEW.display_name OR
        OLD.bio IS DISTINCT FROM NEW.bio OR
        OLD.color IS DISTINCT FROM NEW.color OR
        OLD.avatar_url IS DISTINCT FROM NEW.avatar_url OR
        OLD.banner_url IS DISTINCT FROM NEW.banner_url OR
        OLD.public_key IS DISTINCT FROM NEW.public_key OR
        OLD.is_suspended IS DISTINCT FROM NEW.is_suspended OR
        OLD.suspended_at IS DISTINCT FROM NEW.suspended_at OR
        OLD.suspension_reason IS DISTINCT FROM NEW.suspension_reason) THEN
        
        profile_changed := TRUE;
    END IF;

    -- If no relevant changes, skip federation
    IF NOT profile_changed THEN
        RETURN NEW;
    END IF;

    -- Get instance domain
    SELECT trim(both '"' from config_value::text) INTO instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;

    -- Build actor URL
    profile_actor_url := 'https://' || instance_domain || '/users/' || NEW.username;

    -- Build the profile object (Person type)
    profile_object := jsonb_build_object(
        '@context', jsonb_build_array(
            'https://www.w3.org/ns/activitystreams',
            'https://w3id.org/security/v1'
        ),
        'id', profile_actor_url,
        'type', 'Person',
        'preferredUsername', NEW.username,
        'name', COALESCE(NEW.display_name, NEW.username),
        'summary', COALESCE(NEW.bio, ''),
        'inbox', 'https://' || instance_domain || '/users/' || NEW.username || '/inbox',
        'outbox', 'https://' || instance_domain || '/users/' || NEW.username || '/outbox',
        'followers', 'https://' || instance_domain || '/users/' || NEW.username || '/followers',
        'following', 'https://' || instance_domain || '/users/' || NEW.username || '/following',
        'featured', 'https://' || instance_domain || '/users/' || NEW.username || '/featured',
        'publicKey', jsonb_build_object(
            'id', profile_actor_url || '#main-key',
            'owner', profile_actor_url,
            'publicKeyPem', NEW.public_key
        )
    );

    -- Add avatar if present
    IF NEW.avatar_url IS NOT NULL THEN
        profile_object := profile_object || jsonb_build_object(
            'icon', jsonb_build_object(
                'type', 'Image',
                'url', NEW.avatar_url
            )
        );
    END IF;

    -- Add banner if present  
    IF NEW.banner_url IS NOT NULL THEN
        profile_object := profile_object || jsonb_build_object(
            'image', jsonb_build_object(
                'type', 'Image', 
                'url', NEW.banner_url
            )
        );
    END IF;

    -- Add suspension info if suspended
    IF NEW.is_suspended THEN
        profile_object := profile_object || jsonb_build_object(
            'suspended', true,
            'suspendedAt', NEW.suspended_at,
            'suspensionReason', NEW.suspension_reason
        );
    END IF;

    -- Build the Update activity
    update_activity := jsonb_build_object(
        '@context', 'https://www.w3.org/ns/activitystreams',
        'id', profile_actor_url || '/activities/update/' || gen_random_uuid(),
        'type', 'Update',
        'actor', profile_actor_url,
        'published', NOW(),
        'object', profile_object,
        'to', jsonb_build_array('https://www.w3.org/ns/activitystreams#Public'),
        'cc', jsonb_build_array('https://' || instance_domain || '/users/' || NEW.username || '/followers')
    );

    -- Create the activity record
    INSERT INTO ap_activities (
        ap_id,
        ap_type,
        actor_ap_id,
        activity_data,
        origin_domain,
        to_addresses,
        cc_addresses,
        is_local,
        status
    ) VALUES (
        update_activity->>'id',
        'Update',
        profile_actor_url,
        update_activity,
        instance_domain,
        ARRAY['https://www.w3.org/ns/activitystreams#Public'],
        ARRAY['https://' || instance_domain || '/users/' || NEW.username || '/followers'],
        true,
        'pending'
    ) RETURNING id INTO activity_id;

    -- Queue the activity for federation delivery directly
    -- Get follower domains to send to
    PERFORM queue_activity_for_federation(
        activity_id,
        ARRAY(
            SELECT DISTINCT domain 
            FROM follows f
            JOIN profiles p ON f.follower_id = p.id
            WHERE f.following_id = NEW.id
            AND f.status = 'accepted'
            AND NOT p.is_local
            AND p.domain IS NOT NULL
        ),
        3, -- Priority 3 (profile updates are important but not urgent)
        true -- Immediate processing
    );

    RAISE NOTICE '📝 Profile update activity created and queued for %: %', NEW.username, activity_id;

    RETURN NEW;
END;
$$;


--
-- Name: FUNCTION handle_profile_update_federation(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_profile_update_federation() IS 'Federates profile updates for local users. Creates Update activities when public profile fields change. Federation delivery is handled by existing queue system.';


--
-- Name: handle_reactions_federation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_reactions_federation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    user_federation_enabled boolean;
    current_instance_domain text;
    full_instance_url text;  -- NEW: Full URL with protocol
    activity_type text;
    target_object_id text;
    target_actor_id uuid;
    emoji_data record;
    reaction_content text;
    activity_content jsonb;
    is_dm_message boolean := false;
BEGIN
    -- Get instance domain and build full URL with protocol
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    full_instance_url := 'https://' || current_instance_domain;  -- NEW: Add protocol

    -- Check federation for user
    SELECT is_federation_enabled_for_user(COALESCE(NEW.user_id, OLD.user_id)) INTO user_federation_enabled;
    
    IF NOT user_federation_enabled THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Check if this is a DM message (has remote participants)
    SELECT EXISTS(
        SELECT 1 FROM messages m
        JOIN conversation_participants cp ON m.conversation_id = cp.conversation_id  
        JOIN profiles p ON cp.user_id = p.id
        WHERE m.id = COALESCE(NEW.message_id, OLD.message_id)
          AND NOT p.is_local
    ) INTO is_dm_message;

    -- Only federate DM reactions, not server chat reactions (local-first design)
    IF NOT is_dm_message THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    IF TG_OP = 'INSERT' THEN
        activity_type := 'Like';  -- FIXED: Use 'Like' instead of 'EmojiReact'
        target_object_id := full_instance_url || '/messages/' || NEW.message_id;  -- FIXED: Use full URL
        
        -- Get message author
        SELECT user_id INTO target_actor_id FROM messages WHERE id = NEW.message_id;
        
        -- Get emoji data for custom emoji federation
        SELECT name, url INTO emoji_data 
        FROM emojis WHERE id = NEW.emoji_id;
        
        -- Build reaction content (Pleroma/Misskey compatible)
        reaction_content := CASE 
            WHEN emoji_data.name IS NOT NULL THEN ':' || emoji_data.name || ':'
            ELSE '❤️'  -- Default heart emoji
        END;
        
    ELSIF TG_OP = 'DELETE' THEN
        activity_type := 'Undo';
        target_object_id := full_instance_url || '/messages/' || OLD.message_id;  -- FIXED: Use full URL
        SELECT user_id INTO target_actor_id FROM messages WHERE id = OLD.message_id;
        reaction_content := NULL;
    END IF;

    -- Build activity content with custom emoji support
    IF activity_type IS NOT NULL AND target_object_id IS NOT NULL THEN
        activity_content := jsonb_build_object(
            'type', activity_type,
            'actor', (SELECT federated_id FROM profiles WHERE id = COALESCE(NEW.user_id, OLD.user_id)),
            'object', target_object_id
        );

        -- Add custom emoji data for federation compatibility
        IF reaction_content IS NOT NULL THEN
            activity_content := activity_content || jsonb_build_object(
                'content', reaction_content,
                'tag', CASE 
                    WHEN emoji_data.name IS NOT NULL AND emoji_data.url IS NOT NULL THEN
                        jsonb_build_array(
                            jsonb_build_object(
                                'type', 'Emoji',
                                'name', reaction_content,
                                'icon', jsonb_build_object(
                                    'type', 'Image',
                                    'url', emoji_data.url
                                ),
                                'id', full_instance_url || '/emojis/' || COALESCE(NEW.emoji_id, OLD.emoji_id)  -- FIXED: Use full URL
                            )
                        )
                    ELSE '[]'::jsonb
                END
            );
        END IF;

        -- Create ActivityPub activity for federation  
        INSERT INTO ap_activities (
            ap_id, ap_type, actor_id, actor_ap_id, object_id, object_type,
            target_id, target_type, activity_data, status, is_local
        ) VALUES (
            full_instance_url || '/activities/' || gen_random_uuid(),  -- FIXED: Use full URL
            activity_type,
            COALESCE(NEW.user_id, OLD.user_id),
            (SELECT federated_id FROM profiles WHERE id = COALESCE(NEW.user_id, OLD.user_id)),
            target_object_id, 
            'Note', 
            target_actor_id, 
            'Person',
            activity_content,
            'pending', 
            true
        );
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: FUNCTION handle_reactions_federation(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_reactions_federation() IS 'FIXED: ActivityPub URLs now include https:// protocol. Only federates DM reactions (local-first design). Uses Like activity type for ActivityPub compliance.';


--
-- Name: handle_unified_interaction_federation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_unified_interaction_federation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    user_federation_enabled boolean;
    target_federation_enabled boolean;
    current_instance_domain text;
    full_instance_url text;  -- NEW: Full URL with protocol
    activity_type text;
    target_object_id text;
    target_actor_id uuid;
    actor_user_id uuid;
BEGIN
    -- Get instance domain and build full URL with protocol
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    full_instance_url := 'https://' || current_instance_domain;  -- NEW: Add protocol

    -- Determine the actor user ID based on table type
    IF TG_TABLE_NAME = 'follows' THEN
        actor_user_id := COALESCE(NEW.follower_id, OLD.follower_id);
    ELSE
        actor_user_id := COALESCE(NEW.user_id, OLD.user_id);
    END IF;

    -- Check federation for actor user
    SELECT is_federation_enabled_for_user(actor_user_id) INTO user_federation_enabled;
    
    IF NOT user_federation_enabled THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Determine activity details based on table and operation
    IF TG_TABLE_NAME = 'follows' THEN
        IF TG_OP = 'INSERT' THEN
            activity_type := 'Follow';
            target_object_id := (SELECT federated_id FROM profiles WHERE id = NEW.following_id);
            target_actor_id := NEW.following_id;
        ELSIF TG_OP = 'DELETE' THEN
            activity_type := 'Undo';
            target_object_id := (SELECT federated_id FROM profiles WHERE id = OLD.following_id);
            target_actor_id := OLD.following_id;
        END IF;

    ELSIF TG_TABLE_NAME = 'post_interactions' THEN
        -- Check federation for interaction user
        SELECT is_federation_enabled_for_user(COALESCE(NEW.user_id, OLD.user_id)) INTO user_federation_enabled;
        
        IF NOT user_federation_enabled THEN
            RETURN COALESCE(NEW, OLD);
        END IF;

        IF TG_OP = 'INSERT' THEN
            activity_type := CASE 
                WHEN NEW.interaction_type = 'favorite' THEN 'Like'
                WHEN NEW.interaction_type = 'reblog' THEN 'Announce' 
                ELSE 'Like'
            END;
            target_object_id := (SELECT ap_id FROM posts WHERE id = NEW.post_id);
            target_actor_id := (SELECT author_id FROM posts WHERE id = NEW.post_id);
        ELSIF TG_OP = 'DELETE' THEN
            activity_type := 'Undo';
            target_object_id := (SELECT ap_id FROM posts WHERE id = OLD.post_id);
            target_actor_id := (SELECT author_id FROM posts WHERE id = OLD.post_id);
        END IF;

    ELSIF TG_TABLE_NAME = 'reactions' THEN
        -- Check federation for reaction user
        SELECT is_federation_enabled_for_user(COALESCE(NEW.user_id, OLD.user_id)) INTO user_federation_enabled;
        
        IF NOT user_federation_enabled THEN
            RETURN COALESCE(NEW, OLD);
        END IF;

        IF TG_OP = 'INSERT' THEN
            activity_type := 'Like';  -- FIXED: Use 'Like' instead of 'EmojiReact'
            target_object_id := (SELECT 'message-' || NEW.message_id);
            -- Get message author
            SELECT user_id INTO target_actor_id FROM messages WHERE id = NEW.message_id;
        ELSIF TG_OP = 'DELETE' THEN
            activity_type := 'Undo';
            target_object_id := (SELECT 'message-' || OLD.message_id);
            SELECT user_id INTO target_actor_id FROM messages WHERE id = OLD.message_id;
        END IF;
    END IF;

    -- Create federation activity if we have the required data
    IF activity_type IS NOT NULL AND target_object_id IS NOT NULL AND actor_user_id IS NOT NULL THEN
        INSERT INTO ap_activities (
            ap_id,
            ap_type,
            actor_id,
            actor_ap_id, 
            object_id,
            object_type,
            target_id,
            target_type,
            activity_data,
            status,
            is_local
        ) VALUES (
            full_instance_url || '/activities/' || gen_random_uuid(),  -- FIXED: Use full URL
            activity_type,
            actor_user_id,
            (SELECT federated_id FROM profiles WHERE id = actor_user_id),
            target_object_id,
            CASE 
                WHEN TG_TABLE_NAME = 'follows' THEN 'Person'
                WHEN TG_TABLE_NAME = 'post_interactions' THEN 'Note'
                WHEN TG_TABLE_NAME = 'reactions' THEN 'Note'
                ELSE 'Object'
            END,
            target_actor_id,
            'Person',
            jsonb_build_object(
                'type', activity_type,
                'actor', (SELECT federated_id FROM profiles WHERE id = actor_user_id),
                'object', target_object_id
            ),
            'pending',
            true
        );
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: FUNCTION handle_unified_interaction_federation(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_unified_interaction_federation() IS 'FIXED: ActivityPub URLs now include https:// protocol. Uses Like instead of EmojiReact for reactions.';


--
-- Name: handle_unified_notification_processing(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_unified_notification_processing() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    notification_data jsonb;
    target_user_id uuid;
    mentioned_users uuid[];
    server_members uuid[];
    followers uuid[];
    single_target_id uuid;
    target_user_ids uuid[];
    -- CRITICAL: Use explicit variable names to avoid ANY ambiguity
    msg_channel_id uuid;
    msg_server_id uuid;
BEGIN
    -- Early exit for non-notification operations
    IF TG_OP = 'UPDATE' THEN
        RETURN NEW;
    END IF;

    -- Handle different table operations
    IF TG_TABLE_NAME = 'mentions' AND TG_OP = 'INSERT' THEN
        -- Handle mention notifications
        notification_data := jsonb_build_object(
            'type', 'mention',
            'message_id', NEW.message_id,
            'mentioned_by', NEW.mentioned_by
        );
        
        PERFORM send_notification_to_user(
            'mention',
            NEW.mentioned_user,
            notification_data,
            (SELECT s.id FROM messages m JOIN channels c ON m.channel_id = c.id JOIN servers s ON c.server_id = s.id WHERE m.id = NEW.message_id),
            (SELECT m.channel_id FROM messages m WHERE m.id = NEW.message_id),
            NULL,
            NEW.mentioned_by,
            'normal'
        );

    ELSIF TG_TABLE_NAME = 'follows' AND TG_OP = 'INSERT' THEN
        -- Handle follow notifications
        notification_data := jsonb_build_object(
            'type', 'follow',
            'follower_id', NEW.follower_id
        );
        
        PERFORM send_notification_to_user(
            'follow',
            NEW.following_id,
            notification_data,
            NULL,
            NULL,
            NULL,
            NEW.follower_id,
            'normal'
        );

    ELSIF TG_TABLE_NAME = 'reactions' AND TG_OP = 'INSERT' THEN
        -- Handle reaction notifications
        SELECT user_id INTO single_target_id FROM messages WHERE id = NEW.message_id;
        
        IF single_target_id IS NOT NULL AND single_target_id != NEW.user_id THEN
            -- CRITICAL FIX: Use explicit variables to eliminate ANY channel_id ambiguity
            SELECT m.channel_id, c.server_id 
            INTO msg_channel_id, msg_server_id
            FROM messages m 
            LEFT JOIN channels c ON m.channel_id = c.id 
            WHERE m.id = NEW.message_id;
            
            notification_data := jsonb_build_object(
                'type', 'reaction',
                'message_id', NEW.message_id,
                'emoji_id', NEW.emoji_id,
                'user_id', NEW.user_id
            );
            
            -- CRITICAL FIX: Use explicit variable names instead of ambiguous references
            PERFORM send_notification_to_user(
                'reaction',
                single_target_id,
                notification_data,
                msg_server_id,  -- EXPLICIT: No ambiguity
                msg_channel_id, -- EXPLICIT: No ambiguity
                NULL,
                NEW.user_id,
                'normal'
            );
        END IF;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: FUNCTION handle_unified_notification_processing(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_unified_notification_processing() IS 'FINAL FIX: No ambiguous column references. All channel_id references use explicit variables.';


--
-- Name: handle_unified_profile_federation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_unified_profile_federation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    user_federation_enabled boolean;
    current_instance_domain text;
    should_federate boolean := false;
BEGIN
    -- Only process UPDATE operations
    IF TG_OP != 'UPDATE' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Check if federation is enabled for this user
    SELECT is_federation_enabled_for_user(NEW.id) INTO user_federation_enabled;
    
    IF NOT user_federation_enabled THEN
        RETURN NEW;
    END IF;

    -- Check if any federable fields changed
    should_federate := (
        OLD.display_name IS DISTINCT FROM NEW.display_name OR
        OLD.bio IS DISTINCT FROM NEW.bio OR
        OLD.avatar_url IS DISTINCT FROM NEW.avatar_url OR
        OLD.banner_url IS DISTINCT FROM NEW.banner_url
    );

    IF should_federate THEN
        -- Get instance domain
        SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
        FROM instance_config WHERE config_key = 'domain' LIMIT 1;

        -- Create Update activity for profile changes
        INSERT INTO ap_activities (
            ap_id,
            ap_type,
            actor_id,
            actor_ap_id,
            object_id,
            object_type,
            activity_data,
            status,
            is_local
        ) VALUES (
            current_instance_domain || '/activities/' || gen_random_uuid(),
            'Update',
            NEW.id,
            NEW.federated_id,
            NEW.federated_id,
            'Person',
            jsonb_build_object(
                'type', 'Update',
                'actor', NEW.federated_id,
                'object', jsonb_build_object(
                    'type', 'Person',
                    'id', NEW.federated_id,
                    'name', NEW.display_name,
                    'summary', NEW.bio,
                    'icon', CASE WHEN NEW.avatar_url IS NOT NULL THEN 
                        jsonb_build_object('type', 'Image', 'url', NEW.avatar_url)
                        ELSE NULL END,
                    'image', CASE WHEN NEW.banner_url IS NOT NULL THEN
                        jsonb_build_object('type', 'Image', 'url', NEW.banner_url) 
                        ELSE NULL END
                )
            ),
            'pending',
            true
        );
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: FUNCTION handle_unified_profile_federation(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_unified_profile_federation() IS 'OUTGOING ONLY: Unified trigger for federating local profile updates to remote instances. Not bidirectional.';


--
-- Name: insert_ap_activity_safe(text, text, text, jsonb, text, text[], text[], boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.insert_ap_activity_safe(p_ap_id text, p_ap_type text, p_actor_ap_id text, p_activity_data jsonb, p_origin_domain text DEFAULT NULL::text, p_to_addresses text[] DEFAULT '{}'::text[], p_cc_addresses text[] DEFAULT '{}'::text[], p_is_local boolean DEFAULT false) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    result_record RECORD;
BEGIN
    SELECT * INTO result_record 
    FROM upsert_ap_activity(
        p_ap_id,
        p_ap_type,
        p_actor_ap_id,
        p_activity_data,
        p_origin_domain,
        p_to_addresses,
        p_cc_addresses,
        '{}', -- bto_addresses
        '{}', -- bcc_addresses
        p_is_local
    );
    
    RETURN result_record.activity_id;
END;
$$;


--
-- Name: FUNCTION insert_ap_activity_safe(p_ap_id text, p_ap_type text, p_actor_ap_id text, p_activity_data jsonb, p_origin_domain text, p_to_addresses text[], p_cc_addresses text[], p_is_local boolean); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.insert_ap_activity_safe(p_ap_id text, p_ap_type text, p_actor_ap_id text, p_activity_data jsonb, p_origin_domain text, p_to_addresses text[], p_cc_addresses text[], p_is_local boolean) IS 'Simplified wrapper for upsert_ap_activity that returns just the activity ID.';


--
-- Name: is_activitypub_direct_message(jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_activitypub_direct_message(object_data jsonb, instance_domain text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    v_to JSONB;
    v_cc JSONB;
    v_visibility TEXT;
    v_has_public BOOLEAN := false;
    v_has_followers BOOLEAN := false;
    v_has_local_recipients BOOLEAN := false;
    v_recipient TEXT;
    v_total_recipients INTEGER := 0;
BEGIN
    -- Method 1: Check visibility property
    v_visibility := object_data->>'visibility';
    IF v_visibility = 'direct' THEN
        RETURN true;
    END IF;

    -- Method 2: Check directMessage flag
    IF (object_data->>'directMessage')::boolean = true THEN
        RETURN true;
    END IF;

    -- Method 3: Check addressing patterns
    v_to := COALESCE(object_data->'to', '[]'::jsonb);
    v_cc := COALESCE(object_data->'cc', '[]'::jsonb);

    -- Count total recipients and check for public indicators
    FOR v_recipient IN 
        SELECT jsonb_array_elements_text(v_to || v_cc)
    LOOP
        v_total_recipients := v_total_recipients + 1;
        
        -- Check for public addressing
        IF v_recipient IN (
            'https://www.w3.org/ns/activitystreams#Public',
            'Public'
        ) THEN
            v_has_public := true;
            EXIT; -- If it's public, it's definitely not a DM
        END IF;
        
        -- Check for followers addressing
        IF v_recipient LIKE '%/followers' THEN
            v_has_followers := true;
        END IF;
        
        -- Check for local recipients (this instance)
        IF v_recipient LIKE 'https://' || instance_domain || '/users/%' 
           OR v_recipient LIKE 'https://' || instance_domain || '/social/profile/%' THEN
            v_has_local_recipients := true;
        END IF;
    END LOOP;

    -- ENHANCED: More aggressive DM detection
    -- It's a DM if:
    -- 1. No public addressing AND
    -- 2. No followers addressing AND  
    -- 3. Has local recipients AND
    -- 4. Total recipients is small (≤ 10 for group DMs) AND
    -- 5. CC is empty or very small (private mentions typically have empty CC)
    
    IF NOT v_has_public 
       AND NOT v_has_followers 
       AND v_has_local_recipients 
       AND v_total_recipients <= 10
       AND jsonb_array_length(v_cc) <= 1 THEN
        RETURN true;
    END IF;

    -- ADDITIONAL: If 'to' field is small and CC is empty, it's likely a DM
    IF v_total_recipients <= 3 
       AND jsonb_array_length(v_cc) = 0 
       AND v_has_local_recipients THEN
        RETURN true;
    END IF;

    RETURN false;
END;
$$;


--
-- Name: FUNCTION is_activitypub_direct_message(object_data jsonb, instance_domain text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.is_activitypub_direct_message(object_data jsonb, instance_domain text) IS 'ENHANCED: Improved ActivityPub DM detection with better heuristics for recognizing direct messages vs public posts.';


--
-- Name: is_emoji_reaction_activity(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_emoji_reaction_activity(p_activity jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
    -- Direct EmojiReact activity
    IF p_activity->>'type' = 'EmojiReact' THEN
        RETURN true;
    END IF;
    
    -- Like activity with emoji content (Misskey style)
    IF p_activity->>'type' = 'Like' AND (
        p_activity->>'content' IS NOT NULL OR
        p_activity->>'_misskey_reaction' IS NOT NULL
    ) THEN
        RETURN true;
    END IF;
    
    -- Undo of emoji reaction
    IF p_activity->>'type' = 'Undo' AND 
       p_activity->'object'->>'type' IN ('EmojiReact', 'Like') AND (
        p_activity->'object'->>'content' IS NOT NULL OR
        p_activity->'object'->>'_misskey_reaction' IS NOT NULL
    ) THEN
        RETURN true;
    END IF;
    
    RETURN false;
END;
$$;


--
-- Name: FUNCTION is_emoji_reaction_activity(p_activity jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.is_emoji_reaction_activity(p_activity jsonb) IS 'Checks if an ActivityPub activity is an emoji reaction (EmojiReact, Like with emoji content, or Undo thereof).';


--
-- Name: is_federation_enabled_for_user(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_federation_enabled_for_user(user_id uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    instance_enabled boolean := true;
    user_enabled boolean := true;
BEGIN
    -- Check instance-level federation setting
    SELECT COALESCE((config_value->>'federation_enabled')::boolean, true) 
    INTO instance_enabled
    FROM instance_config 
    WHERE config_key = 'federation_settings'
    LIMIT 1;
    
    -- If no federation_settings config exists, federation is enabled by default
    IF instance_enabled IS NULL THEN
        instance_enabled := true;
    END IF;
    
    -- Check user-level federation setting
    SELECT COALESCE(federation_enabled, true)
    INTO user_enabled
    FROM profiles 
    WHERE id = user_id;
    
    RETURN instance_enabled AND user_enabled;
END;
$$;


--
-- Name: FUNCTION is_federation_enabled_for_user(user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.is_federation_enabled_for_user(user_id uuid) IS 'Checks if federation is enabled both at instance and user level for the given user.';


--
-- Name: is_local_user(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_local_user(p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT is_local
  FROM profiles
  WHERE id = p_user_id;
$$;


--
-- Name: FUNCTION is_local_user(p_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.is_local_user(p_user_id uuid) IS 'Check if user is local to this instance';


--
-- Name: is_user_in_conversation(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_user_in_conversation(user_uuid uuid, conversation_uuid uuid) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT EXISTS(
    SELECT 1 FROM conversation_participants 
    WHERE user_id = user_uuid 
      AND conversation_id = conversation_uuid 
      AND left_at IS NULL
  );
$$;


--
-- Name: log_activity_processing_event(uuid, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_activity_processing_event(p_activity_id uuid, p_ap_id text, p_ap_type text, p_status text, p_error_message text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    INSERT INTO activity_processing_logs (activity_id, ap_id, ap_type, status, error_message, created_at, updated_at)
    VALUES (p_activity_id, p_ap_id, p_ap_type, p_status, p_error_message, NOW(), NOW())
    ON CONFLICT (activity_id) DO UPDATE 
    SET status = EXCLUDED.status,
        attempts = activity_processing_logs.attempts + 1,
        error_message = EXCLUDED.error_message,
        updated_at = NOW(),
        processed_at = CASE WHEN EXCLUDED.status = 'processed' THEN NOW() ELSE activity_processing_logs.processed_at END;
END;
$$;


--
-- Name: log_admin_action(uuid, text, text, text, jsonb, inet, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_admin_action(p_admin_id uuid, p_action_type text, p_target_type text DEFAULT NULL::text, p_target_id text DEFAULT NULL::text, p_action_details jsonb DEFAULT NULL::jsonb, p_ip_address inet DEFAULT NULL::inet, p_user_agent text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    log_id UUID;
BEGIN
    INSERT INTO admin_audit_log (
        admin_id,
        action_type,
        target_type,
        target_id,
        action_details,
        ip_address,
        user_agent
    ) VALUES (
        p_admin_id,
        p_action_type,
        p_target_type,
        p_target_id,
        p_action_details,
        p_ip_address,
        p_user_agent
    ) RETURNING id INTO log_id;
    
    RETURN log_id;
END;
$$;


--
-- Name: mark_notifications_read(uuid, uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_notifications_read(p_user_id uuid, p_notification_ids uuid[] DEFAULT NULL::uuid[]) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    updated_count integer;
BEGIN
    IF p_notification_ids IS NULL THEN
        -- Mark all unread notifications as read
        UPDATE notifications 
        SET read_at = now(), is_read = true, updated_at = now()
        WHERE user_id = p_user_id 
        AND is_read = FALSE;
    ELSE
        -- Mark specific notifications as read
        UPDATE notifications 
        SET read_at = now(), is_read = true, updated_at = now()
        WHERE user_id = p_user_id 
        AND id = ANY(p_notification_ids)
        AND is_read = FALSE;
    END IF;
    
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
END;
$$;


--
-- Name: FUNCTION mark_notifications_read(p_user_id uuid, p_notification_ids uuid[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.mark_notifications_read(p_user_id uuid, p_notification_ids uuid[]) IS 'Mark notifications as read. If no notification IDs provided, marks all unread notifications as read.';


--
-- Name: moderate_user(uuid, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.moderate_user(p_admin_id uuid, p_target_user_id uuid, p_action text, p_reason text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    target_username TEXT;
BEGIN
    -- Check if admin has permission
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_admin_id AND is_admin = TRUE) THEN
        RAISE EXCEPTION 'Insufficient permissions';
    END IF;
    
    -- Get target username for logging
    SELECT username INTO target_username FROM profiles WHERE id = p_target_user_id;
    
    IF p_action = 'suspend' THEN
        UPDATE profiles 
        SET 
            is_suspended = TRUE,
            suspended_at = NOW(),
            suspension_reason = p_reason
        WHERE id = p_target_user_id;
        
        -- Log the action
        PERFORM log_admin_action(
            p_admin_id,
            'user_suspend',
            'user',
            p_target_user_id::TEXT,
            json_build_object('reason', p_reason, 'username', target_username)
        );
        
    ELSIF p_action = 'unsuspend' THEN
        UPDATE profiles 
        SET 
            is_suspended = FALSE,
            suspended_at = NULL,
            suspension_reason = NULL
        WHERE id = p_target_user_id;
        
        -- Log the action
        PERFORM log_admin_action(
            p_admin_id,
            'user_unsuspend',
            'user',
            p_target_user_id::TEXT,
            json_build_object('username', target_username)
        );
    ELSE
        RAISE EXCEPTION 'Invalid action: %', p_action;
    END IF;
    
    RETURN TRUE;
END;
$$;


--
-- Name: notify_federation_event(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_federation_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- PostgreSQL NOTIFY for federation backend to listen
  -- Event type passed via TG_ARGV[0]
  PERFORM pg_notify('federation_events', json_build_object(
    'event', TG_ARGV[0],  -- Event type from trigger definition
    'table', TG_TABLE_NAME,
    'id', NEW.id,
    'data', row_to_json(NEW)
  )::text);
  
  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION notify_federation_event(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.notify_federation_event() IS 'Notify federation backend of events that need federation (posts, follows, reactions)';


--
-- Name: pause_activitypub_cron_jobs(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pause_activitypub_cron_jobs() RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    job_names TEXT[] := ARRAY[
        'activitypub-retry-processor',
        'activitypub-cleanup-old-activities',
        'activitypub-daily-stats'
    ];
    job_name TEXT;
    result TEXT := '';
BEGIN
    FOREACH job_name IN ARRAY job_names LOOP
        BEGIN
            PERFORM cron.unschedule(job_name);
            result := result || 'Paused: ' || job_name || E'\n';
        EXCEPTION WHEN OTHERS THEN
            result := result || 'Failed to pause: ' || job_name || ' (' || SQLERRM || ')' || E'\n';
        END;
    END LOOP;
    RETURN result;
END;
$$;


--
-- Name: process_accept_activity(uuid, jsonb, record); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_accept_activity(activity_id uuid, activity_data jsonb, actor_profile record) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'extensions', 'public', 'pg_temp'
    AS $$
DECLARE
    v_object JSONB;
    v_follow_record RECORD;
    v_following_profile RECORD;
    v_instance_domain TEXT;
    v_accept_id TEXT;
    v_accept_activity JSONB;
    v_activity_uuid UUID;
    v_inbox_url TEXT;
    v_signature_header TEXT;
    v_date_header TEXT;
    v_digest_header TEXT;
    v_http_status INTEGER;
    v_http_response TEXT;
    v_delivery_success BOOLEAN;
BEGIN
    RAISE NOTICE '📩 Processing Accept activity: %', activity_data->>'id';
    
    v_object := activity_data->'object';
    
    -- Only process Follow objects in Accept activities
    IF v_object->>'type' != 'Follow' THEN
        RAISE WARNING 'Accept activity does not contain a Follow object: %', v_object->>'type';
        RETURN;
    END IF;
    
    -- Find the follow record this Accept is responding to
    SELECT * INTO v_follow_record
    FROM follows 
    WHERE ap_id = v_object->>'id';
    
    IF NOT FOUND THEN
        RAISE WARNING 'Follow record not found for Accept activity: %', v_object->>'id';
        RETURN;
    END IF;
    
    -- Update the follow status to accepted
    UPDATE follows 
    SET status = 'accepted',
        updated_at = NOW()
    WHERE id = v_follow_record.id;
    
    RAISE NOTICE '✅ Follow request accepted: % -> %', 
        actor_profile.username, v_follow_record.following_id;
        
    -- NOTE: Accept activities are typically responses to our outgoing Follow requests
    -- They don't need to be federated back out - we just need to process them locally
    -- The federation delivery would have already happened when the remote server sent this Accept to us
    
END;
$$;


--
-- Name: FUNCTION process_accept_activity(activity_id uuid, activity_data jsonb, actor_profile record); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.process_accept_activity(activity_id uuid, activity_data jsonb, actor_profile record) IS 'Processes incoming Accept activities for Follow requests. Updates local follow status to accepted.';


--
-- Name: process_activitypub_note(jsonb, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_activitypub_note(note_data jsonb, actor_profile_id uuid DEFAULT NULL::uuid, instance_domain text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $_$
DECLARE
    v_conversation_id uuid;
    v_local_user RECORD;
    v_username text;
    actor_profile profiles%ROWTYPE;
    v_message_id uuid;
    v_content_jsonb jsonb;
    v_to_array jsonb;
    v_recipient text;
BEGIN
    -- Get actor profile
    IF actor_profile_id IS NOT NULL THEN
        SELECT * INTO actor_profile FROM profiles WHERE id = actor_profile_id;
    END IF;
    
    -- Extract recipients from 'to' field
    v_to_array := note_data->'to';
    
    -- Process each recipient
    IF jsonb_typeof(v_to_array) = 'array' THEN
        FOR v_recipient IN SELECT jsonb_array_elements_text(v_to_array)
        LOOP
            -- Skip public addressing
            IF v_recipient = 'https://www.w3.org/ns/activitystreams#Public' THEN
                CONTINUE;
            END IF;
            
            -- Extract username from recipient URL for local users
            IF v_recipient LIKE 'https://' || COALESCE(instance_domain, '') || '/users/%' THEN
                v_username := substring(v_recipient from 'https://[^/]+/users/(.+)$');
                
                -- Find local user
                SELECT * INTO v_local_user 
                FROM profiles 
                WHERE username = v_username AND is_local = true;
                
                IF NOT FOUND THEN
                    RAISE WARNING 'Local user not found: %@%', v_username, instance_domain;
                    CONTINUE;
                END IF;

                RAISE NOTICE '📨 Processing DM for local user: %', v_username;

                -- UPDATED: Find or create conversation using participant system
                SELECT c.id INTO v_conversation_id
                FROM conversations c
                WHERE c.type = 'direct'
                  AND EXISTS (
                    SELECT 1 FROM conversation_participants cp1
                    WHERE cp1.conversation_id = c.id 
                      AND cp1.user_id = actor_profile.id 
                      AND cp1.left_at IS NULL
                  )
                  AND EXISTS (
                    SELECT 1 FROM conversation_participants cp2
                    WHERE cp2.conversation_id = c.id 
                      AND cp2.user_id = v_local_user.id 
                      AND cp2.left_at IS NULL
                  )
                  AND (
                    SELECT COUNT(*) FROM conversation_participants cp3
                    WHERE cp3.conversation_id = c.id 
                      AND cp3.left_at IS NULL
                  ) = 2;

                IF v_conversation_id IS NULL THEN
                    -- UPDATED: Create new conversation using new structure
                    INSERT INTO conversations (type, created_by, is_active)
                    VALUES ('direct', actor_profile.id, TRUE)
                    RETURNING id INTO v_conversation_id;
                    
                    -- Add both participants
                    INSERT INTO conversation_participants (conversation_id, user_id, role, joined_at)
                    VALUES 
                      (v_conversation_id, actor_profile.id, 'member', NOW()),
                      (v_conversation_id, v_local_user.id, 'member', NOW());
                    
                    RAISE NOTICE '🆕 Created new conversation: %', v_conversation_id;
                ELSE
                    RAISE NOTICE '📝 Found existing conversation: %', v_conversation_id;
                END IF;
                
                -- Convert content and create message
                v_content_jsonb := convert_ap_to_jsonb(
                    COALESCE(note_data->>'content', ''), 
                    note_data->'tag'
                );
                
                -- Create the federated message
                INSERT INTO messages (
                    conversation_id,
                    user_id,
                    content,
                    created_at,
                    metadata
                ) VALUES (
                    v_conversation_id,
                    actor_profile.id,
                    v_content_jsonb,
                    COALESCE((note_data->>'published')::timestamptz, NOW()),
                    jsonb_build_object(
                        'activitypub_id', note_data->>'id',
                        'federated', true,
                        'source', 'activitypub'
                    )
                ) RETURNING id INTO v_message_id;
                
                RAISE NOTICE '✅ Created federated DM message: %', v_message_id;
            END IF;
        END LOOP;
    END IF;
    
    RETURN TRUE;
END;
$_$;


--
-- Name: FUNCTION process_activitypub_note(note_data jsonb, actor_profile_id uuid, instance_domain text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.process_activitypub_note(note_data jsonb, actor_profile_id uuid, instance_domain text) IS 'UPDATED: Processes ActivityPub Note objects for DMs using conversation_participants system instead of user1/user2 columns.';


--
-- Name: process_activitypub_public_post(uuid, jsonb, record, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_activitypub_public_post(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_object JSONB;
    v_content JSONB;
    v_post_id UUID;
    v_visibility TEXT := 'public';
    v_in_reply_to TEXT;
    v_parent_post_id UUID;
    v_mentioned_users TEXT[];
    v_local_user_id UUID;
    v_username TEXT;
BEGIN
    v_object := activity_data->'object';
    
    -- Convert ActivityPub HTML content to our JSONB format
    v_content := parse_activitypub_content_to_jsonb(
        v_object->>'content', 
        v_object->'tag'
    );
    
    -- Determine visibility
    IF v_object ? 'to' THEN
        IF jsonb_array_length(COALESCE(v_object->'to', '[]'::jsonb)) = 0 
           OR (v_object->'to' @> '"https://www.w3.org/ns/activitystreams#Public"'::jsonb) THEN
            v_visibility := 'public';
        ELSE
            v_visibility := 'unlisted';
        END IF;
    END IF;
    
    -- Handle replies
    v_in_reply_to := v_object->>'inReplyTo';
    IF v_in_reply_to IS NOT NULL THEN
        SELECT id INTO v_parent_post_id
        FROM posts 
        WHERE ap_id = v_in_reply_to;
    END IF;
    
    -- Create the post
    INSERT INTO posts (
        author_id,
        content,
        visibility,
        in_reply_to,
        is_local,
        is_federated,
        ap_id,
        ap_type,
        content_warning,
        is_sensitive,
        url,
        created_at,
        metadata
    ) VALUES (
        actor_profile.id,
        v_content,
        v_visibility,
        v_parent_post_id,
        false,
        true,
        v_object->>'id',
        'Note',
        v_object->>'summary',
        COALESCE((v_object->>'sensitive')::boolean, false),
        COALESCE(v_object->>'url', v_object->>'id'),
        COALESCE((v_object->>'published')::timestamptz, NOW()),
        jsonb_build_object(
            'federated', true,
            'from_domain', actor_profile.domain,
            'original_activity', activity_data->>'id'
        )
    ) RETURNING id INTO v_post_id;
    
    RAISE NOTICE '📢 Stored federated post from %@%: %', 
        actor_profile.username, actor_profile.domain, v_object->>'id';
    
    -- ✅ FIX: Handle mentions - create notifications for local users
    SELECT ARRAY_AGG(username) INTO v_mentioned_users
    FROM (
        SELECT DISTINCT substring(tag->>'href' from 'https://' || instance_domain || '/users/([^/]+)')::text as username
        FROM jsonb_array_elements(COALESCE(v_object->'tag', '[]'::jsonb)) as tag
        WHERE tag->>'type' = 'Mention' 
          AND tag->>'href' LIKE 'https://' || instance_domain || '/users/%'
    ) t 
    WHERE username IS NOT NULL;
    
    RAISE NOTICE '📋 Extracted mentioned usernames: %', v_mentioned_users;
    
    IF v_mentioned_users IS NOT NULL THEN
        FOREACH v_username IN ARRAY v_mentioned_users LOOP
            RAISE NOTICE '🔍 Looking for local user: %', v_username;
            
            -- ✅ FIX: Remove domain check for local users (domain = NULL for local users!)
            SELECT id INTO v_local_user_id
            FROM profiles 
            WHERE username = v_username 
              AND is_local = true;  -- FIXED: No domain check!
            
            IF FOUND THEN
                RAISE NOTICE '✅ Found local user: % (ID: %)', v_username, v_local_user_id;
                
                -- Create mention notification
                PERFORM create_simple_activitypub_notification(
                    v_local_user_id,
                    'mention',  -- Fixed: Remove 'activitypub_' prefix (function adds it)
                    jsonb_build_object(
                        'author', jsonb_build_object(
                            'id', actor_profile.id,
                            'username', actor_profile.username,
                            'display_name', actor_profile.display_name,
                            'avatar_url', actor_profile.avatar_url,
                            'domain', actor_profile.domain
                        ),
                        'post', jsonb_build_object(
                            'id', v_post_id,
                            'content', v_content,
                            'ap_id', v_object->>'id'
                        )
                    )
                );
                
                RAISE NOTICE '🔔 Created mention notification for %', v_username;
            ELSE
                RAISE NOTICE '❌ Local user NOT FOUND: %', v_username;
                
                -- Debug: Show available local users
                RAISE NOTICE '📋 Available local users: %', (
                    SELECT string_agg(username, ', ') 
                    FROM profiles 
                    WHERE is_local = true
                );
            END IF;
        END LOOP;
    END IF;
    
    -- Note: Other notifications (replies, etc.) are handled by existing post triggers
END;
$$;


--
-- Name: FUNCTION process_activitypub_public_post(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.process_activitypub_public_post(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text) IS 'FIXED: Remove domain check for local users in mention lookup - local users have domain = NULL';


--
-- Name: process_announce_activity(uuid, jsonb, record); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_announce_activity(activity_id uuid, activity_data jsonb, actor_profile record) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_object_id TEXT;
    v_post_record RECORD;
    v_ap_id TEXT;
BEGIN
    v_object_id := activity_data->>'object';
    v_ap_id := activity_data->>'id';

    -- Find the post being announced
    SELECT * INTO v_post_record
    FROM posts 
    WHERE ap_id = v_object_id;

    IF FOUND THEN
        -- Create the reblog interaction
        INSERT INTO post_interactions (
            user_id,
            post_id,
            interaction_type,
            ap_id,
            is_local,
            created_at
        ) VALUES (
            actor_profile.id,
            v_post_record.id,
            'reblog',
            v_ap_id,
            false,
            NOW()
        ) ON CONFLICT (user_id, post_id, interaction_type) DO NOTHING;
        
        RAISE NOTICE '🔄 Post announced: % by %', v_object_id, actor_profile.username;
    END IF;
END;
$$;


--
-- Name: process_ap_activity_on_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_ap_activity_on_update() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_instance_domain TEXT;
    v_classification TEXT;
    v_actor_profile_id UUID;
BEGIN
    -- Only process when status changes to 'processing'
    IF NEW.status != 'processing' OR OLD.status = 'processing' THEN
        RETURN NEW;
    END IF;
    
    -- Get instance domain
    SELECT trim(both '"' from config_value::text) INTO v_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    IF v_instance_domain IS NULL THEN
        RAISE WARNING 'No instance domain configured, skipping activity processing';
        RETURN NEW;
    END IF;
    
    -- Try to find actor profile (optional)
    SELECT actor_id INTO v_actor_profile_id FROM ap_activities WHERE id = NEW.id;
    
    -- Classify the activity
    v_classification := classify_activitypub_activity(NEW.activity_data, v_instance_domain);
    
    -- Route based on classification
    CASE v_classification
        WHEN 'private_mention' THEN
            -- Process as incoming private message/DM
            IF v_actor_profile_id IS NOT NULL THEN
                PERFORM process_incoming_private_message(
                    NEW.id,
                    NEW.activity_data,
                    v_actor_profile_id,
                    v_instance_domain
                );
            ELSE
                RAISE WARNING 'Actor profile not found for private mention activity %', NEW.id;
            END IF;
            
        WHEN 'public_post' THEN
            -- Process as public post (existing function)
            IF v_actor_profile_id IS NOT NULL THEN
                PERFORM process_activitypub_public_post(
                    NEW.id,
                    NEW.activity_data,
                    (SELECT ROW(id, username, display_name, domain, federated_id, is_local, avatar_url, bio, created_at, updated_at) 
                     FROM profiles WHERE id = v_actor_profile_id),
                    v_instance_domain
                );
            ELSE
                RAISE WARNING 'Actor profile not found for public post activity %', NEW.id;
            END IF;
            
        ELSE
            RAISE WARNING 'Unknown activity classification: % for activity %', v_classification, NEW.id;
    END CASE;
    
    -- Mark as completed
    UPDATE ap_activities SET status = 'completed', processed_at = NOW() WHERE id = NEW.id;
    
    RETURN NEW;
    
EXCEPTION
    WHEN OTHERS THEN
        -- Mark as failed and log error
        UPDATE ap_activities SET 
            status = 'failed', 
            error_message = SQLERRM,
            processed_at = NOW()
        WHERE id = NEW.id;
        
        RAISE WARNING 'Failed to process ActivityPub activity %: %', NEW.id, SQLERRM;
        RETURN NEW;
END;
$$;


--
-- Name: process_create_activity(uuid, jsonb, record, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_create_activity(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_object JSONB;
    v_object_type TEXT;
    v_is_dm BOOLEAN;
BEGIN
    v_object := activity_data->'object';
    v_object_type := v_object->>'type';

    IF v_object_type != 'Note' THEN
        RAISE WARNING 'Create activity object is not a Note: %', v_object_type;
        RETURN;
    END IF;

    -- Check if this is a direct message
    v_is_dm := is_activitypub_direct_message(v_object, instance_domain);

    IF v_is_dm THEN
        RAISE NOTICE '📩 Processing as direct message';
        PERFORM handle_incoming_messages(activity_id, activity_data, actor_profile, instance_domain);
    ELSE
        RAISE NOTICE '📢 Processing as public post';
        PERFORM process_activitypub_public_post(activity_id, activity_data, actor_profile, instance_domain);
    END IF;
END;
$$;


--
-- Name: process_delete_activity(uuid, jsonb, record); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_delete_activity(activity_id uuid, activity_data jsonb, actor_profile record) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_object_id TEXT;
    v_post_record RECORD;
BEGIN
    -- Object can be string ID or object with ID
    v_object_id := CASE 
        WHEN jsonb_typeof(activity_data->'object') = 'string' 
        THEN activity_data->>'object'
        ELSE activity_data->'object'->>'id'
    END;
    
    -- Find and soft-delete the post
    SELECT * INTO v_post_record
    FROM posts 
    WHERE ap_id = v_object_id 
      AND author_id = actor_profile.id; -- Security: only author can delete
    
    IF FOUND THEN
        UPDATE posts 
        SET is_deleted = true,
            deleted_at = NOW(),
            content = '[{"type": "text", "text": "[deleted]"}]'::jsonb
        WHERE id = v_post_record.id;
        
        RAISE NOTICE '🗑️ Deleted post: %', v_object_id;
    END IF;
END;
$$;


--
-- Name: process_follow_activity(uuid, jsonb, record, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_follow_activity(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_following_url TEXT;
    v_following_profile RECORD;
    v_username TEXT;
    v_follow_id UUID;
BEGIN
    -- Extract the user being followed
    v_following_url := CASE 
        WHEN jsonb_typeof(activity_data->'object') = 'string' 
        THEN activity_data->>'object'
        ELSE activity_data->'object'->>'id'
    END;

    -- Extract username from URL
    v_username := substring(v_following_url from 'https://[^/]+/users/([^/]+)');
    
    IF v_username IS NULL THEN
        RAISE WARNING 'Could not extract username from follow object: %', v_following_url;
        RETURN;
    END IF;

    -- Get the local user being followed
    SELECT * INTO v_following_profile
    FROM profiles 
    WHERE username = v_username 
      AND domain = instance_domain 
      AND is_local = true;

    IF NOT FOUND THEN
        RAISE WARNING 'Local user not found: %', v_username;
        RETURN;
    END IF;

    -- Create or update follow relationship
    INSERT INTO follows (
        follower_id,
        following_id,
        ap_id,
        status,
        accepted_at,
        is_local,
        created_at
    ) VALUES (
        actor_profile.id,
        v_following_profile.id,
        activity_data->>'id',
        'accepted', -- Auto-accept for now
        NOW(),
        false,
        NOW()
    )
    ON CONFLICT (follower_id, following_id) 
    DO UPDATE SET
        ap_id = EXCLUDED.ap_id,
        status = 'accepted',
        accepted_at = NOW(),
        updated_at = NOW()
    RETURNING id INTO v_follow_id;

    RAISE NOTICE '✅ Follow relationship created: % now follows %', 
        actor_profile.username, v_following_profile.username;

    -- Note: Follow notifications are handled by the existing follow notification trigger
    -- TODO: Send Accept activity back to follower (queue for federation)
END;
$$;


--
-- Name: process_incoming_emoji_reaction(text, jsonb, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_incoming_emoji_reaction(p_activity_id text, p_activity jsonb, p_actor_uri text, p_actor_domain text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $_$
DECLARE
    v_actor_profile RECORD;
    v_target_post RECORD;
    v_object_id text;
    v_emoji_content text;
    v_emoji_tag jsonb;
    v_emoji_resolution RECORD;
    v_rows_affected integer;
    v_is_undo boolean := false;
    v_inner_object jsonb;
BEGIN
    -- Handle Undo activities
    IF p_activity->>'type' = 'Undo' THEN
        v_is_undo := true;
        v_inner_object := p_activity->'object';
        
        -- Extract info from the undone activity
        IF v_inner_object->>'type' IN ('EmojiReact', 'Like') THEN
            v_object_id := v_inner_object->>'object';
            v_emoji_content := v_inner_object->>'content';
            v_emoji_tag := CASE 
                WHEN jsonb_array_length(COALESCE(v_inner_object->'tag', '[]'::jsonb)) > 0 
                THEN v_inner_object->'tag'->0 
                ELSE NULL 
            END;
        ELSE
            RAISE LOG 'Unknown object type in Undo activity: %', v_inner_object->>'type';
            RETURN false;
        END IF;
    ELSIF p_activity->>'type' IN ('EmojiReact', 'Like') THEN
        -- Direct reaction activity
        v_object_id := p_activity->>'object';
        v_emoji_content := COALESCE(
            p_activity->>'content',
            p_activity->>'_misskey_reaction'  -- Misskey compatibility
        );
        v_emoji_tag := CASE 
            WHEN jsonb_array_length(COALESCE(p_activity->'tag', '[]'::jsonb)) > 0 
            THEN p_activity->'tag'->0 
            ELSE NULL 
        END;
    ELSE
        RAISE LOG 'Unsupported activity type for emoji reaction: %', p_activity->>'type';
        RETURN false;
    END IF;
    
    -- Validate required fields
    IF v_object_id IS NULL THEN
        RAISE LOG 'Missing object ID in emoji reaction activity';
        RETURN false;
    END IF;
    
    IF v_emoji_content IS NULL AND v_emoji_tag IS NULL THEN
        RAISE LOG 'Missing emoji content and tag in reaction activity';
        RETURN false;
    END IF;
    
    -- Find or create the actor profile
    SELECT * INTO v_actor_profile
    FROM profiles
    WHERE federated_id = p_actor_uri;
    
    IF NOT FOUND THEN
        -- Actor doesn't exist, create it by fetching from remote
        DECLARE
            v_actor_response jsonb;
            v_actor_username text;
            v_actor_domain text;
            v_new_profile_id uuid;
        BEGIN
            -- Parse domain from actor URI
            v_actor_domain := split_part(split_part(p_actor_uri, '://', 2), '/', 1);
            
            -- Try to extract username from URI path
            v_actor_username := split_part(p_actor_uri, '/', array_length(string_to_array(p_actor_uri, '/'), 1));
            
            -- Create a basic federated profile for this actor
            SELECT create_federated_profile(
                p_username := COALESCE(v_actor_username, 'unknown'),
                p_display_name := COALESCE(v_actor_username, 'Remote User'),
                p_domain := v_actor_domain,
                p_federated_id := p_actor_uri,
                p_bio := 'Federated ActivityPub user'
            ) INTO v_new_profile_id;
            
            -- Now fetch the created profile
            SELECT * INTO v_actor_profile
            FROM profiles
            WHERE id = v_new_profile_id;
            
            RAISE LOG 'Created federated profile for actor: % (id: %)', p_actor_uri, v_new_profile_id;
        EXCEPTION WHEN OTHERS THEN
            RAISE LOG 'Failed to create federated profile for actor: % - %', p_actor_uri, SQLERRM;
            RETURN false;
        END;
    END IF;
    
    -- Find the target post
    SELECT * INTO v_target_post
    FROM posts
    WHERE ap_id = v_object_id 
       OR id::text = v_object_id
       OR (v_object_id ~ '^https?://[^/]+/posts/([a-f0-9-]{36})$' 
           AND id::text = substring(v_object_id from '^https?://[^/]+/posts/([a-f0-9-]{36})$'));
    
    IF NOT FOUND THEN
        RAISE LOG 'Target post not found for emoji reaction: % (checked ap_id and extracted UUID)', v_object_id;
        RETURN false;
    END IF;
    
    -- Only process reactions on local posts
    IF NOT v_target_post.is_local THEN
        RAISE LOG 'Ignoring reaction on remote post: %', v_target_post.id;
        RETURN true;  -- Not an error, just not our concern
    END IF;
    
    -- Resolve the emoji
    BEGIN
        SELECT * INTO v_emoji_resolution
        FROM resolve_activitypub_emoji(v_emoji_tag, v_emoji_content, p_actor_domain)
        LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
        RAISE LOG 'Failed to resolve emoji for reaction: %', SQLERRM;
        RETURN false;
    END;
    
    IF v_is_undo THEN
        -- Remove existing reaction
        DELETE FROM post_interactions
        WHERE user_id = v_actor_profile.id
        AND post_id = v_target_post.id
        AND interaction_type = 'emoji_reaction'
        AND (
            (emoji_id = v_emoji_resolution.emoji_id) OR
            (emoji_id IS NULL AND custom_emoji_content = v_emoji_resolution.custom_emoji_content)
        );
        
        GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
        
        IF v_rows_affected > 0 THEN
            RAISE LOG 'Removed federated emoji reaction: % from % on post %', 
                v_emoji_content, p_actor_uri, v_target_post.id;
        ELSE
            RAISE LOG 'No matching reaction found to remove: % from % on post %', 
                v_emoji_content, p_actor_uri, v_target_post.id;
        END IF;
        
        RETURN true;
    ELSE
        -- Add new reaction (if not already exists)
        INSERT INTO post_interactions (
            user_id,
            post_id,
            interaction_type,
            emoji_id,
            custom_emoji_content,
            ap_id,
            is_local,
            metadata
        ) VALUES (
            v_actor_profile.id,
            v_target_post.id,
            'emoji_reaction',
            v_emoji_resolution.emoji_id,
            v_emoji_resolution.custom_emoji_content,
            p_activity_id,
            false,  -- This is a federated reaction
            jsonb_build_object(
                'activity_id', p_activity_id,
                'actor_uri', p_actor_uri,
                'actor_domain', p_actor_domain,
                'original_content', v_emoji_content,
                'federation_source', 'activitypub',
                'processed_at', NOW()
            )
        )
        ON CONFLICT (ap_id) DO NOTHING;
        
        GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
        
        IF v_rows_affected > 0 THEN
            RAISE LOG 'Added federated emoji reaction: % from % on post %', 
                v_emoji_content, p_actor_uri, v_target_post.id;
        ELSE
            RAISE LOG 'Duplicate emoji reaction ignored: % from % on post %', 
                v_emoji_content, p_actor_uri, v_target_post.id;
        END IF;
        
        RETURN true;
    END IF;
END;
$_$;


--
-- Name: FUNCTION process_incoming_emoji_reaction(p_activity_id text, p_activity jsonb, p_actor_uri text, p_actor_domain text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.process_incoming_emoji_reaction(p_activity_id text, p_activity jsonb, p_actor_uri text, p_actor_domain text) IS 'Processes incoming EmojiReact and Like activities from ActivityPub federation. Handles both creation and removal (Undo) of emoji reactions.';


--
-- Name: process_incoming_private_message(uuid, jsonb, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_incoming_private_message(p_activity_id uuid, p_activity_data jsonb, p_actor_profile_id uuid, p_instance_domain text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_object JSONB;
  v_content JSONB;
  v_local_recipients TEXT[];
  v_recipient_username TEXT;
  v_local_user profiles%ROWTYPE;
  v_actor_profile profiles%ROWTYPE;
  v_conversation_id UUID;
  v_message_id UUID;
  v_recipient_count INTEGER := 0;
  v_is_dm BOOLEAN := false;
BEGIN
  -- Get actor profile
  SELECT * INTO v_actor_profile FROM profiles WHERE id = p_actor_profile_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Actor profile not found: %', p_actor_profile_id;
  END IF;
  
  RAISE NOTICE '📨 Processing ActivityPub private message from %@%', 
    v_actor_profile.username, v_actor_profile.domain;
  
  -- Extract message object
  v_object := p_activity_data->'object';
  
  -- Extract local recipients from addressing (compatible with all ActivityPub platforms)
  WITH recipient_extraction AS (
    SELECT jsonb_array_elements_text(
      COALESCE(v_object->'to', '[]'::jsonb) || 
      COALESCE(v_object->'cc', '[]'::jsonb)
    ) AS recipient_url
  ),
  -- Also extract from mention tags (Mastodon/Pleroma compatibility)
  mention_extraction AS (
    SELECT jsonb_array_elements(COALESCE(v_object->'tag', '[]'::jsonb)) AS tag
  ),
  mention_recipients AS (
    SELECT tag->>'href' AS recipient_url
    FROM mention_extraction
    WHERE tag->>'type' = 'Mention'
      AND tag->>'href' IS NOT NULL
  ),
  all_recipients AS (
    SELECT recipient_url FROM recipient_extraction
    UNION
    SELECT recipient_url FROM mention_recipients
  ),
  local_recipients AS (
    SELECT DISTINCT
      CASE 
        WHEN recipient_url LIKE 'https://' || p_instance_domain || '/users/%' THEN
          substring(recipient_url from 'https://' || p_instance_domain || '/users/([^/]+)')
        WHEN recipient_url LIKE 'https://' || p_instance_domain || '/social/profile/%' THEN  
          substring(recipient_url from 'https://' || p_instance_domain || '/social/profile/([^/]+)')
        WHEN recipient_url LIKE 'https://' || p_instance_domain || '/@%' THEN
          substring(recipient_url from 'https://' || p_instance_domain || '/@([^/]+)')
        ELSE NULL
      END AS username
    FROM all_recipients
  )
  SELECT array_agg(username)
  INTO v_local_recipients
  FROM local_recipients 
  WHERE username IS NOT NULL;
  
  -- Validate recipients exist
  IF v_local_recipients IS NULL OR array_length(v_local_recipients, 1) = 0 THEN
    RAISE WARNING 'Private message from %@% has no valid local recipients - skipping',
      v_actor_profile.username, v_actor_profile.domain;
    RETURN;
  END IF;
  
  RAISE NOTICE '📧 Private message mentions % local users: %', 
    array_length(v_local_recipients, 1), v_local_recipients;
  
  -- Check if this is actually a DM using the existing detection function
  v_is_dm := is_activitypub_direct_message(v_object, p_instance_domain);
  
  -- Convert ActivityPub content to unified format
  v_content := convert_ap_to_jsonb(
    v_object->>'content',
    v_object->'tag'
  );
  
  -- 🔧 FIX: Strip redundant @user@domain mentions ONLY from DM content
  IF v_is_dm THEN
    v_content := strip_mentions_from_dm_content(v_content);
    RAISE NOTICE '🧹 Stripped mentions from DM content';
  ELSE
    RAISE NOTICE '📢 Keeping mentions in non-DM message';
  END IF;
  
  -- Process each local recipient
  FOREACH v_recipient_username IN ARRAY v_local_recipients LOOP
    -- Get local user profile
    SELECT * INTO v_local_user
    FROM profiles 
    WHERE username = v_recipient_username 
      AND domain = p_instance_domain 
      AND is_local = true;
      
    IF NOT FOUND THEN
      RAISE WARNING 'Local recipient not found: %@%', v_recipient_username, p_instance_domain;
      CONTINUE;
    END IF;
    
    -- Get or create conversation between remote sender and local recipient
    v_conversation_id := get_or_create_dm_conversation(
      v_actor_profile.id,
      v_local_user.id
    );
    
    -- Insert the federated private message (with mentions stripped only if DM)
    INSERT INTO messages (
      conversation_id,
      user_id,
      content,
      created_at,
      metadata
    ) VALUES (
      v_conversation_id,
      v_actor_profile.id,
      v_content,
      COALESCE((v_object->>'published')::timestamptz, NOW()),
      jsonb_build_object(
        'federated', true,
        'ap_id', v_object->>'id',
        'ap_type', 'Note',
        'from_domain', v_actor_profile.domain,
        'activity_id', p_activity_id,
        'original_url', COALESCE(v_object->>'url', v_object->>'id'),
        'private_mention', true,
        'activitypub_compatible', true,
        'is_dm', v_is_dm
      )
    ) RETURNING id INTO v_message_id;
    
    v_recipient_count := v_recipient_count + 1;
    
    RAISE NOTICE '✅ Saved federated private message %: %@% → %',
      v_message_id, v_actor_profile.username, v_actor_profile.domain, v_recipient_username;
  END LOOP;
  
  RAISE NOTICE '🎯 Completed private message processing for activity % (% recipients)',
    p_activity_id, v_recipient_count;
END;
$$;


--
-- Name: FUNCTION process_incoming_private_message(p_activity_id uuid, p_activity_data jsonb, p_actor_profile_id uuid, p_instance_domain text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.process_incoming_private_message(p_activity_id uuid, p_activity_data jsonb, p_actor_profile_id uuid, p_instance_domain text) IS 'Processes incoming ActivityPub private messages with full Mastodon/Misskey/Pleroma compatibility';


--
-- Name: process_like_activity(uuid, jsonb, record); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_like_activity(activity_id uuid, activity_data jsonb, actor_profile record) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_object_id TEXT;
    v_post_record RECORD;
    v_ap_id TEXT;
BEGIN
    v_object_id := activity_data->>'object';
    v_ap_id := activity_data->>'id';

    -- Find the post being liked
    SELECT * INTO v_post_record
    FROM posts 
    WHERE ap_id = v_object_id;

    IF FOUND THEN
        -- Create the like interaction
        INSERT INTO post_interactions (
            user_id,
            post_id,
            interaction_type,
            ap_id,
            is_local,
            created_at
        ) VALUES (
            actor_profile.id,
            v_post_record.id,
            'favorite',
            v_ap_id,
            false,
            NOW()
        ) ON CONFLICT (user_id, post_id, interaction_type) DO NOTHING;
        
        RAISE NOTICE '❤️ Post liked: % by %', v_object_id, actor_profile.username;
    END IF;
END;
$$;


--
-- Name: process_post_hashtags(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_post_hashtags(p_post_id uuid, p_content jsonb) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_hashtag_array TEXT[];
    v_hashtag_text TEXT;
    v_hashtag_id UUID;
    v_position_counter INTEGER := 0;
    v_processed_count INTEGER := 0;
BEGIN
    -- Extract hashtags from content
    v_hashtag_array := extract_hashtags_from_content(p_content);
    
    -- Process each hashtag
    FOREACH v_hashtag_text IN ARRAY v_hashtag_array LOOP
        v_position_counter := v_position_counter + 1;
        
        -- Upsert hashtag and get ID
        v_hashtag_id := upsert_hashtag(v_hashtag_text);
        
        -- Link post to hashtag
        INSERT INTO post_hashtags (post_id, hashtag_id, position_in_content)
        VALUES (p_post_id, v_hashtag_id, v_position_counter)
        ON CONFLICT (post_id, hashtag_id) DO NOTHING;
        
        v_processed_count := v_processed_count + 1;
    END LOOP;
    
    RETURN v_processed_count;
END;
$$;


--
-- Name: process_reject_activity(uuid, jsonb, record); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_reject_activity(activity_id uuid, activity_data jsonb, actor_profile record) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_object JSONB;
    v_original_follow_id TEXT;
    v_follow_record RECORD;
BEGIN
    v_object := activity_data->'object';
    
    -- Handle Reject of Follow activities
    IF v_object->>'type' = 'Follow' THEN
        v_original_follow_id := v_object->>'id';
        
        -- Find the follow request in our database
        SELECT * INTO v_follow_record
        FROM follows 
        WHERE ap_id = v_original_follow_id 
          AND status = 'pending';
        
        IF FOUND THEN
            -- Update follow status to rejected (or delete)
            UPDATE follows 
            SET status = 'rejected',
                updated_at = NOW()
            WHERE id = v_follow_record.id;
            
            RAISE NOTICE '❌ Follow request rejected: % -> %', 
                v_follow_record.follower_id, v_follow_record.following_id;
        END IF;
    END IF;
END;
$$;


--
-- Name: process_undo_activity(uuid, jsonb, record); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_undo_activity(activity_id uuid, activity_data jsonb, actor_profile record) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_object JSONB;
    v_original_activity_id TEXT;
    v_object_type TEXT;
BEGIN
    v_object := activity_data->'object';
    v_original_activity_id := v_object->>'id';
    v_object_type := v_object->>'type';
    
    CASE v_object_type
        WHEN 'Follow' THEN
            -- Undo follow = unfollow
            DELETE FROM follows 
            WHERE ap_id = v_original_activity_id 
              AND follower_id = actor_profile.id;
        
            RAISE NOTICE '🔄 Undone follow activity: %', v_original_activity_id;
        
        WHEN 'Like' THEN
            -- Undo like = unfavorite
            DELETE FROM post_interactions 
            WHERE ap_id = v_original_activity_id 
              AND user_id = actor_profile.id 
              AND interaction_type = 'favorite';
          
            RAISE NOTICE '🔄 Undone like activity: %', v_original_activity_id;
        
        WHEN 'Announce' THEN
            -- Undo announce = unreblog
            DELETE FROM post_interactions 
            WHERE ap_id = v_original_activity_id 
              AND user_id = actor_profile.id 
              AND interaction_type = 'reblog';
          
            RAISE NOTICE '🔄 Undone announce activity: %', v_original_activity_id;
        
        ELSE
            RAISE NOTICE '⚠️ Unhandled undo object type: %', v_object_type;
    END CASE;
END;
$$;


--
-- Name: process_update_activity(uuid, jsonb, record); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_update_activity(activity_id uuid, activity_data jsonb, actor_profile record) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_object JSONB;
    v_object_id TEXT;
    v_object_type TEXT;
    v_post_record RECORD;
    v_content JSONB;
BEGIN
    v_object := activity_data->'object';
    v_object_id := v_object->>'id';
    v_object_type := v_object->>'type';
    
    CASE v_object_type
        WHEN 'Note' THEN
            -- Handle Note updates (post edits)
            -- Find the existing post
            SELECT * INTO v_post_record
            FROM posts 
            WHERE ap_id = v_object_id;
            
            IF FOUND THEN
                -- Convert ActivityPub content to our format
                v_content := parse_activitypub_content_to_jsonb(
                    v_object->>'content', 
                    v_object->'tag'
                );
                
                -- Update the post
                UPDATE posts 
                SET content = v_content,
                    content_warning = v_object->>'summary',
                    is_sensitive = COALESCE((v_object->>'sensitive')::boolean, false),
                    updated_at = NOW(),
                    edited_at = NOW()
                WHERE id = v_post_record.id;
                
                RAISE NOTICE '📝 Updated post: %', v_object_id;
            END IF;
            
        WHEN 'Person' THEN
            -- Handle Person updates (profile updates)
            RAISE NOTICE '👤 Processing profile update for: %', v_object_id;
            
            -- Verify this update is from the profile owner
            IF actor_profile.federated_id != v_object_id THEN
                RAISE WARNING 'Profile update rejected: actor % cannot update profile %', 
                    actor_profile.federated_id, v_object_id;
                RETURN;
            END IF;
            
            -- Update the profile with new information
            -- Handle both direct fields and nested objects (like icon/image)
            UPDATE profiles 
            SET 
                display_name = COALESCE(v_object->>'name', display_name),
                bio = COALESCE(v_object->>'summary', bio),
                avatar_url = CASE 
                    WHEN v_object->'icon'->>'type' = 'Image' THEN v_object->'icon'->>'url'
                    WHEN v_object->>'icon' IS NOT NULL THEN v_object->>'icon'
                    ELSE avatar_url
                END,
                banner_url = CASE 
                    WHEN v_object->'image'->>'type' = 'Image' THEN v_object->'image'->>'url'
                    WHEN v_object->>'image' IS NOT NULL THEN v_object->>'image'
                    ELSE banner_url
                END,
                public_key = COALESCE(v_object->'publicKey'->>'publicKeyPem', public_key),
                inbox_url = COALESCE(v_object->>'inbox', inbox_url),
                outbox_url = COALESCE(v_object->>'outbox', outbox_url),
                followers_url = COALESCE(v_object->>'followers', followers_url),
                following_url = COALESCE(v_object->>'following', following_url),
                updated_at = NOW(),
                last_synced_at = NOW()
            WHERE federated_id = v_object_id 
              AND NOT is_local; -- Only update federated profiles
            
            IF FOUND THEN
                RAISE NOTICE '✅ Updated profile: %', v_object_id;
                
                -- Log the updated fields for debugging
                RAISE NOTICE 'Profile update details - name: %, summary: %, icon: %, image: %',
                    v_object->>'name',
                    v_object->>'summary',
                    COALESCE(v_object->'icon'->>'url', v_object->>'icon'),
                    COALESCE(v_object->'image'->>'url', v_object->>'image');
            ELSE
                RAISE WARNING 'Profile not found for update: %', v_object_id;
            END IF;
            
        ELSE
            RAISE NOTICE 'Unhandled Update object type: %', v_object_type;
    END CASE;
END;
$$;


--
-- Name: FUNCTION process_update_activity(activity_id uuid, activity_data jsonb, actor_profile record); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.process_update_activity(activity_id uuid, activity_data jsonb, actor_profile record) IS 'Processes incoming ActivityPub Update activities. Handles both Note updates (post edits) and Person updates (profile updates). Profile updates include name, bio, avatar, banner, and other public fields. Only allows users to update their own profiles.';


--
-- Name: record_emoji_usage(uuid, uuid, uuid, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_emoji_usage(p_emoji_id uuid, p_user_id uuid, p_server_id uuid, p_context_type text, p_context_id uuid DEFAULT NULL::uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Insert usage record (ignore if duplicate due to unique constraint)
    INSERT INTO emoji_usage (emoji_id, user_id, server_id, context_type, context_id)
    VALUES (p_emoji_id, p_user_id, p_server_id, p_context_type, p_context_id)
    ON CONFLICT (emoji_id, user_id, context_type, context_id) DO NOTHING;
    
    -- Update emoji global usage count and last_used
    UPDATE emojis 
    SET 
        usage_count = (
            SELECT COUNT(DISTINCT (user_id, context_type, context_id))
            FROM emoji_usage 
            WHERE emoji_id = p_emoji_id
        ),
        last_used = now(),
        updated_at = now()
    WHERE id = p_emoji_id;
END;
$$;


--
-- Name: remove_group_icon(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remove_group_icon(conversation_uuid uuid, user_profile_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  is_participant BOOLEAN := false;
  conversation_exists BOOLEAN := false;
BEGIN
  -- Check if user is a participant in the conversation
  SELECT can_manage_group_icon(conversation_uuid, user_profile_id) INTO is_participant;
  
  IF NOT is_participant THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'User is not a participant in this conversation'
    );
  END IF;
  
  -- Check if conversation exists and is a group
  SELECT EXISTS(
    SELECT 1 FROM conversations 
    WHERE id = conversation_uuid AND type = 'group'
  ) INTO conversation_exists;
  
  IF NOT conversation_exists THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Group conversation not found'
    );
  END IF;
  
  -- Remove icon from conversation metadata
  UPDATE conversations 
  SET 
    metadata = COALESCE(metadata, '{}'::jsonb) - 'icon_url',
    updated_at = CURRENT_TIMESTAMP
  WHERE id = conversation_uuid
    AND type = 'group';
  
  RETURN jsonb_build_object(
    'success', true,
    'message', 'Group icon removed successfully'
  );
END;
$$;


--
-- Name: remove_post_emoji_reaction(uuid, uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remove_post_emoji_reaction(p_user_id uuid, p_post_id uuid, p_emoji_id uuid DEFAULT NULL::uuid, p_custom_emoji_content text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_deleted_count integer;
BEGIN
    DELETE FROM post_interactions 
    WHERE user_id = p_user_id
      AND post_id = p_post_id 
      AND interaction_type = 'emoji_reaction'
      AND (
          (p_emoji_id IS NOT NULL AND emoji_id = p_emoji_id) OR
          (p_custom_emoji_content IS NOT NULL AND custom_emoji_content = p_custom_emoji_content)
      );
    
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    RETURN v_deleted_count > 0;
END;
$$;


--
-- Name: FUNCTION remove_post_emoji_reaction(p_user_id uuid, p_post_id uuid, p_emoji_id uuid, p_custom_emoji_content text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.remove_post_emoji_reaction(p_user_id uuid, p_post_id uuid, p_emoji_id uuid, p_custom_emoji_content text) IS 'Remove emoji reaction from post. Returns true if reaction was found and removed.';


--
-- Name: remove_timeline_on_unfollow(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remove_timeline_on_unfollow() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    -- Remove all posts from unfollowed user from the follower's home timeline
    DELETE FROM timeline_entries
    WHERE user_id = OLD.follower_id
      AND timeline_type = 'home'
      AND post_id IN (
          SELECT id FROM posts WHERE author_id = OLD.following_id
      );
    
    RETURN OLD;
END;
$$;


--
-- Name: FUNCTION remove_timeline_on_unfollow(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.remove_timeline_on_unfollow() IS 'Removes posts from home timeline when unfollowing a user';


--
-- Name: resolve_activitypub_emoji(jsonb, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_activitypub_emoji(p_emoji_tag jsonb, p_content text, p_actor_domain text) RETURNS TABLE(emoji_id uuid, custom_emoji_content text)
    LANGUAGE plpgsql
    AS $_$
DECLARE
    v_emoji_name text;
    v_emoji_url text;
    v_local_emoji_id uuid;
    v_custom_content text;
BEGIN
    -- Handle custom emoji from tag (Mastodon/Pleroma style)
    IF p_emoji_tag IS NOT NULL AND p_emoji_tag->>'type' = 'Emoji' THEN
        v_emoji_name := p_emoji_tag->>'name';
        v_emoji_url := p_emoji_tag->'icon'->>'url';
        
        -- Remove colons from emoji name if present
        v_emoji_name := trim(both ':' from v_emoji_name);
        
        -- Try to find existing federated emoji
        SELECT id INTO v_local_emoji_id
        FROM emojis
        WHERE name = v_emoji_name AND domain = p_actor_domain;
        
        IF v_local_emoji_id IS NULL THEN
            -- Try to create new federated emoji
            BEGIN
                INSERT INTO emojis (name, url, domain, usage_count, last_used)
                VALUES (v_emoji_name, v_emoji_url, p_actor_domain, 1, NOW())
                RETURNING id INTO v_local_emoji_id;
            EXCEPTION WHEN unique_violation THEN
                -- Another process created the same emoji, find it
                SELECT id INTO v_local_emoji_id
                FROM emojis
                WHERE name = v_emoji_name AND domain = p_actor_domain;
                
                IF v_local_emoji_id IS NOT NULL THEN
                    -- Update usage stats and URL for existing emoji
                    UPDATE emojis 
                    SET usage_count = usage_count + 1, 
                        last_used = NOW(),
                        url = v_emoji_url  -- Update URL in case it changed
                    WHERE id = v_local_emoji_id;
                END IF;
            END;
        ELSE
            -- Update usage stats for existing emoji
            UPDATE emojis 
            SET usage_count = usage_count + 1, last_used = NOW()
            WHERE id = v_local_emoji_id;
        END IF;
        
        emoji_id := v_local_emoji_id;
        custom_emoji_content := NULL;
        RETURN NEXT;
        RETURN;
    END IF;
    
    -- Handle unicode emoji content or shortcodes
    IF p_content IS NOT NULL AND length(p_content) > 0 THEN
        -- Check if it's a simple unicode emoji (common case)
        IF length(p_content) <= 4 AND p_content ~ '^[\x{1F600}-\x{1F64F}\x{1F300}-\x{1F5FF}\x{1F680}-\x{1F6FF}\x{1F1E0}-\x{1F1FF}\x{2600}-\x{26FF}\x{2700}-\x{27BF}]+$' THEN
            emoji_id := NULL;
            custom_emoji_content := p_content;
            RETURN NEXT;
            RETURN;
        END IF;
        
        -- Handle shortcode format like :emoji_name: (could be local or from Misskey)
        IF p_content ~ '^:[a-zA-Z0-9_]+:$' THEN
            v_emoji_name := trim(both ':' from p_content);
            
            -- First try to find federated emoji from this domain
            SELECT id INTO v_local_emoji_id
            FROM emojis
            WHERE name = v_emoji_name AND domain = p_actor_domain;
            
            -- If not found, try to find local emoji
            IF v_local_emoji_id IS NULL THEN
                SELECT id INTO v_local_emoji_id
                FROM emojis
                WHERE name = v_emoji_name AND domain IS NULL;
            END IF;
            
            IF v_local_emoji_id IS NOT NULL THEN
                -- Found existing emoji (local or federated)
                UPDATE emojis 
                SET usage_count = usage_count + 1, last_used = NOW()
                WHERE id = v_local_emoji_id;
                
                emoji_id := v_local_emoji_id;
                custom_emoji_content := NULL;
                RETURN NEXT;
                RETURN;
            ELSE
                -- Store as custom content if no emoji found
                emoji_id := NULL;
                custom_emoji_content := p_content;
                RETURN NEXT;
                RETURN;
            END IF;
        END IF;
        
        -- Fallback: store content as-is for unicode emojis
        emoji_id := NULL;
        custom_emoji_content := p_content;
        RETURN NEXT;
        RETURN;
    END IF;
    
    -- No valid emoji found
    RAISE EXCEPTION 'No valid emoji content provided';
END;
$_$;


--
-- Name: FUNCTION resolve_activitypub_emoji(p_emoji_tag jsonb, p_content text, p_actor_domain text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.resolve_activitypub_emoji(p_emoji_tag jsonb, p_content text, p_actor_domain text) IS 'Resolves ActivityPub emoji tags and content to local emoji_id by creating federated emoji records as needed. Handles custom emojis, unicode emojis, and shortcodes.';


--
-- Name: resume_activitypub_cron_jobs(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resume_activitypub_cron_jobs() RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    result TEXT := '';
    schedule_result TEXT;
BEGIN
    SELECT cron.schedule(
        'activitypub-retry-processor', 
        '*/5 * * * *', 
        'SELECT process_failed_activities_retry();'
    ) INTO schedule_result;
    SELECT cron.schedule(
        'activitypub-cleanup-old-activities',
        '0 3 * * *',
        'DELETE FROM ap_activities WHERE status = ''processed'' AND created_at < NOW() - INTERVAL ''30 days'' AND attempts < 3;'
    ) INTO schedule_result;
    SELECT cron.schedule(
        'activitypub-daily-stats',
        '0 1 * * *',
        'INSERT INTO activitypub_processing_stats (date, total_activities, processed_activities, failed_activities, permanently_failed_activities, avg_processing_time_ms) SELECT CURRENT_DATE - INTERVAL ''1 day'', COUNT(*), COUNT(*) FILTER (WHERE status = ''processed''), COUNT(*) FILTER (WHERE status = ''failed''), COUNT(*) FILTER (WHERE status = ''permanently_failed''), AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000) FROM ap_activities WHERE created_at >= CURRENT_DATE - INTERVAL ''1 day'' AND created_at < CURRENT_DATE;'
    ) INTO schedule_result;
    result := 'ActivityPub cron jobs have been resumed';
    RETURN result;
END;
$$;


--
-- Name: route_channel_message(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.route_channel_message() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_server_id UUID;
  v_has_remote_members BOOLEAN;
  v_channel_name TEXT;
BEGIN
  -- Only process server channel messages (not DMs)
  IF NEW.channel_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Get server from channel
  SELECT c.server_id, c.name
  INTO v_server_id, v_channel_name
  FROM channels c
  WHERE c.id = NEW.channel_id;

  IF v_server_id IS NULL THEN
    -- Not a server channel, skip
    RETURN NEW;
  END IF;

  -- Check if server has remote members
  v_has_remote_members := server_has_remote_members(v_server_id);

  -- If has remote members, notify federation backend
  IF v_has_remote_members THEN
    PERFORM pg_notify('channel_message_federate', 
      json_build_object(
        'message_id', NEW.id,
        'channel_id', NEW.channel_id,
        'server_id', v_server_id,
        'channel_name', v_channel_name,
        'author_id', NEW.user_id
      )::text
    );
    
    RAISE DEBUG 'Message % queued for federation (server % has remote members)', 
      NEW.id, v_server_id;
  ELSE
    RAISE DEBUG 'Message % is local-only (server % has no remote members)', 
      NEW.id, v_server_id;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION route_channel_message(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.route_channel_message() IS 'Smart routing: Notify federation backend only if server has remote members';


--
-- Name: route_server_leave(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.route_server_leave() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_server RECORD;
  v_user RECORD;
BEGIN
  -- Get server info
  SELECT * INTO v_server
  FROM servers
  WHERE id = OLD.server_id;

  -- Get user info
  SELECT * INTO v_user
  FROM profiles
  WHERE id = OLD.user_id;

  -- If remote server, notify federation backend to send Leave activity
  IF v_server.is_local_server = false THEN
    PERFORM pg_notify('user_leave_remote_server',
      json_build_object(
        'user_id', OLD.user_id,
        'server_id', OLD.server_id,
        'server_ap_id', v_server.ap_id,
        'server_inbox', v_server.federation_inbox_url
      )::text
    );
  END IF;

  -- If local server with remote user, broadcast Leave to other instances
  IF v_server.is_local_server = true AND v_user.is_local = false THEN
    PERFORM pg_notify('remote_user_left_server',
      json_build_object(
        'user_id', OLD.user_id,
        'user_ap_id', v_user.ap_id,
        'server_id', OLD.server_id
      )::text
    );
  END IF;

  RETURN OLD;
END;
$$;


--
-- Name: FUNCTION route_server_leave(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.route_server_leave() IS 'Handle federation for server leave events';


--
-- Name: route_server_membership(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.route_server_membership() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_server RECORD;
  v_user RECORD;
  v_is_remote_user BOOLEAN;
  v_is_remote_server BOOLEAN;
BEGIN
  -- Get server info
  SELECT * INTO v_server
  FROM servers
  WHERE id = NEW.server_id;

  -- Get user info
  SELECT * INTO v_user
  FROM profiles
  WHERE id = NEW.user_id;

  v_is_remote_user := (v_user.is_local = false);
  v_is_remote_server := (v_server.is_local_server = false);

  -- Case 1: Local user joining remote server
  IF NOT v_is_remote_user AND v_is_remote_server THEN
    PERFORM pg_notify('user_join_remote_server',
      json_build_object(
        'user_id', NEW.user_id,
        'server_id', NEW.server_id,
        'server_ap_id', v_server.ap_id,
        'server_inbox', v_server.federation_inbox_url
      )::text
    );
    RAISE NOTICE 'Local user % joining remote server %', v_user.username, v_server.name;
  END IF;

  -- Case 2: Remote user joining local server (handled by inbox)
  -- No notification needed here, inbox handler adds membership

  -- Case 3: Membership status change (pending → accepted)
  IF TG_OP = 'UPDATE' AND OLD.status != NEW.status THEN
    IF NEW.status = 'accepted' THEN
      -- Member is now active, might need to notify
      PERFORM pg_notify('member_accepted',
        json_build_object(
          'user_id', NEW.user_id,
          'server_id', NEW.server_id
        )::text
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION route_server_membership(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.route_server_membership() IS 'Handle federation for server membership changes (joins/leaves)';


--
-- Name: run_trending_maintenance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.run_trending_maintenance() RETURNS json
    LANGUAGE plpgsql
    AS $$
DECLARE
    result JSON;
    hashtags_cleaned INTEGER;
    trending_cleaned INTEGER;
    hashtags_archived INTEGER;
    scores_updated INTEGER;
BEGIN
    -- Archive popular hashtags before cleanup
    hashtags_archived := archive_popular_hashtags();
    
    -- Clean up inactive hashtags
    hashtags_cleaned := cleanup_inactive_hashtags();
    
    -- Clean up old trending data
    trending_cleaned := cleanup_old_trending_data();
    
    -- Update trending scores
    scores_updated := update_hashtag_trending_scores();
    
    -- Update trending posts
    PERFORM update_trending_posts();
    
    -- Build result
    result := json_build_object(
        'maintenance_completed_at', NOW(),
        'hashtags_archived', hashtags_archived,
        'hashtags_cleaned', hashtags_cleaned,
        'trending_data_cleaned', trending_cleaned,
        'trending_scores_updated', scores_updated,
        'status', 'success'
    );
    
    RAISE NOTICE 'Trending system maintenance completed: %', result;
    RETURN result;
END;
$$;


--
-- Name: FUNCTION run_trending_maintenance(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.run_trending_maintenance() IS 'Comprehensive maintenance function that runs all cleanup and update operations';


--
-- Name: search_federated_users(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_federated_users(p_query text, p_limit integer DEFAULT 10) RETURNS TABLE(user_id uuid, username text, display_name text, domain text, avatar_url text, handle text, is_local boolean)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id as user_id,
        p.username,
        p.display_name,
        p.domain,
        p.avatar_url,
        get_user_handle(p.id) as handle,
        p.is_local
    FROM profiles p
    WHERE (
        p.username ILIKE '%' || p_query || '%'
        OR p.display_name ILIKE '%' || p_query || '%'
        OR (p.username || '@' || p.domain) ILIKE '%' || p_query || '%'
    )
    ORDER BY 
        CASE WHEN p.is_local THEN 0 ELSE 1 END,
        p.username
    LIMIT p_limit;
END;
$$;


--
-- Name: search_users(text, integer, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_users(p_query text, p_limit integer DEFAULT 20, p_local_only boolean DEFAULT false) RETURNS TABLE(id uuid, username text, domain text, display_name text, avatar text, is_local boolean)
    LANGUAGE sql STABLE
    AS $$
  SELECT id, username, domain, display_name, avatar_url, is_local
  FROM profiles
  WHERE (username ILIKE '%' || p_query || '%' OR display_name ILIKE '%' || p_query || '%')
    AND (NOT p_local_only OR is_local = true)
  ORDER BY 
    CASE WHEN username = p_query THEN 0 ELSE 1 END,
    CASE WHEN username ILIKE p_query || '%' THEN 0 ELSE 1 END,
    CASE WHEN is_local THEN 0 ELSE 1 END
  LIMIT p_limit;
$$;


--
-- Name: FUNCTION search_users(p_query text, p_limit integer, p_local_only boolean); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.search_users(p_query text, p_limit integer, p_local_only boolean) IS 'Search users by username or display name with smart ranking';


--
-- Name: send_accept_activity_for_follow(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.send_accept_activity_for_follow(follow_activity_id uuid, local_user_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'extensions', 'public', 'pg_temp'
    AS $$
DECLARE
    v_follow_activity RECORD;
    v_local_profile RECORD;
    v_instance_domain TEXT;
    v_accept_id TEXT;
    v_accept_activity JSONB;
    v_activity_uuid UUID;
    v_inbox_url TEXT;
    v_signature_header TEXT;
    v_date_header TEXT;
    v_digest_header TEXT;
    v_http_status INTEGER;
    v_http_response TEXT;
    v_delivery_success BOOLEAN;
    v_follower_domain TEXT;
BEGIN
    RAISE NOTICE '📤 Sending Accept activity for follow: %', follow_activity_id;
    
    -- Get the Follow activity we're accepting
    SELECT * INTO v_follow_activity
    FROM ap_activities 
    WHERE id = follow_activity_id
    AND ap_type = 'Follow';
    
    IF NOT FOUND THEN
        RAISE WARNING 'Follow activity not found: %', follow_activity_id;
        RETURN;
    END IF;
    
    -- Get the local user profile
    SELECT * INTO v_local_profile
    FROM profiles 
    WHERE id = local_user_id
    AND is_local = true;
    
    IF NOT FOUND THEN
        RAISE WARNING 'Local user not found: %', local_user_id;
        RETURN;
    END IF;
    
    -- Get instance domain
    SELECT trim(both '"' from config_value::text) INTO v_instance_domain 
    FROM instance_config 
    WHERE config_key = 'domain' 
    LIMIT 1;
    
    IF v_instance_domain IS NULL THEN
        RAISE WARNING 'Instance domain not configured, cannot send Accept';
        RETURN;
    END IF;
    
    -- Create Accept activity
    v_accept_id := 'https://' || v_instance_domain || '/users/' || v_local_profile.username || '#accepts/' || extract(epoch from now())::bigint;
    
    v_accept_activity := jsonb_build_object(
        '@context', 'https://www.w3.org/ns/activitystreams',
        'id', v_accept_id,
        'type', 'Accept',
        'actor', 'https://' || v_instance_domain || '/users/' || v_local_profile.username,
        'object', v_follow_activity.activity_data
    );
    
    RAISE NOTICE '📋 Created Accept activity: %', v_accept_id;
    
    -- Store the Accept activity in our database
    INSERT INTO ap_activities (
        ap_id,
        ap_type,
        actor_id,
        actor_ap_id,
        object_id,
        object_type,
        activity_data,
        status,
        to_addresses,
        is_local,
        origin_domain
    ) VALUES (
        v_accept_id,
        'Accept',
        local_user_id,
        'https://' || v_instance_domain || '/users/' || v_local_profile.username,
        v_follow_activity.ap_id,
        'Follow',
        v_accept_activity,
        'pending',
        ARRAY[v_follow_activity.actor_ap_id],
        true,
        v_instance_domain
    ) RETURNING id INTO v_activity_uuid;
    
    -- Extract follower domain for inbox URL
    v_follower_domain := (SELECT domain FROM profiles WHERE federated_id = v_follow_activity.actor_ap_id OR id = (
        SELECT id FROM profiles WHERE federated_id = v_follow_activity.actor_ap_id LIMIT 1
    ));
    
    IF v_follower_domain IS NULL THEN
        -- Try to extract domain from actor URL
        v_follower_domain := substring(v_follow_activity.actor_ap_id from 'https://([^/]+)/');
    END IF;
    
    IF v_follower_domain IS NULL THEN
        RAISE WARNING 'Could not determine follower domain from: %', v_follow_activity.actor_ap_id;
        RETURN;
    END IF;
    
    -- Construct inbox URL (user-specific for better delivery)
    v_inbox_url := v_follow_activity.actor_ap_id || '/inbox';
    
    RAISE WARNING '📮 Sending Accept to inbox: %', v_inbox_url;
    
    -- Generate HTTP signature
    BEGIN
        SELECT 
            signature_header,
            date_header,
            digest_header
        INTO 
            v_signature_header,
            v_date_header,
            v_digest_header
        FROM create_http_signature(
            v_inbox_url,
            v_accept_activity::text,
            v_local_profile.username,
            v_instance_domain,
            'POST'
        );
        
        RAISE NOTICE 'Generated HTTP signature for Accept to %', v_follower_domain;
        
    EXCEPTION 
        WHEN OTHERS THEN
            RAISE WARNING 'Failed to generate signature for Accept: %', SQLERRM;
            -- Update activity as failed and return
            UPDATE ap_activities 
            SET status = 'failed',
                error_message = 'Signature generation failed: ' || SQLERRM
            WHERE id = v_activity_uuid;
            RETURN;
    END;
    
    -- Attempt immediate delivery
    BEGIN
        RAISE WARNING '🚀 Attempting Accept delivery to: %', v_inbox_url;

        -- Try to deliver immediately using Supabase HTTP extension
        SELECT status, content INTO v_http_status, v_http_response
        FROM http((
            'POST',
            v_inbox_url,
            ARRAY[
                ('Content-Type', 'application/activity+json'),
                ('User-Agent', 'Harmony/1.0.0'),
                ('Host', v_follower_domain),
                ('Date', v_date_header),
                ('Digest', v_digest_header),
                ('Signature', v_signature_header)
            ]::http_header[],
            'application/activity+json',
            v_accept_activity::text
        )::http_request);
        
        -- Check delivery success
        v_delivery_success := (v_http_status >= 200 AND v_http_status < 300);
        
        RAISE WARNING 'Accept HTTP Response: Status=%, Body=%', v_http_status, LEFT(v_http_response, 200);
        
        IF v_delivery_success THEN
            -- Immediate delivery succeeded
            UPDATE ap_activities 
            SET status = 'completed',
                last_attempt_at = NOW()
            WHERE id = v_activity_uuid;
            
            RAISE NOTICE '✅ Accept delivery succeeded to: % (HTTP %)', v_follower_domain, v_http_status;
            
            -- Also mark the original Follow as completed/accepted
            UPDATE ap_activities
            SET status = 'completed'
            WHERE id = follow_activity_id;
            
        ELSE
            -- Immediate delivery failed, queue for retry
            UPDATE ap_activities 
            SET status = 'failed',
                attempts = 1,
                last_attempt_at = NOW(),
                error_message = format('HTTP %s: %s', v_http_status, LEFT(v_http_response, 500))
            WHERE id = v_activity_uuid;
            
            RAISE WARNING '❌ Accept delivery failed to % (HTTP %): %', 
                v_follower_domain, v_http_status, LEFT(v_http_response, 200);
            
            -- Queue for retry
            PERFORM queue_activity_for_federation(v_activity_uuid, ARRAY[v_follower_domain], 8, true);
        END IF;
        
    EXCEPTION 
        WHEN OTHERS THEN
            -- HTTP extension not available or network error, queue for delivery
            UPDATE ap_activities 
            SET status = 'failed',
                error_message = 'HTTP delivery failed: ' || SQLERRM
            WHERE id = v_activity_uuid;
            
            RAISE WARNING '💥 Accept HTTP delivery exception to % - Error: %', v_follower_domain, SQLERRM;
            PERFORM queue_activity_for_federation(v_activity_uuid, ARRAY[v_follower_domain], 8, true);
    END;
    
END;
$$;


--
-- Name: FUNCTION send_accept_activity_for_follow(follow_activity_id uuid, local_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.send_accept_activity_for_follow(follow_activity_id uuid, local_user_id uuid) IS 'Sends an Accept activity back to a remote follower via HTTP POST with proper signatures. Used for auto-accepting follow requests.';


--
-- Name: send_notification(character varying, uuid[], jsonb, uuid, uuid, uuid, uuid, character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.send_notification(notification_type character varying, to_user_ids uuid[], notification_data jsonb DEFAULT '{}'::jsonb, server_id uuid DEFAULT NULL::uuid, channel_id uuid DEFAULT NULL::uuid, conversation_id uuid DEFAULT NULL::uuid, from_user_id uuid DEFAULT NULL::uuid, priority character varying DEFAULT 'normal'::character varying) RETURNS uuid[]
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    created_notification_ids uuid[] := '{}';
    recipient_id uuid;
    user_prefs record;
    should_send boolean;
    notification_id uuid;
    current_timestamp timestamp with time zone := now();
    enhanced_data jsonb;
BEGIN
    -- Validate inputs
    IF notification_type IS NULL OR array_length(to_user_ids, 1) IS NULL THEN
        RETURN '{}';
    END IF;

    -- Process each recipient
    FOREACH recipient_id IN ARRAY to_user_ids LOOP
        -- Skip if sending to self (optional check)
        IF from_user_id IS NOT NULL AND recipient_id = from_user_id THEN
            CONTINUE;
        END IF;

        -- Get user notification preferences if table exists
        user_prefs := NULL;
        BEGIN
            SELECT * INTO user_prefs FROM notification_preferences WHERE user_id = recipient_id;
        EXCEPTION
            WHEN undefined_table THEN
                -- notification_preferences table doesn't exist, send all notifications
                user_prefs := NULL;
        END;

        -- Default to sending notifications if no preferences found
        should_send := true;

        -- Apply preferences if they exist
        IF user_prefs IS NOT NULL THEN
            -- ✅ FIXED: Use ACTUAL column names from notification_preferences table
            CASE notification_type
                WHEN 'mention' THEN
                    should_send := COALESCE(user_prefs.desktop_mentions, true);
                WHEN 'reply' THEN
                    should_send := COALESCE(user_prefs.desktop_replies, true);
                WHEN 'dm' THEN
                    should_send := COALESCE(user_prefs.desktop_dms, true);
                WHEN 'reaction' THEN
                    should_send := COALESCE(user_prefs.desktop_reactions, true);
                WHEN 'activitypub_follow' THEN
                    should_send := COALESCE(user_prefs.activitypub_desktop_follows, true);
                WHEN 'activitypub_favorite' THEN
                    should_send := COALESCE(user_prefs.activitypub_desktop_favorites, true);
                WHEN 'activitypub_reblog' THEN
                    should_send := COALESCE(user_prefs.activitypub_desktop_reblogs, true);
                WHEN 'activitypub_mention' THEN
                    should_send := COALESCE(user_prefs.activitypub_desktop_mentions, true);
                WHEN 'activitypub_reply' THEN
                    should_send := COALESCE(user_prefs.activitypub_desktop_replies, true);
                ELSE
                    should_send := true; -- Default to sending for unknown types
            END CASE;

            -- Apply DND restrictions if configured
            IF user_prefs.dnd_enabled IS TRUE THEN
                IF current_timestamp::time BETWEEN 
                   COALESCE(user_prefs.dnd_start_time, '22:00'::time) AND 
                   COALESCE(user_prefs.dnd_end_time, '08:00'::time) THEN
                    should_send := false;
                END IF;
            END IF;
        END IF;

        -- Create enhanced notification data with context
        enhanced_data := notification_data;
        
        -- Add context information to the data field since we can't use separate columns
        IF server_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('server_id', server_id);
        END IF;
        
        IF channel_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('channel_id', channel_id);
        END IF;
        
        IF conversation_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('conversation_id', conversation_id);
        END IF;
        
        IF from_user_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('from_user_id', from_user_id);
        END IF;
        
        IF priority IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('priority', priority);
        END IF;

        -- Create notification if should send - using ONLY existing columns
        IF should_send THEN
            INSERT INTO notifications (
                type,
                user_id,
                data,
                created_at
            ) VALUES (
                notification_type,
                recipient_id,
                enhanced_data,
                current_timestamp
            ) RETURNING id INTO notification_id;

            created_notification_ids := array_append(created_notification_ids, notification_id);
            
            RAISE NOTICE '✅ Notification sent: type=% to_user=% id=%', notification_type, recipient_id, notification_id;
        ELSE
            RAISE NOTICE '🔇 Notification skipped (user preferences): type=% to_user=%', notification_type, recipient_id;
        END IF;

    END LOOP;

    RETURN created_notification_ids;
END;
$$;


--
-- Name: FUNCTION send_notification(notification_type character varying, to_user_ids uuid[], notification_data jsonb, server_id uuid, channel_id uuid, conversation_id uuid, from_user_id uuid, priority character varying); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.send_notification(notification_type character varying, to_user_ids uuid[], notification_data jsonb, server_id uuid, channel_id uuid, conversation_id uuid, from_user_id uuid, priority character varying) IS 'FIXED: Uses ACTUAL notification_preferences column names (desktop_dms, desktop_mentions, etc.) instead of made-up field names.';


--
-- Name: send_notification_to_followers(character varying, uuid, jsonb, uuid, character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.send_notification_to_followers(notification_type character varying, target_user_id uuid, notification_data jsonb DEFAULT '{}'::jsonb, from_user_id uuid DEFAULT NULL::uuid, priority character varying DEFAULT 'normal'::character varying) RETURNS uuid[]
    LANGUAGE plpgsql
    AS $$
DECLARE
    follower_ids uuid[];
BEGIN
    -- Get all followers
    SELECT array_agg(follower_id)
    INTO follower_ids
    FROM follows f
    WHERE f.following_id = target_user_id
    AND f.status = 'accepted';

    -- Send notifications to all followers
    RETURN send_notification(
        notification_type,
        follower_ids,
        notification_data,
        NULL,
        NULL,
        NULL,
        from_user_id,
        priority
    );
END;
$$;


--
-- Name: FUNCTION send_notification_to_followers(notification_type character varying, target_user_id uuid, notification_data jsonb, from_user_id uuid, priority character varying); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.send_notification_to_followers(notification_type character varying, target_user_id uuid, notification_data jsonb, from_user_id uuid, priority character varying) IS 'Send notifications to all followers of a user.';


--
-- Name: send_notification_to_server_members(character varying, uuid, jsonb, uuid, uuid, uuid[], character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.send_notification_to_server_members(notification_type character varying, target_server_id uuid, notification_data jsonb DEFAULT '{}'::jsonb, channel_id uuid DEFAULT NULL::uuid, from_user_id uuid DEFAULT NULL::uuid, exclude_user_ids uuid[] DEFAULT '{}'::uuid[], priority character varying DEFAULT 'normal'::character varying) RETURNS uuid[]
    LANGUAGE plpgsql
    AS $$
DECLARE
    server_member_ids uuid[];
BEGIN
    -- Get all server members
    SELECT array_agg(user_id)
    INTO server_member_ids
    FROM user_servers us
    WHERE us.server_id = target_server_id
    AND (exclude_user_ids IS NULL OR NOT (us.user_id = ANY(exclude_user_ids)));

    -- Send notifications to all members
    RETURN send_notification(
        notification_type,
        server_member_ids,
        notification_data,
        target_server_id,
        channel_id,
        NULL,
        from_user_id,
        priority
    );
END;
$$;


--
-- Name: FUNCTION send_notification_to_server_members(notification_type character varying, target_server_id uuid, notification_data jsonb, channel_id uuid, from_user_id uuid, exclude_user_ids uuid[], priority character varying); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.send_notification_to_server_members(notification_type character varying, target_server_id uuid, notification_data jsonb, channel_id uuid, from_user_id uuid, exclude_user_ids uuid[], priority character varying) IS 'Send notifications to all members of a server, with optional exclusions.';


--
-- Name: send_notification_to_user(character varying, uuid, jsonb, uuid, uuid, uuid, uuid, character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.send_notification_to_user(notification_type character varying, to_user_id uuid, notification_data jsonb DEFAULT '{}'::jsonb, server_id uuid DEFAULT NULL::uuid, channel_id uuid DEFAULT NULL::uuid, conversation_id uuid DEFAULT NULL::uuid, from_user_id uuid DEFAULT NULL::uuid, priority character varying DEFAULT 'normal'::character varying) RETURNS uuid
    LANGUAGE sql SECURITY DEFINER
    AS $$
    SELECT (send_notification(
        notification_type,
        ARRAY[to_user_id],
        notification_data,
        server_id,
        channel_id,
        conversation_id,
        from_user_id,
        priority
    ))[1];
$$;


--
-- Name: FUNCTION send_notification_to_user(notification_type character varying, to_user_id uuid, notification_data jsonb, server_id uuid, channel_id uuid, conversation_id uuid, from_user_id uuid, priority character varying); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.send_notification_to_user(notification_type character varying, to_user_id uuid, notification_data jsonb, server_id uuid, channel_id uuid, conversation_id uuid, from_user_id uuid, priority character varying) IS 'SECURITY DEFINER: Helper function for single user notifications with elevated privileges.';


--
-- Name: server_has_remote_members(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.server_has_remote_members(p_server_id uuid) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT EXISTS(
    SELECT 1 
    FROM user_servers us
    JOIN profiles p ON us.user_id = p.id
    WHERE us.server_id = p_server_id
      AND p.is_local = false
      AND us.status = 'accepted'
  );
$$;


--
-- Name: FUNCTION server_has_remote_members(p_server_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.server_has_remote_members(p_server_id uuid) IS 'Check if server has any remote (federated) members';


--
-- Name: set_instance_config(uuid, text, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_instance_config(p_admin_id uuid, p_key text, p_value jsonb, p_description text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    old_value JSONB;
BEGIN
    -- Check if admin has permission
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_admin_id AND is_admin = TRUE) THEN
        RAISE EXCEPTION 'Insufficient permissions';
    END IF;
    
    -- Get old value for logging
    SELECT config_value INTO old_value FROM instance_config WHERE config_key = p_key;
    
    -- Update or insert configuration
    INSERT INTO instance_config (config_key, config_value, description, updated_by, updated_at)
    VALUES (p_key, p_value, p_description, p_admin_id, NOW())
    ON CONFLICT (config_key) DO UPDATE SET
        config_value = p_value,
        description = COALESCE(p_description, instance_config.description),
        updated_by = p_admin_id,
        updated_at = NOW();
    
    -- Log the action
    PERFORM log_admin_action(
        p_admin_id,
        'config_change',
        'config',
        p_key,
        json_build_object(
            'old_value', old_value,
            'new_value', p_value,
            'key', p_key
        )
    );
    
    RETURN TRUE;
END;
$$;


--
-- Name: set_member_instance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_member_instance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Auto-populate member_instance from user's domain
  SELECT domain INTO NEW.member_instance
  FROM profiles
  WHERE id = NEW.user_id;
  
  RETURN NEW;
END;
$$;


--
-- Name: should_create_notification(uuid, character varying, uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.should_create_notification(p_user_id uuid, p_type character varying, p_server_id uuid DEFAULT NULL::uuid, p_channel_id uuid DEFAULT NULL::uuid, p_conversation_id uuid DEFAULT NULL::uuid) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- For now, always allow notifications
    -- This can be enhanced later with user preferences
    RETURN TRUE;
END;
$$;


--
-- Name: FUNCTION should_create_notification(p_user_id uuid, p_type character varying, p_server_id uuid, p_channel_id uuid, p_conversation_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.should_create_notification(p_user_id uuid, p_type character varying, p_server_id uuid, p_channel_id uuid, p_conversation_id uuid) IS 'Checks user preferences and channel settings to determine if a notification should be created';


--
-- Name: strip_dm_mentions(jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.strip_dm_mentions(content jsonb, local_instance_domain text) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    result jsonb := '[]'::jsonb;
    part jsonb;
    is_first_mention boolean := true;
BEGIN
    -- For DMs, we want to strip mentions at the beginning since they're contextual
    -- This is APPLICATION logic, not CONVERSION logic!
    
    FOR part IN SELECT jsonb_array_elements(content)
    LOOP
        -- Skip leading mentions in DMs (they're implied by conversation context)
        IF (part->>'type') = 'mention' AND is_first_mention THEN
            -- Check if this is a local mention (recipient)
            IF (part->>'domain') = local_instance_domain OR (part->>'isLocal')::boolean = true THEN
                CONTINUE; -- Skip local mentions at start of DMs
            END IF;
        END IF;
        
        -- Once we hit non-mention content, stop skipping mentions
        IF (part->>'type') != 'mention' THEN
            is_first_mention := false;
        END IF;
        
        -- Add this part to result
        result := result || part;
    END LOOP;
    
    RETURN result;
END;
$$;


--
-- Name: FUNCTION strip_dm_mentions(content jsonb, local_instance_domain text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.strip_dm_mentions(content jsonb, local_instance_domain text) IS 'APPLICATION LOGIC: Strip leading local mentions from DM content. This is separate from universal content conversion.';


--
-- Name: strip_mentions_from_dm_content(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.strip_mentions_from_dm_content(content jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    result_array jsonb := '[]'::jsonb;
    content_item jsonb;
BEGIN
    -- Handle null or non-array content
    IF content IS NULL OR jsonb_typeof(content) != 'array' THEN
        RETURN content;
    END IF;
    
    -- Filter out mention objects, keep everything else
    FOR content_item IN SELECT jsonb_array_elements(content)
    LOOP
        IF content_item->>'type' != 'mention' THEN
            result_array := result_array || jsonb_build_array(content_item);
        END IF;
    END LOOP;
    
    RETURN result_array;
END;
$$;


--
-- Name: update_follow_counters(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_follow_counters() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Handle different trigger events
    IF TG_OP = 'INSERT' THEN
        -- New follow relationship
        IF NEW.status = 'accepted' THEN
            -- Increment follower count for the followed user
            UPDATE profiles 
            SET followers_count = followers_count + 1 
            WHERE id = NEW.following_id;
            
            -- Increment following count for the follower
            UPDATE profiles 
            SET following_count = following_count + 1 
            WHERE id = NEW.follower_id;
        END IF;
        RETURN NEW;
        
    ELSIF TG_OP = 'UPDATE' THEN
        -- Follow status changed
        IF OLD.status != NEW.status THEN
            IF OLD.status = 'accepted' AND NEW.status != 'accepted' THEN
                -- Follow was accepted, now it's not (unfriend/reject)
                UPDATE profiles 
                SET followers_count = followers_count - 1 
                WHERE id = NEW.following_id;
                
                UPDATE profiles 
                SET following_count = following_count - 1 
                WHERE id = NEW.follower_id;
                
            ELSIF OLD.status != 'accepted' AND NEW.status = 'accepted' THEN
                -- Follow was not accepted, now it is
                UPDATE profiles 
                SET followers_count = followers_count + 1 
                WHERE id = NEW.following_id;
                
                UPDATE profiles 
                SET following_count = following_count + 1 
                WHERE id = NEW.follower_id;
            END IF;
        END IF;
        RETURN NEW;
        
    ELSIF TG_OP = 'DELETE' THEN
        -- Follow relationship deleted
        IF OLD.status = 'accepted' THEN
            UPDATE profiles 
            SET followers_count = followers_count - 1 
            WHERE id = OLD.following_id;
            
            UPDATE profiles 
            SET following_count = following_count - 1 
            WHERE id = OLD.follower_id;
        END IF;
        RETURN OLD;
    END IF;
    
    RETURN NULL;
END;
$$;


--
-- Name: update_group_icon(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_group_icon(conversation_uuid uuid, user_profile_id uuid, icon_path text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  is_participant BOOLEAN := false;
  conversation_exists BOOLEAN := false;
BEGIN
  -- Check if user is a participant in the conversation
  SELECT can_manage_group_icon(conversation_uuid, user_profile_id) INTO is_participant;
  
  IF NOT is_participant THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'User is not a participant in this conversation'
    );
  END IF;
  
  -- Check if conversation exists and is a group
  SELECT EXISTS(
    SELECT 1 FROM conversations 
    WHERE id = conversation_uuid AND type = 'group'
  ) INTO conversation_exists;
  
  IF NOT conversation_exists THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Group conversation not found'
    );
  END IF;
  
  -- Update the conversation metadata with the new icon path
  UPDATE conversations 
  SET 
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('icon_url', icon_path),
    updated_at = CURRENT_TIMESTAMP
  WHERE id = conversation_uuid
    AND type = 'group';
  
  RETURN jsonb_build_object(
    'success', true,
    'message', 'Group icon updated successfully'
  );
END;
$$;


--
-- Name: update_group_name(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_group_name(conversation_uuid uuid, user_profile_id uuid, new_name text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  is_participant BOOLEAN := false;
  conversation_exists BOOLEAN := false;
BEGIN
  -- Check if user is a participant in the conversation
  SELECT can_manage_group_icon(conversation_uuid, user_profile_id) INTO is_participant;
  
  IF NOT is_participant THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'User is not a participant in this conversation'
    );
  END IF;
  
  -- Check if conversation exists and is a group
  SELECT EXISTS(
    SELECT 1 FROM conversations 
    WHERE id = conversation_uuid AND type = 'group'
  ) INTO conversation_exists;
  
  IF NOT conversation_exists THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Group conversation not found'
    );
  END IF;
  
  -- Update the conversation name
  UPDATE conversations 
  SET 
    name = new_name,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = conversation_uuid
    AND type = 'group';
  
  RETURN jsonb_build_object(
    'success', true,
    'message', 'Group name updated successfully'
  );
END;
$$;


--
-- Name: update_post_counters(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_post_counters() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Increment counter
    UPDATE posts
    SET 
      replies_count = replies_count + 1,
      updated_at = NOW()
    WHERE id = NEW.in_reply_to;
  ELSIF TG_OP = 'DELETE' THEN
    -- Decrement counter
    UPDATE posts
    SET 
      replies_count = GREATEST(0, replies_count - 1),
      updated_at = NOW()
    WHERE id = OLD.in_reply_to;
  END IF;
  
  RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: FUNCTION update_post_counters(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.update_post_counters() IS 'Automatically update post counters (replies, reactions, etc.)';


--
-- Name: update_reply_counts(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_reply_counts() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.in_reply_to IS NOT NULL THEN
        UPDATE posts SET replies_count = replies_count + 1
        WHERE id = NEW.in_reply_to;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' AND OLD.in_reply_to IS NOT NULL THEN
        UPDATE posts SET replies_count = replies_count - 1
        WHERE id = OLD.in_reply_to;
        RETURN OLD;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: upsert_ap_activity(text, text, text, jsonb, text, text[], text[], text[], text[], boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.upsert_ap_activity(p_ap_id text, p_ap_type text, p_actor_ap_id text, p_activity_data jsonb, p_origin_domain text DEFAULT NULL::text, p_to_addresses text[] DEFAULT '{}'::text[], p_cc_addresses text[] DEFAULT '{}'::text[], p_bto_addresses text[] DEFAULT '{}'::text[], p_bcc_addresses text[] DEFAULT '{}'::text[], p_is_local boolean DEFAULT false) RETURNS TABLE(activity_id uuid, was_updated boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_activity_id UUID;
    v_was_updated BOOLEAN := FALSE;
    v_existing_status TEXT;
BEGIN
    -- Check if activity already exists
    SELECT id, status INTO v_activity_id, v_existing_status
    FROM ap_activities 
    WHERE ap_id = p_ap_id;
    
    IF v_activity_id IS NOT NULL THEN
        -- Activity exists, check its status
        CASE v_existing_status
            WHEN 'completed', 'processed' THEN
                -- Already processed successfully, return idempotent success
                RAISE NOTICE 'Activity % already processed, returning existing ID', p_ap_id;
                v_was_updated := FALSE;
            WHEN 'failed', 'pending' THEN
                -- Failed or pending, update with fresh data for retry
                UPDATE ap_activities 
                SET 
                    activity_data = p_activity_data,
                    status = 'received',
                    to_addresses = p_to_addresses,
                    cc_addresses = p_cc_addresses,
                    bto_addresses = p_bto_addresses,
                    bcc_addresses = p_bcc_addresses,
                    updated_at = NOW(),
                    error_message = NULL,
                    next_attempt_at = NULL,
                    attempts = 0
                WHERE ap_id = p_ap_id;
                
                RAISE NOTICE 'Updated existing activity % for retry', p_ap_id;
                v_was_updated := TRUE;
            WHEN 'processing', 'received' THEN
                -- Currently being processed or just received, update data but keep status
                UPDATE ap_activities 
                SET 
                    activity_data = p_activity_data,
                    to_addresses = p_to_addresses,
                    cc_addresses = p_cc_addresses,
                    bto_addresses = p_bto_addresses,
                    bcc_addresses = p_bcc_addresses,
                    updated_at = NOW()
                WHERE ap_id = p_ap_id;
                
                RAISE NOTICE 'Updated activity data for currently processing activity %', p_ap_id;
                v_was_updated := TRUE;
        END CASE;
    ELSE
        -- Activity doesn't exist, insert new one
        INSERT INTO ap_activities (
            ap_id,
            ap_type,
            actor_ap_id,
            activity_data,
            origin_domain,
            status,
            is_local,
            to_addresses,
            cc_addresses,
            bto_addresses,
            bcc_addresses
        ) VALUES (
            p_ap_id,
            p_ap_type,
            p_actor_ap_id,
            p_activity_data,
            p_origin_domain,
            'received',
            p_is_local,
            p_to_addresses,
            p_cc_addresses,
            p_bto_addresses,
            p_bcc_addresses
        )
        RETURNING id INTO v_activity_id;
        
        RAISE NOTICE 'Inserted new activity %', p_ap_id;
        v_was_updated := FALSE;
    END IF;
    
    RETURN QUERY SELECT v_activity_id, v_was_updated;
END;
$$;


--
-- Name: FUNCTION upsert_ap_activity(p_ap_id text, p_ap_type text, p_actor_ap_id text, p_activity_data jsonb, p_origin_domain text, p_to_addresses text[], p_cc_addresses text[], p_bto_addresses text[], p_bcc_addresses text[], p_is_local boolean); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.upsert_ap_activity(p_ap_id text, p_ap_type text, p_actor_ap_id text, p_activity_data jsonb, p_origin_domain text, p_to_addresses text[], p_cc_addresses text[], p_bto_addresses text[], p_bcc_addresses text[], p_is_local boolean) IS 'Safely inserts or updates ActivityPub activities with idempotent behavior. Returns the activity ID and whether it was updated.';


--
-- Name: apply_rls(jsonb, integer); Type: FUNCTION; Schema: realtime; Owner: -
--

CREATE FUNCTION realtime.apply_rls(wal jsonb, max_record_bytes integer DEFAULT (1024 * 1024)) RETURNS SETOF realtime.wal_rls
    LANGUAGE plpgsql
    AS $$
declare
-- Regclass of the table e.g. public.notes
entity_ regclass = (quote_ident(wal ->> 'schema') || '.' || quote_ident(wal ->> 'table'))::regclass;

-- I, U, D, T: insert, update ...
action realtime.action = (
    case wal ->> 'action'
        when 'I' then 'INSERT'
        when 'U' then 'UPDATE'
        when 'D' then 'DELETE'
        else 'ERROR'
    end
);

-- Is row level security enabled for the table
is_rls_enabled bool = relrowsecurity from pg_class where oid = entity_;

subscriptions realtime.subscription[] = array_agg(subs)
    from
        realtime.subscription subs
    where
        subs.entity = entity_;

-- Subscription vars
roles regrole[] = array_agg(distinct us.claims_role::text)
    from
        unnest(subscriptions) us;

working_role regrole;
claimed_role regrole;
claims jsonb;

subscription_id uuid;
subscription_has_access bool;
visible_to_subscription_ids uuid[] = '{}';

-- structured info for wal's columns
columns realtime.wal_column[];
-- previous identity values for update/delete
old_columns realtime.wal_column[];

error_record_exceeds_max_size boolean = octet_length(wal::text) > max_record_bytes;

-- Primary jsonb output for record
output jsonb;

begin
perform set_config('role', null, true);

columns =
    array_agg(
        (
            x->>'name',
            x->>'type',
            x->>'typeoid',
            realtime.cast(
                (x->'value') #>> '{}',
                coalesce(
                    (x->>'typeoid')::regtype, -- null when wal2json version <= 2.4
                    (x->>'type')::regtype
                )
            ),
            (pks ->> 'name') is not null,
            true
        )::realtime.wal_column
    )
    from
        jsonb_array_elements(wal -> 'columns') x
        left join jsonb_array_elements(wal -> 'pk') pks
            on (x ->> 'name') = (pks ->> 'name');

old_columns =
    array_agg(
        (
            x->>'name',
            x->>'type',
            x->>'typeoid',
            realtime.cast(
                (x->'value') #>> '{}',
                coalesce(
                    (x->>'typeoid')::regtype, -- null when wal2json version <= 2.4
                    (x->>'type')::regtype
                )
            ),
            (pks ->> 'name') is not null,
            true
        )::realtime.wal_column
    )
    from
        jsonb_array_elements(wal -> 'identity') x
        left join jsonb_array_elements(wal -> 'pk') pks
            on (x ->> 'name') = (pks ->> 'name');

for working_role in select * from unnest(roles) loop

    -- Update `is_selectable` for columns and old_columns
    columns =
        array_agg(
            (
                c.name,
                c.type_name,
                c.type_oid,
                c.value,
                c.is_pkey,
                pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
            )::realtime.wal_column
        )
        from
            unnest(columns) c;

    old_columns =
            array_agg(
                (
                    c.name,
                    c.type_name,
                    c.type_oid,
                    c.value,
                    c.is_pkey,
                    pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
                )::realtime.wal_column
            )
            from
                unnest(old_columns) c;

    if action <> 'DELETE' and count(1) = 0 from unnest(columns) c where c.is_pkey then
        return next (
            jsonb_build_object(
                'schema', wal ->> 'schema',
                'table', wal ->> 'table',
                'type', action
            ),
            is_rls_enabled,
            -- subscriptions is already filtered by entity
            (select array_agg(s.subscription_id) from unnest(subscriptions) as s where claims_role = working_role),
            array['Error 400: Bad Request, no primary key']
        )::realtime.wal_rls;

    -- The claims role does not have SELECT permission to the primary key of entity
    elsif action <> 'DELETE' and sum(c.is_selectable::int) <> count(1) from unnest(columns) c where c.is_pkey then
        return next (
            jsonb_build_object(
                'schema', wal ->> 'schema',
                'table', wal ->> 'table',
                'type', action
            ),
            is_rls_enabled,
            (select array_agg(s.subscription_id) from unnest(subscriptions) as s where claims_role = working_role),
            array['Error 401: Unauthorized']
        )::realtime.wal_rls;

    else
        output = jsonb_build_object(
            'schema', wal ->> 'schema',
            'table', wal ->> 'table',
            'type', action,
            'commit_timestamp', to_char(
                ((wal ->> 'timestamp')::timestamptz at time zone 'utc'),
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ),
            'columns', (
                select
                    jsonb_agg(
                        jsonb_build_object(
                            'name', pa.attname,
                            'type', pt.typname
                        )
                        order by pa.attnum asc
                    )
                from
                    pg_attribute pa
                    join pg_type pt
                        on pa.atttypid = pt.oid
                where
                    attrelid = entity_
                    and attnum > 0
                    and pg_catalog.has_column_privilege(working_role, entity_, pa.attname, 'SELECT')
            )
        )
        -- Add "record" key for insert and update
        || case
            when action in ('INSERT', 'UPDATE') then
                jsonb_build_object(
                    'record',
                    (
                        select
                            jsonb_object_agg(
                                -- if unchanged toast, get column name and value from old record
                                coalesce((c).name, (oc).name),
                                case
                                    when (c).name is null then (oc).value
                                    else (c).value
                                end
                            )
                        from
                            unnest(columns) c
                            full outer join unnest(old_columns) oc
                                on (c).name = (oc).name
                        where
                            coalesce((c).is_selectable, (oc).is_selectable)
                            and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                    )
                )
            else '{}'::jsonb
        end
        -- Add "old_record" key for update and delete
        || case
            when action = 'UPDATE' then
                jsonb_build_object(
                        'old_record',
                        (
                            select jsonb_object_agg((c).name, (c).value)
                            from unnest(old_columns) c
                            where
                                (c).is_selectable
                                and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                        )
                    )
            when action = 'DELETE' then
                jsonb_build_object(
                    'old_record',
                    (
                        select jsonb_object_agg((c).name, (c).value)
                        from unnest(old_columns) c
                        where
                            (c).is_selectable
                            and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                            and ( not is_rls_enabled or (c).is_pkey ) -- if RLS enabled, we can't secure deletes so filter to pkey
                    )
                )
            else '{}'::jsonb
        end;

        -- Create the prepared statement
        if is_rls_enabled and action <> 'DELETE' then
            if (select 1 from pg_prepared_statements where name = 'walrus_rls_stmt' limit 1) > 0 then
                deallocate walrus_rls_stmt;
            end if;
            execute realtime.build_prepared_statement_sql('walrus_rls_stmt', entity_, columns);
        end if;

        visible_to_subscription_ids = '{}';

        for subscription_id, claims in (
                select
                    subs.subscription_id,
                    subs.claims
                from
                    unnest(subscriptions) subs
                where
                    subs.entity = entity_
                    and subs.claims_role = working_role
                    and (
                        realtime.is_visible_through_filters(columns, subs.filters)
                        or (
                          action = 'DELETE'
                          and realtime.is_visible_through_filters(old_columns, subs.filters)
                        )
                    )
        ) loop

            if not is_rls_enabled or action = 'DELETE' then
                visible_to_subscription_ids = visible_to_subscription_ids || subscription_id;
            else
                -- Check if RLS allows the role to see the record
                perform
                    -- Trim leading and trailing quotes from working_role because set_config
                    -- doesn't recognize the role as valid if they are included
                    set_config('role', trim(both '"' from working_role::text), true),
                    set_config('request.jwt.claims', claims::text, true);

                execute 'execute walrus_rls_stmt' into subscription_has_access;

                if subscription_has_access then
                    visible_to_subscription_ids = visible_to_subscription_ids || subscription_id;
                end if;
            end if;
        end loop;

        perform set_config('role', null, true);

        return next (
            output,
            is_rls_enabled,
            visible_to_subscription_ids,
            case
                when error_record_exceeds_max_size then array['Error 413: Payload Too Large']
                else '{}'
            end
        )::realtime.wal_rls;

    end if;
end loop;

perform set_config('role', null, true);
end;
$$;


--
-- Name: broadcast_changes(text, text, text, text, text, record, record, text); Type: FUNCTION; Schema: realtime; Owner: -
--

CREATE FUNCTION realtime.broadcast_changes(topic_name text, event_name text, operation text, table_name text, table_schema text, new record, old record, level text DEFAULT 'ROW'::text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    -- Declare a variable to hold the JSONB representation of the row
    row_data jsonb := '{}'::jsonb;
BEGIN
    IF level = 'STATEMENT' THEN
        RAISE EXCEPTION 'function can only be triggered for each row, not for each statement';
    END IF;
    -- Check the operation type and handle accordingly
    IF operation = 'INSERT' OR operation = 'UPDATE' OR operation = 'DELETE' THEN
        row_data := jsonb_build_object('old_record', OLD, 'record', NEW, 'operation', operation, 'table', table_name, 'schema', table_schema);
        PERFORM realtime.send (row_data, event_name, topic_name);
    ELSE
        RAISE EXCEPTION 'Unexpected operation type: %', operation;
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Failed to process the row: %', SQLERRM;
END;

$$;


--
-- Name: build_prepared_statement_sql(text, regclass, realtime.wal_column[]); Type: FUNCTION; Schema: realtime; Owner: -
--

CREATE FUNCTION realtime.build_prepared_statement_sql(prepared_statement_name text, entity regclass, columns realtime.wal_column[]) RETURNS text
    LANGUAGE sql
    AS $$
      /*
      Builds a sql string that, if executed, creates a prepared statement to
      tests retrive a row from *entity* by its primary key columns.
      Example
          select realtime.build_prepared_statement_sql('public.notes', '{"id"}'::text[], '{"bigint"}'::text[])
      */
          select
      'prepare ' || prepared_statement_name || ' as
          select
              exists(
                  select
                      1
                  from
                      ' || entity || '
                  where
                      ' || string_agg(quote_ident(pkc.name) || '=' || quote_nullable(pkc.value #>> '{}') , ' and ') || '
              )'
          from
              unnest(columns) pkc
          where
              pkc.is_pkey
          group by
              entity
      $$;


--
-- Name: cast(text, regtype); Type: FUNCTION; Schema: realtime; Owner: -
--

CREATE FUNCTION realtime."cast"(val text, type_ regtype) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
    declare
      res jsonb;
    begin
      execute format('select to_jsonb(%L::'|| type_::text || ')', val)  into res;
      return res;
    end
    $$;


--
-- Name: check_equality_op(realtime.equality_op, regtype, text, text); Type: FUNCTION; Schema: realtime; Owner: -
--

CREATE FUNCTION realtime.check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
      /*
      Casts *val_1* and *val_2* as type *type_* and check the *op* condition for truthiness
      */
      declare
          op_symbol text = (
              case
                  when op = 'eq' then '='
                  when op = 'neq' then '!='
                  when op = 'lt' then '<'
                  when op = 'lte' then '<='
                  when op = 'gt' then '>'
                  when op = 'gte' then '>='
                  when op = 'in' then '= any'
                  else 'UNKNOWN OP'
              end
          );
          res boolean;
      begin
          execute format(
              'select %L::'|| type_::text || ' ' || op_symbol
              || ' ( %L::'
              || (
                  case
                      when op = 'in' then type_::text || '[]'
                      else type_::text end
              )
              || ')', val_1, val_2) into res;
          return res;
      end;
      $$;


--
-- Name: is_visible_through_filters(realtime.wal_column[], realtime.user_defined_filter[]); Type: FUNCTION; Schema: realtime; Owner: -
--

CREATE FUNCTION realtime.is_visible_through_filters(columns realtime.wal_column[], filters realtime.user_defined_filter[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $_$
    /*
    Should the record be visible (true) or filtered out (false) after *filters* are applied
    */
        select
            -- Default to allowed when no filters present
            $2 is null -- no filters. this should not happen because subscriptions has a default
            or array_length($2, 1) is null -- array length of an empty array is null
            or bool_and(
                coalesce(
                    realtime.check_equality_op(
                        op:=f.op,
                        type_:=coalesce(
                            col.type_oid::regtype, -- null when wal2json version <= 2.4
                            col.type_name::regtype
                        ),
                        -- cast jsonb to text
                        val_1:=col.value #>> '{}',
                        val_2:=f.value
                    ),
                    false -- if null, filter does not match
                )
            )
        from
            unnest(filters) f
            join unnest(columns) col
                on f.column_name = col.name;
    $_$;


--
-- Name: list_changes(name, name, integer, integer); Type: FUNCTION; Schema: realtime; Owner: -
--

CREATE FUNCTION realtime.list_changes(publication name, slot_name name, max_changes integer, max_record_bytes integer) RETURNS SETOF realtime.wal_rls
    LANGUAGE sql
    SET log_min_messages TO 'fatal'
    AS $$
      with pub as (
        select
          concat_ws(
            ',',
            case when bool_or(pubinsert) then 'insert' else null end,
            case when bool_or(pubupdate) then 'update' else null end,
            case when bool_or(pubdelete) then 'delete' else null end
          ) as w2j_actions,
          coalesce(
            string_agg(
              realtime.quote_wal2json(format('%I.%I', schemaname, tablename)::regclass),
              ','
            ) filter (where ppt.tablename is not null and ppt.tablename not like '% %'),
            ''
          ) w2j_add_tables
        from
          pg_publication pp
          left join pg_publication_tables ppt
            on pp.pubname = ppt.pubname
        where
          pp.pubname = publication
        group by
          pp.pubname
        limit 1
      ),
      w2j as (
        select
          x.*, pub.w2j_add_tables
        from
          pub,
          pg_logical_slot_get_changes(
            slot_name, null, max_changes,
            'include-pk', 'true',
            'include-transaction', 'false',
            'include-timestamp', 'true',
            'include-type-oids', 'true',
            'format-version', '2',
            'actions', pub.w2j_actions,
            'add-tables', pub.w2j_add_tables
          ) x
      )
      select
        xyz.wal,
        xyz.is_rls_enabled,
        xyz.subscription_ids,
        xyz.errors
      from
        w2j,
        realtime.apply_rls(
          wal := w2j.data::jsonb,
          max_record_bytes := max_record_bytes
        ) xyz(wal, is_rls_enabled, subscription_ids, errors)
      where
        w2j.w2j_add_tables <> ''
        and xyz.subscription_ids[1] is not null
    $$;


--
-- Name: quote_wal2json(regclass); Type: FUNCTION; Schema: realtime; Owner: -
--

CREATE FUNCTION realtime.quote_wal2json(entity regclass) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
      select
        (
          select string_agg('' || ch,'')
          from unnest(string_to_array(nsp.nspname::text, null)) with ordinality x(ch, idx)
          where
            not (x.idx = 1 and x.ch = '"')
            and not (
              x.idx = array_length(string_to_array(nsp.nspname::text, null), 1)
              and x.ch = '"'
            )
        )
        || '.'
        || (
          select string_agg('' || ch,'')
          from unnest(string_to_array(pc.relname::text, null)) with ordinality x(ch, idx)
          where
            not (x.idx = 1 and x.ch = '"')
            and not (
              x.idx = array_length(string_to_array(nsp.nspname::text, null), 1)
              and x.ch = '"'
            )
          )
      from
        pg_class pc
        join pg_namespace nsp
          on pc.relnamespace = nsp.oid
      where
        pc.oid = entity
    $$;


--
-- Name: send(jsonb, text, text, boolean); Type: FUNCTION; Schema: realtime; Owner: -
--

CREATE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean DEFAULT true) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  BEGIN
    -- Set the topic configuration
    EXECUTE format('SET LOCAL realtime.topic TO %L', topic);

    -- Attempt to insert the message
    INSERT INTO realtime.messages (payload, event, topic, private, extension)
    VALUES (payload, event, topic, private, 'broadcast');
  EXCEPTION
    WHEN OTHERS THEN
      -- Capture and notify the error
      PERFORM pg_notify(
          'realtime:system',
          jsonb_build_object(
              'error', SQLERRM,
              'function', 'realtime.send',
              'event', event,
              'topic', topic,
              'private', private
          )::text
      );
  END;
END;
$$;


--
-- Name: subscription_check_filters(); Type: FUNCTION; Schema: realtime; Owner: -
--

CREATE FUNCTION realtime.subscription_check_filters() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    /*
    Validates that the user defined filters for a subscription:
    - refer to valid columns that the claimed role may access
    - values are coercable to the correct column type
    */
    declare
        col_names text[] = coalesce(
                array_agg(c.column_name order by c.ordinal_position),
                '{}'::text[]
            )
            from
                information_schema.columns c
            where
                format('%I.%I', c.table_schema, c.table_name)::regclass = new.entity
                and pg_catalog.has_column_privilege(
                    (new.claims ->> 'role'),
                    format('%I.%I', c.table_schema, c.table_name)::regclass,
                    c.column_name,
                    'SELECT'
                );
        filter realtime.user_defined_filter;
        col_type regtype;

        in_val jsonb;
    begin
        for filter in select * from unnest(new.filters) loop
            -- Filtered column is valid
            if not filter.column_name = any(col_names) then
                raise exception 'invalid column for filter %', filter.column_name;
            end if;

            -- Type is sanitized and safe for string interpolation
            col_type = (
                select atttypid::regtype
                from pg_catalog.pg_attribute
                where attrelid = new.entity
                      and attname = filter.column_name
            );
            if col_type is null then
                raise exception 'failed to lookup type for column %', filter.column_name;
            end if;

            -- Set maximum number of entries for in filter
            if filter.op = 'in'::realtime.equality_op then
                in_val = realtime.cast(filter.value, (col_type::text || '[]')::regtype);
                if coalesce(jsonb_array_length(in_val), 0) > 100 then
                    raise exception 'too many values for `in` filter. Maximum 100';
                end if;
            else
                -- raises an exception if value is not coercable to type
                perform realtime.cast(filter.value, col_type);
            end if;

        end loop;

        -- Apply consistent order to filters so the unique constraint on
        -- (subscription_id, entity, filters) can't be tricked by a different filter order
        new.filters = coalesce(
            array_agg(f order by f.column_name, f.op, f.value),
            '{}'
        ) from unnest(new.filters) f;

        return new;
    end;
    $$;


--
-- Name: to_regrole(text); Type: FUNCTION; Schema: realtime; Owner: -
--

CREATE FUNCTION realtime.to_regrole(role_name text) RETURNS regrole
    LANGUAGE sql IMMUTABLE
    AS $$ select role_name::regrole $$;


--
-- Name: topic(); Type: FUNCTION; Schema: realtime; Owner: -
--

CREATE FUNCTION realtime.topic() RETURNS text
    LANGUAGE sql STABLE
    AS $$
select nullif(current_setting('realtime.topic', true), '')::text;
$$;


--
-- Name: add_prefixes(text, text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.add_prefixes(_bucket_id text, _name text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    prefixes text[];
BEGIN
    prefixes := "storage"."get_prefixes"("_name");

    IF array_length(prefixes, 1) > 0 THEN
        INSERT INTO storage.prefixes (name, bucket_id)
        SELECT UNNEST(prefixes) as name, "_bucket_id" ON CONFLICT DO NOTHING;
    END IF;
END;
$$;


--
-- Name: can_insert_object(text, text, uuid, jsonb); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.can_insert_object(bucketid text, name text, owner uuid, metadata jsonb) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO "storage"."objects" ("bucket_id", "name", "owner", "metadata") VALUES (bucketid, name, owner, metadata);
  -- hack to rollback the successful insert
  RAISE sqlstate 'PT200' using
  message = 'ROLLBACK',
  detail = 'rollback successful insert';
END
$$;


--
-- Name: delete_prefix(text, text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.delete_prefix(_bucket_id text, _name text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    -- Check if we can delete the prefix
    IF EXISTS(
        SELECT FROM "storage"."prefixes"
        WHERE "prefixes"."bucket_id" = "_bucket_id"
          AND level = "storage"."get_level"("_name") + 1
          AND "prefixes"."name" COLLATE "C" LIKE "_name" || '/%'
        LIMIT 1
    )
    OR EXISTS(
        SELECT FROM "storage"."objects"
        WHERE "objects"."bucket_id" = "_bucket_id"
          AND "storage"."get_level"("objects"."name") = "storage"."get_level"("_name") + 1
          AND "objects"."name" COLLATE "C" LIKE "_name" || '/%'
        LIMIT 1
    ) THEN
    -- There are sub-objects, skip deletion
    RETURN false;
    ELSE
        DELETE FROM "storage"."prefixes"
        WHERE "prefixes"."bucket_id" = "_bucket_id"
          AND level = "storage"."get_level"("_name")
          AND "prefixes"."name" = "_name";
        RETURN true;
    END IF;
END;
$$;


--
-- Name: delete_prefix_hierarchy_trigger(); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.delete_prefix_hierarchy_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    prefix text;
BEGIN
    prefix := "storage"."get_prefix"(OLD."name");

    IF coalesce(prefix, '') != '' THEN
        PERFORM "storage"."delete_prefix"(OLD."bucket_id", prefix);
    END IF;

    RETURN OLD;
END;
$$;


--
-- Name: enforce_bucket_name_length(); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.enforce_bucket_name_length() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    if length(new.name) > 100 then
        raise exception 'bucket name "%" is too long (% characters). Max is 100.', new.name, length(new.name);
    end if;
    return new;
end;
$$;


--
-- Name: extension(text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.extension(name text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    _parts text[];
    _filename text;
BEGIN
    SELECT string_to_array(name, '/') INTO _parts;
    SELECT _parts[array_length(_parts,1)] INTO _filename;
    RETURN reverse(split_part(reverse(_filename), '.', 1));
END
$$;


--
-- Name: filename(text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.filename(name text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
_parts text[];
BEGIN
	select string_to_array(name, '/') into _parts;
	return _parts[array_length(_parts,1)];
END
$$;


--
-- Name: foldername(text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.foldername(name text) RETURNS text[]
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    _parts text[];
BEGIN
    -- Split on "/" to get path segments
    SELECT string_to_array(name, '/') INTO _parts;
    -- Return everything except the last segment
    RETURN _parts[1 : array_length(_parts,1) - 1];
END
$$;


--
-- Name: get_level(text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.get_level(name text) RETURNS integer
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
SELECT array_length(string_to_array("name", '/'), 1);
$$;


--
-- Name: get_prefix(text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.get_prefix(name text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    AS $_$
SELECT
    CASE WHEN strpos("name", '/') > 0 THEN
             regexp_replace("name", '[\/]{1}[^\/]+\/?$', '')
         ELSE
             ''
        END;
$_$;


--
-- Name: get_prefixes(text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.get_prefixes(name text) RETURNS text[]
    LANGUAGE plpgsql IMMUTABLE STRICT
    AS $$
DECLARE
    parts text[];
    prefixes text[];
    prefix text;
BEGIN
    -- Split the name into parts by '/'
    parts := string_to_array("name", '/');
    prefixes := '{}';

    -- Construct the prefixes, stopping one level below the last part
    FOR i IN 1..array_length(parts, 1) - 1 LOOP
            prefix := array_to_string(parts[1:i], '/');
            prefixes := array_append(prefixes, prefix);
    END LOOP;

    RETURN prefixes;
END;
$$;


--
-- Name: get_size_by_bucket(); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.get_size_by_bucket() RETURNS TABLE(size bigint, bucket_id text)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    return query
        select sum((metadata->>'size')::bigint) as size, obj.bucket_id
        from "storage".objects as obj
        group by obj.bucket_id;
END
$$;


--
-- Name: list_multipart_uploads_with_delimiter(text, text, text, integer, text, text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.list_multipart_uploads_with_delimiter(bucket_id text, prefix_param text, delimiter_param text, max_keys integer DEFAULT 100, next_key_token text DEFAULT ''::text, next_upload_token text DEFAULT ''::text) RETURNS TABLE(key text, id text, created_at timestamp with time zone)
    LANGUAGE plpgsql
    AS $_$
BEGIN
    RETURN QUERY EXECUTE
        'SELECT DISTINCT ON(key COLLATE "C") * from (
            SELECT
                CASE
                    WHEN position($2 IN substring(key from length($1) + 1)) > 0 THEN
                        substring(key from 1 for length($1) + position($2 IN substring(key from length($1) + 1)))
                    ELSE
                        key
                END AS key, id, created_at
            FROM
                storage.s3_multipart_uploads
            WHERE
                bucket_id = $5 AND
                key ILIKE $1 || ''%'' AND
                CASE
                    WHEN $4 != '''' AND $6 = '''' THEN
                        CASE
                            WHEN position($2 IN substring(key from length($1) + 1)) > 0 THEN
                                substring(key from 1 for length($1) + position($2 IN substring(key from length($1) + 1))) COLLATE "C" > $4
                            ELSE
                                key COLLATE "C" > $4
                            END
                    ELSE
                        true
                END AND
                CASE
                    WHEN $6 != '''' THEN
                        id COLLATE "C" > $6
                    ELSE
                        true
                    END
            ORDER BY
                key COLLATE "C" ASC, created_at ASC) as e order by key COLLATE "C" LIMIT $3'
        USING prefix_param, delimiter_param, max_keys, next_key_token, bucket_id, next_upload_token;
END;
$_$;


--
-- Name: list_objects_with_delimiter(text, text, text, integer, text, text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.list_objects_with_delimiter(bucket_id text, prefix_param text, delimiter_param text, max_keys integer DEFAULT 100, start_after text DEFAULT ''::text, next_token text DEFAULT ''::text) RETURNS TABLE(name text, id uuid, metadata jsonb, updated_at timestamp with time zone)
    LANGUAGE plpgsql
    AS $_$
BEGIN
    RETURN QUERY EXECUTE
        'SELECT DISTINCT ON(name COLLATE "C") * from (
            SELECT
                CASE
                    WHEN position($2 IN substring(name from length($1) + 1)) > 0 THEN
                        substring(name from 1 for length($1) + position($2 IN substring(name from length($1) + 1)))
                    ELSE
                        name
                END AS name, id, metadata, updated_at
            FROM
                storage.objects
            WHERE
                bucket_id = $5 AND
                name ILIKE $1 || ''%'' AND
                CASE
                    WHEN $6 != '''' THEN
                    name COLLATE "C" > $6
                ELSE true END
                AND CASE
                    WHEN $4 != '''' THEN
                        CASE
                            WHEN position($2 IN substring(name from length($1) + 1)) > 0 THEN
                                substring(name from 1 for length($1) + position($2 IN substring(name from length($1) + 1))) COLLATE "C" > $4
                            ELSE
                                name COLLATE "C" > $4
                            END
                    ELSE
                        true
                END
            ORDER BY
                name COLLATE "C" ASC) as e order by name COLLATE "C" LIMIT $3'
        USING prefix_param, delimiter_param, max_keys, next_token, bucket_id, start_after;
END;
$_$;


--
-- Name: objects_insert_prefix_trigger(); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.objects_insert_prefix_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM "storage"."add_prefixes"(NEW."bucket_id", NEW."name");
    NEW.level := "storage"."get_level"(NEW."name");

    RETURN NEW;
END;
$$;


--
-- Name: objects_update_prefix_trigger(); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.objects_update_prefix_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    old_prefixes TEXT[];
BEGIN
    -- Ensure this is an update operation and the name has changed
    IF TG_OP = 'UPDATE' AND (NEW."name" <> OLD."name" OR NEW."bucket_id" <> OLD."bucket_id") THEN
        -- Retrieve old prefixes
        old_prefixes := "storage"."get_prefixes"(OLD."name");

        -- Remove old prefixes that are only used by this object
        WITH all_prefixes as (
            SELECT unnest(old_prefixes) as prefix
        ),
        can_delete_prefixes as (
             SELECT prefix
             FROM all_prefixes
             WHERE NOT EXISTS (
                 SELECT 1 FROM "storage"."objects"
                 WHERE "bucket_id" = OLD."bucket_id"
                   AND "name" <> OLD."name"
                   AND "name" LIKE (prefix || '%')
             )
         )
        DELETE FROM "storage"."prefixes" WHERE name IN (SELECT prefix FROM can_delete_prefixes);

        -- Add new prefixes
        PERFORM "storage"."add_prefixes"(NEW."bucket_id", NEW."name");
    END IF;
    -- Set the new level
    NEW."level" := "storage"."get_level"(NEW."name");

    RETURN NEW;
END;
$$;


--
-- Name: operation(); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.operation() RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    RETURN current_setting('storage.operation', true);
END;
$$;


--
-- Name: prefixes_insert_trigger(); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.prefixes_insert_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM "storage"."add_prefixes"(NEW."bucket_id", NEW."name");
    RETURN NEW;
END;
$$;


--
-- Name: search(text, text, integer, integer, integer, text, text, text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.search(prefix text, bucketname text, limits integer DEFAULT 100, levels integer DEFAULT 1, offsets integer DEFAULT 0, search text DEFAULT ''::text, sortcolumn text DEFAULT 'name'::text, sortorder text DEFAULT 'asc'::text) RETURNS TABLE(name text, id uuid, updated_at timestamp with time zone, created_at timestamp with time zone, last_accessed_at timestamp with time zone, metadata jsonb)
    LANGUAGE plpgsql
    AS $$
declare
    can_bypass_rls BOOLEAN;
begin
    SELECT rolbypassrls
    INTO can_bypass_rls
    FROM pg_roles
    WHERE rolname = coalesce(nullif(current_setting('role', true), 'none'), current_user);

    IF can_bypass_rls THEN
        RETURN QUERY SELECT * FROM storage.search_v1_optimised(prefix, bucketname, limits, levels, offsets, search, sortcolumn, sortorder);
    ELSE
        RETURN QUERY SELECT * FROM storage.search_legacy_v1(prefix, bucketname, limits, levels, offsets, search, sortcolumn, sortorder);
    END IF;
end;
$$;


--
-- Name: search_legacy_v1(text, text, integer, integer, integer, text, text, text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.search_legacy_v1(prefix text, bucketname text, limits integer DEFAULT 100, levels integer DEFAULT 1, offsets integer DEFAULT 0, search text DEFAULT ''::text, sortcolumn text DEFAULT 'name'::text, sortorder text DEFAULT 'asc'::text) RETURNS TABLE(name text, id uuid, updated_at timestamp with time zone, created_at timestamp with time zone, last_accessed_at timestamp with time zone, metadata jsonb)
    LANGUAGE plpgsql STABLE
    AS $_$
declare
    v_order_by text;
    v_sort_order text;
begin
    case
        when sortcolumn = 'name' then
            v_order_by = 'name';
        when sortcolumn = 'updated_at' then
            v_order_by = 'updated_at';
        when sortcolumn = 'created_at' then
            v_order_by = 'created_at';
        when sortcolumn = 'last_accessed_at' then
            v_order_by = 'last_accessed_at';
        else
            v_order_by = 'name';
        end case;

    case
        when sortorder = 'asc' then
            v_sort_order = 'asc';
        when sortorder = 'desc' then
            v_sort_order = 'desc';
        else
            v_sort_order = 'asc';
        end case;

    v_order_by = v_order_by || ' ' || v_sort_order;

    return query execute
        'with folders as (
           select path_tokens[$1] as folder
           from storage.objects
             where objects.name ilike $2 || $3 || ''%''
               and bucket_id = $4
               and array_length(objects.path_tokens, 1) <> $1
           group by folder
           order by folder ' || v_sort_order || '
     )
     (select folder as "name",
            null as id,
            null as updated_at,
            null as created_at,
            null as last_accessed_at,
            null as metadata from folders)
     union all
     (select path_tokens[$1] as "name",
            id,
            updated_at,
            created_at,
            last_accessed_at,
            metadata
     from storage.objects
     where objects.name ilike $2 || $3 || ''%''
       and bucket_id = $4
       and array_length(objects.path_tokens, 1) = $1
     order by ' || v_order_by || ')
     limit $5
     offset $6' using levels, prefix, search, bucketname, limits, offsets;
end;
$_$;


--
-- Name: search_v1_optimised(text, text, integer, integer, integer, text, text, text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.search_v1_optimised(prefix text, bucketname text, limits integer DEFAULT 100, levels integer DEFAULT 1, offsets integer DEFAULT 0, search text DEFAULT ''::text, sortcolumn text DEFAULT 'name'::text, sortorder text DEFAULT 'asc'::text) RETURNS TABLE(name text, id uuid, updated_at timestamp with time zone, created_at timestamp with time zone, last_accessed_at timestamp with time zone, metadata jsonb)
    LANGUAGE plpgsql STABLE
    AS $_$
declare
    v_order_by text;
    v_sort_order text;
begin
    case
        when sortcolumn = 'name' then
            v_order_by = 'name';
        when sortcolumn = 'updated_at' then
            v_order_by = 'updated_at';
        when sortcolumn = 'created_at' then
            v_order_by = 'created_at';
        when sortcolumn = 'last_accessed_at' then
            v_order_by = 'last_accessed_at';
        else
            v_order_by = 'name';
        end case;

    case
        when sortorder = 'asc' then
            v_sort_order = 'asc';
        when sortorder = 'desc' then
            v_sort_order = 'desc';
        else
            v_sort_order = 'asc';
        end case;

    v_order_by = v_order_by || ' ' || v_sort_order;

    return query execute
        'with folders as (
           select (string_to_array(name, ''/''))[level] as name
           from storage.prefixes
             where lower(prefixes.name) like lower($2 || $3) || ''%''
               and bucket_id = $4
               and level = $1
           order by name ' || v_sort_order || '
     )
     (select name,
            null as id,
            null as updated_at,
            null as created_at,
            null as last_accessed_at,
            null as metadata from folders)
     union all
     (select path_tokens[level] as "name",
            id,
            updated_at,
            created_at,
            last_accessed_at,
            metadata
     from storage.objects
     where lower(objects.name) like lower($2 || $3) || ''%''
       and bucket_id = $4
       and level = $1
     order by ' || v_order_by || ')
     limit $5
     offset $6' using levels, prefix, search, bucketname, limits, offsets;
end;
$_$;


--
-- Name: search_v2(text, text, integer, integer, text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.search_v2(prefix text, bucket_name text, limits integer DEFAULT 100, levels integer DEFAULT 1, start_after text DEFAULT ''::text) RETURNS TABLE(key text, name text, id uuid, updated_at timestamp with time zone, created_at timestamp with time zone, metadata jsonb)
    LANGUAGE plpgsql STABLE
    AS $_$
BEGIN
    RETURN query EXECUTE
        $sql$
        SELECT * FROM (
            (
                SELECT
                    split_part(name, '/', $4) AS key,
                    name || '/' AS name,
                    NULL::uuid AS id,
                    NULL::timestamptz AS updated_at,
                    NULL::timestamptz AS created_at,
                    NULL::jsonb AS metadata
                FROM storage.prefixes
                WHERE name COLLATE "C" LIKE $1 || '%'
                AND bucket_id = $2
                AND level = $4
                AND name COLLATE "C" > $5
                ORDER BY prefixes.name COLLATE "C" LIMIT $3
            )
            UNION ALL
            (SELECT split_part(name, '/', $4) AS key,
                name,
                id,
                updated_at,
                created_at,
                metadata
            FROM storage.objects
            WHERE name COLLATE "C" LIKE $1 || '%'
                AND bucket_id = $2
                AND level = $4
                AND name COLLATE "C" > $5
            ORDER BY name COLLATE "C" LIMIT $3)
        ) obj
        ORDER BY name COLLATE "C" LIMIT $3;
        $sql$
        USING prefix, bucket_name, limits, levels, start_after;
END;
$_$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW; 
END;
$$;


--
-- Name: http_request(); Type: FUNCTION; Schema: supabase_functions; Owner: -
--

CREATE FUNCTION supabase_functions.http_request() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'supabase_functions'
    AS $$
    DECLARE
      request_id bigint;
      payload jsonb;
      url text := TG_ARGV[0]::text;
      method text := TG_ARGV[1]::text;
      headers jsonb DEFAULT '{}'::jsonb;
      params jsonb DEFAULT '{}'::jsonb;
      timeout_ms integer DEFAULT 1000;
    BEGIN
      IF url IS NULL OR url = 'null' THEN
        RAISE EXCEPTION 'url argument is missing';
      END IF;

      IF method IS NULL OR method = 'null' THEN
        RAISE EXCEPTION 'method argument is missing';
      END IF;

      IF TG_ARGV[2] IS NULL OR TG_ARGV[2] = 'null' THEN
        headers = '{"Content-Type": "application/json"}'::jsonb;
      ELSE
        headers = TG_ARGV[2]::jsonb;
      END IF;

      IF TG_ARGV[3] IS NULL OR TG_ARGV[3] = 'null' THEN
        params = '{}'::jsonb;
      ELSE
        params = TG_ARGV[3]::jsonb;
      END IF;

      IF TG_ARGV[4] IS NULL OR TG_ARGV[4] = 'null' THEN
        timeout_ms = 1000;
      ELSE
        timeout_ms = TG_ARGV[4]::integer;
      END IF;

      CASE
        WHEN method = 'GET' THEN
          SELECT http_get INTO request_id FROM net.http_get(
            url,
            params,
            headers,
            timeout_ms
          );
        WHEN method = 'POST' THEN
          payload = jsonb_build_object(
            'old_record', OLD,
            'record', NEW,
            'type', TG_OP,
            'table', TG_TABLE_NAME,
            'schema', TG_TABLE_SCHEMA
          );

          SELECT http_post INTO request_id FROM net.http_post(
            url,
            payload,
            params,
            headers,
            timeout_ms
          );
        ELSE
          RAISE EXCEPTION 'method argument % is invalid', method;
      END CASE;

      INSERT INTO supabase_functions.hooks
        (hook_table_id, hook_name, request_id)
      VALUES
        (TG_RELID, TG_NAME, request_id);

      RETURN NEW;
    END
  $$;


--
-- Name: extensions; Type: TABLE; Schema: _realtime; Owner: -
--

CREATE TABLE _realtime.extensions (
    id uuid NOT NULL,
    type text,
    settings jsonb,
    tenant_external_id text,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);


--
-- Name: schema_migrations; Type: TABLE; Schema: _realtime; Owner: -
--

CREATE TABLE _realtime.schema_migrations (
    version bigint NOT NULL,
    inserted_at timestamp(0) without time zone
);


--
-- Name: tenants; Type: TABLE; Schema: _realtime; Owner: -
--

CREATE TABLE _realtime.tenants (
    id uuid NOT NULL,
    name text,
    external_id text,
    jwt_secret text,
    max_concurrent_users integer DEFAULT 200 NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL,
    max_events_per_second integer DEFAULT 100 NOT NULL,
    postgres_cdc_default text DEFAULT 'postgres_cdc_rls'::text,
    max_bytes_per_second integer DEFAULT 100000 NOT NULL,
    max_channels_per_client integer DEFAULT 100 NOT NULL,
    max_joins_per_second integer DEFAULT 500 NOT NULL,
    suspend boolean DEFAULT false,
    jwt_jwks jsonb,
    notify_private_alpha boolean DEFAULT false,
    private_only boolean DEFAULT false NOT NULL
);


--
-- Name: audit_log_entries; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.audit_log_entries (
    instance_id uuid,
    id uuid NOT NULL,
    payload json,
    created_at timestamp with time zone,
    ip_address character varying(64) DEFAULT ''::character varying NOT NULL
);


--
-- Name: TABLE audit_log_entries; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.audit_log_entries IS 'Auth: Audit trail for user actions.';


--
-- Name: flow_state; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.flow_state (
    id uuid NOT NULL,
    user_id uuid,
    auth_code text NOT NULL,
    code_challenge_method auth.code_challenge_method NOT NULL,
    code_challenge text NOT NULL,
    provider_type text NOT NULL,
    provider_access_token text,
    provider_refresh_token text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    authentication_method text NOT NULL,
    auth_code_issued_at timestamp with time zone
);


--
-- Name: TABLE flow_state; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.flow_state IS 'stores metadata for pkce logins';


--
-- Name: identities; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.identities (
    provider_id text NOT NULL,
    user_id uuid NOT NULL,
    identity_data jsonb NOT NULL,
    provider text NOT NULL,
    last_sign_in_at timestamp with time zone,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    email text GENERATED ALWAYS AS (lower((identity_data ->> 'email'::text))) STORED,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


--
-- Name: TABLE identities; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.identities IS 'Auth: Stores identities associated to a user.';


--
-- Name: COLUMN identities.email; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON COLUMN auth.identities.email IS 'Auth: Email is a generated column that references the optional email property in the identity_data';


--
-- Name: instances; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.instances (
    id uuid NOT NULL,
    uuid uuid,
    raw_base_config text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: TABLE instances; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.instances IS 'Auth: Manages users across multiple sites.';


--
-- Name: mfa_amr_claims; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.mfa_amr_claims (
    session_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    authentication_method text NOT NULL,
    id uuid NOT NULL
);


--
-- Name: TABLE mfa_amr_claims; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.mfa_amr_claims IS 'auth: stores authenticator method reference claims for multi factor authentication';


--
-- Name: mfa_challenges; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.mfa_challenges (
    id uuid NOT NULL,
    factor_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    verified_at timestamp with time zone,
    ip_address inet NOT NULL,
    otp_code text,
    web_authn_session_data jsonb
);


--
-- Name: TABLE mfa_challenges; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.mfa_challenges IS 'auth: stores metadata about challenge requests made';


--
-- Name: mfa_factors; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.mfa_factors (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    friendly_name text,
    factor_type auth.factor_type NOT NULL,
    status auth.factor_status NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    secret text,
    phone text,
    last_challenged_at timestamp with time zone,
    web_authn_credential jsonb,
    web_authn_aaguid uuid
);


--
-- Name: TABLE mfa_factors; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.mfa_factors IS 'auth: stores metadata about factors';


--
-- Name: one_time_tokens; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.one_time_tokens (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    token_type auth.one_time_token_type NOT NULL,
    token_hash text NOT NULL,
    relates_to text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT one_time_tokens_token_hash_check CHECK ((char_length(token_hash) > 0))
);


--
-- Name: refresh_tokens; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.refresh_tokens (
    instance_id uuid,
    id bigint NOT NULL,
    token character varying(255),
    user_id character varying(255),
    revoked boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    parent character varying(255),
    session_id uuid
);


--
-- Name: TABLE refresh_tokens; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.refresh_tokens IS 'Auth: Store of tokens used to refresh JWT tokens once they expire.';


--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE; Schema: auth; Owner: -
--

CREATE SEQUENCE auth.refresh_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: auth; Owner: -
--

ALTER SEQUENCE auth.refresh_tokens_id_seq OWNED BY auth.refresh_tokens.id;


--
-- Name: saml_providers; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.saml_providers (
    id uuid NOT NULL,
    sso_provider_id uuid NOT NULL,
    entity_id text NOT NULL,
    metadata_xml text NOT NULL,
    metadata_url text,
    attribute_mapping jsonb,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    name_id_format text,
    CONSTRAINT "entity_id not empty" CHECK ((char_length(entity_id) > 0)),
    CONSTRAINT "metadata_url not empty" CHECK (((metadata_url = NULL::text) OR (char_length(metadata_url) > 0))),
    CONSTRAINT "metadata_xml not empty" CHECK ((char_length(metadata_xml) > 0))
);


--
-- Name: TABLE saml_providers; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.saml_providers IS 'Auth: Manages SAML Identity Provider connections.';


--
-- Name: saml_relay_states; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.saml_relay_states (
    id uuid NOT NULL,
    sso_provider_id uuid NOT NULL,
    request_id text NOT NULL,
    for_email text,
    redirect_to text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    flow_state_id uuid,
    CONSTRAINT "request_id not empty" CHECK ((char_length(request_id) > 0))
);


--
-- Name: TABLE saml_relay_states; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.saml_relay_states IS 'Auth: Contains SAML Relay State information for each Service Provider initiated login.';


--
-- Name: schema_migrations; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.schema_migrations (
    version character varying(255) NOT NULL
);


--
-- Name: TABLE schema_migrations; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.schema_migrations IS 'Auth: Manages updates to the auth system.';


--
-- Name: sessions; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.sessions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    factor_id uuid,
    aal auth.aal_level,
    not_after timestamp with time zone,
    refreshed_at timestamp without time zone,
    user_agent text,
    ip inet,
    tag text
);


--
-- Name: TABLE sessions; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.sessions IS 'Auth: Stores session data associated to a user.';


--
-- Name: COLUMN sessions.not_after; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON COLUMN auth.sessions.not_after IS 'Auth: Not after is a nullable column that contains a timestamp after which the session should be regarded as expired.';


--
-- Name: sso_domains; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.sso_domains (
    id uuid NOT NULL,
    sso_provider_id uuid NOT NULL,
    domain text NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    CONSTRAINT "domain not empty" CHECK ((char_length(domain) > 0))
);


--
-- Name: TABLE sso_domains; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.sso_domains IS 'Auth: Manages SSO email address domain mapping to an SSO Identity Provider.';


--
-- Name: sso_providers; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.sso_providers (
    id uuid NOT NULL,
    resource_id text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    CONSTRAINT "resource_id not empty" CHECK (((resource_id = NULL::text) OR (char_length(resource_id) > 0)))
);


--
-- Name: TABLE sso_providers; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.sso_providers IS 'Auth: Manages SSO identity provider information; see saml_providers for SAML.';


--
-- Name: COLUMN sso_providers.resource_id; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON COLUMN auth.sso_providers.resource_id IS 'Auth: Uniquely identifies a SSO provider according to a user-chosen resource ID (case insensitive), useful in infrastructure as code.';


--
-- Name: users; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.users (
    instance_id uuid,
    id uuid NOT NULL,
    aud character varying(255),
    role character varying(255),
    email character varying(255),
    encrypted_password character varying(255),
    email_confirmed_at timestamp with time zone,
    invited_at timestamp with time zone,
    confirmation_token character varying(255),
    confirmation_sent_at timestamp with time zone,
    recovery_token character varying(255),
    recovery_sent_at timestamp with time zone,
    email_change_token_new character varying(255),
    email_change character varying(255),
    email_change_sent_at timestamp with time zone,
    last_sign_in_at timestamp with time zone,
    raw_app_meta_data jsonb,
    raw_user_meta_data jsonb,
    is_super_admin boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    phone text DEFAULT NULL::character varying,
    phone_confirmed_at timestamp with time zone,
    phone_change text DEFAULT ''::character varying,
    phone_change_token character varying(255) DEFAULT ''::character varying,
    phone_change_sent_at timestamp with time zone,
    confirmed_at timestamp with time zone GENERATED ALWAYS AS (LEAST(email_confirmed_at, phone_confirmed_at)) STORED,
    email_change_token_current character varying(255) DEFAULT ''::character varying,
    email_change_confirm_status smallint DEFAULT 0,
    banned_until timestamp with time zone,
    reauthentication_token character varying(255) DEFAULT ''::character varying,
    reauthentication_sent_at timestamp with time zone,
    is_sso_user boolean DEFAULT false NOT NULL,
    deleted_at timestamp with time zone,
    is_anonymous boolean DEFAULT false NOT NULL,
    CONSTRAINT users_email_change_confirm_status_check CHECK (((email_change_confirm_status >= 0) AND (email_change_confirm_status <= 2)))
);


--
-- Name: TABLE users; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.users IS 'Auth: Stores user login data within a secure schema.';


--
-- Name: COLUMN users.is_sso_user; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON COLUMN auth.users.is_sso_user IS 'Auth: Set this column to true when the account comes from SSO. These accounts can have duplicate emails.';


--
-- Name: activity_processing_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activity_processing_logs (
    id integer NOT NULL,
    activity_id uuid NOT NULL,
    ap_id text NOT NULL,
    ap_type text NOT NULL,
    status text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone
);


--
-- Name: activity_processing_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.activity_processing_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: activity_processing_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.activity_processing_logs_id_seq OWNED BY public.activity_processing_logs.id;


--
-- Name: activitypub_processing_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activitypub_processing_stats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    date date NOT NULL,
    total_activities integer DEFAULT 0,
    processed_activities integer DEFAULT 0,
    failed_activities integer DEFAULT 0,
    permanently_failed_activities integer DEFAULT 0,
    avg_processing_time_ms numeric DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: admin_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    admin_id uuid NOT NULL,
    action_type text NOT NULL,
    target_type text,
    target_id text,
    action_details jsonb,
    ip_address inet,
    user_agent text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: ap_activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ap_activities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    ap_id text NOT NULL,
    ap_type text NOT NULL,
    actor_id uuid,
    actor_ap_id text NOT NULL,
    object_id text,
    object_type text,
    target_id uuid,
    target_type text,
    activity_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text,
    to_addresses text[] DEFAULT '{}'::text[],
    cc_addresses text[] DEFAULT '{}'::text[],
    bto_addresses text[] DEFAULT '{}'::text[],
    bcc_addresses text[] DEFAULT '{}'::text[],
    attempts integer DEFAULT 0,
    last_attempt_at timestamp with time zone,
    next_attempt_at timestamp with time zone,
    error_message text,
    is_local boolean DEFAULT true,
    source_domain text,
    origin_domain text,
    CONSTRAINT ap_activities_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'received'::text, 'processed'::text]))),
    CONSTRAINT ap_activities_valid_type CHECK ((ap_type = ANY (ARRAY['Create'::text, 'Update'::text, 'Delete'::text, 'Follow'::text, 'Accept'::text, 'Reject'::text, 'Undo'::text, 'Like'::text, 'Announce'::text, 'Add'::text, 'Remove'::text, 'Invite'::text, 'Join'::text, 'Leave'::text, 'VoiceJoin'::text, 'VoiceLeave'::text, 'VoiceUpdate'::text, 'Block'::text, 'Flag'::text, 'Move'::text, 'Tombstone'::text])))
);


--
-- Name: ap_actor_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ap_actor_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    ap_id text NOT NULL,
    domain text NOT NULL,
    username text NOT NULL,
    actor_data jsonb NOT NULL,
    last_fetched_at timestamp with time zone DEFAULT now(),
    cache_expires_at timestamp with time zone DEFAULT (now() + '01:00:00'::interval),
    fetch_attempts integer DEFAULT 0,
    is_reachable boolean DEFAULT true,
    last_error text
);


--
-- Name: ap_object_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ap_object_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    ap_id text NOT NULL,
    object_type text NOT NULL,
    object_data jsonb NOT NULL,
    last_fetched_at timestamp with time zone DEFAULT now(),
    cache_expires_at timestamp with time zone DEFAULT (now() + '01:00:00'::interval),
    fetch_attempts integer DEFAULT 0,
    is_reachable boolean DEFAULT true,
    last_error text
);


--
-- Name: blocked_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blocked_instances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    domain text NOT NULL,
    reason text NOT NULL,
    blocked_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    block_type text DEFAULT 'full'::text,
    expires_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT blocked_instances_block_type_check CHECK ((block_type = ANY (ARRAY['full'::text, 'media_only'::text, 'follows_only'::text])))
);


--
-- Name: COLUMN blocked_instances.block_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.blocked_instances.block_type IS 'Type of block: full, media_only, or follows_only';


--
-- Name: COLUMN blocked_instances.expires_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.blocked_instances.expires_at IS 'Optional expiration time for temporary blocks';


--
-- Name: channel_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    name text,
    "order" smallint,
    server_id uuid
);


--
-- Name: channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    name text NOT NULL,
    description text,
    type smallint DEFAULT '0'::smallint,
    server_id uuid,
    category uuid,
    "order" integer DEFAULT 0,
    ap_id text,
    is_remote boolean DEFAULT false
);


--
-- Name: COLUMN channels.ap_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.channels.ap_id IS 'ActivityPub context URL for this channel';


--
-- Name: COLUMN channels.is_remote; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.channels.is_remote IS 'True if this is a mirror of a remote channel';


--
-- Name: conversation_backup_pre_cleanup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_backup_pre_cleanup (
    id uuid,
    user1 uuid,
    user2 uuid,
    created_at timestamp with time zone,
    name text,
    type text,
    created_by uuid,
    is_active boolean,
    updated_at timestamp with time zone,
    metadata jsonb
);


--
-- Name: TABLE conversation_backup_pre_cleanup; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.conversation_backup_pre_cleanup IS 'Backup of conversations before dropping user1/user2 columns. Can be dropped after verification.';


--
-- Name: conversation_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_participants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    joined_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    role text DEFAULT 'member'::text,
    is_muted boolean DEFAULT false,
    last_read_at timestamp with time zone,
    left_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT conversation_participants_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text])))
);


--
-- Name: TABLE conversation_participants; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.conversation_participants IS 'Multi-participant conversation system. Migration 013 created this table and migrated from user1/user2 system. Next migration will drop old user1/user2 columns after verification.';


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    name text,
    type text DEFAULT 'direct'::text,
    created_by uuid,
    is_active boolean DEFAULT true,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT conversations_type_check CHECK ((type = ANY (ARRAY['direct'::text, 'group'::text, 'channel'::text])))
);


--
-- Name: TABLE conversations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.conversations IS 'DM conversations between users. Supports both local users (in auth.users) and federated users (profiles only). Foreign keys reference profiles to enable federated DMs.';


--
-- Name: emoji_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.emoji_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    emoji_id uuid NOT NULL,
    user_id uuid NOT NULL,
    server_id uuid NOT NULL,
    context_type text NOT NULL,
    context_id uuid,
    used_at timestamp with time zone DEFAULT now(),
    CONSTRAINT emoji_usage_context_type_check CHECK ((context_type = ANY (ARRAY['message'::text, 'reaction'::text])))
);


--
-- Name: emojis; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.emojis (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    name character varying,
    url character varying,
    server_id uuid,
    uploader uuid,
    updated_at timestamp with time zone DEFAULT now(),
    usage_count integer DEFAULT 0,
    last_used timestamp with time zone,
    domain text
);


--
-- Name: federated_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.federated_instances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    domain text NOT NULL,
    software text,
    version text,
    description text,
    admin_contact text,
    is_blocked boolean DEFAULT false,
    is_trusted boolean DEFAULT false,
    last_seen_at timestamp with time zone DEFAULT now(),
    user_count integer DEFAULT 0,
    status_count integer DEFAULT 0,
    connection_count integer DEFAULT 0,
    metadata jsonb DEFAULT '{}'::jsonb
);


--
-- Name: federation_delivery_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.federation_delivery_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    activity_id uuid,
    target_domain text NOT NULL,
    target_inbox_url text NOT NULL,
    status text DEFAULT 'pending'::text,
    attempts integer DEFAULT 0,
    max_attempts integer DEFAULT 5,
    next_attempt_at timestamp with time zone DEFAULT now(),
    http_status_code integer,
    response_body text,
    error_message text,
    delivery_duration_ms integer,
    priority integer DEFAULT 5,
    actor_username text,
    actor_domain text,
    activity_data jsonb,
    delivered_at timestamp with time zone,
    last_attempt_at timestamp with time zone,
    sender_id uuid,
    target_inbox text,
    next_retry_at timestamp with time zone,
    CONSTRAINT federation_delivery_queue_priority_check CHECK (((priority >= 1) AND (priority <= 10))),
    CONSTRAINT federation_delivery_queue_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'delivered'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: TABLE federation_delivery_queue; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.federation_delivery_queue IS 'Queue for federated activity delivery with retry logic';


--
-- Name: COLUMN federation_delivery_queue.activity_data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.federation_delivery_queue.activity_data IS 'ActivityPub activity data to be delivered, stored here to avoid joins during edge function processing';


--
-- Name: federation_delivery_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.federation_delivery_stats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    total_deliveries integer DEFAULT 0,
    successful_deliveries integer DEFAULT 0,
    failed_deliveries integer DEFAULT 0,
    avg_delivery_time_ms numeric,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: federation_stats; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.federation_stats AS
 SELECT count(*) AS total_activities,
    count(*) FILTER (WHERE (ap_activities.status = 'delivered'::text)) AS delivered_activities,
    count(*) FILTER (WHERE (ap_activities.status = 'failed'::text)) AS failed_activities,
    count(*) FILTER (WHERE (ap_activities.status = 'pending'::text)) AS pending_activities,
    count(DISTINCT ap_activities.actor_id) AS active_users,
    count(DISTINCT ap_activities.target_id) AS target_objects,
    ap_activities.ap_type,
    date_trunc('hour'::text, ap_activities.created_at) AS hour
   FROM public.ap_activities
  GROUP BY ap_activities.ap_type, (date_trunc('hour'::text, ap_activities.created_at))
  ORDER BY (date_trunc('hour'::text, ap_activities.created_at)) DESC;


--
-- Name: files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone,
    name text,
    description text,
    type character varying,
    size bigint,
    url text,
    owner uuid
);


--
-- Name: follows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.follows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    follower_id uuid NOT NULL,
    following_id uuid NOT NULL,
    ap_id text,
    accepted_at timestamp with time zone,
    status text DEFAULT 'pending'::text,
    is_local boolean DEFAULT true,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT follows_no_self_follow CHECK ((follower_id <> following_id)),
    CONSTRAINT follows_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text])))
);


--
-- Name: COLUMN follows.follower_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.follows.follower_id IS 'ID of the user doing the following.
This is the source of the follow relationship (follower_id -> following_id)';


--
-- Name: COLUMN follows.following_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.follows.following_id IS 'ID of the user being followed. 
IMPORTANT: Code should use following_id, NOT followed_id.
This is the target of the follow relationship (follower_id -> following_id)';


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone,
    username text,
    display_name text,
    avatar_url text DEFAULT '/default_avatar.png'::text,
    bio text,
    color character varying,
    status smallint DEFAULT '0'::smallint,
    domain text DEFAULT 'har.mony.lol'::text NOT NULL,
    federated_id text,
    public_key text,
    inbox_url text,
    outbox_url text,
    followers_url text,
    following_url text,
    featured_url text,
    is_local boolean DEFAULT true,
    last_synced_at timestamp with time zone,
    federation_metadata jsonb DEFAULT '{}'::jsonb,
    supported_activities text[] DEFAULT '{}'::text[],
    last_federation_sync timestamp with time zone,
    is_admin boolean DEFAULT false,
    is_suspended boolean DEFAULT false,
    suspended_at timestamp with time zone,
    suspension_reason text,
    followers_count integer DEFAULT 0,
    following_count integer DEFAULT 0,
    posts_count integer DEFAULT 0,
    auth_user_id uuid,
    banner_url text,
    federation_enabled boolean DEFAULT true,
    federation_discoverable boolean DEFAULT true,
    federation_followers_only boolean DEFAULT false,
    manually_approves_followers boolean DEFAULT false,
    shared_inbox_url text
);


--
-- Name: COLUMN profiles.followers_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.followers_count IS 'Denormalized count of followers for O(1) lookups. Maintained by triggers.';


--
-- Name: COLUMN profiles.following_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.following_count IS 'Denormalized count of following for O(1) lookups. Maintained by triggers.';


--
-- Name: COLUMN profiles.posts_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.posts_count IS 'Denormalized count of posts for O(1) lookups. Maintained by triggers.';


--
-- Name: COLUMN profiles.banner_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.banner_url IS 'URL to user banner/header image stored in Supabase storage';


--
-- Name: COLUMN profiles.federation_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.federation_enabled IS 'Whether this user participates in federation at all';


--
-- Name: COLUMN profiles.federation_discoverable; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.federation_discoverable IS 'Whether this user appears in federated searches and directories';


--
-- Name: COLUMN profiles.federation_followers_only; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.federation_followers_only IS 'Whether this user only federates with followers';


--
-- Name: COLUMN profiles.manually_approves_followers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.manually_approves_followers IS 'ActivityPub standard: If true, follows require approval. If false, auto-accept.';


--
-- Name: COLUMN profiles.shared_inbox_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.shared_inbox_url IS 'ActivityPub shared inbox URL for efficient delivery';


--
-- Name: follow_relationships; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.follow_relationships AS
 SELECT f.id,
    f.follower_id,
    f.following_id,
    f.status,
    f.created_at,
    f.accepted_at,
    follower.username AS follower_username,
    following.username AS following_username,
    follower.display_name AS follower_display_name,
    following.display_name AS following_display_name
   FROM ((public.follows f
     JOIN public.profiles follower ON ((f.follower_id = follower.id)))
     JOIN public.profiles following ON ((f.following_id = following.id)));


--
-- Name: VIEW follow_relationships; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.follow_relationships IS 'Helper view that clearly shows follow relationships with usernames.
follower_id = user who is following
following_id = user being followed
Use this view for debugging relationship queries.';


--
-- Name: hashtag_archive; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hashtag_archive (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    archived_at timestamp with time zone DEFAULT now(),
    original_hashtag_id uuid,
    tag text NOT NULL,
    total_uses integer,
    peak_daily_uses integer,
    peak_daily_date date,
    first_used_at timestamp with time zone,
    last_used_at timestamp with time zone,
    archive_reason text
);


--
-- Name: hashtags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hashtags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    tag text NOT NULL,
    normalized_tag text NOT NULL,
    total_uses integer DEFAULT 0,
    daily_uses integer DEFAULT 0,
    weekly_uses integer DEFAULT 0,
    peak_daily_uses integer DEFAULT 0,
    peak_daily_date date,
    first_used_at timestamp with time zone DEFAULT now(),
    last_used_at timestamp with time zone DEFAULT now(),
    trending_score numeric DEFAULT 0,
    trending_rank integer,
    last_trending_update timestamp with time zone
);


--
-- Name: TABLE hashtags; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.hashtags IS 'Tracks hashtag usage and trending metrics';


--
-- Name: instance_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instance_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    config_key text NOT NULL,
    config_value jsonb NOT NULL,
    description text,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: instance_health; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.instance_health AS
 SELECT federated_instances.domain,
    federated_instances.is_blocked,
    federated_instances.is_trusted,
    federated_instances.last_seen_at,
    federated_instances.user_count,
    federated_instances.status_count,
    federated_instances.connection_count,
        CASE
            WHEN (federated_instances.last_seen_at > (now() - '01:00:00'::interval)) THEN 'healthy'::text
            WHEN (federated_instances.last_seen_at > (now() - '24:00:00'::interval)) THEN 'stale'::text
            ELSE 'unreachable'::text
        END AS health_status
   FROM public.federated_instances
  ORDER BY federated_instances.last_seen_at DESC;


--
-- Name: invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    code character varying,
    server_id uuid,
    created_by uuid,
    used boolean DEFAULT false,
    temporary boolean DEFAULT false,
    uses integer
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at time without time zone,
    channel_id uuid,
    user_id uuid,
    content jsonb,
    reply_to uuid,
    reactions uuid[],
    conversation_id uuid,
    is_system boolean DEFAULT false,
    metadata jsonb,
    is_deleted boolean DEFAULT false,
    CONSTRAINT messages_content_is_array CHECK ((jsonb_typeof(content) = 'array'::text)),
    CONSTRAINT messages_content_not_empty CHECK ((jsonb_array_length(content) > 0))
);

ALTER TABLE ONLY public.messages REPLICA IDENTITY FULL;


--
-- Name: COLUMN messages.metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.messages.metadata IS 'JSON metadata for federation info including ap_id, from_domain, original_url, etc.';


--
-- Name: notification_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_channels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    server_id uuid,
    channel_id uuid,
    conversation_id uuid,
    muted boolean DEFAULT false,
    muted_until timestamp with time zone,
    notification_level character varying(20) DEFAULT 'all'::character varying,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: TABLE notification_channels; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.notification_channels IS 'Channel/server/conversation specific notification muting settings';


--
-- Name: notification_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    desktop_notifications boolean DEFAULT true,
    desktop_mentions boolean DEFAULT true,
    desktop_dms boolean DEFAULT true,
    desktop_reactions boolean DEFAULT false,
    desktop_replies boolean DEFAULT true,
    sound_notifications boolean DEFAULT true,
    sound_mentions boolean DEFAULT true,
    sound_dms boolean DEFAULT true,
    sound_reactions boolean DEFAULT false,
    sound_voice_activity boolean DEFAULT true,
    push_notifications boolean DEFAULT true,
    push_mentions boolean DEFAULT true,
    push_dms boolean DEFAULT true,
    push_offline_only boolean DEFAULT true,
    email_notifications boolean DEFAULT false,
    email_digest boolean DEFAULT false,
    email_digest_frequency character varying(20) DEFAULT 'weekly'::character varying,
    dnd_enabled boolean DEFAULT false,
    dnd_start_time time without time zone DEFAULT '22:00:00'::time without time zone,
    dnd_end_time time without time zone DEFAULT '08:00:00'::time without time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    activitypub_notifications boolean DEFAULT true,
    activitypub_follows boolean DEFAULT true,
    activitypub_favorites boolean DEFAULT true,
    activitypub_reblogs boolean DEFAULT true,
    activitypub_mentions boolean DEFAULT true,
    activitypub_replies boolean DEFAULT true,
    activitypub_follow_requests boolean DEFAULT true,
    activitypub_desktop_notifications boolean DEFAULT true,
    activitypub_desktop_follows boolean DEFAULT true,
    activitypub_desktop_favorites boolean DEFAULT false,
    activitypub_desktop_reblogs boolean DEFAULT false,
    activitypub_desktop_mentions boolean DEFAULT true,
    activitypub_desktop_replies boolean DEFAULT true,
    activitypub_sound_notifications boolean DEFAULT true,
    activitypub_sound_follows boolean DEFAULT true,
    activitypub_sound_favorites boolean DEFAULT false,
    activitypub_sound_reblogs boolean DEFAULT false,
    activitypub_sound_mentions boolean DEFAULT true,
    activitypub_sound_replies boolean DEFAULT true,
    sound_replies boolean DEFAULT true
);


--
-- Name: COLUMN notification_preferences.activitypub_notifications; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_preferences.activitypub_notifications IS 'Master toggle for all ActivityPub notifications';


--
-- Name: COLUMN notification_preferences.activitypub_follows; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_preferences.activitypub_follows IS 'Enable notifications for new followers';


--
-- Name: COLUMN notification_preferences.activitypub_favorites; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_preferences.activitypub_favorites IS 'Enable notifications for favorites/likes';


--
-- Name: COLUMN notification_preferences.activitypub_reblogs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_preferences.activitypub_reblogs IS 'Enable notifications for reblogs/boosts';


--
-- Name: COLUMN notification_preferences.activitypub_mentions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_preferences.activitypub_mentions IS 'Enable notifications for mentions';


--
-- Name: COLUMN notification_preferences.activitypub_replies; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_preferences.activitypub_replies IS 'Enable notifications for replies';


--
-- Name: COLUMN notification_preferences.activitypub_follow_requests; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_preferences.activitypub_follow_requests IS 'Enable notifications for follow requests';


--
-- Name: COLUMN notification_preferences.activitypub_desktop_notifications; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_preferences.activitypub_desktop_notifications IS 'Master toggle for ActivityPub desktop notifications';


--
-- Name: COLUMN notification_preferences.activitypub_sound_notifications; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_preferences.activitypub_sound_notifications IS 'Master toggle for ActivityPub sound notifications';


--
-- Name: notification_rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_rate_limits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    notification_type text NOT NULL,
    source_user_id uuid,
    last_notification_at timestamp with time zone DEFAULT now(),
    notification_count integer DEFAULT 1,
    suppressed_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: TABLE notification_rate_limits; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.notification_rate_limits IS 'Prevents notification spam by tracking and rate limiting notifications per user/type/source';


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    type character varying(50) NOT NULL,
    data jsonb DEFAULT '{}'::jsonb,
    is_read boolean DEFAULT false,
    is_clicked boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone DEFAULT (now() + '30 days'::interval),
    read_at timestamp with time zone
);

ALTER TABLE ONLY public.notifications REPLICA IDENTITY FULL;


--
-- Name: COLUMN notifications.is_read; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notifications.is_read IS 'Boolean field indicating if notification has been read';


--
-- Name: COLUMN notifications.read_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notifications.read_at IS 'Timestamp when notification was marked as read';


--
-- Name: pg_background_job; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pg_background_job (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_type text NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'pending'::text,
    created_at timestamp with time zone DEFAULT now(),
    processed_at timestamp with time zone,
    error_message text,
    CONSTRAINT pg_background_job_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: post_hashtags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.post_hashtags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    post_id uuid NOT NULL,
    hashtag_id uuid NOT NULL,
    position_in_content integer DEFAULT 0
);


--
-- Name: TABLE post_hashtags; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.post_hashtags IS 'Links posts to their hashtags';


--
-- Name: post_interactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.post_interactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    user_id uuid NOT NULL,
    post_id uuid NOT NULL,
    interaction_type text NOT NULL,
    ap_id text,
    is_local boolean DEFAULT true,
    metadata jsonb DEFAULT '{}'::jsonb,
    emoji_id uuid,
    custom_emoji_content text,
    CONSTRAINT post_interactions_interaction_type_check CHECK ((interaction_type = ANY (ARRAY['favorite'::text, 'reblog'::text, 'bookmark'::text, 'emoji_reaction'::text])))
);

ALTER TABLE ONLY public.post_interactions REPLICA IDENTITY FULL;


--
-- Name: reactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid NOT NULL,
    user_id uuid NOT NULL,
    emoji_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.reactions REPLICA IDENTITY FULL;


--
-- Name: schedule_result; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedule_result (
    schedule bigint
);


--
-- Name: server_federation_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.server_federation_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    server_id uuid,
    server_domain text NOT NULL,
    user_id uuid,
    event_type text NOT NULL,
    ap_activity_id uuid,
    federated_to text[] DEFAULT '{}'::text[],
    event_data jsonb DEFAULT '{}'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT server_federation_events_event_type_check CHECK ((event_type = ANY (ARRAY['join'::text, 'leave'::text, 'invite'::text, 'ban'::text, 'unban'::text])))
);


--
-- Name: server_membership_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.server_membership_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    server_id uuid NOT NULL,
    user_id uuid NOT NULL,
    event_type text NOT NULL,
    initiated_by uuid,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT server_membership_events_event_type_check CHECK ((event_type = ANY (ARRAY['join'::text, 'leave'::text, 'kick'::text, 'ban'::text])))
);

ALTER TABLE ONLY public.server_membership_events REPLICA IDENTITY FULL;


--
-- Name: servers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.servers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    name text,
    description text,
    owner uuid,
    icon text DEFAULT '/default_server_icon.png'::text,
    allow_cross_server_emojis boolean DEFAULT true,
    public boolean DEFAULT false,
    federation_enabled boolean DEFAULT false,
    federation_domain text,
    federation_inbox_url text,
    federation_metadata jsonb DEFAULT '{}'::jsonb,
    supported_activities text[] DEFAULT '{}'::text[],
    ap_id text,
    host_domain text,
    is_local_server boolean DEFAULT true
);


--
-- Name: COLUMN servers.ap_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.servers.ap_id IS 'ActivityPub ID for this server (Group actor)';


--
-- Name: COLUMN servers.host_domain; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.servers.host_domain IS 'Domain where this server is hosted (null if local)';


--
-- Name: COLUMN servers.is_local_server; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.servers.is_local_server IS 'True if server is hosted on this instance';


--
-- Name: timeline_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.timeline_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    user_id uuid NOT NULL,
    post_id uuid NOT NULL,
    timeline_type text NOT NULL,
    "position" bigint,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT timeline_entries_timeline_type_check CHECK ((timeline_type = ANY (ARRAY['home'::text, 'public'::text, 'local'::text, 'notifications'::text])))
);


--
-- Name: timeline_posts; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.timeline_posts AS
 SELECT p.id,
    p.content,
    p.created_at,
    p.updated_at,
    p.conversation_id,
    jsonb_build_object('id', pr.id, 'username', pr.username, 'display_name', pr.display_name, 'avatar_url', pr.avatar_url, 'domain', COALESCE(pr.domain, 'har.mony.lol'::text), 'handle',
        CASE
            WHEN COALESCE(pr.is_local, true) THEN ('@'::text || pr.username)
            ELSE ((('@'::text || pr.username) || '@'::text) || pr.domain)
        END, 'is_local', COALESCE(pr.is_local, true), 'bio', pr.bio, 'followers_count', pr.followers_count, 'following_count', pr.following_count, 'posts_count', pr.posts_count) AS author,
    p.visibility,
    COALESCE(p.favorites_count, 0) AS favorites_count,
    COALESCE(p.reblogs_count, 0) AS reblogs_count,
    COALESCE(p.replies_count, 0) AS replies_count,
    COALESCE(p.media_attachments, '[]'::jsonb) AS media_attachments,
        CASE
            WHEN (p.in_reply_to IS NOT NULL) THEN jsonb_build_object('id', rp.id, 'author', jsonb_build_object('id', rpr.id, 'username', rpr.username, 'display_name', rpr.display_name, 'avatar_url', rpr.avatar_url, 'domain', COALESCE(rpr.domain, 'har.mony.lol'::text), 'handle',
            CASE
                WHEN COALESCE(rpr.is_local, true) THEN ('@'::text || rpr.username)
                ELSE ((('@'::text || rpr.username) || '@'::text) || rpr.domain)
            END), 'created_at', rp.created_at, 'visibility', rp.visibility, 'content', rp.content)
            ELSE NULL::jsonb
        END AS reply_context,
    p.content_warning,
    COALESCE(p.is_sensitive, false) AS is_sensitive,
    p.reblog,
    p.reblog_author,
    p.url
   FROM (((public.posts p
     LEFT JOIN public.profiles pr ON ((p.author_id = pr.id)))
     LEFT JOIN public.posts rp ON ((p.in_reply_to = rp.id)))
     LEFT JOIN public.profiles rpr ON ((rp.author_id = rpr.id)))
  WHERE (p.deleted_at IS NULL);


--
-- Name: VIEW timeline_posts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.timeline_posts IS 'Timeline view including reblog and reblog_author fields for proper reblog display';


--
-- Name: trending_posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trending_posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    post_id uuid NOT NULL,
    trending_score numeric DEFAULT 0.0 NOT NULL,
    engagement_score numeric DEFAULT 0.0 NOT NULL,
    velocity_score numeric DEFAULT 0.0 NOT NULL,
    period_type text DEFAULT 'daily'::text NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    likes_count integer DEFAULT 0,
    reblogs_count integer DEFAULT 0,
    replies_count integer DEFAULT 0,
    total_engagement integer GENERATED ALWAYS AS (((likes_count + reblogs_count) + replies_count)) STORED,
    trending_rank integer
);


--
-- Name: TABLE trending_posts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.trending_posts IS 'Cached trending posts data for performance';


--
-- Name: trending_refresh_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trending_refresh_queue (
    refresh_type text NOT NULL,
    priority text DEFAULT 'normal'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    last_processed_at timestamp with time zone,
    processing_started_at timestamp with time zone,
    is_processing boolean DEFAULT false
);


--
-- Name: trending_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trending_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    user_id uuid NOT NULL,
    trending_score numeric DEFAULT 0.0 NOT NULL,
    followers_growth numeric DEFAULT 0.0,
    engagement_rate numeric DEFAULT 0.0,
    period_type text DEFAULT 'daily'::text NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    new_followers integer DEFAULT 0,
    posts_count integer DEFAULT 0,
    total_engagement integer DEFAULT 0,
    trending_rank integer
);


--
-- Name: TABLE trending_users; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.trending_users IS 'Cached trending users data for performance';


--
-- Name: unread_counts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.unread_counts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    server_id uuid,
    channel_id uuid,
    conversation_id uuid,
    unread_messages integer DEFAULT 0,
    unread_mentions integer DEFAULT 0,
    last_read_message_id uuid,
    last_read_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: user_blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_blocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    blocker_id uuid NOT NULL,
    blocked_user_id uuid NOT NULL,
    block_type text DEFAULT 'full'::text,
    reason text,
    expires_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT user_blocks_block_type_check CHECK ((block_type = ANY (ARRAY['full'::text, 'posts_only'::text, 'interactions_only'::text])))
);


--
-- Name: TABLE user_blocks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_blocks IS 'User-level blocking with granular control and optional expiration';


--
-- Name: user_mutes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_mutes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    muter_id uuid NOT NULL,
    muted_user_id uuid NOT NULL,
    mute_type text DEFAULT 'posts_and_boosts'::text,
    expires_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT user_mutes_mute_type_check CHECK ((mute_type = ANY (ARRAY['posts_only'::text, 'boosts_only'::text, 'posts_and_boosts'::text, 'notifications_only'::text])))
);


--
-- Name: TABLE user_mutes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_mutes IS 'User-level muting with granular control and optional expiration';


--
-- Name: user_private_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_private_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    private_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: user_servers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_servers (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid NOT NULL,
    server_id uuid NOT NULL,
    temporary boolean,
    member_instance text,
    status text DEFAULT 'accepted'::text
);


--
-- Name: COLUMN user_servers.member_instance; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_servers.member_instance IS 'Instance domain of the member (for efficient batching)';


--
-- Name: COLUMN user_servers.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_servers.status IS 'Membership status: pending, accepted, rejected';


--
-- Name: user_servers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.user_servers ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.user_servers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: user_timeline_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_timeline_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    timeline_type text NOT NULL,
    posts_data jsonb DEFAULT '[]'::jsonb NOT NULL,
    last_updated timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT user_timeline_cache_timeline_type_check CHECK ((timeline_type = ANY (ARRAY['home'::text, 'local'::text, 'public'::text])))
);


--
-- Name: voice_federation_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voice_federation_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    session_id text NOT NULL,
    channel_id uuid,
    server_id uuid,
    user_id uuid,
    event_type text NOT NULL,
    ap_activity_id uuid,
    federated_to text[] DEFAULT '{}'::text[],
    voice_state jsonb DEFAULT '{}'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT voice_federation_events_event_type_check CHECK ((event_type = ANY (ARRAY['join'::text, 'leave'::text, 'mute'::text, 'unmute'::text, 'deafen'::text, 'undeafen'::text, 'video_on'::text, 'video_off'::text])))
);


--
-- Name: messages; Type: TABLE; Schema: realtime; Owner: -
--

CREATE TABLE realtime.messages (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    inserted_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL
)
PARTITION BY RANGE (inserted_at);


--
-- Name: messages_2025_11_13; Type: TABLE; Schema: realtime; Owner: -
--

CREATE TABLE realtime.messages_2025_11_13 (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    inserted_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


--
-- Name: messages_2025_11_14; Type: TABLE; Schema: realtime; Owner: -
--

CREATE TABLE realtime.messages_2025_11_14 (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    inserted_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


--
-- Name: messages_2025_11_15; Type: TABLE; Schema: realtime; Owner: -
--

CREATE TABLE realtime.messages_2025_11_15 (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    inserted_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


--
-- Name: messages_2025_11_16; Type: TABLE; Schema: realtime; Owner: -
--

CREATE TABLE realtime.messages_2025_11_16 (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    inserted_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


--
-- Name: messages_2025_11_17; Type: TABLE; Schema: realtime; Owner: -
--

CREATE TABLE realtime.messages_2025_11_17 (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    inserted_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


--
-- Name: messages_2025_11_18; Type: TABLE; Schema: realtime; Owner: -
--

CREATE TABLE realtime.messages_2025_11_18 (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    inserted_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


--
-- Name: messages_2025_11_19; Type: TABLE; Schema: realtime; Owner: -
--

CREATE TABLE realtime.messages_2025_11_19 (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    inserted_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


--
-- Name: schema_migrations; Type: TABLE; Schema: realtime; Owner: -
--

CREATE TABLE realtime.schema_migrations (
    version bigint NOT NULL,
    inserted_at timestamp(0) without time zone
);


--
-- Name: subscription; Type: TABLE; Schema: realtime; Owner: -
--

CREATE TABLE realtime.subscription (
    id bigint NOT NULL,
    subscription_id uuid NOT NULL,
    entity regclass NOT NULL,
    filters realtime.user_defined_filter[] DEFAULT '{}'::realtime.user_defined_filter[] NOT NULL,
    claims jsonb NOT NULL,
    claims_role regrole GENERATED ALWAYS AS (realtime.to_regrole((claims ->> 'role'::text))) STORED NOT NULL,
    created_at timestamp without time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);


--
-- Name: subscription_id_seq; Type: SEQUENCE; Schema: realtime; Owner: -
--

ALTER TABLE realtime.subscription ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME realtime.subscription_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: buckets; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.buckets (
    id text NOT NULL,
    name text NOT NULL,
    owner uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    public boolean DEFAULT false,
    avif_autodetection boolean DEFAULT false,
    file_size_limit bigint,
    allowed_mime_types text[],
    owner_id text
);


--
-- Name: COLUMN buckets.owner; Type: COMMENT; Schema: storage; Owner: -
--

COMMENT ON COLUMN storage.buckets.owner IS 'Field is deprecated, use owner_id instead';


--
-- Name: migrations; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.migrations (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    hash character varying(40) NOT NULL,
    executed_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: objects; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.objects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bucket_id text,
    name text,
    owner uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    last_accessed_at timestamp with time zone DEFAULT now(),
    metadata jsonb,
    path_tokens text[] GENERATED ALWAYS AS (string_to_array(name, '/'::text)) STORED,
    version text,
    owner_id text,
    user_metadata jsonb,
    level integer
);


--
-- Name: COLUMN objects.owner; Type: COMMENT; Schema: storage; Owner: -
--

COMMENT ON COLUMN storage.objects.owner IS 'Field is deprecated, use owner_id instead';


--
-- Name: prefixes; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.prefixes (
    bucket_id text NOT NULL,
    name text NOT NULL COLLATE pg_catalog."C",
    level integer GENERATED ALWAYS AS (storage.get_level(name)) STORED NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: s3_multipart_uploads; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.s3_multipart_uploads (
    id text NOT NULL,
    in_progress_size bigint DEFAULT 0 NOT NULL,
    upload_signature text NOT NULL,
    bucket_id text NOT NULL,
    key text NOT NULL COLLATE pg_catalog."C",
    version text NOT NULL,
    owner_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_metadata jsonb
);


--
-- Name: s3_multipart_uploads_parts; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.s3_multipart_uploads_parts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    upload_id text NOT NULL,
    size bigint DEFAULT 0 NOT NULL,
    part_number integer NOT NULL,
    bucket_id text NOT NULL,
    key text NOT NULL COLLATE pg_catalog."C",
    etag text NOT NULL,
    owner_id text,
    version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: hooks; Type: TABLE; Schema: supabase_functions; Owner: -
--

CREATE TABLE supabase_functions.hooks (
    id bigint NOT NULL,
    hook_table_id integer NOT NULL,
    hook_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    request_id bigint
);


--
-- Name: TABLE hooks; Type: COMMENT; Schema: supabase_functions; Owner: -
--

COMMENT ON TABLE supabase_functions.hooks IS 'Supabase Functions Hooks: Audit trail for triggered hooks.';


--
-- Name: hooks_id_seq; Type: SEQUENCE; Schema: supabase_functions; Owner: -
--

CREATE SEQUENCE supabase_functions.hooks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hooks_id_seq; Type: SEQUENCE OWNED BY; Schema: supabase_functions; Owner: -
--

ALTER SEQUENCE supabase_functions.hooks_id_seq OWNED BY supabase_functions.hooks.id;


--
-- Name: migrations; Type: TABLE; Schema: supabase_functions; Owner: -
--

CREATE TABLE supabase_functions.migrations (
    version text NOT NULL,
    inserted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: messages_2025_11_13; Type: TABLE ATTACH; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages ATTACH PARTITION realtime.messages_2025_11_13 FOR VALUES FROM ('2025-11-13 00:00:00') TO ('2025-11-14 00:00:00');


--
-- Name: messages_2025_11_14; Type: TABLE ATTACH; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages ATTACH PARTITION realtime.messages_2025_11_14 FOR VALUES FROM ('2025-11-14 00:00:00') TO ('2025-11-15 00:00:00');


--
-- Name: messages_2025_11_15; Type: TABLE ATTACH; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages ATTACH PARTITION realtime.messages_2025_11_15 FOR VALUES FROM ('2025-11-15 00:00:00') TO ('2025-11-16 00:00:00');


--
-- Name: messages_2025_11_16; Type: TABLE ATTACH; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages ATTACH PARTITION realtime.messages_2025_11_16 FOR VALUES FROM ('2025-11-16 00:00:00') TO ('2025-11-17 00:00:00');


--
-- Name: messages_2025_11_17; Type: TABLE ATTACH; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages ATTACH PARTITION realtime.messages_2025_11_17 FOR VALUES FROM ('2025-11-17 00:00:00') TO ('2025-11-18 00:00:00');


--
-- Name: messages_2025_11_18; Type: TABLE ATTACH; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages ATTACH PARTITION realtime.messages_2025_11_18 FOR VALUES FROM ('2025-11-18 00:00:00') TO ('2025-11-19 00:00:00');


--
-- Name: messages_2025_11_19; Type: TABLE ATTACH; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages ATTACH PARTITION realtime.messages_2025_11_19 FOR VALUES FROM ('2025-11-19 00:00:00') TO ('2025-11-20 00:00:00');


--
-- Name: refresh_tokens id; Type: DEFAULT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.refresh_tokens ALTER COLUMN id SET DEFAULT nextval('auth.refresh_tokens_id_seq'::regclass);


--
-- Name: activity_processing_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_processing_logs ALTER COLUMN id SET DEFAULT nextval('public.activity_processing_logs_id_seq'::regclass);


--
-- Name: hooks id; Type: DEFAULT; Schema: supabase_functions; Owner: -
--

ALTER TABLE ONLY supabase_functions.hooks ALTER COLUMN id SET DEFAULT nextval('supabase_functions.hooks_id_seq'::regclass);


--
-- Name: extensions extensions_pkey; Type: CONSTRAINT; Schema: _realtime; Owner: -
--

ALTER TABLE ONLY _realtime.extensions
    ADD CONSTRAINT extensions_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: _realtime; Owner: -
--

ALTER TABLE ONLY _realtime.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: _realtime; Owner: -
--

ALTER TABLE ONLY _realtime.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: mfa_amr_claims amr_id_pk; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.mfa_amr_claims
    ADD CONSTRAINT amr_id_pk PRIMARY KEY (id);


--
-- Name: audit_log_entries audit_log_entries_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.audit_log_entries
    ADD CONSTRAINT audit_log_entries_pkey PRIMARY KEY (id);


--
-- Name: flow_state flow_state_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.flow_state
    ADD CONSTRAINT flow_state_pkey PRIMARY KEY (id);


--
-- Name: identities identities_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.identities
    ADD CONSTRAINT identities_pkey PRIMARY KEY (id);


--
-- Name: identities identities_provider_id_provider_unique; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.identities
    ADD CONSTRAINT identities_provider_id_provider_unique UNIQUE (provider_id, provider);


--
-- Name: instances instances_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.instances
    ADD CONSTRAINT instances_pkey PRIMARY KEY (id);


--
-- Name: mfa_amr_claims mfa_amr_claims_session_id_authentication_method_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.mfa_amr_claims
    ADD CONSTRAINT mfa_amr_claims_session_id_authentication_method_pkey UNIQUE (session_id, authentication_method);


--
-- Name: mfa_challenges mfa_challenges_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.mfa_challenges
    ADD CONSTRAINT mfa_challenges_pkey PRIMARY KEY (id);


--
-- Name: mfa_factors mfa_factors_last_challenged_at_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.mfa_factors
    ADD CONSTRAINT mfa_factors_last_challenged_at_key UNIQUE (last_challenged_at);


--
-- Name: mfa_factors mfa_factors_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.mfa_factors
    ADD CONSTRAINT mfa_factors_pkey PRIMARY KEY (id);


--
-- Name: one_time_tokens one_time_tokens_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.one_time_tokens
    ADD CONSTRAINT one_time_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_token_unique; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_unique UNIQUE (token);


--
-- Name: saml_providers saml_providers_entity_id_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.saml_providers
    ADD CONSTRAINT saml_providers_entity_id_key UNIQUE (entity_id);


--
-- Name: saml_providers saml_providers_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.saml_providers
    ADD CONSTRAINT saml_providers_pkey PRIMARY KEY (id);


--
-- Name: saml_relay_states saml_relay_states_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.saml_relay_states
    ADD CONSTRAINT saml_relay_states_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sso_domains sso_domains_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.sso_domains
    ADD CONSTRAINT sso_domains_pkey PRIMARY KEY (id);


--
-- Name: sso_providers sso_providers_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.sso_providers
    ADD CONSTRAINT sso_providers_pkey PRIMARY KEY (id);


--
-- Name: users users_phone_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.users
    ADD CONSTRAINT users_phone_key UNIQUE (phone);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: activity_processing_logs activity_processing_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_processing_logs
    ADD CONSTRAINT activity_processing_logs_pkey PRIMARY KEY (id);


--
-- Name: activitypub_processing_stats activitypub_processing_stats_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activitypub_processing_stats
    ADD CONSTRAINT activitypub_processing_stats_date_key UNIQUE (date);


--
-- Name: activitypub_processing_stats activitypub_processing_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activitypub_processing_stats
    ADD CONSTRAINT activitypub_processing_stats_pkey PRIMARY KEY (id);


--
-- Name: admin_audit_log admin_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_log
    ADD CONSTRAINT admin_audit_log_pkey PRIMARY KEY (id);


--
-- Name: ap_activities ap_activities_ap_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ap_activities
    ADD CONSTRAINT ap_activities_ap_id_key UNIQUE (ap_id);


--
-- Name: ap_activities ap_activities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ap_activities
    ADD CONSTRAINT ap_activities_pkey PRIMARY KEY (id);


--
-- Name: ap_actor_cache ap_actor_cache_ap_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ap_actor_cache
    ADD CONSTRAINT ap_actor_cache_ap_id_key UNIQUE (ap_id);


--
-- Name: ap_actor_cache ap_actor_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ap_actor_cache
    ADD CONSTRAINT ap_actor_cache_pkey PRIMARY KEY (id);


--
-- Name: ap_object_cache ap_object_cache_ap_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ap_object_cache
    ADD CONSTRAINT ap_object_cache_ap_id_key UNIQUE (ap_id);


--
-- Name: ap_object_cache ap_object_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ap_object_cache
    ADD CONSTRAINT ap_object_cache_pkey PRIMARY KEY (id);


--
-- Name: blocked_instances blocked_instances_domain_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocked_instances
    ADD CONSTRAINT blocked_instances_domain_key UNIQUE (domain);


--
-- Name: blocked_instances blocked_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocked_instances
    ADD CONSTRAINT blocked_instances_pkey PRIMARY KEY (id);


--
-- Name: channel_categories channel_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_categories
    ADD CONSTRAINT channel_categories_pkey PRIMARY KEY (id);


--
-- Name: channels channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_pkey PRIMARY KEY (id);


--
-- Name: conversation_participants conversation_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_participants
    ADD CONSTRAINT conversation_participants_pkey PRIMARY KEY (id);


--
-- Name: conversation_participants conversation_participants_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_participants
    ADD CONSTRAINT conversation_participants_unique UNIQUE (conversation_id, user_id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: emoji_usage emoji_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emoji_usage
    ADD CONSTRAINT emoji_usage_pkey PRIMARY KEY (id);


--
-- Name: emojis emojis_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emojis
    ADD CONSTRAINT emojis_pkey PRIMARY KEY (id);


--
-- Name: federated_instances federated_instances_domain_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.federated_instances
    ADD CONSTRAINT federated_instances_domain_key UNIQUE (domain);


--
-- Name: federated_instances federated_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.federated_instances
    ADD CONSTRAINT federated_instances_pkey PRIMARY KEY (id);


--
-- Name: federation_delivery_queue federation_delivery_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.federation_delivery_queue
    ADD CONSTRAINT federation_delivery_queue_pkey PRIMARY KEY (id);


--
-- Name: federation_delivery_stats federation_delivery_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.federation_delivery_stats
    ADD CONSTRAINT federation_delivery_stats_pkey PRIMARY KEY (id);


--
-- Name: files files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_pkey PRIMARY KEY (id);


--
-- Name: follows follows_ap_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_ap_id_key UNIQUE (ap_id);


--
-- Name: follows follows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_pkey PRIMARY KEY (id);


--
-- Name: hashtag_archive hashtag_archive_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hashtag_archive
    ADD CONSTRAINT hashtag_archive_pkey PRIMARY KEY (id);


--
-- Name: hashtags hashtags_normalized_tag_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hashtags
    ADD CONSTRAINT hashtags_normalized_tag_key UNIQUE (normalized_tag);


--
-- Name: hashtags hashtags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hashtags
    ADD CONSTRAINT hashtags_pkey PRIMARY KEY (id);


--
-- Name: emoji_usage idx_emoji_usage_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emoji_usage
    ADD CONSTRAINT idx_emoji_usage_unique UNIQUE (emoji_id, user_id, context_type, context_id);


--
-- Name: instance_config instance_config_config_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_config
    ADD CONSTRAINT instance_config_config_key_key UNIQUE (config_key);


--
-- Name: instance_config instance_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_config
    ADD CONSTRAINT instance_config_pkey PRIMARY KEY (id);


--
-- Name: invites invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: notification_channels notification_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_channels
    ADD CONSTRAINT notification_channels_pkey PRIMARY KEY (id);


--
-- Name: notification_preferences notification_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (id);


--
-- Name: notification_preferences notification_preferences_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_user_id_key UNIQUE (user_id);


--
-- Name: notification_rate_limits notification_rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_rate_limits
    ADD CONSTRAINT notification_rate_limits_pkey PRIMARY KEY (id);


--
-- Name: notification_rate_limits notification_rate_limits_user_id_notification_type_source_u_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_rate_limits
    ADD CONSTRAINT notification_rate_limits_user_id_notification_type_source_u_key UNIQUE (user_id, notification_type, source_user_id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: pg_background_job pg_background_job_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pg_background_job
    ADD CONSTRAINT pg_background_job_pkey PRIMARY KEY (id);


--
-- Name: post_hashtags post_hashtags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_hashtags
    ADD CONSTRAINT post_hashtags_pkey PRIMARY KEY (id);


--
-- Name: post_hashtags post_hashtags_post_id_hashtag_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_hashtags
    ADD CONSTRAINT post_hashtags_post_id_hashtag_id_key UNIQUE (post_id, hashtag_id);


--
-- Name: post_interactions post_interactions_ap_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_interactions
    ADD CONSTRAINT post_interactions_ap_id_key UNIQUE (ap_id);


--
-- Name: post_interactions post_interactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_interactions
    ADD CONSTRAINT post_interactions_pkey PRIMARY KEY (id);


--
-- Name: posts posts_ap_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posts
    ADD CONSTRAINT posts_ap_id_key UNIQUE (ap_id);


--
-- Name: posts posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posts
    ADD CONSTRAINT posts_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_username_domain_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_username_domain_key UNIQUE (username, domain);


--
-- Name: CONSTRAINT profiles_username_domain_key ON profiles; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT profiles_username_domain_key ON public.profiles IS 'Ensures username uniqueness per domain in federated system. Same username can exist on different domains.';


--
-- Name: reactions reactions_message_id_user_id_emoji_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reactions
    ADD CONSTRAINT reactions_message_id_user_id_emoji_id_key UNIQUE (message_id, user_id, emoji_id);


--
-- Name: reactions reactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reactions
    ADD CONSTRAINT reactions_pkey PRIMARY KEY (id);


--
-- Name: server_federation_events server_federation_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_federation_events
    ADD CONSTRAINT server_federation_events_pkey PRIMARY KEY (id);


--
-- Name: server_membership_events server_membership_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_membership_events
    ADD CONSTRAINT server_membership_events_pkey PRIMARY KEY (id);


--
-- Name: servers servers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.servers
    ADD CONSTRAINT servers_pkey PRIMARY KEY (id);


--
-- Name: timeline_entries timeline_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timeline_entries
    ADD CONSTRAINT timeline_entries_pkey PRIMARY KEY (id);


--
-- Name: trending_posts trending_posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trending_posts
    ADD CONSTRAINT trending_posts_pkey PRIMARY KEY (id);


--
-- Name: trending_posts trending_posts_post_id_period_type_period_start_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trending_posts
    ADD CONSTRAINT trending_posts_post_id_period_type_period_start_key UNIQUE (post_id, period_type, period_start);


--
-- Name: trending_users trending_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trending_users
    ADD CONSTRAINT trending_users_pkey PRIMARY KEY (id);


--
-- Name: trending_users trending_users_user_id_period_type_period_start_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trending_users
    ADD CONSTRAINT trending_users_user_id_period_type_period_start_key UNIQUE (user_id, period_type, period_start);


--
-- Name: unread_counts unread_counts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unread_counts
    ADD CONSTRAINT unread_counts_pkey PRIMARY KEY (id);


--
-- Name: user_blocks user_blocks_blocker_id_blocked_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_blocks
    ADD CONSTRAINT user_blocks_blocker_id_blocked_user_id_key UNIQUE (blocker_id, blocked_user_id);


--
-- Name: user_blocks user_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_blocks
    ADD CONSTRAINT user_blocks_pkey PRIMARY KEY (id);


--
-- Name: user_mutes user_mutes_muter_id_muted_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_mutes
    ADD CONSTRAINT user_mutes_muter_id_muted_user_id_key UNIQUE (muter_id, muted_user_id);


--
-- Name: user_mutes user_mutes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_mutes
    ADD CONSTRAINT user_mutes_pkey PRIMARY KEY (id);


--
-- Name: user_private_keys user_private_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_private_keys
    ADD CONSTRAINT user_private_keys_pkey PRIMARY KEY (id);


--
-- Name: user_private_keys user_private_keys_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_private_keys
    ADD CONSTRAINT user_private_keys_user_id_key UNIQUE (user_id);


--
-- Name: user_servers user_servers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_servers
    ADD CONSTRAINT user_servers_pkey PRIMARY KEY (id);


--
-- Name: user_servers user_servers_user_id_server_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_servers
    ADD CONSTRAINT user_servers_user_id_server_id_unique UNIQUE (user_id, server_id);


--
-- Name: CONSTRAINT user_servers_user_id_server_id_unique ON user_servers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT user_servers_user_id_server_id_unique ON public.user_servers IS 'Ensures a user can only be a member of each server once';


--
-- Name: user_timeline_cache user_timeline_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_timeline_cache
    ADD CONSTRAINT user_timeline_cache_pkey PRIMARY KEY (id);


--
-- Name: user_timeline_cache user_timeline_cache_user_id_timeline_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_timeline_cache
    ADD CONSTRAINT user_timeline_cache_user_id_timeline_type_key UNIQUE (user_id, timeline_type);


--
-- Name: voice_federation_events voice_federation_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_federation_events
    ADD CONSTRAINT voice_federation_events_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id, inserted_at);


--
-- Name: messages_2025_11_13 messages_2025_11_13_pkey; Type: CONSTRAINT; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages_2025_11_13
    ADD CONSTRAINT messages_2025_11_13_pkey PRIMARY KEY (id, inserted_at);


--
-- Name: messages_2025_11_14 messages_2025_11_14_pkey; Type: CONSTRAINT; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages_2025_11_14
    ADD CONSTRAINT messages_2025_11_14_pkey PRIMARY KEY (id, inserted_at);


--
-- Name: messages_2025_11_15 messages_2025_11_15_pkey; Type: CONSTRAINT; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages_2025_11_15
    ADD CONSTRAINT messages_2025_11_15_pkey PRIMARY KEY (id, inserted_at);


--
-- Name: messages_2025_11_16 messages_2025_11_16_pkey; Type: CONSTRAINT; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages_2025_11_16
    ADD CONSTRAINT messages_2025_11_16_pkey PRIMARY KEY (id, inserted_at);


--
-- Name: messages_2025_11_17 messages_2025_11_17_pkey; Type: CONSTRAINT; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages_2025_11_17
    ADD CONSTRAINT messages_2025_11_17_pkey PRIMARY KEY (id, inserted_at);


--
-- Name: messages_2025_11_18 messages_2025_11_18_pkey; Type: CONSTRAINT; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages_2025_11_18
    ADD CONSTRAINT messages_2025_11_18_pkey PRIMARY KEY (id, inserted_at);


--
-- Name: messages_2025_11_19 messages_2025_11_19_pkey; Type: CONSTRAINT; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages_2025_11_19
    ADD CONSTRAINT messages_2025_11_19_pkey PRIMARY KEY (id, inserted_at);


--
-- Name: subscription pk_subscription; Type: CONSTRAINT; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.subscription
    ADD CONSTRAINT pk_subscription PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: buckets buckets_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.buckets
    ADD CONSTRAINT buckets_pkey PRIMARY KEY (id);


--
-- Name: migrations migrations_name_key; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.migrations
    ADD CONSTRAINT migrations_name_key UNIQUE (name);


--
-- Name: migrations migrations_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.migrations
    ADD CONSTRAINT migrations_pkey PRIMARY KEY (id);


--
-- Name: objects objects_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.objects
    ADD CONSTRAINT objects_pkey PRIMARY KEY (id);


--
-- Name: prefixes prefixes_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.prefixes
    ADD CONSTRAINT prefixes_pkey PRIMARY KEY (bucket_id, level, name);


--
-- Name: s3_multipart_uploads_parts s3_multipart_uploads_parts_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.s3_multipart_uploads_parts
    ADD CONSTRAINT s3_multipart_uploads_parts_pkey PRIMARY KEY (id);


--
-- Name: s3_multipart_uploads s3_multipart_uploads_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.s3_multipart_uploads
    ADD CONSTRAINT s3_multipart_uploads_pkey PRIMARY KEY (id);


--
-- Name: hooks hooks_pkey; Type: CONSTRAINT; Schema: supabase_functions; Owner: -
--

ALTER TABLE ONLY supabase_functions.hooks
    ADD CONSTRAINT hooks_pkey PRIMARY KEY (id);


--
-- Name: migrations migrations_pkey; Type: CONSTRAINT; Schema: supabase_functions; Owner: -
--

ALTER TABLE ONLY supabase_functions.migrations
    ADD CONSTRAINT migrations_pkey PRIMARY KEY (version);


--
-- Name: extensions_tenant_external_id_index; Type: INDEX; Schema: _realtime; Owner: -
--

CREATE INDEX extensions_tenant_external_id_index ON _realtime.extensions USING btree (tenant_external_id);


--
-- Name: extensions_tenant_external_id_type_index; Type: INDEX; Schema: _realtime; Owner: -
--

CREATE UNIQUE INDEX extensions_tenant_external_id_type_index ON _realtime.extensions USING btree (tenant_external_id, type);


--
-- Name: tenants_external_id_index; Type: INDEX; Schema: _realtime; Owner: -
--

CREATE UNIQUE INDEX tenants_external_id_index ON _realtime.tenants USING btree (external_id);


--
-- Name: audit_logs_instance_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX audit_logs_instance_id_idx ON auth.audit_log_entries USING btree (instance_id);


--
-- Name: confirmation_token_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX confirmation_token_idx ON auth.users USING btree (confirmation_token) WHERE ((confirmation_token)::text !~ '^[0-9 ]*$'::text);


--
-- Name: email_change_token_current_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX email_change_token_current_idx ON auth.users USING btree (email_change_token_current) WHERE ((email_change_token_current)::text !~ '^[0-9 ]*$'::text);


--
-- Name: email_change_token_new_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX email_change_token_new_idx ON auth.users USING btree (email_change_token_new) WHERE ((email_change_token_new)::text !~ '^[0-9 ]*$'::text);


--
-- Name: factor_id_created_at_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX factor_id_created_at_idx ON auth.mfa_factors USING btree (user_id, created_at);


--
-- Name: flow_state_created_at_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX flow_state_created_at_idx ON auth.flow_state USING btree (created_at DESC);


--
-- Name: identities_email_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX identities_email_idx ON auth.identities USING btree (email text_pattern_ops);


--
-- Name: INDEX identities_email_idx; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON INDEX auth.identities_email_idx IS 'Auth: Ensures indexed queries on the email column';


--
-- Name: identities_user_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX identities_user_id_idx ON auth.identities USING btree (user_id);


--
-- Name: idx_auth_code; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_auth_code ON auth.flow_state USING btree (auth_code);


--
-- Name: idx_user_id_auth_method; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_user_id_auth_method ON auth.flow_state USING btree (user_id, authentication_method);


--
-- Name: mfa_challenge_created_at_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX mfa_challenge_created_at_idx ON auth.mfa_challenges USING btree (created_at DESC);


--
-- Name: mfa_factors_user_friendly_name_unique; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX mfa_factors_user_friendly_name_unique ON auth.mfa_factors USING btree (friendly_name, user_id) WHERE (TRIM(BOTH FROM friendly_name) <> ''::text);


--
-- Name: mfa_factors_user_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX mfa_factors_user_id_idx ON auth.mfa_factors USING btree (user_id);


--
-- Name: one_time_tokens_relates_to_hash_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX one_time_tokens_relates_to_hash_idx ON auth.one_time_tokens USING hash (relates_to);


--
-- Name: one_time_tokens_token_hash_hash_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX one_time_tokens_token_hash_hash_idx ON auth.one_time_tokens USING hash (token_hash);


--
-- Name: one_time_tokens_user_id_token_type_key; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX one_time_tokens_user_id_token_type_key ON auth.one_time_tokens USING btree (user_id, token_type);


--
-- Name: reauthentication_token_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX reauthentication_token_idx ON auth.users USING btree (reauthentication_token) WHERE ((reauthentication_token)::text !~ '^[0-9 ]*$'::text);


--
-- Name: recovery_token_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX recovery_token_idx ON auth.users USING btree (recovery_token) WHERE ((recovery_token)::text !~ '^[0-9 ]*$'::text);


--
-- Name: refresh_tokens_instance_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX refresh_tokens_instance_id_idx ON auth.refresh_tokens USING btree (instance_id);


--
-- Name: refresh_tokens_instance_id_user_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX refresh_tokens_instance_id_user_id_idx ON auth.refresh_tokens USING btree (instance_id, user_id);


--
-- Name: refresh_tokens_parent_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX refresh_tokens_parent_idx ON auth.refresh_tokens USING btree (parent);


--
-- Name: refresh_tokens_session_id_revoked_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX refresh_tokens_session_id_revoked_idx ON auth.refresh_tokens USING btree (session_id, revoked);


--
-- Name: refresh_tokens_updated_at_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX refresh_tokens_updated_at_idx ON auth.refresh_tokens USING btree (updated_at DESC);


--
-- Name: saml_providers_sso_provider_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX saml_providers_sso_provider_id_idx ON auth.saml_providers USING btree (sso_provider_id);


--
-- Name: saml_relay_states_created_at_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX saml_relay_states_created_at_idx ON auth.saml_relay_states USING btree (created_at DESC);


--
-- Name: saml_relay_states_for_email_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX saml_relay_states_for_email_idx ON auth.saml_relay_states USING btree (for_email);


--
-- Name: saml_relay_states_sso_provider_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX saml_relay_states_sso_provider_id_idx ON auth.saml_relay_states USING btree (sso_provider_id);


--
-- Name: sessions_not_after_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX sessions_not_after_idx ON auth.sessions USING btree (not_after DESC);


--
-- Name: sessions_user_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX sessions_user_id_idx ON auth.sessions USING btree (user_id);


--
-- Name: sso_domains_domain_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX sso_domains_domain_idx ON auth.sso_domains USING btree (lower(domain));


--
-- Name: sso_domains_sso_provider_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX sso_domains_sso_provider_id_idx ON auth.sso_domains USING btree (sso_provider_id);


--
-- Name: sso_providers_resource_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX sso_providers_resource_id_idx ON auth.sso_providers USING btree (lower(resource_id));


--
-- Name: unique_phone_factor_per_user; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX unique_phone_factor_per_user ON auth.mfa_factors USING btree (user_id, phone);


--
-- Name: user_id_created_at_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX user_id_created_at_idx ON auth.sessions USING btree (user_id, created_at);


--
-- Name: users_email_partial_key; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX users_email_partial_key ON auth.users USING btree (email) WHERE (is_sso_user = false);


--
-- Name: INDEX users_email_partial_key; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON INDEX auth.users_email_partial_key IS 'Auth: A partial unique index that applies only when is_sso_user is false';


--
-- Name: users_instance_id_email_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX users_instance_id_email_idx ON auth.users USING btree (instance_id, lower((email)::text));


--
-- Name: users_instance_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX users_instance_id_idx ON auth.users USING btree (instance_id);


--
-- Name: users_is_anonymous_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX users_is_anonymous_idx ON auth.users USING btree (is_anonymous);


--
-- Name: idx_activity_processing_logs_activity_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activity_processing_logs_activity_id ON public.activity_processing_logs USING btree (activity_id);


--
-- Name: idx_activitypub_processing_stats_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activitypub_processing_stats_date ON public.activitypub_processing_stats USING btree (date DESC);


--
-- Name: idx_admin_audit_log_action_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_audit_log_action_type ON public.admin_audit_log USING btree (action_type);


--
-- Name: idx_admin_audit_log_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_audit_log_admin_id ON public.admin_audit_log USING btree (admin_id);


--
-- Name: idx_admin_audit_log_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_audit_log_created_at ON public.admin_audit_log USING btree (created_at DESC);


--
-- Name: idx_ap_activities_actor_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_activities_actor_id ON public.ap_activities USING btree (actor_id);


--
-- Name: idx_ap_activities_actor_id_new; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_activities_actor_id_new ON public.ap_activities USING btree (actor_id);


--
-- Name: idx_ap_activities_ap_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_activities_ap_id ON public.ap_activities USING btree (ap_id);


--
-- Name: idx_ap_activities_ap_id_new; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_activities_ap_id_new ON public.ap_activities USING btree (ap_id);


--
-- Name: idx_ap_activities_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_activities_created_at ON public.ap_activities USING btree (created_at DESC);


--
-- Name: idx_ap_activities_created_at_new; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_activities_created_at_new ON public.ap_activities USING btree (created_at DESC);


--
-- Name: idx_ap_activities_federation_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_activities_federation_status ON public.ap_activities USING btree (status, is_local, created_at) WHERE (status = ANY (ARRAY['pending'::text, 'processing'::text]));


--
-- Name: idx_ap_activities_origin_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_activities_origin_domain ON public.ap_activities USING btree (origin_domain);


--
-- Name: idx_ap_activities_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_activities_status ON public.ap_activities USING btree (status);


--
-- Name: idx_ap_activities_status_new; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_activities_status_new ON public.ap_activities USING btree (status);


--
-- Name: idx_ap_activities_status_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_activities_status_type ON public.ap_activities USING btree (status, ap_type) WHERE (status = 'pending'::text);


--
-- Name: idx_ap_activities_target_new; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_activities_target_new ON public.ap_activities USING btree (target_id, target_type) WHERE (target_id IS NOT NULL);


--
-- Name: idx_ap_activities_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_activities_type ON public.ap_activities USING btree (ap_type);


--
-- Name: idx_ap_activities_type_new; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_activities_type_new ON public.ap_activities USING btree (ap_type);


--
-- Name: idx_ap_actor_cache_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_actor_cache_domain ON public.ap_actor_cache USING btree (domain);


--
-- Name: idx_ap_actor_cache_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_actor_cache_expires ON public.ap_actor_cache USING btree (cache_expires_at);


--
-- Name: idx_ap_actor_cache_username; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_actor_cache_username ON public.ap_actor_cache USING btree (username, domain);


--
-- Name: idx_ap_object_cache_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_object_cache_expires ON public.ap_object_cache USING btree (cache_expires_at);


--
-- Name: idx_ap_object_cache_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_object_cache_type ON public.ap_object_cache USING btree (object_type);


--
-- Name: idx_background_job_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_background_job_queue ON public.pg_background_job USING btree (status, created_at) WHERE (status = 'pending'::text);


--
-- Name: idx_categories_server_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_categories_server_order ON public.channel_categories USING btree (server_id, "order");


--
-- Name: idx_channels_ap_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_channels_ap_id ON public.channels USING btree (ap_id) WHERE (ap_id IS NOT NULL);


--
-- Name: idx_channels_category_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_channels_category_order ON public.channels USING btree (category, "order");


--
-- Name: idx_channels_server_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_channels_server_order ON public.channels USING btree (server_id, "order");


--
-- Name: idx_conversation_participants_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversation_participants_active ON public.conversation_participants USING btree (conversation_id, user_id) WHERE (left_at IS NULL);


--
-- Name: idx_conversation_participants_conversation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversation_participants_conversation ON public.conversation_participants USING btree (conversation_id) WHERE (left_at IS NULL);


--
-- Name: idx_conversation_participants_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversation_participants_user ON public.conversation_participants USING btree (user_id) WHERE (left_at IS NULL);


--
-- Name: idx_conversations_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_created_by ON public.conversations USING btree (created_by);


--
-- Name: idx_conversations_type_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_type_active ON public.conversations USING btree (type, is_active);


--
-- Name: idx_conversations_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_updated_at ON public.conversations USING btree (updated_at DESC);


--
-- Name: idx_delivery_queue_activity_id_new; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_delivery_queue_activity_id_new ON public.federation_delivery_queue USING btree (activity_id);


--
-- Name: idx_delivery_queue_next_attempt_new; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_delivery_queue_next_attempt_new ON public.federation_delivery_queue USING btree (next_attempt_at) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));


--
-- Name: idx_delivery_queue_status_new; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_delivery_queue_status_new ON public.federation_delivery_queue USING btree (status);


--
-- Name: idx_delivery_queue_target_domain_new; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_delivery_queue_target_domain_new ON public.federation_delivery_queue USING btree (target_domain);


--
-- Name: idx_emoji_usage_context; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emoji_usage_context ON public.emoji_usage USING btree (context_type, context_id);


--
-- Name: idx_emoji_usage_emoji_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emoji_usage_emoji_id ON public.emoji_usage USING btree (emoji_id);


--
-- Name: idx_emoji_usage_server_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emoji_usage_server_id ON public.emoji_usage USING btree (server_id);


--
-- Name: idx_emoji_usage_used_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emoji_usage_used_at ON public.emoji_usage USING btree (used_at DESC);


--
-- Name: idx_emoji_usage_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emoji_usage_user_id ON public.emoji_usage USING btree (user_id);


--
-- Name: idx_emojis_domain_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emojis_domain_name ON public.emojis USING btree (domain, name);


--
-- Name: idx_emojis_last_used; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emojis_last_used ON public.emojis USING btree (last_used DESC);


--
-- Name: idx_emojis_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emojis_name ON public.emojis USING btree (name);


--
-- Name: idx_emojis_server_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emojis_server_id ON public.emojis USING btree (server_id);


--
-- Name: idx_emojis_unique_federated_domain_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_emojis_unique_federated_domain_name ON public.emojis USING btree (domain, name) WHERE (domain IS NOT NULL);


--
-- Name: idx_emojis_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emojis_updated_at ON public.emojis USING btree (updated_at);


--
-- Name: idx_emojis_usage_count; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emojis_usage_count ON public.emojis USING btree (usage_count DESC);


--
-- Name: idx_federated_instances_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_federated_instances_domain ON public.federated_instances USING btree (domain);


--
-- Name: idx_federated_instances_is_blocked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_federated_instances_is_blocked ON public.federated_instances USING btree (is_blocked);


--
-- Name: idx_federated_instances_last_seen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_federated_instances_last_seen ON public.federated_instances USING btree (last_seen_at);


--
-- Name: idx_federation_delivery_queue_next_attempt_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_federation_delivery_queue_next_attempt_pending ON public.federation_delivery_queue USING btree (next_attempt_at) WHERE (status = 'pending'::text);


--
-- Name: idx_federation_delivery_stats_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_federation_delivery_stats_period ON public.federation_delivery_stats USING btree (period_start, period_end);


--
-- Name: idx_follows_ap_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_follows_ap_id ON public.follows USING btree (ap_id) WHERE (ap_id IS NOT NULL);


--
-- Name: idx_follows_federation_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_follows_federation_status ON public.follows USING btree (follower_id, following_id, status);


--
-- Name: idx_follows_follower_count; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_follows_follower_count ON public.follows USING btree (following_id) WHERE (status = 'accepted'::text);


--
-- Name: idx_follows_follower_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_follows_follower_id ON public.follows USING btree (follower_id);


--
-- Name: idx_follows_following_count; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_follows_following_count ON public.follows USING btree (follower_id) WHERE (status = 'accepted'::text);


--
-- Name: idx_follows_following_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_follows_following_id ON public.follows USING btree (following_id);


--
-- Name: idx_follows_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_follows_status ON public.follows USING btree (status);


--
-- Name: idx_follows_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_follows_unique ON public.follows USING btree (follower_id, following_id);


--
-- Name: idx_hashtags_daily_uses; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hashtags_daily_uses ON public.hashtags USING btree (daily_uses DESC);


--
-- Name: idx_hashtags_last_used; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hashtags_last_used ON public.hashtags USING btree (last_used_at DESC);


--
-- Name: idx_hashtags_normalized_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hashtags_normalized_tag ON public.hashtags USING btree (normalized_tag);


--
-- Name: idx_hashtags_trending_rank; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hashtags_trending_rank ON public.hashtags USING btree (trending_rank) WHERE (trending_rank IS NOT NULL);


--
-- Name: idx_hashtags_trending_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hashtags_trending_score ON public.hashtags USING btree (trending_score DESC);


--
-- Name: idx_messages_metadata_ap_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_metadata_ap_id ON public.messages USING btree (((metadata ->> 'ap_id'::text))) WHERE ((metadata ->> 'ap_id'::text) IS NOT NULL);


--
-- Name: idx_messages_metadata_federated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_metadata_federated ON public.messages USING gin (metadata) WHERE (metadata IS NOT NULL);


--
-- Name: idx_messages_metadata_from_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_metadata_from_domain ON public.messages USING btree (((metadata ->> 'from_domain'::text))) WHERE ((metadata ->> 'from_domain'::text) IS NOT NULL);


--
-- Name: idx_messages_user_conversation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_user_conversation ON public.messages USING btree (user_id, conversation_id) WHERE (conversation_id IS NOT NULL);


--
-- Name: idx_notification_channels_composite; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_channels_composite ON public.notification_channels USING btree (user_id, server_id, channel_id, conversation_id);


--
-- Name: idx_notification_channels_muted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_channels_muted ON public.notification_channels USING btree (user_id, muted) WHERE (muted = true);


--
-- Name: idx_notification_channels_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_notification_channels_unique ON public.notification_channels USING btree (user_id, server_id, channel_id, conversation_id);


--
-- Name: idx_notification_channels_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_channels_user_id ON public.notification_channels USING btree (user_id);


--
-- Name: idx_notification_preferences_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_preferences_user_id ON public.notification_preferences USING btree (user_id);


--
-- Name: idx_notification_rate_limits_user_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_rate_limits_user_type ON public.notification_rate_limits USING btree (user_id, notification_type, suppressed_until);


--
-- Name: idx_notifications_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_created_at ON public.notifications USING btree (created_at);


--
-- Name: idx_notifications_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_expires_at ON public.notifications USING btree (expires_at);


--
-- Name: idx_notifications_is_read; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_is_read ON public.notifications USING btree (is_read);


--
-- Name: idx_notifications_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_type ON public.notifications USING btree (type);


--
-- Name: idx_notifications_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_user_id ON public.notifications USING btree (user_id);


--
-- Name: idx_post_hashtags_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_post_hashtags_created_at ON public.post_hashtags USING btree (created_at DESC);


--
-- Name: idx_post_hashtags_hashtag_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_post_hashtags_hashtag_id ON public.post_hashtags USING btree (hashtag_id);


--
-- Name: idx_post_hashtags_post_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_post_hashtags_post_id ON public.post_hashtags USING btree (post_id);


--
-- Name: idx_post_interactions_ap_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_post_interactions_ap_id ON public.post_interactions USING btree (ap_id) WHERE (ap_id IS NOT NULL);


--
-- Name: idx_post_interactions_emoji_reactions; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_post_interactions_emoji_reactions ON public.post_interactions USING btree (post_id, emoji_id) WHERE (interaction_type = 'emoji_reaction'::text);


--
-- Name: idx_post_interactions_emoji_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_post_interactions_emoji_unique ON public.post_interactions USING btree (user_id, post_id, interaction_type, emoji_id, custom_emoji_content) WHERE (interaction_type = 'emoji_reaction'::text);


--
-- Name: INDEX idx_post_interactions_emoji_unique; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.idx_post_interactions_emoji_unique IS 'Prevents duplicate emoji reactions but allows multiple different emojis per user per post';


--
-- Name: idx_post_interactions_federation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_post_interactions_federation ON public.post_interactions USING btree (user_id, post_id, interaction_type);


--
-- Name: idx_post_interactions_non_emoji_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_post_interactions_non_emoji_unique ON public.post_interactions USING btree (user_id, post_id, interaction_type) WHERE (interaction_type <> 'emoji_reaction'::text);


--
-- Name: INDEX idx_post_interactions_non_emoji_unique; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.idx_post_interactions_non_emoji_unique IS 'Maintains uniqueness for non-emoji interactions (likes, reblogs, bookmarks)';


--
-- Name: idx_post_interactions_post_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_post_interactions_post_id ON public.post_interactions USING btree (post_id);


--
-- Name: idx_post_interactions_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_post_interactions_type ON public.post_interactions USING btree (interaction_type);


--
-- Name: idx_post_interactions_unique_emoji_by_content; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_post_interactions_unique_emoji_by_content ON public.post_interactions USING btree (user_id, post_id, interaction_type, custom_emoji_content) WHERE ((interaction_type = 'emoji_reaction'::text) AND (custom_emoji_content IS NOT NULL));


--
-- Name: INDEX idx_post_interactions_unique_emoji_by_content; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.idx_post_interactions_unique_emoji_by_content IS 'Prevents duplicate emoji reactions using custom_emoji_content (unicode/text emojis)';


--
-- Name: idx_post_interactions_unique_emoji_by_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_post_interactions_unique_emoji_by_id ON public.post_interactions USING btree (user_id, post_id, interaction_type, emoji_id) WHERE ((interaction_type = 'emoji_reaction'::text) AND (emoji_id IS NOT NULL));


--
-- Name: INDEX idx_post_interactions_unique_emoji_by_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.idx_post_interactions_unique_emoji_by_id IS 'Prevents duplicate emoji reactions using emoji_id (custom server emojis)';


--
-- Name: idx_post_interactions_unique_non_emoji; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_post_interactions_unique_non_emoji ON public.post_interactions USING btree (user_id, post_id, interaction_type) WHERE (interaction_type <> 'emoji_reaction'::text);


--
-- Name: INDEX idx_post_interactions_unique_non_emoji; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.idx_post_interactions_unique_non_emoji IS 'Ensures unique interactions per user per post for non-emoji interactions (like, reblog, bookmark, etc.)';


--
-- Name: idx_post_interactions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_post_interactions_user_id ON public.post_interactions USING btree (user_id);


--
-- Name: idx_post_interactions_user_post_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_post_interactions_user_post_type ON public.post_interactions USING btree (user_id, post_id, interaction_type);


--
-- Name: idx_posts_ap_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_ap_id ON public.posts USING btree (ap_id) WHERE (ap_id IS NOT NULL);


--
-- Name: idx_posts_author_count; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_author_count ON public.posts USING btree (author_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_posts_author_federation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_author_federation ON public.posts USING btree (author_id) WHERE (author_id IS NOT NULL);


--
-- Name: idx_posts_author_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_author_id ON public.posts USING btree (author_id);


--
-- Name: idx_posts_conversation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_conversation_id ON public.posts USING btree (conversation_id) WHERE (conversation_id IS NOT NULL);


--
-- Name: idx_posts_conversation_performance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_conversation_performance ON public.posts USING btree (conversation_root_id, created_at) WHERE (conversation_root_id IS NOT NULL);


--
-- Name: idx_posts_conversation_root_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_conversation_root_id ON public.posts USING btree (conversation_root_id);


--
-- Name: idx_posts_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_created_at ON public.posts USING btree (created_at DESC);


--
-- Name: idx_posts_featured_engagement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_featured_engagement ON public.posts USING btree (author_id, (((favorites_count + reblogs_count) + replies_count)) DESC, created_at DESC) WHERE (((favorites_count + reblogs_count) + replies_count) > 0);


--
-- Name: idx_posts_federation_visibility; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_federation_visibility ON public.posts USING btree (visibility, is_federated, created_at) WHERE (is_federated = true);


--
-- Name: idx_posts_in_reply_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_in_reply_to ON public.posts USING btree (in_reply_to) WHERE (in_reply_to IS NOT NULL);


--
-- Name: idx_posts_in_reply_to_conversation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_in_reply_to_conversation ON public.posts USING btree (in_reply_to, conversation_root_id) WHERE (in_reply_to IS NOT NULL);


--
-- Name: idx_posts_is_deleted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_is_deleted ON public.posts USING btree (is_deleted);


--
-- Name: idx_posts_is_local; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_is_local ON public.posts USING btree (is_local);


--
-- Name: idx_posts_local_public_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_local_public_created_at ON public.posts USING btree (is_local, created_at DESC) WHERE ((visibility = 'public'::text) AND (NOT COALESCE(is_deleted, false)));


--
-- Name: idx_posts_pinned; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_pinned ON public.posts USING btree (author_id, is_pinned, created_at DESC) WHERE (is_pinned = true);


--
-- Name: idx_posts_public_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_public_created_at ON public.posts USING btree (created_at DESC) WHERE ((visibility = 'public'::text) AND (NOT COALESCE(is_deleted, false)));


--
-- Name: idx_posts_public_timeline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_public_timeline ON public.posts USING btree (created_at DESC) WHERE ((visibility = ANY (ARRAY['public'::text, 'unlisted'::text])) AND (is_deleted = false));


--
-- Name: idx_posts_timeline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_timeline ON public.posts USING btree (author_id, created_at DESC) WHERE (is_deleted = false);


--
-- Name: idx_posts_visibility; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_visibility ON public.posts USING btree (visibility);


--
-- Name: idx_profiles_auth_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_auth_user_id ON public.profiles USING btree (auth_user_id);


--
-- Name: idx_profiles_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_domain ON public.profiles USING btree (domain);


--
-- Name: idx_profiles_federated_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_profiles_federated_id ON public.profiles USING btree (federated_id) WHERE (federated_id IS NOT NULL);


--
-- Name: idx_profiles_federation_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_federation_enabled ON public.profiles USING btree (id) WHERE (is_local = true);


--
-- Name: idx_profiles_federation_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_federation_lookup ON public.profiles USING btree (domain, federation_enabled) WHERE (federation_enabled = true);


--
-- Name: idx_profiles_is_local_username; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_is_local_username ON public.profiles USING btree (is_local, username) WHERE (is_local = true);


--
-- Name: idx_profiles_manually_approves; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_manually_approves ON public.profiles USING btree (manually_approves_followers) WHERE (manually_approves_followers = true);


--
-- Name: idx_profiles_shared_inbox_url; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_shared_inbox_url ON public.profiles USING btree (shared_inbox_url) WHERE (shared_inbox_url IS NOT NULL);


--
-- Name: idx_profiles_username_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_username_domain ON public.profiles USING btree (username, domain);


--
-- Name: idx_reactions_message_user_emoji; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reactions_message_user_emoji ON public.reactions USING btree (message_id, user_id, emoji_id);


--
-- Name: idx_reactions_user_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reactions_user_message ON public.reactions USING btree (user_id, message_id);


--
-- Name: idx_server_federation_events_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_server_federation_events_domain ON public.server_federation_events USING btree (server_domain, created_at DESC);


--
-- Name: idx_server_federation_events_server; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_server_federation_events_server ON public.server_federation_events USING btree (server_id, created_at DESC);


--
-- Name: idx_server_federation_events_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_server_federation_events_user ON public.server_federation_events USING btree (user_id, created_at DESC);


--
-- Name: idx_server_membership_events_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_server_membership_events_created_at ON public.server_membership_events USING btree (created_at);


--
-- Name: idx_server_membership_events_server_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_server_membership_events_server_event ON public.server_membership_events USING btree (server_id, event_type, created_at);


--
-- Name: idx_server_membership_events_server_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_server_membership_events_server_id ON public.server_membership_events USING btree (server_id);


--
-- Name: idx_server_membership_events_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_server_membership_events_user_id ON public.server_membership_events USING btree (user_id);


--
-- Name: idx_servers_ap_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_servers_ap_id ON public.servers USING btree (ap_id) WHERE (ap_id IS NOT NULL);


--
-- Name: idx_servers_federation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_servers_federation ON public.servers USING btree (federation_enabled, is_local_server);


--
-- Name: idx_timeline_entries_post_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_timeline_entries_post_id ON public.timeline_entries USING btree (post_id);


--
-- Name: idx_timeline_entries_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_timeline_entries_unique ON public.timeline_entries USING btree (user_id, post_id, timeline_type);


--
-- Name: idx_timeline_entries_user_home_position; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_timeline_entries_user_home_position ON public.timeline_entries USING btree (user_id, timeline_type, "position" DESC) WHERE (timeline_type = 'home'::text);


--
-- Name: idx_timeline_entries_user_timeline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_timeline_entries_user_timeline ON public.timeline_entries USING btree (user_id, timeline_type, created_at DESC);


--
-- Name: idx_trending_posts_engagement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trending_posts_engagement ON public.trending_posts USING btree (total_engagement DESC);


--
-- Name: idx_trending_posts_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trending_posts_period ON public.trending_posts USING btree (period_type, period_start DESC);


--
-- Name: idx_trending_posts_rank; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trending_posts_rank ON public.trending_posts USING btree (trending_rank) WHERE (trending_rank IS NOT NULL);


--
-- Name: idx_trending_posts_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trending_posts_score ON public.trending_posts USING btree (trending_score DESC);


--
-- Name: idx_trending_users_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trending_users_period ON public.trending_users USING btree (period_type, period_start DESC);


--
-- Name: idx_trending_users_rank; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trending_users_rank ON public.trending_users USING btree (trending_rank) WHERE (trending_rank IS NOT NULL);


--
-- Name: idx_trending_users_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trending_users_score ON public.trending_users USING btree (trending_score DESC);


--
-- Name: idx_unread_counts_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_unread_counts_unique ON public.unread_counts USING btree (user_id, server_id, channel_id, conversation_id);


--
-- Name: idx_user_blocks_blocked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_blocks_blocked ON public.user_blocks USING btree (blocked_user_id, block_type, expires_at);


--
-- Name: idx_user_blocks_blocker; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_blocks_blocker ON public.user_blocks USING btree (blocker_id, block_type, expires_at);


--
-- Name: idx_user_mutes_muter; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_mutes_muter ON public.user_mutes USING btree (muter_id, mute_type, expires_at);


--
-- Name: idx_user_servers_by_instance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_servers_by_instance ON public.user_servers USING btree (server_id, member_instance);


--
-- Name: idx_user_servers_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_servers_status ON public.user_servers USING btree (server_id, status);


--
-- Name: idx_user_timeline_cache_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_timeline_cache_lookup ON public.user_timeline_cache USING btree (user_id, timeline_type);


--
-- Name: idx_user_timeline_cache_posts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_timeline_cache_posts ON public.user_timeline_cache USING gin (posts_data);


--
-- Name: idx_voice_federation_events_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_voice_federation_events_channel ON public.voice_federation_events USING btree (channel_id, created_at DESC);


--
-- Name: idx_voice_federation_events_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_voice_federation_events_session ON public.voice_federation_events USING btree (session_id, created_at DESC);


--
-- Name: idx_voice_federation_events_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_voice_federation_events_user ON public.voice_federation_events USING btree (user_id, created_at DESC);


--
-- Name: timeline_posts_local_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX timeline_posts_local_created_idx ON public.posts USING btree (is_local, created_at DESC) WHERE ((is_deleted = false) AND (visibility = 'public'::text));


--
-- Name: timeline_posts_visibility_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX timeline_posts_visibility_created_idx ON public.posts USING btree (visibility, created_at DESC) WHERE (is_deleted = false);


--
-- Name: ix_realtime_subscription_entity; Type: INDEX; Schema: realtime; Owner: -
--

CREATE INDEX ix_realtime_subscription_entity ON realtime.subscription USING btree (entity);


--
-- Name: subscription_subscription_id_entity_filters_key; Type: INDEX; Schema: realtime; Owner: -
--

CREATE UNIQUE INDEX subscription_subscription_id_entity_filters_key ON realtime.subscription USING btree (subscription_id, entity, filters);


--
-- Name: bname; Type: INDEX; Schema: storage; Owner: -
--

CREATE UNIQUE INDEX bname ON storage.buckets USING btree (name);


--
-- Name: bucketid_objname; Type: INDEX; Schema: storage; Owner: -
--

CREATE UNIQUE INDEX bucketid_objname ON storage.objects USING btree (bucket_id, name);


--
-- Name: idx_multipart_uploads_list; Type: INDEX; Schema: storage; Owner: -
--

CREATE INDEX idx_multipart_uploads_list ON storage.s3_multipart_uploads USING btree (bucket_id, key, created_at);


--
-- Name: idx_name_bucket_level_unique; Type: INDEX; Schema: storage; Owner: -
--

CREATE UNIQUE INDEX idx_name_bucket_level_unique ON storage.objects USING btree (name COLLATE "C", bucket_id, level);


--
-- Name: idx_objects_bucket_id_name; Type: INDEX; Schema: storage; Owner: -
--

CREATE INDEX idx_objects_bucket_id_name ON storage.objects USING btree (bucket_id, name COLLATE "C");


--
-- Name: idx_objects_lower_name; Type: INDEX; Schema: storage; Owner: -
--

CREATE INDEX idx_objects_lower_name ON storage.objects USING btree ((path_tokens[level]), lower(name) text_pattern_ops, bucket_id, level);


--
-- Name: idx_prefixes_lower_name; Type: INDEX; Schema: storage; Owner: -
--

CREATE INDEX idx_prefixes_lower_name ON storage.prefixes USING btree (bucket_id, level, ((string_to_array(name, '/'::text))[level]), lower(name) text_pattern_ops);


--
-- Name: name_prefix_search; Type: INDEX; Schema: storage; Owner: -
--

CREATE INDEX name_prefix_search ON storage.objects USING btree (name text_pattern_ops);


--
-- Name: objects_bucket_id_level_idx; Type: INDEX; Schema: storage; Owner: -
--

CREATE UNIQUE INDEX objects_bucket_id_level_idx ON storage.objects USING btree (bucket_id, level, name COLLATE "C");


--
-- Name: supabase_functions_hooks_h_table_id_h_name_idx; Type: INDEX; Schema: supabase_functions; Owner: -
--

CREATE INDEX supabase_functions_hooks_h_table_id_h_name_idx ON supabase_functions.hooks USING btree (hook_table_id, hook_name);


--
-- Name: supabase_functions_hooks_request_id_idx; Type: INDEX; Schema: supabase_functions; Owner: -
--

CREATE INDEX supabase_functions_hooks_request_id_idx ON supabase_functions.hooks USING btree (request_id);


--
-- Name: messages_2025_11_13_pkey; Type: INDEX ATTACH; Schema: realtime; Owner: -
--

ALTER INDEX realtime.messages_pkey ATTACH PARTITION realtime.messages_2025_11_13_pkey;


--
-- Name: messages_2025_11_14_pkey; Type: INDEX ATTACH; Schema: realtime; Owner: -
--

ALTER INDEX realtime.messages_pkey ATTACH PARTITION realtime.messages_2025_11_14_pkey;


--
-- Name: messages_2025_11_15_pkey; Type: INDEX ATTACH; Schema: realtime; Owner: -
--

ALTER INDEX realtime.messages_pkey ATTACH PARTITION realtime.messages_2025_11_15_pkey;


--
-- Name: messages_2025_11_16_pkey; Type: INDEX ATTACH; Schema: realtime; Owner: -
--

ALTER INDEX realtime.messages_pkey ATTACH PARTITION realtime.messages_2025_11_16_pkey;


--
-- Name: messages_2025_11_17_pkey; Type: INDEX ATTACH; Schema: realtime; Owner: -
--

ALTER INDEX realtime.messages_pkey ATTACH PARTITION realtime.messages_2025_11_17_pkey;


--
-- Name: messages_2025_11_18_pkey; Type: INDEX ATTACH; Schema: realtime; Owner: -
--

ALTER INDEX realtime.messages_pkey ATTACH PARTITION realtime.messages_2025_11_18_pkey;


--
-- Name: messages_2025_11_19_pkey; Type: INDEX ATTACH; Schema: realtime; Owner: -
--

ALTER INDEX realtime.messages_pkey ATTACH PARTITION realtime.messages_2025_11_19_pkey;


--
-- Name: federation_delivery_queue Federated Outbox; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "Federated Outbox" AFTER INSERT ON public.federation_delivery_queue FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request('http://kong:8000/functions/v1/outbox/delivery', 'POST', '{"Content-type":"application/json"}', '{}', '5000');


--
-- Name: follows add_posts_to_new_follower_timeline; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER add_posts_to_new_follower_timeline AFTER INSERT OR UPDATE ON public.follows FOR EACH ROW WHEN ((new.status = 'accepted'::text)) EXECUTE FUNCTION public.add_existing_posts_to_new_follower_timeline();


--
-- Name: user_servers auto_set_member_instance; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auto_set_member_instance BEFORE INSERT ON public.user_servers FOR EACH ROW EXECUTE FUNCTION public.set_member_instance();


--
-- Name: TRIGGER auto_set_member_instance ON user_servers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TRIGGER auto_set_member_instance ON public.user_servers IS 'Automatically set member_instance from user profile domain';


--
-- Name: follows backfill_timeline_on_follow_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER backfill_timeline_on_follow_trigger AFTER INSERT OR UPDATE OF status ON public.follows FOR EACH ROW WHEN ((new.status = 'accepted'::text)) EXECUTE FUNCTION public.backfill_timeline_on_follow();


--
-- Name: posts create_comprehensive_timeline_entries_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER create_comprehensive_timeline_entries_trigger AFTER INSERT ON public.posts FOR EACH ROW EXECUTE FUNCTION public.create_comprehensive_timeline_entries();


--
-- Name: profiles create_notification_preferences_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER create_notification_preferences_trigger AFTER INSERT ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.create_notification_preferences();


--
-- Name: follows remove_timeline_on_unfollow_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER remove_timeline_on_unfollow_trigger BEFORE DELETE ON public.follows FOR EACH ROW EXECUTE FUNCTION public.remove_timeline_on_unfollow();


--
-- Name: user_servers route_leave_federation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER route_leave_federation AFTER DELETE ON public.user_servers FOR EACH ROW EXECUTE FUNCTION public.route_server_leave();


--
-- Name: TRIGGER route_leave_federation ON user_servers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TRIGGER route_leave_federation ON public.user_servers IS 'Routes leave events to federation backend';


--
-- Name: user_servers route_membership_federation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER route_membership_federation AFTER INSERT OR UPDATE ON public.user_servers FOR EACH ROW EXECUTE FUNCTION public.route_server_membership();


--
-- Name: TRIGGER route_membership_federation ON user_servers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TRIGGER route_membership_federation ON public.user_servers IS 'Routes membership events to federation backend when needed';


--
-- Name: messages smart_route_channel_message; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER smart_route_channel_message AFTER INSERT ON public.messages FOR EACH ROW WHEN ((new.channel_id IS NOT NULL)) EXECUTE FUNCTION public.route_channel_message();


--
-- Name: TRIGGER smart_route_channel_message ON messages; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TRIGGER smart_route_channel_message ON public.messages IS 'Routes channel messages: local members via real-time, remote members via federation';


--
-- Name: messages trg_handle_message_federation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_handle_message_federation AFTER INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.handle_message_federation();


--
-- Name: TRIGGER trg_handle_message_federation ON messages; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TRIGGER trg_handle_message_federation ON public.messages IS 'Handles local notifications for all messages (both local and federated)';


--
-- Name: messages trg_handle_outgoing_messages; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_handle_outgoing_messages AFTER INSERT ON public.messages FOR EACH ROW WHEN (((new.metadata ->> 'federated'::text) IS DISTINCT FROM 'true'::text)) EXECUTE FUNCTION public.handle_outgoing_messages();


--
-- Name: TRIGGER trg_handle_outgoing_messages ON messages; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TRIGGER trg_handle_outgoing_messages ON public.messages IS 'FIXED: Only triggers for outgoing local messages (metadata.federated != true). Prevents federation loops and ensures DM federation works.';


--
-- Name: post_interactions trigger_check_emoji_reaction_limit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_check_emoji_reaction_limit BEFORE INSERT ON public.post_interactions FOR EACH ROW EXECUTE FUNCTION public.check_emoji_reaction_limit();


--
-- Name: reactions trigger_check_message_emoji_reaction_limit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_check_message_emoji_reaction_limit BEFORE INSERT ON public.reactions FOR EACH ROW EXECUTE FUNCTION public.check_message_emoji_reaction_limit();


--
-- Name: post_interactions trigger_post_interaction_federation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_post_interaction_federation AFTER INSERT OR DELETE ON public.post_interactions FOR EACH ROW EXECUTE FUNCTION public.handle_post_interaction_federation();


--
-- Name: TRIGGER trigger_post_interaction_federation ON post_interactions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TRIGGER trigger_post_interaction_federation ON public.post_interactions IS 'Automatically federates emoji reactions to ActivityPub network when users add/remove reactions.';


--
-- Name: post_interactions trigger_unified_interaction_federation_likes; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_unified_interaction_federation_likes AFTER INSERT OR DELETE ON public.post_interactions FOR EACH ROW EXECUTE FUNCTION public.handle_unified_interaction_federation();


--
-- Name: follows trigger_unified_notification_follows; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_unified_notification_follows AFTER INSERT ON public.follows FOR EACH ROW EXECUTE FUNCTION public.handle_unified_notification_processing();


--
-- Name: post_interactions trigger_unified_notification_interactions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_unified_notification_interactions AFTER INSERT ON public.post_interactions FOR EACH ROW EXECUTE FUNCTION public.handle_unified_notification_processing();


--
-- Name: profiles trigger_unified_profile_federation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_unified_profile_federation AFTER UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.handle_unified_profile_federation();


--
-- Name: follows trigger_update_follow_counters; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_update_follow_counters AFTER INSERT OR DELETE OR UPDATE ON public.follows FOR EACH ROW EXECUTE FUNCTION public.update_follow_counters();


--
-- Name: ap_activities unified_activitypub_processing_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER unified_activitypub_processing_trigger AFTER UPDATE ON public.ap_activities FOR EACH ROW EXECUTE FUNCTION public.handle_activitypub_activity_processing();


--
-- Name: TRIGGER unified_activitypub_processing_trigger ON ap_activities; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TRIGGER unified_activitypub_processing_trigger ON public.ap_activities IS 'Processes ActivityPub activities ready for processing. Replaces business logic that was previously in the inbox for better performance and maintainability.';


--
-- Name: posts update_post_reply_counter_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_post_reply_counter_trigger AFTER INSERT OR DELETE ON public.posts FOR EACH ROW EXECUTE FUNCTION public.update_post_counters();


--
-- Name: posts update_reply_counts_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_reply_counts_trigger AFTER INSERT OR DELETE ON public.posts FOR EACH ROW EXECUTE FUNCTION public.update_reply_counts();


--
-- Name: subscription tr_check_filters; Type: TRIGGER; Schema: realtime; Owner: -
--

CREATE TRIGGER tr_check_filters BEFORE INSERT OR UPDATE ON realtime.subscription FOR EACH ROW EXECUTE FUNCTION realtime.subscription_check_filters();


--
-- Name: buckets enforce_bucket_name_length_trigger; Type: TRIGGER; Schema: storage; Owner: -
--

CREATE TRIGGER enforce_bucket_name_length_trigger BEFORE INSERT OR UPDATE OF name ON storage.buckets FOR EACH ROW EXECUTE FUNCTION storage.enforce_bucket_name_length();


--
-- Name: objects objects_delete_delete_prefix; Type: TRIGGER; Schema: storage; Owner: -
--

CREATE TRIGGER objects_delete_delete_prefix AFTER DELETE ON storage.objects FOR EACH ROW EXECUTE FUNCTION storage.delete_prefix_hierarchy_trigger();


--
-- Name: objects objects_insert_create_prefix; Type: TRIGGER; Schema: storage; Owner: -
--

CREATE TRIGGER objects_insert_create_prefix BEFORE INSERT ON storage.objects FOR EACH ROW EXECUTE FUNCTION storage.objects_insert_prefix_trigger();


--
-- Name: objects objects_update_create_prefix; Type: TRIGGER; Schema: storage; Owner: -
--

CREATE TRIGGER objects_update_create_prefix BEFORE UPDATE ON storage.objects FOR EACH ROW WHEN (((new.name <> old.name) OR (new.bucket_id <> old.bucket_id))) EXECUTE FUNCTION storage.objects_update_prefix_trigger();


--
-- Name: prefixes prefixes_create_hierarchy; Type: TRIGGER; Schema: storage; Owner: -
--

CREATE TRIGGER prefixes_create_hierarchy BEFORE INSERT ON storage.prefixes FOR EACH ROW WHEN ((pg_trigger_depth() < 1)) EXECUTE FUNCTION storage.prefixes_insert_trigger();


--
-- Name: prefixes prefixes_delete_hierarchy; Type: TRIGGER; Schema: storage; Owner: -
--

CREATE TRIGGER prefixes_delete_hierarchy AFTER DELETE ON storage.prefixes FOR EACH ROW EXECUTE FUNCTION storage.delete_prefix_hierarchy_trigger();


--
-- Name: objects update_objects_updated_at; Type: TRIGGER; Schema: storage; Owner: -
--

CREATE TRIGGER update_objects_updated_at BEFORE UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();


--
-- Name: extensions extensions_tenant_external_id_fkey; Type: FK CONSTRAINT; Schema: _realtime; Owner: -
--

ALTER TABLE ONLY _realtime.extensions
    ADD CONSTRAINT extensions_tenant_external_id_fkey FOREIGN KEY (tenant_external_id) REFERENCES _realtime.tenants(external_id) ON DELETE CASCADE;


--
-- Name: identities identities_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.identities
    ADD CONSTRAINT identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: mfa_amr_claims mfa_amr_claims_session_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.mfa_amr_claims
    ADD CONSTRAINT mfa_amr_claims_session_id_fkey FOREIGN KEY (session_id) REFERENCES auth.sessions(id) ON DELETE CASCADE;


--
-- Name: mfa_challenges mfa_challenges_auth_factor_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.mfa_challenges
    ADD CONSTRAINT mfa_challenges_auth_factor_id_fkey FOREIGN KEY (factor_id) REFERENCES auth.mfa_factors(id) ON DELETE CASCADE;


--
-- Name: mfa_factors mfa_factors_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.mfa_factors
    ADD CONSTRAINT mfa_factors_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: one_time_tokens one_time_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.one_time_tokens
    ADD CONSTRAINT one_time_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_session_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.refresh_tokens
    ADD CONSTRAINT refresh_tokens_session_id_fkey FOREIGN KEY (session_id) REFERENCES auth.sessions(id) ON DELETE CASCADE;


--
-- Name: saml_providers saml_providers_sso_provider_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.saml_providers
    ADD CONSTRAINT saml_providers_sso_provider_id_fkey FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers(id) ON DELETE CASCADE;


--
-- Name: saml_relay_states saml_relay_states_flow_state_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.saml_relay_states
    ADD CONSTRAINT saml_relay_states_flow_state_id_fkey FOREIGN KEY (flow_state_id) REFERENCES auth.flow_state(id) ON DELETE CASCADE;


--
-- Name: saml_relay_states saml_relay_states_sso_provider_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.saml_relay_states
    ADD CONSTRAINT saml_relay_states_sso_provider_id_fkey FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: sso_domains sso_domains_sso_provider_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.sso_domains
    ADD CONSTRAINT sso_domains_sso_provider_id_fkey FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers(id) ON DELETE CASCADE;


--
-- Name: admin_audit_log admin_audit_log_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_log
    ADD CONSTRAINT admin_audit_log_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: ap_activities ap_activities_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ap_activities
    ADD CONSTRAINT ap_activities_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: blocked_instances blocked_instances_blocked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocked_instances
    ADD CONSTRAINT blocked_instances_blocked_by_fkey FOREIGN KEY (blocked_by) REFERENCES public.profiles(id);


--
-- Name: channel_categories channel_categories_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_categories
    ADD CONSTRAINT channel_categories_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: channels channels_category_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_category_fkey FOREIGN KEY (category) REFERENCES public.channel_categories(id);


--
-- Name: channels channels_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: conversation_participants conversation_participants_conversation_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_participants
    ADD CONSTRAINT conversation_participants_conversation_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: conversation_participants conversation_participants_user_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_participants
    ADD CONSTRAINT conversation_participants_user_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: emoji_usage emoji_usage_emoji_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emoji_usage
    ADD CONSTRAINT emoji_usage_emoji_id_fkey FOREIGN KEY (emoji_id) REFERENCES public.emojis(id) ON DELETE CASCADE;


--
-- Name: emoji_usage emoji_usage_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emoji_usage
    ADD CONSTRAINT emoji_usage_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: emoji_usage emoji_usage_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emoji_usage
    ADD CONSTRAINT emoji_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: emojis emojis_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emojis
    ADD CONSTRAINT emojis_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: emojis emojis_uploader_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emojis
    ADD CONSTRAINT emojis_uploader_fkey FOREIGN KEY (uploader) REFERENCES public.profiles(id);


--
-- Name: federation_delivery_queue federation_delivery_queue_activity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.federation_delivery_queue
    ADD CONSTRAINT federation_delivery_queue_activity_id_fkey FOREIGN KEY (activity_id) REFERENCES public.ap_activities(id) ON DELETE CASCADE;


--
-- Name: files files_owner_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_owner_fkey FOREIGN KEY (owner) REFERENCES public.profiles(id);


--
-- Name: follows follows_follower_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_follower_id_fkey FOREIGN KEY (follower_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: follows follows_following_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_following_id_fkey FOREIGN KEY (following_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: instance_config instance_config_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_config
    ADD CONSTRAINT instance_config_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.profiles(id);


--
-- Name: invites invites_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: invites invites_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: messages messages_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: messages messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: messages messages_reply_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_reply_to_fkey FOREIGN KEY (reply_to) REFERENCES public.messages(id);


--
-- Name: messages messages_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id);


--
-- Name: notification_channels notification_channels_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_channels
    ADD CONSTRAINT notification_channels_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: notification_channels notification_channels_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_channels
    ADD CONSTRAINT notification_channels_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: notification_channels notification_channels_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_channels
    ADD CONSTRAINT notification_channels_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: notification_channels notification_channels_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_channels
    ADD CONSTRAINT notification_channels_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: notification_preferences notification_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: notification_rate_limits notification_rate_limits_source_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_rate_limits
    ADD CONSTRAINT notification_rate_limits_source_user_id_fkey FOREIGN KEY (source_user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: notification_rate_limits notification_rate_limits_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_rate_limits
    ADD CONSTRAINT notification_rate_limits_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: post_hashtags post_hashtags_hashtag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_hashtags
    ADD CONSTRAINT post_hashtags_hashtag_id_fkey FOREIGN KEY (hashtag_id) REFERENCES public.hashtags(id) ON DELETE CASCADE;


--
-- Name: post_hashtags post_hashtags_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_hashtags
    ADD CONSTRAINT post_hashtags_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE;


--
-- Name: post_interactions post_interactions_emoji_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_interactions
    ADD CONSTRAINT post_interactions_emoji_id_fkey FOREIGN KEY (emoji_id) REFERENCES public.emojis(id);


--
-- Name: post_interactions post_interactions_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_interactions
    ADD CONSTRAINT post_interactions_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE;


--
-- Name: post_interactions post_interactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_interactions
    ADD CONSTRAINT post_interactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: posts posts_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posts
    ADD CONSTRAINT posts_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: posts posts_in_reply_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posts
    ADD CONSTRAINT posts_in_reply_to_fkey FOREIGN KEY (in_reply_to) REFERENCES public.posts(id) ON DELETE SET NULL;


--
-- Name: profiles profiles_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: reactions reactions_emoji_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reactions
    ADD CONSTRAINT reactions_emoji_id_fkey FOREIGN KEY (emoji_id) REFERENCES public.emojis(id) ON DELETE CASCADE;


--
-- Name: reactions reactions_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reactions
    ADD CONSTRAINT reactions_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE;


--
-- Name: reactions reactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reactions
    ADD CONSTRAINT reactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: server_federation_events server_federation_events_ap_activity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_federation_events
    ADD CONSTRAINT server_federation_events_ap_activity_id_fkey FOREIGN KEY (ap_activity_id) REFERENCES public.ap_activities(id) ON DELETE SET NULL;


--
-- Name: server_federation_events server_federation_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_federation_events
    ADD CONSTRAINT server_federation_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: server_membership_events server_membership_events_initiated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_membership_events
    ADD CONSTRAINT server_membership_events_initiated_by_fkey FOREIGN KEY (initiated_by) REFERENCES public.profiles(id);


--
-- Name: server_membership_events server_membership_events_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_membership_events
    ADD CONSTRAINT server_membership_events_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: server_membership_events server_membership_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_membership_events
    ADD CONSTRAINT server_membership_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: servers servers_owner_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.servers
    ADD CONSTRAINT servers_owner_fkey FOREIGN KEY (owner) REFERENCES public.profiles(id);


--
-- Name: timeline_entries timeline_entries_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timeline_entries
    ADD CONSTRAINT timeline_entries_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE;


--
-- Name: timeline_entries timeline_entries_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timeline_entries
    ADD CONSTRAINT timeline_entries_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: trending_posts trending_posts_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trending_posts
    ADD CONSTRAINT trending_posts_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE;


--
-- Name: trending_users trending_users_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trending_users
    ADD CONSTRAINT trending_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: unread_counts unread_counts_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unread_counts
    ADD CONSTRAINT unread_counts_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: unread_counts unread_counts_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unread_counts
    ADD CONSTRAINT unread_counts_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: unread_counts unread_counts_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unread_counts
    ADD CONSTRAINT unread_counts_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: unread_counts unread_counts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unread_counts
    ADD CONSTRAINT unread_counts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_blocks user_blocks_blocked_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_blocks
    ADD CONSTRAINT user_blocks_blocked_user_id_fkey FOREIGN KEY (blocked_user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_blocks user_blocks_blocker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_blocks
    ADD CONSTRAINT user_blocks_blocker_id_fkey FOREIGN KEY (blocker_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_mutes user_mutes_muted_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_mutes
    ADD CONSTRAINT user_mutes_muted_user_id_fkey FOREIGN KEY (muted_user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_mutes user_mutes_muter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_mutes
    ADD CONSTRAINT user_mutes_muter_id_fkey FOREIGN KEY (muter_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_private_keys user_private_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_private_keys
    ADD CONSTRAINT user_private_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_servers user_servers_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_servers
    ADD CONSTRAINT user_servers_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: user_servers user_servers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_servers
    ADD CONSTRAINT user_servers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_timeline_cache user_timeline_cache_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_timeline_cache
    ADD CONSTRAINT user_timeline_cache_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: voice_federation_events voice_federation_events_ap_activity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_federation_events
    ADD CONSTRAINT voice_federation_events_ap_activity_id_fkey FOREIGN KEY (ap_activity_id) REFERENCES public.ap_activities(id) ON DELETE SET NULL;


--
-- Name: voice_federation_events voice_federation_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_federation_events
    ADD CONSTRAINT voice_federation_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: objects objects_bucketId_fkey; Type: FK CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.objects
    ADD CONSTRAINT "objects_bucketId_fkey" FOREIGN KEY (bucket_id) REFERENCES storage.buckets(id);


--
-- Name: prefixes prefixes_bucketId_fkey; Type: FK CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.prefixes
    ADD CONSTRAINT "prefixes_bucketId_fkey" FOREIGN KEY (bucket_id) REFERENCES storage.buckets(id);


--
-- Name: s3_multipart_uploads s3_multipart_uploads_bucket_id_fkey; Type: FK CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.s3_multipart_uploads
    ADD CONSTRAINT s3_multipart_uploads_bucket_id_fkey FOREIGN KEY (bucket_id) REFERENCES storage.buckets(id);


--
-- Name: s3_multipart_uploads_parts s3_multipart_uploads_parts_bucket_id_fkey; Type: FK CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.s3_multipart_uploads_parts
    ADD CONSTRAINT s3_multipart_uploads_parts_bucket_id_fkey FOREIGN KEY (bucket_id) REFERENCES storage.buckets(id);


--
-- Name: s3_multipart_uploads_parts s3_multipart_uploads_parts_upload_id_fkey; Type: FK CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.s3_multipart_uploads_parts
    ADD CONSTRAINT s3_multipart_uploads_parts_upload_id_fkey FOREIGN KEY (upload_id) REFERENCES storage.s3_multipart_uploads(id) ON DELETE CASCADE;


--
-- Name: audit_log_entries; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.audit_log_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: flow_state; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.flow_state ENABLE ROW LEVEL SECURITY;

--
-- Name: identities; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.identities ENABLE ROW LEVEL SECURITY;

--
-- Name: instances; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.instances ENABLE ROW LEVEL SECURITY;

--
-- Name: mfa_amr_claims; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.mfa_amr_claims ENABLE ROW LEVEL SECURITY;

--
-- Name: mfa_challenges; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.mfa_challenges ENABLE ROW LEVEL SECURITY;

--
-- Name: mfa_factors; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.mfa_factors ENABLE ROW LEVEL SECURITY;

--
-- Name: one_time_tokens; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.one_time_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: refresh_tokens; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.refresh_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: saml_providers; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.saml_providers ENABLE ROW LEVEL SECURITY;

--
-- Name: saml_relay_states; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.saml_relay_states ENABLE ROW LEVEL SECURITY;

--
-- Name: schema_migrations; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.schema_migrations ENABLE ROW LEVEL SECURITY;

--
-- Name: sessions; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: sso_domains; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.sso_domains ENABLE ROW LEVEL SECURITY;

--
-- Name: sso_providers; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.sso_providers ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;

--
-- Name: emojis A; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "A" ON public.emojis USING (true);


--
-- Name: admin_audit_log Admin audit log admin access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin audit log admin access" ON public.admin_audit_log TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.is_admin = true)))));


--
-- Name: user_servers Allow all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all" ON public.user_servers TO authenticated USING (true) WITH CHECK (true);


--
-- Name: conversation_participants Anyone can view conversation participants; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view conversation participants" ON public.conversation_participants FOR SELECT USING (true);


--
-- Name: conversations Anyone can view conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view conversations" ON public.conversations FOR SELECT USING (true);


--
-- Name: federated_instances Anyone can view federated instances; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view federated instances" ON public.federated_instances FOR SELECT USING (true);


--
-- Name: hashtags Anyone can view hashtags; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view hashtags" ON public.hashtags FOR SELECT USING (true);


--
-- Name: post_hashtags Anyone can view post hashtags; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view post hashtags" ON public.post_hashtags FOR SELECT USING (true);


--
-- Name: trending_posts Anyone can view trending posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view trending posts" ON public.trending_posts FOR SELECT USING (true);


--
-- Name: trending_users Anyone can view trending users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view trending users" ON public.trending_users FOR SELECT USING (true);


--
-- Name: conversations Authenticated users can create conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can create conversations" ON public.conversations FOR INSERT WITH CHECK ((auth.uid() IS NOT NULL));


--
-- Name: conversation_participants Authenticated users can manage participants; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can manage participants" ON public.conversation_participants FOR INSERT WITH CHECK ((auth.uid() IS NOT NULL));


--
-- Name: blocked_instances Blocked instances admin access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Blocked instances admin access" ON public.blocked_instances TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.is_admin = true)))));


--
-- Name: user_blocks Check if blocked by user; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Check if blocked by user" ON public.user_blocks FOR SELECT USING ((blocked_user_id = auth.uid()));


--
-- Name: conversations Conversation participants can update conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Conversation participants can update conversations" ON public.conversations FOR UPDATE USING (((auth.uid() IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.conversation_participants cp
  WHERE ((cp.conversation_id = conversations.id) AND (cp.user_id = auth.uid()) AND (cp.left_at IS NULL)))))) WITH CHECK ((auth.uid() IS NOT NULL));


--
-- Name: notifications Enable insert for authenticated users only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable insert for authenticated users only" ON public.notifications FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: servers Enable insert for authenticated users only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable insert for authenticated users only" ON public.servers FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: notifications Enable insert for users based on user_id; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable insert for users based on user_id" ON public.notifications FOR UPDATE USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: channel_categories Enable read access for all users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable read access for all users" ON public.channel_categories FOR SELECT USING (true);


--
-- Name: invites Enable read access for all users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable read access for all users" ON public.invites FOR SELECT USING (true);


--
-- Name: profiles Enable read access for all users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable read access for all users" ON public.profiles FOR SELECT USING (true);


--
-- Name: servers Enable read access for all users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable read access for all users" ON public.servers FOR SELECT USING (true);


--
-- Name: user_servers Enable read access for all users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable read access for all users" ON public.user_servers FOR SELECT USING (true);


--
-- Name: notifications Enable users to view their own data only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable users to view their own data only" ON public.notifications FOR SELECT TO authenticated USING (true);


--
-- Name: invites FIXME: Enable insert for authenticated users only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "FIXME: Enable insert for authenticated users only" ON public.invites FOR INSERT WITH CHECK (true);


--
-- Name: channel_categories FIXME: Server owners can insert/update/delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "FIXME: Server owners can insert/update/delete" ON public.channel_categories USING (true) WITH CHECK (true);


--
-- Name: invites FIXME: update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "FIXME: update" ON public.invites FOR UPDATE USING (true) WITH CHECK (true);


--
-- Name: instance_config Instance config admin access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Instance config admin access" ON public.instance_config TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.is_admin = true)))));


--
-- Name: server_membership_events Members can view server membership events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can view server membership events" ON public.server_membership_events FOR SELECT TO authenticated USING ((server_id IN ( SELECT us.server_id
   FROM public.user_servers us
  WHERE (us.user_id = auth.uid()))));


--
-- Name: messages Message owner or server owner can update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Message owner or server owner can update" ON public.messages FOR UPDATE USING (((auth.uid() = user_id) OR (auth.uid() = ( SELECT servers.owner
   FROM (public.servers
     JOIN public.channels ON ((servers.id = channels.server_id)))
  WHERE (channels.id = messages.channel_id)))));


--
-- Name: federated_instances Only authenticated users can manage instances; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Only authenticated users can manage instances" ON public.federated_instances USING ((auth.uid() IS NOT NULL));


--
-- Name: hashtags Only system can modify hashtags; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Only system can modify hashtags" ON public.hashtags USING (false) WITH CHECK (false);


--
-- Name: post_hashtags Only system can modify post hashtags; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Only system can modify post hashtags" ON public.post_hashtags USING (false) WITH CHECK (false);


--
-- Name: trending_posts Only system can modify trending posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Only system can modify trending posts" ON public.trending_posts USING (false) WITH CHECK (false);


--
-- Name: trending_users Only system can modify trending users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Only system can modify trending users" ON public.trending_users USING (false) WITH CHECK (false);


--
-- Name: instance_config Public can read federation settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public can read federation settings" ON public.instance_config FOR SELECT USING ((config_key = ANY (ARRAY['federation_settings'::text, 'domain'::text, 'instance_name'::text, 'instance_description'::text, 'open_registration'::text, 'approval_required'::text])));


--
-- Name: profiles Service Role Can Read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service Role Can Read" ON public.profiles FOR SELECT USING (true);


--
-- Name: ap_actor_cache Service role can manage actor cache; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage actor cache" ON public.ap_actor_cache USING ((auth.role() = 'service_role'::text));


--
-- Name: federation_delivery_queue Service role can manage delivery queue; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage delivery queue" ON public.federation_delivery_queue USING ((auth.role() = 'service_role'::text));


--
-- Name: federation_delivery_queue Service role can manage federation queue; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage federation queue" ON public.federation_delivery_queue TO service_role USING (true) WITH CHECK (true);


--
-- Name: ap_object_cache Service role can manage object cache; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage object cache" ON public.ap_object_cache USING ((auth.role() = 'service_role'::text));


--
-- Name: user_blocks Service role can read all blocks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can read all blocks" ON public.user_blocks FOR SELECT TO service_role USING (true);


--
-- Name: pg_background_job Service role manages all background jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role manages all background jobs" ON public.pg_background_job USING ((auth.role() = 'service_role'::text));


--
-- Name: user_private_keys Service role only access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role only access" ON public.user_private_keys USING ((auth.role() = 'service_role'::text));


--
-- Name: server_membership_events System can insert membership events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "System can insert membership events" ON public.server_membership_events FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: ap_activities System can manage ActivityPub activities; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "System can manage ActivityPub activities" ON public.ap_activities USING (true);


--
-- Name: timeline_entries System can manage all timeline entries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "System can manage all timeline entries" ON public.timeline_entries USING (true) WITH CHECK (true);


--
-- Name: profiles System can manage federated profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "System can manage federated profiles" ON public.profiles USING (((is_local = false) OR (auth_user_id = auth.uid())));


--
-- Name: unread_counts System can manage unread counts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "System can manage unread counts" ON public.unread_counts WITH CHECK (true);


--
-- Name: servers Update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Update" ON public.servers FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = servers.owner) AND (profiles.auth_user_id = auth.uid()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = servers.owner) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: user_timeline_cache Users can access own timeline cache; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can access own timeline cache" ON public.user_timeline_cache USING ((auth.uid() = user_id));


--
-- Name: user_blocks Users can block other users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can block other users" ON public.user_blocks FOR INSERT WITH CHECK ((blocker_id = auth.uid()));


--
-- Name: pg_background_job Users can create background jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create background jobs" ON public.pg_background_job FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: follows Users can create follow relationships; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create follow relationships" ON public.follows FOR INSERT WITH CHECK ((auth.uid() = follower_id));


--
-- Name: messages Users can create messages in conversations they participate in; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create messages in conversations they participate in" ON public.messages FOR INSERT WITH CHECK (((user_id = auth.uid()) AND (((conversation_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.conversation_participants
  WHERE ((conversation_participants.conversation_id = messages.conversation_id) AND (conversation_participants.user_id = auth.uid()) AND (conversation_participants.left_at IS NULL))))) OR ((channel_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM (public.channels c
     JOIN public.user_servers us ON ((c.server_id = us.server_id)))
  WHERE ((c.id = messages.channel_id) AND (us.user_id = auth.uid()))))))));


--
-- Name: post_interactions Users can create post interactions on posts they can see; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create post interactions on posts they can see" ON public.post_interactions FOR INSERT WITH CHECK (((user_id = auth.uid()) AND (post_id IN ( SELECT p.id
   FROM public.posts p
  WHERE ((p.author_id = auth.uid()) OR (p.visibility = 'public'::text) OR ((p.visibility = 'followers'::text) AND (EXISTS ( SELECT 1
           FROM public.follows f
          WHERE ((f.follower_id = auth.uid()) AND (f.following_id = p.author_id) AND (f.status = 'accepted'::text))))))))));


--
-- Name: reactions Users can create reactions on messages they can see; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create reactions on messages they can see" ON public.reactions FOR INSERT WITH CHECK (((user_id = auth.uid()) AND (message_id IN ( SELECT m.id
   FROM public.messages m
  WHERE ((m.conversation_id IN ( SELECT conversation_participants.conversation_id
           FROM public.conversation_participants
          WHERE ((conversation_participants.user_id = auth.uid()) AND (conversation_participants.left_at IS NULL)))) OR (m.channel_id IN ( SELECT c.id
           FROM (public.channels c
             JOIN public.user_servers us ON ((c.server_id = us.server_id)))
          WHERE (us.user_id = auth.uid()))))))));


--
-- Name: ap_activities Users can create their own activities; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create their own activities" ON public.ap_activities FOR INSERT WITH CHECK ((actor_id = auth.uid()));


--
-- Name: post_interactions Users can create their own interactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create their own interactions" ON public.post_interactions FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: posts Users can create their own posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create their own posts" ON public.posts FOR INSERT WITH CHECK ((auth.uid() = author_id));


--
-- Name: server_federation_events Users can create their own server events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create their own server events" ON public.server_federation_events FOR INSERT WITH CHECK ((user_id = auth.uid()));


--
-- Name: voice_federation_events Users can create their own voice events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create their own voice events" ON public.voice_federation_events FOR INSERT WITH CHECK ((user_id = auth.uid()));


--
-- Name: follows Users can delete their follow relationships; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their follow relationships" ON public.follows FOR DELETE USING (((auth.uid() = follower_id) OR (auth.uid() = following_id)));


--
-- Name: post_interactions Users can delete their own interactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own interactions" ON public.post_interactions FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: post_interactions Users can delete their own post interactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own post interactions" ON public.post_interactions FOR DELETE USING ((user_id = auth.uid()));


--
-- Name: posts Users can delete their own posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own posts" ON public.posts FOR DELETE USING ((auth.uid() = author_id));


--
-- Name: reactions Users can delete their own reactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own reactions" ON public.reactions FOR DELETE USING ((user_id = auth.uid()));


--
-- Name: profiles Users can insert their own profile.; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own profile." ON public.profiles FOR INSERT WITH CHECK ((auth.uid() = id));


--
-- Name: timeline_entries Users can insert their own timeline entries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own timeline entries" ON public.timeline_entries FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: conversation_participants Users can leave conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can leave conversations" ON public.conversation_participants FOR DELETE USING (((auth.uid() IS NOT NULL) AND (user_id = auth.uid())));


--
-- Name: notification_channels Users can manage their own notification channels; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can manage their own notification channels" ON public.notification_channels USING ((auth.uid() = user_id));


--
-- Name: notification_preferences Users can manage their own notification preferences; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can manage their own notification preferences" ON public.notification_preferences USING ((auth.uid() = user_id));


--
-- Name: user_blocks Users can remove their own blocks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can remove their own blocks" ON public.user_blocks FOR DELETE USING ((blocker_id = auth.uid()));


--
-- Name: conversations Users can update conversations they participate in; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update conversations they participate in" ON public.conversations FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.conversation_participants
  WHERE ((conversation_participants.conversation_id = conversations.id) AND (conversation_participants.user_id = auth.uid()) AND (conversation_participants.left_at IS NULL)))));


--
-- Name: profiles Users can update own profile.; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own profile." ON public.profiles FOR UPDATE USING ((auth.uid() = id));


--
-- Name: follows Users can update their follow relationships; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their follow relationships" ON public.follows FOR UPDATE USING (((auth.uid() = follower_id) OR (auth.uid() = following_id)));


--
-- Name: ap_activities Users can update their own activities; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own activities" ON public.ap_activities FOR UPDATE USING ((actor_id = auth.uid()));


--
-- Name: post_interactions Users can update their own interactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own interactions" ON public.post_interactions FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: conversation_participants Users can update their own participation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own participation" ON public.conversation_participants FOR UPDATE USING (((auth.uid() IS NOT NULL) AND (user_id = auth.uid()))) WITH CHECK (((auth.uid() IS NOT NULL) AND (user_id = auth.uid())));


--
-- Name: conversation_participants Users can update their own participations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own participations" ON public.conversation_participants FOR UPDATE USING ((user_id = auth.uid()));


--
-- Name: post_interactions Users can update their own post interactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own post interactions" ON public.post_interactions FOR UPDATE USING ((user_id = auth.uid()));


--
-- Name: posts Users can update their own posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own posts" ON public.posts FOR UPDATE USING ((auth.uid() = author_id));


--
-- Name: reactions Users can update their own reactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own reactions" ON public.reactions FOR UPDATE USING ((user_id = auth.uid()));


--
-- Name: unread_counts Users can update their own unread counts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own unread counts" ON public.unread_counts FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: post_interactions Users can view all interactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view all interactions" ON public.post_interactions FOR SELECT USING (true);


--
-- Name: profiles Users can view all profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view all profiles" ON public.profiles FOR SELECT USING (true);


--
-- Name: conversations Users can view conversations they participate in; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view conversations they participate in" ON public.conversations FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.conversation_participants
  WHERE ((conversation_participants.conversation_id = conversations.id) AND (conversation_participants.user_id = auth.uid()) AND (conversation_participants.left_at IS NULL)))));


--
-- Name: federation_delivery_queue Users can view federation delivery queue; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view federation delivery queue" ON public.federation_delivery_queue FOR SELECT TO authenticated USING (true);


--
-- Name: follows Users can view follows; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view follows" ON public.follows FOR SELECT USING (((auth.uid() = follower_id) OR (auth.uid() = following_id)));


--
-- Name: messages Users can view messages in conversations they participate in; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view messages in conversations they participate in" ON public.messages FOR SELECT USING ((((conversation_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.conversation_participants
  WHERE ((conversation_participants.conversation_id = messages.conversation_id) AND (conversation_participants.user_id = auth.uid()) AND (conversation_participants.left_at IS NULL))))) OR ((channel_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM (public.channels c
     JOIN public.user_servers us ON ((c.server_id = us.server_id)))
  WHERE ((c.id = messages.channel_id) AND (us.user_id = auth.uid())))))));


--
-- Name: post_interactions Users can view post interactions on posts they can see; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view post interactions on posts they can see" ON public.post_interactions FOR SELECT USING ((post_id IN ( SELECT p.id
   FROM public.posts p
  WHERE ((p.author_id = auth.uid()) OR (p.visibility = 'public'::text) OR ((p.visibility = 'followers'::text) AND (EXISTS ( SELECT 1
           FROM public.follows f
          WHERE ((f.follower_id = auth.uid()) AND (f.following_id = p.author_id) AND (f.status = 'accepted'::text)))))))));


--
-- Name: posts Users can view posts from users they follow; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view posts from users they follow" ON public.posts FOR SELECT USING (((visibility = 'followers'::text) AND (is_deleted = false) AND (EXISTS ( SELECT 1
   FROM public.follows
  WHERE ((follows.follower_id = auth.uid()) AND (follows.following_id = posts.author_id) AND (follows.status = 'accepted'::text))))));


--
-- Name: posts Users can view public posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view public posts" ON public.posts FOR SELECT USING (((visibility = ANY (ARRAY['public'::text, 'unlisted'::text])) AND (is_deleted = false)));


--
-- Name: reactions Users can view reactions on messages they can see; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view reactions on messages they can see" ON public.reactions FOR SELECT USING ((message_id IN ( SELECT m.id
   FROM public.messages m
  WHERE ((m.conversation_id IN ( SELECT conversation_participants.conversation_id
           FROM public.conversation_participants
          WHERE ((conversation_participants.user_id = auth.uid()) AND (conversation_participants.left_at IS NULL)))) OR (m.channel_id IN ( SELECT c.id
           FROM (public.channels c
             JOIN public.user_servers us ON ((c.server_id = us.server_id)))
          WHERE (us.user_id = auth.uid())))))));


--
-- Name: server_federation_events Users can view server events they're involved in; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view server events they're involved in" ON public.server_federation_events FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: ap_activities Users can view their own activities; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own activities" ON public.ap_activities FOR SELECT USING ((actor_id = auth.uid()));


--
-- Name: user_blocks Users can view their own blocks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own blocks" ON public.user_blocks FOR SELECT USING ((blocker_id = auth.uid()));


--
-- Name: posts Users can view their own posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own posts" ON public.posts FOR SELECT USING ((auth.uid() = author_id));


--
-- Name: timeline_entries Users can view their own timeline entries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own timeline entries" ON public.timeline_entries FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: unread_counts Users can view their own unread counts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own unread counts" ON public.unread_counts FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: voice_federation_events Users can view voice events they're involved in; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view voice events they're involved in" ON public.voice_federation_events FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: admin_audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: ap_activities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ap_activities ENABLE ROW LEVEL SECURITY;

--
-- Name: ap_actor_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ap_actor_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: ap_object_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ap_object_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: blocked_instances; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.blocked_instances ENABLE ROW LEVEL SECURITY;

--
-- Name: channel_categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.channel_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: channel_categories channel_categories_update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY channel_categories_update_policy ON public.channel_categories FOR UPDATE TO authenticated USING ((server_id IN ( SELECT user_servers.server_id
   FROM public.user_servers
  WHERE (user_servers.user_id = auth.uid()))));


--
-- Name: channels; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;

--
-- Name: channels channels_delete_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY channels_delete_policy ON public.channels FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.servers s
  WHERE ((s.id = channels.server_id) AND (s.owner = auth.uid())))));


--
-- Name: channels channels_insert_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY channels_insert_policy ON public.channels FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.servers s
  WHERE ((s.id = channels.server_id) AND (s.owner = auth.uid())))));


--
-- Name: channels channels_select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY channels_select_policy ON public.channels FOR SELECT TO authenticated USING ((server_id IN ( SELECT user_servers.server_id
   FROM public.user_servers
  WHERE (user_servers.user_id = auth.uid()))));


--
-- Name: channels channels_update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY channels_update_policy ON public.channels FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.servers s
  WHERE ((s.id = channels.server_id) AND (s.owner = auth.uid()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.servers s
  WHERE ((s.id = channels.server_id) AND (s.owner = auth.uid())))));


--
-- Name: conversation_participants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversation_participants ENABLE ROW LEVEL SECURITY;

--
-- Name: conversation_participants conversation_participants_delete_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY conversation_participants_delete_policy ON public.conversation_participants FOR DELETE USING ((user_id = auth.uid()));


--
-- Name: conversation_participants conversation_participants_insert_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY conversation_participants_insert_policy ON public.conversation_participants FOR INSERT WITH CHECK (((user_id = auth.uid()) OR (auth.uid() IN ( SELECT cp.user_id
   FROM public.conversation_participants cp
  WHERE ((cp.conversation_id = conversation_participants.conversation_id) AND (cp.left_at IS NULL))))));


--
-- Name: conversation_participants conversation_participants_select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY conversation_participants_select_policy ON public.conversation_participants FOR SELECT USING (true);


--
-- Name: conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: emojis emoji_access_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY emoji_access_policy ON public.emojis TO authenticated USING ((server_id IN ( SELECT user_servers.server_id
   FROM public.user_servers
  WHERE (user_servers.user_id = auth.uid()))));


--
-- Name: emojis emoji_public_access_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY emoji_public_access_policy ON public.emojis FOR SELECT TO authenticated USING ((server_id IN ( SELECT servers.id
   FROM public.servers
  WHERE (servers.public = true))));


--
-- Name: emoji_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.emoji_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: emoji_usage emoji_usage_access_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY emoji_usage_access_policy ON public.emoji_usage TO authenticated USING ((server_id IN ( SELECT user_servers.server_id
   FROM public.user_servers
  WHERE (user_servers.user_id = auth.uid()))));


--
-- Name: emojis; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.emojis ENABLE ROW LEVEL SECURITY;

--
-- Name: federated_instances; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.federated_instances ENABLE ROW LEVEL SECURITY;

--
-- Name: federation_delivery_queue; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.federation_delivery_queue ENABLE ROW LEVEL SECURITY;

--
-- Name: files; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.files ENABLE ROW LEVEL SECURITY;

--
-- Name: follows; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;

--
-- Name: hashtags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hashtags ENABLE ROW LEVEL SECURITY;

--
-- Name: instance_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.instance_config ENABLE ROW LEVEL SECURITY;

--
-- Name: invites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invites ENABLE ROW LEVEL SECURITY;

--
-- Name: messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

--
-- Name: messages messages_delete_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY messages_delete_policy ON public.messages FOR DELETE USING (((user_id = auth.uid()) OR ((channel_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM (public.channels
     JOIN public.servers ON ((channels.server_id = servers.id)))
  WHERE ((channels.id = messages.channel_id) AND (servers.owner = auth.uid())))))));


--
-- Name: notification_channels; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_channels ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_preferences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications notifications_realtime_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notifications_realtime_delete ON public.notifications FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: pg_background_job; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pg_background_job ENABLE ROW LEVEL SECURITY;

--
-- Name: post_hashtags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.post_hashtags ENABLE ROW LEVEL SECURITY;

--
-- Name: post_interactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.post_interactions ENABLE ROW LEVEL SECURITY;

--
-- Name: posts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: reactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reactions ENABLE ROW LEVEL SECURITY;

--
-- Name: servers server_delete_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY server_delete_policy ON public.servers FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = servers.owner) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: server_federation_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.server_federation_events ENABLE ROW LEVEL SECURITY;

--
-- Name: server_membership_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.server_membership_events ENABLE ROW LEVEL SECURITY;

--
-- Name: servers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.servers ENABLE ROW LEVEL SECURITY;

--
-- Name: timeline_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.timeline_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: trending_posts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trending_posts ENABLE ROW LEVEL SECURITY;

--
-- Name: trending_users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trending_users ENABLE ROW LEVEL SECURITY;

--
-- Name: unread_counts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.unread_counts ENABLE ROW LEVEL SECURITY;

--
-- Name: user_blocks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY;

--
-- Name: user_private_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_private_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: user_servers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_servers ENABLE ROW LEVEL SECURITY;

--
-- Name: user_timeline_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_timeline_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: voice_federation_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.voice_federation_events ENABLE ROW LEVEL SECURITY;

--
-- Name: messages; Type: ROW SECURITY; Schema: realtime; Owner: -
--

ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

--
-- Name: objects Admins and server owners can delete emojis; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Admins and server owners can delete emojis" ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'emojis'::text) AND ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = auth.uid()) AND (profiles.is_admin = true)))) OR (EXISTS ( SELECT 1
   FROM (public.servers s
     JOIN public.profiles p ON ((s.owner = p.id)))
  WHERE ((p.auth_user_id = auth.uid()) AND ((s.id)::text = (storage.foldername(objects.name))[1])))))));


--
-- Name: objects Admins and server owners can delete server icons; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Admins and server owners can delete server icons" ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'server_icons'::text) AND ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = auth.uid()) AND (profiles.is_admin = true)))) OR (EXISTS ( SELECT 1
   FROM (public.servers s
     JOIN public.profiles p ON ((s.owner = p.id)))
  WHERE ((p.auth_user_id = auth.uid()) AND ((s.id)::text = (storage.foldername(objects.name))[1])))))));


--
-- Name: objects Admins and server owners can update emojis; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Admins and server owners can update emojis" ON storage.objects FOR UPDATE TO authenticated USING (((bucket_id = 'emojis'::text) AND ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = auth.uid()) AND (profiles.is_admin = true)))) OR (EXISTS ( SELECT 1
   FROM (public.servers s
     JOIN public.profiles p ON ((s.owner = p.id)))
  WHERE ((p.auth_user_id = auth.uid()) AND ((s.id)::text = (storage.foldername(objects.name))[1]))))))) WITH CHECK (((bucket_id = 'emojis'::text) AND ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = auth.uid()) AND (profiles.is_admin = true)))) OR (EXISTS ( SELECT 1
   FROM (public.servers s
     JOIN public.profiles p ON ((s.owner = p.id)))
  WHERE ((p.auth_user_id = auth.uid()) AND ((s.id)::text = (storage.foldername(objects.name))[1])))))));


--
-- Name: objects Admins and server owners can update server icons; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Admins and server owners can update server icons" ON storage.objects FOR UPDATE TO authenticated USING (((bucket_id = 'server_icons'::text) AND ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = auth.uid()) AND (profiles.is_admin = true)))) OR (EXISTS ( SELECT 1
   FROM (public.servers s
     JOIN public.profiles p ON ((s.owner = p.id)))
  WHERE ((p.auth_user_id = auth.uid()) AND ((s.id)::text = (storage.foldername(objects.name))[1]))))))) WITH CHECK (((bucket_id = 'server_icons'::text) AND ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = auth.uid()) AND (profiles.is_admin = true)))) OR (EXISTS ( SELECT 1
   FROM (public.servers s
     JOIN public.profiles p ON ((s.owner = p.id)))
  WHERE ((p.auth_user_id = auth.uid()) AND ((s.id)::text = (storage.foldername(objects.name))[1])))))));


--
-- Name: objects Admins and server owners can upload emojis; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Admins and server owners can upload emojis" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'emojis'::text) AND ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = auth.uid()) AND (profiles.is_admin = true)))) OR (EXISTS ( SELECT 1
   FROM (public.servers s
     JOIN public.profiles p ON ((s.owner = p.id)))
  WHERE ((p.auth_user_id = auth.uid()) AND ((s.id)::text = (storage.foldername(objects.name))[1])))))));


--
-- Name: objects Admins and server owners can upload server icons; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Admins and server owners can upload server icons" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'server_icons'::text) AND ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = auth.uid()) AND (profiles.is_admin = true)))) OR (EXISTS ( SELECT 1
   FROM (public.servers s
     JOIN public.profiles p ON ((s.owner = p.id)))
  WHERE ((p.auth_user_id = auth.uid()) AND ((s.id)::text = (storage.foldername(objects.name))[1])))))));


--
-- Name: objects Anyone can view avatars; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Anyone can view avatars" ON storage.objects FOR SELECT TO authenticated, anon USING ((bucket_id = 'avatars'::text));


--
-- Name: objects Anyone can view banners; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Anyone can view banners" ON storage.objects FOR SELECT TO authenticated, anon USING ((bucket_id = 'banners'::text));


--
-- Name: objects Anyone can view emojis; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Anyone can view emojis" ON storage.objects FOR SELECT TO authenticated, anon USING ((bucket_id = 'emojis'::text));


--
-- Name: objects Anyone can view server icons; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Anyone can view server icons" ON storage.objects FOR SELECT TO authenticated, anon USING ((bucket_id = 'server_icons'::text));


--
-- Name: objects Anyone can view user media; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Anyone can view user media" ON storage.objects FOR SELECT TO authenticated, anon USING ((bucket_id = 'user_media'::text));


--
-- Name: objects Application controlled group icon deletes; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Application controlled group icon deletes" ON storage.objects FOR DELETE USING ((bucket_id = 'group-icons'::text));


--
-- Name: objects Application controlled group icon updates; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Application controlled group icon updates" ON storage.objects FOR UPDATE USING ((bucket_id = 'group-icons'::text));


--
-- Name: objects Application controlled group icon uploads; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Application controlled group icon uploads" ON storage.objects FOR INSERT WITH CHECK ((bucket_id = 'group-icons'::text));


--
-- Name: objects Public read access for group icons; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Public read access for group icons" ON storage.objects FOR SELECT USING ((bucket_id = 'group-icons'::text));


--
-- Name: objects Users can delete their own avatars; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Users can delete their own avatars" ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'avatars'::text) AND ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = auth.uid()) AND (profiles.is_admin = true)))) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.auth_user_id = auth.uid()) AND ((p.id)::text = (storage.foldername(objects.name))[1])))))));


--
-- Name: objects Users can delete their own banners; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Users can delete their own banners" ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'banners'::text) AND ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = auth.uid()) AND (profiles.is_admin = true)))) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.auth_user_id = auth.uid()) AND ((p.id)::text = (storage.foldername(objects.name))[1])))))));


--
-- Name: objects Users can delete their own media; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Users can delete their own media" ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'user_media'::text) AND ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = auth.uid()) AND (profiles.is_admin = true)))) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.auth_user_id = auth.uid()) AND ((p.id)::text = (storage.foldername(objects.name))[1])))))));


--
-- Name: objects Users can update their own avatars; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Users can update their own avatars" ON storage.objects FOR UPDATE TO authenticated USING (((bucket_id = 'avatars'::text) AND ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = auth.uid()) AND (profiles.is_admin = true)))) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.auth_user_id = auth.uid()) AND ((p.id)::text = (storage.foldername(objects.name))[1]))))))) WITH CHECK (((bucket_id = 'avatars'::text) AND ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = auth.uid()) AND (profiles.is_admin = true)))) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.auth_user_id = auth.uid()) AND ((p.id)::text = (storage.foldername(objects.name))[1])))))));


--
-- Name: objects Users can update their own banners; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Users can update their own banners" ON storage.objects FOR UPDATE TO authenticated USING (((bucket_id = 'banners'::text) AND ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = auth.uid()) AND (profiles.is_admin = true)))) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.auth_user_id = auth.uid()) AND ((p.id)::text = (storage.foldername(objects.name))[1]))))))) WITH CHECK (((bucket_id = 'banners'::text) AND ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = auth.uid()) AND (profiles.is_admin = true)))) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.auth_user_id = auth.uid()) AND ((p.id)::text = (storage.foldername(objects.name))[1])))))));


--
-- Name: objects Users can update their own media; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Users can update their own media" ON storage.objects FOR UPDATE TO authenticated USING (((bucket_id = 'user_media'::text) AND ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = auth.uid()) AND (profiles.is_admin = true)))) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.auth_user_id = auth.uid()) AND ((p.id)::text = (storage.foldername(objects.name))[1]))))))) WITH CHECK (((bucket_id = 'user_media'::text) AND ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = auth.uid()) AND (profiles.is_admin = true)))) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.auth_user_id = auth.uid()) AND ((p.id)::text = (storage.foldername(objects.name))[1])))))));


--
-- Name: objects Users can upload their own avatars; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Users can upload their own avatars" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'avatars'::text) AND ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = auth.uid()) AND (profiles.is_admin = true)))) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.auth_user_id = auth.uid()) AND ((p.id)::text = (storage.foldername(objects.name))[1])))))));


--
-- Name: objects Users can upload their own banners; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Users can upload their own banners" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'banners'::text) AND ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = auth.uid()) AND (profiles.is_admin = true)))) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.auth_user_id = auth.uid()) AND ((p.id)::text = (storage.foldername(objects.name))[1])))))));


--
-- Name: objects Users can upload their own media; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Users can upload their own media" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'user_media'::text) AND ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = auth.uid()) AND (profiles.is_admin = true)))) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.auth_user_id = auth.uid()) AND ((p.id)::text = (storage.foldername(objects.name))[1])))))));


--
-- Name: buckets; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;

--
-- Name: migrations; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.migrations ENABLE ROW LEVEL SECURITY;

--
-- Name: objects; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

--
-- Name: prefixes; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.prefixes ENABLE ROW LEVEL SECURITY;

--
-- Name: s3_multipart_uploads; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.s3_multipart_uploads ENABLE ROW LEVEL SECURITY;

--
-- Name: s3_multipart_uploads_parts; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.s3_multipart_uploads_parts ENABLE ROW LEVEL SECURITY;

--
-- Name: supabase_realtime; Type: PUBLICATION; Schema: -; Owner: -
--

CREATE PUBLICATION supabase_realtime WITH (publish = 'insert, update, delete, truncate');


--
-- Name: supabase_realtime_messages_publication; Type: PUBLICATION; Schema: -; Owner: -
--

CREATE PUBLICATION supabase_realtime_messages_publication WITH (publish = 'insert, update, delete, truncate');


--
-- Name: supabase_realtime ap_activities; Type: PUBLICATION TABLE; Schema: public; Owner: -
--

ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.ap_activities;


--
-- Name: supabase_realtime conversations; Type: PUBLICATION TABLE; Schema: public; Owner: -
--

ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.conversations;


--
-- Name: supabase_realtime federated_instances; Type: PUBLICATION TABLE; Schema: public; Owner: -
--

ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.federated_instances;


--
-- Name: supabase_realtime follows; Type: PUBLICATION TABLE; Schema: public; Owner: -
--

ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.follows;


--
-- Name: supabase_realtime messages; Type: PUBLICATION TABLE; Schema: public; Owner: -
--

ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.messages;


--
-- Name: supabase_realtime notification_channels; Type: PUBLICATION TABLE; Schema: public; Owner: -
--

ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.notification_channels;


--
-- Name: supabase_realtime notification_preferences; Type: PUBLICATION TABLE; Schema: public; Owner: -
--

ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.notification_preferences;


--
-- Name: supabase_realtime notifications; Type: PUBLICATION TABLE; Schema: public; Owner: -
--

ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.notifications;


--
-- Name: supabase_realtime post_interactions; Type: PUBLICATION TABLE; Schema: public; Owner: -
--

ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.post_interactions;


--
-- Name: supabase_realtime posts; Type: PUBLICATION TABLE; Schema: public; Owner: -
--

ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.posts;


--
-- Name: supabase_realtime profiles; Type: PUBLICATION TABLE; Schema: public; Owner: -
--

ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.profiles;


--
-- Name: supabase_realtime reactions; Type: PUBLICATION TABLE; Schema: public; Owner: -
--

ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.reactions;


--
-- Name: supabase_realtime server_federation_events; Type: PUBLICATION TABLE; Schema: public; Owner: -
--

ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.server_federation_events;


--
-- Name: supabase_realtime server_membership_events; Type: PUBLICATION TABLE; Schema: public; Owner: -
--

ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.server_membership_events;


--
-- Name: supabase_realtime timeline_entries; Type: PUBLICATION TABLE; Schema: public; Owner: -
--

ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.timeline_entries;


--
-- Name: supabase_realtime unread_counts; Type: PUBLICATION TABLE; Schema: public; Owner: -
--

ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.unread_counts;


--
-- Name: supabase_realtime voice_federation_events; Type: PUBLICATION TABLE; Schema: public; Owner: -
--

ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.voice_federation_events;


--
-- Name: supabase_realtime_messages_publication messages; Type: PUBLICATION TABLE; Schema: realtime; Owner: -
--

ALTER PUBLICATION supabase_realtime_messages_publication ADD TABLE ONLY realtime.messages;


--
-- Name: issue_graphql_placeholder; Type: EVENT TRIGGER; Schema: -; Owner: -
--

CREATE EVENT TRIGGER issue_graphql_placeholder ON sql_drop
         WHEN TAG IN ('DROP EXTENSION')
   EXECUTE FUNCTION extensions.set_graphql_placeholder();


--
-- Name: issue_pg_cron_access; Type: EVENT TRIGGER; Schema: -; Owner: -
--

CREATE EVENT TRIGGER issue_pg_cron_access ON ddl_command_end
         WHEN TAG IN ('CREATE EXTENSION')
   EXECUTE FUNCTION extensions.grant_pg_cron_access();


--
-- Name: issue_pg_graphql_access; Type: EVENT TRIGGER; Schema: -; Owner: -
--

CREATE EVENT TRIGGER issue_pg_graphql_access ON ddl_command_end
         WHEN TAG IN ('CREATE FUNCTION')
   EXECUTE FUNCTION extensions.grant_pg_graphql_access();


--
-- Name: issue_pg_net_access; Type: EVENT TRIGGER; Schema: -; Owner: -
--

CREATE EVENT TRIGGER issue_pg_net_access ON ddl_command_end
         WHEN TAG IN ('CREATE EXTENSION')
   EXECUTE FUNCTION extensions.grant_pg_net_access();


--
-- Name: pgrst_ddl_watch; Type: EVENT TRIGGER; Schema: -; Owner: -
--

CREATE EVENT TRIGGER pgrst_ddl_watch ON ddl_command_end
   EXECUTE FUNCTION extensions.pgrst_ddl_watch();


--
-- Name: pgrst_drop_watch; Type: EVENT TRIGGER; Schema: -; Owner: -
--

CREATE EVENT TRIGGER pgrst_drop_watch ON sql_drop
   EXECUTE FUNCTION extensions.pgrst_drop_watch();


--
-- PostgreSQL database dump complete
--

