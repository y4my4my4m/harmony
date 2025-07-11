-- Add admin panel support
-- This migration adds fields and functions needed for the instance admin panel

-- Add admin flag to profiles table
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN DEFAULT FALSE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS suspension_reason TEXT;

-- Add admin audit log table
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    admin_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    action_type TEXT NOT NULL, -- 'user_suspend', 'user_unsuspend', 'instance_block', 'config_change', etc.
    target_type TEXT, -- 'user', 'instance', 'server', 'config'
    target_id TEXT, -- ID of the target (user_id, domain, server_id, etc.)
    action_details JSONB, -- Detailed information about the action
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for admin audit log
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin_id ON admin_audit_log(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action_type ON admin_audit_log(action_type);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at ON admin_audit_log(created_at DESC);

-- Add instance configuration table
CREATE TABLE IF NOT EXISTS instance_config (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    config_key TEXT UNIQUE NOT NULL,
    config_value JSONB NOT NULL,
    description TEXT,
    updated_by UUID REFERENCES profiles(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insert default instance configuration
INSERT INTO instance_config (config_key, config_value, description) VALUES
    ('instance_name', '"Harmony Instance"', 'The name of this Harmony instance'),
    ('instance_description', '"A federated social platform"', 'Description of this instance'),
    ('domain', '"har.mony.lol"', 'The domain name of this instance'),
    ('open_registration', 'true', 'Whether new user registration is open'),
    ('approval_required', 'false', 'Whether new registrations require admin approval'),
    ('max_server_size', '1000', 'Maximum number of members per chat server'),
    ('max_message_length', '2000', 'Maximum length of chat messages'),
    ('allow_file_uploads', 'true', 'Whether file uploads are allowed'),
    ('enable_voice_channels', 'true', 'Whether voice channels are enabled'),
    ('max_post_length', '500', 'Maximum length of ActivityPub posts'),
    ('federation_retry_attempts', '3', 'Number of retry attempts for failed federation deliveries'),
    ('enable_outbound_federation', 'true', 'Whether outbound federation is enabled'),
    ('enable_inbound_federation', 'true', 'Whether inbound federation is enabled')
ON CONFLICT (config_key) DO NOTHING;

-- Add blocked instances table (if not exists from federation schema)
CREATE TABLE IF NOT EXISTS blocked_instances (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    domain TEXT UNIQUE NOT NULL,
    reason TEXT NOT NULL,
    blocked_by UUID NOT NULL REFERENCES profiles(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Function to get system statistics
CREATE OR REPLACE FUNCTION get_system_stats()
RETURNS JSON AS $$
DECLARE
    result JSON;
    total_users INTEGER;
    new_users_today INTEGER;
    total_servers INTEGER;
    active_servers INTEGER;
    federated_instances INTEGER;
    total_posts INTEGER;
    posts_today INTEGER;
BEGIN
    -- Get total users
    SELECT COUNT(*) INTO total_users FROM profiles WHERE created_at IS NOT NULL;
    
    -- Get new users today
    SELECT COUNT(*) INTO new_users_today 
    FROM profiles 
    WHERE created_at >= CURRENT_DATE;
    
    -- Get total servers
    SELECT COUNT(*) INTO total_servers FROM servers;
    
    -- Get active servers (servers with recent activity)
    SELECT COUNT(*) INTO active_servers 
    FROM servers s 
    WHERE EXISTS (
        SELECT 1 FROM messages m 
        JOIN channels c ON m.channel_id = c.id 
        WHERE c.server_id = s.id 
        AND m.created_at >= NOW() - INTERVAL '7 days'
    );
    
    -- Get federated instances count
    SELECT COUNT(DISTINCT domain) INTO federated_instances 
    FROM profiles 
    WHERE domain IS NOT NULL;
    
    -- Get total posts
    SELECT COUNT(*) INTO total_posts FROM posts;
    
    -- Get posts today
    SELECT COUNT(*) INTO posts_today 
    FROM posts 
    WHERE created_at >= CURRENT_DATE;
    
    result := json_build_object(
        'totalUsers', total_users,
        'newUsersToday', new_users_today,
        'totalServers', total_servers,
        'activeServers', active_servers,
        'federatedInstances', federated_instances,
        'totalPosts', total_posts,
        'postsToday', posts_today
    );
    
    RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get federation queue stats
CREATE OR REPLACE FUNCTION get_federation_stats()
RETURNS JSON AS $$
DECLARE
    result JSON;
    pending_deliveries INTEGER;
    failed_deliveries INTEGER;
    successful_deliveries_today INTEGER;
BEGIN
    -- Get pending deliveries (if federation_delivery_queue exists)
    SELECT COUNT(*) INTO pending_deliveries 
    FROM federation_delivery_queue 
    WHERE status = 'pending' OR status = 'retrying';
    
    -- Get failed deliveries
    SELECT COUNT(*) INTO failed_deliveries 
    FROM federation_delivery_queue 
    WHERE status = 'failed';
    
    -- Get successful deliveries today
    SELECT COUNT(*) INTO successful_deliveries_today 
    FROM federation_delivery_queue 
    WHERE status = 'delivered' 
    AND delivered_at >= CURRENT_DATE;
    
    result := json_build_object(
        'pending', COALESCE(pending_deliveries, 0),
        'failed', COALESCE(failed_deliveries, 0),
        'successfulToday', COALESCE(successful_deliveries_today, 0)
    );
    
    RETURN result;
EXCEPTION WHEN undefined_table THEN
    -- If federation_delivery_queue doesn't exist, return default values
    result := json_build_object(
        'pending', 0,
        'failed', 0,
        'successfulToday', 0
    );
    RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get recent admin activity
CREATE OR REPLACE FUNCTION get_recent_admin_activity(p_limit INTEGER DEFAULT 20)
RETURNS TABLE (
    id UUID,
    admin_username TEXT,
    action_type TEXT,
    target_type TEXT,
    target_id TEXT,
    action_details JSONB,
    created_at TIMESTAMP WITH TIME ZONE
) AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to log admin actions
CREATE OR REPLACE FUNCTION log_admin_action(
    p_admin_id UUID,
    p_action_type TEXT,
    p_target_type TEXT DEFAULT NULL,
    p_target_id TEXT DEFAULT NULL,
    p_action_details JSONB DEFAULT NULL,
    p_ip_address INET DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL
) RETURNS UUID AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to suspend/unsuspend users
CREATE OR REPLACE FUNCTION moderate_user(
    p_admin_id UUID,
    p_target_user_id UUID,
    p_action TEXT, -- 'suspend' or 'unsuspend'
    p_reason TEXT DEFAULT NULL
) RETURNS BOOLEAN AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to block/unblock instances
CREATE OR REPLACE FUNCTION moderate_instance(
    p_admin_id UUID,
    p_domain TEXT,
    p_action TEXT, -- 'block' or 'unblock'
    p_reason TEXT DEFAULT NULL
) RETURNS BOOLEAN AS $$
BEGIN
    -- Check if admin has permission
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_admin_id AND is_admin = TRUE) THEN
        RAISE EXCEPTION 'Insufficient permissions';
    END IF;
    
    IF p_action = 'block' THEN
        INSERT INTO blocked_instances (domain, reason, blocked_by)
        VALUES (p_domain, p_reason, p_admin_id)
        ON CONFLICT (domain) DO UPDATE SET
            reason = p_reason,
            blocked_by = p_admin_id,
            created_at = NOW();
        
        -- Log the action
        PERFORM log_admin_action(
            p_admin_id,
            'instance_block',
            'instance',
            p_domain,
            json_build_object('reason', p_reason)
        );
        
    ELSIF p_action = 'unblock' THEN
        DELETE FROM blocked_instances WHERE domain = p_domain;
        
        -- Log the action
        PERFORM log_admin_action(
            p_admin_id,
            'instance_unblock',
            'instance',
            p_domain,
            json_build_object()
        );
    ELSE
        RAISE EXCEPTION 'Invalid action: %', p_action;
    END IF;
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get/set instance configuration
CREATE OR REPLACE FUNCTION get_instance_config(p_key TEXT DEFAULT NULL)
RETURNS TABLE (
    config_key TEXT,
    config_value JSONB,
    description TEXT
) AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION set_instance_config(
    p_admin_id UUID,
    p_key TEXT,
    p_value JSONB,
    p_description TEXT DEFAULT NULL
) RETURNS BOOLEAN AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Enable RLS on new tables
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE instance_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocked_instances ENABLE ROW LEVEL SECURITY;

-- RLS policies for admin audit log (admin only)
CREATE POLICY "Admin audit log admin access" ON admin_audit_log
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM profiles 
            WHERE id = auth.uid() 
            AND is_admin = TRUE
        )
    );

-- RLS policies for instance config (admin write, public read for some)
CREATE POLICY "Instance config admin access" ON instance_config
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM profiles 
            WHERE id = auth.uid() 
            AND is_admin = TRUE
        )
    );

-- RLS policies for blocked instances (admin only)
CREATE POLICY "Blocked instances admin access" ON blocked_instances
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM profiles 
            WHERE id = auth.uid() 
            AND is_admin = TRUE
        )
    );

-- Grant necessary permissions
GRANT SELECT, INSERT, UPDATE ON admin_audit_log TO authenticated;
GRANT SELECT, INSERT, UPDATE ON instance_config TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON blocked_instances TO authenticated;

-- Grant execute permissions on functions
GRANT EXECUTE ON FUNCTION get_system_stats() TO authenticated;
GRANT EXECUTE ON FUNCTION get_federation_stats() TO authenticated;
GRANT EXECUTE ON FUNCTION get_recent_admin_activity(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION log_admin_action(UUID, TEXT, TEXT, TEXT, JSONB, INET, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION moderate_user(UUID, UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION moderate_instance(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION get_instance_config(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION set_instance_config(UUID, TEXT, JSONB, TEXT) TO authenticated;

-- Create initial admin user (replace with your actual admin user ID)
-- You'll need to manually update this with the correct user ID
-- UPDATE profiles SET is_admin = TRUE WHERE username = 'your_admin_username'; 