// The federation backend's HTTP app (createApp() from federation-backend/src/server.ts)
// for journey specs, on 127.0.0.1 at a free port. Prints `listening <url>` once bound.
//
// Run with federation-backend's tsx, environment set by e2e/specs/backend.ts. No worker,
// Redis or realtime: queued jobs stay in the database.

import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server: {
  createApp: () => { listen: (port: number, host: string, cb: () => void) => Server }
  attachActivityRelay: (server: Server, app: unknown) => unknown
} = await import(pathToFileURL(path.join(root, 'federation-backend/src/server.ts')).href)

const app = server.createApp()
const http = app.listen(0, '127.0.0.1', () => {
  const { port } = http.address() as AddressInfo
  console.log(`listening http://127.0.0.1:${port}`)
})

server.attachActivityRelay(http, app)

process.on('SIGTERM', () => http.close(() => process.exit(0)))
