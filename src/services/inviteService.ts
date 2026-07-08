import { supabase } from '@/supabase';
import { useToast } from 'vue-toastification';
import { canUserCreateInvites, getInviteConstraints } from './permissionsService';
import { debug } from '@/utils/debug'

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
    const canCreate = await canUserCreateInvites(userId, serverId);
    if (!canCreate) {
      return { success: false, error: 'You do not have permission to create invites for this server' };
    }

    const constraints = await getInviteConstraints(userId, serverId);
    
    const {
      expiresIn = constraints.defaultExpiration,
      maxUses = 0,
      temporary = false
    } = options;

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

    const code = generateSecureCode();

    const expiresAt = expiresIn > 0 
      ? new Date(Date.now() + expiresIn * 60 * 1000)
      : null;

    // Insert the invite code into the database.
    // max_uses: 0 (unlimited) maps to NULL so the DB column is nullable
    // semantics-aligned with "no cap"; positive values are persisted as-is
    // and enforced at accept time.
    const { error } = await supabase
      .from('invites')
      .insert([{
        code,
        server_id: serverId,
        created_by: userId,
        expires_at: expiresAt,
        max_uses: maxUses && maxUses > 0 ? maxUses : null,
        uses: 0,
        temporary,
        used: false,
      }])
      .select()
      .single();

    if (error) throw error;

    // Construct the invite URL
    const baseUrl = import.meta.env.VITE_APP_URL || window.location.origin;
    const url = `${baseUrl}/invite/${code}`;
    
    return { success: true, url };
  } catch (error) {
    debug.error('Error generating invite URL:', error);
    return { success: false, error: 'Failed to generate invite link' };
  }
}
async function acceptInvite(code: string, userId: string): Promise<{ success: boolean; serverId?: string; error?: string }> {
  const toast = useToast();
  
  try {
    // Look up invite via SECURITY DEFINER RPC. Direct `from('invites').select(...)`
    // would be blocked by the post-20260520 RLS policies (which restrict reads to
    // the invite creator / instance admins); the RPC returns exactly one row by
    // code so it does not enable enumeration.
    const { data: inviteRows, error: inviteError } = await supabase
      .rpc('lookup_invite_by_code', { p_code: code });

    const invite = Array.isArray(inviteRows) ? inviteRows[0] : null;

    if (inviteError || !invite) {
      return { success: false, error: 'Invalid invite code' };
    }

    if (invite.used) {
      return { success: false, error: 'This invite has already been used' };
    }

    if (invite.expires_at && new Date() > new Date(invite.expires_at)) {
      return { success: false, error: 'This invite has expired' };
    }

    if (invite.max_uses && invite.uses >= invite.max_uses) {
      return { success: false, error: 'This invite has reached its usage limit' };
    }

    const { data: existingMember } = await supabase
      .from('user_servers')
      .select('id')
      .eq('user_id', userId)
      .eq('server_id', invite.server_id)
      .single();

    if (existingMember) {
      return { success: false, error: 'You are already a member of this server' };
    }

    const { error: userServerError } = await supabase
      .from('user_servers')
      .insert([{ 
        user_id: userId, 
        server_id: invite.server_id,
        temporary: invite.temporary 
      }]);

    if (userServerError) {
      // Handle duplicate membership gracefully
      if (userServerError.code === '23505') { // Unique constraint violation
        debug.log('User is already a member of this server');
        toast.info("You're already a member of this server!");
        // Still update invite usage since the invite was "used" even if they were already a member
      } else {
        debug.error('Error adding user to server:', userServerError);
        toast.error("Failed to join server. Please try again.");
        return { success: false, error: 'Failed to join server' };
      }
    }

    // Update invite usage. Treat NULL `uses` as 0 to defend against legacy
    // rows where the default never fired. Single-use invites become "used"
    // immediately; otherwise we mark used when the new count crosses
    // `max_uses`, which means a parallel race that pushes us over the limit
    // still flips the flag.
    const currentUses = typeof invite.uses === 'number' ? invite.uses : 0;
    const newUses = currentUses + 1;
    const maxUses = typeof invite.max_uses === 'number' && invite.max_uses > 0
      ? invite.max_uses
      : null;
    const shouldMarkUsed = maxUses !== null && newUses >= maxUses;

    const { error: usageError } = await supabase
      .from('invites')
      .update({
        uses: newUses,
        used: shouldMarkUsed,
      })
      .eq('id', invite.id);

    if (usageError) {
      debug.error('Failed to update invite usage:', usageError);
      // Don't fail the join - the user is already in the server - but log
      // loudly so the limit-enforcement bug doesn't go unnoticed.
    }

    return { success: true, serverId: invite.server_id };
  } catch (error) {
    debug.error('Error accepting invite:', error);
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
    debug.error('Error fetching invite history:', error);
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
    debug.error('Error revoking invite:', error);
    return false;
  }
}

