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
} as const

export const DISCORD_INTENT_NAMES = {
  message_content: 'Message Content Intent',
  members: 'Server Members Intent',
  presence: 'Presence Intent',
} as const
