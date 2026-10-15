import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { backgrounds } from '../../vite-plugin-backgrounds'
import list from 'virtual:backgrounds'

type Hook = (...args: any[]) => any

function loadFrom(publicDir: string): Record<string, string[]> {
  const plugin = backgrounds()
  ;(plugin.configResolved as Hook)({ publicDir })
  const id = (plugin.resolveId as Hook)('virtual:backgrounds')
  const code = (plugin.load as Hook)(id) as string
  return JSON.parse(code.replace(/^export default /, ''))
}

let dir = ''
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('vite-plugin-backgrounds', () => {
  it('lists image files per folder in natural order, skipping other files', () => {
    dir = mkdtempSync(join(tmpdir(), 'bg-'))
    mkdirSync(join(dir, 'backgrounds/login'), { recursive: true })
    mkdirSync(join(dir, 'backgrounds/404'), { recursive: true })
    for (const name of ['10.webp', '2.webp', '1.jpg', 'notes.txt', 'night sky.png']) {
      writeFileSync(join(dir, 'backgrounds/login', name), '')
    }
    writeFileSync(join(dir, 'backgrounds/404/1.webp'), '')

    expect(loadFrom(dir)).toEqual({
      login: [
        '/backgrounds/login/1.jpg',
        '/backgrounds/login/2.webp',
        '/backgrounds/login/10.webp',
        '/backgrounds/login/night%20sky.png',
      ],
      notFound: ['/backgrounds/404/1.webp'],
    })
  })

  it('returns empty lists when the folders are absent', () => {
    dir = mkdtempSync(join(tmpdir(), 'bg-'))
    expect(loadFrom(dir)).toEqual({ login: [], notFound: [] })
  })

  it('resolves through the test config to the committed defaults', () => {
    expect(list.login).toContain('/backgrounds/login/1.webp')
    expect(list.notFound).toContain('/backgrounds/404/1.webp')
  })
})
