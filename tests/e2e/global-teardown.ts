/**
 * Playwright global teardown.
 *
 * Cleans up all test users and seeded data created by global-setup.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createAdminClient, cleanupE2EUsers, cleanupUserByEmail } from './helpers/e2e-helpers'
import type { SeedData } from './global-setup'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = path.resolve(__dirname, '.auth')
const SEED_DATA_PATH = path.resolve(AUTH_DIR, 'seed-data.json')

const AUTH_TEST_USER_PATH = path.resolve(AUTH_DIR, 'auth-test-user.json')

async function globalTeardown(): Promise<void> {
  console.log('[E2E Teardown] Cleaning up test data...')

  const admin = createAdminClient()

  // Clean up the UI-registered user from auth.spec.ts
  if (fs.existsSync(AUTH_TEST_USER_PATH)) {
    try {
      const { email } = JSON.parse(fs.readFileSync(AUTH_TEST_USER_PATH, 'utf-8'))
      if (email) {
        console.log(`[E2E Teardown] Cleaning up auth test user: ${email}`)
        await cleanupUserByEmail(admin, email)
      }
    } catch (error) {
      console.error('[E2E Teardown] Error cleaning up auth test user:', error)
    }
  }

  // Clean up API-seeded users from global-setup
  if (fs.existsSync(SEED_DATA_PATH)) {
    try {
      const seedData: SeedData = JSON.parse(fs.readFileSync(SEED_DATA_PATH, 'utf-8'))

      if (seedData.serverId) {
        try {
          await admin.from('servers').delete().eq('id', seedData.serverId)
        } catch {
          // Server may already be deleted
        }
      }

      await cleanupE2EUsers(admin, [seedData.alice, seedData.bob])
    } catch (error) {
      console.error('[E2E Teardown] Error cleaning up seed data:', error)
    }
  }

  console.log('[E2E Teardown] Done.')
}

export default globalTeardown
