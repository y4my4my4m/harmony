<!--
  AppTimestamp - a <time datetime> whose visible text is short ("5m", "10:58 AM") and
  whose title is the full localized date and time.

    <AppTimestamp :value="message.created_at" speak="time" />          short time of day
    <AppTimestamp :value="post.published" :short="shortRelativeTime(post.published)" />
    <AppTimestamp :value="date" format="date" />                       "Oct 11, 2026"

  `short` overrides the visible text. `format`: 'time' (default), 'date',
  'datetime', 'relative' (Intl.RelativeTimeFormat, e.g. "5 minutes ago").
  `hour12` false forces 24-hour time; default follows the locale. Locale is
  vue-i18n's current locale.

  `speak` is what a screen reader reads:
    'full' (default)  the full date and time ("October 11, 2026 at 10:58 AM") in
                      .sr-only beside the aria-hidden visible text, for short
                      forms such as "5m" that say little on their own.
    'time'            the time of day ("10:58 AM"), for a list whose day headings
                      already give the date (chat messages). When it equals the
                      visible text the visible text itself is exposed.
-->
<template>
  <time :datetime="iso" :title="full" class="timestamp-el">
    <span v-if="exposeVisible">{{ visible }}</span>
    <template v-else>
      <span aria-hidden="true"><slot :short="visible" :full="full">{{ visible }}</slot></span>
      <span class="sr-only">{{ speak === 'time' ? clock : full }}</span>
    </template>
  </time>
</template>

<script setup lang="ts">
import { computed, useSlots } from 'vue'
import { useT } from '@/composables/useT'

interface Props {
  value: string | number | Date
  short?: string
  format?: 'time' | 'date' | 'datetime' | 'relative'
  hour12?: boolean
  speak?: 'full' | 'time'
}

const props = withDefaults(defineProps<Props>(), { format: 'time', hour12: undefined, speak: 'full' })
const { locale } = useT()
const slots = useSlots()

const date = computed(() => (props.value instanceof Date ? props.value : new Date(props.value)))
const valid = computed(() => !Number.isNaN(date.value.getTime()))
const iso = computed(() => (valid.value ? date.value.toISOString() : undefined))

const full = computed(() => {
  if (!valid.value) return ''
  return new Intl.DateTimeFormat(locale.value, { dateStyle: 'long', timeStyle: 'short', hour12: props.hour12 }).format(date.value)
})

const clock = computed(() => {
  if (!valid.value) return ''
  return new Intl.DateTimeFormat(locale.value, { timeStyle: 'short', hour12: props.hour12 }).format(date.value)
})

/** Seconds in each unit, largest first, for the relative format. */
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
  ['second', 1],
]

const visible = computed(() => {
  if (props.short) return props.short
  if (!valid.value) return ''
  const d = date.value
  switch (props.format) {
    case 'date':
      return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }).format(d)
    case 'datetime':
      return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short', hour12: props.hour12 }).format(d)
    case 'relative': {
      const seconds = Math.round((d.getTime() - Date.now()) / 1000)
      const [unit, size] = UNITS.find(([, s]) => Math.abs(seconds) >= s) ?? ['second', 1]
      return new Intl.RelativeTimeFormat(locale.value, { numeric: 'auto' }).format(Math.round(seconds / size), unit)
    }
    default:
      return new Intl.DateTimeFormat(locale.value, { timeStyle: 'short', hour12: props.hour12 }).format(d)
  }
})

// Intl separates the time from AM/PM with U+202F; a visible text built elsewhere
// with a plain space still counts as the same text.
const sameText = (a: string, b: string) => a.replace(/\s/gu, ' ') === b.replace(/\s/gu, ' ')

const exposeVisible = computed(() => props.speak === 'time' && !slots.default && sameText(visible.value, clock.value))
</script>
