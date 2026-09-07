/**
 * Rig.ts — a small procedural humanoid skeleton.
 *
 * The whole character pipeline is generated in code: there is no external
 * rigged model to download, so there is nothing to license and nothing that
 * can fail to load. The rig is deliberately tiny (19 bones) because the
 * cameras never get close enough for finger or face detail to matter, and
 * because every bone costs bake time and vertex-animation texture space.
 *
 * CONVENTIONS
 *   * Local frame: +Y up, +Z is the character's forward. With a right-handed
 *     system that puts the character's LEFT at +X.
 *   * A bone's `offset` is the position of its joint in its parent's space at
 *     rest. At rest every bone's rotation is identity, limbs hang straight
 *     down, and the feet sit on y = 0.
 *   * Rotations are XYZ Euler triples, in radians. With limbs hanging down
 *     (0, -1, 0), a NEGATIVE X rotation swings the limb FORWARD (+Z) and a
 *     positive Z rotation swings it toward +X (the character's left).
 *   * All lengths are expressed as a fraction of total standing height, so a
 *     single rig serves every body size in the crowd.
 */

export interface BoneDef {
  readonly name: string;
  readonly parent: number;
  /** Offset from the parent joint, as a fraction of total height. */
  readonly offset: readonly [number, number, number];
}

export const BONES: readonly BoneDef[] = [
  /*  0 */ { name: 'root', parent: -1, offset: [0, 0.53, 0] },
  /*  1 */ { name: 'spine', parent: 0, offset: [0, 0.07, 0] },
  /*  2 */ { name: 'chest', parent: 1, offset: [0, 0.12, 0] },
  /*  3 */ { name: 'neck', parent: 2, offset: [0, 0.135, 0] },
  /*  4 */ { name: 'head', parent: 3, offset: [0, 0.075, 0] },

  /*  5 */ { name: 'clavL', parent: 2, offset: [0.05, 0.1, 0] },
  /*  6 */ { name: 'upArmL', parent: 5, offset: [0.065, 0, 0] },
  /*  7 */ { name: 'loArmL', parent: 6, offset: [0, -0.19, 0] },
  /*  8 */ { name: 'handL', parent: 7, offset: [0, -0.145, 0] },

  /*  9 */ { name: 'clavR', parent: 2, offset: [-0.05, 0.1, 0] },
  /* 10 */ { name: 'upArmR', parent: 9, offset: [-0.065, 0, 0] },
  /* 11 */ { name: 'loArmR', parent: 10, offset: [0, -0.19, 0] },
  /* 12 */ { name: 'handR', parent: 11, offset: [0, -0.145, 0] },

  /* 13 */ { name: 'thighL', parent: 0, offset: [0.055, -0.02, 0] },
  /* 14 */ { name: 'shinL', parent: 13, offset: [0, -0.245, 0] },
  /* 15 */ { name: 'footL', parent: 14, offset: [0, -0.226, 0] },

  /* 16 */ { name: 'thighR', parent: 0, offset: [-0.055, -0.02, 0] },
  /* 17 */ { name: 'shinR', parent: 16, offset: [0, -0.245, 0] },
  /* 18 */ { name: 'footR', parent: 17, offset: [0, -0.226, 0] },
];

export const BONE_COUNT = BONES.length;

export const BoneIndex = Object.freeze(
  BONES.reduce<Record<string, number>>((acc, b, i) => {
    acc[b.name] = i;
    return acc;
  }, {}),
);

/**
 * A pose: per-bone XYZ Euler rotations plus a root translation offset
 * (also a fraction of height) applied on top of the rest root position.
 */
export interface Pose {
  /** Length BONE_COUNT * 3. */
  rot: Float32Array;
  /** Root translation delta [x, y, z], fractions of height. */
  rootOffset: [number, number, number];
}

export function createPose(): Pose {
  return { rot: new Float32Array(BONE_COUNT * 3), rootOffset: [0, 0, 0] };
}

