// @vitest-environment node
/**
 * db_schema/PERMISSIONS.json against the code it describes. Fails when a permission of
 * permission_bit_names() is absent from the manifest, RoleService, the role editor, the channel
 * override editor or a locale; when a bit map elsewhere disagrees; when a named SQL object is
 * absent from db_schema/migrations, or none names its permission; when a named file is absent
 * or does not name its permission.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Permission, PERMISSION_BITS, PERMISSION_CATEGORIES } from '@/services/RoleService'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const MIGRATIONS = join(ROOT, 'db_schema/migrations')
const LOCALES = join(ROOT, 'src/locales')

const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

type Scope = 'server' | 'channel' | 'reserved'
interface Entry {
  scope: Scope
  reserved?: string
  sql: string[]
  backend: string[]
  client: string[]
  pgtap: string[]
  e2e: string[]
  unit: string[]
}
const manifest = JSON.parse(read('db_schema/PERMISSIONS.json')) as { permissions: Record<string, Entry> }

// ---------------------------------------------------------------------------
// Migrations: the latest CREATE of each function, policy and trigger, unless a later DROP
// removed it. Keys: function:<name>, policy:[<schema>.]<table>:<name>, trigger:<table>:<name>.
// Statements built by EXECUTE format(...) are invisible here.
// ---------------------------------------------------------------------------

interface Definition { at: number; text: string }
const created = new Map<string, Definition>()
const dropped = new Map<string, number>()

const qualified = (schema: string | undefined, table: string) =>
  !schema || schema === 'public' ? table : `${schema}.${table}`

{
  let base = 0
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
    const create = (key: string, at: number, text: string) => created.set(key, { at: base + at, text })
    const drop = (key: string, at: number) => dropped.set(key, base + at)

    for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?(\w+)"?\.)?"?(\w+)"?\s*\(/gi)) {
      if (m[1] && m[1] !== 'public') continue
      const open = /\bAS\s+(\$\w*\$)/gi
      open.lastIndex = m.index! + m[0].length
      const tag = open.exec(sql)
      if (!tag) continue
      const close = sql.indexOf(tag[1], tag.index + tag[0].length)
      create(`function:${m[2]}`, m.index!, sql.slice(m.index!, close < 0 ? undefined : close))
    }
    for (const m of sql.matchAll(/DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?/gi)) {
      if (!m[1] || m[1] === 'public') drop(`function:${m[2]}`, m.index!)
    }
    for (const m of sql.matchAll(/CREATE\s+POLICY\s+(?:"([^"]+)"|(\w+))\s+ON\s+(?:"?(\w+)"?\.)?"?(\w+)"?[^;]*;/gi)) {
      create(`policy:${qualified(m[3], m[4])}:${m[1] ?? m[2]}`, m.index!, m[0])
    }
    for (const m of sql.matchAll(/DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|(\w+))\s+ON\s+(?:"?(\w+)"?\.)?"?(\w+)"?/gi)) {
      drop(`policy:${qualified(m[3], m[4])}:${m[1] ?? m[2]}`, m.index!)
    }
    // 20261001200001: converge_policy('<schema>.<table>', '<name>', requires, $ddl$CREATE POLICY __POLICY__ ...$ddl$).
    for (const m of sql.matchAll(/converge_policy\(\s*'(?:(\w+)\.)?(\w+)'\s*,\s*'([^']+)'\s*,\s*'[^']*'\s*,\s*\$ddl\$([\s\S]*?)\$ddl\$/g)) {
      create(`policy:${qualified(m[1], m[2])}:${m[3]}`, m.index!, m[4])
    }
    for (const m of sql.matchAll(/drop_legacy_policy\(\s*'(?:(\w+)\.)?(\w+)'\s*,\s*'([^']+)'/g)) {
      drop(`policy:${qualified(m[1], m[2])}:${m[3]}`, m.index!)
    }
    for (const m of sql.matchAll(/CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+"?(\w+)"?([^;]*);/gi)) {
      const on = /\bON\s+(?:"?(\w+)"?\.)?"?(\w+)"?/i.exec(m[2])
      if (on) create(`trigger:${on[2]}:${m[1]}`, m.index!, m[0])
    }
    for (const m of sql.matchAll(/DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?\s+ON\s+(?:"?(\w+)"?\.)?"?(\w+)"?/gi)) {
      drop(`trigger:${m[3]}:${m[1]}`, m.index!)
    }
    base += sql.length + 1
  }
}

function definition(key: string): Definition | undefined {
  const def = created.get(key)
  return def && def.at > (dropped.get(key) ?? -1) ? def : undefined
}

// Bit order: the quoted names of permission_bit_names()'s latest definition.
const bitNames = [...(definition('function:permission_bit_names')?.text ?? '').matchAll(/'([A-Z_]+)'/g)].map((m) => m[1])

const namesWord = (text: string, name: string) => new RegExp(`\\b${name}\\b`).test(text)

/** NAME: n pairs of an object literal opened by `opener`. */
function bitLiteral(source: string, opener: string): Map<string, number> {
  const start = source.indexOf(opener)
  if (start < 0) return new Map()
  const body = source.slice(start, source.indexOf('}', start))
  return new Map([...body.matchAll(/^\s*\[?(?:Permission\.)?([A-Z_]+)\]?:\s*(\d+),?$/gm)].map((m) => [m[1], Number(m[2])]))
}

function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from)
  return start < 0 ? '' : source.slice(start, source.indexOf(to, start + from.length))
}

const channelScoped = Object.entries(manifest.permissions)
  .filter(([, e]) => e.scope === 'channel')
  .map(([name]) => name)

