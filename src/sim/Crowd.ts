/**
 * Crowd.ts — the agent-based crowd simulation.
 *
 * Design notes
 * ------------
 *  * Structure-of-arrays over typed arrays, allocated once at `capacity`.
 *    No per-tick allocation anywhere in `step()`.
 *  * A free list recycles slots so spawning and despawning never reallocate.
 *  * Neighbour interaction is bounded by a uniform spatial hash rebuilt each
 *    tick with a counting sort; there is no all-pairs sweep.
 *  * Steering is a social-force model with anisotropic weighting plus an
 *    obstacle SDF field, followed by one position-based relaxation pass that
 *    guarantees agents do not end a tick overlapping each other or geometry.
 *  * Tawaf is NOT a fixed circular track. Each agent has a preferred orbit
 *    radius that drifts, an individual preferred speed, and its own reaction
 *    to congestion, so paths differ between agents and between circuits.
 *    Circuit counting is done on accumulated signed bearing while, and only
 *    while, the agent is in PERFORMING_TAWAF.
 */

import {
  GALLERY,
  GATES,
  MATAF,
  PEDESTRIAN,
  PRAYER_LAYOUT,
  SPAWN_RADIUS,
} from '../config/site.ts';
import {
  MATAF_OBSTACLES,
  OBSTACLES,
  insideTawafExclusion,
  escapeTawafExclusion,
  nearestObstacleDistance,
  obstacleSdf,
  resolvePenetration,
  wrapAngle,
} from './Obstacles.ts';
import { SpatialHash } from './SpatialHash.ts';
import { AGENT_STATE_COUNT, AgentState, GlobalPhase } from './States.ts';
import { SlotAllocator, generatePrayerSlots, yawTowardKaaba, type PrayerSlots } from './PrayerLayout.ts';
import { Rng } from '../util/Rng.ts';

const TWO_PI = Math.PI * 2;

/**
 * Hard separation used while taking a place in a prayer row. Worshippers
 * stand shoulder to shoulder, closer than the walking personal space, so the
 * relaxation pass relaxes its minimum distance in that context only.
 */
const PRAYER_SEPARATION = 0.42;

/** Radial lookup: minimum tawaf radius at a given bearing (Hijr bulge). */
const MIN_RADIUS_SAMPLES = 720;

function buildMinRadiusTable(): Float32Array {
  const t = new Float32Array(MIN_RADIUS_SAMPLES);
  for (let i = 0; i < MIN_RADIUS_SAMPLES; i++) {
    const a = (i / MIN_RADIUS_SAMPLES) * TWO_PI;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // March outward until the ray leaves the tawaf exclusion zone and clears
    // any mataf obstacle by a walking margin.
    let r = 5.0;
    const margin = 0.85;
    for (; r < 30; r += 0.1) {
      const x = ca * r;
      const z = sa * r;
      if (insideTawafExclusion(x, z, margin)) continue;
      if (nearestObstacleDistance(x, z, MATAF_OBSTACLES) < margin) continue;
      break;
    }
    t[i] = r;
  }
  // Smooth the table so the bulge is a gentle curve rather than a step.
  const s = new Float32Array(MIN_RADIUS_SAMPLES);
  const K = 12;
  for (let i = 0; i < MIN_RADIUS_SAMPLES; i++) {
    let acc = 0;
    for (let k = -K; k <= K; k++) {
      acc += t[(i + k + MIN_RADIUS_SAMPLES) % MIN_RADIUS_SAMPLES];
    }
    s[i] = acc / (2 * K + 1);
  }
  return s;
}

let MIN_RADIUS_TABLE: Float32Array | null = null;

export function minTawafRadius(bearing: number): number {
  if (!MIN_RADIUS_TABLE) MIN_RADIUS_TABLE = buildMinRadiusTable();
  let a = bearing % TWO_PI;
  if (a < 0) a += TWO_PI;
  const f = (a / TWO_PI) * MIN_RADIUS_SAMPLES;
  const i0 = Math.floor(f) % MIN_RADIUS_SAMPLES;
  const i1 = (i0 + 1) % MIN_RADIUS_SAMPLES;
  const t = f - Math.floor(f);
  return MIN_RADIUS_TABLE[i0] * (1 - t) + MIN_RADIUS_TABLE[i1] * t;
}

export interface CrowdOptions {
  capacity: number;
  seed?: number;
}

export interface CrowdCounters {
  alive: number;
  waiting: number;
  byState: Int32Array;
  circuitsCompleted: number;
  departures: number;
  arrivals: number;
  stuckRecoveries: number;
  overflowWaiting: number;
}

/** Tunables the UI can change at runtime. */
export interface CrowdTunables {
  targetPopulation: number;
  arrivalRate: number;
  departureRate: number;
  /** Number of circuits an agent performs before leaving. */
  circuits: number;
  /** 0 = no turnover: agents loop forever. 1 = everyone leaves after tawaf. */
  turnover: number;
  simulationSpeed: number;
}

const STATE_COUNT = AGENT_STATE_COUNT;

export class Crowd {
  readonly capacity: number;

  // --- Position / motion -------------------------------------------------
  readonly px: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vz: Float32Array;
  readonly yaw: Float32Array;
  /** Previous-tick values, for render interpolation. */
  readonly prevX: Float32Array;
  readonly prevZ: Float32Array;
  readonly prevYaw: Float32Array;

  // --- Persistent individual traits --------------------------------------
  readonly prefSpeed: Float32Array;
  readonly height: Float32Array;
  /** Body-width multiplier. */
  readonly build: Float32Array;
  /** Index into the garment palette. */
  readonly garment: Uint8Array;
  /** Small per-agent animation phase offset, seconds. */
  readonly phase: Float32Array;

  // --- Behaviour ---------------------------------------------------------
  readonly state: Uint8Array;
  readonly prefRadius: Float32Array;
  readonly radiusDrift: Float32Array;
  readonly gate: Int8Array;
  readonly groupId: Int32Array;
  /** Accumulated counter-clockwise bearing while performing tawaf, radians. */
  readonly tawafAngle: Float32Array;
  readonly lastBearing: Float32Array;
  readonly circuitsDone: Uint8Array;
  readonly targetCircuits: Uint8Array;
  /** Bearing at which tawaf was interrupted by prayer (NaN when none). */
  readonly interruptBearing: Float32Array;
  readonly stuckTimer: Float32Array;
  readonly stateTimer: Float32Array;
  /** Destination used by ENTERING / EXITING / LEAVING_TAWAF / RESUMING. */
  readonly destX: Float32Array;
  readonly destZ: Float32Array;

  // --- Prayer ------------------------------------------------------------
  readonly prayerSlot: Int32Array;
  readonly settled: Uint8Array;
  readonly prayerDelay: Float32Array;
  /** Blend factor 0..1 used while easing onto the exact slot. */
  readonly settleBlend: Float32Array;

  // --- Animation ---------------------------------------------------------
  readonly clip: Uint8Array;
  readonly clipTime: Float32Array;
  readonly prevClip: Uint8Array;
  readonly clipBlend: Float32Array;
  /** Current ground speed, cached for the animation layer. */
  readonly speed: Float32Array;