export type PoseSpec = Partial<Record<string, readonly [number, number, number]>> & {
  /**
   * Translation of the whole figure, in height fractions. Distinct from the
   * `root` KEY, which — like every other key — is a bone ROTATION: the root
   * bone is the pelvis, and tilting it is how the hips hinge in ruku and
   * sujud.
   */
  rootOffset?: readonly [number, number, number];
};

/** Build a pose from a sparse `{ boneName: [rx, ry, rz] }` description. */
export function makePose(spec: PoseSpec): Pose {
  const p = createPose();
  for (const key of Object.keys(spec)) {
    if (key === 'rootOffset') {
      const r = spec.rootOffset!;
      p.rootOffset = [r[0], r[1], r[2]];
      continue;
    }
    const idx = BoneIndex[key];
    if (idx === undefined) throw new Error(`Unknown bone in pose: ${key}`);
    const v = spec[key]!;
    p.rot[idx * 3] = v[0];
    p.rot[idx * 3 + 1] = v[1];
    p.rot[idx * 3 + 2] = v[2];
  }
  return p;
}

/** Linear interpolation of two poses. Euler-space, which is fine here
 * because every joint in this rig moves on a dominant single axis. */
export function lerpPose(a: Pose, b: Pose, t: number, out: Pose): Pose {
  for (let i = 0; i < a.rot.length; i++) {
    out.rot[i] = a.rot[i] + (b.rot[i] - a.rot[i]) * t;
  }
  for (let i = 0; i < 3; i++) {
    out.rootOffset[i] = a.rootOffset[i] + (b.rootOffset[i] - a.rootOffset[i]) * t;
  }
  return out;
}

export function copyPose(src: Pose, out: Pose): Pose {
  out.rot.set(src.rot);
  out.rootOffset[0] = src.rootOffset[0];
  out.rootOffset[1] = src.rootOffset[1];
  out.rootOffset[2] = src.rootOffset[2];
  return out;
}

export function addPose(base: Pose, delta: Pose, scale: number, out: Pose): Pose {
  for (let i = 0; i < base.rot.length; i++) out.rot[i] = base.rot[i] + delta.rot[i] * scale;
  for (let i = 0; i < 3; i++) out.rootOffset[i] = base.rootOffset[i] + delta.rootOffset[i] * scale;
  return out;
}

/**
 * Evaluate forward kinematics.
 *
 * Writes BONE_COUNT 4x3 matrices (column-major 3x3 rotation + translation)
 * into `out` as 12 floats each: [m00 m01 m02 m03 m10 ... m23].
 * The matrices map REST-space positions to POSED-space positions, i.e. they
 * already include the inverse bind transform, so skinning is a plain
 * weighted sum.
 */
export class RigEvaluator {
  /** World-space rest position of each joint, in height fractions. */
  readonly restJoint: Float32Array;
  /** Scratch: posed world matrices, 16 floats per bone (column-major 4x4). */
  private readonly world: Float32Array;
  /** Output skinning matrices, 12 floats per bone (row-major 3x4). */
  readonly skin: Float32Array;

  constructor() {
    this.restJoint = new Float32Array(BONE_COUNT * 3);
    this.world = new Float32Array(BONE_COUNT * 16);
    this.skin = new Float32Array(BONE_COUNT * 12);
    this.computeRest();
  }

  private computeRest(): void {
    for (let i = 0; i < BONE_COUNT; i++) {
      const b = BONES[i];
      const px = b.parent >= 0 ? this.restJoint[b.parent * 3] : 0;
      const py = b.parent >= 0 ? this.restJoint[b.parent * 3 + 1] : 0;
      const pz = b.parent >= 0 ? this.restJoint[b.parent * 3 + 2] : 0;
      this.restJoint[i * 3] = px + b.offset[0];
      this.restJoint[i * 3 + 1] = py + b.offset[1];
      this.restJoint[i * 3 + 2] = pz + b.offset[2];
    }
  }

