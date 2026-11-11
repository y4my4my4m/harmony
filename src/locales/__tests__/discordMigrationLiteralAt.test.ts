/**
 * vue-i18n reads a bare "@" as a linked message, so a literal @ in a locale string must be written {'@'}.
 * Renders the strings with a real i18n instance, in every locale.
 */
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import de from '../de.json'
import en from '../en.json'
import es from '../es.json'
import fr from '../fr.json'
import ja from '../ja.json'
import ko from '../ko.json'
import zh from '../zh.json'

const messages = { en, de, es, fr, ja, ko, zh }

function bareAts(value: unknown, path: string, out: string[]) {
  if (typeof value === 'string') {
    if (/(?<!\{')@(?!')/.test(value)) out.push(`${path}: ${value}`)
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) bareAts(v, `${path}.${k}`, out)
  }
}

describe('discordMigration strings', () => {
  for (const locale of Object.keys(messages) as Array<keyof typeof messages>) {
    it(`${locale}: migrate.linkTo renders a literal @username`, () => {
      const i18n = createI18n({ legacy: false, locale, messages })
      expect(i18n.global.t('discordMigration.migrate.linkTo', { username: 'someone' })).toContain('@someone')
    })

    it(`${locale}: no discordMigration string has a bare @`, () => {
      const found: string[] = []
      bareAts((messages[locale] as Record<string, unknown>).discordMigration, 'discordMigration', found)
      expect(found).toEqual([])
    })
  }
})
