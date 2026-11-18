/**
 * Sign-in provider credentials from Admin, Authentication, rendered into GoTrue's --config-dir.
 *
 * auth_provider_credentials_render() (20261117800001) becomes
 * HARMONY_AUTH_CONFIG_DIR/50-harmony-oauth.env, one KEY='value' line each of
 *   GOTRUE_EXTERNAL_<PROVIDER>_ENABLED, _CLIENT_ID, _SECRET, _REDIRECT_URI
 * GoTrue's reloader overlays every *.env of the directory on its environment 5 s after a change
 * (*.json too from 2.190.0; .env is read by every release with --config-dir) and never unsets a
 * key, so a provider turned off is written ENABLED=false. Single quotes keep a value literal in
 * godotenv; values are limited to [A-Za-z0-9._~+/=-], so none holds a quote, a newline or a $.
 *
 * The file is 0600. GoTrue's image runs as uid 1000, the uid of this image's node user.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const AUTH_CONFIG_FILE = '50-harmony-oauth.env';
export const BUILT_IN_PROVIDERS = ['google', 'twitch', 'github', 'discord'] as const;
export type BuiltInProvider = (typeof BUILT_IN_PROVIDERS)[number];

/** auth_provider_valid_value() of the migration. */
const VALUE = /^[A-Za-z0-9][A-Za-z0-9._~+/=-]{0,511}$/;

export interface ProviderRow {
  provider: string;
  client_id: string | null;
  client_secret: string | null;
  enabled: boolean;
}

export interface RenderedConfig {
  config: Record<string, string>;
  /** Providers the database turned on whose values failed the check here; written off. */
  refused: string[];
}

export function isBuiltInProvider(value: string): value is BuiltInProvider {
  return (BUILT_IN_PROVIDERS as readonly string[]).includes(value);
}

/** GoTrue's callback on the public API URL: BASE/auth/v1/callback. null when BASE is not http(s). */
export function redirectUriFor(base: string | undefined | null): string | null {
  if (!base) return null;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}/auth/v1/callback`;
}

export function renderAuthConfig(rows: ProviderRow[], redirectUri: string | null): RenderedConfig {
  const config: Record<string, string> = {};
  const refused: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isBuiltInProvider(row.provider) || seen.has(row.provider)) continue;
    seen.add(row.provider);
    const prefix = `GOTRUE_EXTERNAL_${row.provider.toUpperCase()}_`;
    const valid = typeof row.client_id === 'string' && VALUE.test(row.client_id)
      && typeof row.client_secret === 'string' && VALUE.test(row.client_secret)
      && redirectUri !== null;
    if (row.enabled && !valid) refused.push(row.provider);
    if (!row.enabled || !valid) {
      config[`${prefix}ENABLED`] = 'false';
      continue;
    }
    config[`${prefix}ENABLED`] = 'true';
    config[`${prefix}CLIENT_ID`] = row.client_id as string;
    config[`${prefix}SECRET`] = row.client_secret as string;
    config[`${prefix}REDIRECT_URI`] = redirectUri as string;
  }
  return { config, refused };
}

/** The file's text: a header, then KEY='value' per line in CONFIG's order. */
export function formatAuthConfig(config: Record<string, string>): string {
  const lines = ['# Written by the Harmony federation server from Admin, Authentication. Edits are overwritten.'];
  for (const [key, value] of Object.entries(config)) {
    if (!/^[A-Z0-9_]+$/.test(key) || !(value === 'true' || value === 'false' || VALUE.test(value) || isRedirect(value))) {
      throw new Error(`refusing to write ${key}`);
    }
    lines.push(`${key}='${value}'`);
  }
  return `${lines.join('\n')}\n`;
}

/** redirectUriFor's output: an http(s) URL without quotes, spaces, # or $. */
function isRedirect(value: string): boolean {
  return /^https?:\/\/[A-Za-z0-9.:[\]_~+/%-]+$/.test(value);
}

/** Replaces DIR/AUTH_CONFIG_FILE with CONTENT through a rename. false when it already held it. */
export async function writeAuthConfig(dir: string, content: string): Promise<boolean> {
  const target = path.join(dir, AUTH_CONFIG_FILE);
  try {
    if ((await fs.readFile(target, 'utf8')) === content) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Dot-prefixed with a .tmp extension: GoTrue reads only *.env and *.json.
  const temp = path.join(dir, `.${AUTH_CONFIG_FILE}.${process.pid}.tmp`);
  const handle = await fs.open(temp, 'w', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.chmod(temp, 0o600);
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
  return true;
}

/** An error's text for the status row: the errno code or message, never a value. */
function describe(error: unknown, dir: string): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') return `${dir} does not exist`;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return `${dir} is not writable (${code})`;
  if (code) return `writing ${dir} failed (${code})`;
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

export interface WriterDeps {
  dir: string;
  redirectUri: string | null;
  render(): Promise<ProviderRow[]>;
  report(applied: boolean, error: string | null): Promise<void>;
  log: { info(message: string): void; warn(message: string): void };
  intervalMs?: number;
  /** A pass reports at least this often while nothing changes, ms. */
  heartbeatMs?: number;
  now?: () => number;
}

export class AuthProviderConfigWriter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private lastError: string | null = null;
  private lastReport = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: WriterDeps) {}

  start(): void {
    if (this.timer) return;
    void this.pass();
    this.timer = setInterval(() => void this.pass(), this.deps.intervalMs ?? 10_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One read, render, write and report. Overlapping calls share the running pass. */
  pass(): Promise<void> {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async run(): Promise<void> {
    const now = this.deps.now ?? Date.now;
    let applied = false;
    let error: string | null = null;
    try {
      const { config, refused } = renderAuthConfig(await this.deps.render(), this.deps.redirectUri);
      if (refused.length > 0) {
        error = this.deps.redirectUri === null
          ? 'PUBLIC_SUPABASE_URL is not an http(s) URL: no redirect URI for the providers'
          : `values of ${refused.join(', ')} were refused`;
      }
      applied = await writeAuthConfig(this.deps.dir, formatAuthConfig(config));
      if (applied) this.deps.log.info(`Sign-in provider settings written to ${path.join(this.deps.dir, AUTH_CONFIG_FILE)}`);
    } catch (caught) {
      error = describe(caught, this.deps.dir);
    }
    if (error !== this.lastError && error) this.deps.log.warn(`Sign-in provider settings: ${error}`);
    const due = now() - this.lastReport >= (this.deps.heartbeatMs ?? 60_000);
    if (!applied && error === this.lastError && !due) return;
    this.lastError = error;
    try {
      await this.deps.report(applied, error);
      this.lastReport = now();
    } catch (caught) {
      this.deps.log.warn(`Sign-in provider settings: status report failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }
}
