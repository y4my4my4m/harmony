/**
 * Playwright global teardown.
 *
 * Cleans up all test users and seeded data created by global-setup.
 */

import * as fs from 'fs'
import * as path from 'path'
import { createAdminClient, cleanupE2EUsers } from './helpers/e2e-helpers'
import type { SeedData } from './global-setup'

const AUTH_DIR = path.resolve(__dirname, '.auth')
const SEED_DATA_PATH = path.resolve(AUTH_DIR, 'seed-data.json')

async function globalTeardown(): Promise<void> {
  console.log('[E2E Teardown] Cleaning up test data...')

  if (!fs.existsSync(SEED_DATA_PATH)) {
    console.log('[E2E Teardown] No seed data found, skipping.')
    return
  }

  try {
    const seedData: SeedData = JSON.parse(fs.readFileSync(SEED_DATA_PATH, 'utf-8'))
    const admin = createAdminClient()

    // Clean up the seeded server (cascades to channels, messages, etc.)
    if (seedData.serverId) {
      await admin.from('servers').delete().eq('id', seedData.serverId).catch(() => {})
    }

    // Clean up users
    await cleanupE2EUsers(admin, [seedData.alice, seedData.bob])

    console.log('[E2E Teardown] Done.')
  } catch (error) {
    console.error('[E2E Teardown] Error during cleanup:', error)
  }
}

export default globalTeardown
