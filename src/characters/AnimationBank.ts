/**
 * AnimationBank.ts — every pose and clip the crowd can play.
 *
 * PRAYER POSTURES
 *   The postures and their order follow the standard congregational salah as
 *   described in the widely available fiqh manuals and as visible in any
 *   recording of a congregation: qiyam (standing) with the hands folded,
 *   takbir with the hands raised, ruku (bowing with the back level and the
 *   hands on the knees), i'tidal (returning upright), sujud (prostration on
 *   forehead, nose, palms, knees and toes), jalsa (sitting between the two
 *   prostrations), the second sujud, and the final tashahhud sitting closed
 *   by the taslim to the right and then the left.
 *
 *   Documented simplifications: the hands are single rigid blobs, so the
 *   raised index finger of the tashahhud is not modelled; the differences
 *   between schools in hand placement and in the sitting posture (iftirash
 *   vs tawarruk) are not distinguished; and no facial or lip movement is
 *   represented. Nothing in this file encodes text or recitation — only body
 *   posture.
 *
 * LOCOMOTION
 *   The walk and shuffle cycles are procedural sine-driven joint curves with
 *   a defined stride length, which is what allows the renderer to drive
 *   playback rate from the agent's actual ground speed and thereby avoid
 *   foot sliding.
 */

import { BONE_COUNT, BoneIndex, type Pose, createPose, lerpPose, makePose } from './Rig.ts';
import { CLIP_COUNT, Clip } from '../sim/States.ts';

const P = Math.PI;

// ---------------------------------------------------------------------------
// Key postures
// ---------------------------------------------------------------------------

/** Neutral rest: limbs hang, feet flat. */
export const POSE_REST = makePose({
  upArmL: [0.06, 0.0, 0.075],
  upArmR: [0.06, 0.0, -0.075],
  loArmL: [-0.34, 0.0, 0.03],
  loArmR: [-0.34, 0.0, -0.03],
});

/** Relaxed standing: the base for the idle clip. */
export const POSE_STAND = makePose({
  spine: [-0.03, 0.0, 0.0],
  chest: [0.05, 0.0, 0.0],
  neck: [0.05, 0.0, 0.0],
  upArmL: [0.08, 0.0, 0.055],
  upArmR: [0.08, 0.0, -0.055],
  loArmL: [-0.52, 0.0, 0.035],
  loArmR: [-0.52, 0.0, -0.035],
  thighL: [0.0, 0.0, 0.012],
  thighR: [0.0, 0.0, -0.012],
  shinL: [0.03, 0.0, 0.0],
  shinR: [0.03, 0.0, 0.0],
});

/** Qiyam: standing in prayer, right hand over left on the abdomen. */
export const POSE_QIYAM = makePose({
  spine: [-0.052, 0.000, 0.000],
  chest: [0.140, 0.000, 0.000],
  neck: [0.103, 0.000, 0.000],
  upArmL: [-0.233, 0.000, -0.041],
  loArmL: [-0.510, 0.000, -0.645],
  upArmR: [-0.233, 0.000, 0.041],
  loArmR: [-0.510, 0.000, 0.645],
});

/** Takbir: hands raised to about ear height, palms forward. */
export const POSE_TAKBIR = makePose({
  spine: [-0.060, 0.000, 0.000],
  chest: [0.004, 0.000, 0.000],
  neck: [0.300, 0.000, 0.000],
  upArmL: [-0.765, 0.000, 0.402],
  loArmL: [-2.584, 0.000, -0.280],
  upArmR: [-0.765, 0.000, -0.402],
  loArmR: [-2.584, 0.000, 0.280],
});

