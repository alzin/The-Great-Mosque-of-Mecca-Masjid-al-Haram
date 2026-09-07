# Architecture

This describes how the pieces fit together and, more usefully, *why* each one
is built the way it is. Most of the decisions here are trade-offs, and the
trade-off is the interesting part.

```
                       ┌──────────────┐
                       │   main.ts    │  fixed-step loop, wiring
                       └──────┬───────┘
          ┌───────────────────┼────────────────────┐
          │                   │                    │
    ┌─────▼─────┐      ┌──────▼──────┐      ┌──────▼──────┐
    │    sim    │      │ characters  │      │  env/camera │
    │           │      │             │      │  audio/ui   │
    │ Crowd     │─────▶│ Animation   │      │ Environment │
    │ Prayer    │      │  Director   │      │ CameraSystem│
    │  Orches.  │      │ CrowdView   │─────▶│ AudioSystem │
    │ SpatialH. │      │ CrowdRender │      │ UI          │
    │ Obstacles │      │ VAT bake    │      │ DebugCollis.│
    │ PrayerLay.│      │ Rig/Mesh    │      └─────────────┘
    └───────────┘      └─────────────┘
      no THREE           THREE only in
      import at all      the renderer
```

The `sim` layer imports nothing from Three.js. That is not tidiness for its
own sake: it is what lets the entire simulation run headless in Node, which is
how the test suite, the soak test and the benchmark work at all. A crowd
simulation you can only exercise through a browser is a crowd simulation you
cannot really test.

## The loop

`core/Clock.ts` runs a fixed timestep of 1/30 s with render interpolation.

**Why fixed.** Steering, collision response and row formation are iterative.
With a variable timestep, agents on a slow machine take longer steps, tunnel
through each other, and produce different behaviour from the same code on a
fast machine. Fixing the step makes the simulation reproducible and stable
independent of display rate.

**Why interpolate.** At 30 Hz on a 60 Hz display, rendering raw simulation
state shows each position twice, which reads as judder. `alpha` — the fraction
of the way to the next tick — is passed to `CrowdView`, which interpolates
position and heading (the heading through the shortest arc, so an agent
crossing ±π does not spin the long way round).

**Spiral of death.** If simulation cost exceeds real time, catching up
completely would never finish. `maxTicksPerFrame` caps the work and the clock
discards the backlog, reporting the dropped ticks so the diagnostics panel can
say the simulation is running behind rather than quietly lying about it.

**Background tabs.** A hidden tab stops receiving animation frames. On return,
the elapsed wall time can be minutes. `resync()` throws it away instead of
simulating it, so the tab resumes rather than fast-forwarding.

## Crowd simulation

`sim/Crowd.ts` is a structure of arrays — one typed array per attribute rather
than one object per agent. With five thousand agents this matters: the inner
loops touch positions and velocities repeatedly, and a flat `Float32Array` is
cache-friendly in a way that five thousand heap objects are not. Ids are
allocated from a free list and recycled, with a `generation` counter so that
anything comparing an agent against its own past can tell "the same person one
tick later" from "a different person who inherited the id".

**Neighbour queries.** `sim/SpatialHash.ts` is a uniform grid rebuilt every
tick with a counting sort, allocation-free. Steering only ever consults agents
in nearby cells. The benchmark confirms the result: cost scales with an
empirical exponent of 0.99 from 250 to 5,000 agents — linear, not quadratic.

**Steering** is a social-force model with anisotropy (people react more
strongly to what is in front of them), a density-dependent speed reduction,
and preferred-radius drift so nobody traces the same circle twice. Speeds come
from four cohorts with means from 0.68 to 1.02 m/s. The much lower speeds
observed near the Kaaba wall are *not* imposed; they emerge from the density
coupling.

**Tawaf direction.** Counter-clockwise seen from above. In this coordinate
frame that is a decreasing `atan2(z, x)`, and the tangent at a point `p` is
`normalize(p.z, -p.x)`. Circuits are counted by accumulating the negative
bearing delta while in `PERFORMING_TAWAF`, with a clamp that rejects
single-tick jumps larger than 0.35 rad so a numerical glitch cannot award a
circuit.

