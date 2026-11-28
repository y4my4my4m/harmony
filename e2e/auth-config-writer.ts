// The federation server's sign-in provider writer (services/authProviderConfigStart.ts) for
// journey specs, passing every 500 ms into E2E_AUTH_CONFIG_DIR, GoTrue's --config-dir in the
// stack. Prints `ready` after its first pass.
//
// Run with federation-backend's tsx, environment set by e2e/specs/authConfigWriter.ts.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = (p: string) => import(pathToFileURL(path.join(root, 'federation-backend/src', p)).href)
const { createAuthProviderConfigWriter } = await mod('services/authProviderConfigStart.ts')

const writer = createAuthProviderConfigWriter(500)
if (!writer) throw new Error('HARMONY_AUTH_CONFIG_DIR is not set')
await writer.pass()
writer.start()
// The writer's timer is unref'd for the server process; this one keeps the script alive.
const alive = setInterval(() => {}, 60_000)
console.log('ready')
process.on('SIGTERM', () => {
  clearInterval(alive)
  writer.stop()
  process.exit(0)
})