/** Ruku: bowing, back near level, hands on the knees, gaze to the ground. */
export const POSE_RUKU = makePose({
  rootOffset: [0.000, -0.002, 0.019],
  root: [0.349, 0.000, 0.000],
  spine: [1.305, 0.000, 0.000],
  chest: [-0.170, 0.000, 0.000],
  neck: [0.233, 0.000, 0.000],
  upArmL: [-0.943, 0.000, -0.149],
  loArmL: [-0.012, 0.000, -0.004],
  upArmR: [-0.943, 0.000, 0.149],
  loArmR: [-0.012, 0.000, 0.004],
  thighL: [-0.302, 0.000, 0.000],
  shinL: [-0.047, 0.000, 0.000],
  thighR: [-0.302, 0.000, 0.000],
  shinR: [-0.047, 0.000, 0.000],
});

/** I'tidal: upright again after the bow, arms at the sides. */
export const POSE_ITIDAL = makePose({
  spine: [-0.020, 0.000, 0.000],
  chest: [-0.018, 0.000, 0.000],
  neck: [0.207, 0.000, 0.000],
  upArmL: [0.020, 0.000, -0.215],
  loArmL: [-0.209, 0.000, 0.529],
  upArmR: [0.020, 0.000, 0.215],
  loArmR: [-0.209, 0.000, -0.529],
});

/**
 * Sujud: prostration. Knees and shins on the ground with the toes turned
 * under, hips raised, torso folded down from the pelvis, forehead and palms
 * on the ground with the hands beside the head.
 */
export const POSE_SUJUD = makePose({
  rootOffset: [0.000, -0.254, -0.024],
  root: [1.056, 0.000, 0.000],
  spine: [1.156, 0.000, 0.000],
  chest: [0.102, 0.000, 0.000],
  neck: [0.003, 0.000, 0.000],
  upArmL: [-2.533, 0.000, -0.722],
  loArmL: [-2.700, 0.000, 0.951],
  upArmR: [-2.533, 0.000, 0.722],
  loArmR: [-2.700, 0.000, -0.951],
  thighL: [-1.242, 0.000, 0.000],
  shinL: [1.870, 0.000, 0.000],
  thighR: [-1.242, 0.000, 0.000],
  shinR: [1.870, 0.000, 0.000],
});

/** Jalsa: sitting back on the heels between the two prostrations. */
export const POSE_JALSA = makePose({
  rootOffset: [0.000, -0.362, -0.024],
  root: [-0.062, 0.000, 0.000],
  spine: [0.092, 0.000, 0.000],
  chest: [0.085, 0.000, 0.000],
  neck: [-0.006, 0.000, 0.000],
  upArmL: [-0.246, 0.000, 0.247],
  loArmL: [-0.892, 0.000, -0.869],
  upArmR: [-0.246, 0.000, -0.247],
  loArmR: [-0.892, 0.000, 0.869],
  thighL: [-1.006, 0.000, 0.000],
  shinL: [2.705, 0.000, 0.000],
  thighR: [-1.006, 0.000, 0.000],
  shinR: [2.705, 0.000, 0.000],
});

/** Tashahhud: the same sitting posture, slightly more settled. */
export const POSE_TASHAHHUD = makePose({
  rootOffset: [0.000, -0.367, -0.027],
  root: [-0.021, 0.000, 0.000],
  spine: [0.075, 0.000, 0.000],
  chest: [0.068, 0.000, 0.000],
  neck: [-0.009, 0.000, 0.000],
  upArmL: [-0.377, 0.000, 0.330],
  loArmL: [-0.722, 0.000, -0.930],
  upArmR: [-0.377, 0.000, -0.330],
  loArmR: [-0.722, 0.000, 0.930],
  thighL: [-1.074, 0.000, 0.000],
  shinL: [2.728, 0.000, 0.000],
  thighR: [-1.074, 0.000, 0.000],
  shinR: [2.728, 0.000, 0.000],
});

/**
 * The two shaping poses for the descent and the rise.
 *
 * These are derived from the solved key postures rather than authored, and
 * they are not simple midpoints: the ORDER of a prostration matters. The
 * knees reach the ground first, then the hands, then the forehead, and the
 * rise reverses that. Taking the legs from the end pose while the torso is
 * still halfway is what encodes that order.
 */
