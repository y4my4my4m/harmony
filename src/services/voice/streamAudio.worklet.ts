/**
 * AudioWorklet processor for native program audio. Port messages carry ArrayBuffers of
 * interleaved stereo s16 at the context rate (48 kHz); output is two channels from the
 * jitter buffer. Loaded through Vite's `?worker&url`, which bundles the buffer module in.
 */
import { STREAM_AUDIO_PROCESSOR, StereoJitterBuffer } from './streamAudioBuffer';

// AudioWorkletGlobalScope members; the DOM lib does not declare them.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

class StreamAudioProcessor extends AudioWorkletProcessor {
  private readonly buffer = new StereoJitterBuffer();

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        this.buffer.pushInterleavedS16(new Int16Array(event.data));
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (out?.length >= 2) {
      this.buffer.pull(out[0], out[1]);
    }
    return true;
  }
}

registerProcessor(STREAM_AUDIO_PROCESSOR, StreamAudioProcessor);
