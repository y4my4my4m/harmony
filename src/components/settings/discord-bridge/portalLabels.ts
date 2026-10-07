/**
 * Control names as the Discord Developer Portal and client print them. The portal has no
 * localisation, so these stay English in every locale and are inserted into translated
 * sentences.
 */
export const PORTAL = {
  newApplication: 'New Application',
  create: 'Create',
  bot: 'Bot',
  privilegedIntents: 'Privileged Gateway Intents',
  saveChanges: 'Save Changes',
  token: 'Token',
  resetToken: 'Reset Token',
  yesDoIt: 'Yes, do it!',
  copy: 'Copy',
  generalInformation: 'General Information',
  applicationId: 'Application ID',
  publicBot: 'Public Bot',
  requiresCodeGrant: 'Requires OAuth2 Code Grant',
  oauth2: 'OAuth2',
  redirects: 'Redirects',
  addRedirect: 'Add Redirect',
  clientSecret: 'Client Secret',
  resetSecret: 'Reset Secret',
} as const

export const DISCORD_INTENT_NAMES = {
  message_content: 'Message Content Intent',
  members: 'Server Members Intent',
  presence: 'Presence Intent',
} as const