function shapedMid(from: Pose, to: Pose, torsoT: number, legT: number): Pose {
  const out = createPose();
  lerpPose(from, to, torsoT, out);
  const legs = createPose();
  lerpPose(from, to, legT, legs);
  for (const bone of [
    BoneIndex.thighL, BoneIndex.thighR,
    BoneIndex.shinL, BoneIndex.shinR,
    BoneIndex.footL, BoneIndex.footR,
  ]) {
    out.rot[bone * 3] = legs.rot[bone * 3];
    out.rot[bone * 3 + 1] = legs.rot[bone * 3 + 1];
    out.rot[bone * 3 + 2] = legs.rot[bone * 3 + 2];
  }
  return out;
}

/** Halfway down to prostration: already kneeling, torso still coming down. */
const POSE_DESCEND_MID = shapedMid(POSE_ITIDAL, POSE_SUJUD, 0.45, 0.9);

/** Mid-point of standing up from the sitting posture. */
const POSE_RISE_MID = shapedMid(POSE_TASHAHHUD, POSE_STAND, 0.4, 0.62);

// ---------------------------------------------------------------------------
// Clip definitions
// ---------------------------------------------------------------------------

export interface ClipDef {
  /** Number of baked frames. */
  frames: number;
  /** Whether the clip loops seamlessly. */
  loop: boolean;
  /** Produces the pose for normalised time u in [0, 1). */
  sample: (u: number, out: Pose) => void;
}

const _a: Pose = { rot: new Float32Array(BONE_COUNT * 3), rootOffset: [0, 0, 0] };
const _b: Pose = { rot: new Float32Array(BONE_COUNT * 3), rootOffset: [0, 0, 0] };

/** Smooth ease used for every transition so nothing starts or stops abruptly. */
function ease(u: number): number {
  return u * u * (3 - 2 * u);
}

function transition(from: Pose, to: Pose, mid?: Pose) {
  return (u: number, out: Pose) => {
    const e = ease(u);
    if (mid) {
      if (e < 0.5) lerpPose(from, mid, ease(e * 2), out);
      else lerpPose(mid, to, ease((e - 0.5) * 2), out);
    } else {
      lerpPose(from, to, e, out);
    }
  };
}

/** A held posture with a small, slow breathing motion so nobody looks frozen. */
function hold(base: Pose, amplitude = 1) {
  return (u: number, out: Pose) => {
    out.rot.set(base.rot);
    out.rootOffset[0] = base.rootOffset[0];
    out.rootOffset[1] = base.rootOffset[1];
    out.rootOffset[2] = base.rootOffset[2];
    const breath = Math.sin(u * P * 2) * 0.006 * amplitude;
    out.rot[BoneIndex.chest * 3] += breath;
    out.rot[BoneIndex.spine * 3] -= breath * 0.5;
    out.rootOffset[1] += breath * 0.15;
  };
}

/**
 * Walk cycle. One full cycle is two steps; STRIDE_FRACTION is the ground
 * distance covered per cycle expressed as a fraction of body height, and it
 * is what the renderer uses to lock playback rate to ground speed.
 */
export const WALK_STRIDE_FRACTION = 0.82;

