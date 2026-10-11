// axe-core checks for the journey specs.
//
//   await expectNoAxeViolations(page)                                  whole page
//   await expectNoAxeViolations(page, { include: '[role="dialog"]' })  one region
//   await expectNoAxeViolations(page, { rules: ['button-name', 'label'] })
//
// Rules: WCAG 2.0/2.1 A and AA tags. Fails on serious and critical impact by
// default (`impacts` widens it). axe is injected from node_modules/axe-core, so
// runs need no network.
//
// AXE_EXCLUSIONS below is the single list of known, not yet fixed violations.
// Each entry names the area that owns the fix; the area builder deletes its
// entries as the screens are fixed. An entry matches by rule and, when given, by
// a CSS selector the failing node sits in (closest()) or by the colour pair of a
// color-contrast node.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Page } from '@playwright/test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const AXE_PATH = path.join(ROOT, 'node_modules/axe-core/axe.min.js')

export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

export type Area = 'chat' | 'voice' | 'social' | 'settings-auth' | 'owner'

export interface AxeExclusion {
  rule: string
  area: Area
  reason: string
  /** Node is inside an element matching this selector. */
  within?: string
  /** color-contrast only: foreground/background pair, lower-case hex. */
  colors?: { fg: string; bg: string }
}

export const AXE_EXCLUSIONS: AxeExclusion[] = [
  {
    rule: 'color-contrast',
    area: 'owner',
    reason:
      'White label on the brand fill #0ea5e9 is 2.77:1. readableTextOn() keeps white above 2.6:1 by design; ' +
      'a dark label (7.6:1) or a darker fill is a brand decision left to the owner.',
    colors: { fg: '#ffffff', bg: '#0ea5e9' },
  },
  {
    rule: 'color-contrast',
    area: 'owner',
    reason: 'Role colours are member data (server role settings); names are drawn in the colour the role carries.',
    within: '.display-name',
  },
  {
    rule: 'aria-allowed-attr',
    area: 'chat',
    reason: 'Composer editor: aria-expanded on role=textbox (RichTextEditor.vue); needs the combobox pattern.',
    within: '.rich-text-editor',
  },
  {
    rule: 'label-content-name-mismatch',
    area: 'chat',
    reason: 'Composer GIF button: aria-label "GIFs" over the visible "GIF" glyph text.',
    within: '[data-testid="message-input"]',
  },
  {
    rule: 'nested-interactive',
    area: 'chat',
    reason: 'Voice channel rows (role=button) contain the "Open chat" button (ChannelSidebar.vue).',
    within: '.channel-sidebar',
  },
  {
    rule: 'label-content-name-mismatch',
    area: 'voice',
    reason: 'User panel avatar button: aria-label "Your account and voice controls" omits the visible name (UserProfileComponent.vue).',
    within: '[data-region="user"], .user-profile-section',
  },
]

export interface AxeOptions {
  /** CSS selector of the region to check; default the whole document. */
  include?: string
  /** CSS selectors left out of the run. */
  exclude?: string[]
  /** Only these rules (still filtered by impact). */
  rules?: string[]
  /** Rules switched off for this call only, with the reason in the caller. */
  disable?: string[]
  /** Impacts that fail. Default serious and critical. */
  impacts?: Array<'minor' | 'moderate' | 'serious' | 'critical'>
  /** Ignore AXE_EXCLUSIONS (to list everything that is still wrong). */
  noExclusions?: boolean
  /** Label for the printed summary. */
  label?: string
}

export interface AxeFinding {
  id: string
  impact: string
  help: string
  nodes: Array<{ target: string; html: string; summary: string }>
}

async function ensureAxe(page: Page): Promise<void> {
  const present = await page.evaluate(() => typeof (window as unknown as { axe?: unknown }).axe !== 'undefined')
  if (!present) await page.addScriptTag({ path: AXE_PATH })
}

/** Violations after impact filtering and AXE_EXCLUSIONS, without asserting. */
export async function axeFindings(page: Page, options: AxeOptions = {}): Promise<AxeFinding[]> {
  await ensureAxe(page)
  const impacts = options.impacts ?? ['serious', 'critical']
  const exclusions = options.noExclusions ? [] : AXE_EXCLUSIONS
  return page.evaluate(
    async ({ include, exclude, rules, disable, impacts, exclusions, tags }) => {
      type Node = { target: string[]; html: string; failureSummary?: string; any?: Array<{ data?: { fgColor?: string; bgColor?: string } }> }
      type Violation = { id: string; impact: string | null; help: string; nodes: Node[] }
      const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Violation[] }> } }).axe
      const context = { include: include ? [include] : [document], exclude: (exclude ?? []).map((s: string) => [s]) }
      const runOptions: Record<string, unknown> = { resultTypes: ['violations'] }
      if (rules?.length) runOptions.runOnly = { type: 'rule', values: rules }
      else runOptions.runOnly = { type: 'tag', values: tags }
      if (disable?.length) runOptions.rules = Object.fromEntries(disable.map((id: string) => [id, { enabled: false }]))
      const { violations } = await axe.run(context, runOptions)

      const excluded = (rule: string, node: Node) =>
        exclusions.some((ex) => {
          if (ex.rule !== rule) return false
          if (ex.colors) {
            const data = node.any?.find((c) => c.data?.fgColor)?.data
            return !!data && data.fgColor?.toLowerCase() === ex.colors.fg && data.bgColor?.toLowerCase() === ex.colors.bg
          }
          if (ex.within) {
            const el = document.querySelector(node.target[node.target.length - 1])
            return !!el?.closest(ex.within)
          }
          return true
        })

      return violations
        .filter((v) => impacts.includes((v.impact ?? 'minor') as never))
        .map((v) => ({
          id: v.id,
          impact: v.impact ?? 'minor',
          help: v.help,
          nodes: v.nodes
            .filter((n) => !excluded(v.id, n))
            .map((n) => ({ target: n.target.join(' '), html: n.html.slice(0, 160), summary: (n.failureSummary ?? '').split('\n').slice(0, 3).join(' ') })),
        }))
        .filter((v) => v.nodes.length > 0)
    },
    {
      include: options.include,
      exclude: options.exclude,
      rules: options.rules,
      disable: options.disable,
      impacts,
      exclusions,
      tags: WCAG_TAGS,
    },
  )
}

export function formatFindings(findings: AxeFinding[], label = 'page'): string {
  if (findings.length === 0) return `axe ${label}: no violations`
  const lines = [`axe ${label}: ${findings.reduce((n, f) => n + f.nodes.length, 0)} failing nodes`]
  for (const f of findings) {
    lines.push(`  [${f.impact}] ${f.id} (${f.nodes.length}): ${f.help}`)
    for (const n of f.nodes.slice(0, 5)) lines.push(`      ${n.target}\n        ${n.html}\n        ${n.summary}`)
    if (f.nodes.length > 5) lines.push(`      ... ${f.nodes.length - 5} more`)
  }
  return lines.join('\n')
}

/** Fails with a readable summary when axe reports violations at the given impacts. */
export async function expectNoAxeViolations(page: Page, options: AxeOptions = {}): Promise<void> {
  const findings = await axeFindings(page, options)
  const summary = formatFindings(findings, options.label ?? options.include ?? page.url())
  if (findings.length) console.log(summary)
  expect(findings, summary).toEqual([])
}
