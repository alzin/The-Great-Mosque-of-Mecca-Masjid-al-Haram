/**
 * CharacterMesh.ts — procedural generation of the skinned character body.
 *
 * The body is built from "rings": closed loops of vertices placed along a
 * path, each ring bound to one or two bones with blend weights. Triangulating
 * between consecutive rings gives clean topology, and dropping rings or
 * segments gives a cheap, well-behaved LOD chain.
 *
 * The garment is a single lofted tube from hem to shoulders whose lower rings
 * are weighted to the average of both thighs. That is what lets the robe
 * follow the legs credibly through bowing, kneeling and prostration instead
 * of shearing away from the body.
 *
 * Coordinates are in HEIGHT FRACTIONS; the instance shader multiplies by each
 * agent's real height.
 */

import { BONE_COUNT, BoneIndex } from './Rig.ts';

export interface MeshData {
  /** Rest positions, 3 per vertex, in height fractions. */
  position: Float32Array;
  /** Rest normals, 3 per vertex. */
  normal: Float32Array;
  /** Two bone indices per vertex. */
  skinIndex: Uint8Array;
  /** Two matching weights per vertex (sum to 1). */
  skinWeight: Float32Array;
  /**
   * Per-vertex material zone, used by the shader to tint garment / skin /
   * head-covering separately: 0 = garment, 1 = skin, 2 = head covering,
   * 3 = sash / trim.
   */
  zone: Uint8Array;
  index: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

export interface LodSpec {
  /** Segments around the garment tube. */
  bodySegments: number;
  /** Rings along the garment. */
  bodyRings: number;
  /** Segments around limbs. */
  limbSegments: number;
  /** Rings per limb bone. */
  limbRings: number;
  /** Latitude bands for the head. */
  headBands: number;
  headSegments: number;
  /** Skip the separate lower-leg geometry (hidden by long garments). */
  simpleLegs: boolean;
}

export const LOD_SPECS: readonly LodSpec[] = [
  // LOD0 — used for the nearest few hundred characters.
  { bodySegments: 12, bodyRings: 11, limbSegments: 6, limbRings: 3, headBands: 6, headSegments: 8, simpleLegs: false },
  // LOD1 — mid distance.
  { bodySegments: 8, bodyRings: 7, limbSegments: 4, limbRings: 2, headBands: 4, headSegments: 6, simpleLegs: false },
  // LOD2 — far field: silhouette only.
  { bodySegments: 6, bodyRings: 5, limbSegments: 3, limbRings: 1, headBands: 3, headSegments: 4, simpleLegs: true },
];

const Z_GARMENT = 0;
const Z_SKIN = 1;
const Z_HEADCOVER = 2;
const Z_TRIM = 3;

interface Builder {
  pos: number[];
  nrm: number[];
  si: number[];
  sw: number[];
  zone: number[];
  idx: number[];
}

function newBuilder(): Builder {
  return { pos: [], nrm: [], si: [], sw: [], zone: [], idx: [] };
}

function pushVertex(
  b: Builder,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  b0: number,
  b1: number,
  w0: number,
  zone: number,
): number {
  const i = b.pos.length / 3;
  b.pos.push(x, y, z);
  const nl = Math.hypot(nx, ny, nz) || 1;
  b.nrm.push(nx / nl, ny / nl, nz / nl);
  b.si.push(b0, b1);
  const w = Math.max(0, Math.min(1, w0));
  b.sw.push(w, 1 - w);
  b.zone.push(zone);
  return i;
}

function bridgeRings(b: Builder, ringA: number[], ringB: number[]): void {
  const n = ringA.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    b.idx.push(ringA[i], ringB[i], ringB[j]);
    b.idx.push(ringA[i], ringB[j], ringA[j]);
  }
}

function capRing(b: Builder, ring: number[], centre: number, flip: boolean): void {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (flip) b.idx.push(centre, ring[j], ring[i]);
    else b.idx.push(centre, ring[i], ring[j]);
  }
}

