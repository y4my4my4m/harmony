import { debug } from '@/utils/debug';
import { userStorage } from '@/utils/userScopedStorage';
import { VoiceSettingsService } from './VoiceSettingsService';
import { remoteAudioMixer } from './voice/remoteAudioMixer';
import { spatialAudioService } from './spatialAudio';
import { useSpatialAudioStore } from '@/stores/spatialAudio';
import {
  INPUT_VOLUME_UNITY,
  MicGainStage,
  UNITY_RELEASE_MS,
  clampInputVolume,
  inputGain,
  needsGainStage,
} from './voice/micGain';
import { SOUNDBOARD_P2P_EVENT } from './soundboard/protocol';
import { SIGNAL_ACK_TIMEOUT_MS, relaysSignals, sendSignal as sendRoomSignal, sendSignalOnUnload } from './signalRelay';
import { DEFAULT_ICE_SERVERS, loadIceServers } from './voice/iceServers';
import { speakingDetector } from './voice/speakingDetector';
import { openRebuildingChannel, type RebuildingChannel } from './rebuildingChannel';

const RENEGOTIATION_STABLE_WAIT_MS = 10_000;
// send_signal takes 1 to 64 messages, at most 65536 bytes as text (20261124100001).
const RELAY_BATCH_MESSAGES = 64;
const RELAY_BATCH_BYTES = 48_000;
const SIGNAL_JOIN_TIMEOUT_MS = 15_000;
// Longest a leave waits for its queued signals (user-left) to be sent.
const LEAVE_SEND_TIMEOUT_MS = 2_000;
// After a resumed signalling topic: members answering the state request with no connection here get an offer.
const RESYNC_WINDOW_MS = 10_000;
// A member whose connection failed or closed has left once this passes with no signal from it. ICE
// reports 'failed' 15 to 30 s after the last packet.
const PEER_LOST_GRACE_MS = 6_000;
// A member still signalling with its connection lost stays, and is asked again this often.
const PEER_RECHECK_MS = 30_000;

// TYPES & INTERFACES

export interface UserMediaState {
  userId: string;
  isAudioEnabled: boolean;
  isVideoEnabled: boolean;
  isScreenSharing: boolean;
  isMuted: boolean;
  isDeafened: boolean;
  isSpeaking: boolean;
  audioLevel: number;
  /** A stream audio track is received for this user. */
  hasScreenShareAudio?: boolean;
}

export interface UserConnection {
  userId: string;
  peerConnection: RTCPeerConnection;
  mediaState: UserMediaState;
  remoteStream: MediaStream | null;
  /** The peer's screenshare stream (separate MediaStream so camera + screen can run concurrently) */
  remoteScreenStream: MediaStream | null;
  /** Every remote stream seen in ontrack, keyed by stream id, so streams can be (re)classified once the peer announces its screen stream id */
  knownStreams: Map<string, MediaStream>;
  audioElement: HTMLAudioElement | null;
  /** Separate playback element for screenshare audio (never spatialized) */
  screenAudioElement: HTMLAudioElement | null;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  /**
   * ICE candidates arriving before `setRemoteDescription`
   * (common with trickle ICE) are queued here and flushed afterwards.
   * `addIceCandidate` throws `InvalidStateError` when `remoteDescription`
   * is unset, which yields flaky P2P connections on slow networks.
   */
  pendingIceCandidates: RTCIceCandidateInit[];
  /** Set while the connection is lost: ends in the member's leave (watchPeer). */
  lostTimer: ReturnType<typeof setTimeout> | null;
  /** The member has signalled since watchPeer last asked. */
  heard: boolean;
}

export interface SignalingMessage {
  type: 'offer' | 'answer' | 'ice-candidate' | 'user-joined' | 'user-left' | 'media-state' | 'state-sync' | 'call-start-time' | 'request-call-start-time' | 'soundboard';
  /** Relayed (send_signal): the database's sender, not the message's. */
  from: string;
  /** The sender's join: a new one means the peer started over and its old connection is dead. */
  session?: string;
  to?: string;
  data: any;
  timestamp: number;
}

export interface ChannelState {
  participants: UserMediaState[];
  channelId: string;
}

function newSessionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isLost(connection: UserConnection): boolean {
  const { connectionState } = connection.peerConnection;
  return connectionState === 'failed' || connectionState === 'closed';
}

function cancelled(): DOMException {
  return new DOMException('Connection cancelled', 'AbortError');
}

function silentState(userId: string): UserMediaState {
  return {
    userId,
    isAudioEnabled: true,
    isVideoEnabled: false,
    isScreenSharing: false,
    isMuted: false,
    isDeafened: false,
    isSpeaking: false,
    audioLevel: 0,
  };
}

// MAIN WEBRTC SERVICE

export class UnifiedWebRTCService {
  private channelId: string | null = null;
  private currentUserId: string | null = null;
  private signalChannel: RebuildingChannel | null = null;
  // Ends a setupSignaling that is still waiting for its topic.
  private cancelSignaling: (() => void) | null = null;
  private resyncUntil = 0;
  // This client's join, empty outside one, and each peer's latest (SignalingMessage.session).
  private sessionId = '';
  private peerSessions = new Map<string, string>();
  // Each peer's session that said user-left: what it sent before can arrive after.
  private leftSessions = new Map<string, string>();
  // Outgoing messages in order, one request in flight (signalRelay.sendSignal); a request carries
  // the run of messages queued meanwhile.
  private signalQueue: Array<{
    room: string;
    from: string;
    channel: RebuildingChannel;
    message: Omit<SignalingMessage, 'from'>;
  }> = [];
  private signalFlushing = false;
  private signalFlush: Promise<void> = Promise.resolve();
  private iceServers: RTCIceServer[] = [...DEFAULT_ICE_SERVERS];

  // Local media and state
  // localStream carries mic + camera; the screenshare gets its own stream so
  // both video feeds can be published at once and told apart by stream id.
  private localStream: MediaStream | null = null;
  private localScreenStream: MediaStream | null = null;
  private cameraVideoTrackId: string | null = null;
  // Screen stream ids announced by peers (via media-state / state-sync),
  // used to classify incoming streams as camera/mic vs screenshare
  private announcedScreenStreamIds = new Map<string, string | null>();
  // PTT gate: closed = mic track disabled without touching the user's explicit mute state
  private pttGateOpen = true;
  private localMediaState: UserMediaState = {
    userId: '',
    isAudioEnabled: true,
    isVideoEnabled: false,
    isScreenSharing: false,
    isMuted: false,
    isDeafened: false,
    isSpeaking: false,
    audioLevel: 0,
  };
  
  // Remote connections and states
  private connections = new Map<string, UserConnection>();
  private allUserStates = new Map<string, UserMediaState>();
  
  // Event system
  private eventListeners = new Map<string, Function[]>();
  
  // Audio context for level monitoring
  private audioContext: AudioContext | null = null;
  private localAudioAnalyser: AnalyserNode | null = null;
  // RAF handle, so device/constraint changes cancel the previous
  // loop before starting a new one. Overlapping loops all read
  // `localAudioAnalyser` and broadcast audio levels in lockstep.
  private audioLevelRafId: number | null = null;
  
  // Audio constraints settings
  private audioConstraints = {
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: true,
    sampleRate: 48000
  };

  // Stream quality settings (shared format with LiveKit)
  private streamQualitySettings = {
    resolution: 720,    // Default 720p
    frameRate: 30,      // Default 30fps
    audioBitrate: 128,  // Default 128kbps
  };

  // Device selection
  private selectedInputDevice: string | null = null;
  private selectedOutputDevice: string | null = null;
  private selectedVideoDevice: string | null = null;

  // Input volume. localStream's audio track is the outgoing mic: the gain
  // stage output off unity, else the capture track itself.
  private inputVolume = INPUT_VOLUME_UNITY;
  private rawMicTrack: MediaStreamTrack | null = null;
  private micGainStage: MicGainStage | null = null;
  private micGainReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  
  constructor() {
    this.setupCleanup();
    this.loadAudioSettings();
    this.loadStreamQualitySettings();
    this.setupSettingsListener();
  }

  private loadStreamQualitySettings(): void {
    try {
      const saved = userStorage.getItem('stream-quality');
      if (saved) {
        const settings = JSON.parse(saved);
        this.streamQualitySettings = {
          resolution: settings.resolution ?? 720,
          frameRate: settings.frameRate ?? 30,
          audioBitrate: settings.audioBitrate ?? 128,
        };
        debug.log('[P2P] Loaded stream quality settings:', this.streamQualitySettings);
      }
    } catch (error) {
      debug.warn('[P2P] Failed to load stream quality settings:', error);
    }
  }

  private saveStreamQualitySettings(): void {
    try {
      userStorage.setItem('stream-quality', JSON.stringify(this.streamQualitySettings));
    } catch (error) {
      debug.warn('[P2P] Failed to save stream quality settings:', error);
    }
  }

