import { describe, it, expect, vi, afterEach } from 'vitest';

// Environment the schema requires; VAPID_SUBJECT varies per test.
const BASE_ENV = {
  NODE_ENV: 'test',
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  INSTANCE_DOMAIN: 'harmony.test',
};

async function loadConfig(vapidSubject: string | undefined) {
  vi.resetModules();
  for (const [k, v] of Object.entries(BASE_ENV)) vi.stubEnv(k, v);
  vi.stubEnv('VAPID_SUBJECT', vapidSubject);
  return (await import('../config/index.js')).default;
}

describe('VAPID_SUBJECT', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('keeps a bare address', async () => {
    expect((await loadConfig('admin@harmony.test')).VAPID_SUBJECT).toBe('admin@harmony.test');
  });

  it('strips a mailto: prefix, any case, with surrounding space', async () => {
    expect((await loadConfig('mailto:admin@harmony.test')).VAPID_SUBJECT).toBe('admin@harmony.test');
    expect((await loadConfig(' MAILTO:admin@harmony.test ')).VAPID_SUBJECT).toBe('admin@harmony.test');
  });

  it('reads a blank value as unset', async () => {
    expect((await loadConfig('')).VAPID_SUBJECT).toBeUndefined();
    expect((await loadConfig('mailto:')).VAPID_SUBJECT).toBeUndefined();
    expect((await loadConfig(undefined)).VAPID_SUBJECT).toBeUndefined();
  });

  it('still refuses a value that is no email address', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(loadConfig('https://harmony.test')).rejects.toThrow('process.exit');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
