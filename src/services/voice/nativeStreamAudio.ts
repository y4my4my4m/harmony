/**
 * Native program audio for a desktop screen share (src-tauri commands/stream_audio.rs).
 * WebKit's getDisplayMedia returns no audio and WebView2's only for whole screens, so on
 * Windows and macOS the desktop app captures it natively: the shared window's application, or
 * every application but Harmony. Blocks arrive over a Tauri channel as base64 s16le stereo at
 * 48 kHz and play through an AudioWorklet into a MediaStreamTrack published as stream audio.
 */
import { ref, shallowRef } from 'vue';
import { useToast } from 'vue-toastification';
import { Channel, invoke } from '@tauri-apps/api/core';
import { i18n } from '@/i18n';
import { debug } from '@/utils/debug';
import { isTauriDesktop } from '@/utils/platform';
import { STREAM_AUDIO_PROCESSOR } from './streamAudioBuffer';
import builtWorkletUrl from './streamAudio.worklet.ts?worker&url';

const SAMPLE_RATE = 48_000;

// Vite's dev worker URL imports its client env module, which fails to evaluate in an
// AudioWorkletGlobalScope; addModule still resolves and the processor never registers. Dev
// serves the worklet as a plain module. The name is a variable so Vite does not turn the
// URL into a build asset.
const DEV_WORKLET = 'streamAudio.worklet.ts';

function workletUrl(): string {
  return import.meta.env.DEV ? new URL(DEV_WORKLET, import.meta.url).href : builtWorkletUrl;
}

export interface NativeStreamAudioSupport {
  supported: boolean;
  reason: string | null;
}

/** Null until the first probe answers. */
export const nativeStreamAudioSupport = ref<NativeStreamAudioSupport | null>(null);

let probe: Promise<NativeStreamAudioSupport> | null = null;

export function probeNativeStreamAudio(): Promise<NativeStreamAudioSupport> {
  probe ??= (async () => {
    let result: NativeStreamAudioSupport = { supported: false, reason: 'not the desktop app' };
    try {
      if (isTauriDesktop()) {
        result = await invoke<NativeStreamAudioSupport>('stream_audio_support');
      }
    } catch (error) {
      result = { supported: false, reason: String(error) };
    }
    nativeStreamAudioSupport.value = result;
    return result;
  })();
  return probe;
}

/** Appends a line to the desktop app's stream-audio.log (src-tauri commands/stream_audio.rs). */
export function traceStreamAudio(event: string, data?: Record<string, unknown>): void {
  if (!isTauriDesktop()) return;
  const line = data ? `${event} ${JSON.stringify(data)}` : event;
  void invoke('stream_audio_trace', { line }).catch(() => {});
}

/** The cached probe result; false before the probe answers. */
export function nativeStreamAudioSupported(): boolean {
  return nativeStreamAudioSupport.value?.supported === true;
}

export interface SharedSurface {
  label: string;
  displaySurface: string;
}

interface Started {
  sampleRate: number;
  channels: number;
  blockFrames: number;
  scope: 'system' | 'app';
  app: string | null;
  detail: string;
  /** Capture session; stream_audio_stop with it stops only that capture. */
  session: number;
}

export type StreamAudioErrorKind = 'unsupported' | 'permission' | 'failed';

export class StreamAudioError extends Error {
  constructor(readonly kind: StreamAudioErrorKind, message: string) {
    super(message);
    this.name = 'StreamAudioError';
  }

  /** Command errors read "<kind>: <message>". */
  static from(error: unknown): StreamAudioError {
    if (error instanceof StreamAudioError) return error;
    const text = error instanceof Error ? error.message : String(error);
    const match = /^(unsupported|permission|failed): ?(.*)$/s.exec(text);
    return match ? new StreamAudioError(match[1] as StreamAudioErrorKind, match[2]) : new StreamAudioError('failed', text);
  }
}

export interface StreamAudioSource {
  scope: 'system' | 'app';
  /** Application name when scope is 'app'. */
  app: string | null;
  /** How the shared surface resolved, from the native side. */
  detail: string;
}

export interface NativeStreamAudio extends StreamAudioSource {
  track: MediaStreamTrack;
  /**
   * Captures another surface into the same track. scope, app and detail follow. On failure
   * no capture runs; the caller stops this one.
   */
  retarget(surface: SharedSurface): Promise<void>;
  stop(): Promise<void>;
}

/** Source of the running native capture; null when none runs. Shallow: stop compares identity. */
export const activeStreamAudio = shallowRef<StreamAudioSource | null>(null);

/**
 * WebKit settles resume() only once the context runs, which without user activation waits for
 * the next gesture; the picker has consumed the click's activation. The context resumes on the
 * next press instead of anything awaiting it.
 */
