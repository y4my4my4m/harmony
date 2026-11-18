import { mkdtemp, readFile, readdir, rm, stat, chmod, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_CONFIG_FILE,
  AuthProviderConfigWriter,
  formatAuthConfig,
  redirectUriFor,
  renderAuthConfig,
  writeAuthConfig,
  type ProviderRow,
} from '../services/AuthProviderConfigWriter.js';

const REDIRECT = 'https://db.example.com/auth/v1/callback';
const discord: ProviderRow = { provider: 'discord', client_id: '123456789012345678', client_secret: 'Secret_one-123', enabled: true };

describe('redirectUriFor', () => {
  it('appends GoTrue callback to the public API URL', () => {
    expect(redirectUriFor('https://db.example.com')).toBe(REDIRECT);
    expect(redirectUriFor('https://db.example.com/')).toBe(REDIRECT);
    expect(redirectUriFor('http://localhost:54480')).toBe('http://localhost:54480/auth/v1/callback');
  });

  it('refuses what is not a plain http(s) URL', () => {
    expect(redirectUriFor(undefined)).toBeNull();
    expect(redirectUriFor('ftp://db.example.com')).toBeNull();
    expect(redirectUriFor('https://user:pw@db.example.com')).toBeNull();
    expect(redirectUriFor('https://db.example.com/?x=1')).toBeNull();
    expect(redirectUriFor('not a url')).toBeNull();
  });
});

describe('renderAuthConfig', () => {
  it('writes the four keys of a provider that is on', () => {
    expect(renderAuthConfig([discord], REDIRECT)).toEqual({
      config: {
        GOTRUE_EXTERNAL_DISCORD_ENABLED: 'true',
        GOTRUE_EXTERNAL_DISCORD_CLIENT_ID: '123456789012345678',
        GOTRUE_EXTERNAL_DISCORD_SECRET: 'Secret_one-123',
        GOTRUE_EXTERNAL_DISCORD_REDIRECT_URI: REDIRECT,
      },
      refused: [],
    });
  });

  it('writes ENABLED=false alone for a provider that is off or cleared', () => {
    const rows: ProviderRow[] = [
      { ...discord, enabled: false },
      { provider: 'google', client_id: null, client_secret: null, enabled: false },
    ];
    expect(renderAuthConfig(rows, REDIRECT)).toEqual({
      config: { GOTRUE_EXTERNAL_DISCORD_ENABLED: 'false', GOTRUE_EXTERNAL_GOOGLE_ENABLED: 'false' },
      refused: [],
    });
  });

  it('turns off a provider whose values could open another key', () => {
    for (const bad of ['abc\nGOTRUE_JWT_SECRET=x', 'a b', '"quoted"', '#hash', 'a$b', '', 'a,b']) {
      const { config, refused } = renderAuthConfig([{ ...discord, client_secret: bad }], REDIRECT);
      expect(config).toEqual({ GOTRUE_EXTERNAL_DISCORD_ENABLED: 'false' });
      expect(refused).toEqual(['discord']);
      const { config: byId } = renderAuthConfig([{ ...discord, client_id: bad }], REDIRECT);
      expect(byId).toEqual({ GOTRUE_EXTERNAL_DISCORD_ENABLED: 'false' });
    }
  });

  it('turns every provider off without a redirect URI', () => {
    expect(renderAuthConfig([discord], null)).toEqual({ config: { GOTRUE_EXTERNAL_DISCORD_ENABLED: 'false' }, refused: ['discord'] });
  });

  it('skips unknown providers and repeats', () => {
    const rows = [{ ...discord, provider: 'apple' }, discord, { ...discord, client_id: '999999999999999999' }];
    expect(Object.keys(renderAuthConfig(rows, REDIRECT).config)).toEqual([
      'GOTRUE_EXTERNAL_DISCORD_ENABLED', 'GOTRUE_EXTERNAL_DISCORD_CLIENT_ID',
      'GOTRUE_EXTERNAL_DISCORD_SECRET', 'GOTRUE_EXTERNAL_DISCORD_REDIRECT_URI',
    ]);
    expect(renderAuthConfig(rows, REDIRECT).config.GOTRUE_EXTERNAL_DISCORD_CLIENT_ID).toBe('123456789012345678');
  });
});

/** godotenv's reading of a single-quoted line: the text between the quotes, as is. */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)='([^']*)'$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

