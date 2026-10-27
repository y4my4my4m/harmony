/**
 * Activities accepted on server inboxes:
 * Join/Leave (membership), Accept/Reject (membership responses),
 * Create/Update/Delete (channel messages and structure),
 * Like/EmojiReaction (reactions), Add/Remove (channels, moderation), Undo,
 * Flag (reports about the server's messages). A Follow of the Group is answered with Reject.
 */

import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { actorHostname } from '../utils/mentionParts.js';
import { inboundRawContent } from '../utils/inboundContent.js';
import { ActivityProcessor } from './ActivityProcessor.js';
import { DeliveryQueue } from './DeliveryQueue.js';
import { SignatureService } from './SignatureService.js';
import { noteToContent, parseAlsoKnownAs, parseMovedTo } from './converters/fromActivityPub.js';
import config from '../config/index.js';
import { harmonyVoiceMessageFromObject } from '../utils/voiceMessageFederation.js';
import { INVITE_REFUSALS } from '../utils/inviteRefusals.js';
import { relayedActivity, relayToChannelReaders, type RelayServer } from './groupRelay.js';
import { isServerBlockedHere } from './instanceServerBlocks.js';
import { isVoiceMemberActivity, processVoiceMemberActivity } from './voiceModerationFederation.js';
import { flagComment, flagObjectUris, parseLocalObjectUri } from './flag.js';
import {
  authorizeChannelWrite,
  federatedUploadUrls,
  hasChannelPermissions,
  storedFileUrls,
  resolveThreadInChannel,
  resolveMessageInChannel,
  notAfterNow,
  logDenied,
  THREAD_STUB_STATUS,
} from './channelWriteAuthz.js';
import { HARMONY_CONTEXT } from './harmonyContext.js';
import { parseChannelPosition } from './copyMirror.js';

// Permission bit positions in server_roles.permissions (mirror src/services/RoleService.ts)
const PERM_ADMINISTRATOR = 0n;
const PERM_MANAGE_CHANNELS = 2n;
const PERM_KICK_MEMBERS = 9n;

// The server inbox authenticates the sender but permits same-domain delegation.
// Each mutating handler gates on the actor's own standing: owner, member, role,
// or object ownership. See BUGS.md server-inbox authz.

export async function resolveActorProfileId(supabase: any, actorUrl: string): Promise<string | null> {
  if (!actorUrl) return null;
  const { data } = await supabase
    .from('profiles')
    .select('id')
    .eq('federated_id', actorUrl)
    .maybeSingle();
  return data?.id ?? null;
}

export async function actorIsAcceptedMember(
  supabase: any,
  serverId: string,
  actorUrl: string,
): Promise<{ ok: boolean; userId: string | null }> {
  const userId = await resolveActorProfileId(supabase, actorUrl);
  if (!userId) return { ok: false, userId: null };

  const { data: membership } = await supabase
    .from('user_servers')
    .select('status')
    .eq('server_id', serverId)
    .eq('user_id', userId)
    .maybeSingle();

  return { ok: membership?.status === 'accepted', userId };
}

// Moderator means: host Group actor (strict match), server owner, or a member
// holding is_admin or the required permission bit.
export async function actorIsServerModerator(
  supabase: any,
  serverId: string,
  server: any,
  actorUrl: string,
  requiredBit: bigint,
): Promise<boolean> {
  if (!actorUrl) return false;

  // Host authority requires a strict match: host CRUD carries actor === ap_id.
  // Same-domain delegation would let any host user impersonate the Group actor.
  if (server.ap_id && SignatureService.verifyActorMatch(actorUrl, server.ap_id)) {
    return true;
  }

  const profileId = await resolveActorProfileId(supabase, actorUrl);
  if (!profileId) return false;

  if (server.owner && profileId === server.owner) return true;

  const { data: roles } = await supabase
    .from('user_roles')
    .select('server_roles!inner(is_admin, permissions)')
    .eq('user_id', profileId)
    .eq('server_id', serverId);

  if (!roles) return false;
  const adminMask = (1n << PERM_ADMINISTRATOR) | (1n << requiredBit);
  return roles.some((r: any) => {
    const role = r.server_roles;
    if (!role) return false;
    if (role.is_admin) return true;
    try {
      return (BigInt(role.permissions ?? 0) & adminMask) !== 0n;
    } catch {
      return false;
    }
  });
}

/**
 * MANAGE_MESSAGES in one channel: the host Group actor (strict match), or an accepted,
 * unbanned member holding it through has_permission with the channel's overrides applied,
 * as can_current_user_manage_messages_in_channel resolves it for local users. The owner and
 * ADMINISTRATOR holders hold it everywhere.
 */
export async function actorManagesMessagesIn(
  supabase: any,
  serverId: string,
  server: any,
  actorUrl: string,
  channelId: string | null,
): Promise<boolean> {
  if (!actorUrl || !channelId) return false;
  if (server.ap_id && SignatureService.verifyActorMatch(actorUrl, server.ap_id)) return true;

  const { ok, userId } = await actorIsAcceptedMember(supabase, serverId, actorUrl);
  if (!ok || !userId) return false;
  const { data: ban, error: banError } = await supabase
    .from('server_bans')
    .select('id')
    .eq('server_id', serverId)
    .eq('user_id', userId)
    .maybeSingle();
  if (banError || ban) return false;

  return hasChannelPermissions(supabase, userId, serverId, channelId, [['MANAGE_MESSAGES']]);
}

/**
 * Highest role position of a member, as get_user_highest_role_position: the
 * maximum server_roles.position over the member's roles, 0 without roles.
 * Null when the lookup fails.
 */
export async function highestRolePosition(
  supabase: any,
  serverId: string,
  profileId: string | null,
): Promise<number | null> {
  if (!profileId) return null;
  const { data, error } = await supabase
    .from('user_roles')
    .select('server_roles!inner(position)')
    .eq('user_id', profileId)
    .eq('server_id', serverId);
  if (error) return null;
  let max = 0;
  for (const row of data ?? []) {
    const position = Number((row as any).server_roles?.position ?? 0);
    if (Number.isFinite(position) && position > max) max = position;
  }
  return max;
}

// Authorship compared by profiles.federated_id.
export async function actorOwnsMessage(
  supabase: any,
  messageId: string,
  actorUrl: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('messages')
    .select('profiles:user_id(federated_id)')
    .eq('id', messageId)
    .maybeSingle();
  const ownerUrl = (data as any)?.profiles?.federated_id as string | null | undefined;
  return !!ownerUrl && SignatureService.verifyActorMatch(actorUrl, ownerUrl);
}

/** Incoming `harmony:rawContent` as stored here (inboundRawContent). */
function normalizeMentionDomains(content: any[], senderUrl: unknown): any[] {
  return inboundRawContent(content, actorHostname(senderUrl));
}

// MAIN HANDLER

