/**
 * PrayerLayout.ts — generation of congregational prayer positions around the
 * Kaaba, and locality-aware assignment of worshippers to them.
 *
 * ARRANGEMENT
 *   In Masjid al-Haram the qibla is the Kaaba itself, so the rows are not a
 *   rectangular grid facing one world direction: they are concentric rings
 *   centred on the Kaaba, and every worshipper faces inward along their own
 *   radius. Rows are generated from the inside out, since the front (inner)
 *   rows fill first.
 *
 *   Slots are rejected where they collide with the Kaaba footprint, the Hijr
 *   Ismail, the Maqam Ibrahim, the Zamzam kiosk, gallery columns, or the
 *   radial service aisles that are kept clear for circulation.
 *
 * ASSIGNMENT
 *   Angular bucketing keeps the assignment local: a worshipper standing in
 *   the south-west of the courtyard is offered slots in the south-west first,
 *   so nobody has to cross the whole mataf. Buckets are searched outward from
 *   the worshipper's own bucket, and within a bucket slots are handed out
 *   innermost-first. Every slot is handed out at most once by construction.
 */

import { PRAYER_LAYOUT } from '../config/site.ts';
import { OBSTACLES, insideTawafExclusion, nearestObstacleDistance, wrapAngle } from './Obstacles.ts';

export interface PrayerSlots {
  /** World X of each slot. */
  readonly x: Float32Array;
  /** World Z of each slot. */
  readonly z: Float32Array;
  /** Facing yaw (radians) — toward the Kaaba centre. */
  readonly yaw: Float32Array;
  /** Row index, 0 = innermost. */
  readonly row: Int32Array;
  /** Radius of the slot from the Kaaba centre. */
  readonly radius: Float32Array;
  readonly count: number;
  /** Number of angular buckets used for locality. */
  readonly bucketCount: number;
  /** bucketStart[b]..bucketStart[b+1] indexes into `order`. */
  readonly bucketStart: Int32Array;
  /** Slot indices sorted by (bucket, row). */
  readonly order: Int32Array;
  /** Number of rows generated. */
  readonly rowCount: number;
  /** rowCumulative[r] = number of slots in rows 0..r-1. */
  readonly rowCumulative: Int32Array;
}

const BUCKETS = 96;
/** How many rows behind the fill frontier a worshipper may still be placed. */
const SLOT_ROW_SLACK = 4;
/** Bound on the per-bucket forward scan, so claim() stays effectively O(1). */
const BUCKET_SCAN_LIMIT = 96;

/**
 * Convert a world position into the yaw an agent needs so that its forward
 * axis (+Z in the character's local frame) points at the Kaaba centre.
 */
export function yawTowardKaaba(x: number, z: number): number {
  // Character forward is +Z local. To face the origin, forward = normalize(-x, -z).
  return Math.atan2(-x, -z);
}

export function generatePrayerSlots(): PrayerSlots {
  const xs: number[] = [];
  const zs: number[] = [];
  const yaws: number[] = [];
  const rows: number[] = [];
  const radii: number[] = [];

  const { firstRowRadius, rowSpacing, lateralSpacing, lastRowRadius, aisleBearings, aisleHalfWidth, obstacleClearance } =
    PRAYER_LAYOUT;

  const rowCount = Math.floor((lastRowRadius - firstRowRadius) / rowSpacing) + 1;

  for (let row = 0; row < rowCount; row++) {
    const r = firstRowRadius + row * rowSpacing;
    const circumference = 2 * Math.PI * r;
    const n = Math.max(8, Math.floor(circumference / lateralSpacing));
    // Alternate the angular phase between rows so worshippers are not in
    // perfectly radial columns — this matches how real rows stagger and it
    // also keeps sujud space between adjacent rows.
    const phase = (row % 2) * (Math.PI / n);

    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + phase;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;

      // Radial service aisles kept clear.
      let inAisle = false;
      for (const ab of aisleBearings) {
        // Aisle half-width is specified in metres at this radius.
        const halfAngle = Math.min(Math.PI / 2, aisleHalfWidth / Math.max(1, r));
        if (Math.abs(wrapAngle(a - ab)) < halfAngle) {
          inAisle = true;
          break;
        }
      }
      if (inAisle) continue;

      if (insideTawafExclusion(x, z, obstacleClearance)) continue;
      if (nearestObstacleDistance(x, z, OBSTACLES) < obstacleClearance) continue;

      xs.push(x);
      zs.push(z);
      yaws.push(yawTowardKaaba(x, z));
      rows.push(row);
      radii.push(r);
    }
  }

  const count = xs.length;
  const generatedRows = rowCount;
  const perRow = new Int32Array(generatedRows);
  for (const r of rows) perRow[r]++;
  const rowCumulative = new Int32Array(generatedRows + 1);
  for (let r = 0; r < generatedRows; r++) rowCumulative[r + 1] = rowCumulative[r] + perRow[r];

  const slots = {
    x: Float32Array.from(xs),
    z: Float32Array.from(zs),
    yaw: Float32Array.from(yaws),
    row: Int32Array.from(rows),
    radius: Float32Array.from(radii),
    count,
    bucketCount: BUCKETS,
    rowCount: generatedRows,
    rowCumulative,
  };

  // Build bucket index: sort slot ids by (bucket, row).
  const bucketOf = new Int32Array(count);
  const bucketStart = new Int32Array(BUCKETS + 1);
  for (let i = 0; i < count; i++) {
    let a = Math.atan2(slots.z[i], slots.x[i]);
    if (a < 0) a += Math.PI * 2;
    let b = Math.floor((a / (Math.PI * 2)) * BUCKETS);
    if (b >= BUCKETS) b = BUCKETS - 1;
    bucketOf[i] = b;
    bucketStart[b]++;
  }
  let running = 0;
  for (let b = 0; b < BUCKETS; b++) {
    const c = bucketStart[b];
    bucketStart[b] = running;
    running += c;
  }
  bucketStart[BUCKETS] = running;

  const cursor = new Int32Array(BUCKETS);
  const order = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const b = bucketOf[i];
    order[bucketStart[b] + cursor[b]] = i;
    cursor[b]++;
  }
  // Sort each bucket innermost row first.
  for (let b = 0; b < BUCKETS; b++) {
    const s = bucketStart[b];
    const e = bucketStart[b + 1];
    const sub = Array.from(order.subarray(s, e));
    sub.sort((p, q) => slots.row[p] - slots.row[q]);
    for (let k = 0; k < sub.length; k++) order[s + k] = sub[k];
  }

  return { ...slots, bucketStart, order };
}

