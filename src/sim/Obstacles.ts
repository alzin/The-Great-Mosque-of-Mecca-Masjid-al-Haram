/**
 * Obstacles.ts — the simplified collision + navigation representation of the
 * environment. This is deliberately kept separate from the rendering geometry
 * in src/env: renderers may add mouldings, bevels and decoration, but the
 * simulation only ever sees the convex primitives declared here.
 *
 * Every obstacle exposes a signed distance in the XZ plane (negative inside)
 * plus an outward gradient, which is all the steering code needs.
 */

import { GALLERY, HIJR, KAABA, MAQAM, MATAF, ZAMZAM } from '../config/site.ts';

export const ObstacleKind = {
  Box: 0,
  Circle: 1,
  Arc: 2,
} as const;

export type ObstacleKind = (typeof ObstacleKind)[keyof typeof ObstacleKind];

export interface ObstacleBase {
  readonly kind: ObstacleKind;
  readonly name: string;
  /** Height in metres — used for reporting only, the sim is 2.5D. */
  readonly height: number;
  /** Bounding circle for broad-phase rejection. */
  readonly bx: number;
  readonly bz: number;
  readonly br: number;
}

export interface BoxObstacle extends ObstacleBase {
  readonly kind: typeof ObstacleKind.Box;
  readonly cx: number;
  readonly cz: number;
  readonly halfX: number;
  readonly halfZ: number;
  readonly cos: number;
  readonly sin: number;
}

export interface CircleObstacle extends ObstacleBase {
  readonly kind: typeof ObstacleKind.Circle;
  readonly cx: number;
  readonly cz: number;
  readonly r: number;
}

/** A thick circular arc — used for the Hijr Ismail wall. */
export interface ArcObstacle extends ObstacleBase {
  readonly kind: typeof ObstacleKind.Arc;
  readonly cx: number;
  readonly cz: number;
  readonly radius: number;
  readonly halfThickness: number;
  /** Arc spans [startAngle, endAngle] measured with atan2(z - cz, x - cx). */
  readonly startAngle: number;
  readonly endAngle: number;
}

export type Obstacle = BoxObstacle | CircleObstacle | ArcObstacle;

function makeBox(
  name: string,
  cx: number,
  cz: number,
  halfX: number,
  halfZ: number,
  yaw: number,
  height: number,
): BoxObstacle {
  return {
    kind: ObstacleKind.Box,
    name,
    cx,
    cz,
    halfX,
    halfZ,
    cos: Math.cos(yaw),
    sin: Math.sin(yaw),
    height,
    bx: cx,
    bz: cz,
    br: Math.hypot(halfX, halfZ),
  };
}

function makeCircle(name: string, cx: number, cz: number, r: number, height: number): CircleObstacle {
  return { kind: ObstacleKind.Circle, name, cx, cz, r, height, bx: cx, bz: cz, br: r };
}

function makeArc(
  name: string,
  cx: number,
  cz: number,
  radius: number,
  halfThickness: number,
  startAngle: number,
  endAngle: number,
  height: number,
): ArcObstacle {
  return {
    kind: ObstacleKind.Arc,
    name,
    cx,
    cz,
    radius,
    halfThickness,
    startAngle,
    endAngle,
    height,
    bx: cx,
    bz: cz,
    br: radius + halfThickness,
  };
}

/** Normalise an angle to (-pi, pi]. */
export function wrapAngle(a: number): number {
  let x = (a + Math.PI) % (Math.PI * 2);
  if (x < 0) x += Math.PI * 2;
  return x - Math.PI;
}

/**
 * The Hijr Ismail is centred on the midpoint of the Kaaba's NW wall. The NW
 * normal points from the Kaaba centre toward bearing (iraqi+shami)/2 = -pi
 * ... we compute it explicitly: the NW wall's outward normal bisects the
 * North and West corners, i.e. bearing = -3*pi/4 (north-west).
 */
export const HIJR_NORMAL = (-3 * Math.PI) / 4;

/** Centre of the Hijr arc in world XZ. */
export const HIJR_CENTRE = {
  x: Math.cos(HIJR_NORMAL) * (KAABA.lengthNW / 2 + HIJR.centreOffset),
  z: Math.sin(HIJR_NORMAL) * (KAABA.lengthNW / 2 + HIJR.centreOffset),
};

