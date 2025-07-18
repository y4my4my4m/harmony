
--
-- Name: process_update_activity(uuid, jsonb, record); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.process_update_activity(activity_id uuid, activity_data jsonb, actor_profile record) RETURNS void
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
-- Name: FUNCTION process_update_activity(uuid, jsonb, record); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.process_update_activity(uuid, jsonb, record) IS 'Processes incoming ActivityPub Update activities. Handles both Note updates (post edits) and Person updates (profile updates). Profile updates include name, bio, avatar, banner, and other public fields. Only allows users to update their own profiles.';
