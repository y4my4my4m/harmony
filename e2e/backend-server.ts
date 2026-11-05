// The federation backend's HTTP app (createApp() from federation-backend/src/server.ts)
// for journey specs, on 127.0.0.1 at a free port. Prints `listening <url>` once bound.
//
// Run with federation-backend's tsx, environment set by e2e/specs/backend.ts. No worker,
// Redis or realtime: queued jobs stay in the database.
//
// E2E_PROJECT_INSTANCE=true makes this backend the Harmony project's instance and
// E2E_PROJECT_FEED_URL is the project fund feed it reads (services/projectFunding.ts
// setTestProject). Only this launcher reads them; the backend's own entry point does not, and
// setTestProject refuses NODE_ENV=production. Both are set before server.ts loads: the default
// funding router builds its feed cache at import.

import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const backend = (file: string) => pathToFileURL(path.join(root, 'federation-backend/src', file)).href

const projectInstance = process.env.E2E_PROJECT_INSTANCE === 'true'
const feedUrl = process.env.E2E_PROJECT_FEED_URL || undefined
if (projectInstance || feedUrl) {
  const funding: {
    setTestProject: (project: { projectInstance: boolean; feedUrl?: string }) => void
  } = await import(backend('services/projectFunding.ts'))
  funding.setTestProject({ projectInstance, feedUrl })
}

const server: {
  createApp: () => { listen: (port: number, host: string, cb: () => void) => Server }
} = await import(backend('server.ts'))

const http = server.createApp().listen(0, '127.0.0.1', () => {
  const { port } = http.address() as AddressInfo
  console.log(`listening http://127.0.0.1:${port}`)
})

process.on('SIGTERM', () => http.close(() => process.exit(0)))
