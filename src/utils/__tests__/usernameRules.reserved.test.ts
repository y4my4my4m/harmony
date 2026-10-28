/**
 * Reserved local usernames: one list in src/utils/usernameRules.ts, guard_local_username
 * (20261031900001_reserved_usernames.sql) and self-host/lib.sh reserved_username.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RESERVED_USERNAMES, isReservedUsername } from '@/utils/usernameRules'

const ROOT = resolve(__dirname, '../../..')
const sorted = (names: Iterable<string>) => [...names].sort()

describe('reserved usernames', () => {
  it('refuse mass mentions, staff words and the instance name, in any case', () => {
    for (const name of ['everyone', 'here', 'system', 'harmony', 'admin', 'Admins', 'administrator',
      'mod', 'mods', 'moderator', 'MODERATORS', 'staff', 'root']) {
      expect(isReservedUsername(name, 'har.mony.lol'), name).toBe(true)
    }
  })

  it('refuse the labels of the domain before its last, port dropped', () => {
    expect(isReservedUsername('har', 'har.mony.lol')).toBe(true)
    expect(isReservedUsername('mony', 'har.mony.lol:8443')).toBe(true)
    expect(isReservedUsername('lol', 'har.mony.lol')).toBe(false)
    expect(isReservedUsername('localhost', 'localhost:5173')).toBe(true)
    expect(isReservedUsername('spacify', null)).toBe(false)
  })

  it('take names that only contain a reserved word', () => {
    for (const name of ['everyone2', 'admin_bob', 'heres', 'moderation']) {
      expect(isReservedUsername(name, 'har.mony.lol'), name).toBe(false)
    }
  })

  it('are the same list in the database guard', () => {
    const sql = readFileSync(resolve(ROOT, 'db_schema/migrations/20261031900001_reserved_usernames.sql'), 'utf8')
    const array = /lower\(NEW\.username\) = ANY \(ARRAY\[([\s\S]*?)\]\)/.exec(sql)?.[1] ?? ''
    expect(sorted(array.match(/'([a-z]+)'/g)!.map((s) => s.slice(1, -1)))).toEqual(sorted(RESERVED_USERNAMES))
  })

  it('are the same list in self-host/lib.sh', () => {
    const lib = resolve(ROOT, 'self-host/lib.sh')
    const run = (name: string, domain: string) =>
      spawnSync('bash', ['-c', `set -euo pipefail; source "${lib}"; reserved_username "$1" "$2"`, '_', name, domain]).status
    for (const name of RESERVED_USERNAMES) expect(run(name, ''), name).toBe(0)
    expect(run('mony', 'har.mony.lol')).toBe(0)
    expect(run('lol', 'har.mony.lol')).toBe(1)
    expect(run('owner', 'har.mony.lol')).toBe(1)
    const cases = /reserved_username\(\) \{[\s\S]*?case "\$name" in\n\t*([a-z|]+)\)/.exec(readFileSync(lib, 'utf8'))?.[1] ?? ''
    expect(sorted(cases.split('|'))).toEqual(sorted(RESERVED_USERNAMES))
  })
})
