/**
 * pose-check.ts — numeric validation of the salah postures.
 *
 * Screenshots tell you a posture is wrong; they are a slow way to work out by
 * how much. This prints the world position of every joint that has a physical
 * constraint attached to it, so a pose can be corrected against numbers
 * instead of by eye:
 *
 *   sujud   — forehead, both palms, both knees and the toes all on the ground
 *   jalsa   — shins on the ground, hips resting on the heels, torso upright
 *   ruku    — back near horizontal, hands at about knee height
 *   qiyam   — everything at rest height, feet flat
 *
 * Run: node --experimental-strip-types tools/pose-check.ts
 */

import { BONES, BoneIndex, RigEvaluator, createPose } from '../src/characters/Rig.ts';
import {
  POSE_QIYAM,
  POSE_TAKBIR,
  POSE_RUKU,
  POSE_ITIDAL,
  POSE_SUJUD,
  POSE_JALSA,
  POSE_TASHAHHUD,
} from '../src/characters/AnimationBank.ts';
import type { Pose } from '../src/characters/Rig.ts';

const ev = new RigEvaluator();
const p: [number, number, number] = [0, 0, 0];

/** Body height used to report figures in centimetres. */
const H = 174;

function joints(pose: Pose): Record<string, [number, number, number]> {
  ev.evaluate(pose);
  const out: Record<string, [number, number, number]> = {};
  for (let i = 0; i < BONES.length; i++) {
    ev.jointPosition(i, p);
    out[BONES[i].name] = [p[0], p[1], p[2]];
  }
  return out;
}

function cm(v: number): string {
  return (v * H).toFixed(1).padStart(7);
}

const checks: Array<{
  name: string;
  pose: Pose;
  /** joint -> [expected y in height fractions, tolerance] */
  expect: Array<[string, number, number, string]>;
}> = [
  {
    name: 'qiyam',
    pose: POSE_QIYAM,
    expect: [
      ['footL', 0.039, 0.02, 'foot on the ground'],
      ['head', 0.93, 0.04, 'head at standing height'],
    ],
  },
  {
    name: 'takbir',
    pose: POSE_TAKBIR,
    expect: [
      ['handL', 0.78, 0.09, 'hands near shoulder height'],
      ['footL', 0.039, 0.02, 'foot on the ground'],
    ],
  },
  {
    name: 'ruku',
    pose: POSE_RUKU,
    expect: [
      ['neck', 0.62, 0.09, 'shoulders at about hip height'],
      ['handL', 0.34, 0.1, 'hands at about knee height'],
      ['footL', 0.039, 0.03, 'foot on the ground'],
    ],
  },
  {
    name: 'itidal',
    pose: POSE_ITIDAL,
    expect: [
      ['head', 0.93, 0.04, 'upright again'],
      ['footL', 0.039, 0.02, 'foot on the ground'],
    ],
  },
  {
    name: 'sujud',
    pose: POSE_SUJUD,
    expect: [
      ['head', 0.075, 0.05, 'forehead on the ground'],
      ['handL', 0.045, 0.05, 'palms on the ground'],
      ['shinL', 0.035, 0.045, 'knees on the ground'],
      ['footL', 0.03, 0.05, 'toes turned under, on the ground'],
      ['root', 0.3, 0.1, 'hips raised above the knees'],
    ],
  },
  {
    name: 'jalsa',
    pose: POSE_JALSA,
    expect: [
      ['shinL', 0.035, 0.045, 'knees on the ground'],
      ['footL', 0.04, 0.05, 'feet under the body'],
      ['root', 0.16, 0.06, 'sitting back on the heels'],
      ['head', 0.6, 0.08, 'torso upright while seated'],
    ],
  },
  {
    name: 'tashahhud',
    pose: POSE_TASHAHHUD,
    expect: [
      ['shinL', 0.035, 0.045, 'knees on the ground'],
      ['root', 0.16, 0.06, 'sitting back on the heels'],
      ['head', 0.6, 0.08, 'torso upright while seated'],
    ],
  },
];

let failures = 0;
const interesting = ['root', 'chest', 'neck', 'head', 'handL', 'thighL', 'shinL', 'footL'];

for (const c of checks) {
  const j = joints(c.pose);
  console.log(`\n--- ${c.name} ---`);
  console.log('   joint        x(cm)   y(cm)   z(cm)');
  for (const name of interesting) {
    const v = j[name];
    console.log(`   ${name.padEnd(8)} ${cm(v[0])} ${cm(v[1])} ${cm(v[2])}`);
  }
  for (const [name, want, tol, why] of c.expect) {
    const got = j[name][1];
    const ok = Math.abs(got - want) <= tol;
    if (!ok) failures++;
    console.log(
      `   ${ok ? 'ok  ' : 'FAIL'} ${name} y=${(got * H).toFixed(1)}cm want ${(want * H).toFixed(1)}\u00b1${(tol * H).toFixed(1)}cm  (${why})`,
    );
  }
}

// The lowest point of the skeleton should never be far below zero: an
// underground joint means the whole figure is sinking through the marble.
for (const c of checks) {
  const j = joints(c.pose);
  let lowest = Infinity;
  let which = '';
  for (const [name, v] of Object.entries(j)) {
    if (v[1] < lowest) {
      lowest = v[1];
      which = name;
    }
  }
  if (lowest < -0.02) {
    failures++;
    console.log(`\nFAIL ${c.name}: ${which} is ${(lowest * H).toFixed(1)} cm below the floor`);
  }
}

console.log(`\n${failures === 0 ? 'All posture constraints satisfied.' : `${failures} constraint(s) violated.`}`);
void createPose;
void BoneIndex;
process.exit(failures > 0 ? 1 : 0);