function buildObstacles(): Obstacle[] {
  const out: Obstacle[] = [];

  // --- The Kaaba itself (plus its shadharwan base as the effective footprint)
  out.push(
    makeBox(
      'Kaaba',
      0,
      0,
      KAABA.lengthNE / 2 + KAABA.baseProjection,
      KAABA.lengthNW / 2 + KAABA.baseProjection,
      KAABA.yaw,
      KAABA.height,
    ),
  );

  // --- Hijr Ismail: the semicircular wall, plus the enclosed area which is
  // excluded from tawaf. We model the enclosed area as a circle so agents
  // never cut through it, and the wall itself as a thick arc.
  const hijrArcStart = HIJR_NORMAL - HIJR.halfAngle;
  const hijrArcEnd = HIJR_NORMAL + HIJR.halfAngle;
  out.push(
    makeArc(
      'Hijr Ismail wall',
      HIJR_CENTRE.x,
      HIJR_CENTRE.z,
      HIJR.radius,
      HIJR.wallThickness / 2,
      hijrArcStart,
      hijrArcEnd,
      HIJR.wallHeight,
    ),
  );

  // --- Maqam Ibrahim: enclosure in front of the Kaaba door (NE face).
  const maqamBearing = Math.PI / 4; // NE normal, bisecting East and North... see note
  // The NE wall runs between the East (Black Stone) and North (Iraqi) corners,
  // so its outward normal bisects them at bearing -pi/4.
  const neNormal = -Math.PI / 4;
  void maqamBearing;
  out.push(
    makeCircle(
      'Maqam Ibrahim',
      Math.cos(neNormal) * MAQAM.distanceFromCentre - Math.sin(neNormal) * MAQAM.lateralOffset,
      Math.sin(neNormal) * MAQAM.distanceFromCentre + Math.cos(neNormal) * MAQAM.lateralOffset,
      MAQAM.baseRadius,
      MAQAM.totalHeight,
    ),
  );

  // --- Zamzam access kiosk
  out.push(
    makeCircle(
      'Zamzam access',
      Math.cos(ZAMZAM.bearing) * ZAMZAM.distanceFromCentre,
      Math.sin(ZAMZAM.bearing) * ZAMZAM.distanceFromCentre,
      ZAMZAM.radius,
      ZAMZAM.height,
    ),
  );

  // --- Gallery columns
  for (let ring = 0; ring < GALLERY.columnRings.length; ring++) {
    const r = GALLERY.columnRings[ring];
    const n = GALLERY.columnsPerRing[ring];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (ring % 2) * (Math.PI / n);
      out.push(
        makeCircle(
          `column-${ring}-${i}`,
          Math.cos(a) * r,
          Math.sin(a) * r,
          GALLERY.columnRadius,
          GALLERY.arcadeHeight,
        ),
      );
    }
  }

  return out;
}

export const OBSTACLES: readonly Obstacle[] = buildObstacles();

/** Obstacles inside the mataf proper — the ones tawaf must route around. */
/**
 * Obstacles used for the crowd's per-tick penetration resolution.
 *
 * The Kaaba and the Hijr wall are deliberately EXCLUDED, even though they are
 * squarely inside the mataf. Both are handled instead by
 * `escapeTawafExclusion`, and having two authorities for the same geometry was
 * an actual bug: `resolvePenetration` treats the Hijr wall as a two-sided
 * obstacle and pushes to whichever face is nearer, so an agent squeezed past
 * the wall's centreline was resolved INTO the enclosure — which the exclusion
 * escape then had to undo across the full 0.9 m wall thickness, as a visible
 * jump. The exclusion test knows that the enclosed area is out of bounds and
 * always resolves outward, so it is the only thing that should touch them.
 */
export const MATAF_OBSTACLES: readonly Obstacle[] = OBSTACLES.filter(
  (o) =>
    Math.hypot(o.bx, o.bz) + o.br < MATAF.outerRadius &&
    o.name !== 'Kaaba' &&
    o.name !== 'Hijr Ismail wall',
);

export interface SdfResult {
  /** Signed distance to the surface: negative inside the obstacle. */
  d: number;
  /** Outward unit gradient in XZ. */
  nx: number;
  nz: number;
}

const _sdf: SdfResult = { d: Infinity, nx: 0, nz: 0 };

