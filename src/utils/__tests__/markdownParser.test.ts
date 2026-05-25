import { describe, it, expect } from 'vitest'
import {
  parseMarkdownToNodes,
  nodesToText,
  getPlainText,
  parseMarkdownWithMarkers,
} from '@/utils/markdownParser'

describe('markdownParser', () => {
  describe('parseMarkdownToNodes', () => {
    it('parses plain text', () => {
      const nodes = parseMarkdownToNodes('hello world')
      expect(nodes).toHaveLength(1)
      expect(nodes[0]).toEqual({ type: 'text', content: 'hello world' })
    })

    it('parses bold text', () => {
      const nodes = parseMarkdownToNodes('**bold**')
      expect(nodes).toHaveLength(1)
      expect(nodes[0]).toEqual({ type: 'bold', content: 'bold' })
    })

    it('parses italic text', () => {
      const nodes = parseMarkdownToNodes('*italic*')
      expect(nodes).toHaveLength(1)
      expect(nodes[0]).toEqual({ type: 'italic', content: 'italic' })
    })

    it('parses strikethrough text', () => {
      const nodes = parseMarkdownToNodes('~~strikethrough~~')
      expect(nodes).toHaveLength(1)
      expect(nodes[0]).toEqual({ type: 'strikethrough', content: 'strikethrough' })
    })

    it('parses underline text', () => {
      const nodes = parseMarkdownToNodes('__underline__')
      expect(nodes).toHaveLength(1)
      expect(nodes[0]).toEqual({ type: 'underline', content: 'underline' })
    })

    it('parses inline code', () => {
      const nodes = parseMarkdownToNodes('`code`')
      expect(nodes).toHaveLength(1)
      expect(nodes[0]).toEqual({ type: 'code', content: 'code' })
    })

    it('parses code blocks with language', () => {
      const nodes = parseMarkdownToNodes('```javascript\nconsole.log("hi")\n```')
      expect(nodes).toHaveLength(1)
      expect(nodes[0].type).toBe('codeblock')
      expect(nodes[0].content).toContain('console.log')
      expect(nodes[0].language).toBe('javascript')
    })

    it('parses code blocks without language', () => {
      const nodes = parseMarkdownToNodes('```\nsome code\n```')
      expect(nodes).toHaveLength(1)
      expect(nodes[0].type).toBe('codeblock')
      expect(nodes[0].language).toBe('text')
    })

    it('parses emoji shortcodes', () => {
      const nodes = parseMarkdownToNodes(':smile:')
      expect(nodes).toHaveLength(1)
      expect(nodes[0]).toEqual({ type: 'emoji', content: 'smile' })
    })

    it('parses mixed content', () => {
      const nodes = parseMarkdownToNodes('Hello **world** and *italic*')
      expect(nodes.length).toBeGreaterThanOrEqual(3)
      expect(nodes.find(n => n.type === 'bold')?.content).toBe('world')
    })

    it('handles newlines', () => {
      const nodes = parseMarkdownToNodes('line1\nline2')
      const newlineNodes = nodes.filter(n => n.type === 'newline')
      expect(newlineNodes).toHaveLength(1)
    })

    it('handles empty string', () => {
      const nodes = parseMarkdownToNodes('')
      expect(nodes).toHaveLength(0)
    })
  })

  describe('nodesToText', () => {
    it('reconstructs markdown from nodes', () => {
      const nodes = parseMarkdownToNodes('**bold** and `code`')
      const text = nodesToText(nodes)
      expect(text).toBe('**bold** and `code`')
    })

    it('reconstructs emoji as shortcode', () => {
      const nodes = parseMarkdownToNodes(':wave:')
      expect(nodesToText(nodes)).toBe(':wave:')
    })
  })

  describe('getPlainText', () => {
    it('strips formatting and returns plain text', () => {
      const nodes = parseMarkdownToNodes('**bold** and `code`')
      const plain = getPlainText(nodes)
      expect(plain).toContain('bold')
      expect(plain).toContain('code')
      expect(plain).not.toContain('**')
    })

    it('preserves emoji shortcodes', () => {
      const nodes = parseMarkdownToNodes('hello :wave:')
      expect(getPlainText(nodes)).toContain(':wave:')
    })
  })

  describe('parseMarkdownWithMarkers', () => {
    it('parses bold with raw markers', () => {
      const tokens = parseMarkdownWithMarkers('**bold**')
      const boldToken = tokens.find(t => t.type === 'bold')
      expect(boldToken).toBeDefined()
      expect(boldToken!.content).toBe('bold')
      expect(boldToken!.raw).toBe('**bold**')
    })

    it('parses inline code', () => {
      const tokens = parseMarkdownWithMarkers('`code`')
      const codeToken = tokens.find(t => t.type === 'code')
      expect(codeToken).toBeDefined()
      expect(codeToken!.content).toBe('code')
    })

    it('parses mixed content', () => {
      const tokens = parseMarkdownWithMarkers('hello **world** bye')
      expect(tokens).toHaveLength(3)
      expect(tokens[0].type).toBe('text')
      expect(tokens[1].type).toBe('bold')
      expect(tokens[2].type).toBe('text')
    })

    it('does not parse formatting inside code blocks', () => {
      const tokens = parseMarkdownWithMarkers('```\n**not bold**\n```')
      const boldTokens = tokens.filter(t => t.type === 'bold')
      expect(boldTokens).toHaveLength(0)
    })

    it('treats incomplete code blocks as text', () => {
      const tokens = parseMarkdownWithMarkers('```javascript\nincomplete')
      const codeblockTokens = tokens.filter(t => t.type === 'codeblock')
      expect(codeblockTokens).toHaveLength(0)
    })
  })
})
