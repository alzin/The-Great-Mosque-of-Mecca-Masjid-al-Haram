import type { AudioSystem } from './AudioSystem.ts';

export const ADHAN = {
  muezzin: 'Ali Ahmed Mulla',
  sourcePage: 'https://audio.islamweb.net/audio/index.php?audioid=1&page=audioinfo',
  // Version-pinned public mirror of the regular Haram adhan (not the Fajr variant).
  url: encodeURI('https://raw.githubusercontent.com/Kiwifu/adhan-mp3/b9180a2bb769f74cff8e378ef2cc7aaf8db5cd5b/Ali_Ibn_Ahmad_Mala_1_-_Al_Haram_Al_Maki_(علي_بن_أحمد_ملا_-_الحرم_المكي).mp3'),
} as const;

export type AdhanState = 'off' | 'starting' | 'on';

/** One adhan at a time; preserve Quran position and the listener's mute choice. */
export class AdhanPlayer {
  state: AdhanState = 'off';
  private media: HTMLAudioElement | null = null;
  private request = 0;
  private resumeQuran = false;

  constructor(
    private readonly quran: AudioSystem,
    private readonly onChange: (state: AdhanState, error: string | null) => void,
  ) {}

  get active(): boolean { return this.state !== 'off'; }

  async start(): Promise<void> {
    if (this.active) return;
    const request = ++this.request;
    this.resumeQuran = ['on', 'starting', 'blocked'].includes(this.quran.state);
    this.state = 'starting';
    this.quran.stop();
    this.onChange(this.state, null);
    try {
      const media = new Audio();
      this.media = media;
      media.preload = 'none';
      media.volume = 0.65;
      media.src = ADHAN.url;
      media.addEventListener('ended', () => {
        if (this.media === media) this.stop(true);
      });
      media.addEventListener('error', () => {
        if (this.media === media) this.finishWithError();
      });
      media.addEventListener('waiting', () => {
        if (this.media === media) { this.state = 'starting'; this.onChange(this.state, null); }
      });
      media.addEventListener('playing', () => {
        if (this.media === media) { this.state = 'on'; this.onChange(this.state, null); }
      });
      await media.play();
      if (request === this.request && this.media === media) {
        this.state = 'on';
        this.onChange(this.state, null);
      }
    } catch {
      if (request === this.request) this.finishWithError();
    }
  }

  /** Explicit mute suppresses resuming Quran; completion/cancel may restore it. */
  stop(resume = false): void {
    ++this.request;
    const shouldResume = resume && this.resumeQuran;
    this.resumeQuran = false;
    const media = this.media;
    this.media = null;
    this.state = 'off';
    if (media) {
      media.pause();
      media.removeAttribute('src');
      media.load();
    }
    this.onChange(this.state, null);
    if (shouldResume) void this.quran.start();
  }

  private finishWithError(): void {
    this.stop(true);
    this.onChange('off', 'The Haram adhan could not be played. Check your connection.');
  }
}
