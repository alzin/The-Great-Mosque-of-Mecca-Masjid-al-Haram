/**
 * PrayerOrchestrator.ts — the precinct-wide state machine and the salah
 * animation timeline.
 *
 * THE SEQUENCE
 *   The postures and their order follow the standard congregational salah:
 *     takbirat al-ihram (standing, hands raised)
 *     -> qiyam (standing recitation)
 *     -> ruku (bowing, back level, hands on knees)
 *     -> i'tidal (returning to standing)
 *     -> sujud (prostration)
 *     -> jalsa (sitting between the two prostrations)
 *     -> sujud (second prostration)
 *     -> rise for the next rak'ah, or sit for tashahhud
 *     -> tashahhud (final sitting)
 *     -> taslim (greeting to the right, then to the left)
 *   A middle tashahhud is inserted after the second rak'ah of a three- or
 *   four-rak'ah prayer.
 *
 * DOCUMENTED SIMPLIFICATIONS
 *   * Segment durations are compressed relative to a real congregation so a
 *     complete cycle is watchable; `durationScale` exposes this.
 *   * Qunut, sujud al-sahw and the differences between the madhahib in the
 *     details of hand placement and the sitting posture are not modelled.
 *   * The simulation renders body posture only; it contains no audio or text
 *     of recitation.
 *
 * ADHAN / IQAMAH / START
 *   These are kept as three separate, separately configurable events, because
 *   they are separated in practice by an interval that varies by prayer and
 *   by mosque. The simulation clock is a demonstration clock: it is NOT a
 *   prayer-time calculator and makes no claim about when any congregation in
 *   Makkah actually begins.
 */

import { Clip, GlobalPhase } from './States.ts';
import type { Crowd } from './Crowd.ts';

export interface TimelineSegment {
  clip: Clip;
  /** Seconds. */
  duration: number;
  /** Human-readable label for the UI. */
  label: string;
  /** True for held postures (the baked clip loops); false for transitions. */
  hold: boolean;
}

export interface PrayerTimeline {
  segments: TimelineSegment[];
  /** Cumulative start time of each segment. */
  starts: Float32Array;
  total: number;
  rakahs: number;
}

export interface TimelineSample {
  clip: Clip;
  /** Normalised progress through the clip, 0..1. */
  t01: number;
  /** Clip being blended out of, or the same clip when not blending. */
  prevClip: Clip;
  prevT01: number;
  /** 0 = fully prevClip, 1 = fully clip. */
  blend: number;
  segment: number;
  label: string;
}

const BLEND_TIME = 0.16;

/** Base (unscaled) durations in seconds, tuned for a watchable demonstration. */
const D = {
  takbir: 1.5,
  qiyamFirst: 14.0,
  qiyamOther: 10.0,
  toRuku: 1.3,
  ruku: 5.5,
  fromRuku: 1.2,
  itidal: 3.4,
  toSujud: 1.6,
  sujud: 5.0,
  sujudToJalsa: 1.2,
  jalsa: 3.2,
  jalsaToSujud: 1.1,
  sujudToStand: 1.9,
  tashahhudMiddle: 6.0,
  tashahhudFinal: 11.0,
  taslim: 3.6,
  sitToStand: 2.2,
};

export function buildPrayerTimeline(rakahs = 2, durationScale = 1): PrayerTimeline {
  const seg: TimelineSegment[] = [];
  const push = (clip: Clip, duration: number, label: string, hold: boolean) => {
    seg.push({ clip, duration: Math.max(0.2, duration * durationScale), label, hold });
  };

  for (let r = 0; r < rakahs; r++) {
    const isLast = r === rakahs - 1;
    const isMiddle = rakahs > 2 && r === 1;

    push(Clip.TAKBIR, D.takbir, r === 0 ? 'Takbirat al-ihram' : 'Takbir', false);
    push(Clip.QIYAM, r === 0 ? D.qiyamFirst : D.qiyamOther, `Qiyam \u2014 rak\u2018ah ${r + 1}`, true);
    push(Clip.TO_RUKU, D.toRuku, 'Bowing', false);
    push(Clip.RUKU, D.ruku, 'Ruku', true);
    push(Clip.FROM_RUKU, D.fromRuku, 'Rising', false);
    push(Clip.ITIDAL, D.itidal, "I'tidal", true);
    push(Clip.TO_SUJUD, D.toSujud, 'Descending', false);
    push(Clip.SUJUD, D.sujud, 'Sujud', true);
    push(Clip.SUJUD_TO_JALSA, D.sujudToJalsa, 'Rising', false);
    push(Clip.JALSA, D.jalsa, 'Jalsa', true);
    push(Clip.JALSA_TO_SUJUD, D.jalsaToSujud, 'Descending', false);
    push(Clip.SUJUD, D.sujud, 'Sujud', true);

    if (isLast) {
      push(Clip.SUJUD_TO_JALSA, D.sujudToJalsa, 'Sitting', false);
      push(Clip.TASHAHHUD, D.tashahhudFinal, 'Tashahhud', true);
      push(Clip.TASLIM, D.taslim, 'Taslim', false);
      push(Clip.SIT_TO_STAND, D.sitToStand, 'Rising', false);
    } else if (isMiddle) {
      push(Clip.SUJUD_TO_JALSA, D.sujudToJalsa, 'Sitting', false);
      push(Clip.TASHAHHUD, D.tashahhudMiddle, 'Tashahhud', true);
      push(Clip.SIT_TO_STAND, D.sitToStand, 'Rising', false);
    } else {
      push(Clip.SUJUD_TO_STAND, D.sujudToStand, 'Rising', false);
    }
  }

  const starts = new Float32Array(seg.length + 1);
  let t = 0;
  for (let i = 0; i < seg.length; i++) {
    starts[i] = t;
    t += seg[i].duration;
  }
  starts[seg.length] = t;

  return { segments: seg, starts, total: t, rakahs };
}

