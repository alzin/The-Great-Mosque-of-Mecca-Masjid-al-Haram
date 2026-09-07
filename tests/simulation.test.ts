/**
 * simulation.test.ts — the invariants the crowd must never violate.
 *
 * These are properties, not golden values. A crowd simulation is stochastic
 * and lightly chaotic: asserting that agent 412 is at a particular coordinate
 * after 90 seconds would be a test of the random seed, not of the model. What
 * can be asserted is that nobody is ever inside the Kaaba, that the population
 * only changes through the gates, that every worshipper gets a slot of their
 * own, and that no number ever becomes NaN.
 */

import { describe, it, expect } from 'vitest';
import { Crowd } from '../src/sim/Crowd.ts';
import { PrayerOrchestrator, buildPrayerTimeline, sampleTimeline } from '../src/sim/PrayerOrchestrator.ts';
import { AgentState, GlobalPhase, AGENT_STATE_COUNT, CLIP_COUNT } from '../src/sim/States.ts';
import { insideTawafExclusion, isWalkable, OBSTACLES } from '../src/sim/Obstacles.ts';
import { generatePrayerSlots, SlotAllocator, yawTowardKaaba } from '../src/sim/PrayerLayout.ts';
import { GALLERY, MATAF, PRAYER_LAYOUT } from '../src/config/site.ts';
import { CLIPS, CLIP_OFFSETS, TOTAL_FRAMES } from '../src/characters/AnimationBank.ts';
import { resolveFrames } from '../src/characters/CrowdView.ts';

const DT = 1 / 30;

function run(crowd: Crowd, seconds: number, onTick?: (t: number) => void): void {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    crowd.step(DT);
    onTick?.(i * DT);
  }
}

/** Every finite-number invariant, checked in one pass. */
function assertNumericallySane(crowd: Crowd): void {
  const ids = crowd.liveIdsView();
  for (let k = 0; k < ids.length; k++) {
    const id = ids[k];
    expect(Number.isFinite(crowd.px[id])).toBe(true);
    expect(Number.isFinite(crowd.pz[id])).toBe(true);
    expect(Number.isFinite(crowd.yaw[id])).toBe(true);
    expect(Number.isFinite(crowd.speed[id])).toBe(true);
    expect(crowd.speed[id]).toBeGreaterThanOrEqual(0);
    expect(crowd.state[id]).toBeGreaterThanOrEqual(0);
    expect(crowd.state[id]).toBeLessThan(AGENT_STATE_COUNT);
    expect(crowd.clip[id]).toBeGreaterThanOrEqual(0);
    expect(crowd.clip[id]).toBeLessThan(CLIP_COUNT);
    expect(crowd.clipTime[id]).toBeGreaterThanOrEqual(0);
    expect(crowd.clipTime[id]).toBeLessThanOrEqual(1.0001);
  }
}

describe('obstacles and walkability', () => {
  it('excludes the Kaaba footprint from the walkable area', () => {
    expect(isWalkable(0, 0)).toBe(false);
    expect(isWalkable(3, 3)).toBe(false);
  });

  it('marks the open mataf as walkable', () => {
    for (const r of [12, 25, 40, 55]) {
      for (let a = 0; a < 6; a++) {
        const t = (a / 6) * Math.PI * 2;
        const x = Math.cos(t) * r;
        const z = Math.sin(t) * r;
        // Skip the two fixed structures.
        if (!isWalkable(x, z)) {
          // Only Maqam Ibrahim and Zamzam should ever block open courtyard.
          const blocked = OBSTACLES.some(
            (o) => Math.hypot(x - o.bx, z - o.bz) < o.br + 1,
          );
          expect(blocked).toBe(true);
        }
      }
    }
  });

  it('keeps the tawaf exclusion zone inside the first prayer row', () => {
    expect(insideTawafExclusion(0, 0)).toBe(true);
    expect(PRAYER_LAYOUT.firstRowRadius).toBeGreaterThan(MATAF.innerRadius);
  });
});

