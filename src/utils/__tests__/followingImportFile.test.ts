import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { parseFollowingCsv, parseHarmonySocialJson, readFollowingFile } from '../followingImportFile'

const MASTODON_CSV = [
  'Account address,Show boosts,Notify on new posts,Languages',
  'alice@mastodon.example,true,false,',
  'bob@other.example,false,true,"en, de"',
  '',
].join('\n')

const SOCIAL = {
  following: [
    { username: 'alice', domain: 'mastodon.example', status: 'accepted', deleted: false },
    { username: 'pending', domain: 'other.example', status: 'pending', deleted: false },
    { username: 'turned', domain: 'other.example', status: 'rejected', deleted: false },
    { username: 'gone', domain: 'other.example', status: 'accepted', deleted: true },
    { username: 'nodomain', domain: null, federated_id: 'https://uri.example/users/nodomain', status: 'accepted' },
  ],
  followers: [{ username: 'fan', domain: 'other.example' }],
}

const file = (name: string, content: BlobPart) => new File([content], name)

describe('parseFollowingCsv', () => {
  it('reads the first column of following_accounts.csv and drops its header', () => {
    expect(parseFollowingCsv(MASTODON_CSV)).toEqual({
      ok: true,
      source: 'mastodon_csv',
      handles: ['alice@mastodon.example', 'bob@other.example'],
    })
  })

  it('takes a file without the header as data, as Mastodon does', () => {
    const result = parseFollowingCsv('alice@mastodon.example\nbob@other.example\n')
    expect(result.ok && result.handles).toEqual(['alice@mastodon.example', 'bob@other.example'])
  })

  it('handles a byte order mark, CRLF, quoting and a header in another case', () => {
    const text = '\uFEFFACCOUNT ADDRESS,Show boosts\r\n"alice@mastodon.example",true\r\n"weird,""name",true\r\n'
    const result = parseFollowingCsv(text)
    expect(result.ok && result.handles).toEqual(['alice@mastodon.example', 'weird,"name'])
  })

  it('leaves validation to the server: a malformed row stays in the list', () => {
    const result = parseFollowingCsv('Account address\nnot a handle\nalice@mastodon.example\n')
    expect(result.ok && result.handles).toEqual(['not a handle', 'alice@mastodon.example'])
  })

  it('refuses muted_accounts.csv by its second header', () => {
    expect(parseFollowingCsv('Account address,Hide notifications\nalice@m.example,true\n')).toEqual({
      ok: false,
      error: 'wrong_list',
    })
  })

  it('says when a file lists nobody', () => {
    expect(parseFollowingCsv('Account address,Show boosts\n')).toEqual({ ok: false, error: 'no_accounts' })
    expect(parseFollowingCsv('\n\n')).toEqual({ ok: false, error: 'no_accounts' })
  })
})

describe('parseHarmonySocialJson', () => {
  it('reads following only, without deleted accounts or declined follows', () => {
    expect(parseHarmonySocialJson(JSON.stringify(SOCIAL))).toEqual({
      ok: true,
      source: 'harmony_export',
      handles: ['alice@mastodon.example', 'pending@other.example', 'nodomain@uri.example'],
    })
  })

  it('refuses JSON that is no export', () => {
    expect(parseHarmonySocialJson('{"followers":[]}')).toEqual({ ok: false, error: 'unrecognized_file' })
    expect(parseHarmonySocialJson('[]')).toEqual({ ok: false, error: 'unrecognized_file' })
    expect(parseHarmonySocialJson('not json')).toEqual({ ok: false, error: 'unrecognized_file' })
    expect(parseHarmonySocialJson('null')).toEqual({ ok: false, error: 'unrecognized_file' })
  })

  it('says when an export follows nobody', () => {
    expect(parseHarmonySocialJson('{"following":[]}')).toEqual({ ok: false, error: 'no_accounts' })
  })
})

describe('readFollowingFile', () => {
  it('reads following_accounts.csv', async () => {
    const result = await readFollowingFile(file('following_accounts.csv', MASTODON_CSV))
    expect(result.ok && result.source).toBe('mastodon_csv')
  })

  it('reads social.json', async () => {
    const result = await readFollowingFile(file('social.json', JSON.stringify(SOCIAL)))
    expect(result.ok && result.source).toBe('harmony_export')
  })

  it('reads social.json out of the export ZIP', async () => {
    const zip = new JSZip()
    zip.file('README.txt', 'Harmony account export')
    zip.file('social.json', JSON.stringify(SOCIAL))
    const bytes = await zip.generateAsync({ type: 'uint8array' })
    const result = await readFollowingFile(file('harmony-export-me-2026-11-09.zip', bytes))
    expect(result.ok && result.handles).toContain('alice@mastodon.example')
  })

  it('finds social.json in a folder inside the ZIP', async () => {
    const zip = new JSZip()
    zip.file('harmony-export/social.json', JSON.stringify(SOCIAL))
    const bytes = await zip.generateAsync({ type: 'uint8array' })
    expect((await readFollowingFile(file('renamed.zip', bytes))).ok).toBe(true)
  })

  it('refuses a ZIP without social.json and bytes that are no ZIP', async () => {
    const zip = new JSZip()
    zip.file('README.txt', 'something else')
    const bytes = await zip.generateAsync({ type: 'uint8array' })
    expect(await readFollowingFile(file('other.zip', bytes))).toEqual({ ok: false, error: 'unrecognized_file' })
    expect(await readFollowingFile(file('broken.zip', 'not a zip'))).toEqual({ ok: false, error: 'unrecognized_file' })
  })

  it.each(['blocked_accounts.csv', 'muted_accounts.csv', 'bookmarks.csv', 'lists.csv', 'blocked_domains.csv'])(
    'refuses Mastodon\'s %s: following a block list is the wrong outcome',
    async (name) => {
      expect(await readFollowingFile(file(name, 'alice@mastodon.example\n'))).toEqual({ ok: false, error: 'wrong_list' })
    },
  )

  it('keeps a renamed following list', async () => {
    expect((await readFollowingFile(file('my_following_list.csv', MASTODON_CSV))).ok).toBe(true)
  })

  it('refuses other file types', async () => {
    expect(await readFollowingFile(file('photo.png', 'x'))).toEqual({ ok: false, error: 'unrecognized_file' })
  })

  it('refuses a file over the limit before reading it', async () => {
    const big = file('following_accounts.csv', 'x')
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 })
    expect(await readFollowingFile(big)).toEqual({ ok: false, error: 'file_too_large' })
  })
})
