import { describe, it, expect, vi, afterEach } from 'vitest';

// Which instance is the Harmony project's, read through the real configuration: no environment
// variable makes a self-hosted production backend the project's instance or moves its feed.

const BASE_ENV = {
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
};

// PROJECT_INSTANCE and PROJECT_FUNDING_URL, which the configuration does not read, and the
// journeys' variables, which only e2e/backend-server.ts reads.
const CLAIMS = {
  PROJECT_INSTANCE: 'true',
  PROJECT_FUNDING_URL: 'https://self.example/api/federation/funding/project-feed',
  E2E_PROJECT_INSTANCE: 'true',
  E2E_PROJECT_FEED_URL: 'https://self.example/api/federation/funding/project-feed',
};

async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...env })) vi.stubEnv(k, v);
  const config = (await import('../config/index.js')).default;
  const funding = await import('../services/projectFunding.js');
  return { config, funding };
}

describe('the project instance under NODE_ENV=production', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a self-hosted instance stays one whatever its environment claims', async () => {
    const { config, funding } = await load({ NODE_ENV: 'production', INSTANCE_DOMAIN: 'self.example', ...CLAIMS });
    expect(config).not.toHaveProperty('PROJECT_INSTANCE');
    expect(config).not.toHaveProperty('PROJECT_FUNDING_URL');
    expect(funding.isProjectInstance()).toBe(false);
    expect(funding.projectFeedUrl()).toBe('https://har.mony.lol/api/federation/funding/project-feed');
    expect(() => funding.setTestProject({ projectInstance: true, feedUrl: CLAIMS.E2E_PROJECT_FEED_URL })).toThrow(/production/);
    expect(funding.isProjectInstance()).toBe(false);
    expect(funding.projectFeedUrl()).toBe('https://har.mony.lol/api/federation/funding/project-feed');
  });

  it('har.mony.lol is the project instance whatever its environment says', async () => {
    const { funding } = await load({ NODE_ENV: 'production', INSTANCE_DOMAIN: 'har.mony.lol', PROJECT_INSTANCE: 'false' });
    expect(funding.isProjectInstance()).toBe(true);
  });

  it('with no NODE_ENV the schema default, development, still reads no project setting', async () => {
    const { config, funding } = await load({ NODE_ENV: undefined, INSTANCE_DOMAIN: 'self.example', ...CLAIMS });
    expect(config.NODE_ENV).toBe('development');
    expect(funding.isProjectInstance()).toBe(false);
    expect(funding.projectFeedUrl()).toBe('https://har.mony.lol/api/federation/funding/project-feed');
  });
});
