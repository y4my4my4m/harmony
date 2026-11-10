import { describe, expect, it } from 'vitest'
import { unescapeMarkup as client } from '@/utils/markupEscapes'
import { unescapeMarkup as server } from '../../../federation-backend/src/utils/markupEscapes'

const SAMPLES = [
  '\\*a\\* \\_b\\_ \\~c \\|d \\>e \\#f \\@g \\:h: \\[i] \\`j \\\\ \\<k \\+l',
  '\\https://x.example \\HTTP://y.example \\ftp://z.example',
  '¯\\_(ツ)_/¯ and a\\_b',
  '`\\*` ```\\*``` `open \\*',
  'C:\\Users\\bob \\(x\\) \\"q\\" trailing\\',
  '',
]

describe('markup escape parity (frontend vs federation-backend)', () => {
  it.each(SAMPLES)('reads %j alike', (text) => {
    expect(server(text)).toBe(client(text))
  })
})
