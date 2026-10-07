import { supabase } from '@/supabase';
import { canUserCreateInvites, getInviteConstraints } from './permissionsService';
import { debug } from '@/utils/debug'
import { i18n } from '@/i18n';
import { runtimeConfig } from '@/services/runtimeConfig';

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
    const baseUrl = runtimeConfig.appUrl || window.location.origin;
    const url = `${baseUrl}/invite/${code}`;
    
    return { success: true, url };
  } catch (error) {
    debug.error('Error generating invite URL:', error);
    return { success: false, error: 'Failed to generate invite link' };
  }
}
const INVITE_ERRORS: Array<[string, () => string]> = [
  ['INVITE_EXHAUSTED', () => 'This invite has reached its usage limit'],
  ['INVITE_REVOKED', () => 'This invite has been revoked'],
  ['INVITE_EXPIRED', () => 'This invite has expired'],
  ['INVITE_NOT_FOUND', () => 'Invalid invite code'],
  ['BANNED_FROM_SERVER', () => i18n.global.t('invite.bannedFromServer')],
];

/**
 * Joins the server through redeem_invite, which checks the invite, counts the use and
 * adds the membership in one transaction. Already being a member is a success.
 */
async function acceptInvite(code: string): Promise<{ success: boolean; serverId?: string; error?: string }> {
  try {
    const { data, error } = await supabase.rpc('redeem_invite', { p_code: code });

    if (error) {
      const known = INVITE_ERRORS.find(([marker]) => (error.message || '').includes(marker));
      if (!known) debug.error('Error redeeming invite:', error);
      return { success: false, error: known ? known[1]() : 'Failed to join server' };
    }

    const serverId = (data as { server_id?: string } | null)?.server_id;
    if (!serverId) return { success: false, error: 'Failed to join server' };
    return { success: true, serverId };
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

const PREVIEW_ERRORS: Record<string, string> = {
  not_found: 'Invite not found or has expired',
  revoked: 'This invite has been revoked',
  expired: 'This invite has expired',
  exhausted: 'This invite has reached its maximum uses',
};

// Server card, rules and membership for a valid invite, without accepting it. A non-member
// cannot read a private server's row, so the card comes from get_invite_preview.
async function getInviteInfo(code: string): Promise<{ info?: InviteInfo; error?: string }> {
  try {
    const { data, error } = await supabase.rpc('get_invite_preview', { p_code: code });
    if (error || !data) return { error: 'Failed to load invite details' };

    const preview = data as Record<string, any>;
    if (preview.status !== 'valid') {
      return { error: PREVIEW_ERRORS[preview.status] ?? PREVIEW_ERRORS.not_found };
    }

    const rules = Array.isArray(preview.rules)
      ? preview.rules.filter((r: unknown): r is string => typeof r === 'string' && r.trim().length > 0)
      : [];

    return {
      info: {
        code,
        serverId: preview.server_id,
        serverName: preview.name ?? '',
        description: preview.description ?? null,
        icon: preview.icon ?? null,
        banner: preview.banner ?? null,
        rules,
        memberCount: Number(preview.member_count) || 0,
        expiresAt: preview.expires_at ?? null,
        isMember: preview.is_member === true,
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
  getInviteInfo
}