**Render vs collision geometry.** `sim/Obstacles.ts` holds the only geometry
the simulation ever sees: boxes, circles and thick arcs, each exposing a
signed distance and an outward gradient. The rendered architecture in `env/`
has mouldings, bevels, capitals and arches that the crowd knows nothing about.
This is what makes it safe to make the visuals more elaborate — a new bevel
cannot trap an agent. The two are kept honest by construction (the Hijr's
render geometry reads its centre and normal from the collision model, so they
cannot drift apart) and by the collision debug view, which draws the
simulation's world rather than the rendered one.

**Corrections are rate-limited.** When the crowd squeezes someone into an
obstacle, the geometric solve can legitimately want to move them a metre.
Applying that in one tick is a 30 m/s teleport — more conspicuous than the
overlap it fixes. Corrections are clamped to what a person could walk in a
tick, and the inward velocity component is cancelled so they do not push
straight back in. This was found by a test asserting that no agent ever moves
more than half a metre in one tick.

## Prayer

Two cooperating pieces.

`sim/PrayerLayout.ts` generates the slots once at start-up: **13,398 slots in
40 concentric rows**, each facing the Kaaba centre, spaced 1.28 m radially (room
for prostration) and 0.62 m along the row. Slots are validated against the
obstacle set at generation time, so a slot is never inside the Maqam or the
Hijr. Radial service aisles are kept clear.

Rows are *arcs*, not a grid. This is the geometrically correct thing — everyone
faces a single point, so lines of equal distance from that point are circles —
and it is also visually the single most recognisable feature of prayer at the
Haram.

`SlotAllocator` hands out unique slots. Two mechanisms keep it sensible:
angular buckets so a worshipper is placed near where they already are, and a
"fill frontier" so rows fill from the inside out and a small congregation
compresses into the front rows instead of scattering across forty rows. The
test suite asserts uniqueness under a full allocation of all 13,398 slots.

`sim/PrayerOrchestrator.ts` owns the global phase machine —
`NORMAL_ACTIVITY → PREPARATION → ROW_FORMATION → PRAYER → POST_PRAYER →
NORMAL_ACTIVITY` — and the posture timeline. Adhan, iqamah and the start of
the prayer are three separate events: the adhan begins preparation (a gradual
pull toward the prayer area, ramped over the interval rather than switched
on), the iqamah triggers row formation, and the prayer starts when 85% of the
congregation is settled or a timeout expires, whichever comes first.

**This is a demonstration clock, not a prayer-time calculator.** It does not
know where the sun is.

Three details that took real work:

- *Packing.* The social-force comfort radius is 0.62 m, exactly the row
  spacing, so worshippers pushed each other out of their own slots and row
  formation stalled at 72%. Within 3 m of an assigned slot the repulsion is
  graded down and a tighter hard separation of 0.42 m takes over.
- *Final approach.* The density-based speed cap throttled people to a crawl in
  the last metre. Inside 0.8 m the approach becomes committed and kinematic,
  rate-limited to 0.7 m/s, settling below 0.06 m. Settled agents are frozen
  and skipped by the relaxation pass entirely, which is also why the prayer
  phase benchmarks about six times cheaper than tawaf.
- *Latecomers.* `beginPrayer` only converts agents that have actually settled.
  Anyone still walking joins the prayer in progress through
  `joinPrayerInProgress`. This matches practice, and it removes the need to
  make everyone wait for the slowest person.

Tawaf progress survives the interruption: the bearing at which each agent was
interrupted is recorded, and after the taslim they rise in a stagger and walk
back to it. Circuit counts are not reset.

## Characters

This is where the "recognisable animated humans, not capsules" requirement
collides with "five thousand of them".

**The problem.** `THREE.SkinnedMesh` animates one skeleton.
`THREE.InstancedMesh` draws one geometry many times but shares all vertex
data, so every instance strikes the same pose. Neither alone gives a courtyard
full of people each at a different point in a different action.

**The approach: vertex animation textures.** Linear-blend skinning is
evaluated on the CPU at start-up for all 19 clips and baked into a float
texture, one column per vertex and one row per frame. At draw time a posed
vertex is a texture fetch rather than a bone computation, so a person becomes
one instance carrying a handful of floats: where they are, which way they
face, how tall they are, and which frames of which clips they are between.

