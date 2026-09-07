/**
 * VertexAnimationTexture.ts — bakes the whole animation bank into textures.
 *
 * WHY THIS APPROACH
 *   Three.js `InstancedMesh` does NOT give independent skeletal animation:
 *   a SkinnedMesh has one skeleton, and instancing it would make every copy
 *   move identically. To get thousands of independently animated people in a
 *   handful of draw calls, we bake linear-blend skinning on the CPU once at
 *   start-up and store the resulting vertex positions in a texture:
 *
 *     texel (vertexIndex, frameIndex) -> posed vertex position
 *
 *   The vertex shader then reads its own vertex's position for whatever
 *   frame that particular instance is on. Every instance can be on a
 *   different clip at a different phase, and it is still one draw call per
 *   LOD. Bake cost is a few hundred thousand vector transforms, which is
 *   milliseconds, and it happens before the first frame is presented.
 *
 * LAYOUT
 *   Position texture: RGBA32F, width = vertexCount, height = totalFrames.
 *   Normal texture:   RGBA8,   same dimensions, normal * 0.5 + 0.5.
 *   Positions are in HEIGHT-FRACTION space; the shader scales per instance.
 */

import * as THREE from 'three';
import { BONE_COUNT, RigEvaluator, createPose } from './Rig.ts';
import { CLIPS, CLIP_OFFSETS, TOTAL_FRAMES } from './AnimationBank.ts';
import type { MeshData } from './CharacterMesh.ts';
import { CLIP_COUNT } from '../sim/States.ts';

export interface BakedAnimation {
  positionTexture: THREE.DataTexture;
  normalTexture: THREE.DataTexture;
  vertexCount: number;
  frameCount: number;
  /** Bytes of GPU memory used by the two textures. */
  bytes: number;
  /** Wall-clock time the bake took, milliseconds. */
  bakeMs: number;
  /** Min/max Y in height-fraction space, for bounding boxes. */
  minY: number;
  maxY: number;
}

/**
 * Bake one mesh against the whole clip bank.
 */
