/**
 * Native LiveKit transport for the Linux Tauri client.
 *
 * WebKitGTK has no WebRTC, so media runs in the Rust process (livekit crate,
 * real libwebrtc) — see src-tauri/crates/harmony-media. This service mirrors
 * the LiveKitWebRTCService surface that webrtcManager consumes, translating
 * Tauri `media://*` events back into the JS event names the store expects.
 *
 * Phase 1 = voice only: video/screenshare land with the native call window
 * (Phase 2), so attachVideoToElement() and stream getters return null/false.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type { UserMediaState, VideoSource } from './livekitWebRTC';
import {
  getLiveKitToken,
  isLiveKitAvailable,
  liveKitRoomName,
  type LiveKitRoomType,
} from './livekitTokens';
import { VoiceSettingsService } from './VoiceSettingsService';
import { debug } from '@/utils/debug';

export interface NativeDeviceInfo {
  id: string;
  label: string;
}

export interface NativeDeviceList {
  inputs: NativeDeviceInfo[];
  outputs: NativeDeviceInfo[];
  cameras: NativeDeviceInfo[];
}

let nativeSupported: boolean | null = null;

/** True when running inside Tauri with the native-media feature compiled in. */
export async function isNativeMediaSupported(): Promise<boolean> {
  if (nativeSupported !== null) return nativeSupported;

  const g = globalThis as any;
  if (typeof g.__TAURI_INTERNALS__ === 'undefined' && typeof g.__TAURI__ === 'undefined') {
    nativeSupported = false;
    return false;
  }

  try {
    nativeSupported = await invoke<boolean>('native_media_supported');
  } catch {
    nativeSupported = false;
  }
  return nativeSupported;
}

export class NativeLiveKitService {
  private connected = false;
  private channelId: string | null = null;
  private currentUserId: string | null = null;
  private localMediaState: UserMediaState = this.emptyState('');
  private allUserStates = new Map<string, UserMediaState>();
  private micVolumes = new Map<string, number>();
  private screenVolumes = new Map<string, number>();
  private eventListeners = new Map<string, Function[]>();
  private unlisteners: UnlistenFn[] = [];
  private listenersReady: Promise<void> | null = null;

  private emptyState(userId: string): UserMediaState {
    return {
      userId,
      isAudioEnabled: false,
      isVideoEnabled: false,
      isScreenSharing: false,
      isMuted: false,
      isDeafened: false,
      isSpeaking: false,
      audioLevel: 0,
    };
  }

  // TAURI EVENT BRIDGE

  private ensureListeners(): Promise<void> {
    if (this.listenersReady) return this.listenersReady;

    this.listenersReady = (async () => {
      const on = async (name: string, handler: (payload: any) => void) => {
        this.unlisteners.push(await listen(name, (event) => handler(event.payload)));
      };

      await on('media://connected', (p) => {
        this.connected = true;
        this.emit('channel-joined', { channelId: p.channelId, userId: this.currentUserId });
      });

      await on('media://disconnected', (p) => {
        this.connected = false;
        this.allUserStates.clear();
        this.emit('channel-left', { reason: p.reason });
      });

      await on('media://state-synced', (p) => {
        this.localMediaState = { ...this.localMediaState, ...p.local, userId: this.currentUserId ?? p.local.userId };
        this.allUserStates.clear();
        for (const user of p.users) {
          this.allUserStates.set(user.userId, user);
        }
        this.emit('local-state-changed', { ...this.localMediaState });
        this.emit('channel-state-synced', { users: this.getAllUsers() });
      });

      await on('media://user-joined', (p) => {
        this.allUserStates.set(p.userId, p);
        this.emit('user-joined', { userId: p.userId, mediaState: { ...p } });
      });

      await on('media://user-left', (p) => {
        this.allUserStates.delete(p.userId);
        this.micVolumes.delete(p.userId);
        this.screenVolumes.delete(p.userId);
        this.emit('user-left', { userId: p.userId });
      });

      await on('media://user-state', (p) => {
        // preserve data-channel-only flags (isDeafened) the SFU can't see
        const previous = this.allUserStates.get(p.userId);
        const merged = { ...p, isDeafened: previous?.isDeafened ?? false };
        this.allUserStates.set(p.userId, merged);
        this.emit('user-state-changed', { userId: p.userId, mediaState: { ...merged } });
      });

      await on('media://local-state', (p) => {
        this.localMediaState = { ...this.localMediaState, ...p, userId: this.currentUserId ?? p.userId };
        this.emit('local-state-changed', { ...this.localMediaState });
      });

      await on('media://audio-levels', (p) => {
        for (const { userId, level } of p.levels) {
          const state = this.allUserStates.get(userId);
          if (state) {
            state.audioLevel = level;
            state.isSpeaking = level > 20;
          } else if (userId === this.currentUserId) {
            this.localMediaState.audioLevel = level;
            this.localMediaState.isSpeaking = level > 20;
          }
          this.emit('audio-level', { userId, level });
        }
      });

      await on('media://connection-state', (p) => {
        this.emit('connection-state-changed', p.state);
      });

      await on('media://error', (p) => {
        this.emit('error', new Error(p.message));
      });

      await on('media://data', (p) => {
        this.handleDataMessage(p.userId, p.payload);
      });
    })();

    return this.listenersReady;
  }

