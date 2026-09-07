import type { AudioState, AudioSystem } from './AudioSystem.ts';

/** Try on entry, then retry blocked playback inside a real user interaction. */
export function startAutoplay(audio: AudioSystem, target: EventTarget = window): () => void {
  const cleanup = () => {
    target.removeEventListener('click', onInteraction);
    target.removeEventListener('keydown', onInteraction);
  };
  const afterAttempt = (state: AudioState) => {
    if (state !== 'blocked') cleanup();
  };
  const onInteraction = () => {
    if (audio.state === 'blocked') {
      // Call synchronously while the browser's user activation is still valid.
      void audio.start().then(afterAttempt);
    } else if (audio.state !== 'starting') {
      // A manual pause or an actual stream error must never trigger autoplay.
      cleanup();
    }
  };

  // Bubble after the Quran button and M shortcut have handled the same event.
  target.addEventListener('click', onInteraction);
  target.addEventListener('keydown', onInteraction);
  void audio.start().then(afterAttempt);
  return cleanup;
}
