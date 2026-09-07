import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioSystem } from '../src/audio/AudioSystem.ts';

function deferredPlayback() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Control browser playback completion separately from the user's actions. */
class BrowserAudio extends EventTarget {
  static instances: BrowserAudio[] = [];
  readonly attempts: ReturnType<typeof deferredPlayback>[] = [];
  src = '';
  preload = '';
  loop = false;
  autoplay = false;
  muted = false;
  volume = 1;
  currentTime = 0;
  paused = true;
  ended = false;
  error: MediaError | null = null;

  constructor(src?: string) {
    super();
    this.src = src ?? '';
    BrowserAudio.instances.push(this);
  }

  play(): Promise<void> {
    this.paused = false;
    this.ended = false;
    const attempt = deferredPlayback();
    this.attempts.push(attempt);
    return attempt.promise;
  }

  pause(): void { this.paused = true; }
  load(): void {}
  removeAttribute(name: string): void { if (name === 'src') this.src = ''; }

  end(): void {
    this.paused = true;
    this.ended = true;
    this.dispatchEvent(new Event('ended'));
  }

  fail(): void {
    this.error = { code: 2, message: 'The connection was interrupted.' } as MediaError;
    this.dispatchEvent(new Event('error'));
  }
}

function latestMedia(): BrowserAudio {
  return BrowserAudio.instances[BrowserAudio.instances.length - 1];
}