/** Signed distance from a point to one obstacle. Reuses a module-local result. */
export function obstacleSdf(o: Obstacle, x: number, z: number): SdfResult {
  switch (o.kind) {
    case ObstacleKind.Circle: {
      const dx = x - o.cx;
      const dz = z - o.cz;
      const len = Math.hypot(dx, dz);
      _sdf.d = len - o.r;
      if (len > 1e-6) {
        _sdf.nx = dx / len;
        _sdf.nz = dz / len;
      } else {
        _sdf.nx = 1;
        _sdf.nz = 0;
      }
      return _sdf;
    }
    case ObstacleKind.Box: {
      // Transform into the box's local frame.
      const dx = x - o.cx;
      const dz = z - o.cz;
      const lx = dx * o.cos + dz * o.sin;
      const lz = -dx * o.sin + dz * o.cos;
      const qx = Math.abs(lx) - o.halfX;
      const qz = Math.abs(lz) - o.halfZ;
      const outX = Math.max(qx, 0);
      const outZ = Math.max(qz, 0);
      const outLen = Math.hypot(outX, outZ);
      const inside = Math.min(Math.max(qx, qz), 0);
      _sdf.d = outLen + inside;
      let gx: number;
      let gz: number;
      if (outLen > 1e-6) {
        gx = (outX / outLen) * Math.sign(lx || 1);
        gz = (outZ / outLen) * Math.sign(lz || 1);
      } else if (qx > qz) {
        gx = Math.sign(lx || 1);
        gz = 0;
      } else {
        gx = 0;
        gz = Math.sign(lz || 1);
      }
      // Back to world space.
      _sdf.nx = gx * o.cos - gz * o.sin;
      _sdf.nz = gx * o.sin + gz * o.cos;
      const gl = Math.hypot(_sdf.nx, _sdf.nz) || 1;
      _sdf.nx /= gl;
      _sdf.nz /= gl;
      return _sdf;
    }
    case ObstacleKind.Arc: {
      const dx = x - o.cx;
      const dz = z - o.cz;
      const len = Math.hypot(dx, dz);
      const ang = Math.atan2(dz, dx);
      // Angular clamp onto the arc span.
      const mid = (o.startAngle + o.endAngle) / 2;
      const half = (o.endAngle - o.startAngle) / 2;
      const rel = wrapAngle(ang - mid);
      if (Math.abs(rel) <= half) {
        // Radial band distance.
        const radial = Math.abs(len - o.radius) - o.halfThickness;
        _sdf.d = radial;
        const sign = len >= o.radius ? 1 : -1;
        if (len > 1e-6) {
          _sdf.nx = (dx / len) * sign;
          _sdf.nz = (dz / len) * sign;
        } else {
          _sdf.nx = 1;
          _sdf.nz = 0;
        }
      } else {
        // Nearest end cap, treated as a disc of radius halfThickness.
        const capAngle = rel > 0 ? o.endAngle : o.startAngle;
        const capX = o.cx + Math.cos(capAngle) * o.radius;
        const capZ = o.cz + Math.sin(capAngle) * o.radius;
        const cdx = x - capX;
        const cdz = z - capZ;
        const clen = Math.hypot(cdx, cdz);
        _sdf.d = clen - o.halfThickness;
        if (clen > 1e-6) {
          _sdf.nx = cdx / clen;
          _sdf.nz = cdz / clen;
        } else {
          _sdf.nx = 1;
          _sdf.nz = 0;
        }
      }
      return _sdf;
    }
  }
}

/**
 * The tawaf exclusion zone: the Kaaba, its base, the Hijr Ismail wall AND the
 * area it encloses. Tawaf must pass outside all of it. Returns true if the
 * point is inside the excluded region.
 */
export function insideTawafExclusion(x: number, z: number, margin = 0): boolean {
  // Kaaba box
  const k = OBSTACLES[0] as BoxObstacle;
  const dx = x - k.cx;
  const dz = z - k.cz;
  const lx = Math.abs(dx * k.cos + dz * k.sin) - k.halfX - margin;
  const lz = Math.abs(-dx * k.sin + dz * k.cos) - k.halfZ - margin;
  if (lx < 0 && lz < 0) return true;

  // Hijr enclosure: inside the arc radius AND on the outward side of the
  // Kaaba's NW wall.
  const hx = x - HIJR_CENTRE.x;
  const hz = z - HIJR_CENTRE.z;
  const hr = Math.hypot(hx, hz);
  if (hr < HIJR.radius + HIJR.wallThickness / 2 + margin) {
    // Only the half-plane on the outward (NW) side of the Kaaba counts.
    //
    // The plane is taken at the Kaaba's CENTRE, not at its north-west face.
    // Taking it at the face leaves a thin wedge beside the Kaaba's side
    // corners that is outside the box, outside this half-plane, and yet
    // already deep inside the Hijr disc. An agent walking through that wedge
    // is legal right up until it crosses the plane, at which point it is
    // suddenly half a metre inside the exclusion and gets extracted in one
    // visible jump. Putting the plane at the centre makes the excluded region
    // contiguous with the box, so there is no edge to cross discontinuously.
    // The wedge itself is inside the Hijr's footprint, which tawaf must pass
    // outside of in any case.
    const outward = x * Math.cos(HIJR_NORMAL) + z * Math.sin(HIJR_NORMAL);
    if (outward > 0) return true;
  }
  return false;
}

