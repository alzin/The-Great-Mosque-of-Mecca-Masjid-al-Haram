/**
 * AnimationDirector.ts — decides which clip every agent is playing.
 *
 * This is deliberately separate from both the crowd simulation (which owns
 * positions and intent) and the renderer (which owns GPU state). It reads
 * agent state and speed, and writes four fields back into the crowd's
 * structure-of-arrays: `clip`, `clipTime`, `prevClip`, `clipBlend`.
 *
 * FOOT SLIDING
 *   Walk playback rate is derived from ground speed, never from wall time:
 *
 *     cycles per second = speed / (strideFraction * bodyHeight)
 *
 *   `strideFraction` is the ground distance one full two-step cycle covers,
 *   expressed as a fraction of body height, and it is a property of the baked
 *   clip. Because the same number drives both the animation and nothing else,
 *   a person walking at 0.3 m/s shuffles and a person at 1.3 m/s strides, and
 *   neither skates.
 *
 * CONGREGATION SYNCHRONY
 *   Worshippers follow the imam, so they share one timeline. A small
 *   per-person delay (tens to a few hundred milliseconds, stored by the crowd
 *   as `prayerDelay`) keeps the rows from looking like a single rigid object
 *   while preserving the sense of a congregation moving together.
 */

import { Clip, AgentState } from '../sim/States.ts';
import type { Crowd } from '../sim/Crowd.ts';
import type { PrayerTimeline } from '../sim/PrayerOrchestrator.ts';
import { sampleTimeline } from '../sim/PrayerOrchestrator.ts';
import { CLIPS, WALK_STRIDE_FRACTION } from './AnimationBank.ts';

/** Seconds taken to cross-fade when an agent changes clip. */
const BLEND_TIME = 0.18;

/** Below this speed a walking agent is treated as standing. */
const IDLE_SPEED = 0.09;
/** Below this speed the short-step shuffle clip is used instead of the walk. */
const SHUFFLE_SPEED = 0.62;

/** Cycles per second for the looping idle clip. */
const IDLE_RATE = 1 / 3.6;
const SHUFFLE_STRIDE = WALK_STRIDE_FRACTION * 0.5;

export class AnimationDirector {
  /** Frozen normalised time of the clip being blended out of. */
  readonly prevClipTime: Float32Array;

  constructor(capacity: number) {
    this.prevClipTime = new Float32Array(capacity);
  }

  /**
   * Advance every live agent's animation state by `dt` seconds.
   *
   * @param prayerClock Seconds into the salah timeline, or a negative number
   *                    when no prayer is in progress.
   */
  update(crowd: Crowd, dt: number, timeline: PrayerTimeline, prayerClock: number): void {
    const ids = crowd.liveIdsView();
    const n = ids.length;
    const praying = prayerClock >= 0;

    for (let k = 0; k < n; k++) {
      const id = ids[k];
      const state = crowd.state[id];

      let want: number;
      let wantTime = -1; // negative means "advance the existing phase"
      let rate = IDLE_RATE;

      if (praying && (state === AgentState.PRAYING || state === AgentState.RESUMING_ACTIVITY)) {
        // Follow the imam's timeline, offset by this person's small delay.
        const s = sampleTimeline(timeline, prayerClock - crowd.prayerDelay[id]);
        want = s.clip;
        wantTime = s.t01;
        // The timeline supplies its own cross-fade, so if the clip changed we
        // adopt it immediately rather than double-blending.
        if (crowd.clip[id] !== want) {
          crowd.prevClip[id] = s.prevClip;
          this.prevClipTime[id] = s.prevT01;
          crowd.clipBlend[id] = 0;
        }
      } else if (state === AgentState.PRAYING) {
        // Standing in the row, prayer not yet started.
        want = Clip.QIYAM;
        rate = 1 / 6;
      } else {
        const speed = crowd.speed[id];
        if (speed < IDLE_SPEED) {
          want = Clip.IDLE;
          rate = IDLE_RATE;
        } else if (speed < SHUFFLE_SPEED) {
          want = Clip.SHUFFLE;
          rate = speed / (SHUFFLE_STRIDE * crowd.height[id]);
        } else {
          want = Clip.WALK;
          rate = speed / (WALK_STRIDE_FRACTION * crowd.height[id]);
        }
      }

      // --- clip change -----------------------------------------------------
      if (want !== crowd.clip[id] && wantTime < 0) {
        crowd.prevClip[id] = crowd.clip[id];
        this.prevClipTime[id] = crowd.clipTime[id];
        crowd.clipBlend[id] = 0;
        crowd.clip[id] = want;
        // Entering a walk from a standstill should not start mid-stride with a
        // foot in the air; start on a contact frame.
        crowd.clipTime[id] = want === Clip.WALK || want === Clip.SHUFFLE ? 0 : 0;
      } else {
        crowd.clip[id] = want;
      }

      // --- advance ---------------------------------------------------------
      if (wantTime >= 0) {
        crowd.clipTime[id] = wantTime;
      } else {
        let t = crowd.clipTime[id] + rate * dt;
        if (CLIPS[want].loop) {
          t -= Math.floor(t);
        } else if (t > 1) {
          t = 1;
        }
        crowd.clipTime[id] = t;
      }

      if (crowd.clipBlend[id] < 1) {
        crowd.clipBlend[id] = Math.min(1, crowd.clipBlend[id] + dt / BLEND_TIME);
      }
    }
  }

  /** Put one agent into a clip immediately, with no cross-fade. */
  snap(crowd: Crowd, id: number, clip: number, t01 = 0): void {
    crowd.clip[id] = clip;
    crowd.prevClip[id] = clip;
    crowd.clipTime[id] = t01;
    this.prevClipTime[id] = t01;
    crowd.clipBlend[id] = 1;
  }
}
