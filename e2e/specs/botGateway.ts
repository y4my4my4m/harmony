// The bot gateway (bot-gateway/src/index.ts) as a child process against the stack in
// e2e/stack.env, for specs that drive bots over its WebSocket and read its REST routes.
// Requires bot-gateway/node_modules (npm ci in bot-gateway).

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TSX = path.join(ROOT, 'bot-gateway/node_modules/.bin/tsx')

export interface BotGateway {
  /** http://127.0.0.1:<port> */
  url: string
  /** ws://127.0.0.1:<port>/gateway */
  wsUrl: string
  stop(): Promise<void>
}

function env(name: string, fallback: string): string {
  const value = process.env[name] ?? process.env[fallback]
  if (!value) throw new Error(`${name} is not set - run: npm run e2e:up`)
  return value
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

export async function startBotGateway(): Promise<BotGateway> {
  if (!fs.existsSync(TSX)) throw new Error(`${TSX} missing - run npm ci in bot-gateway/`)

  const port = await freePort()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-e2e-botgw-'))
  const child: ChildProcess = spawn(TSX, [path.join(ROOT, 'bot-gateway/src/index.ts')], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'development',
      PORT: String(port),
      SUPABASE_URL: env('E2E_SUPABASE_URL', 'TEST_SUPABASE_URL'),
      SUPABASE_ANON_KEY: env('E2E_SUPABASE_ANON_KEY', 'TEST_SUPABASE_ANON_KEY'),
      SUPABASE_SERVICE_ROLE_KEY: env('E2E_SUPABASE_SERVICE_ROLE_KEY', 'TEST_SUPABASE_SERVICE_ROLE_KEY'),
      INSTANCE_DOMAIN: 'localhost',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })

  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 60_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`bot gateway exited with ${child.exitCode}:\n${output}`)
    const ok = await fetch(`${url}/health`).then((r) => r.ok, () => false)
    if (ok) break
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error(`bot gateway did not start:\n${output}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  return {
    url,
    wsUrl: `ws://127.0.0.1:${port}/gateway`,
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
