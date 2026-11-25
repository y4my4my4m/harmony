/**
 * DrawinPhone: write a prompt, draw what you read, describe what you see, then reveal every chain.
 * Entry of the activity bundle (vite-plugin-activities builds it into one classic script).
 */

import { connect } from '../sdk'
import styles from './src/styles.css'
import { Session } from './src/session'
import { App } from './src/ui'

async function main(): Promise<void> {
  const style = document.createElement('style')
  style.textContent = styles
  document.head.appendChild(style)

  const room = await connect()
  let app: App | null = null
  const session = new Session(room, {
    changed: () => app?.changed(),
    newHost: (name) => app?.toast(app.t('newHost', { name })),
    reacted: (key, emoji) => app?.reacted(key, emoji),
  })
  app = new App(room, session)
  session.start()
  app.changed()
}

main().catch((error: Error) => {
  document.body.textContent = error.message
})
