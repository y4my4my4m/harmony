import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import helmet from 'helmet'
import supertest from 'supertest'

vi.mock('../../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', APP_URL: 'https://harmony.test', CORS_ORIGIN: 'https://harmony.test' },
}))

const { default: router, frameCsp } = await import('../frame.js')

function app() {
  const a = express()
  a.use(helmet())
  a.use('/activities', router)
  return a
}

function directives(csp: string): Map<string, string> {
  return new Map(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const [name, ...rest] = d.split(/\s+/)
    return [name, rest.join(' ')]
  }))
}

describe('activity frame', () => {
  it('serves a sandboxed loader that refuses the network', async () => {
    const res = await supertest(app()).get('/activities/frame/drawinphone?entry=app.1a2b3c4d.js')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^text\/html/)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-frame-options']).toBeUndefined()

    const csp = directives(res.headers['content-security-policy'])
    expect(csp.get('sandbox')).toBe('allow-scripts allow-pointer-lock')
    expect(csp.get('connect-src')).toBe("'none'")
    expect(csp.get('default-src')).toBe("'none'")
    expect(csp.get('form-action')).toBe("'none'")
    expect(csp.get('frame-src')).toBe("'none'")
    expect(csp.get('script-src')).toMatch(/^'nonce-[A-Za-z0-9+/=]+' https:\/\/harmony\.test\/activities\/drawinphone\/$/)
    expect(csp.get('img-src')).toBe('data: blob: https://harmony.test/activities/drawinphone/')
    expect(csp.get('frame-ancestors')).toContain('tauri://localhost')
    expect(csp.get('frame-ancestors')).toContain('http://tauri.localhost')
    expect(csp.get('frame-ancestors')).toContain('https://harmony.test')
    expect(res.headers['permissions-policy']).toContain('camera=()')

    const nonce = /'nonce-([^']+)'/.exec(csp.get('script-src')!)![1]
    expect(res.text).toContain(`<script nonce="${nonce}">`)
    expect(res.text).toContain('"https://harmony.test/activities/drawinphone/app.1a2b3c4d.js"')
    expect(res.text).toContain("self.origin !== 'null'")
  })

  it('loads an installed package from its hash-named file on the backend', async () => {
    const sha = 'a'.repeat(64)
    const res = await supertest(app()).get(`/activities/frame/tictac?source=package&entry=${sha}.js`)
    expect(res.status).toBe(200)
    const csp = directives(res.headers['content-security-policy'])
    expect(csp.get('script-src')).toMatch(/ https:\/\/harmony\.test\/api\/federation\/activities\/pkg\/tictac\/$/)
    expect(res.text).toContain(`"https://harmony.test/api/federation/activities/pkg/tictac/${sha}.js"`)
    expect((await supertest(app()).get('/activities/frame/tictac?source=package&entry=app.js')).status).toBe(400)
  })

  it('uses a fresh nonce per response', async () => {
    const a = await supertest(app()).get('/activities/frame/drawinphone?entry=app.js')
    const b = await supertest(app()).get('/activities/frame/drawinphone?entry=app.js')
    expect(a.headers['content-security-policy']).not.toBe(b.headers['content-security-policy'])
  })

  it.each([
    ['/activities/frame/Drawin?entry=app.js'],
    ['/activities/frame/drawinphone?entry=../x.js'],
    ['/activities/frame/drawinphone?entry=app.html'],
    ['/activities/frame/drawinphone?entry=%2F%2Fevil.example%2Fx.js'],
    ['/activities/frame/drawinphone'],
  ])('refuses %s', async (path) => {
    const res = await supertest(app()).get(path)
    expect(res.status).toBe(400)
  })

  it('scopes every source to the app folder', () => {
    const csp = frameCsp('drawinphone', 'n')
    expect(csp).not.toContain('https://harmony.test/activities/ ')
    expect(csp).not.toMatch(/\bhttps:(?!\/\/)/)
    expect(csp).not.toContain('*')
  })
})
