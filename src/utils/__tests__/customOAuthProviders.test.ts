import { describe, expect, it } from 'vitest'
import {
  isCustomOAuthProviderId,
  isOAuthIdentityProvider,
  oauthProviderLabel,
  parseCustomOAuthProviders,
} from '../customOAuthProviders'

describe('parseCustomOAuthProviders', () => {
  it('reads the jsonb array in stored order', () => {
    expect(parseCustomOAuthProviders([
      { id: 'custom:authentik', name: 'Authentik', icon: 'https://auth.example.com/static/icon.svg' },
      { id: 'custom:better-auth', name: ' Better Auth ' },
    ])).toEqual([
      { id: 'custom:authentik', name: 'Authentik', icon: 'https://auth.example.com/static/icon.svg' },
      { id: 'custom:better-auth', name: 'Better Auth', icon: null },
    ])
  })

  it('reads a JSON string of the array', () => {
    expect(parseCustomOAuthProviders('[{"id":"custom:dex","name":"Dex"}]'))
      .toEqual([{ id: 'custom:dex', name: 'Dex', icon: null }])
  })

  it('answers no providers for anything that is not an array', () => {
    for (const raw of [null, undefined, '', 'not json', '{}', 42, true, { id: 'custom:dex', name: 'Dex' }]) {
      expect(parseCustomOAuthProviders(raw)).toEqual([])
    }
  })

  it('drops entries without a GoTrue custom identifier', () => {
    expect(parseCustomOAuthProviders([
      { id: 'github', name: 'GitHub' },
      { id: 'custom:', name: 'Empty' },
      { id: 'custom:Upper', name: 'Upper case' },
      { id: 'custom:trailing-', name: 'Trailing hyphen' },
      { id: `custom:${'a'.repeat(44)}`, name: 'Too long' },
      { id: 'custom:ok', name: 'Kept' },
      'custom:string',
      null,
    ]).map((p) => p.id)).toEqual(['custom:ok'])
  })

  it('drops entries without a usable name and keeps the first of a repeated id', () => {
    expect(parseCustomOAuthProviders([
      { id: 'custom:a', name: '' },
      { id: 'custom:b', name: 'x'.repeat(101) },
      { id: 'custom:c' },
      { id: 'custom:d', name: 'First' },
      { id: 'custom:d', name: 'Second' },
    ])).toEqual([{ id: 'custom:d', name: 'First', icon: null }])
  })

  it('keeps https and base64 image data icons only', () => {
    const icons = [
      'http://auth.example.com/icon.png',
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'data:image/svg+xml,<svg onload=alert(1)>',
      '/relative/icon.png',
      'data:image/png;base64,iVBORw0KGgo=',
      'https://cdn.example.com/idp.png',
    ]
    expect(parseCustomOAuthProviders(icons.map((icon, i) => ({ id: `custom:p${i}`, name: `P${i}`, icon })))
      .map((p) => p.icon)).toEqual([null, null, null, null, null, 'data:image/png;base64,iVBORw0KGgo=', 'https://cdn.example.com/idp.png'])
  })
})

describe('provider ids', () => {
  it('mirrors GoTrue identifier lengths: 8 to 50 characters', () => {
    expect(isCustomOAuthProviderId('custom:a')).toBe(true)
    expect(isCustomOAuthProviderId(`custom:${'a'.repeat(43)}`)).toBe(true)
    expect(isCustomOAuthProviderId(`custom:${'a'.repeat(44)}`)).toBe(false)
    expect(isCustomOAuthProviderId('custom:org:idp-1')).toBe(true)
  })

  it('treats built-in and custom identities as OAuth for the profile form', () => {
    expect(isOAuthIdentityProvider('github')).toBe(true)
    expect(isOAuthIdentityProvider('custom:authentik')).toBe(true)
    expect(isOAuthIdentityProvider('email')).toBe(false)
    expect(isOAuthIdentityProvider(undefined)).toBe(false)
  })
})

describe('oauthProviderLabel', () => {
  const custom = [{ id: 'custom:authentik', name: 'Example SSO', icon: null }]

  it('names built-in providers by brand and custom ones by their button name', () => {
    expect(oauthProviderLabel('github')).toBe('GitHub')
    expect(oauthProviderLabel('google', custom)).toBe('Google')
    expect(oauthProviderLabel('custom:authentik', custom)).toBe('Example SSO')
  })

  it('falls back to the id without its prefix, or capitalised', () => {
    expect(oauthProviderLabel('custom:authentik')).toBe('authentik')
    expect(oauthProviderLabel('discord')).toBe('Discord')
  })
})
