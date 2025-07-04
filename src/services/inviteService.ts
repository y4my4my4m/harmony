import { supabase } from '@/supabase';
import { canUserCreateInvites, getInviteConstraints } from './permissionsService';

export interface InviteOptions {
  expiresIn?: number; // minutes, 0 = never expires
  maxUses?: number; // 0 = unlimited
  temporary?: boolean;
}

export interface Invite {
  id: string;
  code: string;
  server_id: string;
  created_by: string;
  expires_at: string | null;
  max_uses: number | null;
  uses: number;
  temporary: boolean;
  created_at: string;
  used: boolean;
}

function generateSecureCode(): string {
  // Generate a more secure, readable invite code
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function generateInviteUrl(
  serverId: string, 
  userId: string, 
  options: InviteOptions = {}
): Promise<{ success: boolean; url?: string; error?: string }> {
  try {
    // Check if user has permission to create invites
    const canCreate = await canUserCreateInvites(userId, serverId);
    if (!canCreate) {
      return { success: false, error: 'You do not have permission to create invites for this server' };
    }

    // Get invite constraints for this user
    const constraints = await getInviteConstraints(userId, serverId);
    
    const {
      expiresIn = constraints.defaultExpiration,
      maxUses = 0,
      temporary = false
    } = options;

    // Validate against constraints
    if (constraints.maxExpiration > 0 && expiresIn > constraints.maxExpiration) {
      return { 
        success: false, 
        error: `Expiration time cannot exceed ${Math.floor(constraints.maxExpiration / (24 * 60))} days` 
      };
    }

    if (!constraints.allowTemporary && temporary) {
      return { success: false, error: 'Temporary invites are not allowed in this server' };
    }

    if (constraints.maxUses > 0 && (maxUses === 0 || maxUses > constraints.maxUses)) {
      return { 
        success: false, 
        error: `Maximum uses cannot exceed ${constraints.maxUses}` 
      };
    }

    // Generate a secure invite code
    const code = generateSecureCode();

    // Calculate expiration time
    const expiresAt = expiresIn > 0 
      ? new Date(Date.now() + expiresIn * 60 * 1000)
      : null;

    // Insert the invite code into the database
    const { data, error } = await supabase
      .from('invites')
      .insert([{ 
        code, 
        server_id: serverId, 
        created_by: userId, 
        expires_at: expiresAt,
        // TODO: Uncomment when max_uses is implemented
        // max_uses: maxUses || null,
        // uses: 0,
        // temporary,
        used: false
      }])
      .select()
      .single();

    if (error) throw error;

    // Construct the invite URL
    const baseUrl = import.meta.env.VITE_APP_URL || window.location.origin;
    const url = `${baseUrl}/invite/${code}`;
    
    return { success: true, url };
  } catch (error) {
    console.error('Error generating invite URL:', error);
    return { success: false, error: 'Failed to generate invite link' };
  }
}
async function acceptInvite(code: string, userId: string): Promise<{ success: boolean; serverId?: string; error?: string }> {
  try {
    // Get invite details
    const { data: invite, error: inviteError } = await supabase
      .from('invites')
      .select('*')
      .eq('code', code)
      .single();

    if (inviteError || !invite) {
      return { success: false, error: 'Invalid invite code' };
    }

    // Check if invite is already used (for single-use invites)
    if (invite.used) {
      return { success: false, error: 'This invite has already been used' };
    }

    // Check if invite has expired
    if (invite.expires_at && new Date() > new Date(invite.expires_at)) {
      return { success: false, error: 'This invite has expired' };
    }

    // Check if invite has reached max uses
    if (invite.max_uses && invite.uses >= invite.max_uses) {
      return { success: false, error: 'This invite has reached its usage limit' };
    }

    // Check if user is already in the server
    const { data: existingMember } = await supabase
      .from('user_servers')
      .select('id')
      .eq('user_id', userId)
      .eq('server_id', invite.server_id)
      .single();

    if (existingMember) {
      return { success: false, error: 'You are already a member of this server' };
    }

    // Add user to the server
    const { error: userServerError } = await supabase
      .from('user_servers')
      .insert([{ 
        user_id: userId, 
        server_id: invite.server_id,
        temporary: invite.temporary 
      }]);

    if (userServerError) {
      console.error('Error adding user to server:', userServerError);
      return { success: false, error: 'Failed to join server' };
    }

    // Update invite usage
    const newUses = invite.uses + 1;
    const shouldMarkUsed = invite.max_uses === 1; // Single-use invites
    
    await supabase
      .from('invites')
      .update({ 
        uses: newUses,
        used: shouldMarkUsed
      })
      .eq('id', invite.id);

    return { success: true, serverId: invite.server_id };
  } catch (error) {
    console.error('Error accepting invite:', error);
    return { success: false, error: 'An unexpected error occurred' };
  }
}

async function getInviteHistory(userId: string, serverId?: string): Promise<Invite[]> {
  try {
    let query = supabase
      .from('invites')
      .select('*')
      .eq('created_by', userId)
      .order('created_at', { ascending: false });

    if (serverId) {
      query = query.eq('server_id', serverId);
    }

    const { data, error } = await query;

    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Error fetching invite history:', error);
    return [];
  }
}

async function revokeInvite(inviteId: string, userId: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('invites')
      .update({ used: true })
      .eq('id', inviteId)
      .eq('created_by', userId); // Ensure user can only revoke their own invites

    if (error) throw error;
    return true;
  } catch (error) {
    console.error('Error revoking invite:', error);
    return false;
  }
}

async function getInviteDetails(code: string): Promise<{ invite: Invite; serverName: string } | null> {
  try {
    const { data, error } = await supabase
      .from('invites')
      .select(`
        *,
        servers!inner (
          name,
          icon_url
        )
      `)
      .eq('code', code)
      .single();

    if (error || !data) return null;

    return {
      invite: data,
      serverName: data.servers.name
    };
  } catch (error) {
    console.error('Error fetching invite details:', error);
    return null;
  }
}

export { 
  generateInviteUrl, 
  acceptInvite, 
  getInviteHistory, 
  revokeInvite, 
  getInviteDetails,
  type Invite,
  type InviteOptions
}
