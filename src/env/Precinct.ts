/**
 * Precinct.ts — everything around the Kaaba: the marble courtyard, the
 * colonnaded galleries, the upper floors, the enclosing wall and the
 * minarets.
 *
 * MASSING, NOT SURVEY
 *   These are the correct number of column rings at the correct radii with
 *   plausible arcade proportions, not a measured reconstruction of the real
 *   arcades. Ornament is abstract: no attempt is made to reproduce the
 *   calligraphic friezes of the real building.
 *
 * DRAW CALL BUDGET
 *   The 212 columns, their capitals, bases and arches are drawn as a handful
 *   of `InstancedMesh` objects rather than 212 separate meshes, so the whole
 *   arcade costs roughly the same as one column. Openings for the gates are
 *   made by omitting instances, not by boolean geometry.
 */

import * as THREE from 'three';
import { GALLERY, GATES, MATAF, MINARETS, CORNERS } from '../config/site.ts';
import type { EnvMaterials } from './Materials.ts';

export interface PrecinctBuild {
  group: THREE.Group;
  /** Meshes whose instance counts are useful for the diagnostics panel. */
  instanceCounts: Record<string, number>;
}

/**
 * The mataf floor. A single radial disc, with the paving pattern carried by
 * the marble texture, plus two inlaid features that are genuinely there and
 * genuinely matter to the simulation:
 *   - the darker ring of the innermost circulation zone, and
 *   - the line of Hajar al-Aswad: the marked stripe running out from the
 *     Black Stone corner where each circuit begins and ends.
 */
export function buildCourtyard(mat: EnvMaterials): THREE.Group {
  const g = new THREE.Group();
  g.name = 'courtyard';

  const radial = 96;
  const rings = 24;

  const floorGeo = new THREE.RingGeometry(1.0, GALLERY.outerWallRadius, radial, rings);
  floorGeo.rotateX(-Math.PI / 2);
  // Radial UVs so the marble veining follows the circulation rather than
  // sitting in a square grid across a circular courtyard.
  applyPolarUv(floorGeo, GALLERY.outerWallRadius, 9);
  const floor = new THREE.Mesh(floorGeo, mat.marbleLight);
  floor.receiveShadow = true;
  floor.name = 'mataf-floor';
  g.add(floor);

  // Concentric banding: alternating tone every few metres, as the real paving
  // does, which also gives the eye a scale reference for the crowd.
  for (let i = 0; i < 7; i++) {
    const r = 14 + i * 7.2;
    const band = new THREE.Mesh(
      ringAt(r, 0.34, 128),
      i % 2 === 0 ? mat.marbleBand : mat.marbleDark,
    );
    band.position.y = 0.012;
    band.receiveShadow = false;
    g.add(band);
  }

  // Inner apron immediately around the Kaaba.
  const apron = new THREE.Mesh(ringAt(MATAF.innerRadius + 0.9, 1.6, 96), mat.marbleBand);
  apron.position.y = 0.014;
  g.add(apron);

  // --- The line of Hajar al-Aswad ------------------------------------------
  const lineLength = MATAF.outerRadius - MATAF.innerRadius;
  const lineGeo = new THREE.PlaneGeometry(lineLength, 0.75);
  lineGeo.rotateX(-Math.PI / 2);
  lineGeo.translate(MATAF.innerRadius + lineLength / 2, 0, 0);
  const line = new THREE.Mesh(lineGeo, mat.marbleDark);
  line.rotation.y = -MATAF.startLineBearing;
  line.position.y = 0.02;
  line.name = 'tawaf-start-line';
  g.add(line);

  // A brass strip down the centre of the stripe, as the marker actually has.
  const strip = new THREE.Mesh(
    (() => {
      const s = new THREE.PlaneGeometry(lineLength, 0.13);
      s.rotateX(-Math.PI / 2);
      s.translate(MATAF.innerRadius + lineLength / 2, 0, 0);
      return s;
    })(),
    mat.brass,
  );
  strip.rotation.y = -CORNERS.blackStone;
  strip.position.y = 0.024;
  g.add(strip);

  return g;
}