/**
 * Project a point out of the tawaf exclusion zone by the SHORTEST route.
 *
 * The naive escape — push radially away from the world origin — is wrong, and
 * wrong in an expensive way. The Hijr enclosure is a circle struck from the
 * midpoint of the Kaaba's north-west wall, not from the origin, so a radial
 * push can slide an agent ALONG the boundary instead of out of it. An agent
 * held against that boundary by the crowd then needs many iterations to
 * escape, accumulates depth in the meantime, and eventually gets yanked a
 * metre in one tick when the correction finally lands. Choosing the true
 * nearest exit makes every correction small.
 *
 * Writes the corrected position into `out` and returns true if it moved.
 */
export function escapeTawafExclusion(
  x: number,
  z: number,
  clearance: number,
  out: { x: number; z: number },
): boolean {
  out.x = x;
  out.z = z;
  if (!insideTawafExclusion(x, z, clearance)) return false;

  // --- Kaaba box: leave through the nearest face -------------------------
  const k = OBSTACLES[0] as BoxObstacle;
  const dx = x - k.cx;
  const dz = z - k.cz;
  const lx = dx * k.cos + dz * k.sin;
  const lz = -dx * k.sin + dz * k.cos;
  const overX = k.halfX + clearance - Math.abs(lx);
  const overZ = k.halfZ + clearance - Math.abs(lz);
  if (overX > 0 && overZ > 0) {
    let nx: number;
    let nz: number;
    if (overX < overZ) {
      nx = Math.sign(lx) || 1;
      nz = 0;
      out.x = x + (nx * overX) * k.cos - nz * k.sin;
      out.z = z + (nx * overX) * k.sin + nz * k.cos;
    } else {
      nx = 0;
      nz = Math.sign(lz) || 1;
      out.x = x - (nz * overZ) * k.sin;
      out.z = z + (nz * overZ) * k.cos;
    }
    // Leaving the box may still land inside the Hijr; fall through.
    x = out.x;
    z = out.z;
    if (!insideTawafExclusion(x, z, clearance)) return true;
  }

  // --- Hijr enclosure: leave radially from the ARC's own centre ----------
  const hx = x - HIJR_CENTRE.x;
  const hz = z - HIJR_CENTRE.z;
  const hr = Math.hypot(hx, hz) || 1e-6;
  const target = HIJR.radius + HIJR.wallThickness / 2 + clearance + 1e-3;
  if (hr < target) {
    out.x = HIJR_CENTRE.x + (hx / hr) * target;
    out.z = HIJR_CENTRE.z + (hz / hr) * target;
    return true;
  }

  return out.x !== x || out.z !== z;
}

/**
 * Push a point out of every obstacle it penetrates. Mutates and returns the
 * supplied {x, z} object. `clearance` is added to each obstacle surface.
 */
export function resolvePenetration(
  p: { x: number; z: number },
  clearance: number,
  list: readonly Obstacle[] = MATAF_OBSTACLES,
): boolean {
  let moved = false;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    // Broad phase.
    const bdx = p.x - o.bx;
    const bdz = p.z - o.bz;
    const reach = o.br + clearance + 0.001;
    if (bdx * bdx + bdz * bdz > reach * reach) continue;
    const s = obstacleSdf(o, p.x, p.z);
    if (s.d < clearance) {
      const push = clearance - s.d;
      p.x += s.nx * push;
      p.z += s.nz * push;
      moved = true;
    }
  }
  return moved;
}

/** Distance to the nearest obstacle surface (positive = free space). */
export function nearestObstacleDistance(
  x: number,
  z: number,
  list: readonly Obstacle[] = MATAF_OBSTACLES,
): number {
  let best = Infinity;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    const bdx = x - o.bx;
    const bdz = z - o.bz;
    const rough = Math.sqrt(bdx * bdx + bdz * bdz) - o.br;
    if (rough > best) continue;
    const s = obstacleSdf(o, x, z);
    if (s.d < best) best = s.d;
  }
  return best;
}

/** True if the point is inside the walkable courtyard and free of obstacles. */
export function isWalkable(x: number, z: number, clearance = 0.3): boolean {
  const r = Math.hypot(x, z);
  if (r > GALLERY.columnRings[GALLERY.columnRings.length - 1] + 4) return false;
  if (insideTawafExclusion(x, z, clearance)) return false;
  return nearestObstacleDistance(x, z, OBSTACLES) > clearance;
}
