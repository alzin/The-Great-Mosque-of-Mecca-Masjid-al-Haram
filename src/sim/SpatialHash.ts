/**
 * SpatialHash.ts — a flat, allocation-free uniform grid over the simulation
 * area. Rebuilt each simulation tick with a counting sort, which is O(N) and
 * produces contiguous per-cell agent lists with no per-frame allocation.
 *
 * This is what keeps neighbour queries bounded; the simulation never performs
 * an all-pairs sweep.
 */

export class SpatialHash {
  readonly cellSize: number;
  readonly invCell: number;
  readonly cols: number;
  readonly rows: number;
  readonly minX: number;
  readonly minZ: number;

  /** cellStart[c] .. cellStart[c+1] indexes into `items`. */
  private readonly cellStart: Int32Array;
  private readonly cellCount: Int32Array;
  private items: Int32Array;
  private capacity: number;

  constructor(minX: number, minZ: number, maxX: number, maxZ: number, cellSize: number, capacity: number) {
    this.cellSize = cellSize;
    this.invCell = 1 / cellSize;
    this.minX = minX;
    this.minZ = minZ;
    this.cols = Math.max(1, Math.ceil((maxX - minX) / cellSize));
    this.rows = Math.max(1, Math.ceil((maxZ - minZ) / cellSize));
    const cells = this.cols * this.rows;
    this.cellStart = new Int32Array(cells + 1);
    this.cellCount = new Int32Array(cells);
    this.capacity = Math.max(16, capacity);
    this.items = new Int32Array(this.capacity);
  }

  ensureCapacity(n: number): void {
    if (n > this.capacity) {
      this.capacity = Math.max(n, this.capacity * 2);
      this.items = new Int32Array(this.capacity);
    }
  }

  cellIndex(x: number, z: number): number {
    let cx = ((x - this.minX) * this.invCell) | 0;
    let cz = ((z - this.minZ) * this.invCell) | 0;
    if (cx < 0) cx = 0;
    else if (cx >= this.cols) cx = this.cols - 1;
    if (cz < 0) cz = 0;
    else if (cz >= this.rows) cz = this.rows - 1;
    return cz * this.cols + cx;
  }

  /**
   * Rebuild from a position array. `count` entries are read from posX/posZ
   * at the indices listed in `ids` (or 0..count-1 when ids is null).
   */
  rebuild(posX: Float32Array, posZ: Float32Array, ids: Int32Array | null, count: number): void {
    this.ensureCapacity(count);
    const cellCount = this.cellCount;
    cellCount.fill(0);

    for (let i = 0; i < count; i++) {
      const id = ids ? ids[i] : i;
      cellCount[this.cellIndex(posX[id], posZ[id])]++;
    }

    // Prefix sum -> cellStart
    const cellStart = this.cellStart;
    let running = 0;
    for (let c = 0; c < cellCount.length; c++) {
      cellStart[c] = running;
      running += cellCount[c];
    }
    cellStart[cellCount.length] = running;

    // Scatter, reusing cellCount as a write cursor.
    cellCount.fill(0);
    const items = this.items;
    for (let i = 0; i < count; i++) {
      const id = ids ? ids[i] : i;
      const c = this.cellIndex(posX[id], posZ[id]);
      items[cellStart[c] + cellCount[c]] = id;
      cellCount[c]++;
    }
  }

  /**
   * Visit every agent within `radius` of (x, z). The callback receives the
   * agent id; distance filtering is left to the caller so it can reuse the
   * squared distance it computes anyway.
   *
   * Returns the number of candidates visited (useful for diagnostics).
   */
  forEachNear(x: number, z: number, radius: number, fn: (id: number) => void): number {
    const r = Math.max(1, Math.ceil(radius * this.invCell));
    let cx = ((x - this.minX) * this.invCell) | 0;
    let cz = ((z - this.minZ) * this.invCell) | 0;
    if (cx < 0) cx = 0;
    else if (cx >= this.cols) cx = this.cols - 1;
    if (cz < 0) cz = 0;
    else if (cz >= this.rows) cz = this.rows - 1;

    const x0 = Math.max(0, cx - r);
    const x1 = Math.min(this.cols - 1, cx + r);
    const z0 = Math.max(0, cz - r);
    const z1 = Math.min(this.rows - 1, cz + r);

    let visited = 0;
    const items = this.items;
    const cellStart = this.cellStart;
    for (let gz = z0; gz <= z1; gz++) {
      const rowBase = gz * this.cols;
      for (let gx = x0; gx <= x1; gx++) {
        const c = rowBase + gx;
        const s = cellStart[c];
        const e = cellStart[c + 1];
        for (let k = s; k < e; k++) {
          fn(items[k]);
          visited++;
        }
      }
    }
    return visited;
  }

  /** Count of agents in the cell containing (x, z) and its 8 neighbours. */
  localOccupancy(x: number, z: number): number {
    let cx = ((x - this.minX) * this.invCell) | 0;
    let cz = ((z - this.minZ) * this.invCell) | 0;
    if (cx < 0) cx = 0;
    else if (cx >= this.cols) cx = this.cols - 1;
    if (cz < 0) cz = 0;
    else if (cz >= this.rows) cz = this.rows - 1;
    let n = 0;
    const cellStart = this.cellStart;
    for (let gz = Math.max(0, cz - 1); gz <= Math.min(this.rows - 1, cz + 1); gz++) {
      const rowBase = gz * this.cols;
      for (let gx = Math.max(0, cx - 1); gx <= Math.min(this.cols - 1, cx + 1); gx++) {
        const c = rowBase + gx;
        n += cellStart[c + 1] - cellStart[c];
      }
    }
    return n;
  }
}
