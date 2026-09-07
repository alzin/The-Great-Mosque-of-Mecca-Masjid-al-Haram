/**
 * solve-poses.ts — fits the salah postures to physical constraints.
 *
 * WHY THIS EXISTS
 *   The postures were first authored by hand from anatomical reasoning, and
 *   they were wrong in a way that is easy to make and hard to see: a positive
 *   X rotation tilts an UPWARD-pointing bone (the spine chain) forward, but
 *   swings a DOWNWARD-pointing bone (arms, legs) backward. Signs that looked
 *   consistent on the page produced a ruku that bowed backwards and a sujud
 *   that levitated.
 *
 *   Angles are the wrong thing to author by hand anyway. What is actually
 *   known about these postures is where the BODY has to be: the forehead,
 *   the palms, the knees and the toes are on the ground in sujud; the shins
 *   are on the ground and the hips are on the heels in jalsa; the back is
 *   near level in ruku. So this states those positions and solves for the
 *   angles that satisfy them, by coordinate descent with shrinking steps
 *   over a hand-chosen set of degrees of freedom, with joint limits and a
 *   weak pull toward a neutral pose to keep the solutions anatomical.
 *
 *   The result is printed as a ready-to-paste pose specification. It is run
 *   as a tool, not at start-up: the output is committed to AnimationBank.ts
 *   so the application has no solver in it.
 *
 * Run: node --experimental-strip-types tools/solve-poses.ts
 */

import { BONES, BoneIndex, RigEvaluator } from '../src/characters/Rig.ts';
import type { Pose } from '../src/characters/Rig.ts';

const BONE_COUNT = BONES.length;
const ev = new RigEvaluator();
const scratch: [number, number, number] = [0, 0, 0];

type Axis = 0 | 1 | 2;

interface Dof {
  /** Bone name, or 'rootOffset'. */
  bone: string;
  axis: Axis;
  min: number;
  max: number;
  /** Starting value. */
  init?: number;
  /** Mirror onto this bone with these axis sign flips. */
  mirror?: string;
  mirrorSign?: [number, number, number];
}

interface Target {
  joint: string;
  /** Any of x, y, z may be omitted when unconstrained. */
  x?: number;
  y?: number;
  z?: number;
  weight?: number;
}

interface Problem {
  name: string;
  dofs: Dof[];
  targets: Target[];
  /** Extra fixed angles applied before solving. */
  fixed?: Record<string, [number, number, number]>;
  rootOffset?: [number, number, number];
  solveRootY?: boolean;
  solveRootZ?: boolean;
}

function emptyPose(): Pose {
  return { rot: new Float32Array(BONE_COUNT * 3), rootOffset: [0, 0, 0] };
}

function applyDofs(pose: Pose, dofs: Dof[], values: number[]): void {
  pose.rot.fill(0);
  for (let i = 0; i < dofs.length; i++) {
    const d = dofs[i];
    const v = values[i];
    if (d.bone === 'rootOffset') {
      pose.rootOffset[d.axis] = v;
      continue;
    }
    const bi = BoneIndex[d.bone];
    pose.rot[bi * 3 + d.axis] = v;
    if (d.mirror) {
      const mi = BoneIndex[d.mirror];
      const sign = d.mirrorSign ?? [1, -1, -1];
      pose.rot[mi * 3 + d.axis] = v * sign[d.axis];
    }
  }
}

function cost(pose: Pose, problem: Problem, values: number[], dofs: Dof[]): number {
  ev.evaluate(pose);
  let c = 0;
  for (const t of problem.targets) {
    ev.jointPosition(BoneIndex[t.joint], scratch);
    const w = t.weight ?? 1;
    if (t.x !== undefined) c += w * (scratch[0] - t.x) ** 2;
    if (t.y !== undefined) c += w * (scratch[1] - t.y) ** 2;
    if (t.z !== undefined) c += w * (scratch[2] - t.z) ** 2;
  }
  // Nothing may go through the floor. Without this the solver is happy to
  // bury an elbow in the marble to satisfy a hand target.
  for (let i = 0; i < BONE_COUNT; i++) {
    ev.jointPosition(i, scratch);
    if (scratch[1] < 0.012) c += 40 * (0.012 - scratch[1]) ** 2;
  }

  // Weak regularisation: prefer the smallest angles that do the job.
  for (let i = 0; i < values.length; i++) {
    if (dofs[i].bone === 'rootOffset') continue;
    c += 2e-5 * values[i] * values[i];
  }
  return c;
}

