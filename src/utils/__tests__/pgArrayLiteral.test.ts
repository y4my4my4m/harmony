import { describe, expect, it } from 'vitest'
import { jsonbArrayLiteral } from '../pgArrayLiteral'

describe('jsonbArrayLiteral', () => {
  it('keeps a list one element', () => {
    expect(jsonbArrayLiteral([['a.example', 'b.example']])).toBe('{"[\\"a.example\\",\\"b.example\\"]"}')
  })

  it('takes lists, scalars and an empty list together', () => {
    expect(jsonbArrayLiteral([['a'], 7, true, []])).toBe('{"[\\"a\\"]","7","true","[]"}')
  })

  it('escapes quotes and backslashes inside a value', () => {
    expect(jsonbArrayLiteral(['say "hi"\\'])).toBe('{"\\"say \\\\\\"hi\\\\\\"\\\\\\\\\\""}')
  })

  it('writes null as a NULL element', () => {
    expect(jsonbArrayLiteral([null, 'x'])).toBe('{NULL,"\\"x\\""}')
  })
})
