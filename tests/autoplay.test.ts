import { describe, expect, it, vi } from 'vitest';
import type { AudioState, AudioSystem } from '../src/audio/AudioSystem.ts';
import { startAutoplay } from '../src/audio/autoplay.ts';

class Playback {
  state: AudioState = 'off';
  private completeAttempt: ((state: AudioState) => void) | undefined;

  readonly start = vi.fn(() => {
    this.state = 'starting';
    return new Promise<AudioState>((resolve) => { this.completeAttempt = resolve; });
  });

  stop(): void { this.state = 'off'; }

  async complete(state: AudioState): Promise<void> {
    this.state = state;
    this.completeAttempt?.(state);
    await Promise.resolve();
    await Promise.resolve();
  }
}

function setup() {
  const audio = new Playback();
  const target = new EventTarget();
  const cleanup = startAutoplay(audio as unknown as AudioSystem, target);
  return { audio, target, cleanup };
}

describe('entry autoplay', () => {
  it('attempts playback immediately and leaves successful playback alone', async () => {
    const { audio, target, cleanup } = setup();
    expect(audio.start).toHaveBeenCalledTimes(1);
    expect(audio.state).toBe('starting');
    await audio.complete('on');
    target.dispatchEvent(new Event('click'));
    target.dispatchEvent(new Event('keydown'));
    expect(audio.start).toHaveBeenCalledTimes(1);
    expect(audio.state).toBe('on');
    cleanup();
  });

  it.each(['click', 'keydown'])('retries blocked autoplay synchronously on the first %s gesture', async (gesture) => {
    const { audio, target, cleanup } = setup();
    await audio.complete('blocked');
    target.dispatchEvent(new Event('pointermove'));
    expect(audio.start).toHaveBeenCalledTimes(1);
    target.dispatchEvent(new Event(gesture));
    // Calling play in the event handler preserves browser user activation.
    expect(audio.start).toHaveBeenCalledTimes(2);
    expect(audio.state).toBe('starting');
    target.dispatchEvent(new Event('click'));
    target.dispatchEvent(new Event('keydown'));
    expect(audio.start).toHaveBeenCalledTimes(2);
    await audio.complete('on');
    audio.stop();
    target.dispatchEvent(new Event('click'));
    expect(audio.start).toHaveBeenCalledTimes(2);
    expect(audio.state).toBe('off');
    cleanup();
  });

  it('allows another gesture if the browser still blocks the first retry', async () => {
    const { audio, target, cleanup } = setup();
    await audio.complete('blocked');
    target.dispatchEvent(new Event('click'));
    await audio.complete('blocked');
    target.dispatchEvent(new Event('keydown'));
    expect(audio.start).toHaveBeenCalledTimes(3);
    await audio.complete('on');
    cleanup();
  });

  it('does not resume when playback was explicitly stopped while awaiting a gesture', async () => {
    const { audio, target, cleanup } = setup();
    await audio.complete('blocked');
    audio.stop();
    target.dispatchEvent(new Event('click'));
    target.dispatchEvent(new Event('keydown'));
    expect(audio.state).toBe('off');
    expect(audio.start).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it.each(['click', 'keydown'])('does not duplicate an explicit play handler registered before the %s fallback', async (gesture) => {
    const audio = new Playback();
    const target = new EventTarget();
    target.addEventListener(gesture, () => { void audio.start(); });
    const cleanup = startAutoplay(audio as unknown as AudioSystem, target);
    await audio.complete('blocked');
    target.dispatchEvent(new Event(gesture));
    expect(audio.start).toHaveBeenCalledTimes(2);
    await audio.complete('on');
    cleanup();
  });

  it.each(['unavailable', 'off'] as const)('does not retry after an initial %s result', async (state) => {
    const { audio, target, cleanup } = setup();
    await audio.complete(state);
    target.dispatchEvent(new Event('click'));
    target.dispatchEvent(new Event('keydown'));
    expect(audio.start).toHaveBeenCalledTimes(1);
    expect(audio.state).toBe(state);
    cleanup();
  });

  it('stops automatic retries if the gesture retry encounters a network error', async () => {
    const { audio, target, cleanup } = setup();
    await audio.complete('blocked');
    target.dispatchEvent(new Event('click'));
    await audio.complete('unavailable');
    target.dispatchEvent(new Event('click'));
    target.dispatchEvent(new Event('keydown'));
    expect(audio.start).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it.each(['pending', 'blocked'] as const)('cleanup prevents future gesture retries when playback is %s', async (phase) => {
    const { audio, target, cleanup } = setup();
    if (phase === 'blocked') await audio.complete('blocked');
    cleanup();
    if (phase === 'pending') await audio.complete('blocked');
    target.dispatchEvent(new Event('click'));
    target.dispatchEvent(new Event('keydown'));
    expect(audio.start).toHaveBeenCalledTimes(1);
    expect(audio.state).toBe('blocked');
  });

  it('cleanup leaves already playing audio running', async () => {
    const { audio, cleanup } = setup();
    await audio.complete('on');
    cleanup();
    expect(audio.state).toBe('on');
  });
});