function solve(problem: Problem): { pose: Pose; values: number[]; cost: number } {
  const dofs = problem.dofs;
  const values = dofs.map((d) => d.init ?? 0);
  const pose = emptyPose();

  const evaluate = (v: number[]): number => {
    applyDofs(pose, dofs, v);
    if (problem.fixed) {
      for (const [name, rot] of Object.entries(problem.fixed)) {
        const bi = BoneIndex[name];
        pose.rot[bi * 3] = rot[0];
        pose.rot[bi * 3 + 1] = rot[1];
        pose.rot[bi * 3 + 2] = rot[2];
      }
    }
    return cost(pose, problem, v, dofs);
  };

  let best = evaluate(values);
  let step = 0.35;
  for (let pass = 0; pass < 260; pass++) {
    let improved = false;
    for (let i = 0; i < dofs.length; i++) {
      const d = dofs[i];
      for (const dir of [1, -1]) {
        const original = values[i];
        const candidate = Math.min(d.max, Math.max(d.min, original + dir * step));
        if (candidate === original) continue;
        values[i] = candidate;
        const c = evaluate(values);
        if (c < best - 1e-12) {
          best = c;
          improved = true;
        } else {
          values[i] = original;
        }
      }
    }
    if (!improved) {
      step *= 0.6;
      if (step < 1e-4) break;
    }
  }
  evaluate(values);
  return { pose, values, cost: best };
}

// ---------------------------------------------------------------------------
// The postures
// ---------------------------------------------------------------------------

const armDofs = (prefix: 'L' | 'R' = 'L'): Dof[] => {
  const other = prefix === 'L' ? 'R' : 'L';
  return [
    { bone: `upArm${prefix}`, axis: 0, min: -2.6, max: 1.6, mirror: `upArm${other}` },
    { bone: `upArm${prefix}`, axis: 2, min: -1.2, max: 1.2, init: 0.25, mirror: `upArm${other}` },
    { bone: `loArm${prefix}`, axis: 0, min: -2.7, max: 0.1, mirror: `loArm${other}` },
    { bone: `loArm${prefix}`, axis: 2, min: -1.0, max: 1.0, mirror: `loArm${other}` },
  ];
};

/** Pelvis hinge. In this rig the root IS the pelvis, so tilting it is what
 *  produces the hip flexion that dominates bowing and prostration. */
const pelvisDof: Dof = { bone: 'root', axis: 0, min: -0.25, max: 1.4 };

const legDofs: Dof[] = [
  { bone: 'thighL', axis: 0, min: -2.4, max: 1.6, mirror: 'thighR' },
  { bone: 'shinL', axis: 0, min: -0.2, max: 2.9, mirror: 'shinR' },
  { bone: 'footL', axis: 0, min: -1.6, max: 1.0, mirror: 'footR' },
];

/**
 * Standing postures: the trunk is essentially upright, so the spine is given
 * very little freedom. Without this the solver happily leans the whole torso
 * back to satisfy a hand target, which is anatomically silly and looks it.
 */
const uprightSpineDofs: Dof[] = [
  { bone: 'spine', axis: 0, min: -0.06, max: 0.14 },
  { bone: 'chest', axis: 0, min: -0.06, max: 0.14 },
  { bone: 'neck', axis: 0, min: -0.1, max: 0.3 },
  { bone: 'head', axis: 0, min: -0.25, max: 0.25 },
];

