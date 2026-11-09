import { beforeEach, describe, expect, it, vi } from 'vitest';

const update = vi.fn();
const eq = vi.fn();

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from: (table: string) => {
      expect(table).toBe('signup_mail_hosts');
      return {
        update: (values: unknown) => {
          update(values);
          return { eq: async (column: string, value: string) => { eq(column, value); return { error: null }; } };
        },
      };
    },
  }),
}));

vi.mock('../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { handleSignupMailHostJob, lookupMailHosts, normalizeMailHosts } = await import('../services/signupMailHosts.js');

function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

beforeEach(() => {
  update.mockClear();
  eq.mockClear();
});

describe('normalizeMailHosts', () => {
  it('lowercases, drops the root dot and repeats, and sorts', () => {
    expect(normalizeMailHosts([
      { exchange: 'RECV2.erinn.biz.' },
      { exchange: 'recv1.erinn.biz' },
      { exchange: 'recv1.ERINN.biz.' },
    ])).toEqual(['recv1.erinn.biz', 'recv2.erinn.biz']);
  });

  it('drops a null MX and a name without a dot', () => {
    expect(normalizeMailHosts([{ exchange: '' }, { exchange: '.' }, { exchange: 'localhost' }])).toEqual([]);
  });

  it('keeps at most ten hosts', () => {
    const records = Array.from({ length: 20 }, (_, i) => ({ exchange: `mx${String(i).padStart(2, '0')}.example.org` }));
    expect(normalizeMailHosts(records)).toHaveLength(10);
  });
});

describe('lookupMailHosts', () => {
  it('answers the hosts', async () => {
    await expect(lookupMailHosts('petchi.uk', async () => [{ exchange: 'recv-petchiuk.erinn.biz' }]))
      .resolves.toEqual(['recv-petchiuk.erinn.biz']);
  });

  it.each(['ENOTFOUND', 'ENODATA'])('%s is an answer: no mail server', async (code) => {
    await expect(lookupMailHosts('none.example', async () => { throw dnsError(code); })).resolves.toEqual([]);
  });

  it.each(['ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED'])('%s leaves the lookup owed', async (code) => {
    await expect(lookupMailHosts('down.example', async () => { throw dnsError(code); })).resolves.toBeNull();
  });
});

describe('handleSignupMailHostJob', () => {
  it('stores the hosts and clears what is owed', async () => {
    await handleSignupMailHostJob({ domain: 'Petchi.UK' }, async () => [{ exchange: 'recv-petchiuk.erinn.biz.' }]);
    expect(eq).toHaveBeenCalledWith('domain', 'petchi.uk');
    const values = update.mock.calls[0][0];
    expect(values.hosts).toEqual(['recv-petchiuk.erinn.biz']);
    expect(values.due_at).toBeNull();
    expect(Date.parse(values.checked_at)).not.toBeNaN();
  });

  it('stores no hosts for a domain without a mail server', async () => {
    await handleSignupMailHostJob({ domain: 'none.example' }, async () => { throw dnsError('ENOTFOUND'); });
    expect(update.mock.calls[0][0].hosts).toEqual([]);
    expect(update.mock.calls[0][0].due_at).toBeNull();
  });

  it('keeps the last answer and retries later when the lookup fails', async () => {
    const before = Date.now();
    await handleSignupMailHostJob({ domain: 'down.example' }, async () => { throw dnsError('ETIMEOUT'); });
    const values = update.mock.calls[0][0];
    expect(values).not.toHaveProperty('hosts');
    expect(values).not.toHaveProperty('checked_at');
    expect(Date.parse(values.due_at)).toBeGreaterThan(before);
  });

  it('looks up nothing for a name that is not a domain', async () => {
    const resolve = vi.fn();
    await handleSignupMailHostJob({ domain: 'not a domain' }, resolve);
    expect(resolve).not.toHaveBeenCalled();
    expect(update.mock.calls[0][0].hosts).toEqual([]);
    expect(update.mock.calls[0][0].due_at).toBeNull();
  });
});