  /** Same wire protocol as livekitWebRTC's DataReceived handler. */
  private handleDataMessage(fromUserId: string | null, payload: string): void {
    let message: any;
    try {
      message = JSON.parse(payload);
    } catch {
      debug.warn('⚠️ [NativeLiveKit] Failed to parse data message');
      return;
    }

    if (message.type === 'media-state' && fromUserId) {
      const state = this.allUserStates.get(fromUserId);
      if (state) {
        Object.assign(state, message.data);
        this.emit('user-state-changed', { userId: fromUserId, mediaState: { ...state } });
      }
    } else if (message.type === 'call-start-time') {
      this.emit('call-start-time', { timestamp: message.timestamp, from: message.from });
    } else if (message.type === 'request-call-start-time') {
      this.emit('request-call-start-time', { from: message.from });
    }
  }

  private broadcastMediaState(): void {
    this.broadcastMessage({
      type: 'media-state',
      data: {
        isMuted: this.localMediaState.isMuted,
        isDeafened: this.localMediaState.isDeafened,
        isVideoEnabled: this.localMediaState.isVideoEnabled,
        isScreenSharing: this.localMediaState.isScreenSharing,
      },
    });
  }

  broadcastMessage(message: any): void {
    invoke('media_broadcast', { payload: JSON.stringify(message), topic: null }).catch(() => {
      debug.warn('⚠️ [NativeLiveKit] Failed to broadcast data message');
    });
  }

  // CONFIG

  async isAvailable(): Promise<boolean> {
    return isLiveKitAvailable();
  }

  // CONNECTION

  async joinChannel(
    channelId: string,
    userId: string,
    roomType: LiveKitRoomType = 'voice_channel',
    abortSignal?: AbortSignal,
    requireE2EE = false
  ): Promise<boolean> {
    debug.log('🦀 [NativeLiveKit] Joining channel:', channelId, 'as:', userId);

    if (requireE2EE) {
      // Rust-side frame cryptor lands with Phase 2.5
      this.emit(
        'error',
        new Error('End-to-end encrypted voice is not available on the Linux desktop client yet.')
      );
      return false;
    }

    const roomName = liveKitRoomName(channelId, roomType);

    try {
      const tokenResponse = await getLiveKitToken(roomName, roomType);
      if (abortSignal?.aborted) return false;
      return await this.joinWithToken(tokenResponse.wsUrl, tokenResponse.token, channelId, userId);
    } catch (error) {
      debug.error('❌ [NativeLiveKit] Failed to join channel:', error);
      this.emit('error', error);
      return false;
    }
  }