function walkCycle(intensity: number, strideScale: number) {
  return (u: number, out: Pose) => {
    const t = u * P * 2;
    const s = Math.sin(t);
    const c = Math.cos(t);
    const hipSwing = 0.46 * intensity * strideScale;
    const kneeBend = 0.75 * intensity;

    out.rot.fill(0);

    // Legs: thigh swings, knee bends mostly during the swing phase.
    out.rot[BoneIndex.thighL * 3] = -s * hipSwing;
    out.rot[BoneIndex.thighR * 3] = s * hipSwing;
    const kL = Math.max(0, -Math.sin(t - 0.7));
    const kR = Math.max(0, -Math.sin(t + P - 0.7));
    out.rot[BoneIndex.shinL * 3] = kL * kneeBend + 0.06;
    out.rot[BoneIndex.shinR * 3] = kR * kneeBend + 0.06;
    // Ankles keep the sole roughly parallel to the ground through contact.
    out.rot[BoneIndex.footL * 3] = -out.rot[BoneIndex.thighL * 3] * 0.45 - out.rot[BoneIndex.shinL * 3] * 0.55;
    out.rot[BoneIndex.footR * 3] = -out.rot[BoneIndex.thighR * 3] * 0.45 - out.rot[BoneIndex.shinR * 3] * 0.55;

    // Arms counter-swing.
    out.rot[BoneIndex.upArmL * 3] = s * 0.34 * intensity;
    out.rot[BoneIndex.upArmR * 3] = -s * 0.34 * intensity;
    out.rot[BoneIndex.upArmL * 3 + 2] = 0.1;
    out.rot[BoneIndex.upArmR * 3 + 2] = -0.1;
    out.rot[BoneIndex.loArmL * 3] = -0.28 - Math.max(0, s) * 0.34 * intensity;
    out.rot[BoneIndex.loArmR * 3] = -0.28 - Math.max(0, -s) * 0.34 * intensity;

    // Pelvis and torso: vertical bob at twice the step rate, plus a little
    // roll and counter-rotation. This is what stops a walk reading as a
    // rigid glide.
    out.rootOffset[0] = 0;
    out.rootOffset[1] = -0.012 * intensity * (1 - Math.cos(t * 2)) * 0.5 - 0.004 * intensity;
    out.rootOffset[2] = 0;
    out.rot[BoneIndex.root * 3 + 1] = -s * 0.09 * intensity;
    out.rot[BoneIndex.root * 3 + 2] = c * 0.045 * intensity;
    out.rot[BoneIndex.spine * 3 + 1] = s * 0.07 * intensity;
    out.rot[BoneIndex.chest * 3 + 1] = s * 0.05 * intensity;
    out.rot[BoneIndex.spine * 3] = -0.03;
    out.rot[BoneIndex.chest * 3] = 0.02;
    out.rot[BoneIndex.neck * 3] = 0.06;
  };
}

/** Idle: weight shifts and a slow breath. */
function idleCycle(u: number, out: Pose): void {
  out.rot.set(POSE_STAND.rot);
  out.rootOffset[0] = POSE_STAND.rootOffset[0];
  out.rootOffset[1] = POSE_STAND.rootOffset[1];
  out.rootOffset[2] = POSE_STAND.rootOffset[2];
  const t = u * P * 2;
  const sway = Math.sin(t);
  const breath = Math.sin(t * 2);
  out.rot[BoneIndex.root * 3 + 2] += sway * 0.022;
  out.rootOffset[0] += sway * 0.006;
  out.rootOffset[1] += breath * 0.0025;
  out.rot[BoneIndex.chest * 3] += breath * 0.012;
  out.rot[BoneIndex.neck * 3 + 1] += Math.sin(t * 0.5) * 0.09;
  out.rot[BoneIndex.upArmL * 3] += sway * 0.03;
  out.rot[BoneIndex.upArmR * 3] -= sway * 0.03;
}

/** Turning in place: a small stepping shuffle with the torso leading. */
function turnCycle(u: number, out: Pose): void {
  walkCycle(0.45, 0.5)(u, out);
  out.rot[BoneIndex.root * 3 + 1] += 0.12;
  out.rot[BoneIndex.neck * 3 + 1] += 0.1;
}

/** Taslim: the greeting turned to the right, then to the left. */
function taslimClip(u: number, out: Pose): void {
  out.rot.set(POSE_TASHAHHUD.rot);
  out.rootOffset[0] = POSE_TASHAHHUD.rootOffset[0];
  out.rootOffset[1] = POSE_TASHAHHUD.rootOffset[1];
  out.rootOffset[2] = POSE_TASHAHHUD.rootOffset[2];
  // Right first (the character's right is -X, so a negative Y rotation), then
  // left, then back to centre.
  let yaw = 0;
  if (u < 0.36) yaw = -ease(u / 0.36);
  else if (u < 0.5) yaw = -1;
  else if (u < 0.86) yaw = -1 + 2 * ease((u - 0.5) / 0.36);
  else yaw = 1 - ease((u - 0.86) / 0.14);
  out.rot[BoneIndex.neck * 3 + 1] += yaw * 0.62;
  out.rot[BoneIndex.head * 3 + 1] += yaw * 0.3;
  out.rot[BoneIndex.chest * 3 + 1] += yaw * 0.1;
}

