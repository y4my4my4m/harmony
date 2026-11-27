/**
 * A server's welcome screen and rules on the wire, and on its copies (migrations 20261006300001,
 * 20261127100001).
 *
 * Group document (GroupService.ts) and Update(Group) (DatabaseListener.ts handleServerUpdated):
 *   "harmony:welcome": {
 *     "rules": [{ "title", "description" }],   at most MAX_RULES
 *     "enabled": boolean, "message": string,   message empty while disabled
 *     "enabledAt": ISO time | null,
 *     "requireAcceptance": boolean, "acceptanceRequiredAt": ISO time | null
 *   }
 *     the screen as get_server_welcome reads it: its rules, else servers.rules as titles.
 *     Absent when it cannot be read: a copy's screen stays as it is.
 * Group document only:
 *   "harmony:instanceRules": ["..."]   the host instance's rules (instance_config.instance_rules),
 *     shown with the server's before a join from another instance. Absent when there are none.
 *
 * A copy stores harmony:welcome as its server_welcome_screens row. get_server_welcome,
 * accept_server_rules and enforce_server_rules_acceptance then hold the copy's members to it as
 * they hold a local server's members: the member's instance asks, records the acceptance and
 * refuses the member's messages until then. Harmony before 1.9.9 sends neither property and
 * ignores both.
 */

export const HARMONY_WELCOME = 'harmony:welcome';
export const HARMONY_INSTANCE_RULES = 'harmony:instanceRules';

/** server_welcome_screens limits (20261006300001). */
export const MAX_RULES = 20;
const MAX_TITLE = 100;
const MAX_DESCRIPTION = 500;
const MAX_MESSAGE = 2000;
const MAX_INSTANCE_RULES = 50;
const MAX_INSTANCE_RULE = 1000;

export interface WelcomeRule {
  title: string;
  description: string;
}

export interface ApWelcome {
  rules: WelcomeRule[];
  enabled: boolean;
  message: string;
  enabledAt: string | null;
  requireAcceptance: boolean;
  acceptanceRequiredAt: string | null;
}

/** A server_welcome_screens row, as the host reads it. */
export interface WelcomeScreenRow {
  enabled?: boolean | null;
  message?: string | null;
  rules?: unknown;
  require_acceptance?: boolean | null;
  enabled_at?: string | null;
  acceptance_required_at?: string | null;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function clean(value: unknown, max: number, multiline = false): string {
  if (typeof value !== 'string') return '';
  const stripped = value.replace(CONTROL, '');
  return (multiline ? stripped : stripped.replace(/[\r\n\t]+/g, ' ')).trim().slice(0, max);
}

function time(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Rules of a screen row ({title, description} objects) or of servers.rules (title strings). */
function rulesOf(value: unknown): WelcomeRule[] {
  if (!Array.isArray(value)) return [];
  const rules: WelcomeRule[] = [];
  for (const entry of value) {
    if (rules.length >= MAX_RULES) break;
    const title = clean(typeof entry === 'string' ? entry : (entry as any)?.title, MAX_TITLE);
    if (!title) continue;
    const description = typeof entry === 'string' ? '' : clean((entry as any)?.description, MAX_DESCRIPTION, true);
    rules.push({ title, description });
  }
  return rules;
}

/** harmony:welcome of a server: its screen row when it has one, else its servers.rules titles. */
export function welcomeToAp(screen: WelcomeScreenRow | null, serverRules: unknown): ApWelcome {
  if (!screen) {
    return {
      rules: rulesOf(serverRules),
      enabled: false,
      message: '',
      enabledAt: null,
      requireAcceptance: false,
      acceptanceRequiredAt: null,
    };
  }
  const enabled = screen.enabled === true;
  return {
    rules: rulesOf(screen.rules),
    enabled,
    message: enabled ? clean(screen.message, MAX_MESSAGE, true) : '',
    enabledAt: enabled ? time(screen.enabled_at) : null,
    requireAcceptance: screen.require_acceptance === true,
    acceptanceRequiredAt: screen.require_acceptance === true ? time(screen.acceptance_required_at) : null,
  };
}

/**
 * harmony:welcome of a Group as a copy stores it; null when the Group carries none, which leaves
 * a copy's screen as it is. A missing enabledAt or acceptanceRequiredAt reads as `now`, which
 * holds no one who joined before it. Requiring acceptance of no rules reads as not requiring it,
 * as set_server_welcome refuses that.
 */
export function parseGroupWelcome(value: unknown, now: Date = new Date()): ApWelcome | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const rules = rulesOf(v.rules);
  const enabled = v.enabled === true;
  const requireAcceptance = v.requireAcceptance === true && rules.length > 0;
  return {
    rules,
    enabled,
    message: enabled ? clean(v.message, MAX_MESSAGE, true) : '',
    enabledAt: enabled ? time(v.enabledAt) ?? now.toISOString() : null,
    requireAcceptance,
    acceptanceRequiredAt: requireAcceptance ? time(v.acceptanceRequiredAt) ?? now.toISOString() : null,
  };
}

/** instance_config.instance_rules as harmony:instanceRules lists them. */
export function instanceRulesToAp(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const rules: string[] = [];
  for (const entry of value) {
    if (rules.length >= MAX_INSTANCE_RULES) break;
    const rule = clean(entry, MAX_INSTANCE_RULE);
    if (rule) rules.push(rule);
  }
  return rules;
}

/** harmony:instanceRules of a Group document; empty when it carries none. */
export function parseInstanceRules(value: unknown): string[] {
  return instanceRulesToAp(value);
}

/** Rule titles a join dialog lists. */
export function ruleTitles(welcome: ApWelcome | null): string[] {
  return welcome ? welcome.rules.map((r) => r.title) : [];
}