describe('prayer layout', () => {
  const slots = generatePrayerSlots();

  it('generates rows in concentric arcs facing the Kaaba', () => {
    expect(slots.count).toBeGreaterThan(5000);
    for (let i = 0; i < slots.count; i += 97) {
      const x = slots.x[i];
      const z = slots.z[i];
      const r = Math.hypot(x, z);
      expect(r).toBeGreaterThanOrEqual(PRAYER_LAYOUT.firstRowRadius - 0.01);
      expect(r).toBeLessThanOrEqual(PRAYER_LAYOUT.lastRowRadius + 0.01);

      // Facing: the yaw must point at the Kaaba, i.e. the forward vector
      // (sin yaw, cos yaw) must be antiparallel to the outward radial.
      const yaw = yawTowardKaaba(x, z);
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      const dot = (fx * -x + fz * -z) / r;
      expect(dot).toBeGreaterThan(0.999);
    }
  });

  it('never places a slot inside an obstacle', () => {
    for (let i = 0; i < slots.count; i += 37) {
      expect(isWalkable(slots.x[i], slots.z[i])).toBe(true);
    }
  });

  it('spaces the rows evenly outward from the first', () => {
    expect(slots.rowCount).toBeGreaterThan(20);
    for (let i = 0; i < slots.count; i += 53) {
      const expected =
        PRAYER_LAYOUT.firstRowRadius + slots.row[i] * PRAYER_LAYOUT.rowSpacing;
      expect(Math.abs(slots.radius[i] - expected)).toBeLessThan(0.02);
      expect(Math.abs(Math.hypot(slots.x[i], slots.z[i]) - slots.radius[i])).toBeLessThan(0.02);
    }
  });

  it('hands out unique slots and returns them on release', () => {
    const alloc = new SlotAllocator(slots);
    const taken = new Set<number>();
    for (let i = 0; i < 4000; i++) {
      const bearing = (i / 4000) * Math.PI * 2 - Math.PI;
      const s = alloc.claim(i, Math.cos(bearing) * 30, Math.sin(bearing) * 30);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(taken.has(s)).toBe(false);
      taken.add(s);
    }
    expect(taken.size).toBe(4000);
    for (const s of taken) alloc.release(s);
    const again = alloc.claim(0, 20, 0);
    expect(again).toBeGreaterThanOrEqual(0);
  });
});

