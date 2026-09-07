/**
 * bench.ts — simulation cost against population.
 *
 * WHAT THIS MEASURES
 *   The CPU cost of one simulation tick: steering, neighbour queries,
 *   collision response, state machines, prayer logic. It also measures the
 *   one-off cost of generating the prayer layout and baking the character
 *   animation, because those decide how long the loading screen lasts.
 *
 * WHAT THIS DOES NOT MEASURE
 *   Frame rate. Rendering needs a GPU and a browser; this is a headless Node
 *   process. The numbers here are a lower bound on what the application
 *   costs, not a statement about how fast it draws. See TEST-REPORT.md.
 *
 * Run: npm run bench
 */

import { Crowd } from '../src/sim/Crowd.ts';
import { PrayerOrchestrator } from '../src/sim/PrayerOrchestrator.ts';
import { generatePrayerSlots } from '../src/sim/PrayerLayout.ts';
import { GlobalPhase } from '../src/sim/States.ts';

const DT = 1 / 30;
const POPULATIONS = [250, 1000, 3000, 5000];
/** Ticks measured per configuration, after a warm-up. */
const MEASURE_TICKS = 900;
const WARMUP_TICKS = 240;

interface Row {
  population: number;
  scenario: string;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
  realtimeHeadroom: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[i];
}

function measure(population: number, scenario: 'tawaf' | 'prayer'): Row {
  const c = new Crowd({ capacity: Math.max(population + 200, 512), seed: 0xbeef + population });
  c.tunables.targetPopulation = population;
  c.populate(population);
  const o = new PrayerOrchestrator(c);
  o.settings.adhanToIqamah = 6;
  o.settings.durationScale = 1;

  let t = 0;
  for (let i = 0; i < WARMUP_TICKS; i++) {
    o.update(DT, t);
    c.step(DT);
    t += DT;
  }

  if (scenario === 'prayer') {
    o.prepare(t);
    // Run until the congregation is actually praying, so the measured window
    // covers the expensive part rather than the walk to the rows.
    let guard = 30 * 240;
    while (o.phase !== GlobalPhase.PRAYER && guard-- > 0) {
      o.update(DT, t);
      c.step(DT);
      t += DT;
    }
  }

  const samples: number[] = [];
  for (let i = 0; i < MEASURE_TICKS; i++) {
    const t0 = performance.now();
    o.update(DT, t);
    c.step(DT);
    samples.push(performance.now() - t0);
    t += DT;
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;

  return {
    population,
    scenario,
    meanMs: mean,
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1],
    // A 30 Hz simulation has 33.3 ms of wall time per tick.
    realtimeHeadroom: (DT * 1000) / mean,
  };
}

function pad(s: string | number, n: number, left = true): string {
  const str = String(s);
  return left ? str.padStart(n) : str.padEnd(n);
}

console.log('Simulation benchmark');
console.log(`node ${process.version}  ${process.platform}/${process.arch}`);
console.log(`fixed timestep ${(DT * 1000).toFixed(2)} ms (${Math.round(1 / DT)} Hz)`);
console.log(`${MEASURE_TICKS} measured ticks after ${WARMUP_TICKS} warm-up ticks\n`);

// One-off costs.
const layoutStart = performance.now();
const slots = generatePrayerSlots();
const layoutMs = performance.now() - layoutStart;
console.log(`prayer layout      ${slots.count.toLocaleString()} slots in ${layoutMs.toFixed(1)} ms`);
console.log(`                   ${slots.rowCount} rows\n`);

console.log(
  `${pad('population', 11)}  ${pad('scenario', 9, false)}  ${pad('mean ms', 8)}  ${pad('p95 ms', 8)}  ${pad('max ms', 8)}  ${pad('x realtime', 11)}`,
);
console.log('-'.repeat(66));

const rows: Row[] = [];
for (const population of POPULATIONS) {
  for (const scenario of ['tawaf', 'prayer'] as const) {
    const r = measure(population, scenario);
    rows.push(r);
    console.log(
      `${pad(r.population.toLocaleString(), 11)}  ${pad(r.scenario, 9, false)}  ${pad(r.meanMs.toFixed(3), 8)}  ${pad(r.p95Ms.toFixed(3), 8)}  ${pad(r.maxMs.toFixed(3), 8)}  ${pad(r.realtimeHeadroom.toFixed(1) + 'x', 11)}`,
    );
  }
}

// Scaling: if the spatial hash is doing its job this should be close to
// linear, not quadratic.
const tawaf = rows.filter((r) => r.scenario === 'tawaf');
if (tawaf.length >= 2) {
  const first = tawaf[0];
  const last = tawaf[tawaf.length - 1];
  const popRatio = last.population / first.population;
  const costRatio = last.meanMs / first.meanMs;
  const exponent = Math.log(costRatio) / Math.log(popRatio);
  console.log(
    `\nscaling ${first.population} -> ${last.population}: cost x${costRatio.toFixed(2)} for population x${popRatio.toFixed(1)}`,
  );
  console.log(`empirical exponent ${exponent.toFixed(2)} (1.0 = linear, 2.0 = quadratic)`);
}

console.log(
  '\nNote: these are CPU simulation costs only. Frame rate depends on the GPU\nand is not measured here; see TEST-REPORT.md.',
);
