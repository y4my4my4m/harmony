import { ghostOwner, ghostUserId, type Config, type Pair } from './config.js'
import { Store } from './Store.js'
import { HttpError } from './http.js'
import type { BridgeMember, SenderMode } from './HarmonyClient.js'
import type { HarmonyTransport, MatrixTransport } from './Relay.js'

/** All calls share Relay's single worker; never provision or publish profiles from event callbacks. */
export class Ghosts {
  private readonly registered = new Set<string>()
  // shortcut: unchanged avatar URLs stay cached until restart; revalidate if in-place uploads need live refresh.
  private readonly avatars = new Map<string, string>()
  constructor(private readonly config: Config, private readonly store: Store,
    private readonly harmony: HarmonyTransport, private readonly matrix: MatrixTransport) {}

  async mode(pair: Pair): Promise<SenderMode> {
    const binding = await this.harmony.bridgeRoom(pair.harmonyChannelId)
    if (binding.room_id !== pair.matrixRoomId) throw new HttpError('Matrix room binding differs from configuration', false)
    return binding.sender_mode
  }

  async plaintext(pair: Pair): Promise<void> {
    await this.harmony.requireMatrixBridge(pair.harmonyChannelId)
    if (!await this.harmony.channelIsPlaintext(pair.harmonyChannelId)
      || !await this.matrix.roomIsPlaintext(pair.matrixRoomId) || this.store.isRoomBlocked(pair.matrixRoomId)) {
      throw new HttpError('Profile sync requires verified plaintext rooms', false)
    }
  }

  async eligible(pair: Pair): Promise<BridgeMember[]> {
    return (await this.harmony.bridgeMembers(pair.harmonyChannelId)).filter(member => this.config.harmony.allowedUserIds.includes(member.id))
  }

  private async consent(pair: Pair, member: BridgeMember): Promise<void> {
    if (!this.config.harmony.allowedUserIds.includes(member.id) || !await this.harmony.relayAllowed(pair.harmonyChannelId, member.id)
      || await this.mode(pair) !== 'ghost') throw new HttpError('Ghost profile is not currently permitted', false)
    await this.plaintext(pair)
  }

  async ensure(pair: Pair, member: BridgeMember): Promise<string> {
    await this.consent(pair, member)
    const id = ghostUserId(this.config, member.id)
    const known = this.store.reserveGhost(id, member.id)
    if (!this.registered.has(id)) {
      await this.matrix.registerGhost(id, known)
      this.store.registerGhost(id)
      this.registered.add(id)
    }
    await this.consent(pair, member)
    let avatar: string | undefined
    if (member.avatar_url) {
      // shortcut: cache follows avatar URL changes, restart to refresh an overwrite at the same URL.
      const key = `${member.id}:${member.avatar_url}`
      avatar = this.avatars.get(key)
      if (!avatar) {
        let image
        try { image = await this.harmony.nativeAvatar(pair.harmonyChannelId, member.id) }
        catch { /* Optional avatar bytes are served only by the trusted eligible-member endpoint. */ }
        await this.consent(pair, member)
        if (image) {
          try {
            avatar = await this.matrix.uploadAvatar(image)
            if (this.avatars.size >= 256) this.avatars.delete(this.avatars.keys().next().value!)
            this.avatars.set(key, avatar)
          } catch { /* Missing avatars must not replace ghost mode with relay attribution. */ }
        }
      }
    }
    await this.consent(pair, member)
    const current = (await this.eligible(pair)).find(candidate => candidate.id === member.id)
    if (!current) throw new HttpError('Ghost member was removed during provisioning', false)
    if (current.avatar_url !== member.avatar_url) avatar = undefined
    // Track before remote join so a crash still leaves enough state for later cleanup.
    this.store.trackGhostRoom(pair.matrixRoomId, id)
    await this.matrix.joinGhost(pair.matrixRoomId, id, { displayname: current.display_name || current.username,
      ...(current.avatar_url ? (avatar ? { avatar_url: avatar } : {}) : { avatar_url: '' }) })
    return id
  }

  async cleanup(pair: Pick<Pair, 'matrixRoomId'>, keep: Set<string>): Promise<void> {
    for (const id of this.store.roomGhosts(pair.matrixRoomId)) {
      if (!ghostOwner(this.config, id)) throw new HttpError('Stored ghost outside configured namespace; restore original registration', false)
      if (keep.has(id)) continue
      await this.matrix.leaveGhost(pair.matrixRoomId, id)
      this.store.forgetGhostRoom(pair.matrixRoomId, id)
    }
  }

  async sync(pair: Pair): Promise<void> {
    let mode: SenderMode
    let eligible: BridgeMember[]
    try {
      mode = await this.mode(pair)
      await this.plaintext(pair)
      eligible = await this.eligible(pair)
    } catch (error) {
      // Revocation still removes previously provisioned ghosts, but never publishes fresh profiles.
      if (error instanceof HttpError && !error.transient) await this.cleanup(pair, new Set())
      throw error
    }
    const keep = new Set(mode === 'ghost' ? eligible.map(member => ghostUserId(this.config, member.id)) : [])
    await this.cleanup(pair, keep)
    // shortcut: provisioning is serial; chunk refreshes if large allowlists delay message delivery.
    if (mode === 'ghost') for (const member of eligible) await this.ensure(pair, member)
  }
}
