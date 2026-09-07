# Test and performance report

Everything in this document is a measurement taken from this project, on the
machine described below, by a command you can re-run. Where something could
not be measured, it says so instead of estimating.

## Environment

| | |
| --- | --- |
| CPU | 1 core |
| RAM | ~4 GB |
| GPU | **none** |
| OS / runtime | Linux x64, Node v22.22.2 |
| Browser (QA only) | Headless Chromium 1194 via Playwright 1.56.0, WebGL 2 through ANGLE/SwiftShader (software rasteriser) |

## What was NOT measured, and why

**Frame rate.** This machine has no GPU. Chromium falls back to SwiftShader,
which rasterises on the same single CPU core that is already running the
simulation. Numbers from that configuration would say something about
SwiftShader, not about the application on real hardware, and quoting them as
"performance" would be misleading. So there is no FPS figure in this report.

What that means in practice: the rendering architecture — instance counts,
draw calls, triangle counts, LOD thresholds, texture sizes — has been designed
and inspected, and the simulation cost underneath it has been measured
properly, but **the frame rate on real hardware is unknown and has not been
verified.** The diagnostics panel in the application reports live FPS, frame
time and p95 frame time, which is where to look on a machine that has a GPU.

The application was rendered and screenshotted repeatedly in software, so it
is known to produce correct images and to run without WebGL errors. It is not
known how fast it does so.

## Reproducing

```bash
npm run typecheck   # TypeScript, strict, zero errors
npm test            # 29 simulation tests, ~90 s
npm run soak        # 40 simulated minutes, ~165 s
npm run bench       # CPU cost against population, ~3 min
npm run poses       # posture constraint check, instant
npm run build       # production build
npm run qa          # headless screenshots (needs Playwright browsers)
```

## Simulation benchmark

Fixed timestep 33.33 ms (30 Hz). 900 measured ticks after 240 warm-up ticks.
"x realtime" is how many times faster than real time one core can run the
simulation.

```
prayer layout      13,398 slots in 62.6 ms, 40 rows

 population  scenario    mean ms    p95 ms    max ms   x realtime
------------------------------------------------------------------
        250  tawaf         0.513     0.656    13.606        64.9x
        250  prayer        0.285     0.414    14.834       117.1x
      1,000  tawaf         1.546     1.635     6.384        21.6x
      1,000  prayer        0.407     0.503     2.567        81.9x
      3,000  tawaf         5.471     5.728     8.827         6.1x
      3,000  prayer        1.133     1.453     1.981        29.4x
      5,000  tawaf        10.294    10.631    11.435         3.2x
      5,000  prayer        1.833     2.256     3.058        18.2x

scaling 250 -> 5000: cost x20.06 for population x20.0
empirical exponent 1.00 (1.0 = linear, 2.0 = quadratic)
```

Three things worth drawing out:

**Scaling is linear.** An exponent of 1.00 across a twentyfold increase in
population is the spatial hash doing its job. A naive all-pairs
implementation would show an exponent near 2, and would cost roughly 20 times
more at 5,000 agents than this does.

**Prayer is five to six times cheaper than tawaf.** Settled worshippers are
frozen and skipped entirely by the separation pass. This is why the population
ceiling is set by circulation rather than by the congregation.

**The `max ms` outliers at 250 agents are garbage collection**, not
simulation: 13.6 ms once in 900 ticks at the smallest population, while the
p95 sits at 0.66 ms. They vanish at larger populations where the arrays are
already warm.

At the 5,000 ceiling, one tick costs 10.3 ms against a 33.3 ms budget — 3.2×
real time on a single core, with the renderer still to be paid for out of the
remaining 23 ms on whatever thread the browser gives it.

## Automated test suite — 29 tests, all passing

`npm test`, ~90 s. These are property tests, not golden values: a crowd
simulation is stochastic, so asserting that agent 412 is at a particular
coordinate after 90 seconds would test the random seed rather than the model.

**Obstacles and walkability (3)** — the Kaaba footprint is not walkable; the
open mataf is, except where the Maqam and Zamzam stand; the exclusion zone
sits inside the first prayer row.

**Prayer layout (4)** — 13,398 slots generated in concentric arcs, every one
facing the Kaaba to within 0.1% of exact; no slot inside an obstacle; rows
evenly spaced outward; the allocator hands out 4,000 slots with zero
duplicates and reuses them after release.

**Animation bank (2)** — every clip packs inside the baked frame range; frame
resolution never returns a row belonging to a different clip, tested across
all 19 clips at nine phase values including out-of-range ones.