  async joinWithToken(
    wsUrl: string,
    token: string,
    channelId: string,
    userId: string
  ): Promise<boolean> {
    await this.ensureListeners();

    this.channelId = channelId;
    this.currentUserId = userId;
    this.localMediaState = { ...this.emptyState(userId), isAudioEnabled: true };

    try {
      await invoke('media_connect', { wsUrl, token, channelId, userId });
      await this.applySavedDevices();
      return true;
    } catch (error) {
      debug.error('❌ [NativeLiveKit] media_connect failed:', error);
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  async leaveChannel(): Promise<void> {
    try {
      await invoke('media_disconnect');
    } catch (error) {
      debug.warn('⚠️ [NativeLiveKit] media_disconnect failed:', error);
    }
    this.connected = false;
    this.channelId = null;
    this.allUserStates.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }

  getChannelId(): string | null {
    return this.channelId;
  }

  // MEDIA CONTROLS

  toggleMute(): boolean {
    const next = !this.localMediaState.isMuted;
    this.setMuted(next);
    return next;
  }

  setMuted(muted: boolean): void {
    this.localMediaState.isMuted = muted;
    this.localMediaState.isAudioEnabled = !muted;
    this.emit('local-state-changed', { ...this.localMediaState });
    invoke('media_set_muted', { muted })
      .then(() => this.broadcastMediaState())
      .catch((error) => debug.warn('⚠️ [NativeLiveKit] set_muted failed:', error));
  }

  toggleDeafen(): boolean {
    const next = !this.localMediaState.isDeafened;
    this.localMediaState.isDeafened = next;
    // deafening also mutes, like the web client
    if (next && !this.localMediaState.isMuted) {
      this.setMuted(true);
    } else {
      this.emit('local-state-changed', { ...this.localMediaState });
    }
    invoke('media_set_deafened', { deafened: next })
      .then(() => this.broadcastMediaState())
      .catch((error) => debug.warn('⚠️ [NativeLiveKit] set_deafened failed:', error));
    return next;
  }

  async toggleVideo(): Promise<boolean> {
    this.emit('error', new Error('Camera is not available on the Linux desktop client yet.'));
    return false;
  }

  async toggleScreenShare(): Promise<boolean> {
    this.emit('error', new Error('Screen sharing is not available on the Linux desktop client yet.'));
    return false;
  }

  async updateStreamQuality(_settings: {
    resolution?: number;
    frameRate?: number;
    audioBitrate?: number;
  }): Promise<void> {
    // audio-only in Phase 1; video quality mapping lands with Phase 2
  }

  // STREAM ACCESS (no MediaStreams exist in the webview on the native path)

  getLocalStream(): MediaStream | null {
    return null;
  }

  getUserStream(_userId: string): MediaStream | null {
    return null;
  }

  getUserMicStream(_userId: string): MediaStream | null {
    return null;
  }

  attachVideoToElement(_userId: string, _el: HTMLVideoElement, _source: VideoSource): boolean {
    return false;
  }

  detachVideoFromElement(_userId: string, _el: HTMLVideoElement, _source: VideoSource): void {}

  setTraditionalAudioEnabled(_enabled: boolean): void {}

  isE2EEEnabled(): boolean {
    return false;
  }

  // STATE

  getLocalState(): UserMediaState {
    return { ...this.localMediaState };
  }

  getAllUsers(): UserMediaState[] {
    return Array.from(this.allUserStates.values()).map((state) => ({ ...state }));
  }

  // VOLUMES (0-200; native path degrades 0 to track-disable, >0 plays at unity
  // until per-track gain is exposed by the livekit rust bindings)

  setUserMicVolume(userId: string, volume: number): void {
    this.micVolumes.set(userId, volume);
    invoke('media_set_user_volume', { userId, source: 'mic', volume: Math.round(volume) }).catch(
      () => {}
    );
  }

  setUserScreenShareVolume(userId: string, volume: number): void {
    this.screenVolumes.set(userId, volume);
    invoke('media_set_user_volume', { userId, source: 'screen', volume: Math.round(volume) }).catch(
      () => {}
    );
  }

  getUserMicVolume(userId: string): number {
    return this.micVolumes.get(userId) ?? 100;
  }

  getUserScreenShareVolume(userId: string): number {
    return this.screenVolumes.get(userId) ?? 100;
  }

  hasScreenShareAudio(userId: string): boolean {
    return this.allUserStates.get(userId)?.hasScreenShareAudio ?? false;
  }

  // DEVICES (native ADM device ids, not browser enumerateDevices ids)

  async listDevices(): Promise<NativeDeviceList> {
    return invoke<NativeDeviceList>('media_list_devices');
  }

  async updateInputDevice(deviceId: string): Promise<void> {
    await invoke('media_set_input_device', { deviceId });
  }

  async updateOutputDevice(deviceId: string): Promise<void> {
    await invoke('media_set_output_device', { deviceId });
  }

  async updateVideoDevice(_deviceId: string): Promise<void> {
    // camera lands with Phase 2
  }

  getSelectedDevices(): {
    inputDevice: string | null;
    outputDevice: string | null;
    videoDevice: string | null;
  } {
    return VoiceSettingsService.getDevices();
  }

  private async applySavedDevices(): Promise<void> {
    const devices = VoiceSettingsService.getDevices();
    try {
      const available = await this.listDevices();
      if (devices.inputDevice && available.inputs.some((d) => d.id === devices.inputDevice)) {
        await this.updateInputDevice(devices.inputDevice);
      }
      if (devices.outputDevice && available.outputs.some((d) => d.id === devices.outputDevice)) {
        await this.updateOutputDevice(devices.outputDevice);
      }
    } catch (error) {
      debug.warn('⚠️ [NativeLiveKit] Failed to apply saved devices:', error);
    }
  }

  // EVENTS

  on(event: string, callback: Function): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event)!.push(callback);
  }

  off(event: string, callback: Function): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      const index = listeners.indexOf(callback);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    }
  }

  private emit(event: string, data?: any): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.forEach((callback) => {
        try {
          callback(data);
        } catch (error) {
          debug.error(`Error in ${event} listener:`, error);
        }
      });
    }
  }
}

export const nativeLiveKit = new NativeLiveKitService();
export default nativeLiveKit;
