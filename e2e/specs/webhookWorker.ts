// e2e/outgoing-webhook-worker.ts as a child process against the stack in e2e/stack.env, with
// deliveries to http://localhost allowed (OUTGOING_WEBHOOKS_ALLOW_LOOPBACK).
// Requires federation-backend/node_modules (npm ci in federation-backend).

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TSX = path.join(ROOT, 'federation-backend/node_modules/.bin/tsx')

function env(name: string, fallback: string): string {
  const value = process.env[name] ?? process.env[fallback]
  if (!value) throw new Error(`${name} is not set - run: npm run e2e:up`)
  return value
}

export interface WebhookWorker {
  stop(): Promise<void>
}

export async function startWebhookWorker(): Promise<WebhookWorker> {
  if (!fs.existsSync(TSX)) throw new Error(`${TSX} missing - run npm ci in federation-backend/`)
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-e2e-webhooks-'))
  const child: ChildProcess = spawn(TSX, [path.join(ROOT, 'e2e/outgoing-webhook-worker.ts')], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'development',
      SUPABASE_URL: env('E2E_SUPABASE_URL', 'TEST_SUPABASE_URL'),
      SUPABASE_ANON_KEY: env('E2E_SUPABASE_ANON_KEY', 'TEST_SUPABASE_ANON_KEY'),
      SUPABASE_SERVICE_ROLE_KEY: env('E2E_SUPABASE_SERVICE_ROLE_KEY', 'TEST_SUPABASE_SERVICE_ROLE_KEY'),
      INSTANCE_DOMAIN: 'localhost',
      REDIS_URL: 'redis://127.0.0.1:9',
      OUTGOING_WEBHOOKS_ALLOW_LOOPBACK: 'true',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`webhook worker did not start:\n${output}`)), 60_000)
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      if (/^ready$/m.test(output)) {
        clearTimeout(timer)
        resolve()
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`webhook worker exited with ${code}:\n${output}`))
    })
  })
  return {
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
