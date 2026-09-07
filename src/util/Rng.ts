/**
 * Rng.ts — a small deterministic PRNG (mulberry32) plus a Gaussian sampler.
 * Determinism matters here: soak tests and benchmarks must be reproducible.
 */
export class Rng {
  private s: number;
  private spare: number | null = null;

  constructor(seed = 1) {
    this.s = seed >>> 0;
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(n: number): number {
    return Math.floor(this.next() * n) % Math.max(1, n);
  }

  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  /** Box-Muller, cached spare. Mean 0, sigma 1, clamped to +/-3. */
  gaussian(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = Math.max(-3, Math.min(3, v * mul));
    return Math.max(-3, Math.min(3, u * mul));
  }
}
