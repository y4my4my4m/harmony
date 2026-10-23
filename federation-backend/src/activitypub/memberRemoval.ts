/**
 * A server's removal of a member from another instance: turning federation off, a kick, a ban,
 * the account's suspension on the host.
 *
 * Host: public.federation_member_removals holds one row per removed remote member (migrations
 * 20261025200001, 20261027250001). Job 'federate-member-removal' sends the member's inbox,
 * signed with the Group's key,
 *
 *   Remove { id: <group>/activities/removal-<row id>, actor: <group>, object: <member>,
 *            target: <group>/members, published: <row created_at>, summary?,
 *            harmony:reason: 'federation_closed' | 'kick' | 'ban' | 'suspended',
 *            harmony:staff?: true }
 *
 * harmony:staff: the host's instance staff removed the member, not the server's moderators.
 *
 * The id is fixed per row, so a resend is deduplicated by the receiver's activity store.
 *
 * Member's instance: ActivityProcessor.processGroupMemberRemove.
 */
import config from '../config/index.js';
import { HARMONY_CONTEXT } from './harmonyContext.js';

export const REMOVAL_REASONS = ['federation_closed', 'kick', 'ban', 'suspended'] as const;
export type RemovalReason = (typeof REMOVAL_REASONS)[number];

export const FEDERATION_CLOSED_SUMMARY = 'This server stopped taking members from other instances';

export interface MemberRemovalRow {
  id: string;
  server_id: string;
  reason: RemovalReason;
  summary: string | null;
  created_at: string;
  staff?: boolean | null;
}

export function groupUrlOf(serverId: string): string {
  return `https://${config.INSTANCE_DOMAIN}/servers/${serverId}`;
}

export function memberRemoveActivity(removal: MemberRemovalRow, memberUrl: string): Record<string, unknown> {
  const group = groupUrlOf(removal.server_id);
  const summary = removal.reason === 'federation_closed' ? FEDERATION_CLOSED_SUMMARY : removal.summary;
  return {
    '@context': ['https://www.w3.org/ns/activitystreams', HARMONY_CONTEXT],
    id: `${group}/activities/removal-${removal.id}`,
    type: 'Remove',
    actor: group,
    object: memberUrl,
    target: `${group}/members`,
    to: [memberUrl],
    published: new Date(removal.created_at).toISOString(),
    ...(summary ? { summary } : {}),
    'harmony:reason': removal.reason,
    ...(removal.staff ? { 'harmony:staff': true } : {}),
  };
}

/** True when the Remove says the host's instance staff removed the member. */
export function removedByStaff(activity: any): boolean {
  return activity?.['harmony:staff'] === true;
}

/** The reason a Remove names; null for a Remove from software that names none. */
export function removalReason(activity: any): RemovalReason | null {
  const reason = activity?.['harmony:reason'];
  return (REMOVAL_REASONS as readonly string[]).includes(reason) ? reason as RemovalReason : null;
}

/** True when a membership created at `joinedAt` is newer than the Remove published at `published`. */
export function membershipOutlivesRemove(joinedAt: unknown, published: unknown): boolean {
  if (typeof joinedAt !== 'string' || typeof published !== 'string') return false;
  const joined = Date.parse(joinedAt);
  const removed = Date.parse(published);
  return Number.isFinite(joined) && Number.isFinite(removed) && joined > removed;
}