const _sample: TimelineSample = {
  clip: Clip.QIYAM,
  t01: 0,
  prevClip: Clip.QIYAM,
  prevT01: 0,
  blend: 1,
  segment: 0,
  label: '',
};

/**
 * Resolve a timeline time into clip state. Held postures loop their (short)
 * baked clip; transitions play through once. A short cross-fade smooths the
 * junction between segments.
 */
export function sampleTimeline(tl: PrayerTimeline, time: number): TimelineSample {
  const t = Math.max(0, Math.min(tl.total - 1e-4, time));
  // Binary search for the segment.
  let lo = 0;
  let hi = tl.segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tl.starts[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  const s = tl.segments[i];
  const local = t - tl.starts[i];
  const t01 = s.hold ? (local / Math.max(0.001, s.duration)) % 1 : local / s.duration;

  _sample.segment = i;
  _sample.clip = s.clip;
  _sample.t01 = Math.min(1, Math.max(0, t01));
  _sample.label = s.label;

  if (local < BLEND_TIME && i > 0) {
    const p = tl.segments[i - 1];
    _sample.prevClip = p.clip;
    _sample.prevT01 = 1;
    _sample.blend = local / BLEND_TIME;
  } else {
    _sample.prevClip = s.clip;
    _sample.prevT01 = _sample.t01;
    _sample.blend = 1;
  }
  return _sample;
}

// ---------------------------------------------------------------------------

export interface PrayerSettings {
  /** Seconds between the adhan and iqamah in the demonstration schedule. */
  adhanToIqamah: number;
  /** Seconds allowed for rows to form before the prayer starts regardless. */
  maxRowFormation: number;
  /** Settled fraction that lets the prayer start early. */
  startThreshold: number;
  rakahs: number;
  durationScale: number;
  /** Seconds spent dispersing after taslim before normal activity resumes. */
  postPrayer: number;
  /** When true, a demonstration prayer runs on a repeating interval. */
  scheduleEnabled: boolean;
  scheduleInterval: number;
}

export const DEFAULT_PRAYER_SETTINGS: PrayerSettings = {
  adhanToIqamah: 25,
  maxRowFormation: 75,
  startThreshold: 0.85,
  rakahs: 2,
  durationScale: 1,
  postPrayer: 26,
  scheduleEnabled: false,
  scheduleInterval: 420,
};

export class PrayerOrchestrator {
  phase: GlobalPhase = GlobalPhase.NORMAL_ACTIVITY;
  settings: PrayerSettings = { ...DEFAULT_PRAYER_SETTINGS };
  timeline: PrayerTimeline;
  /** Time within the current phase, seconds. */
  phaseTime = 0;
  /** Set on entry to PREPARATION. */
  adhanCalled = false;
  iqamahCalled = false;
  /** Simulated seconds until the next scheduled demonstration prayer. */
  scheduleCountdown: number;
  /** Label of the current prayer segment, for the UI. */
  currentLabel = '';
  /** Incremented every time a full prayer cycle completes. */
  completedPrayers = 0;

  private events: Array<{ t: number; text: string }> = [];
  private readonly crowd: Crowd;

  constructor(crowd: Crowd) {
    this.crowd = crowd;
    this.timeline = buildPrayerTimeline(this.settings.rakahs, this.settings.durationScale);
    this.scheduleCountdown = this.settings.scheduleInterval;
  }

  rebuildTimeline(): void {
    this.timeline = buildPrayerTimeline(this.settings.rakahs, this.settings.durationScale);
  }

  get recentEvents(): ReadonlyArray<{ t: number; text: string }> {
    return this.events;
  }

  private logEvent(simTime: number, text: string): void {
    this.events.unshift({ t: simTime, text });
    if (this.events.length > 6) this.events.pop();
  }

  /** Manual control: call the adhan and start preparation. */
  prepare(simTime: number): boolean {
    if (this.phase !== GlobalPhase.NORMAL_ACTIVITY) return false;
    this.setPhase(GlobalPhase.PREPARATION);
    this.adhanCalled = true;
    this.iqamahCalled = false;
    this.logEvent(simTime, 'Adhan \u2014 preparation begins');
    return true;
  }

  /** Manual control: give the iqamah and form the rows. */
  startPrayer(simTime: number): boolean {
    if (this.phase === GlobalPhase.NORMAL_ACTIVITY) {
      this.prepare(simTime);
    }
    if (this.phase !== GlobalPhase.PREPARATION) return false;
    this.setPhase(GlobalPhase.ROW_FORMATION);
    this.iqamahCalled = true;
    this.crowd.beginRowFormation();
    this.logEvent(simTime, 'Iqamah \u2014 rows forming');
    return true;
  }

  /** Manual control: abandon the current prayer cycle and resume activity. */
  cancel(simTime: number): void {
    if (this.phase === GlobalPhase.NORMAL_ACTIVITY) return;
    this.crowd.endPrayer();
    this.setPhase(GlobalPhase.NORMAL_ACTIVITY);
    this.crowd.preparationPull = 0;
    this.logEvent(simTime, 'Prayer cycle cancelled');
  }

  private setPhase(p: GlobalPhase): void {
    this.phase = p;
    this.phaseTime = 0;
    this.crowd.phaseState = p;
  }

  update(dt: number, simTime: number): void {
    this.phaseTime += dt;

    switch (this.phase) {
      case GlobalPhase.NORMAL_ACTIVITY: {
        this.crowd.preparationPull = 0;
        this.currentLabel = '';
        if (this.settings.scheduleEnabled) {
          this.scheduleCountdown -= dt;
          if (this.scheduleCountdown <= 0) {
            this.scheduleCountdown = this.settings.scheduleInterval;
            this.prepare(simTime);
          }
        } else {
          this.scheduleCountdown = this.settings.scheduleInterval;
        }
        break;
      }

      case GlobalPhase.PREPARATION: {
        // The pull toward the prayer area grows through the interval, so the
        // change in the crowd is gradual rather than a switch being thrown.
        const f = Math.min(1, this.phaseTime / Math.max(1, this.settings.adhanToIqamah));
        this.crowd.preparationPull = f * 0.7;
        this.currentLabel = 'Awaiting iqamah';
        if (this.phaseTime >= this.settings.adhanToIqamah) {
          this.startPrayer(simTime);
        }
        break;
      }

      case GlobalPhase.ROW_FORMATION: {
        this.crowd.preparationPull = 0;
        const settled = this.crowd.settledFraction();
        this.currentLabel = `Rows forming \u2014 ${Math.round(settled * 100)}% in place`;
        if (settled >= this.settings.startThreshold || this.phaseTime >= this.settings.maxRowFormation) {
          this.setPhase(GlobalPhase.PRAYER);
          this.crowd.beginPrayer();
          this.logEvent(simTime, `Prayer begins \u2014 ${this.settings.rakahs} rak\u2018ah`);
        }
        break;
      }

      case GlobalPhase.PRAYER: {
        this.crowd.prayerClock += dt;
        const s = sampleTimeline(this.timeline, this.crowd.prayerClock);
        this.currentLabel = s.label;
        if (this.crowd.prayerClock >= this.timeline.total) {
          this.setPhase(GlobalPhase.POST_PRAYER);
          this.crowd.endPrayer();
          this.completedPrayers++;
          this.logEvent(simTime, 'Taslim \u2014 congregation disperses');
        }
        break;
      }

      case GlobalPhase.POST_PRAYER: {
        this.currentLabel = 'Dispersing';
        if (this.phaseTime >= this.settings.postPrayer) {
          this.setPhase(GlobalPhase.NORMAL_ACTIVITY);
          this.adhanCalled = false;
          this.iqamahCalled = false;
        }
        break;
      }
    }
  }

  reset(): void {
    this.phase = GlobalPhase.NORMAL_ACTIVITY;
    this.crowd.phaseState = GlobalPhase.NORMAL_ACTIVITY;
    this.phaseTime = 0;
    this.adhanCalled = false;
    this.iqamahCalled = false;
    this.crowd.prayerClock = 0;
    this.crowd.preparationPull = 0;
    this.scheduleCountdown = this.settings.scheduleInterval;
    this.events = [];
    this.completedPrayers = 0;
  }
}