  /** @param resolution - height in pixels: 360, 480, 720, 1080, or -1 for source. */
  private getVideoConstraints(resolution: number = this.streamQualitySettings.resolution): MediaTrackConstraints {
    const frameRate = this.streamQualitySettings.frameRate;
    
    switch (resolution) {
      case 360:
        return { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: frameRate } };
      case 480:
        return { width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: frameRate } };
      case 720:
        return { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: frameRate } };
      case 1080:
        return { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: frameRate } };
      case -1: // Source/Native - use max available
        return { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: frameRate } };
      default: {
        const width = Math.round(resolution * 16 / 9);
        return { width: { ideal: width }, height: { ideal: resolution }, frameRate: { ideal: frameRate } };
      }
    }
  }

  /** Applies to the currently active video/screenshare tracks. */
  async updateStreamQuality(settings: { resolution?: number; frameRate?: number; audioBitrate?: number }): Promise<void> {
    debug.log('[P2P] Updating stream quality:', settings);
    
    if (settings.resolution !== undefined) {
      this.streamQualitySettings.resolution = settings.resolution;
    }
    if (settings.frameRate !== undefined) {
      this.streamQualitySettings.frameRate = settings.frameRate;
    }
    if (settings.audioBitrate !== undefined) {
      this.streamQualitySettings.audioBitrate = settings.audioBitrate;
    }
    
    this.saveStreamQualitySettings();
    
    if (this.localStream) {
      const videoTracks = this.localStream.getVideoTracks();
      for (const track of videoTracks) {
        try {
          const constraints = this.getVideoConstraints();
          await track.applyConstraints(constraints);
          debug.log('[P2P] Applied video constraints:', constraints);
        } catch (error) {
          debug.warn('[P2P] Failed to apply video constraints:', error);
        }
      }
    }
    
    debug.log('[P2P] Stream quality updated:', this.streamQualitySettings);
  }

  // PUBLIC API

  /** Selects the input device and swaps the live audio track. */
  async updateInputDevice(deviceId: string): Promise<void> {
    debug.log('Updating input device to:', deviceId);
    
    this.selectedInputDevice = deviceId;
    this.saveAudioSettings(); // Use existing method
    
    // Connected: swap the live audio track.
    if (this.localStream && this.channelId) {

      // Acquire the new stream BEFORE stopping the old tracks.
      // Stopping first leaves the call with no mic until rejoin whenever
      // `getUserMedia` fails (permission revoked, device gone,
      // OverconstrainedError).
      try {
        const audioConstraints: MediaTrackConstraints = {
          ...this.audioConstraints,
          deviceId: { exact: deviceId }
        };

        const newAudioStream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: false
        });

        const newAudioTrack = newAudioStream.getAudioTracks()[0];
        if (newAudioTrack) {
          // Swap is committed: route the new capture, then stop the old one.
          await this.installCapturedMic(newAudioTrack);

          debug.log('Input device updated successfully');
          this.emit('local-stream-changed', this.localStream);
          this.emit('stream-changed', { userId: this.currentUserId, stream: this.localStream, type: 'local' });
        }
      } catch (error) {
        debug.error('Failed to update input device:', error);
        this.emit('error', error);
        throw error;
      }
    }
  }

  /** Applies the output device to every remote audio element. */
  async updateOutputDevice(deviceId: string): Promise<void> {
    debug.log('Updating output device to:', deviceId);
    
    this.selectedOutputDevice = deviceId;
    this.saveAudioSettings(); // Use existing method
    
    // setSinkId belongs to the Audio Output Devices API and is absent from
    // the lib.dom HTMLAudioElement type; cast to any.
    for (const [userId, connection] of this.connections) {
      const audioEl = connection.audioElement as any;
      if (audioEl && audioEl.setSinkId) {
        try {
          await audioEl.setSinkId(deviceId);
          debug.log('Updated output device for user:', userId);
        } catch (error) {
          debug.error('Failed to update output device for user:', userId, error);
        }
      }
    }
    
    debug.log('Output device updated successfully');
  }

  /** Selects the video device and restarts the camera track when video is on. */
  async updateVideoDevice(deviceId: string): Promise<void> {
    debug.log('Updating video device to:', deviceId);
    
    this.selectedVideoDevice = deviceId;
    this.saveAudioSettings(); // Use existing method
    
    if (this.localMediaState.isVideoEnabled && this.localStream && this.channelId) {
      try {
        const videoTracks = this.localStream.getVideoTracks();
        videoTracks.forEach(track => {
          track.stop();
          this.localStream!.removeTrack(track);
        });
        
        const baseVideoConstraints = this.getVideoConstraints();
        const videoConstraints: any = {
          video: {
            deviceId: { exact: deviceId },
            ...baseVideoConstraints
          },
          audio: false
        };
        
        const newVideoStream = await navigator.mediaDevices.getUserMedia(videoConstraints);
        const newVideoTrack = newVideoStream.getVideoTracks()[0];
        
        if (newVideoTrack) {
          this.localStream.addTrack(newVideoTrack);
          const previousCameraTrackId = this.cameraVideoTrackId;
          this.cameraVideoTrackId = newVideoTrack.id;

          for (const [userId, conn] of this.connections) {
            try {
              const senders = conn.peerConnection.getSenders();
              // Only swap the camera sender - never the screenshare sender
              const videoSender = senders.find(
                s => s.track?.kind === 'video' &&
                     s.track.id !== this.screenShareVideoTrackId &&
                     (previousCameraTrackId === null || s.track.id === previousCameraTrackId || s.track.readyState === 'ended')
              );

              if (videoSender) {
                await videoSender.replaceTrack(newVideoTrack);
                debug.log('Replaced camera track for peer:', userId);
              }
            } catch (error) {
              debug.error('Error updating video track for peer', userId, ':', error);
            }
          }
          
          debug.log('Video device updated successfully');
          this.emit('local-stream-changed', this.localStream);
          this.emit('stream-changed', { userId: this.currentUserId, stream: this.localStream, type: 'local' });
        }
      } catch (error) {
        debug.error('Failed to update video device:', error);
        this.emit('error', error);
        throw error;
      }
    }
  }
  async joinChannel(channelId: string, userId: string, abortSignal?: AbortSignal): Promise<boolean> {
    debug.log('Joining voice channel:', channelId, 'as user:', userId);
    let session = '';
    // Throws once the join is cancelled, leaving what it opened, or has ended: a leave or a later
    // join took its place and holds the service.
    const stillJoining = async (): Promise<void> => {
      const ended = this.sessionId !== session;
      if (!ended && !abortSignal?.aborted) return;
      if (!ended) await this.leaveChannel();
      throw cancelled();
    };
    
    try {
      if (abortSignal?.aborted) {
        throw cancelled();
      }
      
      if (this.channelId) {
        await this.leaveChannel();
      }
      
      if (abortSignal?.aborted) {
        throw cancelled();
      }
      
      this.channelId = channelId;
      this.currentUserId = userId;
      this.localMediaState.userId = userId;
      session = this.sessionId = newSessionId();
      const iceServers = loadIceServers();

      // 1. Audio first - a voice channel always carries audio.
      await this.initializeLocalAudio(session);
      // fresh tracks start enabled; re-apply mute/PTT gate before audio flows
      this.applyMicGate();
      this.iceServers = await iceServers;
      await stillJoining();
      
      // 2. Signaling must be up before presence is announced.
      await this.setupSignaling();
      await stillJoining();
      
      // 3. Pull current channel state from existing members.
      await this.requestChannelState();
      await stillJoining();
      
      // 4. Announce presence, after state sync.
      setTimeout(() => {
        if (!abortSignal?.aborted && this.sessionId === session) {
          this.broadcastMessage({
            type: 'user-joined',
            from: userId,
            data: { mediaState: this.localMediaState },
            timestamp: Date.now()
          });
        }
      }, 200);
      
      this.emit('channel-joined', { channelId, userId });
      this.emit('local-state-changed', this.localMediaState);
      
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        debug.log('[P2P] Connection cancelled');
        throw error; // Re-throw to propagate cancellation
      }
      debug.error('Failed to join channel:', error);
      // A later join owns the service once it has its own session.
      if (session && this.sessionId === session) await this.teardown(false);
      this.emit('error', error);
      return false;
    }
  }

  /** `silent`: nothing is sent, queued signals included. */
  async leaveChannel({ silent = false }: { silent?: boolean } = {}): Promise<void> {
    debug.log('Leaving voice channel');
    
    if (!silent && this.currentUserId && this.channelId) {
      this.broadcastMessage({
        type: 'user-left',
        from: this.currentUserId,
        data: {},
        timestamp: Date.now()
      });
    }
    
    const oldChannelId = this.channelId;
    await this.teardown(!silent);
    
    this.emit('channel-left', { channelId: oldChannelId });
  }

  /**
   * Releases everything a join opened: peers, tracks, topic, level monitoring. No event and no
   * message; a second run finds nothing left. `sendQueued`: signals already queued still go out,
   * and the topic, which a client broadcast needs, closes after them; otherwise they are dropped.
   */
  private async teardown(sendQueued: boolean): Promise<void> {
    const signalChannel = this.signalChannel;
    const audioContext = this.audioContext;
    this.signalChannel = null;
    this.audioContext = null;
    this.channelId = null;
    this.currentUserId = null;
    this.sessionId = '';
    this.cancelSignaling?.();
    this.cancelSignaling = null;
    if (!sendQueued) this.signalQueue = [];

    this.connections.forEach(conn => this.closeConnection(conn));
    this.connections.clear();
    this.allUserStates.clear();
    this.peerSessions.clear();
    this.leftSessions.clear();
    
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
    this.teardownMicGain();
    this.rawMicTrack?.stop();
    this.rawMicTrack = null;

    if (this.localScreenStream) {
      this.localScreenStream.getTracks().forEach(track => track.stop());
      this.localScreenStream = null;
    }
    this.announcedScreenStreamIds.clear();
    this.cameraVideoTrackId = null;
    this.screenShareVideoTrackId = null;
    this.screenShareAudioTrackId = null;
    this.localMediaState.isVideoEnabled = false;
    this.localMediaState.isScreenSharing = false;

    // Cancel the RAF explicitly, symmetric with setup. The
    // loop also self-terminates next frame via the `else` branch in
    // `updateLevel` once `audioContext` is null; the explicit cancel
    // keeps that from being load-bearing.
    if (this.audioLevelRafId !== null) {
      cancelAnimationFrame(this.audioLevelRafId);
      this.audioLevelRafId = null;
    }
    if (this.localAudioAnalyser) {
      try { this.localAudioAnalyser.disconnect(); } catch { /* noop */ }
      this.localAudioAnalyser = null;
    }

    const sent = sendQueued ? this.queuedSignalsSent() : Promise.resolve();
    if (!relaysSignals()) await sent;
    await Promise.all([sent, signalChannel?.close(), audioContext?.close()]);
  }

  /** Once the queue is empty, at the latest LEAVE_SEND_TIMEOUT_MS from now. */
  private async queuedSignalsSent(): Promise<void> {
    if (!this.signalFlushing) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.signalFlush,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, LEAVE_SEND_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
  }

  async toggleVideo(): Promise<boolean> {
    const session = this.sessionId;
    try {
      if (!this.localMediaState.isVideoEnabled) {
        // Enable video (screenshare, if active, keeps its own stream/senders)
        debug.log('Enabling video camera...');
        
        const { videoDevice } = this.getSelectedDevices();
        
        // Use stream quality settings
        const baseVideoConstraints = this.getVideoConstraints();
        const videoConstraints: any = {
          video: { ...baseVideoConstraints },
          audio: false
        };
        
        if (videoDevice) {
          videoConstraints.video.deviceId = { exact: videoDevice };
          debug.log('Using selected video device:', videoDevice);
        }
        
        const videoStream = await navigator.mediaDevices.getUserMedia(videoConstraints);
        // The call the camera was asked for has ended.
        if (this.sessionId !== session || !this.localStream) {
          videoStream.getTracks().forEach(track => track.stop());
          return this.localMediaState.isVideoEnabled;
        }
        const videoTrack = videoStream.getVideoTracks()[0];
        
        if (!videoTrack) {
          throw new Error('No video track obtained from camera');
        }
        
        debug.log('Video track obtained:', videoTrack.getSettings());
        
        if (this.localStream) {
          // Existing video tracks must be removed before adding the new one.
          const existingVideoTracks = this.localStream.getVideoTracks();
          existingVideoTracks.forEach(track => {
            debug.log('Stopping and removing old video track:', track.id);
            track.stop();
            this.localStream!.removeTrack(track);
          });
          
          this.localStream.addTrack(videoTrack);
          this.cameraVideoTrackId = videoTrack.id;
          this.localMediaState.isVideoEnabled = true;

          debug.log('Local stream now has', this.localStream.getTracks().length, 'tracks');

          for (const [userId, conn] of this.connections) {
            try {
              // Never touch the screenshare sender - only reuse a camera sender
              const existingSenders = conn.peerConnection.getSenders();
              const cameraSender = existingSenders.find(
                s => s.track?.kind === 'video' && s.track.id !== this.screenShareVideoTrackId
              );

              if (cameraSender && cameraSender.track) {
                // Replace existing camera track (no renegotiation needed)
                debug.log('Replacing existing camera track for peer:', userId);
                await cameraSender.replaceTrack(videoTrack);
              } else {
                debug.log('Adding camera track for peer:', userId);
                conn.peerConnection.addTrack(videoTrack, this.localStream);
                await this.renegotiateWithPeer(userId, conn);
              }
            } catch (error) {
              debug.error('Error adding video track to peer', userId, ':', error);
            }
          }
          
          // Self-view renders off this event.
          this.emit('local-stream-changed', this.localStream);
          debug.log('Emitted local-stream-changed event for self-view update');
        }
      } else {
        debug.log('Disabling video camera...');
        
        if (this.localStream) {
          const videoTracks = this.localStream.getVideoTracks();

          for (const track of videoTracks) {
            debug.log('Stopping video track:', track.id);
            track.stop();
            this.localStream.removeTrack(track);

            for (const [userId, conn] of this.connections) {
              try {
                const senders = conn.peerConnection.getSenders();
                const videoSender = senders.find(s => s.track === track);

                if (videoSender) {
                  debug.log('Removing video track from peer:', userId);
                  conn.peerConnection.removeTrack(videoSender);
                  await this.renegotiateWithPeer(userId, conn);
                }
              } catch (error) {
                debug.error('Error removing video track from peer', userId, ':', error);
              }
            }
          }

          this.cameraVideoTrackId = null;
          this.localMediaState.isVideoEnabled = false;
          debug.log('Video disabled, local stream now has', this.localStream.getTracks().length, 'tracks');
          
          this.emit('local-stream-changed', this.localStream);
          debug.log('Emitted local-stream-changed event (video disabled)');
        }
      }
      
      await this.broadcastMediaState();
      this.emit('local-state-changed', this.localMediaState);
      
      return this.localMediaState.isVideoEnabled;
    } catch (error) {
      debug.error('Error toggling video:', error);
      
      if (this.sessionId !== session) return this.localMediaState.isVideoEnabled;
      this.localMediaState.isVideoEnabled = false;
      return false;
    }
  }

  private screenShareVideoTrackId: string | null = null;
  private screenShareAudioTrackId: string | null = null;
  
  async toggleScreenShare(): Promise<boolean> {
    const session = this.sessionId;
    try {
      if (!this.localMediaState.isScreenSharing) {
        // Resolution and framerate come from the stream quality settings.
        const screenVideoConstraints = this.getVideoConstraints();
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: screenVideoConstraints.width,
            height: screenVideoConstraints.height,
            frameRate: screenVideoConstraints.frameRate
          },
          audio: true // Include system audio for app streaming
        });
        // The call the screen was picked for has ended.
        if (this.sessionId !== session) {
          screenStream.getTracks().forEach(track => track.stop());
          return this.localMediaState.isScreenSharing;
        }
        
        const screenVideoTrack = screenStream.getVideoTracks()[0];
        const screenAudioTrack = screenStream.getAudioTracks()[0]; // System audio
        
        this.screenShareVideoTrackId = screenVideoTrack?.id || null;
        this.screenShareAudioTrackId = screenAudioTrack?.id || null;
        
        debug.log('Screen share tracks:', {
          video: screenVideoTrack?.id,
          audio: screenAudioTrack?.id,
          audioLabel: screenAudioTrack?.label
        });
        
        if (screenVideoTrack) {
          // Screenshare lives in its own MediaStream: the stream id travels in
          // the SDP msid, so receivers can tell it apart from the camera feed.
          // Camera state is untouched - both can be live at once.
          this.localScreenStream = new MediaStream([screenVideoTrack]);
          debug.log('Created screen stream:', this.localScreenStream.id);

          if (screenAudioTrack) {
            this.localScreenStream.addTrack(screenAudioTrack);
            debug.log('Screen sharing with system audio enabled');
          }

          this.localMediaState.isScreenSharing = true;

          // Add both screen tracks to every peer, then renegotiate once
          for (const [userId, conn] of this.connections) {
            try {
              conn.peerConnection.addTrack(screenVideoTrack, this.localScreenStream);
              if (screenAudioTrack) {
                conn.peerConnection.addTrack(screenAudioTrack, this.localScreenStream);
              }
              debug.log('Added screen track(s) to peer:', userId);
              await this.renegotiateWithPeer(userId, conn);
            } catch (error) {
              debug.error('Error updating screen share for peer', userId, ':', error);
            }
          }

          screenVideoTrack.onended = () => {
            debug.log('Screen video track ended');
            if (this.localMediaState.isScreenSharing) {
              this.toggleScreenShare();
            }
          };
          
          if (screenAudioTrack) {
            screenAudioTrack.onended = () => {
              debug.log('Screen audio track ended');
              // Audio ending does not stop the screenshare; video may continue.
              this.screenShareAudioTrackId = null;
            };
          }
        }
      } else {
        debug.log('Stopping screen share, cleaning up tracks:', {
          videoTrackId: this.screenShareVideoTrackId,
          audioTrackId: this.screenShareAudioTrackId
        });

        if (this.localScreenStream) {
          const screenTrackIds = new Set(
            this.localScreenStream.getTracks().map(t => t.id)
          );

          this.localScreenStream.getTracks().forEach(track => {
            debug.log('Stopping screen track:', track.kind, track.id);
            track.stop();
          });
          this.localScreenStream = null;

          // Remove the screen senders from every peer, then renegotiate once each, all peers at
          // once: one peer slow to reach a stable state does not hold the others.
          await Promise.allSettled([...this.connections].map(async ([userId, conn]) => {
            try {
              let removed = false;
              for (const sender of conn.peerConnection.getSenders()) {
                if (sender.track && screenTrackIds.has(sender.track.id)) {
                  // removeTrack nulls sender.track.
                  const kind = sender.track.kind;
                  conn.peerConnection.removeTrack(sender);
                  removed = true;
                  debug.log('Removed screen sender from peer:', userId, kind);
                }
              }
              if (removed) {
                await this.renegotiateWithPeer(userId, conn);
              }
            } catch (error) {
              debug.error('Error removing screen tracks from peer', userId, ':', error);
            }
          }));
        }

        this.screenShareVideoTrackId = null;
        this.screenShareAudioTrackId = null;
        this.localMediaState.isScreenSharing = false;
      }
      
      await this.broadcastMediaState();
      this.emit('local-state-changed', this.localMediaState);
      
      return this.localMediaState.isScreenSharing;
    } catch (error) {
      debug.error('Error toggling screen share:', error);
      return false;
    }
  }

  // mic track transmits only when unmuted AND (voice activity mode OR PTT held)
  private isMicGated(): boolean {
    return this.localMediaState.isMuted || !this.pttGateOpen;
  }

  private applyMicGate(): void {
    const audioTrack = this.localStream?.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !this.isMicGated();
    }
    this.localMediaState.isSpeaking = this.calculateSpeakingState(this.localMediaState.audioLevel, this.isMicGated());
  }

  toggleMute(): boolean {
    this.setMuted(!this.localMediaState.isMuted);
    return this.localMediaState.isMuted;
  }

  /**
   * Set explicit mute state (user intent — broadcast to peers)
   */
  setMuted(muted: boolean): void {
    if (this.localMediaState.isMuted === muted) return; // No change

    this.localMediaState.isMuted = muted;
    this.applyMicGate();

    this.broadcastMediaState();
    this.emit('local-state-changed', this.localMediaState);
  }

  /**
   * Open/close the PTT transmit gate — no mute state change, nothing broadcast
   */
  setTransmitGate(open: boolean): void {
    if (this.pttGateOpen === open) return;
    this.pttGateOpen = open;
    this.applyMicGate();
  }

  toggleDeafen(): boolean {
    this.localMediaState.isDeafened = !this.localMediaState.isDeafened;
    
    // When deafened, also mute
    if (this.localMediaState.isDeafened) {
      this.localMediaState.isMuted = true;
      if (this.localStream) {
        const audioTrack = this.localStream.getAudioTracks()[0];
        if (audioTrack) {
          audioTrack.enabled = false;
        }
      }
    }
    
    // Check spatial audio state to avoid double audio on undeafen
    let isSpatialAudioActive = false;
    try {
      const spatialStore = useSpatialAudioStore();
      const spatialStatus = spatialAudioService.getStatus();
      isSpatialAudioActive = spatialStore.settings.enabled && spatialStatus.isInitialized;
      
      spatialAudioService.setDeafened(this.localMediaState.isDeafened);
    } catch (e) {
      // No active Pinia (tests, teardown): spatial audio is off.
    }
    
    // On undeafen the traditional path stays muted while spatial audio is active.
    this.connections.forEach(conn => {
      if (conn.audioElement) {
        conn.audioElement.muted = this.localMediaState.isDeafened || isSpatialAudioActive;
        debug.log('Audio element for', conn.userId, conn.audioElement.muted ? 'muted' : 'unmuted',
                  '(deafened:', this.localMediaState.isDeafened, 'spatialActive:', isSpatialAudioActive, ')');
      }
      // Screen audio is never spatialized - only deafen affects it
      if (conn.screenAudioElement) {
        conn.screenAudioElement.muted = this.localMediaState.isDeafened;
      }
    });
    
    this.broadcastMediaState();
    this.emit('local-state-changed', this.localMediaState);
    
    return this.localMediaState.isDeafened;
  }

  // GETTERS

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getLocalState(): UserMediaState {
    return { ...this.localMediaState };
  }

  getUserStream(userId: string): MediaStream | null {
    if (userId === this.currentUserId) {
      return this.localStream;
    }
    return this.connections.get(userId)?.remoteStream || null;
  }

  /** The user's screenshare stream (camera/mic live in getUserStream) */
  getUserScreenStream(userId: string): MediaStream | null {
    if (userId === this.currentUserId) {
      return this.localScreenStream;
    }
    return this.connections.get(userId)?.remoteScreenStream || null;
  }

  getUserState(userId: string): UserMediaState | null {
    if (userId === this.currentUserId) {
      return { ...this.localMediaState };
    }
    return this.allUserStates.get(userId) || null;
  }

  getAllUsers(): UserMediaState[] {
    const users: UserMediaState[] = [{ ...this.localMediaState }];
    this.allUserStates.forEach(state => {
      if (state.userId !== this.currentUserId) {
        users.push({ ...state });
      }
    });
    return users;
  }

  getConnectionState(userId: string): RTCPeerConnectionState | null {
    return this.connections.get(userId)?.connectionState || null;
  }

  getUserAudioElement(userId: string): HTMLAudioElement | null {
    const connection = this.connections.get(userId);
    return connection ? connection.audioElement : null;
  }

  // EVENT SYSTEM

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
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
  }

  private emit(event: string, data?: any): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          debug.error('Error in event listener:', error);
        }
      });
    }
  }

  // PRIVATE METHODS

  // INPUT VOLUME

  /** Outgoing mic level, percent 0-200. Applied live; unity sends the capture track untouched. */
  setInputVolume(percent: number): void {
    this.inputVolume = clampInputVolume(percent);
    if (!this.rawMicTrack || !this.localStream) return;
    if (needsGainStage(this.inputVolume)) {
      this.clearMicGainRelease();
      void this.routeMic(this.rawMicTrack).then(next => this.swapOutgoingMic(next));
      return;
    }
    if (!this.micGainStage) return;
    this.micGainStage.setGain(1);
    if (this.micGainReleaseTimer) return;
    this.micGainReleaseTimer = setTimeout(() => {
      this.micGainReleaseTimer = null;
      if (needsGainStage(this.inputVolume) || !this.rawMicTrack) return;
      void this.swapOutgoingMic(this.rawMicTrack).then(() => this.teardownMicGain());
    }, UNITY_RELEASE_MS);
  }

  /**
   * Outgoing track for a capture track: the gain stage output off unity (or
   * while a stage is still settling back to unity), else the capture itself.
   */
  private async routeMic(captured: MediaStreamTrack): Promise<MediaStreamTrack> {
    this.rawMicTrack = captured;
    if (!needsGainStage(this.inputVolume) && !this.micGainStage) return captured;
    if (!this.micGainStage) {
      this.micGainStage = new MicGainStage({
        // Context lost: the unscaled mic beats a silent one.
        onInterrupted: () => {
          if (this.rawMicTrack) void this.swapOutgoingMic(this.rawMicTrack).then(() => this.teardownMicGain());
        },
      });
    }
    const stage = this.micGainStage;
    stage.setGain(needsGainStage(this.inputVolume) ? inputGain(this.inputVolume) : 1);
    const out = await stage.connect(captured);
    if (!out) {
      if (this.micGainStage === stage) this.teardownMicGain();
      return captured;
    }
    return out;
  }

  /** Puts a new capture track in service and stops the previous capture. */
  private async installCapturedMic(captured: MediaStreamTrack): Promise<void> {
    const previousCapture = this.rawMicTrack;
    const outgoing = await this.routeMic(captured);
    await this.swapOutgoingMic(outgoing);
    if (previousCapture && previousCapture !== captured) previousCapture.stop();
  }

  /** Makes `next` the outgoing mic in localStream and on every peer's sender. */
  private async swapOutgoingMic(next: MediaStreamTrack): Promise<void> {
    if (!this.localStream) return;
    const previous = this.localStream.getAudioTracks()[0] ?? null;
    if (previous === next) return;
    if (previous) this.localStream.removeTrack(previous);
    this.localStream.addTrack(next);
    next.enabled = !this.isMicGated();

    for (const [userId, conn] of this.connections) {
      try {
        // By track identity: screen share audio is an audio sender too.
        const sender = previous ? conn.peerConnection.getSenders().find(s => s.track === previous) : undefined;
        if (sender) await sender.replaceTrack(next);
      } catch (error) {
        debug.error('Error updating audio track for peer', userId, ':', error);
      }
    }

    this.setupAudioLevelMonitoring();
    this.emit('local-stream-changed', this.localStream);
  }

  private teardownMicGain(): void {
    this.clearMicGainRelease();
    this.micGainStage?.destroy();
    this.micGainStage = null;
  }

  private clearMicGainRelease(): void {
    if (this.micGainReleaseTimer) {
      clearTimeout(this.micGainReleaseTimer);
      this.micGainReleaseTimer = null;
    }
  }

  private calculateSpeakingState(audioLevel: number, isMuted: boolean): boolean {
    return audioLevel > 20 && !isMuted;
  }

  /** Opens the microphone for the join `session`. One whose join has ended meanwhile is stopped. */
  private async initializeLocalAudio(session: string): Promise<void> {
    // The permission prompt outlives the join: its answer can come during a later one.
    const capture = async (audio: MediaTrackConstraints): Promise<MediaStream> => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      if (this.sessionId === session) return stream;
      stream.getTracks().forEach(track => track.stop());
      throw cancelled();
    };
    try {
      const { inputDevice } = this.getSelectedDevices();
      const audioConstraints: MediaTrackConstraints = {
        ...this.audioConstraints
      };

      // 'ideal', not 'exact': a missing device falls back instead of throwing.
      if (inputDevice) {
        audioConstraints.deviceId = { ideal: inputDevice };
        debug.log('Using selected input device for constraint update:', inputDevice);
      }

      let newAudioStream: MediaStream;

      try {
        newAudioStream = await capture(audioConstraints);
      } catch (error) {
        if (this.sessionId !== session) throw cancelled();
        debug.warn('Failed to use selected device during constraint update, falling back to default:', error);
        
        this.selectedInputDevice = null;
        this.saveAudioSettings();
        
        const fallbackConstraints: MediaTrackConstraints = {
          ...this.audioConstraints
          // No deviceId - let browser choose
        };
        
        newAudioStream = await capture(fallbackConstraints);
        
        debug.log('Using default audio device as fallback during constraint update');
      }

      this.inputVolume = clampInputVolume(VoiceSettingsService.getAll().inputVolume);
      const captured = newAudioStream.getAudioTracks()[0];
      const outgoing = captured ? await this.routeMic(captured) : null;
      if (this.sessionId !== session) {
        captured?.stop();
        throw cancelled();
      }
      this.localStream = outgoing && outgoing !== captured ? new MediaStream([outgoing]) : newAudioStream;

      const audioTrack = this.localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !this.localMediaState.isMuted;
      }
      
      this.setupAudioLevelMonitoring();
      
      this.emit('local-stream-changed', this.localStream);
      this.emit('stream-changed', { userId: this.currentUserId, stream: this.localStream, type: 'local' });
    } catch (error) {
      debug.error('Failed to get audio stream:', error);
      throw error;
    }
  }
  private setupAudioLevelMonitoring(): void {
    if (!this.localStream) return;

    // Tear down the previous context and cancel its RAF before
    // constructing the new one. This method also runs on the device- and
    // constraint-change paths via `updateInputDevice`; without the teardown
    // each mid-call switch leaks an AudioContext plus a live RAF loop until
    // `leaveChannel()`.
    if (this.audioLevelRafId !== null) {
      cancelAnimationFrame(this.audioLevelRafId);
      this.audioLevelRafId = null;
    }
    if (this.localAudioAnalyser) {
      try { this.localAudioAnalyser.disconnect(); } catch { /* noop */ }
      this.localAudioAnalyser = null;
    }
    if (this.audioContext) {
      const prev = this.audioContext;
      this.audioContext = null;
      prev.close().catch(err => debug.warn('Failed to close prior AudioContext:', err));
    }

    try {
      this.audioContext = new AudioContext();
      this.localAudioAnalyser = this.audioContext.createAnalyser();
      const source = this.audioContext.createMediaStreamSource(this.localStream);
      
      source.connect(this.localAudioAnalyser);
      this.localAudioAnalyser.fftSize = 256;
      
      const dataArray = new Uint8Array(this.localAudioAnalyser.frequencyBinCount);
      
      let lastBroadcast = 0;
      const updateLevel = () => {
        if (this.localAudioAnalyser && this.audioContext?.state === 'running') {
          this.localAudioAnalyser.getByteFrequencyData(dataArray);
          const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
          this.localMediaState.audioLevel = average;
          
          const wasSpeaking = this.localMediaState.isSpeaking;
          this.localMediaState.isSpeaking = this.calculateSpeakingState(average, this.isMicGated());

          this.emit('audio-level', { userId: this.currentUserId, level: average });

          // Peers on a relaying instance read speaking from the received track (setupRemoteAudio).
          // Peers of an older instance read it from these broadcasts: every 100 ms while speaking.
          const now = Date.now();
          if (!relaysSignals() && (average > 20 || now - lastBroadcast > 1000) && now - lastBroadcast > 100) {
            this.broadcastAudioLevel();
            lastBroadcast = now;
          }

          if (!relaysSignals() && wasSpeaking !== this.localMediaState.isSpeaking) {
            this.broadcastMediaState();
            // NOTE: 'local-state-changed' is not emitted here; components react
            // to audioLevel directly, and the extra event breaks their reactivity.
          }

          this.audioLevelRafId = requestAnimationFrame(updateLevel);
        } else {
          this.audioLevelRafId = null;
        }
      };
      
      this.audioLevelRafId = requestAnimationFrame(updateLevel);
    } catch (error) {
      debug.warn('Audio level monitoring setup failed:', error);
    }
  }

  /**
   * harmony-voice-<room>: read under voice room access (can_subscribe_to_topic). A server close
   * reopens it (openRebuildingChannel); messages of the gap are lost, so a resumed topic asks the
   * room for its state again and offers to members it holds no connection with.
   */
  private async setupSignaling(): Promise<void> {
    if (!this.channelId || !this.currentUserId) {
      throw new Error('Channel ID or User ID not set');
    }

    let settle: ((error?: Error) => void) | null = null;
    const ready = new Promise<void>((resolve, reject) => {
      settle = (error) => (error ? reject(error) : resolve());
    });
    const timer = setTimeout(() => settle?.(new Error('Failed to setup signaling: no answer')), SIGNAL_JOIN_TIMEOUT_MS);
    this.cancelSignaling = () => {
      clearTimeout(timer);
      settle?.(new DOMException('Connection cancelled', 'AbortError'));
      settle = null;
    };

    this.signalChannel = openRebuildingChannel({
      topic: `harmony-voice-${this.channelId}`,
      config: { broadcast: { self: false, ack: true } },
      bind: (channel) => {
        channel.on('broadcast', { event: 'signals' }, (payload) => {
          this.handleRelayed(payload.payload);
        });

        // Client broadcasts: only an instance without send_signal admits them on this topic.
        channel.on('broadcast', { event: 'signal' }, (payload) => {
          this.handleSignalingMessage(payload.payload as SignalingMessage);
        });

        channel.on('broadcast', { event: 'audio-level' }, (payload) => {
          const userId = (payload.payload as { userId?: unknown } | null)?.userId;
          if (typeof userId === 'string' && !speakingDetector.covers(userId)) this.handleAudioLevel(payload.payload);
        });

        channel.on('broadcast', { event: SOUNDBOARD_P2P_EVENT }, (payload) => {
          this.handleSoundboard(payload.payload);
        });
      },
      onSubscribed: (resumed) => {
        if (settle) {
          debug.log('Signaling channel ready');
          clearTimeout(timer);
          settle();
          settle = null;
        } else if (resumed) {
          debug.log('Signaling channel resumed: asking the room for its state');
          this.resyncUntil = Date.now() + RESYNC_WINDOW_MS;
          void this.requestChannelState();
        }
      },
      onRefused: (error) => {
        clearTimeout(timer);
        settle?.(new Error(`Failed to setup signaling: ${error?.message ?? 'refused'}`));
        settle = null;
      },
    });

    return ready;
  }

  private async requestChannelState(): Promise<void> {
    if (!this.currentUserId) return;
    
    debug.log('Requesting channel state from existing users');
    
    this.broadcastMessage({
      type: 'state-sync',
      from: this.currentUserId,
      data: { action: 'request' },
      timestamp: Date.now()
    });
  }

  /** A send_signal broadcast: {from, messages}, `from` set by the database. */
  private handleRelayed(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const { from, messages } = raw as { from?: unknown; messages?: unknown };
    if (typeof from !== 'string' || !Array.isArray(messages)) return;
    for (const entry of messages) {
      if (!entry || typeof entry !== 'object') continue;
      const message = { ...(entry as Omit<SignalingMessage, 'from'>), from };
      if (message.type === 'soundboard') this.handleSoundboard({ from, message: message.data });
      else void this.handleSignalingMessage(message);
    }
  }

  private async handleSignalingMessage(message: SignalingMessage): Promise<void> {
    const { type, from, to, data } = message;

    // A topic being left still delivers.
    if (!this.channelId) return;
    
    // Ignore our own messages
    if (from === this.currentUserId) return;
    
    // Ignore messages not for us (except broadcasts)
    if (to && to !== this.currentUserId) return;
    
    debug.log('Received:', type, 'from:', from);

    // A peer that reloaded or crashed comes back with a new session before any user-left.
    if (message.session) {
      const known = this.peerSessions.get(from);
      if (type === 'user-left') {
        // A reload's user-left can land after the new session's first message.
        if (known && known !== message.session) return;
        this.leftSessions.set(from, message.session);
      } else if (this.leftSessions.get(from) === message.session) {
        return;
      }
      if (known !== message.session) {
        this.peerSessions.set(from, message.session);
        if (known) this.dropConnection(from);
      }
    }
    const held = this.connections.get(from);
    if (held) held.heard = true;
    
    switch (type) {
      case 'user-joined':
        await this.handleUserJoined(from, data.mediaState, !!message.session);
        break;
        
      case 'user-left':
        await this.handleUserLeft(from);
        break;
        
      case 'media-state':
        this.handleMediaStateUpdate(from, data.mediaState, data.screenStreamId);
        break;
        
      case 'state-sync':
        await this.handleStateSync(from, data);
        break;
        
      case 'call-start-time':
        // Handled by the store.
        this.emit('call-start-time', { timestamp: data.timestamp, from });
        break;
        
      case 'request-call-start-time':
        // Handled by the store.
        this.emit('request-call-start-time', { from });
        break;
        
      case 'offer':
        await this.handleOffer(from, data);
        break;
        
      case 'answer':
        await this.handleAnswer(from, data);
        break;
        
      case 'ice-candidate':
        await this.handleIceCandidate(from, data);
        break;
    }
  }

  /**
   * A peer's media state as it states its own: keyed and labelled by its sender, with speaking
   * as analysed here while speakingDetector covers it.
   */
  private peerState(userId: string, claimed: UserMediaState | undefined): UserMediaState {
    const previous = this.allUserStates.get(userId);
    const state: UserMediaState = { ...silentState(userId), ...previous, ...claimed, userId };
    if (previous && speakingDetector.covers(userId)) {
      state.isSpeaking = previous.isSpeaking;
      state.audioLevel = previous.audioLevel;
    }
    return state;
  }

  /**
   * `sessioned`: the announcement names its session, and a connection already held is with that
   * session (handleSignalingMessage drops one of an earlier session): it stays. Without a session,
   * the connection is replaced (createPeerConnection).
   */
  private async handleUserJoined(userId: string, claimed: UserMediaState, sessioned = false): Promise<void> {
    debug.log('User joined:', userId, claimed);

    const mediaState = this.peerState(userId, claimed);
    this.allUserStates.set(userId, mediaState);

    if (!sessioned || !this.connections.has(userId)) {
      await this.createPeerConnection(userId, true); // The member already in the call initiates.
    }

    this.emit('user-joined', { userId, mediaState });
  }

  /** Closes the connection with a peer and its audio. */
  private dropConnection(userId: string): void {
    const connection = this.connections.get(userId);
    if (!connection) return;
    this.closeConnection(connection);
    this.connections.delete(userId);
  }

  private closeConnection(connection: UserConnection): void {
    if (connection.lostTimer) clearTimeout(connection.lostTimer);
    connection.lostTimer = null;
    this.cleanupRemoteAudio(connection);
    connection.peerConnection.close();
  }

  /**
   * A connection that failed or closed: a page gone without a user-left (a crash, a session that
   * ended). Its member leaves after `wait` unless it recovers or the member signals meanwhile; asked
   * for its state, one still in the call with its media cut answers, and stays.
   */
  private watchPeer(connection: UserConnection, wait = PEER_LOST_GRACE_MS): void {
    const { userId } = connection;
    if (!isLost(connection) || this.connections.get(userId) !== connection) {
      if (connection.lostTimer) clearTimeout(connection.lostTimer);
      connection.lostTimer = null;
      return;
    }
    if (connection.lostTimer) return;
    connection.heard = false;
    this.sendDirectMessage(userId, {
      type: 'state-sync',
      from: this.currentUserId!,
      data: { action: 'request' },
      timestamp: Date.now()
    });
    connection.lostTimer = setTimeout(() => {
      connection.lostTimer = null;
      if (this.connections.get(userId) !== connection || !isLost(connection)) return;
      if (connection.heard) this.watchPeer(connection, PEER_RECHECK_MS);
      else void this.handleUserLeft(userId);
    }, wait);
  }

  /** A second leave of the same member says nothing. */
  private async handleUserLeft(userId: string): Promise<void> {
    debug.log('User left:', userId);
    const present = this.connections.has(userId) || this.allUserStates.has(userId);

    this.dropConnection(userId);

    this.allUserStates.delete(userId);
    this.announcedScreenStreamIds.delete(userId);
    if (present) this.emit('user-left', { userId });
  }

  private handleMediaStateUpdate(userId: string, claimed: UserMediaState, screenStreamId?: string | null): void {
    debug.log('Media state update:', userId, claimed, 'screenStreamId:', screenStreamId);

    const mediaState = this.peerState(userId, claimed);
    this.allUserStates.set(userId, mediaState);

    // Screen stream announcement may arrive before or after the tracks do;
    // re-classify whatever streams we already have from this peer
    if (screenStreamId !== undefined) {
      const previous = this.announcedScreenStreamIds.get(userId);
      this.announcedScreenStreamIds.set(userId, screenStreamId);
      if (previous !== screenStreamId) {
        const connection = this.connections.get(userId);
        if (connection) {
          this.classifyRemoteStreams(connection);
        }
      }
    }

    this.emit('user-state-changed', { userId, mediaState });
  }

  private handleAudioLevel(data: { userId: string; audioLevel: number; timestamp: number }): void {
    const { userId, audioLevel } = data;
    
    const userState = this.allUserStates.get(userId);
    if (userState) {
      const wasSpeaking = userState.isSpeaking;
      userState.audioLevel = audioLevel;
      
      userState.isSpeaking = this.calculateSpeakingState(audioLevel, userState.isMuted);
      
      this.emit('audio-level', { userId, level: audioLevel });
      
      if (wasSpeaking !== userState.isSpeaking) {
        this.emit('user-state-changed', { userId, mediaState: userState });
      }
    }
  }

  private async handleStateSync(from: string, data: any): Promise<void> {
    if (data.action === 'request') {
      // Peer requests the current state.
      debug.log('Sending our state to:', from);
      
      this.sendDirectMessage(from, {
        type: 'state-sync',
        from: this.currentUserId!,
        to: from,
        data: {
          action: 'response',
          mediaState: this.localMediaState,
          screenStreamId: this.localScreenStream?.id ?? null,
        },
        timestamp: Date.now()
      });
    } else if (data.action === 'response') {
      // Each member answers for itself; what a peer reports of others is not read.
      debug.log('Received channel state from:', from, data);

      if (data.mediaState) {
        this.allUserStates.set(from, this.peerState(from, data.mediaState));
      }

      // A member who joined while the topic was down: its user-joined never arrived here. One whose
      // connection the same outage ended gets another.
      const held = this.connections.get(from);
      const lost = !!held && isLost(held);
      if (Date.now() < this.resyncUntil && (!held || lost)) {
        await this.createPeerConnection(from, true);
        if (!held) this.emit('user-joined', { userId: from, mediaState: this.allUserStates.get(from) ?? silentState(from) });
      }

      if (data.screenStreamId !== undefined) {
        this.announcedScreenStreamIds.set(from, data.screenStreamId);
        const connection = this.connections.get(from);
        if (connection) {
          this.classifyRemoteStreams(connection);
        }
      }

      // The answer to watchPeer: the member is listed already.
      if (lost) return;
      this.emit('channel-state-synced', {
        users: Array.from(this.allUserStates.values())
      });
    }
  }

  private async createPeerConnection(userId: string, isInitiator: boolean): Promise<void> {
    debug.log('Creating peer connection with:', userId, 'as initiator:', isInitiator);

    // A connection held with the peer is replaced: closed with its audio, not left running.
    this.dropConnection(userId);

    const pc = this.newPeerConnection();

    const connection: UserConnection = {
      userId,
      peerConnection: pc,
      mediaState: this.allUserStates.get(userId) || silentState(userId),
      remoteStream: null,
      remoteScreenStream: null,
      knownStreams: new Map(),
      audioElement: null,
      screenAudioElement: null,
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      pendingIceCandidates: [],
      lostTimer: null,
      heard: false
    };

    this.connections.set(userId, connection);

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        debug.log('Adding track to peer', userId, ':', track.kind, 'enabled:', track.enabled);
        pc.addTrack(track, this.localStream!);
      });
      debug.log('Added', this.localStream.getTracks().length, 'tracks to peer connection with', userId);
    }

    // If we're mid-screenshare when this peer appears, include those tracks too
    if (this.localScreenStream) {
      this.localScreenStream.getTracks().forEach(track => {
        debug.log('Adding screen track to peer', userId, ':', track.kind);
        pc.addTrack(track, this.localScreenStream!);
      });
    }

    pc.ontrack = async (event) => {
      debug.log('Received track from:', userId, event.track.kind, 'Stream ID:', event.streams[0]?.id);

      const stream = event.streams[0];
      if (stream) {
        connection.knownStreams.set(stream.id, stream);
        await this.classifyRemoteStreams(connection);
      }
    };
    
    const sendCandidate = (candidate: RTCIceCandidate) => this.sendDirectMessage(userId, {
      type: 'ice-candidate',
      from: this.currentUserId!,
      to: userId,
      data: candidate,
      timestamp: Date.now()
    });
    // An initiator's candidates, the pooled ones among them, can be gathered before its offer is
    // sent; a peer drops a candidate that comes before the offer, as it holds no connection yet.
    let heldCandidates: RTCIceCandidate[] | null = isInitiator ? [] : null;
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      if (heldCandidates) heldCandidates.push(event.candidate);
      else sendCandidate(event.candidate);
    };
    
    pc.onconnectionstatechange = () => {
      connection.connectionState = pc.connectionState;
      this.emit('connection-state-changed', { userId, state: pc.connectionState });
      this.watchPeer(connection);
    };
    
    pc.oniceconnectionstatechange = () => {
      connection.iceConnectionState = pc.iceConnectionState;
      debug.log('ICE state for', userId, ':', pc.iceConnectionState);
    };
    
    if (isInitiator) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        this.sendDirectMessage(userId, {
          type: 'offer',
          from: this.currentUserId!,
          to: userId,
          data: offer,
          timestamp: Date.now()
        });
      } catch (error) {
        debug.error('Error creating offer for:', userId, error);
      } finally {
        const held = heldCandidates ?? [];
        heldCandidates = null;
        held.forEach(sendCandidate);
      }
    }
  }

  /** The instance's ICE servers; the defaults when RTCPeerConnection refuses them. */
  private newPeerConnection(): RTCPeerConnection {
    try {
      return new RTCPeerConnection({ iceServers: this.iceServers, iceCandidatePoolSize: 10 });
    } catch (error) {
      debug.warn('[P2P] ICE servers refused, using the defaults:', error);
      return new RTCPeerConnection({ iceServers: [...DEFAULT_ICE_SERVERS], iceCandidatePoolSize: 10 });
    }
  }

  private async handleOffer(from: string, offer: RTCSessionDescriptionInit): Promise<void> {
    debug.log('Handling offer from:', from);
    
    let connection = this.connections.get(from);
    if (!connection || isLost(connection)) {
      await this.createPeerConnection(from, false);
      connection = this.connections.get(from)!;
    } else if (connection.peerConnection.signalingState === 'have-local-offer') {
      // Offers crossed: two members joined at once, or renegotiations met. The member with the
      // greater id rolls its offer back and answers; the other keeps its offer and ignores this one
      // (the WebRTC "perfect negotiation" pattern, with the id as politeness).
      if ((this.currentUserId ?? '') < from) {
        debug.log('Offer collision with', from, '- keeping ours');
        return;
      }
      try {
        await connection.peerConnection.setLocalDescription({ type: 'rollback' });
      } catch (error) {
        debug.warn('Offer collision with', from, '- rollback failed:', error);
        return;
      }
    }

    // Ensure user is tracked in allUserStates so they appear in the participant list.
    // Offers can arrive before the state-sync response that normally adds users.
    if (!this.allUserStates.has(from)) {
      const defaultState: UserMediaState = {
        userId: from,
        isAudioEnabled: true,
        isVideoEnabled: false,
        isScreenSharing: false,
        isMuted: false,
        isDeafened: false,
        isSpeaking: false,
        audioLevel: 0,
      };
      this.allUserStates.set(from, defaultState);
      this.emit('user-joined', { userId: from, mediaState: defaultState });
      debug.log('Added user from offer to allUserStates:', from);
    }
    
    try {
      await connection.peerConnection.setRemoteDescription(offer);
      // Flush ICE candidates that arrived before the remote description was
      // set.
      await this.flushPendingIceCandidates(from);
      const answer = await connection.peerConnection.createAnswer();
      await connection.peerConnection.setLocalDescription(answer);
      
      this.sendDirectMessage(from, {
        type: 'answer',
        from: this.currentUserId!,
        to: from,
        data: answer,
        timestamp: Date.now()
      });
    } catch (error) {
      debug.error('Error handling offer from:', from, error);
    }
  }

  private async handleAnswer(from: string, answer: RTCSessionDescriptionInit): Promise<void> {
    debug.log('Handling answer from:', from);
    
    const connection = this.connections.get(from);
    if (connection) {
      try {
        await connection.peerConnection.setRemoteDescription(answer);
        // Flush ICE candidates that arrived before the answer
        // was processed.
        await this.flushPendingIceCandidates(from);
      } catch (error) {
        debug.error('Error handling answer from:', from, error);
      }
    }
  }

  private async handleIceCandidate(from: string, candidate: RTCIceCandidateInit): Promise<void> {
    const connection = this.connections.get(from);
    if (!connection) return;

    // With trickle ICE, candidates frequently arrive before the
    // remote SDP has been processed. Calling `addIceCandidate` before
    // `setRemoteDescription` throws `InvalidStateError`. Queue until the
    // remote description is set, then flush in `flushPendingIceCandidates`.
    if (!connection.peerConnection.remoteDescription) {
      // Queue cap. An authenticated peer in the same Supabase
      // voice channel can flood `ice-candidate` messages without ever sending
      // an offer. Observed real-world counts are <30 per peer, so 100 bounds
      // the memory without dropping legitimate candidates.
      const MAX_PENDING_ICE = 100;
      if (connection.pendingIceCandidates.length >= MAX_PENDING_ICE) {
        debug.warn(
          `⚠️ Dropping ICE candidate from ${from}: queue full (${MAX_PENDING_ICE}). Peer is sending candidates without an offer.`,
        );
        return;
      }
      connection.pendingIceCandidates.push(candidate);
      return;
    }

    try {
      await connection.peerConnection.addIceCandidate(candidate);
    } catch (error) {
      debug.error('Error adding ICE candidate from:', from, error);
    }
  }

  /**
   * Flush any ICE candidates queued by `handleIceCandidate` while the
   * remote description was missing. Called from both `handleOffer` (callee
   * side, after setRemoteDescription on the offer) and `handleAnswer`
   * (caller side, after setRemoteDescription on the answer).
   */
  private async flushPendingIceCandidates(from: string): Promise<void> {
    const connection = this.connections.get(from);
    if (!connection || connection.pendingIceCandidates.length === 0) return;

    const queued = connection.pendingIceCandidates.splice(0);
    debug.log(`Flushing ${queued.length} queued ICE candidates from ${from}`);
    for (const candidate of queued) {
      try {
        await connection.peerConnection.addIceCandidate(candidate);
      } catch (error) {
        debug.warn('Error adding queued ICE candidate from:', from, error);
      }
    }
  }

  /**
   * `from` is the database's on a relaying instance (handleRelayed); on an older one it is the
   * sender's own claim, and the private topic admits only the room's members.
   */
  private handleSoundboard(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const { from, message } = raw as { from?: unknown; message?: unknown };
    if (typeof from !== 'string' || from === this.currentUserId || !this.allUserStates.has(from)) return;
    this.emit('soundboard', { userId: from, message, granted: null, externalGranted: null });
  }

  sendSoundboard(message: unknown): void {
    if (!this.currentUserId) return;
    this.sendSignal({ type: 'soundboard', from: this.currentUserId, data: message, timestamp: Date.now() });
  }

  private broadcastMessage(message: SignalingMessage): void {
    this.sendSignal(message);
  }

  private sendDirectMessage(to: string, message: SignalingMessage): void {
    this.sendSignal({ ...message, to });
  }

  private sendSignal(signal: SignalingMessage): void {
    if (!this.signalChannel || !this.channelId || !this.currentUserId) return;
    const { from: _sender, ...message } = { ...signal, session: this.sessionId };
    this.signalQueue.push({ room: this.channelId, from: this.currentUserId, channel: this.signalChannel, message });
    if (!this.signalFlushing) this.signalFlush = this.flushSignals();
  }

  /** Sends the queue, one request at a time, each a run of one join's messages. */
  private async flushSignals(): Promise<void> {
    this.signalFlushing = true;
    try {
      while (this.signalQueue.length > 0) {
        const { room, from, channel } = this.signalQueue[0];
        let count = 0;
        let bytes = 0;
        while (count < this.signalQueue.length && count < RELAY_BATCH_MESSAGES && this.signalQueue[count].channel === channel) {
          bytes += JSON.stringify(this.signalQueue[count].message).length;
          if (count > 0 && bytes > RELAY_BATCH_BYTES) break;
          count++;
        }
        const batch = this.signalQueue.splice(0, count).map((entry) => entry.message);
        try {
          await sendRoomSignal(`harmony-voice-${room}`, 'signals', { messages: batch },
            () => this.broadcastSignals(channel, from, batch));
        } catch (error) {
          debug.warn('[P2P]', batch.length, 'signals refused:', (error as { message?: string })?.message ?? error);
          this.emit('error', error);
        }
      }
    } finally {
      this.signalFlushing = false;
    }
  }

  /**
   * Each message as its own client broadcast, as an instance without send_signal takes it. The
   * first outcome that is not 'ok', else 'ok'.
   */
  private async broadcastSignals(
    channel: RebuildingChannel,
    from: string,
    messages: Array<Omit<SignalingMessage, 'from'>>,
  ): Promise<string> {
    const outcomes = await Promise.all(messages.map((message) => channel.send(message.type === 'soundboard'
      ? { type: 'broadcast', event: SOUNDBOARD_P2P_EVENT, payload: { from, message: message.data } }
      : { type: 'broadcast', event: 'signal', payload: { ...message, from } }, { timeout: SIGNAL_ACK_TIMEOUT_MS })));
    return outcomes.find((outcome) => outcome !== 'ok') ?? 'ok';
  }

  /**
   * Wait for a stable signaling state, then send a fresh offer to the peer.
   * Used after addTrack/removeTrack (renegotiation).
   */
  private async renegotiateWithPeer(userId: string, conn: UserConnection): Promise<void> {
    if (conn.peerConnection.signalingState !== 'stable') {
      debug.log('⏳ Waiting for stable signaling state before renegotiation...');
      // A peer that never answered an earlier offer stays in have-local-offer, and a closed one
      // never leaves 'closed': the wait is bounded and the offer skipped.
      const deadline = Date.now() + RENEGOTIATION_STABLE_WAIT_MS;
      const stable = await new Promise<boolean>(resolve => {
        const checkState = () => {
          const state = conn.peerConnection.signalingState;
          if (state === 'stable') resolve(true);
          else if (state === 'closed' || Date.now() > deadline) resolve(false);
          else setTimeout(checkState, 100);
        };
        checkState();
      });
      if (!stable) {
        debug.warn('Renegotiation with', userId, 'skipped: signaling state', conn.peerConnection.signalingState);
        return;
      }
    }

    const offer = await conn.peerConnection.createOffer();
    await conn.peerConnection.setLocalDescription(offer);

    this.sendDirectMessage(userId, {
      type: 'offer',
      from: this.currentUserId!,
      to: userId,
      data: offer,
      timestamp: Date.now()
    });

    debug.log('Renegotiation offer sent to:', userId);
  }

  private async broadcastMediaState(): Promise<void> {
    this.broadcastMessage({
      type: 'media-state',
      from: this.currentUserId!,
      data: {
        mediaState: this.localMediaState,
        // Lets receivers classify our streams: camera/mic vs screenshare
        screenStreamId: this.localScreenStream?.id ?? null,
      },
      timestamp: Date.now()
    });
  }

  private broadcastAudioLevel(): void {
    if (!this.signalChannel || !this.currentUserId) return;
    
    this.signalChannel.send({
      type: 'broadcast',
      event: 'audio-level',
      payload: {
        userId: this.currentUserId,
        audioLevel: this.localMediaState.audioLevel,
        timestamp: Date.now()
      }
    });
  }

  /**
   * Sort a peer's known streams into mic/camera vs screenshare using the
   * screen stream id the peer announced. Called from ontrack (streams may
   * arrive before the announcement) and from media-state / state-sync
   * handlers (the announcement may arrive before the streams).
   */
  private async classifyRemoteStreams(connection: UserConnection): Promise<void> {
    const userId = connection.userId;
    const screenStreamId = this.announcedScreenStreamIds.get(userId) ?? null;

    // Drop streams whose tracks have all ended
    for (const [id, stream] of connection.knownStreams) {
      const tracks = stream.getTracks();
      if (tracks.length > 0 && tracks.every(t => t.readyState === 'ended')) {
        connection.knownStreams.delete(id);
      }
    }

    const previousMicStream = connection.remoteStream;
    const previousScreenStream = connection.remoteScreenStream;

    connection.remoteScreenStream = screenStreamId
      ? connection.knownStreams.get(screenStreamId) ?? null
      : null;
    connection.remoteStream =
      [...connection.knownStreams.values()].find(s => s.id !== screenStreamId) ?? null;

    if (connection.remoteStream && connection.remoteStream !== previousMicStream) {
      debug.log('Mic/camera stream for user:', userId, 'tracks:', connection.remoteStream.getTracks().length);
      await this.setupRemoteAudio(connection, connection.remoteStream);
    }

    if (connection.remoteScreenStream !== previousScreenStream) {
      debug.log('Screen stream for user:', userId, 'present:', !!connection.remoteScreenStream);
      this.setupScreenAudio(connection);
    }

    this.emit('user-stream-changed', { userId, stream: connection.remoteStream });
    this.emit('stream-changed', { userId, stream: connection.remoteStream, type: 'remote' });
  }

  /**
   * Screenshare audio plays through its own element - it must never be
   * spatialized or muted along with the dry mic path.
   */
  private setupScreenAudio(connection: UserConnection): void {
    if (connection.screenAudioElement) {
      remoteAudioMixer.detach(connection.userId, 'screen', connection.screenAudioElement);
      connection.screenAudioElement.pause();
      connection.screenAudioElement.srcObject = null;
      connection.screenAudioElement = null;
    }

    const audioTracks = connection.remoteScreenStream?.getAudioTracks() ?? [];
    connection.mediaState.hasScreenShareAudio = audioTracks.length > 0;
    if (audioTracks.length === 0) return;

    const audioElement = new Audio();
    audioElement.autoplay = true;
    audioElement.srcObject = new MediaStream(audioTracks);
    audioElement.muted = this.localMediaState.isDeafened;
    const sinkCapable = audioElement as any;
    if (this.selectedOutputDevice && sinkCapable.setSinkId) {
      sinkCapable.setSinkId(this.selectedOutputDevice).catch(() => { /* best effort */ });
    }
    connection.screenAudioElement = audioElement;
    remoteAudioMixer.attach(connection.userId, 'screen', audioElement);
    debug.log('Screen audio element created for user:', connection.userId);
  }

  private async setupRemoteAudio(connection: UserConnection, stream: MediaStream): Promise<void> {
    const audioTracks = stream.getAudioTracks();
    
    if (audioTracks.length > 0) {
      if (!connection.audioElement) {
        connection.audioElement = new Audio();
        connection.audioElement.autoplay = true;
        // playsInline applies to video elements only.
      }
      
      connection.audioElement.srcObject = stream;
      
      const { useSpatialAudioStore } = await import('@/stores/spatialAudio');
      const { spatialAudioService } = await import('@/services/spatialAudio');
      const spatialStore = useSpatialAudioStore();
      const spatialStatus = spatialAudioService.getStatus();
      const isSpatialAudioActive = spatialStore.settings.enabled && spatialStatus.isInitialized;
      
      // While spatial audio is active (enabled + initialized) the
      // HTMLAudioElement is muted, else the dry and wet paths both play.
      connection.audioElement.muted = this.localMediaState.isDeafened || isSpatialAudioActive;
      // Per-user volume and local mute; the mixer also silences its boost
      // chain on deafen, which `muted` alone would not.
      remoteAudioMixer.attach(connection.userId, 'mic', connection.audioElement);

      // Speaking from the received audio, as livekitWebRTC.watchRemoteSpeaker: peers send no levels.
      speakingDetector.watch(
        connection.userId,
        () => connection.remoteStream?.getAudioTracks()[0] ?? null,
        (level) => this.handleAudioLevel({ userId: connection.userId, audioLevel: level, timestamp: Date.now() }),
        connection,
      );

      debug.log('Audio element created for user:', connection.userId,
                  'muted:', connection.audioElement.muted,
                  'spatialEnabled:', spatialStore.settings.enabled,
                  'spatialInitialized:', spatialStatus.isInitialized,
                  'spatialActive:', isSpatialAudioActive,
                  'deafened:', this.localMediaState.isDeafened);
      
      connection.audioElement.onerror = (error) => {
        debug.error('Audio element error for user', connection.userId, ':', error);
      };
      
      connection.audioElement.onplay = () => {
        debug.log('Audio started playing for user:', connection.userId);
      };
    }
  }

  /** Call on every spatial-audio toggle. */
  setTraditionalAudioEnabled(enabled: boolean): void {
    debug.log(`Setting traditional audio enabled: ${enabled} for ${this.connections.size} connections`);
    
    this.connections.forEach(connection => {
      if (connection.audioElement) {
        const wasPlaying = !connection.audioElement.muted && !connection.audioElement.paused;
        
        // Muted while spatial audio is enabled, else the dry and wet paths
        // both play.
        connection.audioElement.muted = !enabled || this.localMediaState.isDeafened;
        
        const isNowPlaying = !connection.audioElement.muted && !connection.audioElement.paused;
        
        debug.log(`${connection.userId}: muted=${connection.audioElement.muted}, ` +
                   `wasPlaying=${wasPlaying}, isNowPlaying=${isNowPlaying}, ` +
                   `deafened=${this.localMediaState.isDeafened}`);
      } else {
        debug.warn(`No audioElement for user ${connection.userId}`);
      }
    });
  }

  private cleanupRemoteAudio(connection: UserConnection): void {
    speakingDetector.unwatch(connection.userId, connection);
    remoteAudioMixer.detach(connection.userId, 'mic', connection.audioElement ?? undefined);
    remoteAudioMixer.detach(connection.userId, 'screen', connection.screenAudioElement ?? undefined);
    if (connection.audioElement) {
      connection.audioElement.pause();
      connection.audioElement.srcObject = null;
      connection.audioElement = null;
      debug.log('Audio element cleaned up for user:', connection.userId);
    }
    if (connection.screenAudioElement) {
      connection.screenAudioElement.pause();
      connection.screenAudioElement.srcObject = null;
      connection.screenAudioElement = null;
      debug.log('Screen audio element cleaned up for user:', connection.userId);
    }
  }

  /** user-left of an unloading page: the signal queue's requests wait for auth-js's lock, past its end. */
  private sendLeaveOnUnload(): void {
    if (!this.signalChannel || !this.channelId || !this.currentUserId) return;
    const message = { type: 'user-left' as const, data: {}, timestamp: Date.now(), session: this.sessionId };
    if (relaysSignals()) sendSignalOnUnload(`harmony-voice-${this.channelId}`, 'signals', { messages: [message] });
    else void this.broadcastSignals(this.signalChannel, this.currentUserId, [message]).catch(() => {});
  }

  // beforeunload also fires for a navigation that becomes a download; pagehide only when the page goes.
  private setupCleanup(): void {
    window.addEventListener('pagehide', (event) => {
      if (!this.channelId) return;
      const channelId = this.channelId;
      this.sendLeaveOnUnload();
      void this.leaveChannel({ silent: true }).then(() => {
        // Restored from the back/forward cache, the app shows a call that has ended.
        if (event.persisted) this.emit('connection-lost', { channelId });
      });
    });
  }

  // AUDIO SETTINGS MANAGEMENT

  getSelectedDevices(): { inputDevice: string | null; outputDevice: string | null; videoDevice: string | null } {
    return {
      inputDevice: this.selectedInputDevice,
      outputDevice: this.selectedOutputDevice,
      videoDevice: this.selectedVideoDevice
    };
  }

  private loadAudioSettings(): void {
    try {
      const devices = VoiceSettingsService.getDevices();
      const constraints = VoiceSettingsService.getAudioConstraints();
      
      this.audioConstraints = {
        ...this.audioConstraints,
        echoCancellation: constraints.echoCancellation,
        noiseSuppression: constraints.noiseSuppression,
        autoGainControl: constraints.autoGainControl,
      };
      debug.log('[P2P] Loaded audio settings:', this.audioConstraints);
      
      this.selectedInputDevice = devices.inputDevice;
      this.selectedOutputDevice = devices.outputDevice;
      this.selectedVideoDevice = devices.videoDevice;
      debug.log('[P2P] Loaded device settings:', devices);
    } catch (error) {
      debug.warn('[P2P] Failed to load audio settings:', error);
    }
  }

  private saveAudioSettings(): void {
    try {
      VoiceSettingsService.setAudioConstraints({
        echoCancellation: this.audioConstraints.echoCancellation,
        noiseSuppression: this.audioConstraints.noiseSuppression,
        autoGainControl: this.audioConstraints.autoGainControl
      });
      
      if (this.selectedInputDevice) {
        VoiceSettingsService.setInputDevice(this.selectedInputDevice);
      }
      if (this.selectedOutputDevice) {
        VoiceSettingsService.setOutputDevice(this.selectedOutputDevice);
      }
      if (this.selectedVideoDevice) {
        VoiceSettingsService.setVideoDevice(this.selectedVideoDevice);
      }
      
      debug.log('[P2P] Saved audio and device settings via VoiceSettingsService');
    } catch (error) {
      debug.warn('[P2P] Failed to save audio settings:', error);
    }
  }

  private setupSettingsListener(): void {
    // Listen for settings updates from the settings panel
    this.on('update-settings', (data: { type: string; value: any }) => {
      if (data.type === 'audioConstraints') {
        this.updateAudioConstraints(data.value);
      }
    });
  }

  /** Restarts the audio stream when the constraints change mid-call. */
  async updateAudioConstraints(constraints: { echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean }): Promise<void> {
    debug.log('Updating audio constraints:', constraints);
    
    Object.assign(this.audioConstraints, constraints);
    this.saveAudioSettings();
    
    if (this.localStream && this.channelId) {

      // As in `updateInputDevice`: acquire the new stream FIRST, then stop
      // and remove the old tracks. The reverse order kills the mic whenever
      // `getUserMedia` rejects the new constraints (AGC value the device
      // cannot honour, permission flipped between save and apply).
      try {
        const newAudioStream = await navigator.mediaDevices.getUserMedia({
          audio: this.audioConstraints,
          video: false
        });

        const newAudioTrack = newAudioStream.getAudioTracks()[0];
        if (newAudioTrack) {
          // New capture is committed: route it, then stop the old one.
          await this.installCapturedMic(newAudioTrack);

          debug.log('Audio stream updated with new constraints');
          this.emit('local-stream-changed', this.localStream);
        }
      } catch (error) {
        debug.error('Failed to update audio constraints:', error);
        this.emit('error', error);
      }
    }
  }

  getAudioConstraints(): { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean } {
    return {
      echoCancellation: this.audioConstraints.echoCancellation,
      noiseSuppression: this.audioConstraints.noiseSuppression,
      autoGainControl: this.audioConstraints.autoGainControl
    };
  }
}

// SINGLETON EXPORT

export const unifiedWebRTC = new UnifiedWebRTCService();