export async function processServerInboxActivity(
  serverId: string,
  activity: any,
  opts: { verifiedSigner?: string | null } = {},
): Promise<void> {
  const supabase = getSupabaseClient();

  logger.info(`Server ${serverId} received ${activity.type} activity from ${activity.actor}`);

  const { data: server } = await supabase
    .from('servers')
    .select('*')
    .eq('id', serverId)
    .single();

  if (!server) {
    logger.error(`Server ${serverId} not found`);
    return;
  }

  // A remote server's copy takes only the relays (groupRelay.ts) and voice member activities
  // (voiceModerationFederation.ts) of that server's Group, signed with the Group's key.
  if (!server.is_local_server) {
    const voiceMember = isVoiceMemberActivity(activity);
    if (!relayedActivity(activity) && !voiceMember) {
      logger.warn(`Server ${serverId} is not local, cannot process inbox`);
      return;
    }
    const what = voiceMember ? activity.type : 'Group relay';
    if (!opts.verifiedSigner || !server.ap_id || !SignatureService.verifyActorMatch(opts.verifiedSigner, server.ap_id)) {
      logDenied(what, opts.verifiedSigner ?? 'an unsigned sender', `the signer is not the Group of server ${serverId}`);
      return;
    }
    if (await isServerBlockedHere(supabase, serverId)) {
      logDenied(what, opts.verifiedSigner, `server ${serverId} is blocked on this instance`);
      return;
    }
    if (voiceMember) {
      await processVoiceMemberActivity(server, activity);
      return;
    }
    await ActivityProcessor.processGroupRelay(server as RelayServer, activity);
    return;
  }

  try {
    const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
    if (actorUrl) {
      const actorDomain = new URL(actorUrl).hostname;
      const { BlockedInstancesCache } = await import('../services/BlockedInstancesCache.js');
      if (BlockedInstancesCache.isBlocked(actorDomain)) {
        logger.info(`Rejecting activity from blocked instance: ${actorDomain}`);
        return;
      }
    }
  } catch (error) {
    logger.debug(`Could not check instance block status: ${error}`);
  }

  // A suspended profile only leaves, as on the shared and user inboxes.
  if (activity.type !== 'Leave') {
    const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
    if (typeof actorUrl === 'string' && actorUrl) {
      const { data: actorProfile } = await supabase
        .from('profiles')
        .select('is_suspended')
        .eq('federated_id', actorUrl)
        .maybeSingle();
      if (actorProfile?.is_suspended === true) {
        logger.info(`Ignoring ${activity.type} from suspended user ${actorUrl} on server ${serverId}`);
        return;
      }
    }
  }

  // Leave is always allowed so members can leave gracefully. Every other
  // type requires federation_enabled on the server.
  switch (activity.type) {
    case 'Follow':
      await rejectFollow(serverId, server, activity);
      break;

    case 'Leave':
      await processLeaveServer(serverId, server, activity);
      break;

    // This server is local and answers Joins itself; an Accept or Reject of a
    // Join arriving here comes from a third party. Answers to a local user's
    // Join of a remote server arrive at the user inbox.
    case 'Accept':
    case 'Reject':
      logger.warn(`Ignoring ${activity.type} from ${activity.actor?.id ?? activity.actor} on local server inbox ${serverId}`);
      break;

    case 'Join':
      if (!server.federation_enabled) {
        logger.info(`Federation not enabled for server ${serverId}, rejecting Join`);
        const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
        const derivedInbox = `${actorUrl}/inbox`;
        await sendRejectActivity(serverId, activity, derivedInbox, 'Federation is disabled on this server');
        return;
      }
      await processJoinServer(serverId, server, activity);
      break;

    case 'Create':
      if (!server.federation_enabled) {
        logger.info(`Federation not enabled for server ${serverId}, rejecting Create`);
        return;
      }
      await processCreateActivity(serverId, server, activity);
      break;

    case 'Update':
      if (!server.federation_enabled) {
        logger.info(`Federation not enabled for server ${serverId}, rejecting Update`);
        return;
      }
      await processUpdateActivity(serverId, server, activity);
      break;

    case 'Delete':
      if (!server.federation_enabled) {
        logger.info(`Federation not enabled for server ${serverId}, rejecting Delete`);
        return;
      }
      await processDeleteActivity(serverId, server, activity);
      break;

    case 'Like':
    case 'EmojiReaction':
    case 'EmojiReact':
      if (!server.federation_enabled) {
        logger.info(`Federation not enabled for server ${serverId}, rejecting reaction`);
        return;
      }
      await processReactionActivity(serverId, server, activity);
      break;

    case 'Add':
      if (!server.federation_enabled) {
        logger.info(`Federation not enabled for server ${serverId}, rejecting Add`);
        return;
      }
      await processAddActivity(serverId, server, activity);
      break;

    case 'Remove':
      if (!server.federation_enabled) {
        logger.info(`Federation not enabled for server ${serverId}, rejecting Remove`);
        return;
      }
      await processRemoveActivity(serverId, server, activity);
      break;

    case 'Undo':
      if (!server.federation_enabled) {
        logger.info(`Federation not enabled for server ${serverId}, rejecting Undo`);
        return;
      }
      await processUndoActivity(serverId, server, activity);
      break;

    // A report reaches the server's moderators whether or not it takes members from other
    // instances now: the message was federated while it did.
    case 'Flag':
      await processServerFlag(serverId, activity, opts.verifiedSigner ?? null);
      break;

    default:
      if (activity.type?.startsWith('harmony:Voice')) {
        if (!server.federation_enabled) {
          logger.info(`Federation not enabled for server ${serverId}, rejecting voice activity`);
          return;
        }
        const { VoiceActivityHandler } = await import('./VoiceActivityHandler.js');
        await VoiceActivityHandler.processVoiceActivity(activity);
      } else {
        logger.info(`Unhandled server activity type: ${activity.type}`);
      }
  }
}

/**
 * Flag at a local server's Group inbox: a report from another instance about a message of
 * this server (flag.ts buildServerFlagActivity). The first object that is a message in a
 * channel of the server, by /messages/<uuid> of this instance or by its stored ap_id, files
 * one report scoped to the server (create_federated_server_report). A Flag naming no message
 * of the server is handled as at the shared inbox (ActivityProcessor.processFlag).
 */
export async function processServerFlag(serverId: string, activity: any, verifiedSigner: string | null): Promise<void> {
  const supabase = getSupabaseClient();
  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
  // As at the shared inbox: a Flag files moderation work in its signer's name, so it is
  // refused unsigned whatever REQUIRE_VALID_SIGNATURES says.
  if (typeof actorUrl !== 'string' || !verifiedSigner || !SignatureService.verifyActorMatch(actorUrl, verifiedSigner)) {
    logDenied('Flag', actorUrl ?? 'an unnamed actor', 'it is not signed by its actor');
    return;
  }
  let sourceDomain: string;
  try {
    sourceDomain = new URL(actorUrl).hostname.toLowerCase();
  } catch {
    logger.warn(`Flag on server ${serverId} with an unparseable actor ignored`);
    return;
  }
  if (typeof activity.id !== 'string' || !activity.id) {
    logger.warn(`Flag on server ${serverId} from ${actorUrl} without an id ignored`);
    return;
  }

  const uris = flagObjectUris(activity.object);
  let messageId: string | null = null;
  for (const uri of uris) {
    messageId = await findFlaggedMessage(supabase, serverId, uri);
    if (messageId) break;
  }
  if (!messageId) {
    await ActivityProcessor.processFlag(activity);
    return;
  }

  const { data, error } = await supabase.rpc('create_federated_server_report', {
    p_ap_id: activity.id,
    p_actor: actorUrl,
    p_source_domain: sourceDomain,
    p_server_id: serverId,
    p_message_id: messageId,
    p_comment: flagComment(activity.content),
    p_reason: typeof activity['harmony:reason'] === 'string' ? activity['harmony:reason'] : null,
    p_object_uris: uris,
  });
  if (error) {
    throw new Error(`Flag ${activity.id}: report not stored: ${error.message}`);
  }
  logger.info(`Flag ${activity.id} from ${sourceDomain} on server ${serverId}, message ${messageId}: ${data?.status ?? 'unknown'}`);
}

/** The message of `serverId` a Flag object names, or null. */
async function findFlaggedMessage(
  supabase: ReturnType<typeof getSupabaseClient>,
  serverId: string,
  uri: string,
): Promise<string | null> {
  const ref = parseLocalObjectUri(uri, config.INSTANCE_DOMAIN);
  if (ref?.kind === 'message') {
    const { data } = await supabase
      .from('messages')
      .select('id, channel_id')
      .eq('id', ref.id)
      .maybeSingle();
    const inServer = data ? await inServerChannel(supabase, serverId, data) : null;
    if (inServer) return inServer.id;
  }
  const byApId = await findServerMessageByApId(supabase, serverId, uri);
  return byApId?.id ?? null;
}