export function bakeVertexAnimation(mesh: MeshData): BakedAnimation {
  const t0 = (globalThis.performance ?? Date).now();
  const vertexCount = mesh.vertexCount;
  const frameCount = TOTAL_FRAMES;

  const posData = new Float32Array(vertexCount * frameCount * 4);
  const nrmData = new Uint8Array(vertexCount * frameCount * 4);

  const evaluator = new RigEvaluator();
  const pose = createPose();
  const skin = evaluator.skin;

  let minY = Infinity;
  let maxY = -Infinity;

  for (let clip = 0; clip < CLIP_COUNT; clip++) {
    const def = CLIPS[clip];
    const base = CLIP_OFFSETS[clip];
    for (let f = 0; f < def.frames; f++) {
      // For a looping clip the last frame must not duplicate the first, so
      // sample over [0, 1) rather than [0, 1].
      const u = def.loop ? f / def.frames : f / Math.max(1, def.frames - 1);
      pose.rot.fill(0);
      pose.rootOffset[0] = 0;
      pose.rootOffset[1] = 0;
      pose.rootOffset[2] = 0;
      def.sample(u, pose);
      evaluator.evaluate(pose);

      const row = (base + f) * vertexCount;
      for (let v = 0; v < vertexCount; v++) {
        const px = mesh.position[v * 3];
        const py = mesh.position[v * 3 + 1];
        const pz = mesh.position[v * 3 + 2];
        const nx = mesh.normal[v * 3];
        const ny = mesh.normal[v * 3 + 1];
        const nz = mesh.normal[v * 3 + 2];

        const i0 = mesh.skinIndex[v * 2] * 12;
        const i1 = mesh.skinIndex[v * 2 + 1] * 12;
        const w0 = mesh.skinWeight[v * 2];
        const w1 = mesh.skinWeight[v * 2 + 1];

        // Linear blend skinning, two influences.
        const ox =
          w0 * (skin[i0] * px + skin[i0 + 1] * py + skin[i0 + 2] * pz + skin[i0 + 3]) +
          w1 * (skin[i1] * px + skin[i1 + 1] * py + skin[i1 + 2] * pz + skin[i1 + 3]);
        const oy =
          w0 * (skin[i0 + 4] * px + skin[i0 + 5] * py + skin[i0 + 6] * pz + skin[i0 + 7]) +
          w1 * (skin[i1 + 4] * px + skin[i1 + 5] * py + skin[i1 + 6] * pz + skin[i1 + 7]);
        const oz =
          w0 * (skin[i0 + 8] * px + skin[i0 + 9] * py + skin[i0 + 10] * pz + skin[i0 + 11]) +
          w1 * (skin[i1 + 8] * px + skin[i1 + 9] * py + skin[i1 + 10] * pz + skin[i1 + 11]);

        // Normals use the rotation part only.
        let mx =
          w0 * (skin[i0] * nx + skin[i0 + 1] * ny + skin[i0 + 2] * nz) +
          w1 * (skin[i1] * nx + skin[i1 + 1] * ny + skin[i1 + 2] * nz);
        let my =
          w0 * (skin[i0 + 4] * nx + skin[i0 + 5] * ny + skin[i0 + 6] * nz) +
          w1 * (skin[i1 + 4] * nx + skin[i1 + 5] * ny + skin[i1 + 6] * nz);
        let mz =
          w0 * (skin[i0 + 8] * nx + skin[i0 + 9] * ny + skin[i0 + 10] * nz) +
          w1 * (skin[i1 + 8] * nx + skin[i1 + 9] * ny + skin[i1 + 10] * nz);
        const ml = Math.hypot(mx, my, mz) || 1;
        mx /= ml;
        my /= ml;
        mz /= ml;

        const p = (row + v) * 4;
        posData[p] = ox;
        posData[p + 1] = oy;
        posData[p + 2] = oz;
        posData[p + 3] = 1;
        nrmData[p] = Math.round((mx * 0.5 + 0.5) * 255);
        nrmData[p + 1] = Math.round((my * 0.5 + 0.5) * 255);
        nrmData[p + 2] = Math.round((mz * 0.5 + 0.5) * 255);
        nrmData[p + 3] = 255;

        if (oy < minY) minY = oy;
        if (oy > maxY) maxY = oy;
      }
    }
  }

  const positionTexture = new THREE.DataTexture(
    posData,
    vertexCount,
    frameCount,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  positionTexture.minFilter = THREE.NearestFilter;
  positionTexture.magFilter = THREE.NearestFilter;
  positionTexture.wrapS = THREE.ClampToEdgeWrapping;
  positionTexture.wrapT = THREE.ClampToEdgeWrapping;
  positionTexture.generateMipmaps = false;
  positionTexture.needsUpdate = true;

  const normalTexture = new THREE.DataTexture(
    nrmData,
    vertexCount,
    frameCount,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  normalTexture.minFilter = THREE.NearestFilter;
  normalTexture.magFilter = THREE.NearestFilter;
  normalTexture.wrapS = THREE.ClampToEdgeWrapping;
  normalTexture.wrapT = THREE.ClampToEdgeWrapping;
  normalTexture.generateMipmaps = false;
  normalTexture.needsUpdate = true;

  const t1 = (globalThis.performance ?? Date).now();

  return {
    positionTexture,
    normalTexture,
    vertexCount,
    frameCount,
    bytes: posData.byteLength + nrmData.byteLength,
    bakeMs: t1 - t0,
    minY,
    maxY,
  };
}

/**
 * Headless variant used by the tests: returns the raw arrays without touching
 * any Three.js texture object, so it can run in Node.
 */
export function bakeRaw(mesh: MeshData): {
  positions: Float32Array;
  vertexCount: number;
  frameCount: number;
} {
  const vertexCount = mesh.vertexCount;
  const frameCount = TOTAL_FRAMES;
  const out = new Float32Array(vertexCount * frameCount * 3);
  const evaluator = new RigEvaluator();
  const pose = createPose();
  const skin = evaluator.skin;

  for (let clip = 0; clip < CLIP_COUNT; clip++) {
    const def = CLIPS[clip];
    const base = CLIP_OFFSETS[clip];
    for (let f = 0; f < def.frames; f++) {
      const u = def.loop ? f / def.frames : f / Math.max(1, def.frames - 1);
      pose.rot.fill(0);
      pose.rootOffset[0] = 0;
      pose.rootOffset[1] = 0;
      pose.rootOffset[2] = 0;
      def.sample(u, pose);
      evaluator.evaluate(pose);
      const row = (base + f) * vertexCount;
      for (let v = 0; v < vertexCount; v++) {
        const px = mesh.position[v * 3];
        const py = mesh.position[v * 3 + 1];
        const pz = mesh.position[v * 3 + 2];
        const i0 = mesh.skinIndex[v * 2] * 12;
        const i1 = mesh.skinIndex[v * 2 + 1] * 12;
        const w0 = mesh.skinWeight[v * 2];
        const w1 = mesh.skinWeight[v * 2 + 1];
        const o = (row + v) * 3;
        out[o] =
          w0 * (skin[i0] * px + skin[i0 + 1] * py + skin[i0 + 2] * pz + skin[i0 + 3]) +
          w1 * (skin[i1] * px + skin[i1 + 1] * py + skin[i1 + 2] * pz + skin[i1 + 3]);
        out[o + 1] =
          w0 * (skin[i0 + 4] * px + skin[i0 + 5] * py + skin[i0 + 6] * pz + skin[i0 + 7]) +
          w1 * (skin[i1 + 4] * px + skin[i1 + 5] * py + skin[i1 + 6] * pz + skin[i1 + 7]);
        out[o + 2] =
          w0 * (skin[i0 + 8] * px + skin[i0 + 9] * py + skin[i0 + 10] * pz + skin[i0 + 11]) +
          w1 * (skin[i1 + 8] * px + skin[i1 + 9] * py + skin[i1 + 10] * pz + skin[i1 + 11]);
      }
    }
  }
  return { positions: out, vertexCount, frameCount };
}

export { BONE_COUNT };
