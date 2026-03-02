import { describe, it, expect, vi } from 'vitest'

vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    SUPABASE_URL: 'http://localhost:54321',
    PUBLIC_SUPABASE_URL: 'http://localhost:54321',
  },
}))

import { escapeHtml, convertContentToHTML, extractActivityPubTags, extractAttachments } from '../utils/contentUtils.js'

describe('contentUtils', () => {
  describe('escapeHtml', () => {
    it('escapes ampersands', () => {
      expect(escapeHtml('A & B')).toBe('A &amp; B')
    })

    it('escapes angle brackets', () => {
      expect(escapeHtml('<script>')).toBe('&lt;script&gt;')
    })

    it('escapes quotes', () => {
      expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;')
    })

    it('escapes single quotes', () => {
      expect(escapeHtml("it's")).toBe('it&#039;s')
    })

    it('returns empty string for empty input', () => {
      expect(escapeHtml('')).toBe('')
    })

    it('handles multiple special characters', () => {
      expect(escapeHtml('<a href="x">&')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;')
    })
  })

  describe('convertContentToHTML', () => {
    it('handles plain string content', () => {
      expect(convertContentToHTML('Hello world')).toBe('Hello world')
    })

    it('escapes HTML in string content', () => {
      expect(convertContentToHTML('<b>bold</b>')).toBe('&lt;b&gt;bold&lt;/b&gt;')
    })

    it('handles text parts in array', () => {
      const content = [{ type: 'text', text: 'Hello' }]
      expect(convertContentToHTML(content)).toBe('Hello')
    })

    it('handles mention parts', () => {
      const content = [{ type: 'mention', username: 'alice' }]
      const html = convertContentToHTML(content)
      expect(html).toContain('@alice')
      expect(html).toContain('harmony.test')
      expect(html).toContain('<a')
    })

    it('handles mention with custom domain', () => {
      const content = [{ type: 'mention', username: 'bob', domain: 'mastodon.social' }]
      const html = convertContentToHTML(content)
      expect(html).toContain('mastodon.social')
    })

    it('handles url parts', () => {
      const content = [{ type: 'url', url: 'https://example.com' }]
      const html = convertContentToHTML(content)
      expect(html).toContain('https://example.com')
      expect(html).toContain('<a')
    })

    it('handles emoji object parts', () => {
      const content = [{ type: 'emoji', emoji: { name: 'heart' } }]
      expect(convertContentToHTML(content)).toBe(':heart:')
    })

    it('handles unicode emoji parts', () => {
      const content = [{ type: 'emoji', emoji: '😀' }]
      expect(convertContentToHTML(content)).toBe('😀')
    })

    it('handles code parts', () => {
      const content = [{ type: 'code', text: 'const x = 1' }]
      expect(convertContentToHTML(content)).toBe('<code>const x = 1</code>')
    })

    it('handles codeblock parts', () => {
      const content = [{ type: 'codeblock', text: 'const x = 1', language: 'javascript' }]
      const html = convertContentToHTML(content)
      expect(html).toContain('<pre><code')
      expect(html).toContain('language-javascript')
    })

    it('handles bold parts', () => {
      const content = [{ type: 'bold', text: 'bold text' }]
      expect(convertContentToHTML(content)).toBe('<strong>bold text</strong>')
    })

    it('handles italic parts', () => {
      const content = [{ type: 'italic', text: 'italic text' }]
      expect(convertContentToHTML(content)).toBe('<em>italic text</em>')
    })

    it('handles strikethrough parts', () => {
      const content = [{ type: 'strikethrough', text: 'deleted' }]
      expect(convertContentToHTML(content)).toBe('<del>deleted</del>')
    })

    it('handles linebreak parts', () => {
      const content = [{ type: 'linebreak' }]
      expect(convertContentToHTML(content)).toBe('<br />')
    })

    it('handles object with text property', () => {
      expect(convertContentToHTML({ text: 'simple' })).toBe('simple')
    })

    it('returns empty for unknown content', () => {
      expect(convertContentToHTML(42)).toBe('')
      expect(convertContentToHTML(null)).toBe('')
    })

    it('concatenates mixed content parts', () => {
      const content = [
        { type: 'text', text: 'Hello ' },
        { type: 'mention', username: 'alice' },
        { type: 'text', text: '!' },
      ]
      const html = convertContentToHTML(content)
      expect(html).toContain('Hello ')
      expect(html).toContain('@alice')
      expect(html).toContain('!')
    })
  })

  describe('extractActivityPubTags', () => {
    it('returns empty array for non-array input', () => {
      expect(extractActivityPubTags('string')).toEqual([])
      expect(extractActivityPubTags(null)).toEqual([])
    })

    it('extracts mention tags', () => {
      const content = [{ type: 'mention', username: 'alice' }]
      const tags = extractActivityPubTags(content)
      expect(tags).toHaveLength(1)
      expect(tags[0].type).toBe('Mention')
      expect(tags[0].name).toBe('@alice')
    })

    it('extracts mention with domain', () => {
      const content = [{ type: 'mention', username: 'bob', domain: 'remote.host' }]
      const tags = extractActivityPubTags(content)
      expect(tags[0].name).toBe('@bob@remote.host')
    })

    it('extracts hashtag tags', () => {
      const content = [{ type: 'hashtag', tag: 'fediverse' }]
      const tags = extractActivityPubTags(content)
      expect(tags).toHaveLength(1)
      expect(tags[0].type).toBe('Hashtag')
      expect(tags[0].name).toBe('#fediverse')
    })

    it('extracts custom emoji tags', () => {
      const content = [{
        type: 'emoji',
        emoji: { name: 'blobcat', url: 'https://cdn.example.com/blobcat.png', id: 'emoji-1' },
      }]
      const tags = extractActivityPubTags(content)
      expect(tags).toHaveLength(1)
      expect(tags[0].type).toBe('Emoji')
      expect(tags[0].name).toBe(':blobcat:')
      expect(tags[0].icon.url).toBe('https://cdn.example.com/blobcat.png')
    })

    it('skips text parts', () => {
      const content = [{ type: 'text', text: 'hello' }]
      expect(extractActivityPubTags(content)).toHaveLength(0)
    })
  })

  describe('extractAttachments', () => {
    it('returns empty for non-array', () => {
      expect(extractAttachments('string')).toEqual([])
    })

    it('extracts attachment parts', () => {
      const content = [{
        type: 'attachment',
        url: 'https://cdn.example.com/file.pdf',
        mediaType: 'application/pdf',
        name: 'document.pdf',
      }]
      const attachments = extractAttachments(content)
      expect(attachments).toHaveLength(1)
      expect(attachments[0].type).toBe('Document')
      expect(attachments[0].url).toBe('https://cdn.example.com/file.pdf')
    })

    it('extracts image parts', () => {
      const content = [{
        type: 'image',
        url: 'https://cdn.example.com/photo.jpg',
        mime_type: 'image/jpeg',
      }]
      const attachments = extractAttachments(content)
      expect(attachments).toHaveLength(1)
      expect(attachments[0].mediaType).toBe('image/jpeg')
    })

    it('skips non-attachment parts', () => {
      const content = [
        { type: 'text', text: 'hello' },
        { type: 'attachment', url: 'https://cdn.example.com/file.pdf' },
      ]
      expect(extractAttachments(content)).toHaveLength(1)
    })
  })
})
