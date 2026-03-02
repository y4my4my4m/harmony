import { describe, it, expect } from 'vitest'
import { highlightSyntax, getSupportedLanguages } from '@/utils/syntaxHighlighter'

describe('syntaxHighlighter', () => {
  describe('getSupportedLanguages', () => {
    it('includes javascript', () => {
      expect(getSupportedLanguages()).toContain('javascript')
    })

    it('includes typescript', () => {
      expect(getSupportedLanguages()).toContain('typescript')
    })

    it('includes python', () => {
      expect(getSupportedLanguages()).toContain('python')
    })

    it('includes json', () => {
      expect(getSupportedLanguages()).toContain('json')
    })
  })

  describe('highlightSyntax', () => {
    it('returns plain text for unsupported language', () => {
      const tokens = highlightSyntax('hello world', 'brainfuck')
      expect(tokens).toHaveLength(1)
      expect(tokens[0].type).toBe('text')
      expect(tokens[0].content).toBe('hello world')
    })

    it('highlights JavaScript keywords', () => {
      const tokens = highlightSyntax('const x = 42', 'javascript')
      const keyword = tokens.find(t => t.type === 'keyword')
      expect(keyword).toBeDefined()
      expect(keyword!.content).toBe('const')
    })

    it('highlights JavaScript strings', () => {
      const tokens = highlightSyntax('"hello"', 'javascript')
      const str = tokens.find(t => t.type === 'string')
      expect(str).toBeDefined()
      expect(str!.content).toBe('"hello"')
    })

    it('highlights JavaScript numbers', () => {
      const tokens = highlightSyntax('42', 'javascript')
      const num = tokens.find(t => t.type === 'number')
      expect(num).toBeDefined()
      expect(num!.content).toBe('42')
    })

    it('highlights single-line comments', () => {
      const tokens = highlightSyntax('// comment', 'javascript')
      const comment = tokens.find(t => t.type === 'comment')
      expect(comment).toBeDefined()
      expect(comment!.content).toBe('// comment')
    })

    it('highlights multi-line comments', () => {
      const tokens = highlightSyntax('/* comment */', 'javascript')
      const comment = tokens.find(t => t.type === 'comment')
      expect(comment).toBeDefined()
      expect(comment!.content).toBe('/* comment */')
    })

    it('highlights Python keywords', () => {
      const tokens = highlightSyntax('def hello():', 'python')
      const keyword = tokens.find(t => t.type === 'keyword')
      expect(keyword).toBeDefined()
      expect(keyword!.content).toBe('def')
    })

    it('highlights Python comments', () => {
      const tokens = highlightSyntax('# comment', 'python')
      const comment = tokens.find(t => t.type === 'comment')
      expect(comment).toBeDefined()
    })

    it('highlights function calls', () => {
      const tokens = highlightSyntax('foo()', 'javascript')
      const fn = tokens.find(t => t.type === 'function')
      expect(fn).toBeDefined()
      expect(fn!.content).toBe('foo')
    })

    it('highlights TypeScript-specific keywords', () => {
      const tokens = highlightSyntax('interface Foo {}', 'typescript')
      const keyword = tokens.find(t => t.type === 'keyword')
      expect(keyword).toBeDefined()
      expect(keyword!.content).toBe('interface')
    })

    it('handles escaped strings correctly', () => {
      const tokens = highlightSyntax('"hello \\"world\\""', 'javascript')
      const str = tokens.find(t => t.type === 'string')
      expect(str).toBeDefined()
      expect(str!.content).toContain('hello')
    })

    it('handles empty input', () => {
      const tokens = highlightSyntax('', 'javascript')
      expect(tokens).toHaveLength(0)
    })
  })
})