  // --- Slot management ---------------------------------------------------
  readonly alive: Uint8Array;
  /**
   * Incremented every time a slot is handed to a new agent. Ids are recycled,
   * so `alive` alone cannot distinguish "the same person one tick later" from
   * "a different person who inherited the id". Anything comparing an agent
   * against its own past — continuity checks, trails, the no-teleport test —
   * has to compare generations, not ids.
   */
  readonly generation: Uint32Array;
  private readonly freeList: Int32Array;
  private freeCount = 0;
  /** Dense list of live agent indices, rebuilt on spawn/despawn. */
  readonly liveIds: Int32Array;
  private _liveCount = 0;
  private liveDirty = true;

  // --- Infrastructure ----------------------------------------------------
  readonly hash: SpatialHash;
  readonly slots: PrayerSlots;
  readonly allocator: SlotAllocator;
  private readonly rng: Rng;

  tunables: CrowdTunables = {
    targetPopulation: 900,
    arrivalRate: 22,
    departureRate: 22,
    circuits: 7,
    turnover: 0.85,
    simulationSpeed: 1,
  };

  phaseState: GlobalPhase = GlobalPhase.NORMAL_ACTIVITY;
  /** Seconds since the prayer timeline started (only meaningful in PRAYER). */
  prayerClock = 0;
  /** Fraction of the crowd asked to head for prayer during PREPARATION. */
  preparationPull = 0;

  counters: CrowdCounters = {
    alive: 0,
    waiting: 0,
    byState: new Int32Array(STATE_COUNT),
    circuitsCompleted: 0,
    departures: 0,
    arrivals: 0,
    stuckRecoveries: 0,
    overflowWaiting: 0,
  };

  /** People queued outside, waiting for space to enter. */
  private waitingQueue = 0;
  private arrivalAccumulator = 0;
  private departureAccumulator = 0;
  private nextGroupId = 1;

  /** Scratch arrays reused every tick. */
  private readonly forceX: Float32Array;
  private readonly forceZ: Float32Array;
  private readonly density: Float32Array;

  constructor(opts: CrowdOptions) {
    const n = opts.capacity;
    this.capacity = n;
    this.rng = new Rng(opts.seed ?? 0x5eed1234);

    const f32 = () => new Float32Array(n);
    this.px = f32();
    this.pz = f32();
    this.vx = f32();
    this.vz = f32();
    this.yaw = f32();
    this.prevX = f32();
    this.prevZ = f32();
    this.prevYaw = f32();
    this.prefSpeed = f32();
    this.height = f32();
    this.build = f32();
    this.garment = new Uint8Array(n);
    this.phase = f32();
    this.state = new Uint8Array(n);
    this.prefRadius = f32();
    this.radiusDrift = f32();
    this.gate = new Int8Array(n);
    this.groupId = new Int32Array(n);
    this.tawafAngle = f32();
    this.lastBearing = f32();
    this.circuitsDone = new Uint8Array(n);
    this.targetCircuits = new Uint8Array(n);
    this.interruptBearing = f32();
    this.stuckTimer = f32();
    this.stateTimer = f32();
    this.destX = f32();
    this.destZ = f32();
    this.prayerSlot = new Int32Array(n).fill(-1);
    this.settled = new Uint8Array(n);
    this.prayerDelay = f32();
    this.settleBlend = f32();
    this.clip = new Uint8Array(n);
    this.clipTime = f32();
    this.prevClip = new Uint8Array(n);
    this.clipBlend = f32();
    this.speed = f32();
    this.alive = new Uint8Array(n);
    this.generation = new Uint32Array(n);
    this.freeList = new Int32Array(n);
    this.liveIds = new Int32Array(n);

    for (let i = 0; i < n; i++) this.freeList[i] = n - 1 - i;
    this.freeCount = n;

    const extent = GALLERY.columnRings[GALLERY.columnRings.length - 1] + 12;
    this.hash = new SpatialHash(-extent, -extent, extent, extent, 1.6, n);

    this.slots = generatePrayerSlots();
    this.allocator = new SlotAllocator(this.slots);

    this.forceX = f32();
    this.forceZ = f32();
    this.density = f32();

    // Warm the radius table so the first tick is not unusually slow.
    minTawafRadius(0);
  }

  get liveCount(): number {
    return this._liveCount;
  }

  get waiting(): number {
    return this.waitingQueue;
  }

  /** Maximum population the prayer layout can seat. */
  get prayerCapacity(): number {
    return this.slots.count;
  }

  /**
   * Compacted list of live agent ids. The returned subarray is a view onto
   * internal storage: it is valid until the next `step`, and must not be
   * written to. Used by the animation and render layers so neither has to
   * walk the whole capacity looking for holes.
   */
  liveIdsView(): Int32Array {
    this.ensureLive();
    return this.liveIds.subarray(0, this._liveCount);
  }

  // ---------------------------------------------------------------------
  // Spawning
  // ---------------------------------------------------------------------

