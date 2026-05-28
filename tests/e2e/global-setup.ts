/**
 * Playwright global setup.
 *
 * Creates test users via Supabase admin API, logs each in through the browser
 * to capture localStorage auth state, then saves storageState files for reuse.
 */

import { chromium, type FullConfig } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
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

async function loginAndSaveState(
  user: E2ETestUser,
  storageStatePath: string,
  baseURL: string,
): Promise<void> {
  const supabaseUrl = getSupabaseUrl()
  const supabaseAnonKey = getSupabaseAnonKey()

  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data, error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  })

  if (error || !data.session) {
    throw new Error(`Failed to login ${user.username}: ${error?.message ?? 'no session'}`)
  }

  // Supabase stores auth under sb-<hostname>-auth-token
  const hostname = new URL(supabaseUrl).hostname
  const storageKey = `sb-${hostname}-auth-token`
  const storageValue = JSON.stringify(data.session)

  const browser = await chromium.launch()
  const context = await browser.newContext()
  const page = await context.newPage()

  await page.goto(baseURL, { waitUntil: 'domcontentloaded' })

  await page.evaluate(
    ({ key, value }) => {
      localStorage.setItem(key, value)
    },
    { key: storageKey, value: storageValue },
  )

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

  // The server INSERT trigger auto-creates a default "general" channel - use it
  const { data: defaultChannel } = await admin
    .from('channels')
    .select('id')
    .eq('server_id', serverId)
    .eq('name', 'general')
    .single()

  const channelId = defaultChannel?.id ?? await seedChannel(admin, serverId, { name: 'e2e-general' })
  await addUserToServer(admin, bob.profileId, serverId)

  console.log('[E2E Setup] Logging in users via browser...')

  await loginAndSaveState(alice, path.resolve(AUTH_DIR, 'alice.json'), baseURL)
  await loginAndSaveState(bob, path.resolve(AUTH_DIR, 'bob.json'), baseURL)

  // Persist seed data for tests to reference
  const seedData: SeedData = { alice, bob, serverId, channelId }
  fs.writeFileSync(SEED_DATA_PATH, JSON.stringify(seedData, null, 2))

  console.log('[E2E Setup] Done.')
}

export default globalSetup