/**
 * A chat server has members, not followers: a Follow of its Group (Mastodon, Lemmy and
 * Misskey users following a group by handle) is answered with the Group's Reject, so the
 * follower's instance drops its pending request.
 */
async function rejectFollow(serverId: string, server: any, activity: any): Promise<void> {
  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
  const objectUrl = typeof activity.object === 'string' ? activity.object : activity.object?.id;
  const groupUrl = server.ap_id || `https://${config.INSTANCE_DOMAIN}/servers/${serverId}`;
  if (typeof actorUrl !== 'string' || !objectUrl || !SignatureService.verifyActorMatch(objectUrl, groupUrl)) {
    logger.warn(`Ignoring Follow on server inbox ${serverId}: it names ${objectUrl}, not the Group`);
    return;
  }
  const follower = await ActivityProcessor['ensureRemoteUser'](actorUrl);
  if (!follower?.id) {
    logger.warn(`Follow of server ${serverId}: ${actorUrl} could not be resolved, no Reject sent`);
    return;
  }
  const { data: profile } = await getSupabaseClient()
    .from('profiles')
    .select('inbox_url, shared_inbox_url')
    .eq('id', follower.id)
    .maybeSingle();
  const inbox = profile?.inbox_url || profile?.shared_inbox_url;
  if (!inbox) {
    logger.warn(`Follow of server ${serverId}: ${actorUrl} has no inbox, no Reject sent`);
    return;
  }
  await sendRejectActivity(serverId, activity, inbox, 'A chat server is joined, not followed');
}

// JOIN / LEAVE HANDLERS

/**
 * The account a joining actor moved from, when that account belongs to the server: an
 * accepted member or banned. The actor's alsoKnownAs and the alias's movedTo are both
 * fetched now; a local alias is read from its row. The stored rows only select candidates.
 */
export async function findMovedMembership(
  supabase: any,
  serverId: string,
  user: { id: string; federated_id: string | null; also_known_as?: string[] | null },
): Promise<{ aliasId: string; banned: boolean } | null> {
  if (!user.federated_id) return null;
  const stored = (user.also_known_as ?? []).filter((uri) => typeof uri === 'string');
  const columns = 'id, federated_id, is_local, moved_to_id';
  const [{ data: movedHere }, { data: aliased }] = await Promise.all([
    supabase.from('profiles').select(columns).eq('moved_to_id', user.id).limit(25),
    stored.length > 0
      ? supabase.from('profiles').select(columns).in('federated_id', stored).limit(25)
      : Promise.resolve({ data: [] }),
  ]);
  const byId = new Map<string, any>();
  for (const account of [...(movedHere ?? []), ...(aliased ?? [])]) {
    if (account.id !== user.id) byId.set(account.id, account);
  }
  const accounts = [...byId.values()];
  const ids = accounts.map((a) => a.id);
  if (ids.length === 0) return null;

  const [{ data: memberships }, { data: bans }] = await Promise.all([
    supabase.from('user_servers').select('user_id, status').eq('server_id', serverId).in('user_id', ids),
    supabase.from('server_bans').select('user_id').eq('server_id', serverId).in('user_id', ids),
  ]);
  const banned = new Set<string>((bans ?? []).map((b: any) => b.user_id));
  for (const m of memberships ?? []) if (m.status === 'banned') banned.add(m.user_id);
  const members = new Set<string>((memberships ?? []).filter((m: any) => m.status === 'accepted').map((m: any) => m.user_id));
  const candidates = accounts.filter((a) => banned.has(a.id) || members.has(a.id));
  if (candidates.length === 0) return null;

  const fresh = await ActivityProcessor.refreshRemoteActor(user.federated_id);
  if (!fresh) return null;
  const aliases = parseAlsoKnownAs(fresh.actor.alsoKnownAs);

  for (const alias of candidates) {
    if (!alias.federated_id || !aliases.includes(alias.federated_id)) continue;
    let movedHereNow: boolean;
    if (alias.is_local) {
      movedHereNow = alias.moved_to_id === user.id;
    } else {
      const aliasFresh = await ActivityProcessor.refreshRemoteActor(alias.federated_id);
      movedHereNow = !!aliasFresh && parseMovedTo(aliasFresh.actor.movedTo) === user.federated_id;
    }
    if (movedHereNow) return { aliasId: alias.id, banned: banned.has(alias.id) };
  }
  return null;
}