describe('permission bits', () => {
  it('permission_bit_names() names 32 permissions', () => {
    expect(bitNames).toHaveLength(32)
    expect(new Set(bitNames).size).toBe(32)
  })

  it('the manifest lists every permission, in bit order', () => {
    expect(Object.keys(manifest.permissions)).toEqual(bitNames)
  })

  it('RoleService holds every permission at its bit', () => {
    expect(Object.values(Permission).sort()).toEqual([...bitNames].sort())
    for (const [i, name] of bitNames.entries()) expect(PERMISSION_BITS[name as Permission], name).toBe(i)
    const categorised = Object.values(PERMISSION_CATEGORIES).flatMap((c) => [...c.permissions])
    expect([...categorised].sort()).toEqual([...bitNames].sort())
  })

  it('the bot gateway, federation backend and journey harness agree on bit positions', () => {
    const bot = bitLiteral(read('bot-gateway/src/auth/botPermissions.ts'), 'export const PERMISSION_BIT = {')
    expect([...bot.keys()]).toEqual(bitNames)
    for (const [name, bit] of bot) expect(bit, name).toBe(bitNames.indexOf(name))

    const federation = read('federation-backend/src/activitypub/ServerInboxHandler.ts')
    const perms = [...federation.matchAll(/const PERM_([A-Z_]+) = (\d+)n;/g)]
    expect(perms.length).toBeGreaterThan(0)
    for (const [, name, bit] of perms) expect(Number(bit), name).toBe(bitNames.indexOf(name))

    const harness = bitLiteral(read('e2e/specs/harness.ts'), 'export const PERMISSION_BITS = {')
    expect(harness.size).toBeGreaterThan(0)
    for (const [name, bit] of harness) expect(bit, name).toBe(bitNames.indexOf(name))
  })
})

describe('permission editors', () => {
  const roleEditor = read('src/components/settings/RoleManagement.vue')
  const sections = between(roleEditor, 'const PERMISSION_SECTIONS', '\n]\n')
  const sectionKeys = [...sections.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1])
  const sectionIds = [...sections.matchAll(/id: '(\w+)'/g)].map((m) => m[1])

  const channelEditor = read('src/components/ChannelEditModal.vue')
  const overrideKeys = new Set(
    [...between(channelEditor, 'const PERMISSION_GROUPS', 'interface Props').matchAll(/Permission\.([A-Z_]+)/g)].map((m) => m[1]),
  )

  it('the role editor shows every permission once', () => {
    expect([...sectionKeys].sort()).toEqual([...bitNames].sort())
  })

  it('channel overrides offer exactly the channel-scoped permissions', () => {
    expect([...overrideKeys].sort()).toEqual([...channelScoped].sort())
  })

  for (const file of readdirSync(LOCALES).filter((f) => f.endsWith('.json'))) {
    it(`${file} labels and describes every permission the editors show`, () => {
      const locale = JSON.parse(readFileSync(join(LOCALES, file), 'utf8'))
      const role = locale.server.roleManagement
      for (const id of sectionIds) expect(role.sections[id], `sections.${id}`).toBeTruthy()
      for (const name of bitNames) {
        expect(role.perms[name]?.label, `roleManagement.perms.${name}.label`).toBeTruthy()
        expect(role.perms[name]?.description, `roleManagement.perms.${name}.description`).toBeTruthy()
      }
      for (const name of overrideKeys) {
        expect(locale.channel.edit.perms[name]?.label, `channel.edit.perms.${name}.label`).toBeTruthy()
        expect(locale.channel.edit.perms[name]?.description, `channel.edit.perms.${name}.description`).toBeTruthy()
      }
    })
  }
})

describe('db_schema/PERMISSIONS.json', () => {
  for (const name of bitNames) {
    const entry = manifest.permissions[name]
    if (!entry) continue

    describe(name, () => {
      it('has a scope, and a reason when reserved', () => {
        expect(['server', 'channel', 'reserved']).toContain(entry.scope)
        expect(typeof entry.reserved === 'string' && entry.reserved.length > 0).toBe(entry.scope === 'reserved')
      })

      it('names SQL objects present in db_schema/migrations', () => {
        const absent = entry.sql.filter((key) => !definition(key))
        expect(absent).toEqual([])
      })

      if (entry.scope === 'reserved') {
        it('is accepted by none of its SQL objects', () => {
          const naming = entry.sql.filter((key) => definition(key)?.text.includes(`'${name}'`))
          expect(naming).toEqual([])
        })
      } else {
        it('is enforced: a SQL object names it, or a backend file does', () => {
          const sqlNames = entry.sql.some((key) => definition(key)?.text.includes(`'${name}'`))
          expect(sqlNames || entry.backend.length > 0).toBe(true)
        })
      }

      it('has a pgTAP file and a journey', () => {
        expect(entry.pgtap.length).toBeGreaterThan(0)
        expect(entry.e2e.length).toBeGreaterThan(0)
        for (const file of entry.pgtap) expect(file).toMatch(/^db_schema\/tests\/[^/]+\.sql$/)
        for (const file of entry.e2e) expect(file).toMatch(/^e2e\/specs\/[^/]+\.spec\.ts$/)
      })

      it('names files that exist and name it', () => {
        const files = [...entry.backend, ...entry.client, ...entry.pgtap, ...entry.e2e, ...entry.unit]
        const missing = files.filter((file) => !existsSync(join(ROOT, file)))
        expect(missing).toEqual([])
        const silent = files.filter((file) => !namesWord(read(file), name))
        expect(silent).toEqual([])
      })
    })
  }
})
