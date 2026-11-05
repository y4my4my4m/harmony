import type { FundingLink } from '@/services/FundingService'

/**
 * The Harmony development fund, shown on the Harmony development tab of every instance. It is
 * paid on Stripe, outside any instance, and its supporters and their messages are on the
 * project's website; nothing here comes from an instance's settings, database or backend.
 * federation-backend routes/webhooks/stripe.ts DEVELOPMENT_PAYMENT_LINK_IDS are these links.
 */
export interface DevelopmentLink extends FundingLink {
  period: 'once' | 'monthly'
}

export const DEVELOPMENT_LINKS: readonly Readonly<DevelopmentLink>[] = Object.freeze([
  Object.freeze({ platform: 'stripe', url: 'https://donate.stripe.com/fZu8wQ29W5S97hrcqKb7y03', label: 'One-time', period: 'once' as const }),
  Object.freeze({ platform: 'stripe', url: 'https://donate.stripe.com/8x25kEbKwbct59jcqKb7y04', label: 'Monthly', period: 'monthly' as const }),
])

export const DEVELOPMENT_SUPPORTERS_URL = 'https://mony.lol/supporters'
