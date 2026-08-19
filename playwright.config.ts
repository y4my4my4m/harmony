import { defineConfig, devices } from '@playwright/test'
import { config } from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// e2e/stack.env is written by e2e/stack.sh; absent unless that stack is up.
// dotenv keeps the first value bound to a name, so it wins over .env.test.
config({ path: path.resolve(__dirname, 'e2e/stack.env') })
config({ path: path.resolve(__dirname, '.env.test') })

const browserChannel = process.env.PW_BUNDLED ? {} : { channel: 'chrome' as const }

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10000,
  },
  // System Chrome everywhere, CI included: the bundled per-revision build is a 167 MiB
  // download that `playwright install` garbage-collects across projects sharing the cache.
  // PW_BUNDLED=1 selects the bundled chromium.
  projects: [
    {
      name: 'auth-tests',
      testMatch: 'auth.spec.ts',
      use: { ...devices['Desktop Chrome'], ...browserChannel },
    },
    {
      name: 'chromium',
      testIgnore: ['auth.spec.ts', 'navigation.spec.ts'],
      dependencies: ['auth-tests'],
      use: { ...devices['Desktop Chrome'], ...browserChannel },
    },
    {
      name: 'navigation',
      testMatch: 'navigation.spec.ts',
      use: { ...devices['Desktop Chrome'], ...browserChannel },
    },
    // Journey specs run against the ephemeral stack from e2e/stack.sh. No auth-tests
    // dependency: each spec creates and deletes its actors through GoTrue's admin API
    // rather than sharing a storageState.
    {
      name: 'journeys',
      testDir: './e2e/specs',
      use: { ...devices['Desktop Chrome'], ...browserChannel },
    },
    // {
    //   name: 'firefox',
    //   testIgnore: 'auth.spec.ts',
    //   dependencies: ['auth-tests'],
    //   use: { ...devices['Desktop Firefox'] },
    // },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
