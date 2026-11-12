import { describe, expect, it, vi } from 'vitest'
const { from } = vi.hoisted(() => ({ from: vi.fn() }))
vi.mock('@/supabase', () => ({ supabase: {
  from,
  auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  channel: () => ({ on() { return this }, subscribe() { return this } }),
} }))
import { matrixMentionToken, parseMatrixMentionToken, parseMatrixId, matrixProfileUrl } from '../matrixMentions'
import { parseContentToMessageParts, resolveMentionsUserData, convertMessagePartsToText, extractMentionsFromMessageParts, convertMessagePartsToActivityPubHTML } from '../unifiedContentProcessing'
import { messagePartsToRawText, messagePartsToMarkdown, messagePartsToPlainText, stripLeadingSelfMention } from '../messageContentUtils'
import { extractPlaintextMentionParts } from '../channelEncryption'
import { mentionsViewer } from '../hereMention'
import { replyMentionPrefill } from '../postReblog'
import type { MentionContent } from '@/types'

const id = '@sam:example.org:8448'
const token = '<@matrix:%40sam%3Aexample.org%3A8448>'
const mention: MentionContent = { type: 'mention', userId: id, username: 'sam', domain: 'example.org:8448', isLocal: false, isBridged: true, bridgeSource: 'matrix' }
describe('Matrix mention identity and source token', () => {
  it('uses a full stable MXID with one encoded field, including server ports', () => {
    expect(matrixMentionToken(id)).toBe(token)
    expect(parseMatrixMentionToken(token)).toEqual({ id, username: 'sam', domain: 'example.org:8448' })
    expect(parseMatrixId('@sam:[::1]:8448')?.domain).toBe('[::1]:8448')
    const special = "@sam=2f!foo's(test)%:example.org"
    expect(parseMatrixMentionToken(matrixMentionToken(special)!)?.id).toBe(special)
    expect(matrixProfileUrl(id)).toBe('https://matrix.to/#/%40sam%3Aexample.org%3A8448')
  })
  it.each(['@sam', '@:hs', '@sam:evil/host', '@sam:evil\\', '@sam:%65xample.org', '@sam:hs:', '@sam:evil?x', '@sam:evil#x', '@sam:user@host', '@sam:host\n', '@sa\u0000m:hs', 'javascript:alert(1)'])('rejects invalid or unsafe MXID %j', value => {
    expect(parseMatrixId(value)).toBeNull()
    expect(matrixMentionToken(value)).toBeNull()
    expect(matrixProfileUrl(value)).toBeNull()
  })
  it.each(['<@matrix:@sam:hs>', '<@matrix:%ZZ>', '<@matrix:%2540sam%253Ahs>', '<@matrix:%40sam%3ahs>', '<@matrix:%40sam%3Ahs%3E>', '<@matrix:%40sam%3Ahs:extra>'])('does not parse a malformed or ambiguous token %j', value => {
    expect(parseMatrixMentionToken(value)).toBeNull()
  })
  it('parses native structured parts without ever resolving a Harmony username', async () => {
    from.mockClear()
    expect(await resolveMentionsUserData(token)).toEqual({})
    expect(from).not.toHaveBeenCalled()
    const parts = await parseContentToMessageParts(`hello ${token}`)
    expect(parts).toEqual([{ type: 'text', text: 'hello ' }, { ...mention, displayName: 'sam' }])
    expect(await parseContentToMessageParts('<@matrix:%ZZ>')).toEqual([{ type: 'text', text: '<@matrix:%ZZ>' }])
  })
  it.each(['<@matrix:@sam:hs>', '<@matrix:%40sam%3Ahs:extra>', '<@matrix:%40sam%3Ahs extra>', '<@matrix:%40sam%3Ahs'])('keeps malformed or truncated Matrix token %j as text, never native mentions', async value => {
    from.mockClear()
    expect(await resolveMentionsUserData(value)).toEqual({})
    expect(from).not.toHaveBeenCalled()
    expect(await parseContentToMessageParts(value)).toEqual([{ type: 'text', text: value }])
  })
  it('preserves Discord compact mentions and does not consume tokens inside code, URLs or masked labels', async () => {
    const discord = await parseContentToMessageParts('@d!123:sam')
    expect(discord[0]).toMatchObject({ userId: '123', bridgeSource: 'discord', domain: 'discord.com' })
    for (const value of [`\`${token}\``, `\`\`\`\n${token}\n\`\`\``, `https://example.org/${token}`, `[${token}](https://example.org)`]) {
      const parts = await parseContentToMessageParts(value)
      expect(parts.filter(part => part.type === 'mention'), value).toEqual([])
    }
  })
  it.each([1, 3])('keeps a Matrix token escaped by %i backslashes as text without native resolution', async count => {
    const value = '\\'.repeat(count) + token
    from.mockClear()
    expect(await resolveMentionsUserData(value)).toEqual({})
    expect(from).not.toHaveBeenCalled()
    expect(await parseContentToMessageParts(value)).toEqual([{ type: 'text', text: value }])
  })
  it('keeps an unescaped Matrix mention after a literal backslash pair', async () => {
    const parts = await parseContentToMessageParts('\\\\' + token)
    expect(parts.filter(part => part.type === 'mention')).toEqual([{ ...mention, displayName: 'sam' }])
  })
  it('round-trips edits while displaying the full MXID in previews', () => {
    expect(messagePartsToRawText([mention])).toBe(token)
    expect(messagePartsToMarkdown([mention])).toBe(token)
    expect(convertMessagePartsToText([mention])).toBe(token)
    expect(messagePartsToPlainText([mention])).toBe(id)
    expect(stripLeadingSelfMention([mention], 'sam')).toEqual([mention])
  })
  it('never generates Harmony/ActivityPub notification targets for Matrix mentions', () => {
    expect(replyMentionPrefill({ id: 'post', author: { id: 'viewer', username: 'viewer', is_local: true }, content: [mention] } as any, { id: 'viewer', username: 'viewer' })).toBe('')
    expect(extractMentionsFromMessageParts([mention])).toEqual([])
    expect(extractPlaintextMentionParts([mention])).toEqual([])
    expect(mentionsViewer([mention], { profileId: id, roleIds: new Set() })).toBe(false)
    const html = convertMessagePartsToActivityPubHTML([mention])
    expect(html).toContain('https://matrix.to/#/%40sam%3Aexample.org%3A8448')
    expect(html).not.toContain('/users/sam')
    expect(html).not.toContain('class="u-url mention"')
  })
})