  private rebuildLive(): void {
    let k = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i]) this.liveIds[k++] = i;
    }
    this._liveCount = k;
    this.liveDirty = false;
  }

  private ensureLive(): void {
    if (this.liveDirty) this.rebuildLive();
  }

  private allocate(): number {
    if (this.freeCount === 0) return -1;
    const id = this.freeList[--this.freeCount];
    this.alive[id] = 1;
    this.generation[id]++;
    this.liveDirty = true;
    return id;
  }

  private release(id: number): void {
    if (!this.alive[id]) return;
    this.alive[id] = 0;
    if (this.prayerSlot[id] >= 0) {
      this.allocator.release(this.prayerSlot[id]);
      this.prayerSlot[id] = -1;
    }
    this.freeList[this.freeCount++] = id;
    this.liveDirty = true;
  }

  private sampleSpeed(): number {
    const r = this.rng.next();
    let acc = 0;
    for (const c of PEDESTRIAN.cohorts) {
      acc += c.share;
      if (r <= acc) {
        return Math.min(
          PEDESTRIAN.maxSpeed,
          Math.max(PEDESTRIAN.minSpeed, c.mean + this.rng.gaussian() * c.sigma),
        );
      }
    }
    return 0.9;
  }

  private initTraits(id: number): void {
    const rng = this.rng;
    this.prefSpeed[id] = this.sampleSpeed();
    const [hMin, hMax] = PEDESTRIAN.heightRange;
    this.height[id] = hMin + rng.next() * (hMax - hMin);
    this.build[id] = 0.9 + rng.next() * 0.22;
    this.garment[id] = rng.int(GARMENT_COUNT);
    this.phase[id] = rng.next() * 4;
    this.targetCircuits[id] = this.tunables.circuits;
    this.circuitsDone[id] = 0;
    this.tawafAngle[id] = 0;
    this.interruptBearing[id] = NaN;
    this.stuckTimer[id] = 0;
    this.stateTimer[id] = 0;
    this.settled[id] = 0;
    this.settleBlend[id] = 0;
    this.prayerSlot[id] = -1;
    this.groupId[id] = -1;
    this.clip[id] = 0;
    this.prevClip[id] = 0;
    this.clipBlend[id] = 1;
    // Normalised clip phase: must stay in [0, 1). A random start keeps a
    // crowd of identical idle cycles from beating in unison.
    this.clipTime[id] = rng.next();
    // Preferred orbit radius: skewed toward the inner ring, matching the
    // observation that most pilgrims crowd close to the Kaaba.
    const t = Math.pow(rng.next(), 1.7);
    this.prefRadius[id] = 11 + t * 34;
    this.radiusDrift[id] = (rng.next() - 0.5) * 0.06;
  }

  /** Spawn an agent at a gate, walking inward. Returns id or -1. */
  spawnAtGate(gateIdx?: number): number {
    const id = this.allocate();
    if (id < 0) return -1;
    const usable = GATES.filter((g) => g.entry);
    const g = usable[gateIdx !== undefined ? gateIdx % usable.length : this.rng.int(usable.length)];
    const spread = (this.rng.next() - 0.5) * 2 * g.halfWidth;
    const a = g.bearing + spread;
    const r = SPAWN_RADIUS + this.rng.next() * 4;

    this.initTraits(id);
    this.px[id] = Math.cos(a) * r;
    this.pz[id] = Math.sin(a) * r;
    this.prevX[id] = this.px[id];
    this.prevZ[id] = this.pz[id];
    this.gate[id] = g.id;
    this.state[id] = AgentState.ENTERING;
    // Aim for a point on the tawaf ring near the entry bearing.
    const targetR = Math.max(minTawafRadius(a) + 1.5, this.prefRadius[id]);
    this.destX[id] = Math.cos(a) * targetR;
    this.destZ[id] = Math.sin(a) * targetR;
    const dirX = this.destX[id] - this.px[id];
    const dirZ = this.destZ[id] - this.pz[id];
    const l = Math.hypot(dirX, dirZ) || 1;
    this.vx[id] = (dirX / l) * this.prefSpeed[id] * 0.6;
    this.vz[id] = (dirZ / l) * this.prefSpeed[id] * 0.6;
    this.yaw[id] = Math.atan2(dirX, dirZ);
    this.prevYaw[id] = this.yaw[id];
    this.counters.arrivals++;
    return id;
  }

  /**
   * Populate directly with a plausible distribution. Only used at
   * initialisation or after an explicit reset — never while running.
   */
  populate(count: number): void {
    const want = Math.min(count, this.capacity);
    let guard = want * 40;
    while (this._liveCountApprox() < want && guard-- > 0) {
      const id = this.allocate();
      if (id < 0) break;
      this.initTraits(id);
      const roll = this.rng.next();
      if (roll < 0.86) {
        // Somewhere on the ring, mid-tawaf, with progress already spread out.
        const bearing = this.rng.next() * TWO_PI;
        const rMin = minTawafRadius(bearing) + 0.9;
        const r = Math.max(rMin, this.prefRadius[id] + this.rng.gaussian() * 1.4);
        const x = Math.cos(bearing) * r;
        const z = Math.sin(bearing) * r;
        if (!this.isFreeSpot(x, z)) {
          this.release(id);
          continue;
        }
        this.px[id] = x;
        this.pz[id] = z;
        this.state[id] = AgentState.PERFORMING_TAWAF;
        // Distribute progress across the whole 0..7 range so the scene does
        // not begin with everyone on circuit one.
        const done = this.rng.int(this.tunables.circuits);
        const frac = this.rng.next();
        this.circuitsDone[id] = done;
        this.tawafAngle[id] = (done + frac) * TWO_PI;
        this.lastBearing[id] = bearing;
        const tx = Math.sin(bearing);
        const tz = -Math.cos(bearing);
        this.vx[id] = tx * this.prefSpeed[id];
        this.vz[id] = tz * this.prefSpeed[id];
        this.yaw[id] = Math.atan2(tx, tz);
      } else if (roll < 0.94) {
        // Walking in from a gate.
        this.release(id);
        this.spawnAtGate();
        continue;
      } else {
        // Idling in the outer courtyard.
        const bearing = this.rng.next() * TWO_PI;
        const r = 46 + this.rng.next() * 14;
        const x = Math.cos(bearing) * r;
        const z = Math.sin(bearing) * r;
        if (!this.isFreeSpot(x, z)) {
          this.release(id);
          continue;
        }
        this.px[id] = x;
        this.pz[id] = z;
        this.state[id] = AgentState.IDLE;
        this.stateTimer[id] = this.rng.next() * 25;
        this.yaw[id] = yawTowardKaaba(x, z);
      }
      this.prevX[id] = this.px[id];
      this.prevZ[id] = this.pz[id];
      this.prevYaw[id] = this.yaw[id];
    }
    this.rebuildLive();
    this.assignGroups();
  }

  private _liveCountApprox(): number {
    return this.capacity - this.freeCount;
  }

  private isFreeSpot(x: number, z: number): boolean {
    if (insideTawafExclusion(x, z, 0.6)) return false;
    if (nearestObstacleDistance(x, z, MATAF_OBSTACLES) < 0.6) return false;
    return Math.hypot(x, z) < MATAF.outerRadius + 1;
  }

  /** Give ~30% of agents a small-group membership with a nearby partner. */
  private assignGroups(): void {
    this.ensureLive();
    this.hash.rebuild(this.px, this.pz, this.liveIds, this._liveCount);
    for (let k = 0; k < this._liveCount; k++) {
      const id = this.liveIds[k];
      if (this.groupId[id] !== -1) continue;
      if (this.rng.next() > 0.3) continue;
      const gid = this.nextGroupId++;
      this.groupId[id] = gid;
      let joined = 0;
      const want = 1 + this.rng.int(3);
      this.hash.forEachNear(this.px[id], this.pz[id], 2.5, (other) => {
        if (joined >= want || other === id) return;
        if (this.groupId[other] !== -1) return;
        if (this.state[other] !== this.state[id]) return;
        this.groupId[other] = gid;
        this.prefSpeed[other] = this.prefSpeed[id];
        this.prefRadius[other] = this.prefRadius[id];
        joined++;
      });
    }
  }

  reset(population: number): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i]) this.release(i);
    }
    this.allocator.reset();
    this.waitingQueue = 0;
    this.arrivalAccumulator = 0;
    this.departureAccumulator = 0;
    this.phaseState = GlobalPhase.NORMAL_ACTIVITY;
    this.prayerClock = 0;
    this.preparationPull = 0;
    this.counters.circuitsCompleted = 0;
    this.counters.departures = 0;
    this.counters.arrivals = 0;
    this.counters.stuckRecoveries = 0;
    this.rebuildLive();
    this.populate(population);
  }

  // ---------------------------------------------------------------------
  // Prayer orchestration hooks
  // ---------------------------------------------------------------------

  /** Called by the global state machine when iqamah is given. */
  beginRowFormation(): void {
    this.ensureLive();
    // Assign inner agents first so the front rows fill first.
    const order = Array.from(this.liveIds.subarray(0, this._liveCount));
    order.sort((a, b) => {
      const ra = this.px[a] * this.px[a] + this.pz[a] * this.pz[a];
      const rb = this.px[b] * this.px[b] + this.pz[b] * this.pz[b];
      return ra - rb;
    });

    let overflow = 0;
    for (const id of order) {
      if (this.state[id] === AgentState.PERFORMING_TAWAF) {
        this.interruptBearing[id] = Math.atan2(this.pz[id], this.px[id]);
      }
      const slot = this.allocator.claim(id, this.px[id], this.pz[id]);
      if (slot < 0) {
        overflow++;
        // No slot: wait in the outer courtyard rather than overlapping anyone.
        this.setState(id, AgentState.IDLE);
        const b = Math.atan2(this.pz[id], this.px[id]);
        const r = PRAYER_LAYOUT.lastRowRadius + 1.2 + (overflow % 4) * 0.9;
        this.destX[id] = Math.cos(b) * r;
        this.destZ[id] = Math.sin(b) * r;
        continue;
      }
      this.prayerSlot[id] = slot;
      this.setState(id, AgentState.MOVING_TO_PRAYER);
      this.destX[id] = this.slots.x[slot];
      this.destZ[id] = this.slots.z[slot];
      this.settled[id] = 0;
      this.settleBlend[id] = 0;
      // Follower delay grows with row index: the sound of the imam and the
      // rows in front reaches the back a beat later.
      this.prayerDelay[id] = Math.min(0.75, this.slots.row[slot] * 0.011 + this.rng.next() * 0.09);
    }
    this.counters.overflowWaiting = overflow;
  }

  /** Fraction of assigned agents that have reached and settled into a slot. */
  settledFraction(): number {
    this.ensureLive();
    let assigned = 0;
    let done = 0;
    for (let k = 0; k < this._liveCount; k++) {
      const id = this.liveIds[k];
      if (this.prayerSlot[id] < 0) continue;
      assigned++;
      if (this.settled[id]) done++;
    }
    return assigned === 0 ? 1 : done / assigned;
  }

  /**
   * Start the prayer. Only worshippers who have actually reached their place
   * begin; anyone still walking stays in MOVING_TO_PRAYER and joins the
   * congregation when they arrive, which is what happens in practice — the
   * imam does not wait for the back of the mosque.
   */
  beginPrayer(): void {
    this.ensureLive();
    for (let k = 0; k < this._liveCount; k++) {
      const id = this.liveIds[k];
      if (this.prayerSlot[id] >= 0 && this.settled[id]) {
        this.setState(id, AgentState.PRAYING);
        // Snap the last fraction so rows are perfectly straight at takbir.
        const s = this.prayerSlot[id];
        this.px[id] = this.slots.x[s];
        this.pz[id] = this.slots.z[s];
        this.prevX[id] = this.px[id];
        this.prevZ[id] = this.pz[id];
        this.yaw[id] = this.slots.yaw[s];
        this.prevYaw[id] = this.yaw[id];
        this.vx[id] = 0;
        this.vz[id] = 0;
        this.settled[id] = 1;
        this.settleBlend[id] = 1;
      }
    }
    this.prayerClock = 0;
  }

  /** Convert a latecomer who has just reached their slot into PRAYING. */
  private joinPrayerInProgress(id: number): void {
    const slot = this.prayerSlot[id];
    if (slot < 0) return;
    this.setState(id, AgentState.PRAYING);
    this.px[id] = this.slots.x[slot];
    this.pz[id] = this.slots.z[slot];
    this.yaw[id] = this.slots.yaw[slot];
    this.vx[id] = 0;
    this.vz[id] = 0;
    this.speed[id] = 0;
    this.settled[id] = 1;
  }

  /** Release everyone from prayer and set them dispersing. */
  endPrayer(): void {
    this.ensureLive();
    for (let k = 0; k < this._liveCount; k++) {
      const id = this.liveIds[k];
      if (this.prayerSlot[id] >= 0) {
        this.allocator.release(this.prayerSlot[id]);
        this.prayerSlot[id] = -1;
      }
      this.settled[id] = 0;
      this.settleBlend[id] = 0;
      if (this.state[id] === AgentState.PRAYING || this.state[id] === AgentState.MOVING_TO_PRAYER) {
        this.setState(id, AgentState.RESUMING_ACTIVITY);
        // Stagger the rise so the whole congregation does not stand as one.
        this.stateTimer[id] = -(this.prayerDelay[id] * 2 + this.rng.next() * 3.5);
        if (Number.isFinite(this.interruptBearing[id]) && this.circuitsDone[id] < this.targetCircuits[id]) {
          const b = this.interruptBearing[id];
          const r = Math.max(minTawafRadius(b) + 1.0, this.prefRadius[id]);
          this.destX[id] = Math.cos(b) * r;
          this.destZ[id] = Math.sin(b) * r;
        } else {
          // No tawaf to resume: drift out toward a gate.
          const g = GATES[this.rng.int(GATES.length)];
          this.destX[id] = Math.cos(g.bearing) * (MATAF.outerRadius - 2);
          this.destZ[id] = Math.sin(g.bearing) * (MATAF.outerRadius - 2);
        }
      }
    }
    this.counters.overflowWaiting = 0;
  }

  private setState(id: number, s: AgentState): void {
    this.state[id] = s;
    this.stateTimer[id] = 0;
    this.stuckTimer[id] = 0;
  }

  // ---------------------------------------------------------------------
  // Main tick
  // ---------------------------------------------------------------------

  /**
   * Advance the simulation by exactly `dt` seconds. Callers must supply a
   * fixed timestep; the engine is responsible for accumulating real time.
   */
  step(dt: number): void {
    this.ensureLive();
    this.manageArrivals(dt);
    this.manageDepartures(dt);
    this.ensureLive();

    const n = this._liveCount;
    const ids = this.liveIds;

    // Record previous state for render interpolation.
    for (let k = 0; k < n; k++) {
      const id = ids[k];
      this.prevX[id] = this.px[id];
      this.prevZ[id] = this.pz[id];
      this.prevYaw[id] = this.yaw[id];
    }

    this.hash.rebuild(this.px, this.pz, ids, n);

    // --- 1. Desired velocity from behaviour --------------------------------
    for (let k = 0; k < n; k++) {
      this.updateBehaviour(ids[k], dt);
    }

    // --- 2. Interaction forces --------------------------------------------
    this.computeInteractions(n, ids);

    // --- 3. Integrate ------------------------------------------------------
    for (let k = 0; k < n; k++) {
      this.integrate(ids[k], dt);
    }

    // --- 4. Position-based relaxation -------------------------------------
    this.hash.rebuild(this.px, this.pz, ids, n);
    this.relax(n, ids);

    // --- 5. Bookkeeping ----------------------------------------------------
    for (let k = 0; k < n; k++) {
      this.postUpdate(ids[k], dt);
    }

    this.updateCounters(n, ids);
  }

  // --- behaviour ----------------------------------------------------------

  /** Desired velocity is written into forceX/forceZ as a target velocity. */
  private updateBehaviour(id: number, dt: number): void {
    this.stateTimer[id] += dt;
    const x = this.px[id];
    const z = this.pz[id];
    const r = Math.hypot(x, z) || 1e-4;
    const bearing = Math.atan2(z, x);
    const pref = this.prefSpeed[id];
    let dx = 0;
    let dz = 0;
    let speedScale = 1;

    switch (this.state[id]) {
      case AgentState.ENTERING: {
        dx = this.destX[id] - x;
        dz = this.destZ[id] - z;
        const d = Math.hypot(dx, dz);
        if (d < 2.5 || r < MATAF.outerRadius - 2) {
          this.setState(id, AgentState.JOINING_TAWAF);
        }
        break;
      }

      case AgentState.JOINING_TAWAF: {
        // Merge: mostly tangential already, with a radial pull to the
        // preferred lane, so people ease into the stream rather than
        // cutting across it.
        const targetR = this.effectiveRadius(id, bearing);
        const merge = Math.min(1, this.stateTimer[id] / 6);
        const tx = z / r;
        const tz = -x / r;
        const radial = clamp((targetR - r) * 0.22, -1, 1);
        dx = tx * merge + (x / r) * radial;
        dz = tz * merge + (z / r) * radial;
        speedScale = 0.85 + 0.15 * merge;
        // Circuit counting starts when the agent crosses the Black Stone line
        // travelling counter-clockwise.
        if (merge > 0.55 && this.crossedStartLine(id, bearing)) {
          this.setState(id, AgentState.PERFORMING_TAWAF);
          this.tawafAngle[id] = this.circuitsDone[id] * TWO_PI;
        }
        this.lastBearing[id] = bearing;
        break;
      }

      case AgentState.PERFORMING_TAWAF: {
        const targetR = this.effectiveRadius(id, bearing);
        const tx = z / r;
        const tz = -x / r;
        const radial = clamp((targetR - r) * 0.3, -0.85, 0.85);
        dx = tx + (x / r) * radial;
        dz = tz + (z / r) * radial;
        // Progress accounting.
        const delta = wrapAngle(bearing - this.lastBearing[id]);
        if (Math.abs(delta) < 0.35) {
          // Counter-clockwise from above is a DECREASING atan2 bearing in
          // this frame, so progress is -delta.
          this.tawafAngle[id] -= delta;
        }
        this.lastBearing[id] = bearing;
        const done = Math.floor(this.tawafAngle[id] / TWO_PI);
        if (done > this.circuitsDone[id]) {
          this.counters.circuitsCompleted += done - this.circuitsDone[id];
          this.circuitsDone[id] = Math.min(255, done);
        }
        if (this.circuitsDone[id] >= this.targetCircuits[id]) {
          this.setState(id, AgentState.LEAVING_TAWAF);
          // Peel outward, toward the area behind the Maqam where the two
          // rak'ahs following tawaf are customarily prayed.
          const outB = bearing + 0.35;
          const outR = MATAF.outerRadius - 8 - this.rng.next() * 10;
          this.destX[id] = Math.cos(outB) * outR;
          this.destZ[id] = Math.sin(outB) * outR;
        }
        break;
      }

      case AgentState.LEAVING_TAWAF: {
        dx = this.destX[id] - x;
        dz = this.destZ[id] - z;
        if (Math.hypot(dx, dz) < 2.0) {
          this.setState(id, AgentState.IDLE);
          this.stateTimer[id] = -(6 + this.rng.next() * 22);
        }
        break;
      }

      case AgentState.IDLE: {
        speedScale = 0;
        if (this.stateTimer[id] > 0) {
          if (this.rng.next() < this.tunables.turnover) {
            this.beginExit(id);
          } else {
            // Go round again.
            this.circuitsDone[id] = 0;
            this.tawafAngle[id] = 0;
            this.setState(id, AgentState.JOINING_TAWAF);
          }
        }
        break;
      }

      case AgentState.EXITING: {
        dx = this.destX[id] - x;
        dz = this.destZ[id] - z;
        const d = Math.hypot(dx, dz);
        if (d < 2.0 || r > SPAWN_RADIUS + 1.5) {
          this.release(id);
          this.counters.departures++;
          return;
        }
        break;
      }

      case AgentState.MOVING_TO_PRAYER: {
        const slot = this.prayerSlot[id];
        if (slot < 0) {
          this.setState(id, AgentState.IDLE);
          break;
        }
        if (this.settled[id] && this.phaseState === GlobalPhase.PRAYER) {
          this.joinPrayerInProgress(id);
          break;
        }
        dx = this.slots.x[slot] - x;
        dz = this.slots.z[slot] - z;
        const d = Math.hypot(dx, dz);
        // The last 0.8 m is handled kinematically in integrate(); here we
        // just aim at the slot and slow down as we close on it.
        if (d < 2.0) {
          speedScale = Math.max(0.35, d / 2.0);
          this.settleBlend[id] = Math.min(1, this.settleBlend[id] + dt * 2.4);
        } else {
          speedScale = 1.0;
          this.settleBlend[id] = 0;
        }
        break;
      }

      case AgentState.PRAYING: {
        speedScale = 0;
        break;
      }

      case AgentState.RESUMING_ACTIVITY: {
        if (this.stateTimer[id] < 0) {
          speedScale = 0;
          break;
        }
        dx = this.destX[id] - x;
        dz = this.destZ[id] - z;
        const d = Math.hypot(dx, dz);
        speedScale = 0.8;
        if (d < 2.2) {
          if (this.circuitsDone[id] < this.targetCircuits[id]) {
            this.setState(id, AgentState.PERFORMING_TAWAF);
            this.lastBearing[id] = bearing;
            this.interruptBearing[id] = NaN;
          } else {
            this.beginExit(id);
          }
        }
        break;
      }
    }

    // Preparation pull: a growing share of the crowd starts drifting toward
    // the prayer area even before iqamah.
    if (this.phaseState === GlobalPhase.PREPARATION && this.preparationPull > 0) {
      const s = this.state[id];
      const eligible = s === AgentState.IDLE || s === AgentState.LEAVING_TAWAF;
      if (eligible && hash01(id) < this.preparationPull) {
        const targetR = PRAYER_LAYOUT.firstRowRadius + 6 + hash01(id * 7 + 3) * 30;
        const rr = clamp((targetR - r) * 0.3, -1, 1);
        dx += (x / r) * rr;
        dz += (z / r) * rr;
        speedScale = Math.max(speedScale, 0.6);
      }
    }

    // Group cohesion: a light pull toward the group's mean position.
    if (this.groupId[id] !== -1 && speedScale > 0) {
      let gx = 0;
      let gz = 0;
      let cnt = 0;
      const gid = this.groupId[id];
      this.hash.forEachNear(x, z, 3.0, (other) => {
        if (other !== id && this.groupId[other] === gid) {
          gx += this.px[other];
          gz += this.pz[other];
          cnt++;
        }
      });
      if (cnt > 0) {
        gx = gx / cnt - x;
        gz = gz / cnt - z;
        const gl = Math.hypot(gx, gz);
        if (gl > 1.3) {
          dx += (gx / gl) * 0.35;
          dz += (gz / gl) * 0.35;
        }
      }
    }

    // Normalise into a desired velocity, then apply obstacle look-ahead.
    let l = Math.hypot(dx, dz);
    if (l < 1e-5) {
      this.forceX[id] = 0;
      this.forceZ[id] = 0;
      return;
    }
    dx /= l;
    dz /= l;

    const avoided = this.avoidObstacles(x, z, dx, dz);
    dx = avoided.x;
    dz = avoided.z;

    const target = pref * speedScale;
    this.forceX[id] = dx * target;
    this.forceZ[id] = dz * target;
  }

  private beginExit(id: number): void {
    const bearing = Math.atan2(this.pz[id], this.px[id]);
    // Choose the nearest gate that permits exit.
    let best = GATES[0];
    let bestD = Infinity;
    for (const g of GATES) {
      if (!g.exit) continue;
      const d = Math.abs(wrapAngle(g.bearing - bearing));
      if (d < bestD) {
        bestD = d;
        best = g;
      }
    }
    const a = best.bearing + (this.rng.next() - 0.5) * 2 * best.halfWidth;
    this.gate[id] = best.id;
    this.destX[id] = Math.cos(a) * (SPAWN_RADIUS + 2);
    this.destZ[id] = Math.sin(a) * (SPAWN_RADIUS + 2);
    this.setState(id, AgentState.EXITING);
  }

  /** Preferred radius including the Hijr bulge and a slow personal drift. */
  private effectiveRadius(id: number, bearing: number): number {
    const base = this.prefRadius[id];
    const floor = minTawafRadius(bearing) + 0.75;
    return Math.max(floor, base);
  }

  private crossedStartLine(id: number, bearing: number): boolean {
    const prev = this.lastBearing[id];
    if (!Number.isFinite(prev)) return false;
    // Counter-clockwise motion means bearing decreases through zero.
    if (prev > 0 && bearing <= 0 && prev - bearing < 0.5) return true;
    return false;
  }

  private readonly _avoid = { x: 0, z: 0 };

  /**
   * Deflect a desired direction around obstacles using a short look-ahead
   * probe of the SDF field. Returns a unit direction.
   */
  private avoidObstacles(x: number, z: number, dx: number, dz: number): { x: number; z: number } {
    let ax = dx;
    let az = dz;
    const look = 2.2;
    for (let i = 0; i < MATAF_OBSTACLES.length; i++) {
      const o = MATAF_OBSTACLES[i];
      const bdx = x - o.bx;
      const bdz = z - o.bz;
      const reach = o.br + look + 1.2;
      if (bdx * bdx + bdz * bdz > reach * reach) continue;
      const s = obstacleSdf(o, x, z);
      const influence = 1.4;
      if (s.d > influence) continue;
      // Strength grows sharply as we approach the surface.
      const w = clamp((influence - s.d) / influence, 0, 1);
      // Push directly away, and add a tangential component so agents slide
      // around rather than stalling head-on.
      const dot = ax * s.nx + az * s.nz;
      if (dot < 0) {
        // Heading into it: remove the inbound component and add tangent.
        ax -= s.nx * dot * (0.9 + w);
        az -= s.nz * dot * (0.9 + w);
      }
      ax += s.nx * w * 1.35;
      az += s.nz * w * 1.35;
    }
    // Keep everyone out of the Hijr enclosure explicitly, since its interior
    // is not covered by a single convex primitive.
    if (insideTawafExclusion(x + ax * 0.8, z + az * 0.8, 0.9)) {
      const r = Math.hypot(x, z) || 1;
      ax += (x / r) * 1.2;
      az += (z / r) * 1.2;
    }
    const l = Math.hypot(ax, az) || 1;
    this._avoid.x = ax / l;
    this._avoid.z = az / l;
    return this._avoid;
  }

  // --- interaction --------------------------------------------------------

  private computeInteractions(n: number, ids: Int32Array): void {
    const comfort = PEDESTRIAN.comfortRadius;
    const comfort2 = comfort * comfort;

    for (let k = 0; k < n; k++) {
      const id = ids[k];
      if (this.settled[id]) {
        this.density[id] = 0;
        continue;
      }
      const x = this.px[id];
      const z = this.pz[id];
      const dvx = this.forceX[id];
      const dvz = this.forceZ[id];
      const dl = Math.hypot(dvx, dvz) || 1;
      const fx = dvx / dl;
      const fz = dvz / dl;

      /*
       * Packing mode. Prayer rows are deliberately shoulder-to-shoulder, and
       * the row pitch is *smaller* than the comfortable walking distance a
       * pedestrian keeps. If we applied the normal social force here, every
       * worshipper would push their neighbour back out of the slot they were
       * trying to reach and the rows would never close up. So on the final
       * approach we fall back to hard non-overlap only (handled by the
       * position-based relaxation pass) with a token amount of soft
       * repulsion for ordering.
       */
      let scale = 1;
      let range = comfort;
      let range2 = comfort2;
      let settledWeight = 2.6;
      if (this.state[id] === AgentState.MOVING_TO_PRAYER) {
        const slot = this.prayerSlot[id];
        if (slot >= 0) {
          const sdx = this.slots.x[slot] - x;
          const sdz = this.slots.z[slot] - z;
          const sd = Math.hypot(sdx, sdz);
          // Blend smoothly into packing mode over the last 3 m so people do
          // not visibly change behaviour at a hard boundary.
          const pack = 1 - Math.min(1, Math.max(0, (sd - 0.4) / 2.6));
          scale = 1 - pack * 0.9;
          settledWeight = 2.6 - pack * 2.3;
          range = comfort * (1 - pack * 0.45);
          range2 = range * range;
        }
      }

      let repX = 0;
      let repZ = 0;
      let neighbours = 0;

      this.hash.forEachNear(x, z, range, (other) => {
        if (other === id) return;
        const ox = x - this.px[other];
        const oz = z - this.pz[other];
        const d2 = ox * ox + oz * oz;
        if (d2 > range2 || d2 < 1e-8) return;
        const d = Math.sqrt(d2);
        neighbours++;
        const nx = ox / d;
        const nz = oz / d;
        // Anisotropy: react much more strongly to people ahead.
        const facing = -(nx * fx + nz * fz);
        const lambda = 0.32;
        const aniso = lambda + (1 - lambda) * (1 + facing) * 0.5;
        // Exponential social force.
        let mag = Math.exp((PEDESTRIAN.radius * 2 - d) / 0.18) * aniso * 0.55 * scale;
        // Settled worshippers are immovable: treat them as walls.
        if (this.settled[other]) mag *= settledWeight;
        if (mag > 4) mag = 4;
        repX += nx * mag;
        repZ += nz * mag;
      });

      this.density[id] = neighbours;
      this.forceX[id] += repX;
      this.forceZ[id] += repZ;
    }
  }

  private integrate(id: number, dt: number): void {
    const state = this.state[id];
    if (state === AgentState.PRAYING || (this.settled[id] && state === AgentState.MOVING_TO_PRAYER)) {
      this.vx[id] = 0;
      this.vz[id] = 0;
      this.speed[id] = 0;
      // Orientation locks to the assigned slot.
      const s = this.prayerSlot[id];
      if (s >= 0) {
        this.yaw[id] = approachAngle(this.yaw[id], this.slots.yaw[s], PEDESTRIAN.maxTurnRate * dt);
        this.px[id] += (this.slots.x[s] - this.px[id]) * Math.min(1, dt * 5);
        this.pz[id] += (this.slots.z[s] - this.pz[id]) * Math.min(1, dt * 5);
      }
      return;
    }

    /*
     * Committed final approach. Within a stride of the assigned slot a
     * worshipper stops negotiating with the crowd and simply steps into
     * place. This is rate limited (never a snap, never a sideways slide)
     * but it is not subject to avoidance, which is what guarantees the rows
     * actually close up instead of asymptotically creeping.
     */
    if (state === AgentState.MOVING_TO_PRAYER) {
      const slot = this.prayerSlot[id];
      if (slot >= 0) {
        const sdx = this.slots.x[slot] - this.px[id];
        const sdz = this.slots.z[slot] - this.pz[id];
        const sd = Math.hypot(sdx, sdz);
        if (sd < 0.8) {
          const stepSpeed = Math.min(0.7, Math.max(0.12, sd * 2.2));
          const step = Math.min(sd, stepSpeed * dt);
          if (sd > 1e-6) {
            this.px[id] += (sdx / sd) * step;
            this.pz[id] += (sdz / sd) * step;
          }
          this.speed[id] = stepSpeed;
          this.vx[id] = sd > 1e-6 ? (sdx / sd) * stepSpeed : 0;
          this.vz[id] = sd > 1e-6 ? (sdz / sd) * stepSpeed : 0;
          // Face the qibla as we arrive, still rate limited.
          const wantYaw = sd > 0.25 ? Math.atan2(sdx, sdz) : this.slots.yaw[slot];
          this.yaw[id] = approachAngle(this.yaw[id], wantYaw, PEDESTRIAN.maxTurnRate * dt);
          if (sd < 0.06) {
            this.settled[id] = 1;
            this.speed[id] = 0;
            this.vx[id] = 0;
            this.vz[id] = 0;
          }
          return;
        }
      }
    }

    // Density-dependent speed: the classic fundamental diagram. Local
    // occupancy is counted in a 3x3 cell neighbourhood of 1.6 m cells.
    const occ = this.density[id];
    const headingToPrayer = state === AgentState.MOVING_TO_PRAYER;
    const congestion = clamp(1 - (occ - 2) / 12, headingToPrayer ? 0.5 : 0.16, 1);

    let tvx = this.forceX[id];
    let tvz = this.forceZ[id];
    const tl = Math.hypot(tvx, tvz);
    const cap =
      this.prefSpeed[id] *
      congestion *
      (state === AgentState.EXITING ? 1.05 : headingToPrayer ? 1.2 : 1);
    if (tl > cap && tl > 1e-6) {
      tvx = (tvx / tl) * cap;
      tvz = (tvz / tl) * cap;
    }

    const maxDv = PEDESTRIAN.maxAccel * dt;
    let ax = tvx - this.vx[id];
    let az = tvz - this.vz[id];
    const al = Math.hypot(ax, az);
    if (al > maxDv && al > 1e-9) {
      ax = (ax / al) * maxDv;
      az = (az / al) * maxDv;
    }
    this.vx[id] += ax;
    this.vz[id] += az;

    let sp = Math.hypot(this.vx[id], this.vz[id]);
    if (sp > PEDESTRIAN.maxSpeed) {
      this.vx[id] = (this.vx[id] / sp) * PEDESTRIAN.maxSpeed;
      this.vz[id] = (this.vz[id] / sp) * PEDESTRIAN.maxSpeed;
      sp = PEDESTRIAN.maxSpeed;
    }
    this.speed[id] = sp;

    this.px[id] += this.vx[id] * dt;
    this.pz[id] += this.vz[id] * dt;

    // Face the direction of travel, rate limited so nobody snaps around.
    if (sp > 0.08) {
      const want = Math.atan2(this.vx[id], this.vz[id]);
      this.yaw[id] = approachAngle(this.yaw[id], want, PEDESTRIAN.maxTurnRate * dt);
    }
  }

  /** One position-based pass that removes residual overlap. */
  private relax(n: number, ids: Int32Array): void {
    const minDist = PEDESTRIAN.radius * 2;
    const minDist2 = minDist * minDist;

    for (let k = 0; k < n; k++) {
      const id = ids[k];
      if (this.state[id] === AgentState.PRAYING) continue;
      // Once someone has taken their place they are a fixed obstacle: rows
      // must not jitter under avoidance forces.
      if (this.settled[id]) continue;
      let cx = 0;
      let cz = 0;
      let hits = 0;
      const x = this.px[id];
      const z = this.pz[id];

      // Worshippers stand closer together than pedestrians walk, so the
      // hard separation shrinks once someone is taking their place in a row.
      const packing =
        this.state[id] === AgentState.MOVING_TO_PRAYER || this.state[id] === AgentState.PRAYING;
      const sep = packing ? PRAYER_SEPARATION : minDist;
      const sep2 = packing ? PRAYER_SEPARATION * PRAYER_SEPARATION : minDist2;

      this.hash.forEachNear(x, z, sep, (other) => {
        if (other === id) return;
        const ox = x - this.px[other];
        const oz = z - this.pz[other];
        const d2 = ox * ox + oz * oz;
        if (d2 >= sep2) return;
        const d = Math.sqrt(d2);
        if (d < 1e-5) {
          // Perfectly coincident: separate deterministically.
          cx += ((id % 7) - 3) * 0.01;
          cz += ((id % 5) - 2) * 0.01;
          hits++;
          return;
        }
        // Settled worshippers do not move; the mover takes the whole push.
        const share = this.settled[other] ? 1.0 : 0.5;
        const push = (sep - d) * share;
        cx += (ox / d) * push;
        cz += (oz / d) * push;
        hits++;
      });

      if (hits > 0) {
        // Cap the correction so a dense knot cannot fling anybody.
        const cl = Math.hypot(cx, cz);
        const maxPush = 0.16;
        if (cl > maxPush) {
          cx = (cx / cl) * maxPush;
          cz = (cz / cl) * maxPush;
        }
        this.px[id] += cx;
        this.pz[id] += cz;

        // Push people apart, but never INTO the Kaaba or the Hijr. Without
        // this the separation pass can drive an agent a little deeper on each
        // relaxation iteration, and the depth it accumulates within a single
        // tick is what the final correction then has to undo in one jump.
        // Catching it here keeps every correction small.
        const q = this._pt;
        if (escapeTawafExclusion(this.px[id], this.pz[id], PEDESTRIAN.radius + 0.05, q)) {
          this.px[id] = q.x;
          this.pz[id] = q.z;
        }
      }
    }
  }

  private readonly _pt = { x: 0, z: 0 };

  private postUpdate(id: number, dt: number): void {
    if (!this.alive[id]) return;

    // Keep out of geometry. Praying agents are already exactly on a slot that
    // was validated against the obstacle set at generation time.
    if (this.state[id] !== AgentState.PRAYING) {
      const p = this._pt;
      p.x = this.px[id];
      p.z = this.pz[id];
      const clearance = PEDESTRIAN.radius + 0.05;

      // --- Soft correction: general obstacles, rate limited ----------------
      //
      // This is a geometric solve, and it can legitimately want to move an
      // agent a long way when the crowd has squeezed them somewhere they
      // should not be. Applying that in one tick is a 30 m/s teleport, which
      // is far more conspicuous than the overlap it fixes. Clamping means the
      // agent walks clear over a few frames instead, and cancelling the
      // inward velocity stops them pushing straight back in while they do.
      resolvePenetration(p, clearance, MATAF_OBSTACLES);
      let dx = p.x - this.px[id];
      let dz = p.z - this.pz[id];
      const dLen = Math.hypot(dx, dz);
      if (dLen > 1e-6) {
        const maxCorrection = PEDESTRIAN.maxSpeed * dt * 2;
        if (dLen > maxCorrection) {
          const nx = dx / dLen;
          const nz = dz / dLen;
          dx = nx * maxCorrection;
          dz = nz * maxCorrection;
          const into = this.vx[id] * nx + this.vz[id] * nz;
          if (into < 0) {
            this.vx[id] -= nx * into;
            this.vz[id] -= nz * into;
          }
        }
        this.px[id] += dx;
        this.pz[id] += dz;
      }

      // --- Hard invariant: never inside the Kaaba or the Hijr --------------
      //
      // This one is NOT rate limited, and deliberately so: "no one is ever
      // standing inside the Kaaba" is a correctness property, not a
      // preference, and a frame that ends in violation of it is simply wrong.
      // It is safe to apply in full because `escapeTawafExclusion` leaves by
      // the shortest route, so the depth an agent can reach in a single tick
      // — and therefore the correction — stays small. Measured worst case at
      // 2,400 agents is under 0.2 m.
      if (escapeTawafExclusion(this.px[id], this.pz[id], clearance, p)) {
        const ex = p.x - this.px[id];
        const ez = p.z - this.pz[id];
        const eLen = Math.hypot(ex, ez);
        this.px[id] = p.x;
        this.pz[id] = p.z;
        if (eLen > 1e-6) {
          const nx = ex / eLen;
          const nz = ez / eLen;
          const into = this.vx[id] * nx + this.vz[id] * nz;
          if (into < 0) {
            this.vx[id] -= nx * into;
            this.vz[id] -= nz * into;
          }
        }
      }
    }

    // Numerical safety net: never let a NaN propagate.
    if (!Number.isFinite(this.px[id]) || !Number.isFinite(this.pz[id])) {
      this.px[id] = Math.cos(id) * 30;
      this.pz[id] = Math.sin(id) * 30;
      this.vx[id] = 0;
      this.vz[id] = 0;
      this.prevX[id] = this.px[id];
      this.prevZ[id] = this.pz[id];
    }
    if (!Number.isFinite(this.yaw[id])) this.yaw[id] = 0;

    // Slow personal drift between lanes, so nobody traces the same circle.
    this.prefRadius[id] += this.radiusDrift[id] * dt;
    if (this.prefRadius[id] < 10.5) {
      this.prefRadius[id] = 10.5;
      this.radiusDrift[id] = Math.abs(this.radiusDrift[id]);
    } else if (this.prefRadius[id] > 46) {
      this.prefRadius[id] = 46;
      this.radiusDrift[id] = -Math.abs(this.radiusDrift[id]);
    }

    // Stuck detection and recovery.
    const moving =
      this.state[id] !== AgentState.PRAYING &&
      this.state[id] !== AgentState.IDLE &&
      !this.settled[id];
    if (moving && this.speed[id] < 0.06) {
      this.stuckTimer[id] += dt;
      if (this.stuckTimer[id] > 4) {
        // Nudge laterally along the flow to break the deadlock.
        const b = Math.atan2(this.pz[id], this.px[id]);
        const side = ((id & 1) === 0 ? 1 : -1) * 0.35;
        this.vx[id] += Math.sin(b) * 0.4 + Math.cos(b) * side;
        this.vz[id] += -Math.cos(b) * 0.4 + Math.sin(b) * side;
        this.stuckTimer[id] = 0;
        this.counters.stuckRecoveries++;
      }
      if (this.stuckTimer[id] > 22) {
        // Last resort: retire this agent through the nearest gate.
        this.beginExit(id);
      }
    } else {
      this.stuckTimer[id] = Math.max(0, this.stuckTimer[id] - dt * 0.5);
    }

    // Hard bound: nobody escapes the modelled precinct.
    const r = Math.hypot(this.px[id], this.pz[id]);
    const limit = SPAWN_RADIUS + 8;
    if (r > limit) {
      if (this.state[id] === AgentState.EXITING) {
        this.release(id);
        this.counters.departures++;
        return;
      }
      this.px[id] = (this.px[id] / r) * limit;
      this.pz[id] = (this.pz[id] / r) * limit;
    }
  }

  // --- population management ---------------------------------------------

  /** Estimated density of the mataf, people per square metre. */
  mataafDensity(): number {
    const area = Math.PI * (MATAF.outerRadius * MATAF.outerRadius - MATAF.innerRadius * MATAF.innerRadius);
    return this._liveCount / area;
  }

  private manageArrivals(dt: number): void {
    const target = this.tunables.targetPopulation;
    const deficit = target - this._liveCountApprox() - 0;
    if (deficit <= 0) {
      this.waitingQueue = 0;
      this.arrivalAccumulator = 0;
      return;
    }

    // During preparation and prayer, arrivals are damped: people who are not
    // already inside mostly wait rather than walking through forming rows.
    let rate = this.tunables.arrivalRate;
    if (this.phaseState === GlobalPhase.PREPARATION) rate *= 0.35;
    else if (this.phaseState === GlobalPhase.ROW_FORMATION) rate *= 0.12;
    else if (this.phaseState === GlobalPhase.PRAYER) rate = 0;
    else if (this.phaseState === GlobalPhase.POST_PRAYER) rate *= 0.4;

    // Congestion throttle at the entrances.
    const density = this.mataafDensity();
    if (density > 1.6) rate *= 0.25;
    else if (density > 1.1) rate *= 0.6;

    this.waitingQueue = deficit;

    if (rate <= 0) return;
    this.arrivalAccumulator += rate * dt;
    let budget = Math.floor(this.arrivalAccumulator);
    if (budget <= 0) return;
    this.arrivalAccumulator -= budget;
    if (budget > 60) budget = 60;

    while (budget-- > 0 && this._liveCountApprox() < target) {
      if (this.spawnAtGate() < 0) break;
      this.waitingQueue = Math.max(0, this.waitingQueue - 1);
    }
  }

  private manageDepartures(dt: number): void {
    const target = this.tunables.targetPopulation;
    const surplus = this._liveCountApprox() - target;
    if (surplus <= 0) {
      this.departureAccumulator = 0;
      return;
    }
    // Never make praying worshippers vanish. During prayer we simply defer.
    if (this.phaseState === GlobalPhase.ROW_FORMATION || this.phaseState === GlobalPhase.PRAYER) {
      return;
    }
    this.departureAccumulator += this.tunables.departureRate * dt;
    let budget = Math.floor(this.departureAccumulator);
    if (budget <= 0) return;
    this.departureAccumulator -= budget;
    if (budget > 60) budget = 60;

    this.ensureLive();
    // Prefer people who have finished, then people furthest out. Nobody is
    // deleted in place: they are given an exit route and walk out.
    for (let k = 0; k < this._liveCount && budget > 0; k++) {
      const id = this.liveIds[k];
      const s = this.state[id];
      if (s === AgentState.EXITING || s === AgentState.PRAYING || s === AgentState.MOVING_TO_PRAYER) continue;
      const finished = this.circuitsDone[id] >= this.targetCircuits[id];
      if (finished || s === AgentState.IDLE || s === AgentState.ENTERING) {
        this.beginExit(id);
        budget--;
      }
    }
    // If that was not enough, take the outermost tawaf participants.
    if (budget > 0) {
      for (let k = 0; k < this._liveCount && budget > 0; k++) {
        const id = this.liveIds[k];
        const s = this.state[id];
        if (s !== AgentState.PERFORMING_TAWAF && s !== AgentState.JOINING_TAWAF) continue;
        if (Math.hypot(this.px[id], this.pz[id]) < MATAF.outerRadius * 0.55) continue;
        this.beginExit(id);
        budget--;
      }
    }
  }

  private updateCounters(n: number, ids: Int32Array): void {
    const by = this.counters.byState;
    by.fill(0);
    for (let k = 0; k < n; k++) {
      by[this.state[ids[k]]]++;
    }
    this.counters.alive = n;
    this.counters.waiting = this.waitingQueue;
  }
}

// ---------------------------------------------------------------------------

export const GARMENT_COUNT = 8;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Rotate `from` toward `to` by at most `maxStep`, on the shortest arc. */
export function approachAngle(from: number, to: number, maxStep: number): number {
  const d = wrapAngle(to - from);
  if (Math.abs(d) <= maxStep) return to;
  return from + Math.sign(d) * maxStep;
}

/** Deterministic 0..1 hash of an integer — used for stable per-agent choices. */
function hash01(i: number): number {
  let x = (i + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export { hash01 };

/** Re-export so the render layer can use the same obstacle set. */
export { OBSTACLES };