function resumeOnNextGesture(context: AudioContext): void {
  void context.resume().catch(() => {});
  const resume = () => {
    window.removeEventListener('pointerdown', resume, true);
    window.removeEventListener('keydown', resume, true);
    if (context.state === 'suspended') void context.resume().catch(() => {});
  };
  window.addEventListener('pointerdown', resume, true);
  window.addEventListener('keydown', resume, true);
}

function base64ToBuffer(text: string): ArrayBuffer {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Holds the AudioContext, created before getDisplayMedia so it is still inside the click's
 * user activation; a context created after the picker can start suspended and render silence.
 */
export class PreparedStreamAudio {
  private readonly context: AudioContext;
  private used = false;

  constructor() {
    this.context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    void this.context.resume().catch(() => {});
    const context = this.context;
    context.onstatechange = () => traceStreamAudio('context', { state: context.state });
  }

  /** Starts native capture for the surface the picker shared. Consumes the context. */
  async start(surface: SharedSurface): Promise<NativeStreamAudio> {
    if (this.used) throw new StreamAudioError('failed', 'already started');
    this.used = true;
    const context = this.context;
    let node: AudioWorkletNode | null = null;
    let channel: Channel<string> | null = null;
    let open = true;
    try {
      await context.audioWorklet.addModule(workletUrl());
      const workletNode = new AudioWorkletNode(context, STREAM_AUDIO_PROCESSOR, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      node = workletNode;
      const destination = context.createMediaStreamDestination();
      destination.channelCount = 2;
      workletNode.connect(destination);
      const feed = (block: string) => {
        if (!open) return;
        const buffer = base64ToBuffer(block);
        workletNode.port.postMessage(buffer, [buffer]);
      };
      // A Channel serves one command call: its message indexes start at 0 per Rust Channel,
      // and the previous one's end unregisters the callback. A retarget opens another.
      let audioChannel = new Channel<string>();
      channel = audioChannel;
      audioChannel.onmessage = feed;
      traceStreamAudio('native start', { ...surface, context: context.state });
      const started = await invoke<Started>('stream_audio_start', { surface, onAudio: audioChannel });
      if (context.state !== 'running') resumeOnNextGesture(context);
      const track = destination.stream.getAudioTracks()[0];
      debug.log('[StreamAudio] native capture started', { ...started, surface, context: context.state });
      traceStreamAudio('native started', { scope: started.scope, app: started.app, context: context.state });
      let session = started.session;
      let source: StreamAudioSource = { scope: started.scope, app: started.app, detail: started.detail };
      activeStreamAudio.value = source;
      const handle: NativeStreamAudio = {
        ...source,
        track,
        retarget: async (next) => {
          if (!open) throw new StreamAudioError('failed', 'stopped');
          const nextChannel = new Channel<string>();
          nextChannel.onmessage = feed;
          audioChannel.onmessage = () => {};
          traceStreamAudio('native retarget', { ...next });
          try {
            const restarted = await invoke<Started>('stream_audio_start', { surface: next, onAudio: nextChannel });
            audioChannel = nextChannel;
            session = restarted.session;
            source = { scope: restarted.scope, app: restarted.app, detail: restarted.detail };
            Object.assign(handle, source);
            activeStreamAudio.value = source;
            traceStreamAudio('native retargeted', { scope: restarted.scope, app: restarted.app });
          } catch (error) {
            nextChannel.onmessage = () => {};
            if (activeStreamAudio.value === source) activeStreamAudio.value = null;
            const failure = StreamAudioError.from(error);
            traceStreamAudio('native retarget failed', { kind: failure.kind, message: failure.message });
            throw failure;
          }
        },
        stop: async () => {
          if (!open) return;
          open = false;
          if (activeStreamAudio.value === source) activeStreamAudio.value = null;
          audioChannel.onmessage = () => {};
          await invoke('stream_audio_stop', { session }).catch(() => {});
          workletNode.disconnect();
          track.stop();
          await context.close().catch(() => {});
        },
      };
      return handle;
    } catch (error) {
      open = false;
      if (channel) channel.onmessage = () => {};
      node?.disconnect();
      await context.close().catch(() => {});
      const failure = StreamAudioError.from(error);
      traceStreamAudio('native failed', { kind: failure.kind, message: failure.message });
      throw failure;
    }
  }

  /** Releases the context when start is never called. */
  dispose(): void {
    if (this.used) return;
    this.used = true;
    void this.context.close().catch(() => {});
  }
}

/** The stream goes out without sound; says why. */
export function notifyStreamAudioFailed(error: unknown): void {
  const { kind, message } = StreamAudioError.from(error);
  debug.warn('[StreamAudio] native capture failed:', kind, message);
  const t = i18n.global.t;
  const text = kind === 'permission' ? t('voice.streamAudioPermission') : t('voice.streamAudioFailed');
  useToast().warning(text);
}
