/**
 * CrowdView.ts — the bridge between the simulation and the renderer.
 *
 * The simulation knows nothing about cameras and the renderer knows nothing
 * about agent states; this module is the only place that knows both. Each
 * frame it walks the live agents, interpolates them between the previous and
 * current simulation ticks, decides visibility and level of detail, resolves
 * clip phase into texture rows, and hands the result to the renderer.
 *
 * Interpolation matters here. The simulation runs on a fixed timestep that is
 * usually slower than the display refresh, so rendering raw simulation state
 * would judder. `alpha` is the fraction of a tick elapsed since the last one,
 * and every visible quantity — position and heading — is interpolated with it.
 */

import * as THREE from 'three';
import type { Crowd } from '../sim/Crowd.ts';
import type { AnimationDirector } from './AnimationDirector.ts';
import { CrowdRenderer, PALETTE_COUNT, clipFrame } from './CrowdRenderer.ts';
import { CLIPS, CLIP_OFFSETS } from './AnimationBank.ts';
import { CLIP_COUNT } from '../sim/States.ts';

const CLIP_FRAMES = new Int32Array(CLIP_COUNT);
const CLIP_LOOP = new Uint8Array(CLIP_COUNT);
for (let i = 0; i < CLIP_COUNT; i++) {
  CLIP_FRAMES[i] = CLIPS[i].frames;
  CLIP_LOOP[i] = CLIPS[i].loop ? 1 : 0;
}

/** Radius of the bounding sphere used for per-agent frustum culling. */
const AGENT_RADIUS = 1.2;

export class CrowdView {
  private readonly frustum = new THREE.Frustum();
  private readonly viewProj = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere(new THREE.Vector3(), AGENT_RADIUS);
  private readonly resolved = { f0: 0, f1: 0, frac: 0 };

  constructor(readonly renderer: CrowdRenderer) {}

  /**
   * @param alpha Fraction of a simulation tick elapsed, 0..1.
   */
  update(crowd: Crowd, director: AnimationDirector, camera: THREE.Camera, alpha: number): void {
    const r = this.renderer;
    const q = r.quality;
    r.beginFrame();

    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProj);

    const cam = camera.position;
    const ids = crowd.liveIdsView();
    const n = ids.length;

    const d0Sq = q.lod0Distance * q.lod0Distance;
    const d1Sq = q.lod1Distance * q.lod1Distance;

    let lod0Used = 0;
    let lod1Used = 0;
    let culled = 0;

    for (let k = 0; k < n; k++) {
      const id = ids[k];

      const x = crowd.prevX[id] + (crowd.px[id] - crowd.prevX[id]) * alpha;
      const z = crowd.prevZ[id] + (crowd.pz[id] - crowd.prevZ[id]) * alpha;
      const yaw = lerpAngle(crowd.prevYaw[id], crowd.yaw[id], alpha);

      this.sphere.center.set(x, 0.9, z);
      if (!this.frustum.intersectsSphere(this.sphere)) {
        culled++;
        continue;
      }

      const dx = x - cam.x;
      const dy = 0.9 - cam.y;
      const dz = z - cam.z;
      const distSq = dx * dx + dy * dy + dz * dz;

      let lod: number;
      if (distSq < d0Sq && lod0Used < q.lod0Budget) {
        lod = 0;
        lod0Used++;
      } else if (distSq < d1Sq && lod1Used < q.lod1Budget) {
        lod = 1;
        lod1Used++;
      } else {
        lod = 2;
      }

      // Current clip: two rows plus the fraction between them.
      resolveFrames(crowd.clip[id], crowd.clipTime[id], this.resolved);
      const f0 = this.resolved.f0;
      const f1 = this.resolved.f1;
      const frac = this.resolved.frac;

      // Outgoing clip: one nearest row. `clipBlend` runs 0 -> 1 as the new
      // clip takes over, so the renderer's weight for the old clip is 1 - that.
      const blend = 1 - crowd.clipBlend[id];
      let fB = f0;
      if (blend > 0.001) {
        fB = Math.round(clipFrame(crowd.prevClip[id], director.prevClipTime[id]));
        const pc = crowd.prevClip[id];
        const last = CLIP_OFFSETS[pc] + CLIP_FRAMES[pc] - 1;
        if (fB > last) fB = last;
        if (fB < CLIP_OFFSETS[pc]) fB = CLIP_OFFSETS[pc];
      }

      r.submit(
        lod,
        x,
        0,
        z,
        yaw,
        crowd.height[id],
        crowd.build[id],
        f0,
        f1,
        frac,
        fB,
        blend,
        crowd.garment[id] % PALETTE_COUNT,
        brightness(id),
      );
    }

    r.stats.culled = culled;
    r.endFrame();
  }
}

/**
 * Resolve a clip and normalised phase into two adjacent absolute texture rows
 * and the weight between them. Looping clips wrap inside their own range;
 * one-shot clips clamp at their last frame. Neither ever reads a row that
 * belongs to a different clip.
 */
export function resolveFrames(
  clip: number,
  t01: number,
  out: { f0: number; f1: number; frac: number },
): void {
  const frames = CLIP_FRAMES[clip];
  const base = CLIP_OFFSETS[clip];
  if (CLIP_LOOP[clip] === 1) {
    let t = t01 % 1;
    if (t < 0) t += 1;
    const f = t * frames;
    let i0 = Math.floor(f);
    if (i0 >= frames) i0 = frames - 1;
    out.frac = f - i0;
    out.f0 = base + i0;
    out.f1 = base + ((i0 + 1) % frames);
  } else {
    const t = t01 < 0 ? 0 : t01 > 1 ? 1 : t01;
    const f = t * (frames - 1);
    let i0 = Math.floor(f);
    if (i0 > frames - 2) i0 = Math.max(0, frames - 2);
    out.frac = frames > 1 ? f - i0 : 0;
    out.f0 = base + i0;
    out.f1 = base + Math.min(frames - 1, i0 + 1);
  }
}

/** Stable per-agent brightness jitter so a white crowd is not a flat sheet. */
function brightness(id: number): number {
  let x = (id + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x ^= x >>> 13;
  return 0.9 + ((x >>> 0) % 1000) / 1000 * 0.16;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
