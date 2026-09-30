import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client';
import { MicGainStage } from './micGain';

/**
 * livekit-client TrackProcessor carrying the input-gain stage.
 * LocalTrack.restart() (device switch, processing change, re-acquire on
 * unmute) passes each new capture track to restart(); the stage keeps its
 * output track, so the sender sees the same track throughout.
 */
export class MicGainProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = 'harmony-input-gain';
  processedTrack?: MediaStreamTrack;

  constructor(readonly stage: MicGainStage) {}

  async init(opts: AudioProcessorOptions): Promise<void> {
    const out = await this.stage.connect(opts.track);
    if (!out) throw new Error('Voice AudioContext is not running');
    this.processedTrack = out;
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    const out = await this.stage.connect(opts.track);
    if (out) this.processedTrack = out;
  }

  async destroy(): Promise<void> {
    this.stage.destroy();
    this.processedTrack = undefined;
  }
}