async function resolvePlayback(media: BrowserAudio): Promise<void> {
  media.attempts[media.attempts.length - 1].resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('Quran playback', () => {
  const systems: AudioSystem[] = [];

  function setup(callback = vi.fn()) {
    const audio = new AudioSystem(callback);
    systems.push(audio);
    return { audio, callback };
  }

  beforeEach(() => {
    BrowserAudio.instances = [];
    vi.stubGlobal('Audio', BrowserAudio);
  });

  afterEach(() => {
    for (const audio of systems.splice(0)) audio.dispose();
    vi.unstubAllGlobals();
  });

  it('stays silent without requesting media until enabled, then resumes the paused recitation', async () => {
    const { audio } = setup();
    expect(audio.state).toBe('off');
    expect(audio.isOn).toBe(false);
    expect(audio.error).toBeNull();
    expect(audio.currentSurah).toBe(1);
    expect(BrowserAudio.instances).toHaveLength(0);

    const firstStart = audio.toggle();
    const media = latestMedia();
    expect(audio.state).toBe('starting');
    expect(media.src).toMatch(/\/001\.mp3(?:[?#]|$)/);
    expect(media.loop).toBe(false);
    await resolvePlayback(media);
    expect(await firstStart).toBe('on');
    expect(audio.isOn).toBe(true);

    media.currentTime = 18.5;
    expect(await audio.toggle()).toBe('off');
    expect(media.paused).toBe(true);
    expect(media.currentTime).toBe(18.5);
    const resume = audio.start();
    expect(latestMedia()).toBe(media);
    expect(media.currentTime).toBe(18.5);
    await resolvePlayback(media);
    expect(await resume).toBe('on');
  });

  it.each(['resolve', 'reject'] as const)('stays off when canceled playback later %ss', async (completion) => {
    const { audio, callback } = setup();
    const start = audio.start();
    const media = latestMedia();
    const attempt = media.attempts[0];
    audio.stop();
    callback.mockClear();
    if (completion === 'resolve') attempt.resolve();
    else attempt.reject(new Error('Playback was interrupted by pause.'));
    expect(await start).toBe('off');
    expect(audio.state).toBe('off');
    expect(audio.error).toBeNull();
    expect(media.paused).toBe(true);
    expect(callback).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('ignores a stale %s after a newer play request succeeds', async (completion) => {
    const { audio, callback } = setup();
    const firstStart = audio.start();
    const firstAttempt = latestMedia().attempts[0];
    audio.stop();
    const secondStart = audio.start();
    const currentMedia = latestMedia();
    await resolvePlayback(currentMedia);
    expect(await secondStart).toBe('on');
    callback.mockClear();

    if (completion === 'resolve') firstAttempt.resolve();
    else firstAttempt.reject(new Error('The older play request was canceled.'));
    await firstStart;
    expect(audio.state).toBe('on');
    expect(audio.error).toBeNull();
    expect(currentMedia.paused).toBe(false);
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not report on when an older request finishes while the new request is still starting', async () => {
    const { audio } = setup();
    const firstStart = audio.start();
    const firstAttempt = latestMedia().attempts[0];
    audio.stop();
    const secondStart = audio.start();
    firstAttempt.resolve();
    await firstStart;
    expect(audio.state).toBe('starting');
    await resolvePlayback(latestMedia());
    expect(await secondStart).toBe('on');
  });

  it('treats autoplay policy rejection as waiting for interaction and allows a normal retry', async () => {
    const { audio, callback } = setup();
    const firstStart = audio.start();
    latestMedia().attempts[0].reject(Object.assign(new Error('A user gesture is required.'), {
      name: 'NotAllowedError',
    }));
    expect(await firstStart).toBe('blocked');
    expect(audio.isOn).toBe(false);
    expect(audio.error).toBeNull();
    expect(callback).toHaveBeenLastCalledWith('blocked', null);

    const retry = audio.start();
    await resolvePlayback(latestMedia());
    expect(await retry).toBe('on');
    expect(audio.error).toBeNull();
  });

  it('reports a failed play request and retries with fresh media on the next user action', async () => {
    const { audio, callback } = setup();
    const firstStart = audio.start();
    const failedMedia = latestMedia();
    failedMedia.attempts[0].reject(new Error('The connection was interrupted.'));
    expect(await firstStart).toBe('unavailable');
    expect(audio.error).toBeTruthy();
    expect(callback).toHaveBeenLastCalledWith('unavailable', expect.any(String));

    const retry = audio.toggle();
    const retriedMedia = latestMedia();
    expect(retriedMedia).not.toBe(failedMedia);
    expect(retriedMedia.src).toMatch(/\/001\.mp3(?:[?#]|$)/);
    await resolvePlayback(retriedMedia);
    expect(await retry).toBe('on');
    expect(audio.error).toBeNull();
  });

  it('reports runtime media errors, and ignores errors from replaced media after retry', async () => {
    const { audio, callback } = setup();
    const start = audio.start();
    const failedMedia = latestMedia();
    await resolvePlayback(failedMedia);
    await start;
    failedMedia.fail();
    expect(audio.state).toBe('unavailable');
    expect(audio.isOn).toBe(false);
    expect(callback).toHaveBeenLastCalledWith('unavailable', expect.any(String));

    const retry = audio.start();
    const retriedMedia = latestMedia();
    expect(retriedMedia).not.toBe(failedMedia);
    await resolvePlayback(retriedMedia);
    await retry;
    failedMedia.fail();
    expect(audio.state).toBe('on');
    expect(audio.error).toBeNull();
  });

  it('preserves a runtime failure if the pending play promise resolves afterward', async () => {
    const { audio, callback } = setup();
    const start = audio.start();
    const media = latestMedia();
    media.fail();
    const reportedError = audio.error;
    callback.mockClear();
    await resolvePlayback(media);
    expect(await start).toBe('unavailable');
    expect(audio.error).toBe(reportedError);
    expect(media.paused).toBe(true);
    expect(callback).not.toHaveBeenCalled();
  });

  it('continues from Al-Fatihah to the next surah and ignores ended events after pausing', async () => {
    const { audio } = setup();
    const start = audio.start();
    const fatihah = latestMedia();
    await resolvePlayback(fatihah);
    await start;
    fatihah.end();
    expect(audio.currentSurah).toBe(2);
    const baqarah = latestMedia();
    expect(baqarah).not.toBe(fatihah);
    expect(baqarah.src).toMatch(/\/002\.mp3(?:[?#]|$)/);
    await resolvePlayback(baqarah);
    expect(audio.state).toBe('on');

    // A delayed event from the previous track cannot skip the current surah.
    fatihah.dispatchEvent(new Event('ended'));
    expect(audio.currentSurah).toBe(2);
    audio.stop();
    baqarah.dispatchEvent(new Event('ended'));
    expect(audio.state).toBe('off');
    expect(audio.currentSurah).toBe(2);
    expect(latestMedia()).toBe(baqarah);
    expect(baqarah.paused).toBe(true);
  });

  it('follows Quran order through the final surah and stops after An-Nas', async () => {
    const { audio } = setup();
    const start = audio.start();
    await resolvePlayback(latestMedia());
    await start;
    for (let surah = 2; surah <= 114; surah++) {
      latestMedia().end();
      expect(audio.currentSurah).toBe(surah);
      expect(latestMedia().src).toContain(`/${String(surah).padStart(3, '0')}.mp3`);
      await resolvePlayback(latestMedia());
    }
    const lastSurah = latestMedia();
    lastSurah.end();
    expect(audio.state).toBe('off');
    expect(audio.isOn).toBe(false);
    expect(lastSurah.paused).toBe(true);

    const restart = audio.toggle();
    expect(audio.currentSurah).toBe(1);
    expect(latestMedia().src).toMatch(/\/001\.mp3(?:[?#]|$)/);
    await resolvePlayback(latestMedia());
    expect(await restart).toBe('on');
  });

  it('applies and clamps the volume before and during playback', async () => {
    const { audio } = setup();
    audio.setVolume(0.42);
    expect(BrowserAudio.instances).toHaveLength(0);
    const start = audio.start();
    const media = latestMedia();
    expect(media.volume).toBeCloseTo(0.42);
    await resolvePlayback(media);
    await start;
    audio.setVolume(-1);
    expect(media.volume).toBe(0);
    audio.setVolume(2);
    expect(media.volume).toBe(1);
  });

  it('cancels pending playback and releases the media source on disposal', async () => {
    const { audio, callback } = setup();
    const start = audio.start();
    const media = latestMedia();
    audio.dispose();
    expect(audio.state).toBe('off');
    expect(media.paused).toBe(true);
    expect(media.src).toBe('');
    callback.mockClear();
    media.attempts[0].resolve();
    await start;
    media.fail();
    media.dispatchEvent(new Event('ended'));
    expect(audio.state).toBe('off');
    expect(callback).not.toHaveBeenCalled();
  });
});
