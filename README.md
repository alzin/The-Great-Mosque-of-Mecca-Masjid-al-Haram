# Masjid al-Haram — central precinct

A real-time 3D simulation of the central area of Masjid al-Haram: an
agent-based crowd performing tawaf around the Kaaba, entering and leaving
through the gates, and forming curved concentric rows for congregational
prayer.

**This is a simulation, not a live feed and not a recording.** Nothing here
is a broadcast, a photograph, or a measured survey of the real building. The
dimensions are a reconstruction assembled from published figures; the crowd is
a model; the people are procedurally generated and represent nobody. The
interface says so, permanently, in the corner of the screen.

## Running it

Requires Node 20 or newer and a browser with WebGL 2.

```bash
npm install
npm run dev        # development server, http://127.0.0.1:5173
npm run build      # type-check and produce dist/
npm run preview    # serve the production build, http://127.0.0.1:4173
```

No API keys, no backend, no network access at run time. `npm install` is the
only thing that touches the network.

Other scripts:

```bash
npm run typecheck  # tsc --noEmit
npm test           # simulation test suite (~90 s)
npm run soak       # 40 simulated minutes of unattended running (~10 min)
npm run bench      # CPU cost against population
npm run poses      # verify the salah postures against physical constraints
npm run solve      # re-solve the postures (development tool)
npm run qa         # headless screenshots into qa-output/ (needs Playwright browsers)
```

## Controls

Drag to orbit, scroll to dolly. Everything is reachable from the keyboard.

| Key | Action |
| --- | --- |
| `Space` | Pause / resume |
| `1` – `4` | Camera presets |
| `←` `→` `↑` `↓` | Orbit |
| `+` / `−` | Dolly in and out |
| `C` | Cinematic drift |
| `P` | Call to prayer |
| `M` | Audio on / off |
| `G` | Diagnostics panel |
| `R` | Reset |
| `?` | Key list |

**Population** has both a number field and a slider. Changing the target never
makes anyone appear or vanish in place: arrivals walk in through the gates and
departures walk out. The readout distinguishes the number currently in the
precinct, the target, and the number waiting to enter.

**Congregational prayer** can be called manually or repeated on a timer. Adhan,
iqamah and the start of the prayer are separate events. Pace and the number of
rak'ahs are adjustable.

**Collision view** (under Display) draws the simplified primitives the crowd
actually steers around, rather than the rendered architecture. This is the only
place capsules appear.

## Capacity

| | |
| --- | --- |
| Maximum population | **5,000** |
| Prayer layout capacity | **13,398** slots in 40 rows |
| Simulation rate | Fixed 30 Hz with render interpolation |

Above 5,000 the limit is the CPU simulation, not the renderer. At 5,000 agents
one tick costs about 10.6 ms on a single core, which is 3.1× real time —
comfortable, but the margin narrows quickly beyond that. If the target exceeds
the prayer capacity the surplus waits outside the rows rather than being
double-booked; the interface says so.

See TEST-REPORT.md for measurements.

## Quality settings

| | Low | Medium | High |
| --- | --- | --- | --- |
| Shadows | off | 1024 | 2048 |
| Environment map | off | on | on |
| Texture size | 128 | 256 | 512 |
| Pixel ratio cap | 1.0 | 1.5 | 2.0 |
| LOD 0 / LOD 1 distance | 14 / 40 m | 24 / 62 m | 36 / 92 m |
| Contact shadows | off | on | on |

## What this gets right

- Tawaf is counter-clockwise, starts and ends at the line of Hajar al-Aswad,
  and passes outside the Hijr Ismail.
- Prayer rows are curved concentric arcs facing the Kaaba, filled from the
  inside out, with every worshipper on a unique reachable slot.
- The salah posture sequence is complete and in order: takbirat al-ihram,
  qiyam, ruku, i'tidal, sujud, jalsa, sujud, the following rak'ah, tashahhud,
  and taslim to the right then the left.
- Nobody teleports. Arrivals and departures use the gates. Tawaf progress
  survives an interruption for prayer.
- Walk animation rate is driven by ground speed, so there is no foot sliding.
- Crowd speeds near the Kaaba fall to a fraction of free-flow speed because of
  density, which is what is observed in reality — it is not imposed.

## Limitations

Read this section before drawing any conclusion from what you see.

**It is a reconstruction, not a survey.** Dimensions come from published
figures that disagree with one another, particularly for the Hijr Ismail and
for the post-2016 mataf. The gallery arcades are plausible massing at the
correct radii, not the real arcades. Six minarets are modelled out of thirteen.
Do not use this for anything that needs real measurements.

**No sacred text is reproduced.** The kiswah's Qur'anic calligraphy and the
inscription friezes are deliberately absent, and rendered as abstract gold
relief instead. See ASSETS.md.

**No adhan or recitation.** The optional audio is filtered noise standing in
for a crowd in a stone courtyard, muted by default. There is no synthesised
call to prayer and no recitation of any kind.

**The crowd model is a model.** Social forces with a density–speed coupling
reproduce plausible aggregate flow. They are not validated against measured
trajectories from the real mataf, and no claim is made about predictive
accuracy for crowd safety purposes. **Do not use this for crowd safety
planning.**

**Religious simplifications.** All worshippers perform the same posture
sequence at the same pace, with only a small per-person delay. Differences
between schools of jurisprudence — hand position in qiyam, the sitting posture
in the final tashahhud — are not represented. Nobody prays individually,
arrives mid-prayer and catches up a missed rak'ah, or is seated. No
distinction is made between ihram and everyday dress beyond garment colour,
and the two-cloth ihram garment itself is not modelled as two cloths.

**The crowd casts no shadow-map shadows,** only cheap contact shadows. See
ARCHITECTURE.md for why.

**Cloth does not simulate.** The kiswah is rigid geometry and garments are
skinned to the body. In prostration the robe reads as an arch rather than
draping.

**The prayer clock is a demonstration,** not a prayer-time calculator. It does
not know where the sun is.

**Faces are not modelled.** At the intended camera distances a head is a few
pixels. Close inspection in the mataf-level camera will show that.

**Frame rate was not measured.** The development environment has no GPU. CPU
simulation cost, draw calls, triangle counts and bake times are real
measurements; frame rate is not, and TEST-REPORT.md says so rather than
inventing a number.

## Documentation

- **ARCHITECTURE.md** — how it works and why each trade-off was made
- **ASSETS.md** — asset and licence manifest, and what is deliberately absent
- **TEST-REPORT.md** — measurements, what was verified, and what was not
