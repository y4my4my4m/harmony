/**
 * Playwright global setup.
 *
 * Creates test users via Supabase admin API, logs each in through the browser
 * to capture localStorage auth state, then saves storageState files for reuse.
 */

import { chromium, type FullConfig } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  createAdminClient,
  createE2EUser,
  seedServer,
  seedChannel,
  addUserToServer,
  getSupabaseUrl,
  getSupabaseAnonKey,
  type E2ETestUser,
} from './helpers/e2e-helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = path.resolve(__dirname, '.auth')
const SEED_DATA_PATH = path.resolve(AUTH_DIR, 'seed-data.json')

export interface SeedData {
  alice: E2ETestUser
  bob: E2ETestUser
  serverId: string
  channelId: string
}

async function loginViaAPI(
  user: E2ETestUser,
  storageStatePath: string,
  baseURL: string,
): Promise<void> {
  const browser = await chromium.launch()
  const context = await browser.newContext()
  const page = await context.newPage()

  // Navigate to app so localStorage is on the correct origin
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' })

  // Sign in via Supabase JS client injected into the page
  const supabaseUrl = getSupabaseUrl()
  const supabaseAnonKey = getSupabaseAnonKey()

  const loginResult = await page.evaluate(
    async ({ url, anonKey, email, password }) => {
      const { createClient } = await import('@supabase/supabase-js')
      const client = createClient(url, anonKey, {
        auth: { persistSession: true },
      })
      const { data, error } = await client.auth.signInWithPassword({ email, password })
      if (error) return { error: error.message }
      return { accessToken: data.session?.access_token }
    },
    {
      url: supabaseUrl,
      anonKey: supabaseAnonKey,
      email: user.email,
      password: user.password,
    },
  )

  if (loginResult.error) {
    throw new Error(`Failed to login ${user.username}: ${loginResult.error}`)
  }

  // Wait briefly for localStorage to persist
  await page.waitForTimeout(500)

  await context.storageState({ path: storageStatePath })
  await browser.close()
}

async function globalSetup(_config: FullConfig): Promise<void> {
  // Ensure .auth directory exists and is gitignored
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true })
  }

  const gitignorePath = path.resolve(AUTH_DIR, '.gitignore')
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, '*\n')
  }

  const admin = createAdminClient()
  const baseURL = process.env.BASE_URL || 'http://localhost:5173'

  console.log('[E2E Setup] Creating test users...')

  const alice = await createE2EUser(admin, { username: 'e2e_alice', displayName: 'Alice E2E' })
  const bob = await createE2EUser(admin, { username: 'e2e_bob', displayName: 'Bob E2E' })

  console.log('[E2E Setup] Seeding test data...')

  const serverId = await seedServer(admin, alice.profileId, {
    name: 'E2E Test Server',
    isPublic: true,
  })
  const channelId = await seedChannel(admin, serverId, { name: 'general' })
  await addUserToServer(admin, bob.profileId, serverId)

  console.log('[E2E Setup] Logging in users via browser...')

  await loginViaAPI(alice, path.resolve(AUTH_DIR, 'alice.json'), baseURL)
  await loginViaAPI(bob, path.resolve(AUTH_DIR, 'bob.json'), baseURL)

  // Persist seed data for tests to reference
  const seedData: SeedData = { alice, bob, serverId, channelId }
  fs.writeFileSync(SEED_DATA_PATH, JSON.stringify(seedData, null, 2))

  console.log('[E2E Setup] Done.')
}

export default globalSetup
