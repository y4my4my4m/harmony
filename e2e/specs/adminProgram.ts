// Runs node programs of self-host/admin.sh as run_node and fed_node do (PARAMS_B64, NODE_LIB, the
// programs, on node --input-type=module), from the host against the stack, with its service key.
// Requests to E2E_IDP_HOST go through a CONNECT proxy to 127.0.0.1 and trust the stack's IdP CA,
// as federation-server reaches the issuer on a self-host.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ADMIN = fs.readFileSync(path.join(ROOT, 'self-host/admin.sh'), 'utf8')
const IDP_CA = path.join(ROOT, 'e2e/idp/ca.pem')

/** The body of a single-quoted NAME='...' program in admin.sh. */
function program(name: string): string {
  const m = new RegExp(`^${name}='\\n([\\s\\S]*?)\\n'$`, 'm').exec(ADMIN)
  if (!m) throw new Error(`${name} is not in admin.sh`)
  return m[1]
}

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set - run: npm run e2e:up`)
  return value
}

/** A CONNECT proxy that sends HOST:any-port to 127.0.0.1 and refuses other targets. */
async function proxyFor(host: string): Promise<{ url: string; close(): Promise<void> }> {
  const proxy = http.createServer()
  proxy.on('connect', (req, socket, head) => {
    const [target, port] = (req.url ?? '').split(':')
    if (target !== host) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const upstream = net.connect(Number(port), '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`,
    async close() {
      proxy.closeAllConnections()
      await new Promise((resolve) => proxy.close(resolve))
    },
  }
}

/** Runs NODE_LIB and the named programs with PARAMS; resolves to the program's JSON line. */
export async function runAdminProgram(names: string[], params: Record<string, string>): Promise<Record<string, any>> {
  const b64 = (s: string) => Buffer.from(s).toString('base64')
  const json = JSON.stringify(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, b64(v)])))
  const source = [`const PARAMS_B64 = "${b64(json)}";`, program('NODE_LIB'), ...names.map(program)].join('\n')
  const proxy = await proxyFor(process.env.E2E_IDP_HOST || 'idp.e2e.test')
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-'], {
        env: {
          PATH: process.env.PATH,
          SUPABASE_URL: env('E2E_SUPABASE_URL'),
          SUPABASE_SERVICE_ROLE_KEY: env('E2E_SUPABASE_SERVICE_ROLE_KEY'),
          SUPABASE_ANON_KEY: env('E2E_SUPABASE_ANON_KEY'),
          NODE_USE_ENV_PROXY: '1',
          HTTPS_PROXY: proxy.url,
          NO_PROXY: 'localhost,127.0.0.1',
          NODE_EXTRA_CA_CERTS: IDP_CA,
        },
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { err += d })
      child.on('error', reject)
      child.on('close', () => {
        const line = out.trim().split('\n').pop() ?? ''
        try { resolve(JSON.parse(line)) } catch { reject(new Error(`no JSON from the admin program: ${out}${err}`)) }
      })
      child.stdin.end(source)
    })
  } finally {
    await proxy.close()
  }
}
