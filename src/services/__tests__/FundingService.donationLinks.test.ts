import { describe, it, expect } from 'vitest'
import { donationLinkHref, needsHandleInMessage, orderDonationLinks } from '../FundingService'

const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001'
const stripe = { platform: 'stripe', url: 'https://buy.stripe.com/test_abc', label: 'Card' }
const kofi = { platform: 'ko-fi', url: 'https://ko-fi.com/someone', label: 'Ko-fi' }

describe('donationLinkHref', () => {
  it('names the donor on a Stripe Payment Link', () => {
    const url = new URL(donationLinkHref(stripe, { profileId: ALICE, email: 'a+b@example.com' }))
    expect(url.origin + url.pathname).toBe('https://buy.stripe.com/test_abc')
    expect(url.searchParams.get('client_reference_id')).toBe(ALICE)
    expect(url.searchParams.get('prefilled_email')).toBe('a+b@example.com')
  })

  it('keeps an email the admin prefilled and other parameters', () => {
    const link = { ...stripe, url: 'https://buy.stripe.com/test_abc?prefilled_email=x%40y.z&locale=fr' }
    const url = new URL(donationLinkHref(link, { profileId: ALICE, email: 'a@example.com' }))
    expect(url.searchParams.get('prefilled_email')).toBe('x@y.z')
    expect(url.searchParams.get('locale')).toBe('fr')
  })

  it('leaves other platforms, signed-out donors and unparsable URLs unchanged', () => {
    expect(donationLinkHref(kofi, { profileId: ALICE })).toBe(kofi.url)
    expect(donationLinkHref(stripe, {})).toBe(stripe.url)
    expect(donationLinkHref({ ...stripe, url: 'not a url' }, { profileId: ALICE })).toBe('not a url')
  })
})

describe('needsHandleInMessage', () => {
  it('holds while any link is not Stripe', () => {
    expect(needsHandleInMessage([stripe])).toBe(false)
    expect(needsHandleInMessage([stripe, kofi])).toBe(true)
    expect(needsHandleInMessage([])).toBe(false)
  })
})

describe('orderDonationLinks', () => {
  it('puts Stripe links first and keeps each group in order', () => {
    const monthly = { ...stripe, label: 'Monthly' }
    const paypal = { platform: 'paypal', url: 'https://paypal.me/x', label: 'PayPal' }
    expect(orderDonationLinks([kofi, stripe, paypal, monthly])).toEqual([stripe, monthly, kofi, paypal])
  })
})