/** One flat annulus at a given radius, lying in the XZ plane. */
function ringAt(radius: number, width: number, segments: number): THREE.BufferGeometry {
  const geo = new THREE.RingGeometry(radius - width / 2, radius + width / 2, segments, 1);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/** Replace UVs with (radius, angle) so textures wrap around the courtyard. */
function applyPolarUv(geo: THREE.BufferGeometry, maxRadius: number, repeats: number): void {
  const pos = geo.getAttribute('position');
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, z);
    const a = Math.atan2(z, x);
    uv.setXY(i, (a / (Math.PI * 2)) * repeats * 4, (r / maxRadius) * repeats);
  }
  uv.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Galleries
// ---------------------------------------------------------------------------

/** True when a bearing falls inside one of the gate openings. */
function inGate(bearing: number, slack: number): boolean {
  for (const gate of GATES) {
    let d = bearing - gate.bearing;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    if (Math.abs(d) < gate.halfWidth + slack) return true;
  }
  return false;
}

export function buildGalleries(mat: EnvMaterials): PrecinctBuild {
  const group = new THREE.Group();
  group.name = 'galleries';
  const counts: Record<string, number> = {};

  const shaftGeo = new THREE.CylinderGeometry(
    GALLERY.columnRadius,
    GALLERY.columnRadius * 1.06,
    GALLERY.arcadeHeight,
    10,
  );
  shaftGeo.translate(0, GALLERY.arcadeHeight / 2, 0);

  const capGeo = new THREE.CylinderGeometry(
    GALLERY.columnRadius * 1.5,
    GALLERY.columnRadius * 1.02,
    0.7,
    10,
  );
  const baseGeo = new THREE.CylinderGeometry(
    GALLERY.columnRadius * 1.25,
    GALLERY.columnRadius * 1.4,
    0.35,
    10,
  );

  // Count the instances we will actually place, per floor level.
  const placements: Array<{ x: number; z: number; y: number; a: number }> = [];
  const archPlacements: Array<{ x: number; z: number; y: number; a: number; span: number }> = [];

  for (let level = 0; level < GALLERY.floorLevels.length; level++) {
    const y = GALLERY.floorLevels[level];
    for (let ring = 0; ring < GALLERY.columnRings.length; ring++) {
      const radius = GALLERY.columnRings[ring];
      const n = GALLERY.columnsPerRing[ring];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        // The innermost ring is broken by the gate openings on the ground
        // floor; upper floors run continuously above them.
        if (ring === 0 && level === 0 && inGate(a, 0.012)) continue;
        const x = Math.cos(a) * radius;
        const z = Math.sin(a) * radius;
        placements.push({ x, z, y, a });

        if (ring === 0 && level === 0) {
          const next = ((i + 1) / n) * Math.PI * 2;
          if (!inGate(next, 0.012)) {
            const mid = (a + next) / 2;
            const span = 2 * radius * Math.sin((next - a) / 2);
            archPlacements.push({
              x: Math.cos(mid) * radius,
              z: Math.sin(mid) * radius,
              y,
              a: mid,
              span,
            });
          }
        }
      }
    }
  }

  const dummy = new THREE.Object3D();

  const shafts = new THREE.InstancedMesh(shaftGeo, mat.stone, placements.length);
  const caps = new THREE.InstancedMesh(capGeo, mat.stoneWarm, placements.length);
  const bases = new THREE.InstancedMesh(baseGeo, mat.stoneWarm, placements.length);
  for (const m of [shafts, caps, bases]) {
    m.castShadow = true;
    m.receiveShadow = true;
    m.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  }

  placements.forEach((p, i) => {
    dummy.position.set(p.x, p.y, p.z);
    dummy.rotation.set(0, -p.a, 0);
    dummy.updateMatrix();
    shafts.setMatrixAt(i, dummy.matrix);

    dummy.position.set(p.x, p.y + GALLERY.arcadeHeight + 0.35, p.z);
    dummy.updateMatrix();
    caps.setMatrixAt(i, dummy.matrix);

    dummy.position.set(p.x, p.y + 0.175, p.z);
    dummy.updateMatrix();
    bases.setMatrixAt(i, dummy.matrix);
  });
  shafts.instanceMatrix.needsUpdate = true;
  caps.instanceMatrix.needsUpdate = true;
  bases.instanceMatrix.needsUpdate = true;
  shafts.name = 'gallery-columns';
  group.add(shafts, caps, bases);
  counts.columns = placements.length;

  // --- Arches spanning the innermost colonnade -----------------------------
  if (archPlacements.length > 0) {
    const archGeo = buildArchGeometry(archPlacements[0].span, GALLERY.archRise, 0.85);
    const arches = new THREE.InstancedMesh(archGeo, mat.stoneWarm, archPlacements.length);
    arches.castShadow = true;
    arches.receiveShadow = true;
    archPlacements.forEach((p, i) => {
      dummy.position.set(p.x, p.y + GALLERY.arcadeHeight + 0.7, p.z);
      dummy.rotation.set(0, -p.a, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      arches.setMatrixAt(i, dummy.matrix);
    });
    arches.instanceMatrix.needsUpdate = true;
    arches.name = 'gallery-arches';
    group.add(arches);
    counts.arches = archPlacements.length;
  }

  // --- Floor slabs and parapets -------------------------------------------
  for (let level = 1; level < GALLERY.floorLevels.length; level++) {
    const y = GALLERY.floorLevels[level];
    const slab = new THREE.Mesh(
      thickRing(GALLERY.columnRings[0] - 1.6, GALLERY.outerWallRadius, 0.9, 128),
      mat.stone,
    );
    slab.position.y = y - 0.9;
    slab.castShadow = true;
    slab.receiveShadow = true;
    group.add(slab);

    const parapet = new THREE.Mesh(
      thickRing(
        GALLERY.columnRings[0] - 1.6,
        GALLERY.columnRings[0] - 1.1,
        GALLERY.parapetHeight,
        128,
      ),
      mat.marbleBand,
    );
    parapet.position.y = y;
    parapet.castShadow = true;
    parapet.receiveShadow = true;
    group.add(parapet);
  }

  // Roof over the top gallery.
  const roofY = GALLERY.floorLevels[GALLERY.floorLevels.length - 1] + GALLERY.arcadeHeight + 1.4;
  const roof = new THREE.Mesh(
    thickRing(GALLERY.columnRings[0] - 1.6, GALLERY.outerWallRadius, 1.2, 128),
    mat.stone,
  );
  roof.position.y = roofY;
  roof.castShadow = true;
  roof.receiveShadow = true;
  group.add(roof);

  // --- Outer wall -----------------------------------------------------------
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(
      GALLERY.outerWallRadius,
      GALLERY.outerWallRadius,
      GALLERY.outerWallHeight,
      96,
      1,
      true,
    ),
    mat.stone,
  );
  wall.position.y = GALLERY.outerWallHeight / 2;
  wall.material.side = THREE.DoubleSide;
  wall.receiveShadow = true;
  wall.name = 'outer-wall';
  group.add(wall);

  const crenel = new THREE.Mesh(
    thickRing(GALLERY.outerWallRadius - 0.6, GALLERY.outerWallRadius + 0.6, 1.6, 96),
    mat.stoneWarm,
  );
  crenel.position.y = GALLERY.outerWallHeight;
  crenel.castShadow = true;
  group.add(crenel);

  counts.gates = GATES.length;
  return { group, instanceCounts: counts };
}

