// The federation backend for specs that need its routes (channel webhooks, account
// migration, LiveKit tokens). e2e/backend-server.ts runs as a child process against the
// stack in e2e/stack.env; a page reaches it through route(), which forwards the page's
// /api/federation/<path> requests to the backend's /<path>, as nginx proxies them, and
// /api/livekit/* when started with LiveKit keys.
//
// The dev server proxies /api/federation to localhost:3001, which is absent in CI and
// on a developer machine is whatever instance runs there; route() replaces that hop.
// The app's service worker carries those requests otherwise, out of page.route()'s
// reach: contexts that use route() set serviceWorkers: 'block'.
// Requires federation-backend/node_modules (npm ci in federation-backend).

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page, Route } from '@playwright/test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TSX = path.join(ROOT, 'federation-backend/node_modules/.bin/tsx')

/** profiles.domain of e2e accounts; local handles and actor URIs derive from it. */
export const INSTANCE_DOMAIN = 'localhost'

export interface Backend {
  url: string
  /**
   * Forwards the page's /api/federation/* requests to this backend. The page's context
   * must block service workers: page.route() does not see requests a service worker makes.
   */
  route(page: Page): Promise<void>
  stop(): Promise<void>
}

function env(name: string, fallback: string): string {
  const value = process.env[name] ?? process.env[fallback]
  if (!value) throw new Error(`${name} is not set - run: npm run e2e:up`)
  return value
}

/** `extraEnv` adds to the backend's environment, e.g. the LIVEKIT_* keys from startLiveKit(). */
export async function startBackend(extraEnv: Record<string, string> = {}): Promise<Backend> {
  if (!fs.existsSync(TSX)) throw new Error(`${TSX} missing - run npm ci in federation-backend/`)

  // winston writes logs/ and config/index.ts reads .env from the working directory.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-e2e-backend-'))
  const child: ChildProcess = spawn(TSX, [path.join(ROOT, 'e2e/backend-server.ts')], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'development',
      SUPABASE_URL: env('E2E_SUPABASE_URL', 'TEST_SUPABASE_URL'),
      SUPABASE_ANON_KEY: env('E2E_SUPABASE_ANON_KEY', 'TEST_SUPABASE_ANON_KEY'),
      SUPABASE_SERVICE_ROLE_KEY: env(
        'E2E_SUPABASE_SERVICE_ROLE_KEY',
        'TEST_SUPABASE_SERVICE_ROLE_KEY',
      ),
      INSTANCE_DOMAIN,
      // createApp() opens no Redis connection; a closed port keeps any path off a local Redis.
      REDIS_URL: 'redis://127.0.0.1:9',
      LOG_LEVEL: 'error',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`backend did not start:\n${output}`)), 60_000)
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      const match = /listening (http:\/\/127\.0\.0\.1:\d+)/.exec(output)
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`backend exited with ${code}:\n${output}`))
    })
  })

  // A backend that dies mid-spec shows up only as `socket hang up` on the page's next request:
  // its exit and last output go to the runner's log.
  let stopping = false
  child.once('exit', (code, signal) => {
    if (!stopping) console.error(`[backend] ${url} exited (code ${code}, signal ${signal}); last output:\n${output.slice(-4000)}`)
  })

  return {
    url,
    async route(page: Page) {
      const forward = async (route: Route) => {
        const target = new URL(route.request().url())
        const path = target.pathname.replace(/^\/api\/federation(?=\/)/, '')
        let response
        try {
          response = await route.fetch({ url: `${url}${path}${target.search}` })
        } catch (error) {
          // voice-moderation.spec.ts saw `socket hang up` here in CI with no exit report: whether
          // the backend was still running tells a dropped connection from a dead process.
          const state = child.exitCode === null && child.signalCode === null ? 'still running' : `exited (${child.exitCode ?? child.signalCode})`
          console.error(`[backend] ${route.request().method()} ${path} failed: ${(error as Error).message.split('\n')[0]}; backend ${state}; last output:\n${output.slice(-4000)}`)
          throw error
        }
        await route.fulfill({ response })
      }
      await page.route('**/api/federation/**', forward)
      if (extraEnv.LIVEKIT_URL) await page.route('**/api/livekit/**', forward)
    },
    async stop() {
      stopping = true
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve))
        child.kill('SIGTERM')
        await exited
      }
      fs.rmSync(cwd, { recursive: true, force: true })
    },
  }
}