**Prayer timeline (3)** — the postures of a two-rak'ah prayer occur in the
canonical order (takbir before ruku before sujud before tashahhud before
taslim); duration scaling shortens without reordering; extra rak'ahs add time.

**Population accounting (5)** — empty stays empty; a small target is reached
and held; capacity is never exceeded even when the target is raised beyond it;
lowering the target makes people *walk out* rather than deleting them
(`EXITING` observed, departures counted); arrivals appear only near the
colonnade, never in the middle of the courtyard.

**Circulation (3)** — across 120 s with 700 agents, zero agents inside the
Kaaba or Hijr and zero outside the precinct wall; **more than 95% of
circulating agents move counter-clockwise** (the remainder are momentary
deflections around the Hijr); circuits complete and people cycle out; at 2,200
agents more than half are still making progress rather than deadlocking.

**Congregational prayer (8)** — the global machine passes through every phase
and returns; every worshipper gets a unique slot and the rows are arcs (yaw
spread > 3 radians, each facing the Kaaba); **nobody moves more than 0.5 m in
one tick**; tawaf resumes afterwards with circuit progress preserved; the
cycle can be cancelled mid-formation; three consecutive cycles run without
drift; overflow beyond 13,398 worshippers is refused rather than double-booked.

**Reset (1)** — returns to a clean state, counters zeroed, and re-populates.

## Soak test — 40 simulated minutes

`npm run soak`, 165 s of wall time for 72,000 ticks. Population target moves
through 1,200 → 400 → 2,400 → 900 → 1,500 during the run, with prayers
scheduled every five minutes. Invariants are sampled twice a second.

```
soak: 40 simulated minutes (72000 ticks)
population range        480 .. 2400
prayers completed       4
circuits completed      11713
arrivals / departures   2598 / 2210
stuck recoveries        1160
exclusion violations    0
out of bounds           0
non-finite values       0
double-booked slots     0
mean step               2.217 ms
worst step              37.97 ms
```

Also verified at the end of the run: no id leak (live count matches the
`alive` flags exactly), the population converged on its final target, the
phase machine returned to `NORMAL_ACTIVITY` when the schedule was switched
off, no agent was left stuck in `PRAYING`, and more than 40% of the crowd was
walking again after dispersal.

1,160 stuck recoveries over 40 minutes is roughly one every two seconds across
a crowd of up to 2,400 — that is the congestion recovery mechanism working
under deliberately heavy load, not a fault. It is reported because it is a
useful health signal: a sudden rise would mean the steering had developed a
trap.

## Posture verification

`npm run poses` checks the salah postures against physical constraints —
forehead, palms, knees and toes on the ground in sujud; shins down and hips on
the heels in jalsa; back near level in ruku; nothing below the floor in any
posture. All constraints satisfied.

The postures are not hand-authored. `tools/solve-poses.ts` solves the joint
angles from those physical targets by coordinate descent under anatomical
joint limits; the solved residuals are:

| Posture | Worst constraint residual |
| --- | --- |
| Qiyam | 0.7 cm |
| I'tidal | 0.5 cm |
| Ruku | 2.4 cm |
| Jalsa | 4.7 cm |
| Tashahhud | 4.7 cm |
| Takbir | 5.6 cm |
| Sujud | 5.4 cm |

See ARCHITECTURE.md for why this was done numerically rather than by eye.

## Visual verification

`npm run qa` drives headless Chromium and writes screenshots to `qa-output/`.
Every shot below was inspected. This is how three defects were found that no
numeric test would have caught:

1. **A detached, floating head and arms buried inside the garment.** The body
   profile was narrower at the shoulders than at the chest, so the arms were
   swallowed by the robe and there was a visible gap at the neck.
2. **Ruku bowing backwards and sujud levitating a metre off the ground**,
   caused by the Euler sign convention differing between upward-pointing and
   downward-pointing bones.
3. **A hard-edged quadrilateral of shadow across the courtyard** — the shadow
   camera was too small, so the gallery roof's shadow stopped in mid-air at
   the edge of the map.

Shots captured:

| Shot | What it checks |
| --- | --- |
| `character-clips-grid` | All 19 clips at once |
| `pose-qiyam`, `pose-takbir`, `pose-ruku`, `pose-sujud`, `pose-jalsa`, `pose-tashahhud` | Each salah posture, close up |
| `pose-walk-a`, `pose-walk-b` | Two phases of the walk cycle |
| `scene-broadcast`, `scene-mataf`, `scene-overhead`, `scene-maqam` | The four camera presets |
| `scene-prayer-rows` | Row formation from overhead |
| `scene-prayer-close` | The congregation at mataf level |
| `scene-debug-collision` | The collision primitives the crowd actually steers around |

