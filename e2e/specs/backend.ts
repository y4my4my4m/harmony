// The federation backend for specs that need its routes (channel webhooks, account
// migration). e2e/backend-server.ts runs as a child process against the stack in
// e2e/stack.env; a page reaches it through route(), which forwards the page's
// /api/federation/* requests to it.
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
import type { Page } from '@playwright/test'

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

export async function startBackend(): Promise<Backend> {
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

  return {
    url,
    async route(page: Page) {
      await page.route('**/api/federation/**', async (route) => {
        const target = new URL(route.request().url())
        const response = await route.fetch({ url: `${url}${target.pathname}${target.search}` })
        await route.fulfill({ response })
      })
    },
    async stop() {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve))
        child.kill('SIGTERM')
        await exited
      }
      fs.rmSync(cwd, { recursive: true, force: true })
    },
  }
}
