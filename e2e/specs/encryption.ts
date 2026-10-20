// End-to-end encryption set up in a journey's page, as the setup wizard does it.

import type { Page } from '@playwright/test'
import type { SpecUser } from './harness'

/**
 * Sets up end-to-end encryption for the signed-in user through the Megolm service module the
 * app loaded (by the URL Vite served it under).
 */
export async function setUpEncryption(page: Page, user: SpecUser): Promise<void> {
  await page.evaluate(async (authUserId) => {
    const served = performance.getEntriesByType('resource').map((e) => e.name)
      .find((name) => name.includes('/src/services/encryption/MegolmMessageEncryptionService.ts'))
    const url = served ?? '/src/services/encryption/MegolmMessageEncryptionService.ts'
    const service = (await import(/* @vite-ignore */ url)).megolmMessageEncryptionService as any
    if (!service.isInitialized()) await service.initialize(authUserId)
    await service.setupNewEncryption()
    if (!service.isUnlocked()) throw new Error('encryption setup left the keys locked')
  }, user.id)
}
