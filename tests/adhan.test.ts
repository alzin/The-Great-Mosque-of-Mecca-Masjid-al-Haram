import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADHAN, AdhanPlayer } from '../src/audio/AdhanPlayer.ts';
import type { AudioState, AudioSystem } from '../src/audio/AudioSystem.ts';

class Media extends EventTarget {
  static instances: Media[] = [];
  src = '';
  volume = 1;
  preload = '';
  paused = true;
  resolve!: () => void;
  reject!: (error: Error) => void;
  constructor() { super(); Media.instances.push(this); }
  play() {
    this.paused = false;
    return new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  }
  pause() { this.paused = true; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  load() {}
}

function setup(state: AudioState = 'on') {
  const quran = {
    state,
    stop: vi.fn(() => { quran.state = 'off'; }),
    start: vi.fn(async () => { quran.state = 'on'; return quran.state; }),
  };
  const change = vi.fn();
  const adhan = new AdhanPlayer(quran as unknown as AudioSystem, change);
  return { quran, change, adhan };
}

describe('Haram adhan', () => {
  beforeEach(() => { Media.instances = []; vi.stubGlobal('Audio', Media); });
  afterEach(() => vi.unstubAllGlobals());

  it('pauses Quran before playing a single recording and resumes it on completion', async () => {
    const { quran, adhan } = setup();
    const start = adhan.start();
    const media = Media.instances[0];
    expect(quran.stop).toHaveBeenCalledOnce();
    expect(quran.state).toBe('off');
    expect(media.src).toBe(ADHAN.url);
    expect(adhan.state).toBe('starting');
    await adhan.start();
    expect(Media.instances).toHaveLength(1);
    media.resolve();
    await start;
    expect(adhan.state).toBe('on');
    media.dispatchEvent(new Event('ended'));
    expect(adhan.active).toBe(false);
    expect(media.paused).toBe(true);
    expect(quran.start).toHaveBeenCalledOnce();
  });

  it.each(['off', 'unavailable'] as const)('does not enable Quran after adhan if it was %s', async (state) => {
    const { adhan, quran } = setup(state);
    const start = adhan.start();
    const media = Media.instances[0];
    media.resolve();
    await start;
    media.dispatchEvent(new Event('ended'));
    expect(quran.start).not.toHaveBeenCalled();
  });

  it('keeps all audio off after explicit mute, despite a late completion', async () => {
    const { adhan, quran } = setup();
    const start = adhan.start();
    const media = Media.instances[0];
    adhan.stop();
    media.resolve();
    await start;
    media.dispatchEvent(new Event('ended'));
    expect(adhan.active).toBe(false);
    expect(quran.start).not.toHaveBeenCalled();
    expect(media.src).toBe('');
    expect(media.paused).toBe(true);
  });

  it('restores previous Quran playback when prayer is cancelled', async () => {
    const { adhan, quran } = setup();
    const start = adhan.start();
    adhan.stop(true);
    Media.instances[0].reject(new Error('Interrupted'));
    await start;
    expect(quran.start).toHaveBeenCalledOnce();
    expect(adhan.state).toBe('off');
  });

  it.each(['promise', 'event'] as const)('reports a %s failure and restores Quran only once', async (failure) => {
    const { adhan, quran, change } = setup();
    const start = adhan.start();
    const media = Media.instances[0];
    if (failure === 'promise') media.reject(new Error('Network error'));
    else {
      media.dispatchEvent(new Event('error'));
      media.reject(new Error('Network error'));
    }
    await start;
    expect(adhan.state).toBe('off');
    expect(quran.start).toHaveBeenCalledOnce();
    expect(change).toHaveBeenLastCalledWith('off', expect.stringContaining('could not be played'));
  });

  it('ignores a cancelled recording failing after a new adhan has started', async () => {
    const { adhan, quran } = setup();
    const oldStart = adhan.start();
    const oldMedia = Media.instances[0];
    adhan.stop(true);
    const newStart = adhan.start();
    const newMedia = Media.instances[1];
    newMedia.resolve();
    await newStart;
    oldMedia.reject(new Error('Old interrupted request'));
    await oldStart;
    oldMedia.dispatchEvent(new Event('ended'));
    oldMedia.dispatchEvent(new Event('error'));
    expect(adhan.state).toBe('on');
    expect(quran.state).toBe('off');
    adhan.stop();
  });
});