/**
 * Garment profile: half-width in X and Z at a given height fraction, plus the
 * bone weighting for that height. Tuned so the silhouette reads as a person
 * in a thobe or ihram at 40-120 m.
 */
interface GarmentSample {
  y: number;
  halfX: number;
  halfZ: number;
  b0: number;
  b1: number;
  w0: number;
  zone: number;
}

function garmentProfile(t: number, robeLength: number): GarmentSample {
  // t: 0 at hem, 1 at the shoulder line.
  const yHem = robeLength;
  const yTop = 0.845;
  const y = yHem + (yTop - yHem) * t;

  // Width profile as a small table, interpolated. Expressed as half-widths in
  // height fractions: multiply by 1.74 to read them as metres on an average
  // adult. The shape that matters at distance is flared hem -> waist -> chest
  // -> shoulders, and in particular the shoulders must be the WIDEST point.
  // Getting that backwards makes the silhouette read as a bell rather than a
  // person, and buries the arms inside the garment.
  const halfX = sampleProfile(t, PROFILE_X);
  const halfZ = sampleProfile(t, PROFILE_Z);

  // Bone weighting along the garment. The hem tracks the legs (averaged
  // across both thighs via a two-bone blend) so kneeling reads correctly.
  let b0: number;
  let b1: number;
  let w0: number;
  if (y < 0.30) {
    b0 = BoneIndex.thighL;
    b1 = BoneIndex.thighR;
    w0 = 0.5;
  } else if (y < 0.50) {
    const k = (y - 0.3) / 0.2;
    b0 = BoneIndex.root;
    b1 = BoneIndex.thighL;
    w0 = 0.35 + 0.6 * k;
  } else if (y < 0.62) {
    const k = (y - 0.5) / 0.12;
    b0 = BoneIndex.spine;
    b1 = BoneIndex.root;
    w0 = k * 0.85;
  } else if (y < 0.75) {
    const k = (y - 0.62) / 0.13;
    b0 = BoneIndex.chest;
    b1 = BoneIndex.spine;
    w0 = k * 0.9;
  } else {
    b0 = BoneIndex.chest;
    b1 = BoneIndex.spine;
    w0 = 1;
  }

  // A sash / belt band around the waist reads well at distance and breaks up
  // the silhouette.
  const zone = y > 0.545 && y < 0.585 ? Z_TRIM : Z_GARMENT;

  return { y, halfX, halfZ, b0, b1, w0, zone };
}

/** [t, halfWidth] control points, ascending in t. */
const PROFILE_X: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0.118],
  [0.14, 0.11],
  [0.46, 0.09],
  [0.62, 0.089],
  [0.84, 0.094],
  [0.95, 0.1],
  [1.0, 0.1],
];

const PROFILE_Z: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0.073],
  [0.14, 0.068],
  [0.46, 0.055],
  [0.62, 0.059],
  [0.84, 0.067],
  [0.95, 0.069],
  [1.0, 0.067],
];

function sampleProfile(t: number, table: ReadonlyArray<readonly [number, number]>): number {
  if (t <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (t <= table[i][0]) {
      const [t0, v0] = table[i - 1];
      const [t1, v1] = table[i];
      const k = smoothstep(0, 1, (t - t0) / Math.max(1e-6, t1 - t0));
      return v0 + (v1 - v0) * k;
    }
  }
  return table[table.length - 1][1];
}

/**
 * The neck. Without it the head floats: the garment's shoulder cap sits at
 * 0.845 and the chin at about 0.87, and that gap is glaringly visible even on
 * a person only forty pixels tall.
 */