export const CLIPS: ClipDef[] = (() => {
  const c: ClipDef[] = new Array(CLIP_COUNT);

  c[Clip.IDLE] = { frames: 36, loop: true, sample: idleCycle };
  c[Clip.WALK] = { frames: 28, loop: true, sample: walkCycle(1, 1) };
  c[Clip.SHUFFLE] = { frames: 28, loop: true, sample: walkCycle(0.55, 0.5) };
  c[Clip.TURN] = { frames: 24, loop: true, sample: turnCycle };

  c[Clip.TAKBIR] = { frames: 16, loop: false, sample: transition(POSE_QIYAM, POSE_TAKBIR) };
  c[Clip.QIYAM] = { frames: 30, loop: true, sample: hold(POSE_QIYAM) };
  c[Clip.TO_RUKU] = { frames: 16, loop: false, sample: transition(POSE_QIYAM, POSE_RUKU) };
  c[Clip.RUKU] = { frames: 24, loop: true, sample: hold(POSE_RUKU, 0.7) };
  c[Clip.FROM_RUKU] = { frames: 14, loop: false, sample: transition(POSE_RUKU, POSE_ITIDAL) };
  c[Clip.ITIDAL] = { frames: 24, loop: true, sample: hold(POSE_ITIDAL) };
  c[Clip.TO_SUJUD] = {
    frames: 20,
    loop: false,
    sample: transition(POSE_ITIDAL, POSE_SUJUD, POSE_DESCEND_MID),
  };
  c[Clip.SUJUD] = { frames: 24, loop: true, sample: hold(POSE_SUJUD, 0.5) };
  c[Clip.SUJUD_TO_JALSA] = { frames: 14, loop: false, sample: transition(POSE_SUJUD, POSE_JALSA) };
  c[Clip.JALSA] = { frames: 24, loop: true, sample: hold(POSE_JALSA, 0.6) };
  c[Clip.JALSA_TO_SUJUD] = { frames: 13, loop: false, sample: transition(POSE_JALSA, POSE_SUJUD) };
  c[Clip.SUJUD_TO_STAND] = {
    frames: 20,
    loop: false,
    sample: transition(POSE_SUJUD, POSE_QIYAM, POSE_RISE_MID),
  };
  c[Clip.TASHAHHUD] = { frames: 26, loop: true, sample: hold(POSE_TASHAHHUD, 0.6) };
  c[Clip.TASLIM] = { frames: 30, loop: false, sample: taslimClip };
  c[Clip.SIT_TO_STAND] = {
    frames: 20,
    loop: false,
    sample: transition(POSE_TASHAHHUD, POSE_STAND, POSE_RISE_MID),
  };

  for (let i = 0; i < CLIP_COUNT; i++) {
    if (!c[i]) throw new Error(`clip ${i} is undefined`);
  }
  return c;
})();

/** Total baked frames across every clip. */
export const TOTAL_FRAMES = CLIPS.reduce((a, c) => a + c.frames, 0);

/** First frame index of each clip inside the packed animation texture. */
export const CLIP_OFFSETS: Int32Array = (() => {
  const o = new Int32Array(CLIP_COUNT + 1);
  let acc = 0;
  for (let i = 0; i < CLIP_COUNT; i++) {
    o[i] = acc;
    acc += CLIPS[i].frames;
  }
  o[CLIP_COUNT] = acc;
  return o;
})();

export { _a as scratchPoseA, _b as scratchPoseB };