/** A closed ring with thickness in Y, i.e. an annular slab. */
function thickRing(
  inner: number,
  outer: number,
  height: number,
  segments: number,
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outer, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, inner, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false,
    curveSegments: segments / 4,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, height, 0);
  return geo;
}

/**
 * A single pointed arch spanning two columns, built as an extruded profile.
 * The local frame has the span along Z and the depth along X, matching how
 * the instances are oriented around the ring.
 */
function buildArchGeometry(span: number, rise: number, depth: number): THREE.BufferGeometry {
  const half = span / 2;
  const shape = new THREE.Shape();
  const steps = 14;

  // Outer profile: two circular arcs meeting in a point (a two-centred arch).
  const outer: Array<[number, number]> = [];
  const inner: Array<[number, number]> = [];
  const thickness = 0.62;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = -half + span * t;
    const y = Math.sqrt(Math.max(0, 1 - (x / half) ** 2)) * rise;
    const point = Math.max(0, 1 - Math.abs(x) / half) ** 3 * 0.55;
    outer.push([x, y + point + thickness]);
    inner.push([x, y + point]);
  }

  shape.moveTo(outer[0][0], 0);
  for (const [x, y] of outer) shape.lineTo(x, y);
  shape.lineTo(outer[outer.length - 1][0], 0);
  for (let i = inner.length - 1; i >= 0; i--) shape.lineTo(inner[i][0], inner[i][1]);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  geo.translate(0, 0, -depth / 2);
  // Extruded in XY with depth along Z; rotate so the span lies along Z.
  geo.rotateY(Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------
// Minarets
// ---------------------------------------------------------------------------

export function buildMinarets(mat: EnvMaterials): THREE.Group {
  const g = new THREE.Group();
  g.name = 'minarets';

  for (const spec of MINARETS) {
    const m = new THREE.Group();
    const h = spec.height;

    const plinth = new THREE.Mesh(new THREE.BoxGeometry(7.5, h * 0.16, 7.5), mat.stone);
    plinth.position.y = h * 0.08;
    plinth.castShadow = true;
    m.add(plinth);

    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(2.05, 2.75, h * 0.6, 8),
      mat.stoneWarm,
    );
    shaft.position.y = h * 0.16 + h * 0.3;
    shaft.castShadow = true;
    m.add(shaft);

    // Two balconies, as the Saudi-era minarets have.
    for (const f of [0.5, 0.72]) {
      const balcony = new THREE.Mesh(
        new THREE.CylinderGeometry(3.1, 3.1, 1.5, 12),
        mat.marbleBand,
      );
      balcony.position.y = h * f;
      balcony.castShadow = true;
      m.add(balcony);

      const rail = new THREE.Mesh(
        new THREE.CylinderGeometry(3.25, 3.25, 1.1, 12, 1, true),
        mat.stoneWarm,
      );
      rail.position.y = h * f + 1.3;
      m.add(rail);
    }

    const upper = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 2.05, h * 0.22, 8),
      mat.stoneWarm,
    );
    upper.position.y = h * 0.76 + h * 0.11;
    upper.castShadow = true;
    m.add(upper);

    const lantern = new THREE.Mesh(
      new THREE.CylinderGeometry(1.75, 1.75, h * 0.06, 8),
      mat.marbleLight,
    );
    lantern.position.y = h * 0.98;
    m.add(lantern);

    const cap = new THREE.Mesh(new THREE.ConeGeometry(1.85, h * 0.1, 8), mat.goldDark);
    cap.position.y = h * 1.05;
    cap.castShadow = true;
    m.add(cap);

    const finial = new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 6), mat.gold);
    finial.position.y = h * 1.11;
    m.add(finial);

    m.position.set(Math.cos(spec.bearing) * spec.radius, 0, Math.sin(spec.bearing) * spec.radius);
    m.rotation.y = -spec.bearing;
    g.add(m);
  }

  return g;
}