function buildNeck(b: Builder, spec: LodSpec): void {
  const segs = Math.max(5, Math.floor(spec.bodySegments * 0.6));
  const rings: number[][] = [];
  const levels: Array<[number, number, number]> = [
    // y, radius, weight toward the neck bone
    [0.852, 0.041, 0.0],
    [0.874, 0.032, 0.6],
    [0.894, 0.03, 1.0],
  ];
  for (const [y, rad, w] of levels) {
    const ring: number[] = [];
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const cx = Math.cos(a);
      const sz = Math.sin(a);
      ring.push(
        pushVertex(b, cx * rad, y, sz * rad * 0.92, cx, 0.1, sz, BoneIndex.neck, BoneIndex.chest, w, Z_SKIN),
      );
    }
    rings.push(ring);
  }
  for (let r = 0; r < rings.length - 1; r++) bridgeRings(b, rings[r], rings[r + 1]);
}

function buildGarment(b: Builder, spec: LodSpec, robeLength: number): void {
  const rings: number[][] = [];
  const segs = spec.bodySegments;

  for (let r = 0; r < spec.bodyRings; r++) {
    const t = r / (spec.bodyRings - 1);
    const s = garmentProfile(t, robeLength);
    const ring: number[] = [];
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const cx = Math.cos(a);
      const sz = Math.sin(a);
      const x = cx * s.halfX;
      const z = sz * s.halfZ;
      // Normal of an ellipse.
      const nx = cx / s.halfX;
      const nz = sz / s.halfZ;
      ring.push(pushVertex(b, x, s.y, z, nx, 0.15, nz, s.b0, s.b1, s.w0, s.zone));
    }
    rings.push(ring);
  }

  for (let r = 0; r < rings.length - 1; r++) bridgeRings(b, rings[r], rings[r + 1]);

  // Hem cap (seen from below when prostrating) and shoulder cap.
  const hem = garmentProfile(0, robeLength);
  const hemCentre = pushVertex(
    b, 0, hem.y, 0, 0, -1, 0, hem.b0, hem.b1, hem.w0, Z_GARMENT,
  );
  capRing(b, rings[0], hemCentre, false);

  // Shoulders. A flat cap across the top of the tube reads as a box; two
  // shrinking rings above the shoulder line give the slope from the deltoid
  // to the base of the neck, which is most of what makes a distant figure
  // look like a person rather than a bollard.
  let previous = rings[rings.length - 1];
  const shoulderRings: Array<[number, number, number]> = [
    // y, halfX, halfZ
    [0.858, 0.092, 0.062],
    [0.874, 0.062, 0.048],
  ];
  for (const [y, hx, hz] of shoulderRings) {
    const ring: number[] = [];
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const cx = Math.cos(a);
      const sz = Math.sin(a);
      ring.push(
        pushVertex(b, cx * hx, y, sz * hz, cx / hx, 0.9, sz / hz, BoneIndex.chest, BoneIndex.neck, 0.8, Z_GARMENT),
      );
    }
    bridgeRings(b, previous, ring);
    previous = ring;
  }
  const topCentre = pushVertex(
    b, 0, 0.88, 0, 0, 1, 0, BoneIndex.neck, BoneIndex.chest, 0.7, Z_GARMENT,
  );
  capRing(b, previous, topCentre, true);
}

/** A tapered tube following one bone, from its joint toward its child. */
function buildLimb(
  b: Builder,
  spec: LodSpec,
  boneA: number,
  boneB: number,
  startY: number,
  endY: number,
  offsetX: number,
  rStart: number,
  rEnd: number,
  zone: number,
  capEnd: boolean,
): void {
  const segs = spec.limbSegments;
  const ringCount = spec.limbRings + 1;
  const rings: number[][] = [];

  for (let r = 0; r < ringCount; r++) {
    const t = r / (ringCount - 1);
    const y = startY + (endY - startY) * t;
    const rad = rStart + (rEnd - rStart) * t;
    // Blend from boneA to boneB across the segment, concentrated near the
    // joint so the elbow/knee creases rather than collapsing.
    const w0 = 1 - smoothstep(0.45, 1.0, t);
    const ring: number[] = [];
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const cx = Math.cos(a);
      const sz = Math.sin(a);
      ring.push(
        pushVertex(b, offsetX + cx * rad, y, sz * rad, cx, 0, sz, boneA, boneB, w0, zone),
      );
    }
    rings.push(ring);
  }
  for (let r = 0; r < rings.length - 1; r++) bridgeRings(b, rings[r], rings[r + 1]);

  if (capEnd) {
    const centre = pushVertex(
      b, offsetX, endY - rEnd * 0.4, 0, 0, -1, 0, boneB, boneB, 1, zone,
    );
    capRing(b, rings[rings.length - 1], centre, false);
  }
  const startCentre = pushVertex(b, offsetX, startY + rStart * 0.3, 0, 0, 1, 0, boneA, boneA, 1, zone);
  capRing(b, rings[0], startCentre, true);
}