/**
 * Bowing and prostrating. `spine` is the first bone above the root, so in
 * this rig it carries the HIP flexion as well as the lumbar bend; in sujud
 * the hip is flexed to about 120 degrees, which is why its range has to be
 * so much larger than a spine's would be.
 */
const foldSpineDofs: Dof[] = [
  { bone: 'spine', axis: 0, min: -0.2, max: 1.85 },
  { bone: 'chest', axis: 0, min: -0.2, max: 1.15 },
  { bone: 'neck', axis: 0, min: -0.5, max: 1.0 },
  { bone: 'head', axis: 0, min: -0.5, max: 0.9 },
];

const problems: Problem[] = [
  {
    name: 'POSE_QIYAM',
    dofs: [...uprightSpineDofs, ...armDofs()],
    targets: [
      { joint: 'head', y: 0.928, z: 0.02 },
      // Right hand over left, resting on the abdomen just above the navel.
      { joint: 'handL', x: 0.028, y: 0.545, z: 0.115, weight: 3 },
      { joint: 'loArmL', y: 0.63, z: 0.03, weight: 0.5 },
    ],
  },
  {
    name: 'POSE_TAKBIR',
    dofs: [...uprightSpineDofs, ...armDofs()],
    targets: [
      { joint: 'head', y: 0.928, z: 0.01 },
      // Hands up beside the head, roughly level with the ears.
      { joint: 'handL', x: 0.145, y: 0.845, z: 0.09, weight: 3 },
      { joint: 'loArmL', x: 0.15, y: 0.68, z: 0.06, weight: 0.15 },
    ],
  },
  {
    name: 'POSE_RUKU',
    dofs: [pelvisDof, ...foldSpineDofs, ...armDofs(), ...legDofs],
    solveRootY: true,
    solveRootZ: true,
    targets: [
      // Back near level: the shoulders drop to about hip height and go
      // forward, the head continues the line of the back.
      { joint: 'neck', y: 0.6, z: 0.3, weight: 2 },
      { joint: 'head', y: 0.585, z: 0.37 },
      // Hands grasp the knees.
      { joint: 'handL', x: 0.085, y: 0.3, z: 0.09, weight: 2 },
      // Legs stay straight and planted.
      { joint: 'shinL', y: 0.265, z: 0.0, weight: 3 },
      { joint: 'footL', y: 0.039, z: 0.0, weight: 4 },
    ],
  },
  {
    name: 'POSE_ITIDAL',
    dofs: [...uprightSpineDofs, ...armDofs()],
    targets: [
      { joint: 'head', y: 0.928, z: 0.005 },
      { joint: 'handL', x: 0.118, y: 0.5, z: 0.03, weight: 2 },
    ],
  },
  {
    name: 'POSE_SUJUD',
    dofs: [pelvisDof, ...foldSpineDofs, ...armDofs(), ...legDofs],
    solveRootY: true,
    solveRootZ: true,
    targets: [
      // Forehead on the ground, ahead of the knees.
      { joint: 'head', y: 0.085, z: 0.3, weight: 8 },
      // Soft only: the torso curves, so a straight-line neck target would
      // fight the head target rather than help it.
      { joint: 'neck', y: 0.14, z: 0.235, weight: 0.25 },
      // Palms on the ground either side of the head.
      { joint: 'handL', x: 0.115, y: 0.045, z: 0.315, weight: 3 },
      // Knees on the ground, hips raised above them, shins back, toes under.
      { joint: 'shinL', y: 0.032, z: 0.0, weight: 5 },
      { joint: 'footL', y: 0.05, z: -0.215, weight: 4 },
      { joint: 'root', y: 0.26, z: -0.055, weight: 3 },
    ],
  },
  {
    name: 'POSE_JALSA',
    dofs: [pelvisDof, ...uprightSpineDofs, ...armDofs(), ...legDofs],
    solveRootY: true,
    solveRootZ: true,
    targets: [
      // Sitting back on the heels: knees forward on the ground, hips low.
      { joint: 'shinL', y: 0.032, z: 0.19, weight: 5 },
      { joint: 'footL', y: 0.045, z: -0.035, weight: 4 },
      { joint: 'root', y: 0.16, z: -0.02, weight: 4 },
      // Torso upright.
      { joint: 'head', y: 0.575, z: 0.0, weight: 2 },
      // Hands resting on the thighs.
      { joint: 'handL', x: 0.1, y: 0.215, z: 0.13, weight: 2 },
    ],
  },
  {
    name: 'POSE_TASHAHHUD',
    dofs: [pelvisDof, ...uprightSpineDofs, ...armDofs(), ...legDofs],
    solveRootY: true,
    solveRootZ: true,
    targets: [
      { joint: 'shinL', y: 0.032, z: 0.19, weight: 5 },
      { joint: 'footL', y: 0.045, z: -0.035, weight: 4 },
      { joint: 'root', y: 0.155, z: -0.025, weight: 4 },
      { joint: 'head', y: 0.572, z: 0.005, weight: 2 },
      { joint: 'handL', x: 0.098, y: 0.212, z: 0.145, weight: 2 },
    ],
  },
];