async function getInviteDetails(code: string): Promise<{ invite: Invite; serverName: string } | null> {
  try {
    // Uses SECURITY DEFINER RPC so anonymous / non-owner viewers can preview
    // a single invite by code (e.g. shared link cards) without granting broad
    // SELECT on `public.invites`.
    const { data, error } = await supabase
      .rpc('lookup_invite_by_code', { p_code: code });

    const row = Array.isArray(data) ? data[0] : null;
    if (error || !row) return null;

    return {
      invite: row as unknown as Invite,
      serverName: row.server_name ?? ''
    };
  } catch (error) {
    debug.error('Error fetching invite details:', error);
    return null;
  }
}

export interface InviteInfo {
  code: string;
  serverId: string;
  serverName: string;
  description: string | null;
  icon: string | null;
  banner: string | null;
  rules: string[];
  memberCount: number;
  expiresAt: string | null;
  isMember: boolean;
}

// Resolve invite → server card + rules + membership, without accepting it
async function getInviteInfo(code: string): Promise<{ info?: InviteInfo; error?: string }> {
  try {
    const { data: inviteRows, error: inviteError } = await supabase
      .rpc('lookup_invite_by_code', { p_code: code });

    const invite = Array.isArray(inviteRows) ? inviteRows[0] : null;
    if (inviteError || !invite) return { error: 'Invite not found or has expired' };
    if (invite.used) return { error: 'This invite has been revoked' };
    if (invite.expires_at && new Date() > new Date(invite.expires_at)) {
      return { error: 'This invite has expired' };
    }
    if (invite.max_uses && (invite.uses || 0) >= invite.max_uses) {
      return { error: 'This invite has reached its maximum uses' };
    }

    const { data: server, error: serverError } = await supabase
      .from('servers')
      .select('id, name, icon, banner, description, rules')
      .eq('id', invite.server_id)
      .single();

    if (serverError || !server) return { error: 'Server not found' };

    const { getServerMemberCount, isUserMemberOfServer } = await import('@/services/serverMembershipService');
    const memberCount = await getServerMemberCount(server.id);

    // Pattern A: membership is keyed by profiles(id), not the auth UUID
    let isMember = false;
    try {
      const { authContextService } = await import('@/services/AuthContextService');
      const profileId = await authContextService.getCurrentProfileId();
      isMember = await isUserMemberOfServer(profileId, server.id);
    } catch {
      // not logged in / profile unresolved - treat as non-member
    }

    const rules = Array.isArray(server.rules)
      ? server.rules.filter((r: unknown): r is string => typeof r === 'string' && r.trim().length > 0)
      : [];

    return {
      info: {
        code,
        serverId: server.id,
        serverName: server.name,
        description: server.description ?? null,
        icon: server.icon ?? null,
        banner: server.banner ?? null,
        rules,
        memberCount: memberCount || 0,
        expiresAt: invite.expires_at ?? null,
        isMember,
      },
    };
  } catch (error) {
    debug.error('Error resolving invite info:', error);
    return { error: 'Failed to load invite details' };
  }
}

export {
  generateInviteUrl,
  acceptInvite,
  getInviteHistory,
  revokeInvite,
  getInviteDetails,
  getInviteInfo
}