function buildHead(b: Builder, spec: LodSpec, coverTop: boolean): void {
  const cy = 0.928;
  const rx = 0.048;
  const ry = 0.062;
  const rz = 0.052;
  const bands = spec.headBands;
  const segs = spec.headSegments;
  const rings: number[][] = [];

  for (let bnd = 1; bnd < bands; bnd++) {
    const phi = (bnd / bands) * Math.PI;
    const sp = Math.sin(phi);
    const cp = Math.cos(phi);
    const y = cy + cp * ry;
    const ring: number[] = [];
    // The upper part of the head reads as a covering (taqiyah / ihram towel
    // / scarf) and gets its own material zone.
    const zone = coverTop && cp > -0.15 ? Z_HEADCOVER : Z_SKIN;
    const scale = coverTop && cp > -0.15 ? 1.09 : 1;
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const x = Math.cos(a) * sp * rx * scale;
      const z = Math.sin(a) * sp * rz * scale;
      ring.push(
        pushVertex(b, x, y, z, x, (y - cy) * 1.2, z, BoneIndex.head, BoneIndex.head, 1, zone),
      );
    }
    rings.push(ring);
  }
  for (let r = 0; r < rings.length - 1; r++) bridgeRings(b, rings[r], rings[r + 1]);

  const topZone = coverTop ? Z_HEADCOVER : Z_SKIN;
  const top = pushVertex(b, 0, cy + ry, 0, 0, 1, 0, BoneIndex.head, BoneIndex.head, 1, topZone);
  capRing(b, rings[0], top, true);
  const bot = pushVertex(b, 0, cy - ry, 0, 0, -1, 0, BoneIndex.neck, BoneIndex.head, 0.4, Z_SKIN);
  capRing(b, rings[rings.length - 1], bot, false);
}

function buildFoot(b: Builder, spec: LodSpec, bone: number, offsetX: number): void {
  // A simple wedge; enough to read as a foot and to look planted.
  const segs = Math.max(4, spec.limbSegments);
  const y0 = 0.059;
  const ring: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    ring.push(
      pushVertex(
        b,
        offsetX + Math.cos(a) * 0.026,
        y0,
        Math.sin(a) * 0.038 + 0.008,
        Math.cos(a),
        0.2,
        Math.sin(a),
        bone,
        bone,
        1,
        Z_SKIN,
      ),
    );
  }
  const sole: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    sole.push(
      pushVertex(
        b,
        offsetX + Math.cos(a) * 0.03,
        0.004,
        Math.sin(a) * 0.062 + 0.032,
        Math.cos(a) * 0.4,
        -0.9,
        Math.sin(a) * 0.4,
        bone,
        bone,
        1,
        Z_SKIN,
      ),
    );
  }
  bridgeRings(b, ring, sole);
  const c0 = pushVertex(b, offsetX, y0 + 0.01, 0, 0, 1, 0, bone, bone, 1, Z_SKIN);
  capRing(b, ring, c0, true);
  const c1 = pushVertex(b, offsetX, 0.002, 0.032, 0, -1, 0, bone, bone, 1, Z_SKIN);
  capRing(b, sole, c1, false);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export interface CharacterVariant {
  /** Height fraction at which the garment hem sits. */
  robeLength: number;
  coverHead: boolean;
}