Cost is four vertex texture fetches: two frames of the current clip, lerped so
the animation is smooth at any playback rate; one frame of the clip being
blended out of; and one normal.

One subtlety worth recording, because it was a real bug: clips are packed end
to end in a single texture, so the frame after the last frame of a looping
clip is the *first frame of the next clip*. Computing `f0 + 1` in the shader
therefore produced a one-frame pop on every cycle. Both frames are now
resolved on the CPU, per clip, and passed explicitly. `tests/simulation.test.ts`
asserts that no clip can ever resolve to a row belonging to another.

**Foot sliding** is prevented by deriving playback rate from ground speed:

```
cycles per second = speed / (strideFraction × bodyHeight)
```

`strideFraction` is a property of the baked clip — the ground distance one
full two-step cycle covers, as a fraction of body height. Somebody at 0.3 m/s
shuffles, somebody at 1.3 m/s strides, and neither skates.

**The postures were solved, not authored.** The salah postures were first
written by hand from anatomical reasoning, and they were wrong in a way that
is easy to make and hard to see: a positive X rotation tilts an *upward*
pointing bone (the spine chain) forward, but swings a *downward* pointing bone
(arms, legs) backward. Signs that looked consistent on the page produced a
ruku that bowed backwards and a sujud that levitated a metre off the ground.

Angles are the wrong thing to author by hand anyway. What is actually known
about these postures is where the *body* has to be: in sujud the forehead,
both palms, both knees and the toes are on the ground and the hips are raised;
in jalsa the shins are on the ground and the hips rest on the heels; in ruku
the back is near level and the hands reach the knees. `tools/solve-poses.ts`
states those positions and solves for the joint angles by coordinate descent,
with anatomical joint limits, a floor constraint so nothing goes through the
marble, and a weak pull toward neutral. The solved postures satisfy every
constraint to within a few centimetres and are committed to
`AnimationBank.ts`; no solver ships in the application.

`tools/pose-check.ts` re-verifies the constraints, and is the cheap check to
run after any change to the rig.

**LOD and culling** happen on the CPU in `CrowdView`, per agent, per frame:
sphere-versus-frustum, then a distance bucket with a cap on the highest level
so pushing the camera into the crowd cannot suddenly demand thousands of
high-detail bodies. Three LODs, one draw call each.

**The crowd does not cast shadow-map shadows.** Thousands of animated
instances in the shadow pass would roughly double the vertex cost, and at the
resolution a map covering a 148 m courtyard can afford, the resulting shadows
are a smear rather than a person. Instead each person gets an instanced blob
contact shadow: cheap, stable, and correct-looking at broadcast distance. The
architecture casts real shadows. This is a deliberate trade and it is listed
in the limitations.

## Environment

Everything is generated at run time — see ASSETS.md for the manifest and for
what is deliberately *not* generated.

Columns, capitals, bases and arches are `InstancedMesh`, so 212 columns cost
about what one column costs. Gate openings are made by omitting instances, not
by boolean geometry.

The lighting is mid-afternoon with the sun about 45° up in the west. This is
not arbitrary: much lower and the 34 m gallery roof throws the entire
courtyard into shade, which is accurate and useless to look at; much higher
and the Kaaba stops casting a shadow long enough to read. The shadow camera
covers the whole open courtyard, because a smaller one leaves a visible
straight edge across the marble where the roof's shadow simply stops in
mid-air — which is exactly what the first screenshot showed.

## Camera

A constrained orbit rather than a free-fly. Pitch, distance, height above the
floor and radial position are all clamped, so it is not possible to end up
inside the Kaaba, under the marble, or a kilometre away looking at nothing.
Every preset is a point on the same spherical shell, so switching is a move
rather than a cut, and the user can take over mid-transition without a
discontinuity. Presets choose the equivalent azimuth nearest the current one,
so a preset never spins the long way round.

## Interface

Plain DOM over the canvas. Every control is a real focusable element with a
label; the frequently used ones also have single-key shortcuts. The
"3D simulation — not a live feed" badge is not dismissible.

Population has both a number field and a slider, as required — the slider for
exploration, the field for a precise figure. Invalid input is clamped, the
clamp is announced in an `aria-live` region, and the raw value never reaches
the simulation.

The interface updates at 5 Hz, not once per frame. It has no need for 60 Hz
and the string formatting is not free.
