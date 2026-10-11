// useI18n() for shared components that also mount outside an app with the i18n
// plugin (unit tests that mount a parent with stubs). There the key itself is
// returned and the locale is 'en'.

import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

type Translate = (key: string, ...args: unknown[]) => string

export function useT(): { t: Translate; locale: { value: string } } {
  try {
    const { t, locale } = useI18n()
    return { t: t as unknown as Translate, locale }
  } catch {
    return { t: (key: string) => key, locale: ref('en') }
  }
}