/**
 * Two garment silhouettes are generated. Everyone shares one geometry per
 * LOD (that is what keeps the draw calls down); the variation the viewer
 * sees comes from per-instance height, build, colour and animation phase.
 * The hem is set at ankle length, which reads correctly for both an ankle
 * length thobe and a wrapped lower garment at these camera distances.
 */
export const DEFAULT_VARIANT: CharacterVariant = { robeLength: 0.075, coverHead: true };

export function buildCharacterMesh(lod: number, variant: CharacterVariant = DEFAULT_VARIANT): MeshData {
  const spec = LOD_SPECS[Math.max(0, Math.min(LOD_SPECS.length - 1, lod))];
  const b = newBuilder();

  buildGarment(b, spec, variant.robeLength);
  buildNeck(b, spec);
  buildHead(b, spec, variant.coverHead);

  // Arms: upper and lower, left and right. The sleeve is part of the garment
  // colour zone down to the forearm, then skin.
  // Arm geometry is aligned to the ACTUAL joint positions in the rig, not to
  // approximate numbers: the shoulder joint sits at x = 0.115, y = 0.82, the
  // elbow at y = 0.63 and the wrist at y = 0.485. Geometry that disagrees
  // with its own skeleton swings away from the body as soon as the bone
  // rotates, which is exactly the "floating rod" artefact this replaces. The
  // deltoid ring starts slightly above the joint so it tucks under the
  // garment's sloped shoulder.
  const shoulderY = 0.838;
  const elbowY = 0.63;
  const wristY = 0.485;
  const handY = 0.44;
  const armX = 0.115;
  for (const [side, up, lo, hand] of [
    [1, BoneIndex.upArmL, BoneIndex.loArmL, BoneIndex.handL],
    [-1, BoneIndex.upArmR, BoneIndex.loArmR, BoneIndex.handR],
  ] as const) {
    const x = armX * side;
    buildLimb(b, spec, up, lo, shoulderY, elbowY, x, 0.036, 0.026, Z_GARMENT, false);
    buildLimb(b, spec, lo, hand, elbowY, wristY, x, 0.026, 0.019, Z_SKIN, false);
    buildLimb(b, spec, hand, hand, wristY, handY, x, 0.021, 0.013, Z_SKIN, true);
  }

  if (!spec.simpleLegs) {
    // Only the part of the leg below the hem needs geometry.
    const hem = variant.robeLength;
    const ankleY = 0.062;
    buildLimb(b, spec, BoneIndex.shinL, BoneIndex.footL, Math.min(0.285, hem + 0.02), ankleY, 0.055, 0.028, 0.022, Z_SKIN, false);
    buildLimb(b, spec, BoneIndex.shinR, BoneIndex.footR, Math.min(0.285, hem + 0.02), ankleY, -0.055, 0.028, 0.022, Z_SKIN, false);
    buildFoot(b, spec, BoneIndex.footL, 0.055);
    buildFoot(b, spec, BoneIndex.footR, -0.055);
  } else {
    buildFoot(b, spec, BoneIndex.footL, 0.055);
    buildFoot(b, spec, BoneIndex.footR, -0.055);
  }

  const vertexCount = b.pos.length / 3;
  if (vertexCount === 0) throw new Error('character mesh generated no vertices');
  for (const bi of b.si) {
    if (bi < 0 || bi >= BONE_COUNT) throw new Error(`bad bone index ${bi}`);
  }

  return {
    position: Float32Array.from(b.pos),
    normal: Float32Array.from(b.nrm),
    skinIndex: Uint8Array.from(b.si),
    skinWeight: Float32Array.from(b.sw),
    zone: Uint8Array.from(b.zone),
    index: Uint32Array.from(b.idx),
    vertexCount,
    triangleCount: b.idx.length / 3,
  };
}