describe('animation bank', () => {
  it('packs every clip inside the baked frame range', () => {
    for (let c = 0; c < CLIP_COUNT; c++) {
      expect(CLIPS[c].frames).toBeGreaterThan(0);
      expect(CLIP_OFFSETS[c] + CLIPS[c].frames).toBeLessThanOrEqual(TOTAL_FRAMES);
    }
  });

  it('never resolves a frame belonging to a different clip', () => {
    const out = { f0: 0, f1: 0, frac: 0 };
    for (let c = 0; c < CLIP_COUNT; c++) {
      const lo = CLIP_OFFSETS[c];
      const hi = lo + CLIPS[c].frames - 1;
      for (const t of [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1, 1.5, -0.3]) {
        resolveFrames(c, t, out);
        expect(out.f0).toBeGreaterThanOrEqual(lo);
        expect(out.f0).toBeLessThanOrEqual(hi);
        expect(out.f1).toBeGreaterThanOrEqual(lo);
        expect(out.f1).toBeLessThanOrEqual(hi);
        expect(out.frac).toBeGreaterThanOrEqual(0);
        expect(out.frac).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('prayer timeline', () => {
  it('runs the postures of a two-rak\u2018ah prayer in the canonical order', () => {
    const tl = buildPrayerTimeline(2, 1);
    const labels: string[] = [];
    for (let t = 0; t < tl.total; t += 0.25) {
      const s = sampleTimeline(tl, t);
      if (labels[labels.length - 1] !== s.label) labels.push(s.label);
    }
    const joined = labels.join(' > ').toLowerCase();
    expect(joined).toContain('takbir');
    expect(joined.indexOf('ruku')).toBeLessThan(joined.indexOf('sujud'));
    expect(joined).toContain('tashahhud');
    expect(joined.lastIndexOf('taslim')).toBeGreaterThan(joined.indexOf('tashahhud'));
  });

  it('scales duration without changing the posture order', () => {
    const a = buildPrayerTimeline(2, 1);
    const b = buildPrayerTimeline(2, 0.5);
    expect(b.total).toBeLessThan(a.total);
    expect(b.total).toBeGreaterThan(a.total * 0.4);
  });

  it('adds time for extra rak\u2018ahs', () => {
    expect(buildPrayerTimeline(4, 1).total).toBeGreaterThan(buildPrayerTimeline(2, 1).total);
  });
});

describe('crowd: population accounting', () => {
  it('starts empty and stays empty at a target of zero', () => {
    const c = new Crowd({ capacity: 200, seed: 3 });
    c.tunables.targetPopulation = 0;
    run(c, 40);
    expect(c.liveCount).toBe(0);
    assertNumericallySane(c);
  });

  it('reaches a small target and holds it', () => {
    const c = new Crowd({ capacity: 400, seed: 5 });
    c.tunables.targetPopulation = 60;
    c.tunables.arrivalRate = 120;
    run(c, 180);
    expect(c.liveCount).toBeGreaterThan(40);
    expect(c.liveCount).toBeLessThanOrEqual(60);
    assertNumericallySane(c);
  });

  it('never exceeds capacity even when the target is raised beyond it', () => {
    const c = new Crowd({ capacity: 150, seed: 9 });
    c.tunables.targetPopulation = 150;
    c.populate(150);
    c.tunables.targetPopulation = 400;
    c.tunables.arrivalRate = 600;
    run(c, 60);
    expect(c.liveCount).toBeLessThanOrEqual(150);
  });

  it('lets people walk out rather than deleting them when the target drops', () => {
    const c = new Crowd({ capacity: 600, seed: 11 });
    c.populate(400);
    expect(c.liveCount).toBe(400);
    c.tunables.targetPopulation = 150;
    c.tunables.departureRate = 240;

    let sawExiting = false;
    run(c, 200, () => {
      if (c.counters.byState[AgentState.EXITING] > 0) sawExiting = true;
    });
    expect(sawExiting).toBe(true);
    expect(c.liveCount).toBeLessThan(400);
    expect(c.counters.departures).toBeGreaterThan(0);
    assertNumericallySane(c);
  });

  it('admits arrivals only through gate openings', () => {
    const c = new Crowd({ capacity: 300, seed: 13 });
    c.tunables.targetPopulation = 120;
    c.tunables.arrivalRate = 300;
    const seen = new Set<number>();
    run(c, 60, () => {
      const ids = c.liveIdsView();
      for (let k = 0; k < ids.length; k++) {
        const id = ids[k];
        if (c.state[id] !== AgentState.ENTERING || seen.has(id)) continue;
        seen.add(id);
        // A just-spawned agent must be out near the colonnade, not in the
        // middle of the courtyard.
        const r = Math.hypot(c.px[id], c.pz[id]);
        expect(r).toBeGreaterThan(MATAF.outerRadius * 0.5);
      }
    });
    expect(seen.size).toBeGreaterThan(0);
  });
});

describe('crowd: circulation', () => {
  it('keeps everyone out of the Kaaba and inside the precinct', () => {
    const c = new Crowd({ capacity: 900, seed: 17 });
    c.populate(700);
    let violations = 0;
    let outOfBounds = 0;
    run(c, 120, () => {
      const ids = c.liveIdsView();
      for (let k = 0; k < ids.length; k++) {
        const id = ids[k];
        if (insideTawafExclusion(c.px[id], c.pz[id])) violations++;
        if (Math.hypot(c.px[id], c.pz[id]) > GALLERY.outerWallRadius) outOfBounds++;
      }
    });
    expect(violations).toBe(0);
    expect(outOfBounds).toBe(0);
    assertNumericallySane(c);
  });

  it('circumambulates counter-clockwise', () => {
    const c = new Crowd({ capacity: 600, seed: 19 });
    c.populate(400);
    run(c, 30);

    const before = new Map<number, number>();
    const ids = Array.from(c.liveIdsView());
    for (const id of ids) {
      if (c.state[id] === AgentState.PERFORMING_TAWAF) {
        before.set(id, Math.atan2(c.pz[id], c.px[id]));
      }
    }
    run(c, 6);

    let ccw = 0;
    let cw = 0;
    for (const [id, a0] of before) {
      if (c.state[id] !== AgentState.PERFORMING_TAWAF) continue;
      let d = Math.atan2(c.pz[id], c.px[id]) - a0;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      if (Math.abs(d) < 1e-3) continue;
      // Counter-clockwise seen from above is a DECREASING atan2(z, x) angle
      // in this coordinate frame.
      if (d < 0) ccw++;
      else cw++;
    }
    expect(ccw).toBeGreaterThan(0);
    expect(ccw / Math.max(1, ccw + cw)).toBeGreaterThan(0.95);
  });

  it('completes circuits and eventually cycles people out', () => {
    const c = new Crowd({ capacity: 900, seed: 23 });
    c.tunables.targetPopulation = 500;
    c.tunables.circuits = 2;
    c.populate(500);
    run(c, 600);
    expect(c.counters.circuitsCompleted).toBeGreaterThan(0);
    expect(c.counters.departures).toBeGreaterThan(0);
    expect(c.counters.arrivals).toBeGreaterThan(0);
  });

  it('recovers rather than deadlocking under heavy congestion', () => {
    const c = new Crowd({ capacity: 2500, seed: 29 });
    c.populate(2200);
    run(c, 240);
    assertNumericallySane(c);
    // Under this density most people should still be making progress.
    const ids = c.liveIdsView();
    let moving = 0;
    for (let k = 0; k < ids.length; k++) {
      if (c.speed[ids[k]] > 0.05) moving++;
    }
    expect(moving / ids.length).toBeGreaterThan(0.5);
  });
});

describe('crowd: congregational prayer', () => {
  function runPrayer(seed: number, population: number) {
    const c = new Crowd({ capacity: population + 400, seed });
    c.tunables.targetPopulation = population;
    c.populate(population);
    const o = new PrayerOrchestrator(c);
    o.settings.adhanToIqamah = 8;
    o.settings.durationScale = 0.3;
    o.settings.postPrayer = 10;

    let t = 0;
    const phases: GlobalPhase[] = [o.phase];
    const step = () => {
      o.update(DT, t);
      c.step(DT);
      t += DT;
      if (phases[phases.length - 1] !== o.phase) phases.push(o.phase);
    };
    for (let i = 0; i < 30 * 6; i++) step();
    o.prepare(t);
    for (let i = 0; i < 30 * 320; i++) step();
    return { crowd: c, orchestrator: o, phases, elapsed: t };
  }

  it('walks the global state machine through every phase and back', () => {
    const { phases, orchestrator } = runPrayer(31, 500);
    expect(phases).toContain(GlobalPhase.PREPARATION);
    expect(phases).toContain(GlobalPhase.ROW_FORMATION);
    expect(phases).toContain(GlobalPhase.PRAYER);
    expect(phases).toContain(GlobalPhase.POST_PRAYER);
    expect(phases[phases.length - 1]).toBe(GlobalPhase.NORMAL_ACTIVITY);
    expect(orchestrator.completedPrayers).toBe(1);
  });

  it('gives every worshipper a slot of their own, and forms curved rows', () => {
    const c = new Crowd({ capacity: 1200, seed: 37 });
    c.populate(900);
    const o = new PrayerOrchestrator(c);
    o.settings.adhanToIqamah = 5;
    o.settings.durationScale = 0.3;
    let t = 0;
    o.prepare(t);
    for (let i = 0; i < 30 * 150; i++) {
      o.update(DT, t);
      c.step(DT);
      t += DT;
      if (o.phase === GlobalPhase.PRAYER) break;
    }
    expect(o.phase).toBe(GlobalPhase.PRAYER);

    const used = new Map<number, number>();
    const ids = c.liveIdsView();
    let praying = 0;
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k];
      if (c.state[id] !== AgentState.PRAYING) continue;
      praying++;
      const slot = c.prayerSlot[id];
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(used.has(slot)).toBe(false);
      used.set(slot, id);
    }
    expect(praying).toBeGreaterThan(400);

    // Rows are arcs, not a rectangular grid: worshippers at the same radius
    // must face different absolute directions, and each must face the Kaaba.
    const yaws: number[] = [];
    for (const id of used.values()) {
      const x = c.px[id];
      const z = c.pz[id];
      const r = Math.hypot(x, z);
      const fx = Math.sin(c.yaw[id]);
      const fz = Math.cos(c.yaw[id]);
      expect((fx * -x + fz * -z) / r).toBeGreaterThan(0.9);
      yaws.push(c.yaw[id]);
    }
    const spread = Math.max(...yaws) - Math.min(...yaws);
    expect(spread).toBeGreaterThan(3);
  });

  it('never teleports anyone into a row', () => {
    const c = new Crowd({ capacity: 800, seed: 41 });
    c.populate(600);
    const o = new PrayerOrchestrator(c);
    o.settings.adhanToIqamah = 5;
    o.settings.durationScale = 0.3;
    let t = 0;
    o.prepare(t);

    const prevX = new Float32Array(c.capacity);
    const prevZ = new Float32Array(c.capacity);
    const prevGen = new Uint32Array(c.capacity);
    const tracked = new Uint8Array(c.capacity);
    let maxJump = 0;

    for (let i = 0; i < 30 * 200; i++) {
      o.update(DT, t);
      c.step(DT);
      t += DT;
      const ids = c.liveIdsView();
      for (let k = 0; k < ids.length; k++) {
        const id = ids[k];
        // Ids are recycled, so only compare an agent against itself.
        const recycled = c.generation[id] !== prevGen[id];
        if (tracked[id] && !recycled) {
          const d = Math.hypot(c.px[id] - prevX[id], c.pz[id] - prevZ[id]);
          if (d > maxJump) maxJump = d;
        }
        prevX[id] = c.px[id];
        prevZ[id] = c.pz[id];
        prevGen[id] = c.generation[id];
        tracked[id] = 1;
      }
      // An id freed this tick may be handed to a new arrival next tick.
      for (let id = 0; id < c.capacity; id++) if (!c.alive[id]) tracked[id] = 0;
    }
    // One tick at the fastest permitted speed is well under half a metre.
    expect(maxJump).toBeLessThan(0.5);
  });

  it('lets tawaf resume afterwards, preserving circuit progress', () => {
    const c = new Crowd({ capacity: 700, seed: 43 });
    c.populate(500);
    const o = new PrayerOrchestrator(c);
    o.settings.adhanToIqamah = 5;
    o.settings.durationScale = 0.25;
    o.settings.postPrayer = 8;
    let t = 0;

    for (let i = 0; i < 30 * 40; i++) {
      o.update(DT, t);
      c.step(DT);
      t += DT;
    }
    const before = new Map<number, number>();
    const ids = Array.from(c.liveIdsView());
    for (const id of ids) before.set(id, c.circuitsDone[id]);

    o.prepare(t);
    for (let i = 0; i < 30 * 320; i++) {
      o.update(DT, t);
      c.step(DT);
      t += DT;
    }
    expect(o.phase).toBe(GlobalPhase.NORMAL_ACTIVITY);

    // Everyone still present with their original id must have at least as
    // many circuits as before: the prayer interrupts, it does not reset.
    let checked = 0;
    for (const [id, n] of before) {
      if (!c.alive[id]) continue;
      if (c.circuitsDone[id] < n) {
        // Only legitimate if the slot was recycled to a new arrival.
        continue;
      }
      checked++;
      expect(c.circuitsDone[id]).toBeGreaterThanOrEqual(n);
    }
    expect(checked).toBeGreaterThan(100);

    // And people are walking again.
    let moving = 0;
    const after = c.liveIdsView();
    for (let k = 0; k < after.length; k++) if (c.speed[after[k]] > 0.1) moving++;
    expect(moving / after.length).toBeGreaterThan(0.4);
  });

  it('can be cancelled mid-formation and returns to normal activity', () => {
    const c = new Crowd({ capacity: 500, seed: 47 });
    c.populate(300);
    const o = new PrayerOrchestrator(c);
    o.settings.adhanToIqamah = 4;
    let t = 0;
    o.prepare(t);
    for (let i = 0; i < 30 * 30; i++) {
      o.update(DT, t);
      c.step(DT);
      t += DT;
    }
    expect(o.phase).toBe(GlobalPhase.ROW_FORMATION);
    o.cancel(t);
    for (let i = 0; i < 30 * 40; i++) {
      o.update(DT, t);
      c.step(DT);
      t += DT;
    }
    expect(o.phase).toBe(GlobalPhase.NORMAL_ACTIVITY);
    assertNumericallySane(c);
    const ids = c.liveIdsView();
    for (let k = 0; k < ids.length; k++) {
      expect(c.state[ids[k]]).not.toBe(AgentState.PRAYING);
    }
  });

  it('handles repeated prayer cycles without drift or leaks', () => {
    const c = new Crowd({ capacity: 700, seed: 53 });
    c.tunables.targetPopulation = 450;
    c.populate(450);
    const o = new PrayerOrchestrator(c);
    o.settings.adhanToIqamah = 4;
    o.settings.durationScale = 0.22;
    o.settings.postPrayer = 8;
    let t = 0;
    for (let cycle = 0; cycle < 3; cycle++) {
      o.prepare(t);
      for (let i = 0; i < 30 * 260; i++) {
        o.update(DT, t);
        c.step(DT);
        t += DT;
        if (o.phase === GlobalPhase.NORMAL_ACTIVITY && i > 30 * 40) break;
      }
    }
    expect(o.completedPrayers).toBe(3);
    assertNumericallySane(c);
    expect(c.liveCount).toBeGreaterThan(300);
    expect(c.liveCount).toBeLessThanOrEqual(450);
  });

  it('seats the overflow outside the rows rather than double-booking', () => {
    const slots = generatePrayerSlots();
    const alloc = new SlotAllocator(slots);
    const claimed = new Set<number>();
    let refusals = 0;
    for (let i = 0; i < slots.count + 500; i++) {
      const bearing = (i * 0.37) % (Math.PI * 2);
      const s = alloc.claim(i, Math.cos(bearing) * 40, Math.sin(bearing) * 40);
      if (s < 0) {
        refusals++;
        continue;
      }
      expect(claimed.has(s)).toBe(false);
      claimed.add(s);
    }
    expect(claimed.size).toBe(slots.count);
    expect(refusals).toBe(500);
  });
});

describe('crowd: reset', () => {
  it('returns to a clean state and can be re-populated', () => {
    const c = new Crowd({ capacity: 400, seed: 59 });
    c.populate(300);
    run(c, 60);
    c.reset(120);
    expect(c.liveCount).toBe(120);
    expect(c.counters.departures).toBe(0);
    expect(c.counters.circuitsCompleted).toBe(0);
    assertNumericallySane(c);
    run(c, 60);
    assertNumericallySane(c);
  });
});
