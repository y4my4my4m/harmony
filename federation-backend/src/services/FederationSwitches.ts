/**
 * The instance's federation switches (instance_federation_switches, migration
 * 20261028500001), as every process of the backend enforces them:
 *
 *   outbound off   no activity is delivered to another instance; dropped and logged.
 *   inbound off    every inbox POST and every signed request of another instance answers 403.
 *   both off       the instance is closed: the Group's Remove of a member from another instance
 *                  and a local member's Leave of a server hosted elsewhere, which the closing
 *                  itself queues, are still delivered.
 *
 * Read at most every REFRESH_MS; NOTIFY federation_switches drops the cached value. A failed
 * read keeps the last value, both on before the first.
 */

import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

export interface FederationSwitchState {
  inbound: boolean;
  outbound: boolean;
}

const REFRESH_MS = 10_000;

let state: FederationSwitchState = { inbound: true, outbound: true };
let readAt = 0;
let inFlight: Promise<FederationSwitchState> | null = null;

async function read(): Promise<FederationSwitchState> {
  let data: any;
  let failure: string | null = null;
  try {
    const result = await getSupabaseClient().rpc('instance_federation_switches');
    data = result.data;
    failure = result.error?.message ?? null;
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (failure || !row || typeof row !== 'object') {
    logger.warn(`Federation switches unread, keeping inbound=${state.inbound} outbound=${state.outbound}: ${failure ?? 'no row'}`);
    return state;
  }
  const next = { inbound: row.inbound !== false, outbound: row.outbound !== false };
  if (next.inbound !== state.inbound || next.outbound !== state.outbound) {
    logger.info(`Federation switches: inbound=${next.inbound} outbound=${next.outbound}`);
  }
  return next;
}

export async function federationSwitches(): Promise<FederationSwitchState> {
  if (Date.now() - readAt < REFRESH_MS) return state;
  inFlight ??= read()
    .then((next) => {
      state = next;
      readAt = Date.now();
      return next;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function invalidateFederationSwitches(): void {
  readAt = 0;
}

/**
 * Activities a closed instance still sends: the Group's Remove of a member when its server stopped
 * federating (memberRemoveActivity, id .../activities/removal-<row>, harmony:reason
 * federation_closed) and a member's Leave queued by instance_server_member_leaves (id
 * .../activities/instance-leave-<row>). Both are recognised on a queued retry too.
 */
export function isClosingActivity(activity: unknown): boolean {
  const a = activity as { type?: unknown; id?: unknown; 'harmony:reason'?: unknown } | null;
  const id = typeof a?.id === 'string' ? a.id : '';
  if (a?.type === 'Remove') return id.includes('/activities/removal-') && a['harmony:reason'] === 'federation_closed';
  if (a?.type === 'Leave') return id.includes('/activities/instance-leave-');
  return false;
}

/** Whether an activity may go to another instance now. */
export async function outboundAllows(activity: unknown): Promise<boolean> {
  let { inbound, outbound } = await federationSwitches();
  if (outbound) return true;
  if (!isClosingActivity(activity)) return false;
  // The closing queues its Removes and Leaves before this process reads inbound off.
  if (inbound) {
    invalidateFederationSwitches();
    ({ inbound, outbound } = await federationSwitches());
  }
  return outbound || !inbound;
}

/** Whether other instances' deliveries and signed requests are taken now. */
export async function inboundAllowed(): Promise<boolean> {
  return (await federationSwitches()).inbound;
}

/** Test seam: the next read sees the database again, starting from both on. */
export function resetFederationSwitchesForTests(): void {
  state = { inbound: true, outbound: true };
  readAt = 0;
  inFlight = null;
}
