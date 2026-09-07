/**
 * characterPreview.ts — a development harness, not part of the application.
 *
 * The whole point of the crowd renderer is that thousands of people cost
 * almost nothing. The risk of that approach is that a mistake in the rig, the
 * skinning weights or a posture is invisible at broadcast distance and yet
 * completely wrong. So before scaling up, this page draws exactly ONE person,
 * two metres tall on the screen, through the whole clip bank, using the same
 * baked animation texture and the same instanced shader the crowd uses.
 *
 * Served only by the dev server; excluded from the production build.
 */

import * as THREE from 'three';
import { CrowdRenderer, clipFrame } from '../characters/CrowdRenderer.ts';
import { CLIP_NAMES, CLIP_COUNT } from '../sim/States.ts';
import { CLIPS } from '../characters/AnimationBank.ts';

const label = document.getElementById('label')!;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2b3036);

const camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.1, 60);

scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x40382c, 1.5));
const key = new THREE.DirectionalLight(0xfff0dc, 2.4);
key.position.set(3, 5, 4);
scene.add(key);
const rim = new THREE.DirectionalLight(0x8fb4ff, 1.1);
rim.position.set(-4, 2.5, -3);
scene.add(rim);

// A ground plane so contact with the floor is visible.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(12, 12).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x8d8f92, roughness: 0.9 }),
);
scene.add(ground);

// Reference grid at 0.25 m so proportions can be checked by eye.
const grid = new THREE.GridHelper(8, 32, 0x556070, 0x3c444e);
grid.position.y = 0.002;
scene.add(grid);

const crowd = new CrowdRenderer(32, {
  lod0Budget: 32,
  lod1Budget: 32,
  lod0Distance: 1000,
  lod1Distance: 2000,
  blobShadows: false,
});
scene.add(crowd.group);

const params = new URLSearchParams(location.search);
/** Fixed clip index, or -1 to cycle through all of them. */
const fixedClip = params.has('clip') ? Number(params.get('clip')) : -1;
/** Fixed phase within the clip, or -1 to animate. */
const fixedPhase = params.has('phase') ? Number(params.get('phase')) : -1;
const gridMode = params.has('grid');
const azimuth = params.has('az') ? Number(params.get('az')) : 0.55;

let clip = fixedClip >= 0 ? fixedClip : 0;
let phase = 0;
let clipTimer = 0;

const HEIGHT = 1.74;

function layout(): void {
  if (gridMode) {
    // Every clip at once, laid out in a grid, for a single overview shot.
    camera.position.set(0, 4.4, 12.0);
    camera.lookAt(0, 1.0, 0);
  } else {
    const r = 4.4;
    camera.position.set(Math.sin(azimuth) * r, 1.35, Math.cos(azimuth) * r);
    camera.lookAt(0, 0.92, 0);
  }
  camera.updateMatrixWorld();
}

function submitOne(x: number, z: number, clipIndex: number, u: number): void {
  const def = CLIPS[clipIndex];
  const frames = def.frames;
  const base = clipFrame(clipIndex, u);
  const f0 = Math.floor(base);
  const frac = base - f0;
  const firstRow = clipFrame(clipIndex, 0);
  const lastRow = firstRow + frames - 1;
  const f1 = def.loop
    ? f0 + 1 > lastRow
      ? firstRow
      : f0 + 1
    : Math.min(lastRow, f0 + 1);
  crowd.submit(0, x, 0, z, 0, HEIGHT, 1, f0, f1, frac, f0, 0, 2, 1);
}

function frame(nowMs: number): void {
  requestAnimationFrame(frame);
  const t = nowMs / 1000;

  crowd.beginFrame();

  if (gridMode) {
    const cols = 5;
    for (let i = 0; i < CLIP_COUNT; i++) {
      const cx = (i % cols) - (cols - 1) / 2;
      const cz = Math.floor(i / cols) - 1.5;
      const u = fixedPhase >= 0 ? fixedPhase : CLIPS[i].loop ? (t * 0.5) % 1 : 1;
      submitOne(cx * 1.35, cz * 1.7, i, u);
    }
  } else {
    if (fixedClip < 0) {
      clipTimer += 1 / 60;
      if (clipTimer > 2.6) {
        clipTimer = 0;
        clip = (clip + 1) % CLIP_COUNT;
      }
    }
    phase = fixedPhase >= 0 ? fixedPhase : CLIPS[clip].loop ? (t * 0.6) % 1 : Math.min(1, clipTimer / 1.6);
    submitOne(0, 0, clip, phase);
  }

  crowd.endFrame();
  layout();
  renderer.render(scene, camera);

  label.textContent = gridMode
    ? `all ${CLIP_COUNT} clips`
    : `clip ${clip}: ${CLIP_NAMES[clip]}   u=${phase.toFixed(2)}   height=${HEIGHT} m`;
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'ArrowRight') clip = (clip + 1) % CLIP_COUNT;
  if (e.code === 'ArrowLeft') clip = (clip + CLIP_COUNT - 1) % CLIP_COUNT;
});

(window as unknown as Record<string, unknown>).__preview = {
  ready: true,
  vertexCounts: crowd.stats.vertsPerLod,
  bakeMs: crowd.stats.bakeMs,
};

requestAnimationFrame(frame);
