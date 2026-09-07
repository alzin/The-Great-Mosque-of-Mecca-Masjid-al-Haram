/**
 * soak.test.ts — forty simulated minutes, unattended.
 *
 * Short tests catch logic errors. They do not catch the things that only show
 * up over time: a slot allocator that leaks a few entries per prayer, an
 * accumulated bearing that drifts, a free list that loses ids, a spatial hash
 * that degrades, memory that grows. This runs 72,000 fixed timesteps through
 * repeated prayer cycles and a changing population target, sampling
 * invariants throughout and checking for drift at the end.
 *
 * It is deliberately separate from the main suite because it takes minutes:
 *   npm run soak
 */

import { describe, it, expect } from 'vitest';
import { Crowd } from '../src/sim/Crowd.ts';
import { PrayerOrchestrator } from '../src/sim/PrayerOrchestrator.ts';
import { AgentState, GlobalPhase } from '../src/sim/States.ts';
import { insideTawafExclusion } from '../src/sim/Obstacles.ts';
import { GALLERY } from '../src/config/site.ts';

const DT = 1 / 30;
const MINUTES = 40;
const TOTAL_TICKS = Math.round((MINUTES * 60) / DT);

describe('soak', () => {
  it(`survives ${MINUTES} simulated minutes with prayers and population changes`, () => {
    const capacity = 3000;
    const c = new Crowd({ capacity, seed: 0xf00d });
    c.tunables.targetPopulation = 1200;
    c.tunables.arrivalRate = 40;
    c.tunables.departureRate = 40;
    c.populate(1200);

    const o = new PrayerOrchestrator(c);
    o.settings.adhanToIqamah = 20;
    o.settings.durationScale = 0.5;
    o.settings.postPrayer = 20;
    o.settings.scheduleEnabled = true;
    o.settings.scheduleInterval = 300;

    let t = 0;
    let exclusionViolations = 0;
    let outOfBounds = 0;
    let nonFinite = 0;
    let maxLive = 0;
    let minLive = Infinity;
    let doubleBooked = 0;
    let maxStepMs = 0;
    let totalStepMs = 0;

    // A changing target across the run, so the population machinery is
    // exercised rather than left at a steady state.
    const targets = [1200, 400, 2400, 900, 1500];

    const slotOwners = new Map<number, number>();

    for (let i = 0; i < TOTAL_TICKS; i++) {
      if (i % Math.floor(TOTAL_TICKS / targets.length) === 0) {
        c.tunables.targetPopulation = targets[Math.min(targets.length - 1, Math.floor(i / (TOTAL_TICKS / targets.length)))];
      }

      const t0 = performance.now();
      o.update(DT, t);
      c.step(DT);
      const elapsed = performance.now() - t0;
      totalStepMs += elapsed;
      if (elapsed > maxStepMs) maxStepMs = elapsed;
      t += DT;

      // Sample invariants a few times a second rather than every tick: the
      // checks cost more than the simulation does.
      if (i % 15 === 0) {
        const ids = c.liveIdsView();
        maxLive = Math.max(maxLive, ids.length);
        minLive = Math.min(minLive, ids.length);
        slotOwners.clear();
        for (let k = 0; k < ids.length; k++) {
          const id = ids[k];
          const x = c.px[id];
          const z = c.pz[id];
          if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(c.yaw[id])) {
            nonFinite++;
          }
          if (insideTawafExclusion(x, z)) exclusionViolations++;
          if (Math.hypot(x, z) > GALLERY.outerWallRadius) outOfBounds++;
          const slot = c.prayerSlot[id];
          if (slot >= 0) {
            if (slotOwners.has(slot)) doubleBooked++;
            slotOwners.set(slot, id);
          }
        }
      }
    }

    const meanStepMs = totalStepMs / TOTAL_TICKS;

    // eslint-disable-next-line no-console
    console.log(
      [
        '',
        `  soak: ${MINUTES} simulated minutes (${TOTAL_TICKS} ticks)`,
        `  population range        ${minLive} .. ${maxLive}`,
        `  prayers completed       ${o.completedPrayers}`,
        `  circuits completed      ${c.counters.circuitsCompleted}`,
        `  arrivals / departures   ${c.counters.arrivals} / ${c.counters.departures}`,
        `  stuck recoveries        ${c.counters.stuckRecoveries}`,
        `  exclusion violations    ${exclusionViolations}`,
        `  out of bounds           ${outOfBounds}`,
        `  non-finite values       ${nonFinite}`,
        `  double-booked slots     ${doubleBooked}`,
        `  mean step               ${meanStepMs.toFixed(3)} ms`,
        `  worst step              ${maxStepMs.toFixed(2)} ms`,
        '',
      ].join('\n'),
    );

    expect(nonFinite).toBe(0);
    expect(exclusionViolations).toBe(0);
    expect(outOfBounds).toBe(0);
    expect(doubleBooked).toBe(0);

    // The scheduled prayer runs every five minutes, so forty minutes must
    // produce several complete cycles and end back in normal activity.
    // Measured: a 300 s schedule interval plus the length of a cycle yields
    // four completed prayers in forty minutes.
    expect(o.completedPrayers).toBeGreaterThanOrEqual(4);
    expect(c.counters.circuitsCompleted).toBeGreaterThan(100);

    // No id leak: the free list plus the live list must still account for
    // every slot.
    let aliveCount = 0;
    for (let id = 0; id < capacity; id++) if (c.alive[id]) aliveCount++;
    expect(aliveCount).toBe(c.liveCount);

    // The final target must have been approached, not drifted away from.
    expect(c.liveCount).toBeGreaterThan(1000);
    expect(c.liveCount).toBeLessThanOrEqual(1500);

    // --- Wind down ---------------------------------------------------------
    //
    // Forty minutes will often end mid-prayer, when a stationary crowd is the
    // CORRECT state. So stop scheduling further prayers and give the
    // simulation up to five more simulated minutes to come back to normal
    // activity. That it always can is itself worth asserting: a phase machine
    // that can get wedged in ROW_FORMATION would show up here.
    o.settings.scheduleEnabled = false;
    let windDown = 0;
    const windDownLimit = Math.round((5 * 60) / DT);
    while (o.phase !== GlobalPhase.NORMAL_ACTIVITY && windDown < windDownLimit) {
      o.update(DT, t);
      c.step(DT);
      t += DT;
      windDown++;
    }
    expect(o.phase).toBe(GlobalPhase.NORMAL_ACTIVITY);

    // Let the congregation disperse before judging whether people are moving.
    for (let i = 0; i < Math.round(25 / DT); i++) {
      o.update(DT, t);
      c.step(DT);
      t += DT;
    }

    // Nobody left in a transient state.
    const ids = c.liveIdsView();
    let praying = 0;
    for (let k = 0; k < ids.length; k++) {
      if (c.state[ids[k]] === AgentState.PRAYING) praying++;
    }
    expect(praying).toBe(0);

    // And the crowd is walking again, not frozen in a deadlock.
    let moving = 0;
    for (let k = 0; k < ids.length; k++) if (c.speed[ids[k]] > 0.05) moving++;
    expect(moving / ids.length).toBeGreaterThan(0.4);
  });
});
