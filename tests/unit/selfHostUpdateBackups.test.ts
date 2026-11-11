/**
 * `harmony update` deletes its own old backups. Real update.sh and backup.sh against a stand-in
 * `docker`: the names pruned are the names backup.sh writes.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SELF_HOST = resolve(__dirname, '../../self-host')

const FAKE_DOCKER = String.raw`#!/usr/bin/env bash
case "$*" in
*'test -s'*) exit 1 ;;
'compose version'*) echo 2.30.0 ;;
'compose ps'*) echo fake-db ;;
*pg_dump*) echo dump ;;
esac
`

const dd = (day: number) => String(day).padStart(2, '0')
const moved = (day: number) => `202001${dd(day)}-000000-aaaa111-to-bbbb222`
const same = (day: number) => `202002${dd(day)}-000000-cccc333-to-cccc333`
const days = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

describe('harmony update and its old backups', () => {
  let root: string
  let backups: string
  let envFile: string
  let oldCommit: string
  let newCommit: string
  const BASE_ENV = 'DOMAIN=chat.test\nHARMONY_VERSION=1.9.5\nENABLE_ANALYTICS=false\nENABLE_STUDIO=false\n'

  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harmony-update-backups-'))
    const selfHost = join(root, 'self-host')
    mkdirSync(selfHost)
    mkdirSync(join(root, 'bin'))
    for (const f of ['update.sh', 'backup.sh', 'lib.sh', 'linking.sh', 'modes.sh']) copyFileSync(join(SELF_HOST, f), join(selfHost, f))
    writeFileSync(join(selfHost, 'configure.sh'), 'exit 0\n')
    writeFileSync(join(selfHost, 'bootstrap.sh'), 'exit "${FAKE_MIGRATE_RC:-0}"\n')
    writeFileSync(join(root, 'bin', 'docker'), FAKE_DOCKER)
    writeFileSync(join(root, 'bin', 'sleep'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(root, 'bin', 'docker'), 0o755)
    chmodSync(join(root, 'bin', 'sleep'), 0o755)
    envFile = join(selfHost, '.env')
    writeFileSync(envFile, BASE_ENV)
    backups = join(selfHost, 'backups')
    mkdirSync(backups)
    git('init', '-q')
    git('commit', '-q', '--allow-empty', '-m', 'old')
    oldCommit = git('rev-parse', 'HEAD')
    git('commit', '-q', '--allow-empty', '-m', 'new')
    newCommit = git('rev-parse', 'HEAD')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const seed = (...names: string[]) => {
    for (const name of names) {
      mkdirSync(join(backups, name))
      writeFileSync(join(backups, name, 'manifest'), 'contents=database,config\n')
    }
  }
  const present = () => readdirSync(backups).sort()
  const short = (commit: string) => git('rev-parse', '--short', commit)
  const update = (prev: string, env: Record<string, string> = {}) =>
    spawnSync('bash', [join(root, 'self-host', 'update.sh'), '--code-updated', prev], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, ...env },
    })
  // Directory backup.sh wrote in this run: every seed predates 2021.
  const written = () => present().filter((name) => Number(name.slice(0, 4)) > 2020)

  it('keeps the newest 5 version changes, the backup it wrote among them', () => {
    seed(...days(1, 7).map(moved))
    const r = update(oldCommit)
    expect(r.status, r.stderr).toBe(0)
    expect(written()).toHaveLength(1)
    expect(written()[0]).toMatch(new RegExp(`-${short(oldCommit)}-to-${short(newCommit)}$`))
    expect(present()).toEqual([...days(4, 7).map(moved), written()[0]])
    expect(r.stdout).toContain('Old update backups deleted: 3 (')
    expect(r.stdout).toContain('Update complete (1.9.5).')
  })

  it('counts the second backup of one second with the rest', () => {
    seed(...days(1, 5).map(moved), `${moved(5)}-2`)
    expect(update(oldCommit).status).toBe(0)
    expect(present()).toEqual([moved(3), moved(4), moved(5), `${moved(5)}-2`, written()[0]])
  })

  it('does not let runs with no new code push out a version change', () => {
    seed(moved(1), ...days(1, 6).map(same))
    const r = update(newCommit)
    expect(r.status, r.stderr).toBe(0)
    expect(written()[0]).toMatch(new RegExp(`-${short(newCommit)}-to-${short(newCommit)}$`))
    expect(present()).toEqual([moved(1), ...days(3, 6).map(same), written()[0]])
  })

  it('leaves manual, pre-restore, kept and incomplete backups alone', () => {
    const others = [
      '20190101-000000',
      '20190102-000000-nightly',
      '20190103-000000-pre-restore',
      '20190104-000000-aaaa111-to-bbbb222-keep',
      'offsite-copy',
    ]
    seed(...others, ...days(1, 6).map(moved))
    mkdirSync(join(backups, '20190105-000000-dddd444-to-eeee555'))
    writeFileSync(join(backups, 'restore-20190106-000000.log'), 'log\n')
    expect(update(oldCommit).status).toBe(0)
    expect(present()).toEqual(
      [
        ...others,
        '20190105-000000-dddd444-to-eeee555',
        'restore-20190106-000000.log',
        ...days(3, 6).map(moved),
        written()[0],
      ].sort(),
    )
  })

  it('deletes nothing when the update stops', () => {
    seed(...days(1, 7).map(moved))
    const r = update(oldCommit, { FAKE_MIGRATE_RC: '1' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('Update stopped during: migrate')
    expect(r.stderr).toContain('Pre-update backup:')
    expect(present()).toEqual([...days(1, 7).map(moved), written()[0]])
  })

  it('deletes nothing when this run wrote no backup', () => {
    seed(...days(1, 7).map(moved))
    const r = update(oldCommit, { HARMONY_SKIP_BACKUP: '1' })
    expect(r.status, r.stderr).toBe(0)
    expect(present()).toEqual(days(1, 7).map(moved))
  })

  describe('HARMONY_KEEP_UPDATE_BACKUPS', () => {
    beforeEach(() => seed(...days(1, 7).map(moved)))

    it('0 keeps them all', () => {
      expect(update(oldCommit, { HARMONY_KEEP_UPDATE_BACKUPS: '0' }).status).toBe(0)
      expect(present()).toHaveLength(8)
    })

    it('sets the number from the environment', () => {
      expect(update(oldCommit, { HARMONY_KEEP_UPDATE_BACKUPS: '2' }).status).toBe(0)
      expect(present()).toEqual([moved(7), written()[0]])
    })

    it('sets the number from .env', () => {
      writeFileSync(envFile, `${BASE_ENV}HARMONY_KEEP_UPDATE_BACKUPS=3\n`)
      expect(update(oldCommit).status).toBe(0)
      expect(present()).toEqual([moved(6), moved(7), written()[0]])
    })

    it('prefers the environment to .env', () => {
      writeFileSync(envFile, `${BASE_ENV}HARMONY_KEEP_UPDATE_BACKUPS=3\n`)
      expect(update(oldCommit, { HARMONY_KEEP_UPDATE_BACKUPS: '0' }).status).toBe(0)
      expect(present()).toHaveLength(8)
    })

    it('reads a leading zero as decimal', () => {
      const r = update(oldCommit, { HARMONY_KEEP_UPDATE_BACKUPS: '08' })
      expect(r.status, r.stderr).toBe(0)
      expect(present()).toHaveLength(8)
    })

    it('warns on anything but a number and deletes nothing', () => {
      const r = update(oldCommit, { HARMONY_KEEP_UPDATE_BACKUPS: 'all' })
      expect(r.status, r.stderr).toBe(0)
      expect(r.stderr).toContain('HARMONY_KEEP_UPDATE_BACKUPS is not a number (all); no backup deleted')
      expect(present()).toHaveLength(8)
    })
  })

  // Root ignores directory modes, so the deletion cannot fail there.
  it.skipIf(process.getuid?.() === 0)('warns when a deletion fails and still completes', () => {
    seed(...days(1, 6).map(moved))
    const locked = join(backups, moved(1))
    chmodSync(locked, 0o555)
    try {
      const r = update(oldCommit)
      expect(r.status, r.stderr).toBe(0)
      expect(r.stderr).toContain('Some old update backups')
      expect(r.stdout).toContain('Update complete (1.9.5).')
      expect(present()).toContain(moved(1))
      expect(present()).not.toContain(moved(2))
    } finally {
      chmodSync(locked, 0o755)
    }
  })
})