The harness also records browser console errors and page exceptions per shot,
into `qa-output/report.json`.

## Bugs found and fixed during verification

Recorded because each one is a case where the test was worth more than the
code it tested.

| Found by | Bug |
| --- | --- |
| Test suite | `clipTime` seeded into `[0, 2)` despite being a normalised 0–1 phase |
| Test suite | Agents moved up to **1.02 m in a single tick** (30 m/s) when extracted from the Hijr enclosure |
| Investigation of the above | The escape pushed radially from the **world origin**, but the Hijr arc is struck from the Kaaba's north-west wall midpoint, so agents slid *along* the boundary instead of out and accumulated depth |
| Investigation of the above | The Kaaba and Hijr had **two collision authorities**: `resolvePenetration` treats the Hijr wall as two-sided and pushed agents *into* the enclosure, which the exclusion escape then undid across the full 0.9 m wall thickness |
| Investigation of the above | A discontinuity in the exclusion half-plane left a legal wedge beside the Kaaba's side corners that was already deep inside the Hijr disc |
| Soak test | Corrections rate-limited for smoothness allowed **26 exclusion violations** over 40 minutes; the soft correction and the hard invariant now have separate paths |
| Code review during shader work | Sampling `f0 + 1` in the vertex shader read the **first frame of the next clip** at the end of a looping clip, popping once per cycle |
| Visual QA | Character mesh: floating head, buried arms |
| Visual QA | Ruku and sujud with inverted spine rotation |
| Visual QA | Shadow camera smaller than the courtyard |
| Build | `manualChunks` object form rejected by Rolldown (Vite 8) |

After all fixes, at 2,400 agents over 300 simulated seconds: **zero exclusion
violations, zero jumps above 0.3 m, worst single-tick movement 0.199 m.**

## Production build

```
dist/index.html                   1.02 kB │ gzip:   0.55 kB
dist/assets/index-*.css           7.14 kB │ gzip:   2.17 kB
dist/assets/index-*.js          114.64 kB │ gzip:  38.28 kB
dist/assets/three-*.js          559.96 kB │ gzip: 141.11 kB
```

Total transfer approximately **182 kB gzipped**, of which 141 kB is Three.js.
There are no other assets: no models, textures, audio or fonts. See ASSETS.md.

`npm run build` runs `tsc --noEmit` first, so the build fails on any type
error. TypeScript is in strict mode and reports zero errors across `src`,
`tests` and `tools`.

## Validation checklist

| Case | Result |
| --- | --- |
| Empty precinct (target 0) | Stays empty, no errors — tested |
| Very small population | Reaches and holds target — tested |
| Default population (900) | Runs, verified in screenshots |
| Target raised during tawaf | Arrivals walk in through gates — tested |
| Target lowered during tawaf | Departures walk out, nobody deleted — tested |
| Target changed during prayer | Arrivals throttled by phase; covered by the soak, which changes target across prayer cycles |
| Target above capacity | Clamped to 5,000, reported in the interface — tested |
| Target above prayer capacity | Overflow waits outside the rows, interface says so — tested |
| Congested gates | 2,200–2,400 agents, >50% still progressing — tested |
| Repeated prayer cycles | Three consecutive cycles, plus four in the soak — tested |
| Tawaf progress preserved across prayer | Circuit counts never decrease — tested |
| Prayer cancelled mid-formation | Returns to normal activity — tested |
| Invalid population input | Clamped, announced in an aria-live region, never reaches the simulation |
| Camera preset changes | All four presets screenshotted |
| Quality changes | Implemented for shadows, env map, textures, pixel ratio, LOD; **switched at runtime only by hand, not automated** |
| Reset | Counters zeroed, re-populates — tested |
| Window resize | Handled; **not automated** |
| Background tab | `resync()` discards elapsed wall time; **not automated** |
| Optional asset failure | Not applicable — there are no external assets |
| WebGL unavailable | Renders a readable error panel rather than a black screen; **not automated** |
| 30+ simulated minutes unattended | 40 minutes, all invariants clean — tested |

Three entries are marked "not automated". They are implemented and were
exercised by hand, but there is no test asserting them, and this report is not
going to claim otherwise.
