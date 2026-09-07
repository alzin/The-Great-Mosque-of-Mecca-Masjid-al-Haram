/**
 * Quran recordings by Abdul Rahman Al-Sudais, streamed as they play.
 * Starts at Al-Fatihah and continues in Quran order at the original speed.
 * Playback is independent of the simulation clock. The app attempts autoplay
 * on entry and retries after interaction when the browser requires a gesture.
 */
import { RECITATION, recitationUrl } from './recitation.ts';

export type AudioState = 'off' | 'starting' | 'on' | 'blocked' | 'unavailable';

export class AudioSystem {
  private media: HTMLAudioElement | null = null;
  private request = 0;
  private volume = 0.5;

  state: AudioState = 'off';
  error: string | null = null;
  currentSurah = 1;

  constructor(private readonly onStateChange?: (state: AudioState, error: string | null) => void) {}

  get isOn(): boolean {
    return this.state === 'on';
  }

  async toggle(): Promise<AudioState> {
    if (this.state === 'on' || this.state === 'starting') {
      this.stop();
      return this.state;
    }
    return this.start();
  }

  async start(): Promise<AudioState> {
    if (this.state === 'on' || this.state === 'starting') return this.state;
    const request = ++this.request;
    if (this.state === 'unavailable') this.releaseMedia();
    // After completing the final surah, the next explicit play starts anew.
    if (this.currentSurah === RECITATION.surahCount && this.media?.ended) {
      this.releaseMedia();
      this.currentSurah = 1;
    }
    this.setState('starting');
    try {
      const media = this.media ?? this.createMedia();
      await media.play();
      // A user may have paused, retried, or disposed while play was pending.
      if (request === this.request && this.media === media) this.setState('on');
    } catch (err) {
      if (request === this.request) {
        const blocked = err instanceof Error && err.name === 'NotAllowedError';
        if (blocked) {
          this.setState('blocked');
          this.media?.pause();
        } else {
          this.fail('Could not play the recitation. Check your connection and press Quran to retry.');
        }
      }
    }
    return this.state;
  }

  /** Pause at the current position so the next play resumes the same verse. */
  stop(): void {
    ++this.request;
    this.setState('off');
    this.media?.pause();
  }

  setVolume(v: number): void {
    if (!Number.isFinite(v)) return;
    this.volume = Math.min(1, Math.max(0, v));
    if (this.media) this.media.volume = this.volume;
  }

  private createMedia(): HTMLAudioElement {
    const media = new Audio();
    this.media = media;
    media.preload = 'none';
    media.loop = false;
    media.volume = this.volume;
    media.src = recitationUrl(this.currentSurah);

    const active = () => this.media === media && (this.state === 'on' || this.state === 'starting');
    media.addEventListener('playing', () => {
      if (active()) this.setState('on');
    });
    media.addEventListener('waiting', () => {
      if (active()) this.setState('starting');
    });
    media.addEventListener('error', () => {
      if (active()) this.fail('The recitation could not be loaded. Check your connection and press Quran to retry.');
    });
    media.addEventListener('pause', () => {
      // Ignore queued pause events from an earlier stop if playback resumed.
      if (active() && media.paused && !media.ended) this.stop();
    });
    media.addEventListener('ended', () => {
      if (!active()) return;
      if (this.currentSurah === RECITATION.surahCount) {
        this.stop();
        return;
      }
      this.releaseMedia();
      this.currentSurah++;
      this.state = 'off';
      void this.start();
    });
    return media;
  }

  private setState(state: AudioState, error: string | null = null): void {
    this.state = state;
    this.error = error;
    this.onStateChange?.(state, error);
  }

  private fail(message: string): void {
    ++this.request;
    this.setState('unavailable', message);
    this.media?.pause();
  }

  private releaseMedia(): void {
    const media = this.media;
    this.media = null;
    if (!media) return;
    media.pause();
    media.removeAttribute('src');
    media.load();
  }

  dispose(): void {
    ++this.request;
    this.releaseMedia();
    this.currentSurah = 1;
    this.setState('off');
  }
}
