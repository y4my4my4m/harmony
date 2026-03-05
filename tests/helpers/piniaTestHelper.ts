import { createPinia, setActivePinia, type Pinia } from 'pinia'

/**
 * Create and activate a fresh Pinia instance for testing.
 * Call in beforeEach() to isolate store state between tests.
 */
export function setupTestPinia(initialState: Record<string, any> = {}): Pinia {
  const pinia = createPinia()
  pinia.state.value = initialState
  setActivePinia(pinia)
  return pinia
}
