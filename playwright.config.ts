import { defineConfig, devices } from '@playwright/test'
import { config } from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// e2e/stack.env is written by e2e/stack.sh and absent unless that stack is up.
// dotenv never overwrites a name already set, so loading it first points a run
// at the ephemeral stack whenever one exists and falls back to .env.test
// otherwise.
config({ path: path.resolve(__dirname, 'e2e/stack.env') })
config({ path: path.resolve(__dirname, '.env.test') })

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
  projects: [
    {
      name: 'auth-tests',
      testMatch: 'auth.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      testIgnore: ['auth.spec.ts', 'navigation.spec.ts'],
      dependencies: ['auth-tests'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'navigation',
      testMatch: 'navigation.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    // Journey specs against the ephemeral stack from e2e/stack.sh. Their own testDir,
    // outside the one above, and no dependency on auth-tests: each spec creates and
    // deletes its actors through GoTrue's admin API rather than sharing a storageState.
    {
      name: 'journeys',
      testDir: './e2e/specs',
      use: { ...devices['Desktop Chrome'] },
    },
    // Opt-in: npx playwright test --project=firefox
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