  /**
   * Evaluate a pose. Fills `this.skin` with the rest->posed transform of
   * every bone.
   */
  evaluate(pose: Pose): Float32Array {
    const w = this.world;
    for (let i = 0; i < BONE_COUNT; i++) {
      const b = BONES[i];
      const rx = pose.rot[i * 3];
      const ry = pose.rot[i * 3 + 1];
      const rz = pose.rot[i * 3 + 2];

      // Local rotation matrix, XYZ order.
      const cx = Math.cos(rx);
      const sx = Math.sin(rx);
      const cy = Math.cos(ry);
      const sy = Math.sin(ry);
      const cz = Math.cos(rz);
      const sz = Math.sin(rz);
      // R = Rz * Ry * Rx  (applied to a column vector as R * v)
      const m00 = cz * cy;
      const m01 = cz * sy * sx - sz * cx;
      const m02 = cz * sy * cx + sz * sx;
      const m10 = sz * cy;
      const m11 = sz * sy * sx + cz * cx;
      const m12 = sz * sy * cx - cz * sx;
      const m20 = -sy;
      const m21 = cy * sx;
      const m22 = cy * cx;

      let tx = b.offset[0];
      let ty = b.offset[1];
      let tz = b.offset[2];
      if (b.parent < 0) {
        tx += pose.rootOffset[0];
        ty += pose.rootOffset[1];
        tz += pose.rootOffset[2];
      }

      const o = i * 16;
      if (b.parent < 0) {
        w[o] = m00;
        w[o + 1] = m01;
        w[o + 2] = m02;
        w[o + 3] = tx;
        w[o + 4] = m10;
        w[o + 5] = m11;
        w[o + 6] = m12;
        w[o + 7] = ty;
        w[o + 8] = m20;
        w[o + 9] = m21;
        w[o + 10] = m22;
        w[o + 11] = tz;
      } else {
        const p = b.parent * 16;
        // world = parentWorld * local
        for (let r = 0; r < 3; r++) {
          const p0 = w[p + r * 4];
          const p1 = w[p + r * 4 + 1];
          const p2 = w[p + r * 4 + 2];
          const p3 = w[p + r * 4 + 3];
          w[o + r * 4] = p0 * m00 + p1 * m10 + p2 * m20;
          w[o + r * 4 + 1] = p0 * m01 + p1 * m11 + p2 * m21;
          w[o + r * 4 + 2] = p0 * m02 + p1 * m12 + p2 * m22;
          w[o + r * 4 + 3] = p0 * tx + p1 * ty + p2 * tz + p3;
        }
      }
    }

    // skin = world * inverseBind, where inverseBind is a pure translation by
    // -restJoint (rest rotations are identity).
    const s = this.skin;
    for (let i = 0; i < BONE_COUNT; i++) {
      const o = i * 16;
      const so = i * 12;
      const bx = this.restJoint[i * 3];
      const by = this.restJoint[i * 3 + 1];
      const bz = this.restJoint[i * 3 + 2];
      for (let r = 0; r < 3; r++) {
        const m0 = w[o + r * 4];
        const m1 = w[o + r * 4 + 1];
        const m2 = w[o + r * 4 + 2];
        const m3 = w[o + r * 4 + 3];
        s[so + r * 4] = m0;
        s[so + r * 4 + 1] = m1;
        s[so + r * 4 + 2] = m2;
        s[so + r * 4 + 3] = m3 - (m0 * bx + m1 * by + m2 * bz);
      }
    }
    return s;
  }

  /** World position of a joint under the last evaluated pose. */
  jointPosition(index: number, out: [number, number, number]): void {
    const o = index * 16;
    out[0] = this.world[o + 3];
    out[1] = this.world[o + 7];
    out[2] = this.world[o + 11];
  }
}