// ---------------------------------------------------------------------------

const H = 174;
let worst = 0;

for (const problem of problems) {
  if (problem.solveRootY) {
    problem.dofs = [
      { bone: 'rootOffset', axis: 1, min: -0.42, max: 0.05, init: -0.1 },
      ...problem.dofs,
    ];
  }
  if (problem.solveRootZ) {
    problem.dofs = [
      { bone: 'rootOffset', axis: 2, min: -0.2, max: 0.2, init: 0 },
      ...problem.dofs,
    ];
  }

  const { pose, cost: c } = solve(problem);
  ev.evaluate(pose);

  console.log(`\n// ${problem.name}  (residual ${(Math.sqrt(c) * H).toFixed(2)} cm)`);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < BONE_COUNT; i++) {
    const r = [pose.rot[i * 3], pose.rot[i * 3 + 1], pose.rot[i * 3 + 2]];
    if (r.every((v) => Math.abs(v) < 1e-4)) continue;
    if (seen.has(BONES[i].name)) continue;
    seen.add(BONES[i].name);
    lines.push(`  ${BONES[i].name}: [${r.map((v) => v.toFixed(3)).join(', ')}],`);
  }
  if (pose.rootOffset.some((v) => Math.abs(v) > 1e-4)) {
    lines.unshift(`  rootOffset: [${pose.rootOffset.map((v) => v.toFixed(3)).join(', ')}],`);
  }
  console.log(`export const ${problem.name} = makePose({\n${lines.join('\n')}\n});`);

  console.log('  // achieved:');
  for (const t of problem.targets) {
    ev.jointPosition(BoneIndex[t.joint], scratch);
    const parts: string[] = [];
    let err = 0;
    if (t.x !== undefined) {
      parts.push(`x ${(scratch[0] * H).toFixed(1)}/${(t.x * H).toFixed(1)}`);
      err = Math.max(err, Math.abs(scratch[0] - t.x));
    }
    if (t.y !== undefined) {
      parts.push(`y ${(scratch[1] * H).toFixed(1)}/${(t.y * H).toFixed(1)}`);
      err = Math.max(err, Math.abs(scratch[1] - t.y));
    }
    if (t.z !== undefined) {
      parts.push(`z ${(scratch[2] * H).toFixed(1)}/${(t.z * H).toFixed(1)}`);
      err = Math.max(err, Math.abs(scratch[2] - t.z));
    }
    worst = Math.max(worst, err);
    console.log(`  //   ${t.joint.padEnd(8)} ${parts.join('  ')}   (err ${(err * H).toFixed(1)} cm)`);
  }
}

console.log(`\n// worst single-axis residual across all postures: ${(worst * H).toFixed(1)} cm`);