async function processJoinServer(
  serverId: string,
  server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor.id;

  logger.info(`Processing Join request from ${actorUrl}`);

  const remoteUser = await ActivityProcessor['ensureRemoteUser'](actorUrl);

  // ensureRemoteUser returns a partial row; refetch the full record.
  let user = remoteUser;
  if (remoteUser) {
    const { data: fullUser } = await supabase
      .from('profiles')
      .select('id, username, inbox_url, federated_id, is_suspended, also_known_as')
      .eq('id', remoteUser.id)
      .maybeSingle();
    
    if (fullUser) {
      user = fullUser;
    }
  }

  if (!user) {
    logger.error('Failed to find/create remote user for Join activity');
    // ActivityPub convention: inbox is {actorUrl}/inbox.
    const derivedInbox = `${actorUrl}/inbox`;
    await sendRejectActivity(serverId, activity, derivedInbox, 'User not found');
    return;
  }

  if (user.is_suspended) {
    logger.warn(`Rejecting join from suspended user: ${actorUrl}`);
    await sendRejectActivity(serverId, activity, user.inbox_url, 'User is suspended');
    return;
  }

  const { data: ban } = await supabase
    .from('server_bans')
    .select('id')
    .eq('server_id', serverId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (ban) {
    logger.warn(`Rejecting join from banned user: ${actorUrl}`);
    await sendRejectActivity(serverId, activity, user.inbox_url, 'User is banned from this server');
    return;
  }

  const { data: existing } = await supabase
    .from('user_servers')
    .select('id, status')
    .eq('server_id', serverId)
    .eq('user_id', user.id)
    .maybeSingle();

  // A suspended server takes no new members (a_user_servers_suspension_guard); a member's
  // repeated Join keeps the membership.
  if (server.suspended_at && existing?.status !== 'accepted') {
    logger.warn(`Rejecting join from ${actorUrl}: server ${serverId} is suspended`);
    await sendRejectActivity(serverId, activity, user.inbox_url, 'This server is suspended by instance staff');
    return;
  }

  // A member who moved to this actor brings the membership along: no invite, the same
  // nickname and roles. A ban of the old account holds for the new one.
  const carried = existing?.status === 'accepted' ? null : await findMovedMembership(supabase, serverId, user);
  if (carried?.banned) {
    logger.warn(`Rejecting join from ${actorUrl}: the account it moved from is banned`);
    await sendRejectActivity(serverId, activity, user.inbox_url, 'User is banned from this server');
    return;
  }

  // An invite is spent only by a join that adds a member. consume_invite locks the
  // row and checks it as redeem_invite does for local users.
  if (!server.public && existing?.status !== 'accepted' && !carried) {
    const inviteCode = activity['harmony:inviteCode'];

    if (typeof inviteCode !== 'string' || !inviteCode) {
      logger.warn(`Rejecting join to private server without invite code: ${actorUrl}`);
      await sendRejectActivity(serverId, activity, user.inbox_url, 'Private server requires invite code');
      return;
    }

    const { data: refusal, error: inviteError } = await supabase.rpc('consume_invite', {
      p_server_id: serverId,
      p_code: inviteCode,
    });

    if (inviteError || refusal) {
      const reason = inviteError ? 'Invalid invite code' : INVITE_REFUSALS[refusal as string] ?? 'Invalid invite code';
      logger.warn(`Rejecting join with invite ${inviteCode}: ${inviteError?.message ?? refusal}`);
      await sendRejectActivity(serverId, activity, user.inbox_url, reason);
      return;
    }

    logger.info(`Valid invite code used: ${inviteCode}`);
  }

  const memberDomain = new URL(actorUrl).hostname;

  if (existing) {
    if (existing.status === 'accepted') {
      logger.info(`User ${user.username} already member of server ${serverId}`);
    } else {
      await supabase
        .from('user_servers')
        .update({ status: 'accepted' })
        .eq('id', existing.id);
    }
  } else {
    const { error } = await supabase.from('user_servers').insert({
      server_id: serverId,
      user_id: user.id,
      status: 'accepted',
      member_instance: memberDomain,
    });

    if (error) {
      logger.error('Failed to add user to server:', error);
      await sendRejectActivity(serverId, activity, user.inbox_url, 'Internal error');
      return;
    }

    logger.info(`Added ${user.username}@${memberDomain} to server ${serverId}`);
  }

  if (carried) {
    const { data: outcome, error: carryError } = await supabase.rpc('carry_over_moved_membership', {
      p_server_id: serverId,
      p_profile_id: user.id,
      p_alias_id: carried.aliasId,
    });
    if (carryError) {
      logger.error(`Membership carry-over for ${actorUrl} failed: ${carryError.message}`);
    } else {
      logger.info(`Membership of ${carried.aliasId} on server ${serverId} for ${actorUrl}: ${outcome}`);
    }
  }

  await sendAcceptActivity(serverId, activity, user.inbox_url);
  logger.info(`Sent Accept to ${user.username}`);
}

async function processLeaveServer(
  serverId: string,
  _server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor.id;

  const { data: user, error: userError } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('federated_id', actorUrl)
    .maybeSingle();

  if (userError) {
    logger.error(`Failed to query user for Leave activity: ${userError.message}`);
    return;
  }

  if (!user) {
    logger.warn(`User not found for Leave activity: ${actorUrl}`);
    return;
  }

  const { error } = await supabase
    .from('user_servers')
    .delete()
    .eq('server_id', serverId)
    .eq('user_id', user.id);

  if (error) {
    logger.error('Failed to remove user from server:', error);
  } else {
    logger.info(`Removed ${user.username} from server ${serverId}`);
  }
}

// MESSAGE HANDLERS

// Create carries either a ChatThread or a Note in a server channel.
/** The message with this ap_id, when it is in a channel of `serverId`. */
async function findServerMessageByApId(
  supabase: ReturnType<typeof getSupabaseClient>,
  serverId: string,
  apId: string,
): Promise<{ id: string; channel_id: string } | null> {
  const { data: message } = await supabase
    .from('messages')
    .select('id, channel_id')
    .eq('metadata->>ap_id', apId)
    .maybeSingle();
  return message ? await inServerChannel(supabase, serverId, message) : null;
}

async function inServerChannel<T extends { channel_id: string | null }>(
  supabase: ReturnType<typeof getSupabaseClient>,
  serverId: string,
  message: T,
): Promise<(T & { channel_id: string }) | null> {
  if (!message.channel_id) return null;
  const { data: channel } = await supabase
    .from('channels')
    .select('id')
    .eq('id', message.channel_id)
    .eq('server_id', serverId)
    .maybeSingle();
  return channel ? (message as T & { channel_id: string }) : null;
}

/**
 * Message a reaction names, in a channel of `serverId`: by the UUID of a /messages/ URL, then
 * by ap_id.
 */
async function findReactedMessage(
  supabase: ReturnType<typeof getSupabaseClient>,
  serverId: string,
  objectUrl: string,
): Promise<{ id: string; channel_id: string } | null> {
  const messageIdMatch = objectUrl.match(/\/messages\/([a-f0-9-]{36})/);
  if (messageIdMatch) {
    const { data } = await supabase
      .from('messages')
      .select('id, channel_id')
      .eq('id', messageIdMatch[1])
      .maybeSingle();
    const message = data ? await inServerChannel(supabase, serverId, data) : null;
    if (message) return message;
  }
  return findServerMessageByApId(supabase, serverId, objectUrl);
}

async function processCreateActivity(
  serverId: string,
  _server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  const object = activity.object;

  if (object?.type === 'ChatThread') {
    // handleThreadActivity authorizes against this server's channels only.
    logger.info(`Routing server inbox Create ChatThread to handler: ${object.id}`);
    const { handleThreadActivity } = await import('./ThreadActivityHandler.js');
    const result = await handleThreadActivity({ ...activity, object }, { serverId });
    if (!result.success) {
      logger.warn(`Thread Create via server inbox failed: ${result.error}`);
    }
    return;
  }

  if (!object || object.type !== 'Note') {
    logger.info(`Create activity object is not a Note: ${object?.type}`);
    return;
  }

  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor.id;

  const remoteAuthor = await ActivityProcessor['ensureRemoteUser'](actorUrl);
  logger.debug(`ensureRemoteUser returned: ${remoteAuthor ? `id=${remoteAuthor.id}, username=${remoteAuthor.username}` : 'null'}`);

  const { data: author, error: authorError } = await supabase
    .from('profiles')
    .select('id, username, federated_id')
    .eq('federated_id', actorUrl)
    .maybeSingle();

  if (authorError) {
    logger.error(`Failed to query author profile: ${authorError.message}`);
    return;
  }

  if (!author) {
    logger.error(`Failed to find author for server message. actorUrl=${actorUrl}`);
    const username = actorUrl.split('/').pop();
    const { data: similarProfiles } = await supabase
      .from('profiles')
      .select('id, username, federated_id')
      .eq('username', username)
      .limit(5);
    if (similarProfiles?.length) {
      logger.debug(`Similar profiles found: ${JSON.stringify(similarProfiles)}`);
    }
    return;
  }

  logger.debug(`Found author: id=${author.id}, username=${author.username}, federated_id=${author.federated_id}`);

  const context = object.context;
  if (!context || !context.includes('/channels/')) {
    logger.warn('Message missing channel context');
    return;
  }

  let { data: channel } = await supabase
    .from('channels')
    .select('id, name')
    .eq('ap_id', context)
    .eq('server_id', serverId)
    .maybeSingle();

  if (!channel) {
    // Fall back to the UUID embedded in the context URL.
    const channelIdMatch = context.match(/\/channels\/([a-f0-9-]+)/);
    if (channelIdMatch) {
      const { data: localChannel } = await supabase
        .from('channels')
        .select('id, name')
        .eq('id', channelIdMatch[1])
        .eq('server_id', serverId)
        .single();
      channel = localChannel;
    }
  }

  if (!channel) {
    // Sync the remote server to pick up new channels. Channels are never
    // created from incoming messages.
    const { data: serverData } = await supabase
      .from('servers')
      .select('is_local_server, ap_id')
      .eq('id', serverId)
      .single();

    if (serverData && !serverData.is_local_server && serverData.ap_id) {
      try {
        const { ServerDiscoveryService } = await import('../services/ServerDiscoveryService');
        await ServerDiscoveryService.syncRemoteServer(serverId);

        const { data: syncedChannel } = await supabase
          .from('channels')
          .select('id, name')
          .eq('ap_id', context)
          .eq('server_id', serverId)
          .maybeSingle();

        if (!syncedChannel) {
          const channelIdMatch = context.match(/\/channels\/([a-f0-9-]+)/);
          if (channelIdMatch) {
            const { data: localChannel } = await supabase
              .from('channels')
              .select('id, name')
              .eq('id', channelIdMatch[1])
              .eq('server_id', serverId)
              .single();
            channel = localChannel;
          }
        } else {
          channel = syncedChannel;
        }
      } catch (syncError) {
        logger.warn('Failed to sync remote server for missing channel:', syncError);
      }
    }

    if (!channel) {
      logger.warn(`Dropping message for unknown channel: ${context} (server: ${serverId}). Channel creation from messages is not allowed.`);
      return;
    }
  }

  // Thread first: a thread message needs SEND_MESSAGES_IN_THREADS, and a stub
  // thread for an unknown one needs a thread-creation permission.
  let resolvedThreadId: string | null = null;
  const threadApIdValue: string | null =
    typeof object['harmony:threadId'] === 'string' ? object['harmony:threadId'] : null;
  if (threadApIdValue) {
    const thread = await resolveThreadInChannel(supabase, threadApIdValue, channel.id);
    if (thread.status === 'foreign') {
      logDenied('Create(Note)', actorUrl, `thread ${threadApIdValue} is not in channel ${channel.id}`);
      return;
    }
    if (thread.status === 'found') {
      resolvedThreadId = thread.id;
    } else {
      logger.warn(`Thread not found for AP ID ${threadApIdValue}, will create stub thread after message insert.`);
    }
  }

  const kinds = !threadApIdValue
    ? (['message'] as const)
    : resolvedThreadId
      ? (['thread_message'] as const)
      : (['thread_message', 'thread_create'] as const);
  const newUploads = federatedUploadUrls(object).length;
  for (const kind of kinds) {
    const authz = await authorizeChannelWrite(supabase, { actorUrl, serverId, channelId: channel.id, kind, newUploads });
    if (!authz.ok) {
      logDenied('Create(Note)', actorUrl, authz.reason);
      return;
    }
  }

  let messageContent: any[];
  if (object['harmony:rawContent'] && Array.isArray(object['harmony:rawContent'])) {
    messageContent = normalizeMentionDomains(object['harmony:rawContent'], actorUrl);
  } else if (typeof object.content === 'string') {
    messageContent = noteToContent(object);
  } else if (Array.isArray(object.content)) {
    messageContent = normalizeMentionDomains(object.content, actorUrl);
  } else {
    messageContent = [{ type: 'text', text: String(object.content || '') }];
  }

  // Resolve mention userIds from origin-instance UUIDs to local profile UUIDs
  if (Array.isArray(messageContent)) {
    const { resolveMentionUserIds } = await import('../utils/mentionResolver.js');
    messageContent = await resolveMentionUserIds(messageContent);
  }

  const { data: existingMessage } = await supabase
    .from('messages')
    .select('id')
    .eq('metadata->>ap_id', object.id)
    .maybeSingle();

  if (existingMessage) {
    logger.info(`Message already exists: ${object.id}`);
    return;
  }

  // Parent lookup order: ap_id, then UUID from the inReplyTo URL, in this channel.
  const replyToId = typeof object.inReplyTo === 'string'
    ? await resolveMessageInChannel(supabase, object.inReplyTo, channel.id)
    : null;

  const messageTimestamp = notAfterNow(object.published);
  const isEncrypted = object['harmony:encrypted'] === true;

  const messageMetadata: Record<string, any> = {
    ap_id: object.id,
    from_domain: new URL(actorUrl).hostname,
    federated: true,
  };
  if (threadApIdValue && !resolvedThreadId) {
    messageMetadata.pending_thread_ap_id = threadApIdValue;
  }
  const voiceFromAp = harmonyVoiceMessageFromObject(object);
  if (voiceFromAp) {
    Object.assign(messageMetadata, voiceFromAp);
  }

  // Array response: the server's AutoMod drops a blocked row (zero rows), and PostgREST
  // rolls a zero-row .single() request back with the AutoMod event in it.
  const { data: insertedRows, error } = await supabase.from('messages').insert({
    channel_id: channel.id,
    user_id: author.id,
    content: messageContent,
    reply_to: replyToId,
    thread_id: resolvedThreadId,
    metadata: messageMetadata,
    encrypted: isEncrypted,
    created_at: messageTimestamp,
    updated_at: object.updated ? notAfterNow(object.updated) : messageTimestamp,
    federation_status: 'completed',
  }).select('id, content, metadata');

  if (error) {
    logger.error('Failed to insert server message:', error);
    return;
  }
  const insertedMessage = insertedRows?.[0];
  if (!insertedMessage) {
    // Not re-broadcast to member instances either.
    logger.info(`Server message ${object.id} from ${author.username} dropped by AutoMod`);
    return;
  }

  // Link preview enrichment is detached; failures do not affect the insert.
  if (insertedMessage) {
    const { enrichMessageLinkPreviews } = await import('../listeners/DatabaseListener.js');
    enrichMessageLinkPreviews(insertedMessage).catch(err =>
      logger.warn('Link preview enrichment failed for federated message:', err)
    );
  }
  
  logger.info(`Inserted federated message in #${channel.name} from ${author.username}`);

  // Messages may arrive before their thread; a stub thread stands in.
  if (threadApIdValue && !resolvedThreadId && insertedMessage) {
    try {
      const threadUuidMatch = threadApIdValue.match(/\/threads\/([a-f0-9-]{36})/);
      const stubThreadId = threadUuidMatch ? threadUuidMatch[1] : crypto.randomUUID();

      // Parent comes from harmony:parentMessageId, in this channel, not the inserted message.
      let parentMessageId = insertedMessage.id;
      const parentMessageApId = object['harmony:parentMessageId'];
      if (typeof parentMessageApId === 'string') {
        parentMessageId = (await resolveMessageInChannel(supabase, parentMessageApId, channel.id)) ?? parentMessageId;
      }

      let threadName = 'Thread';
      if (Array.isArray(messageContent)) {
        const textPart = messageContent.find((p: any) => p?.type === 'text' && p?.text);
        if (textPart) {
          threadName = String(textPart.text).substring(0, 100);
        }
      }

      const { error: stubError } = await supabase
        .from('threads')
        .insert({
          id: stubThreadId,
          channel_id: channel.id,
          parent_message_id: parentMessageId,
          name: threadName,
          created_by: author.id,
          ap_id: threadApIdValue,
          federation_status: THREAD_STUB_STATUS,
          message_count: 1,
          member_count: 1,
        });

      if (stubError) {
        if (stubError.code === '23505'
            && (await resolveThreadInChannel(supabase, threadApIdValue, channel.id)).status === 'found') {
          resolvedThreadId = stubThreadId;
          logger.info(`Stub thread ${stubThreadId} already exists (race condition), assigning message`);
        } else {
          logger.warn(`Failed to create stub thread: ${stubError.message}`);
        }
      } else {
        resolvedThreadId = stubThreadId;
        logger.info(`Created stub thread ${stubThreadId} for AP ID ${threadApIdValue}`);
      }

      if (resolvedThreadId) {
        await supabase
          .from('messages')
          .update({ thread_id: resolvedThreadId })
          .eq('id', insertedMessage.id);

        const { data: orphans } = await supabase
          .from('messages')
          .select('id')
          .eq('channel_id', channel.id)
          .is('thread_id', null)
          .eq('metadata->>pending_thread_ap_id', threadApIdValue)
          .neq('id', insertedMessage.id);

        if (orphans && orphans.length > 0) {
          await supabase
            .from('messages')
            .update({ thread_id: resolvedThreadId })
            .in('id', orphans.map((m: any) => m.id));
          logger.info(`Assigned ${orphans.length} additional orphaned messages to stub thread ${resolvedThreadId}`);
        }
      }
    } catch (err) {
      logger.warn('Failed to create stub thread from message:', err);
    }
  }

  await relayToChannelReaders(serverId, channel.id, activity, actorUrl, 'message');
}

// Update covers thread, category, channel, server metadata, and Note edits.
async function processUpdateActivity(
  serverId: string,
  server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  const object = activity.object;

  if (!object) {
    return;
  }

  if (object.type === 'ChatThread') {
    // handleThreadActivity requires the thread's creator and this server's channel.
    logger.info(`Routing server inbox Update ChatThread to handler: ${object.id}`);
    const { handleThreadActivity } = await import('./ThreadActivityHandler.js');
    const result = await handleThreadActivity({ ...activity, object }, { serverId });
    if (!result.success) {
      logger.warn(`Thread Update via server inbox failed: ${result.error}`);
    }
    return;
  }

  // AUTHZ: structural updates require host authority or MANAGE_CHANNELS.
  const structuralTypes = ['harmony:Category', 'harmony:TextChannel', 'harmony:VoiceChannel', 'Group'];
  if (structuralTypes.includes(object.type) || object['harmony:ChatServer']) {
    const structActor = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
    if (!(await actorIsServerModerator(supabase, serverId, server, structActor, PERM_MANAGE_CHANNELS))) {
      logger.warn(`Rejecting Update(${object.type}): ${structActor} lacks channel-management authority on server ${serverId}`);
      return;
    }
  }

  if (object.type === 'harmony:Category') {
    const catUuidMatch = object.id?.match(/\/channels\/([a-f0-9-]{36})$/i);
    if (!catUuidMatch) {
      logger.warn(`Cannot extract UUID from category ap_id: ${object.id}`);
      return;
    }
    const catUuid = catUuidMatch[1];

    const { data: existingCat } = await supabase
      .from('channel_categories')
      .select('id')
      .eq('id', catUuid)
      .eq('server_id', serverId)
      .maybeSingle();

    if (existingCat) {
      await supabase
        .from('channel_categories')
        .update({
          name: object.name,
          order: parseChannelPosition(object),
        })
        .eq('id', catUuid);
      logger.info(`Updated remote category: ${object.name}`);
    } else {
      const { error } = await supabase.from('channel_categories').insert({
        id: catUuid,
        server_id: serverId,
        name: object.name,
        order: parseChannelPosition(object) ?? 0,
      });
      if (error) {
        logger.error(`Failed to auto-create category ${object.name}:`, error);
      } else {
        logger.info(`Auto-created remote category on Update: ${object.name}`);
      }
    }
    return;
  }

  if (['harmony:TextChannel', 'harmony:VoiceChannel'].includes(object.type)) {
    const { data: channel } = await supabase
      .from('channels')
      .select('id')
      .eq('ap_id', object.id)
      .eq('server_id', serverId)
      .maybeSingle();

    let categoryId = null;
    if (object.category) {
      const catMatch = object.category.match(/\/channels\/([a-f0-9-]{36})$/i);
      if (catMatch) {
        const { data: cat } = await supabase
          .from('channel_categories')
          .select('id')
          .eq('id', catMatch[1])
          .eq('server_id', serverId)
          .maybeSingle();
        categoryId = cat?.id || null;
      }
    }

    if (channel) {
      await supabase
        .from('channels')
        .update({
          name: object.name,
          description: object.description,
          order: parseChannelPosition(object),
          category: categoryId,
        })
        .eq('id', channel.id);
      logger.info(`Updated remote channel: ${object.name}`);
    } else {
      const entityUuidMatch = object.id?.match(/\/channels\/([a-f0-9-]{36})$/i);
      const channelType = object.type === 'harmony:VoiceChannel' ? 1 : 0;
      const insertData: any = {
        server_id: serverId,
        name: object.name,
        description: object.description,
        type: channelType,
        order: parseChannelPosition(object) ?? 0,
        ap_id: object.id,
        is_remote: true,
        category: categoryId,
      };
      if (entityUuidMatch) insertData.id = entityUuidMatch[1];

      const { error } = await supabase.from('channels').insert(insertData);
      if (error) {
        logger.error(`Failed to auto-create channel ${object.name}:`, error);
      } else {
        logger.info(`Auto-created remote channel on Update: ${object.name}`);
      }
    }
    return;
  }

  if (object.type === 'Group' || object['harmony:ChatServer']) {
    const serverIdMatch = object.id?.match(/\/servers\/([a-f0-9-]{36})$/i);
    if (!serverIdMatch) {
      logger.warn(`Cannot extract server ID from ap_id: ${object.id}`);
      return;
    }
    
    const { data: existingServer } = await supabase
      .from('servers')
      .select('id')
      .eq('id', serverIdMatch[1])
      .eq('is_local_server', false)
      .maybeSingle();
    
    if (!existingServer) {
      logger.warn(`Remote server not found for Update: ${object.id}`);
      return;
    }
    
    const updateData: any = {
      updated_at: new Date().toISOString(),
    };
    
    if (object.name) {
      updateData.name = object.name;
    }
    if (object.summary !== undefined) {
      updateData.description = object.summary;
    }
    // Explicit null means the icon was removed.
    if (object.icon?.url) {
      updateData.icon = object.icon.url;
    } else if (object.icon === null) {
      updateData.icon = null;
    }
    // Banner is carried in the ActivityPub 'image' property.
    if (object.image?.url) {
      updateData.banner = object.image.url;
    } else if (object.image === null) {
      updateData.banner = null;
    }
    // AP 'discoverable' maps to servers.public.
    if (object.discoverable !== undefined) {
      updateData.public = object.discoverable;
    }
    
    const { error: updateError } = await supabase
      .from('servers')
      .update(updateData)
      .eq('id', existingServer.id);
    
    if (updateError) {
      logger.error(`Failed to update server ${existingServer.id}:`, updateError);
    } else {
      const changedFields = Object.keys(updateData).filter(k => k !== 'updated_at');
      logger.info(`Updated remote server ${existingServer.id}: ${changedFields.join(', ')}`);
    }
    return;
  }

  if (object.type !== 'Note') {
    return;
  }

  const message = typeof object.id === 'string'
    ? await findServerMessageByApId(supabase, serverId, object.id)
    : null;

  if (!message) {
    logger.warn(`Message not found in server ${serverId} for Update: ${object.id}`);
    return;
  }

  // AUTHZ: message edits are author-only, by a member still able to view the channel.
  const editorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
  if (!(await actorOwnsMessage(supabase, message.id, editorUrl))) {
    logger.warn(`Rejecting Update: ${editorUrl} does not own message ${object.id}`);
    return;
  }
  // As enforce_message_attach_files: an edit needs ATTACH_FILES only for uploads the row lacks.
  const { data: stored } = await supabase
    .from('messages')
    .select('content')
    .eq('id', message.id)
    .maybeSingle();
  const held = storedFileUrls(stored?.content);
  const editAuthz = await authorizeChannelWrite(supabase, {
    actorUrl: editorUrl, serverId, channelId: message.channel_id, kind: 'edit',
    newUploads: federatedUploadUrls(object).filter((url) => !held.has(url)).length,
  });
  if (!editAuthz.ok) {
    logDenied('Update(Note)', editorUrl, editAuthz.reason);
    return;
  }

  let messageContent: any[];
  if (object['harmony:rawContent'] && Array.isArray(object['harmony:rawContent'])) {
    messageContent = normalizeMentionDomains(object['harmony:rawContent'], editorUrl);
  } else if (typeof object.content === 'string') {
    messageContent = noteToContent(object);
  } else {
    messageContent = normalizeMentionDomains(object.content || [], editorUrl);
  }

  const voicePatch = harmonyVoiceMessageFromObject(object);
  let updatePayload: Record<string, unknown> = {
    content: messageContent,
    updated_at: object.updated || new Date().toISOString(),
  };
  if (voicePatch) {
    const { data: existingRow } = await supabase
      .from('messages')
      .select('metadata')
      .eq('id', message.id)
      .maybeSingle();
    const meta = (existingRow?.metadata && typeof existingRow.metadata === 'object')
      ? { ...existingRow.metadata }
      : {};
    Object.assign(meta, voicePatch);
    updatePayload = { ...updatePayload, metadata: meta };
  }

  const { error } = await supabase
    .from('messages')
    .update(updatePayload)
    .eq('id', message.id);

  if (error) {
    logger.error('Failed to update message:', error);
    return;
  }
  
  logger.info(`Updated federated message: ${object.id}`);

  await relayToChannelReaders(serverId, message.channel_id, activity, editorUrl, 'edit');
}

async function processDeleteActivity(
  serverId: string,
  server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  
  const objectUrl = typeof activity.object === 'string' 
    ? activity.object 
    : activity.object?.id;

  if (!objectUrl) {
    return;
  }

  const actorUrlDel = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;

  // Message is resolved first, within this server: authorization precedes mutation.
  const targetMsg = await findServerMessageByApId(supabase, serverId, objectUrl);

  if (!targetMsg) {
    logger.warn(`Message not found in server ${serverId} for delete: ${objectUrl}`);
    return;
  }

  // AUTHZ: deleter must own the message, or hold MANAGE_MESSAGES in its channel or host authority.
  const ownsMsg = await actorOwnsMessage(supabase, targetMsg.id, actorUrlDel);
  const canModerate = ownsMsg
    ? true
    : await actorManagesMessagesIn(supabase, serverId, server, actorUrlDel, targetMsg.channel_id);
  if (!canModerate) {
    logger.warn(`Rejecting Delete: ${actorUrlDel} may not delete message ${objectUrl} in server ${serverId}`);
    return;
  }

  const { error } = await supabase
    .from('messages')
    .update({ is_deleted: true })
    .eq('id', targetMsg.id);

  if (error) {
    logger.error('Failed to delete message:', error);
    return;
  }

  logger.info(`Deleted federated message: ${objectUrl}`);

  // The Group's own Delete (handleChannelMessageDelete, queued by the is_deleted trigger)
  // follows through the worker; a receiver applies whichever arrives first.
  await relayToChannelReaders(serverId, targetMsg.channel_id, activity, actorUrlDel, 'delete');
}

// Handles Like, EmojiReact and EmojiReaction.
async function processReactionActivity(
  serverId: string,
  _server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor.id;
  const objectUrl = typeof activity.object === 'string' ? activity.object : activity.object?.id;

  if (!objectUrl) {
    return;
  }

  await ActivityProcessor['ensureRemoteUser'](actorUrl);

  const { data: user } = await supabase
    .from('profiles')
    .select('id')
    .eq('federated_id', actorUrl)
    .single();

  if (!user) {
    return;
  }

  const message = await findReactedMessage(supabase, serverId, objectUrl);

  if (!message) {
    logger.warn(`Message not found in server ${serverId} for reaction: ${objectUrl}`);
    return;
  }

  // AUTHZ: accepted, unbanned member holding VIEW_CHANNEL and ADD_REACTIONS.
  const reactionAuthz = await authorizeChannelWrite(supabase, {
    actorUrl, serverId, channelId: message.channel_id, kind: 'reaction',
  });
  if (!reactionAuthz.ok) {
    logDenied('reaction', actorUrl, reactionAuthz.reason);
    return;
  }

  const emoji = activity.content || activity.tag?.find((t: any) => t.type === 'Emoji')?.name || '❤️';
  const emojiUrl = activity.tag?.find((t: any) => t.type === 'Emoji')?.icon?.url;
  const emojiName = activity.tag?.find((t: any) => t.type === 'Emoji')?.name;

  const isCustomEmoji = !!(emojiUrl && emojiName);

  const reactionData: any = {
    message_id: message.id,
    user_id: user.id,
    metadata: { federated: true, ap_id: activity.id },
  };

  if (isCustomEmoji) {
    // Custom emoji resolves to a row id in the emojis table.
    const { data: existingEmoji } = await supabase
      .from('emojis')
      .select('id')
      .eq('url', emojiUrl)
      .maybeSingle();

    if (existingEmoji) {
      reactionData.emoji_id = existingEmoji.id;
    } else {
      const cleanName = (emojiName || emoji).replace(/:/g, '');
      const { data: newEmoji } = await supabase
        .from('emojis')
        .insert({
          name: cleanName,
          url: emojiUrl,
          server_id: null,
          uploader: user.id,
          domain: new URL(emojiUrl).hostname,
        })
        .select('id')
        .single();

      if (newEmoji) {
        reactionData.emoji_id = newEmoji.id;
      }
    }

    if (!reactionData.emoji_id) {
      logger.error('Failed to get/create custom emoji for reaction');
      return;
    }
  } else {
    // Unicode emoji: emoji_id null, value in custom_emoji_content.
    // Storage must match ActivityProcessor.processLike or reactions double-count.
    let normalizedEmoji = emoji || '❤️';
    if (normalizedEmoji === '❤') normalizedEmoji = '❤️';
    reactionData.emoji_id = null;
    reactionData.custom_emoji_content = normalizedEmoji;
  }

  let dupQuery = supabase
    .from('reactions')
    .select('id')
    .eq('message_id', message.id)
    .eq('user_id', user.id);

  if (reactionData.emoji_id) {
    dupQuery = dupQuery.eq('emoji_id', reactionData.emoji_id);
  } else {
    dupQuery = dupQuery.is('emoji_id', null)
      .eq('custom_emoji_content', reactionData.custom_emoji_content);
  }

  const { data: existingReaction } = await dupQuery.maybeSingle();
  if (existingReaction) {
    logger.info(`Reaction already exists for user ${user.id} on message ${message.id}`);
    return;
  }

  const { data: inserted, error } = await supabase
    .from('reactions')
    .insert(reactionData)
    .select('id');

  if (error) {
    // 23505: unique violation from a concurrent insert.
    if (error.code === '23505') {
      logger.info(`Reaction already exists (constraint): ${error.message}`);
      return;
    }
    logger.error('Failed to add reaction:', error);
    return;
  }

  if (!inserted?.length) {
    // check_message_emoji_reaction_limit drops a federated 21st emoji; nothing to relay.
    logger.info(`Reaction on message ${message.id} dropped: the message holds 20 different emoji`);
    return;
  }

  logger.info(`Added reaction to message ${message.id}`);

  await relayToChannelReaders(serverId, message.channel_id, activity, actorUrl, 'reaction');
}

// Add creates a channel or a category.
async function processAddActivity(
  serverId: string,
  server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  const object = activity.object;

  if (!object) {
    return;
  }

  const objectType = object.type;

  // AUTHZ: channel/category creation requires host authority or MANAGE_CHANNELS.
  const addActor = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
  if (!(await actorIsServerModerator(supabase, serverId, server, addActor, PERM_MANAGE_CHANNELS))) {
    logger.warn(`Rejecting Add(${objectType}): ${addActor} lacks channel-management authority on server ${serverId}`);
    return;
  }

  let entityUuid: string | undefined;
  const match = object.id?.match(/\/channels\/([a-f0-9-]{36})$/i);
  if (match) {
    entityUuid = match[1];
  }

  if (objectType === 'harmony:Category') {
    const { data: existingCat } = await supabase
      .from('channel_categories')
      .select('id')
      .eq('server_id', serverId)
      .eq('name', object.name)
      .maybeSingle();

    if (existingCat) {
      logger.info(`Category already exists: ${object.name}`);
      return;
    }

    const catInsertData: any = {
      server_id: serverId,
      name: object.name,
      order: parseChannelPosition(object) ?? 0,
    };

    // Reuse the remote UUID as the local primary key.
    if (entityUuid) {
      catInsertData.id = entityUuid;
    }

    const { error: catError } = await supabase.from('channel_categories').insert(catInsertData);
    if (catError) {
      logger.error(`Failed to create category ${object.name}:`, catError);
    } else {
      logger.info(`Created remote category: ${object.name}`);
    }
    return;
  }

  if (['harmony:TextChannel', 'harmony:VoiceChannel'].includes(objectType)) {
    const channelType = objectType === 'harmony:VoiceChannel' ? 1 : 0;

    // Category reference resolves to channel_categories by UUID.
    let categoryId = null;
    if (object.category) {
      const catMatch = object.category.match(/\/channels\/([a-f0-9-]{36})$/i);
      if (catMatch) {
        const { data: cat } = await supabase
          .from('channel_categories')
          .select('id')
          .eq('id', catMatch[1])
          .eq('server_id', serverId)
          .maybeSingle();
        
        categoryId = cat?.id || null;
      }
    }

    const { data: existing } = await supabase
      .from('channels')
      .select('id')
      .eq('ap_id', object.id)
      .maybeSingle();

    if (existing) {
      logger.info(`Channel already exists: ${object.name}`);
      return;
    }

    const insertData: any = {
      server_id: serverId,
      name: object.name,
      description: object.description,
      type: channelType,
      order: parseChannelPosition(object) ?? 0,
      ap_id: object.id,
      is_remote: true,
      category: categoryId,
    };

    // Reuse the remote UUID as the local primary key.
    if (entityUuid) {
      insertData.id = entityUuid;
    }

    const { error: channelError } = await supabase.from('channels').insert(insertData);
    if (channelError) {
      logger.error(`Failed to create channel ${object.name}:`, channelError);
    } else {
      logger.info(`Created remote channel: ${object.name} (${objectType}, category: ${categoryId})`);
    }
  }
}

// Remove deletes a channel/category, or kicks a member.
async function processRemoveActivity(
  serverId: string,
  server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  
  const objectUrl = typeof activity.object === 'string' ? activity.object : activity.object?.id;
  const removeActor = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;

  if (!objectUrl) {
    return;
  }

  if (objectUrl.includes('/channels/')) {
    // AUTHZ: structural change - require host authority or MANAGE_CHANNELS.
    if (!(await actorIsServerModerator(supabase, serverId, server, removeActor, PERM_MANAGE_CHANNELS))) {
      logger.warn(`Rejecting Remove(channel): ${removeActor} lacks channel-management authority on server ${serverId}`);
      return;
    }

    const uuidMatch = objectUrl.match(/\/channels\/([a-f0-9-]{36})$/i);
    const entityUuid = uuidMatch ? uuidMatch[1] : null;

    const { data: deletedChannel } = await supabase
      .from('channels')
      .delete()
      .eq('ap_id', objectUrl)
      .eq('server_id', serverId)
      .select('id')
      .maybeSingle();
    
    if (deletedChannel) {
      logger.info(`Removed remote channel: ${objectUrl}`);
      return;
    }

    // channel_categories has no ap_id column; match by UUID.
    if (entityUuid) {
      const { data: deletedCategory } = await supabase
        .from('channel_categories')
        .delete()
        .eq('id', entityUuid)
        .eq('server_id', serverId)
        .select('id')
        .maybeSingle();
      
      if (deletedCategory) {
        logger.info(`Removed remote category: ${objectUrl}`);
        return;
      }
    }

    logger.warn(`Could not find channel or category to remove: ${objectUrl}`);
    return;
  }

  // Otherwise it's a kick, under the rules of kick_server_member: the owner is
  // never removed; a member leaves on their own; anyone else needs host
  // authority, ownership, or KICK_MEMBERS with a strictly higher top role.
  const { data: user } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('federated_id', objectUrl)
    .maybeSingle();

  if (!user) {
    return;
  }

  if (server.owner && user.id === server.owner) {
    logger.warn(`Rejecting Remove(member): ${removeActor} may not remove the owner of server ${serverId}`);
    return;
  }

  const isSelfRemoval = !!removeActor && SignatureService.verifyActorMatch(removeActor, objectUrl);
  let actorProfileId: string | null = null;
  if (!isSelfRemoval) {
    if (!(await actorIsServerModerator(supabase, serverId, server, removeActor, PERM_KICK_MEMBERS))) {
      logger.warn(`Rejecting Remove(member): ${removeActor} may not kick ${objectUrl} from server ${serverId}`);
      return;
    }
    const isHostActor = !!server.ap_id && SignatureService.verifyActorMatch(removeActor, server.ap_id);
    actorProfileId = isHostActor ? null : await resolveActorProfileId(supabase, removeActor);
    const actorIsOwner = !!actorProfileId && actorProfileId === server.owner;
    if (!isHostActor && !actorIsOwner) {
      const actorPosition = await highestRolePosition(supabase, serverId, actorProfileId);
      const targetPosition = await highestRolePosition(supabase, serverId, user.id);
      if (actorPosition === null || targetPosition === null || actorPosition <= targetPosition) {
        logger.warn(`Rejecting Remove(member): ${removeActor} does not outrank ${objectUrl} on server ${serverId}`);
        return;
      }
    }
  }

  const { data: removed } = await supabase
    .from('user_servers')
    .delete()
    .eq('server_id', serverId)
    .eq('user_id', user.id)
    .select('id');

  // The kick event tells a member from another instance through their instance
  // (trigger_remote_member_removal, migration 20261025200001).
  if (!isSelfRemoval && removed?.length) {
    const { error: eventError } = await supabase.from('server_membership_events').insert({
      server_id: serverId,
      user_id: user.id,
      event_type: 'kick',
      payload: {
        kicked_by: actorProfileId,
        reason: typeof activity.summary === 'string' ? activity.summary.slice(0, 300) : '',
      },
    });
    if (eventError) logger.warn(`Kick of ${user.username} on server ${serverId} not recorded: ${eventError.message}`);
  }

  logger.info(`Kicked ${user.username} from server ${serverId}`);
}

async function processUndoActivity(
  serverId: string,
  server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  const object = activity.object;

  if (!object) {
    return;
  }

  const objectType = typeof object === 'string' ? null : object.type;

  switch (objectType) {
    case 'Join': {
      // Undo(Join) is a Leave. processLeaveServer trusts object.actor, so it
      // must equal the authenticated outer actor; otherwise any actor can undo
      // another member's Join and force-remove them.
      const undoActor = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
      const joinActor = typeof object.actor === 'string' ? object.actor : object.actor?.id;
      if (!undoActor || !joinActor || !SignatureService.verifyActorMatch(undoActor, joinActor)) {
        logger.warn(`Rejecting Undo(Join): actor ${undoActor} does not match Join actor ${joinActor}`);
        return;
      }
      await processLeaveServer(serverId, server, object);
      break;
    }

    case 'Like':
    case 'EmojiReact':
    case 'EmojiReaction': {
      // The undone reaction is the signer's own.
      const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
      const likeActor = typeof object.actor === 'string' ? object.actor : object.actor?.id;
      if (!actorUrl || (likeActor && !SignatureService.verifyActorMatch(actorUrl, likeActor))) {
        logger.warn(`Rejecting Undo(${objectType}): ${actorUrl} cannot undo a reaction by ${likeActor}`);
        return;
      }
      const targetUrl = typeof object.object === 'string' ? object.object : object.object?.id;
      const userId = await resolveActorProfileId(supabase, actorUrl);
      const message = userId && typeof targetUrl === 'string'
        ? await findReactedMessage(supabase, serverId, targetUrl)
        : null;
      if (!userId || !message) {
        logger.warn(`Undo(${objectType}) names no reaction in server ${serverId}: ${targetUrl}`);
        return;
      }
      await ActivityProcessor.removeMessageReactions(message.id, userId, object);
      await relayToChannelReaders(serverId, message.channel_id, activity, actorUrl, 'reaction removal');
      break;
    }

    default:
      logger.info(`Unhandled Undo object type: ${objectType}`);
  }
}

// HELPER FUNCTIONS

async function sendAcceptActivity(
  serverId: string,
  originalActivity: any,
  targetInbox: string
): Promise<void> {
  const serverUrl = `https://${config.INSTANCE_DOMAIN}/servers/${serverId}`;

  const acceptActivity = {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      HARMONY_CONTEXT,
    ],
    id: `${serverUrl}/activities/${crypto.randomUUID()}`,
    type: 'Accept',
    actor: serverUrl,
    object: originalActivity,
    published: new Date().toISOString(),
  };

  await DeliveryQueue.sendToInbox(targetInbox, acceptActivity, { serverId });
}

async function sendRejectActivity(
  serverId: string,
  originalActivity: any,
  targetInbox: string,
  reason: string
): Promise<void> {
  const serverUrl = `https://${config.INSTANCE_DOMAIN}/servers/${serverId}`;

  const rejectActivity = {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      HARMONY_CONTEXT,
    ],
    id: `${serverUrl}/activities/${crypto.randomUUID()}`,
    type: 'Reject',
    actor: serverUrl,
    object: originalActivity,
    summary: reason,
    published: new Date().toISOString(),
  };

  await DeliveryQueue.sendToInbox(targetInbox, rejectActivity, { serverId });
}