/**
 * Stateful allocator. Hands out unique slots, preferring slots close to the
 * requester's current bearing and as far forward (inner) as still available.
 */
export class SlotAllocator {
  readonly slots: PrayerSlots;
  /** -1 when free, otherwise the agent id holding the slot. */
  private readonly owner: Int32Array;
  /** Per-bucket cursor into `order` — everything before it is taken. */
  private readonly cursor: Int32Array;
  private _used = 0;

  constructor(slots: PrayerSlots) {
    this.slots = slots;
    this.owner = new Int32Array(slots.count).fill(-1);
    this.cursor = new Int32Array(slots.bucketCount);
  }

  get used(): number {
    return this._used;
  }

  get capacity(): number {
    return this.slots.count;
  }

  get free(): number {
    return this.slots.count - this._used;
  }

  reset(): void {
    this.owner.fill(-1);
    this.cursor.fill(0);
    this._used = 0;
  }

  ownerOf(slot: number): number {
    return this.owner[slot];
  }

  /** Advance a bucket's cursor past slots that are already taken. */
  private advance(bucket: number): number {
    const { bucketStart, order } = this.slots;
    const end = bucketStart[bucket + 1];
    let c = bucketStart[bucket] + this.cursor[bucket];
    while (c < end && this.owner[order[c]] !== -1) c++;
    this.cursor[bucket] = c - bucketStart[bucket];
    return c;
  }

  /**
   * The row the congregation has filled up to, given how many places have
   * been handed out. Without this, a worshipper standing far out but in an
   * angular sector that happens to be sparse would be sent to a front row
   * and have to cross the entire courtyard. The frontier keeps the walk
   * short while still filling from the front.
   */
  fairRow(assigned: number): number {
    const cum = this.slots.rowCumulative;
    let lo = 0;
    let hi = this.slots.rowCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid + 1] <= assigned) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Claim the best free slot for an agent currently at (x, z).
   * Returns the slot index, or -1 when the layout is full.
   */
  claim(agentId: number, x: number, z: number): number {
    const { bucketCount, bucketStart, order, row } = this.slots;
    let a = Math.atan2(z, x);
    if (a < 0) a += Math.PI * 2;
    let home = Math.floor((a / (Math.PI * 2)) * bucketCount);
    if (home >= bucketCount) home = bucketCount - 1;

    // Allow a few rows of slack so locality still has room to work.
    const minRow = Math.max(0, this.fairRow(this._used) - SLOT_ROW_SLACK);

    let best = -1;
    let bestRow = Infinity;

    for (let spread = 0; spread < bucketCount; spread++) {
      const lo = spread === 0 ? 0 : -spread;
      for (let step = 0; step < (spread === 0 ? 1 : 2); step++) {
        const off = step === 0 ? spread : lo;
        const b = (home + off + bucketCount) % bucketCount;
        const start = this.advance(b);
        const end = bucketStart[b + 1];
        // Slots within a bucket are ordered by row, so the first free entry
        // at or beyond the frontier is the best this bucket can offer.
        const scanLimit = Math.min(end, start + BUCKET_SCAN_LIMIT);
        for (let c = start; c < scanLimit; c++) {
          const slot = order[c];
          if (this.owner[slot] !== -1) continue;
          if (row[slot] < minRow) continue;
          if (row[slot] < bestRow) {
            bestRow = row[slot];
            best = slot;
          }
          break;
        }
      }
      if (best !== -1 && spread >= 2) break;
    }

    if (best === -1) {
      // Frontier search found nothing (layout nearly full): fall back to any
      // free slot at all so we never overlap people to satisfy a request.
      for (let i = 0; i < this.owner.length; i++) {
        if (this.owner[i] === -1) {
          best = i;
          break;
        }
      }
      if (best === -1) return -1;
    }
    this.owner[best] = agentId;
    this._used++;
    return best;
  }

  release(slot: number): void {
    if (slot < 0 || slot >= this.owner.length) return;
    if (this.owner[slot] === -1) return;
    this.owner[slot] = -1;
    this._used--;
    // Rewind the bucket cursor so the freed slot can be handed out again.
    const { bucketCount, bucketStart, x, z } = this.slots;
    let a = Math.atan2(z[slot], x[slot]);
    if (a < 0) a += Math.PI * 2;
    let b = Math.floor((a / (Math.PI * 2)) * bucketCount);
    if (b >= bucketCount) b = bucketCount - 1;
    // Find the freed slot's position within the bucket ordering.
    const s = bucketStart[b];
    const e = bucketStart[b + 1];
    for (let c = s; c < e; c++) {
      if (this.slots.order[c] === slot) {
        const rel = c - s;
        if (rel < this.cursor[b]) this.cursor[b] = rel;
        break;
      }
    }
  }
}
