/**
 * Mail hosts of email domains for public.before_user_created_hook (20261109100001). Postgres has no
 * resolver: the hook inserts a row in signup_mail_hosts and queues a signup-mail-host job, and the
 * hook reads the hosts written here at the next sign-up on that domain.
 */

import { promises as dns } from 'node:dns';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

const LOOKUP_TIMEOUT_MS = 5_000;
const RETRY_AFTER_MS = 5 * 60_000;
const MAX_HOSTS = 10;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]{2,}$/;

export type MxResolver = (domain: string) => Promise<Array<{ exchange: string }>>;

export interface SignupMailHostJobData {
  domain: string;
}

/** ENOTFOUND and ENODATA are answers: the domain has no mail server. Any other error is retried. */
function isDefinitive(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOTFOUND' || code === 'ENODATA';
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('MX lookup timed out')), LOOKUP_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Lowercase names without the root dot. A null MX (RFC 7505) has an empty exchange. */
export function normalizeMailHosts(records: Array<{ exchange: string }>): string[] {
  const hosts = new Set<string>();
  for (const { exchange } of records) {
    const host = exchange.trim().toLowerCase().replace(/\.$/, '');
    if (DOMAIN.test(host)) hosts.add(host);
  }
  return [...hosts].sort().slice(0, MAX_HOSTS);
}

/** Null when the lookup failed and is owed again. */
export async function lookupMailHosts(domain: string, resolve: MxResolver = dns.resolveMx): Promise<string[] | null> {
  try {
    return normalizeMailHosts(await withTimeout(resolve(domain)));
  } catch (error) {
    if (isDefinitive(error)) return [];
    logger.warn(`MX lookup for ${domain} failed: ${(error as Error).message}`);
    return null;
  }
}

export async function handleSignupMailHostJob(
  data: SignupMailHostJobData,
  resolve: MxResolver = dns.resolveMx,
): Promise<void> {
  const domain = String(data.domain ?? '').toLowerCase();
  const supabase = getSupabaseClient();
  if (!DOMAIN.test(domain)) {
    const { error } = await supabase
      .from('signup_mail_hosts')
      .update({ hosts: [], checked_at: new Date().toISOString(), due_at: null })
      .eq('domain', data.domain);
    if (error) throw error;
    return;
  }

  const hosts = await lookupMailHosts(domain, resolve);
  const { error } = await supabase
    .from('signup_mail_hosts')
    .update(hosts
      ? { hosts, checked_at: new Date().toISOString(), due_at: null }
      : { due_at: new Date(Date.now() + RETRY_AFTER_MS).toISOString() })
    .eq('domain', domain);
  if (error) throw error;
}