describe('formatAuthConfig', () => {
  it('writes one single-quoted line per key after a comment', () => {
    const text = formatAuthConfig(renderAuthConfig([discord], REDIRECT).config);
    const lines = text.trimEnd().split('\n');
    expect(lines[0].startsWith('# ')).toBe(true);
    expect(lines.slice(1)).toEqual([
      "GOTRUE_EXTERNAL_DISCORD_ENABLED='true'",
      "GOTRUE_EXTERNAL_DISCORD_CLIENT_ID='123456789012345678'",
      "GOTRUE_EXTERNAL_DISCORD_SECRET='Secret_one-123'",
      `GOTRUE_EXTERNAL_DISCORD_REDIRECT_URI='${REDIRECT}'`,
    ]);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('refuses a value or key that could end the line or the quotes', () => {
    for (const value of ["a'b", 'a\nB=c', 'a b', 'a$b', 'a#b']) {
      expect(() => formatAuthConfig({ GOTRUE_EXTERNAL_DISCORD_SECRET: value })).toThrow();
    }
    expect(() => formatAuthConfig({ 'GOTRUE_X\nY': 'v' })).toThrow();
  });
});

describe('writeAuthConfig', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'hm-authcfg-')); });
  afterEach(async () => {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the file 0600 through a rename and leaves no temporary file', async () => {
    expect(await writeAuthConfig(dir, "A='b'\n")).toBe(true);
    expect(await readFile(path.join(dir, AUTH_CONFIG_FILE), 'utf8')).toBe("A='b'\n");
    expect((await stat(path.join(dir, AUTH_CONFIG_FILE))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual([AUTH_CONFIG_FILE]);
  });

  it('leaves an identical file alone', async () => {
    await writeAuthConfig(dir, '# x\n');
    const before = (await stat(path.join(dir, AUTH_CONFIG_FILE))).mtimeMs;
    expect(await writeAuthConfig(dir, '# x\n')).toBe(false);
    expect((await stat(path.join(dir, AUTH_CONFIG_FILE))).mtimeMs).toBe(before);
  });

  it('replaces a different file', async () => {
    await writeFile(path.join(dir, AUTH_CONFIG_FILE), 'old');
    expect(await writeAuthConfig(dir, 'new')).toBe(true);
    expect(await readFile(path.join(dir, AUTH_CONFIG_FILE), 'utf8')).toBe('new');
  });
});

describe('AuthProviderConfigWriter', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'hm-authcfg-')); });
  afterEach(async () => {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  function writer(rows: () => ProviderRow[], overrides: Partial<ConstructorParameters<typeof AuthProviderConfigWriter>[0]> = {}) {
    const report = vi.fn(async () => {});
    const log = { info: vi.fn(), warn: vi.fn() };
    let clock = 0;
    const w = new AuthProviderConfigWriter({
      dir, redirectUri: REDIRECT, render: async () => rows(), report, log, now: () => clock, ...overrides,
    });
    return { w, report, log, tick: (ms: number) => { clock += ms; } };
  }

  it('renders, writes and reports the change', async () => {
    const { w, report } = writer(() => [discord]);
    await w.pass();
    const written = parseEnv(await readFile(path.join(dir, AUTH_CONFIG_FILE), 'utf8'));
    expect(written.GOTRUE_EXTERNAL_DISCORD_CLIENT_ID).toBe('123456789012345678');
    expect(report).toHaveBeenCalledWith(true, null);
  });

  it('reports an unchanged file only once a minute', async () => {
    const { w, report, tick } = writer(() => [discord]);
    await w.pass();
    tick(10_000);
    await w.pass();
    expect(report).toHaveBeenCalledTimes(1);
    tick(60_000);
    await w.pass();
    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith(false, null);
  });

  it('reports a directory it cannot write, without values', async () => {
    const { w, report } = writer(() => [discord], { dir: path.join(dir, 'absent') });
    await w.pass();
    expect(report).toHaveBeenCalledWith(false, `${path.join(dir, 'absent')} does not exist`);
  });

  it('reports a read failure', async () => {
    const { w, report } = writer(() => { throw new Error('auth_provider_credentials_render: boom'); });
    await w.pass();
    expect(report).toHaveBeenCalledWith(false, 'auth_provider_credentials_render: boom');
  });

  it('names refused providers and keeps their secret out of the report', async () => {
    const { w, report } = writer(() => [{ ...discord, client_secret: 'bad\nvalue' }]);
    await w.pass();
    expect(report).toHaveBeenCalledWith(true, 'values of discord were refused');
    expect(JSON.stringify(report.mock.calls)).not.toContain('bad');
  });

  it('shares one pass between overlapping calls', async () => {
    let calls = 0;
    const { w } = writer(() => { calls += 1; return [discord]; });
    await Promise.all([w.pass(), w.pass()]);
    expect(calls).toBe(1);
  });
});
