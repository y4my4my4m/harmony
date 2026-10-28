import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The self-host scripts run on minimal Debian and Ubuntu hosts under `set -euo pipefail`.
// util-linux's `column` is absent there (bsdextrautils), and a reader that stops before its
// writer is done (head -c, head -1, od -N) ends the script with SIGPIPE (exit 141) whenever the
// writer is still writing: in configure.sh's VAPID step that silently stopped fresh installs.

const dir = join(__dirname, '..', '..', 'self-host')
const scripts = readdirSync(dir)
  .filter((name) => name.endsWith('.sh') || name === 'harmony')
  .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))

const code = (text: string) => text.split('\n').filter((line) => !/^\s*#/.test(line))

describe('self-host scripts', () => {
  it('do not call column', () => {
    for (const { name, text } of scripts) {
      expect(code(text).filter((line) => /(^|[|;&(]\s*)column\b/.test(line)), name).toEqual([])
    }
  })

  it('read openssl output to its end', () => {
    for (const { name, text } of scripts) {
      expect(code(text).filter((line) => /openssl[^|]*\|.*\|\s*(head\s+-c|od\b[^|]*-N)/.test(line) || /openssl[^|]*\|\s*(head\s+-c|od\b[^|]*-N)/.test(line)), name).toEqual([])
    }
  })
})
