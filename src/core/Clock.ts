/**
 * Clock.ts — a fixed-timestep accumulator with render interpolation.
 *
 * WHY FIXED
 *   Steering, collision response and row formation are all iterative. If the
 *   timestep varies with frame rate, agents on a slow machine take longer
 *   steps, tunnel through each other, and the whole crowd behaves differently
 *   from the same simulation on a fast machine. Fixing the timestep makes the
 *   simulation reproducible and stable regardless of display rate.
 *
 * WHY INTERPOLATE
 *   The simulation runs at 30 Hz. A 60 Hz display asking for raw simulation
 *   state would show each position twice, which reads as a judder even though
 *   the underlying motion is smooth. `alpha` is the fraction of the way to the
 *   next tick, and the render layer uses it to interpolate.
 *
 * SPIRAL OF DEATH
 *   If simulation cost exceeds real time — a huge population on a slow
 *   machine — running "until caught up" would never catch up and the tab
 *   would lock. `maxTicksPerFrame` caps the work and the clock quietly drops
 *   the surplus, reporting it so the diagnostics panel can show that the
 *   simulation is running behind wall time rather than pretending otherwise.
 *
 * BACKGROUND TABS
 *   A hidden tab stops firing animation frames. On return, the elapsed wall
 *   time can be minutes. `resync()` throws that away instead of trying to
 *   simulate it, so returning to the tab resumes rather than fast-forwards.
 */

export interface ClockStats {
  /** Simulation ticks executed on the last frame. */
  ticks: number;
  /** Ticks dropped on the last frame because of the cap. */
  dropped: number;
  /** Total simulated seconds. */
  simTime: number;
  /** Total simulation ticks since the start. */
  totalTicks: number;
}

export class FixedClock {
  /** Seconds per simulation tick. */
  readonly dt: number;
  private accumulator = 0;
  private lastMs = 0;
  private started = false;

  readonly stats: ClockStats = { ticks: 0, dropped: 0, simTime: 0, totalTicks: 0 };

  constructor(
    hz = 30,
    /** Hard cap on catch-up work in one frame. */
    private readonly maxTicksPerFrame = 5,
  ) {
    this.dt = 1 / hz;
  }

  /** Discard accumulated time; call after a pause or a tab restore. */
  resync(nowMs: number): void {
    this.lastMs = nowMs;
    this.accumulator = 0;
    this.started = true;
  }

  /**
   * Advance the clock. Calls `tick` zero or more times, then returns the
   * interpolation factor for rendering.
   *
   * @param speed Simulation speed multiplier (1 = real time, 0 = paused).
   */
  advance(nowMs: number, speed: number, tick: (dt: number) => void): number {
    if (!this.started) {
      this.resync(nowMs);
      return 0;
    }

    let frame = (nowMs - this.lastMs) / 1000;
    this.lastMs = nowMs;
    // A single enormous frame (tab restore, breakpoint, GC pause) is clamped
    // rather than simulated.
    if (!Number.isFinite(frame) || frame < 0) frame = 0;
    if (frame > 0.5) frame = 0.5;

    this.accumulator += frame * speed;

    let ticks = 0;
    let dropped = 0;
    while (this.accumulator >= this.dt) {
      if (ticks >= this.maxTicksPerFrame) {
        // Cannot keep up: discard the backlog so we do not spiral.
        dropped = Math.floor(this.accumulator / this.dt);
        this.accumulator = 0;
        break;
      }
      this.accumulator -= this.dt;
      tick(this.dt);
      ticks++;
      this.stats.totalTicks++;
      this.stats.simTime += this.dt;
    }

    this.stats.ticks = ticks;
    this.stats.dropped = dropped;

    return speed > 0 ? Math.min(1, this.accumulator / this.dt) : 1;
  }

  reset(): void {
    this.accumulator = 0;
    this.started = false;
    this.stats.simTime = 0;
    this.stats.totalTicks = 0;
    this.stats.ticks = 0;
    this.stats.dropped = 0;
  }
}

/** Rolling average of frame timings, for the diagnostics panel. */
export class FrameTimer {
  private readonly samples: Float32Array;
  private index = 0;
  private filled = 0;

  constructor(size = 90) {
    this.samples = new Float32Array(size);
  }

  push(ms: number): void {
    this.samples[this.index] = ms;
    this.index = (this.index + 1) % this.samples.length;
    if (this.filled < this.samples.length) this.filled++;
  }

  get average(): number {
    if (this.filled === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this.filled; i++) sum += this.samples[i];
    return sum / this.filled;
  }

  /** 95th percentile, which is where stutter actually shows up. */
  get p95(): number {
    if (this.filled === 0) return 0;
    const copy = Array.from(this.samples.subarray(0, this.filled)).sort((a, b) => a - b);
    return copy[Math.min(copy.length - 1, Math.floor(copy.length * 0.95))];
  }

  get fps(): number {
    const a = this.average;
    return a > 0 ? 1000 / a : 0;
  }

  reset(): void {
    this.index = 0;
    this.filled = 0;
    this.samples.fill(0);
  }
}
