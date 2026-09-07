/**
 * Materials.ts — every surface in the scene, generated at run time.
 *
 * WHY PROCEDURAL
 *   No photographic texture of the Haram can be shipped without a licence,
 *   and inventing a "photoreal" one would be worse: it would look like a
 *   claim about a real place that the simulation is not entitled to make.
 *   Everything here is synthesised from noise and simple functions, so the
 *   asset manifest has no third-party entries and the whole thing still
 *   builds offline. See ASSETS.md.
 *
 * WHAT IS DELIBERATELY ABSENT
 *   The kiswah of the Kaaba carries Qur'anic calligraphy woven in gold. This
 *   simulation does NOT attempt to reproduce it. Fabricating approximate
 *   sacred text would be disrespectful and inaccurate, so the hizam and the
 *   door are rendered as gold-toned bands and panels with abstract, non-
 *   textual relief. The same restraint applies to the arcades.
 */

import * as THREE from 'three';

type Canvas = HTMLCanvasElement;

function canvas(size: number): { c: Canvas; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable — cannot generate textures.');
  return { c, ctx };
}

/** Deterministic value noise so every run looks identical. */
function makeNoise(seed: number) {
  const perm = new Uint8Array(512);
  let s = seed >>> 0;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];

  const grad = (h: number, x: number, y: number) => {
    switch (h & 3) {
      case 0:
        return x + y;
      case 1:
        return -x + y;
      case 2:
        return x - y;
      default:
        return -x - y;
    }
  };
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

  return function noise2(x: number, y: number): number {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);
    const aa = perm[perm[xi] + yi];
    const ab = perm[perm[xi] + yi + 1];
    const ba = perm[perm[xi + 1] + yi];
    const bb = perm[perm[xi + 1] + yi + 1];
    const x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u);
    const x2 = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u);
    return (lerp(x1, x2, v) + 1) * 0.5;
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function fbm(noise: (x: number, y: number) => number, x: number, y: number, octaves: number): number {
  let v = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    v += noise(x * freq, y * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return v / norm;
}

/** Derive a normal map from a height field by central differences. */
function heightToNormal(height: Float32Array, size: number, strength: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = height[y * size + ((x - 1 + size) % size)];
      const r = height[y * size + ((x + 1) % size)];
      const d = height[((y - 1 + size) % size) * size + x];
      const u = height[((y + 1) % size) * size + x];
      let nx = (l - r) * strength;
      let ny = (d - u) * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      const i = (y * size + x) * 4;
      data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

function fromCanvas(c: Canvas, srgb: boolean, repeat = 1): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------

export interface EnvMaterials {
  marbleLight: THREE.MeshStandardMaterial;
  marbleBand: THREE.MeshStandardMaterial;
  marbleDark: THREE.MeshStandardMaterial;
  stone: THREE.MeshStandardMaterial;
  stoneWarm: THREE.MeshStandardMaterial;
  kiswah: THREE.MeshStandardMaterial;
  gold: THREE.MeshStandardMaterial;
  goldDark: THREE.MeshStandardMaterial;
  blackStoneSurround: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  lampWarm: THREE.MeshBasicMaterial;
  brass: THREE.MeshStandardMaterial;
  dispose(): void;
}

/**
 * White marble with faint grey veining. Real Haram paving is Thassos marble,
 * chosen partly because it stays cool underfoot; visually it is very bright
 * with restrained grey figuring, which is what this reproduces.
 */
function marbleTexture(size: number, seed: number, base: string, veinStrength: number): Canvas {
  const { c, ctx } = canvas(size);
  const noise = makeNoise(seed);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * 4;
      const v = (y / size) * 4;
      const warp = fbm(noise, u * 1.6, v * 1.6, 4);
      const vein = Math.abs(Math.sin((u + warp * 2.4) * 3.1)) ** 8;
      const grain = fbm(noise, u * 22, v * 22, 3) - 0.5;
      const k = 1 - vein * veinStrength + grain * 0.035;
      const i = (y * size + x) * 4;
      d[i] = clamp255(d[i] * k);
      d[i + 1] = clamp255(d[i + 1] * k);
      d[i + 2] = clamp255(d[i + 2] * k);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Woven black cloth: a fine twill weave with a slight silk sheen. */
function kiswahMaps(size: number): { map: Canvas; normal: THREE.DataTexture; rough: Canvas } {
  const { c, ctx } = canvas(size);
  const noise = makeNoise(0x1a55e7);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Twill: a diagonal over-under pattern.
      const weave =
        0.5 +
        0.5 * Math.sin((x + y) * Math.PI * 0.5) * 0.55 +
        0.25 * Math.sin(x * Math.PI * 0.5) * 0.4;
      const slub = fbm(noise, x / size * 40, y / size * 40, 2);
      const h = weave * 0.8 + slub * 0.2;
      height[y * size + x] = h;
      const shade = 26 + h * 26 + slub * 10;
      const i = (y * size + x) * 4;
      d[i] = shade * 1.02;
      d[i + 1] = shade;
      d[i + 2] = shade * 1.06;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const roughC = canvas(size);
  const rimg = roughC.ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const h = height[i];
    const r = 150 + (1 - h) * 70;
    rimg.data[i * 4] = r;
    rimg.data[i * 4 + 1] = r;
    rimg.data[i * 4 + 2] = r;
    rimg.data[i * 4 + 3] = 255;
  }
  roughC.ctx.putImageData(rimg, 0, 0);

  return { map: c, normal: heightToNormal(height, size, 2.2), rough: roughC.c };
}

/** Coarse dressed stone for the gallery walls and minarets. */
function stoneMaps(size: number, tint: [number, number, number]) {
  const { c, ctx } = canvas(size);
  const noise = makeNoise(0x51043b);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const height = new Float32Array(size * size);
  const courses = 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const row = Math.floor((y / size) * courses);
      const offset = (row % 2) * 0.5;
      const cellX = (x / size) * 4 + offset;
      const jointY = Math.abs(((y / size) * courses) % 1 - 0.5);
      const jointX = Math.abs((cellX % 1) - 0.5);
      const joint = Math.min(smoothstep(0.42, 0.5, jointY), smoothstep(0.44, 0.5, jointX));
      const grain = fbm(noise, x / size * 12, y / size * 12, 4);
      const h = joint * 0.75 + grain * 0.25;
      height[y * size + x] = h;
      const k = 0.72 + h * 0.32 + (grain - 0.5) * 0.1;
      const i = (y * size + x) * 4;
      d[i] = clamp255(tint[0] * k);
      d[i + 1] = clamp255(tint[1] * k);
      d[i + 2] = clamp255(tint[2] * k);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { map: c, normal: heightToNormal(height, size, 1.6) };
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Abstract gold relief. Interlaced geometry only — no letterforms, because
 * the real bands carry Qur'anic text and this simulation does not reproduce
 * scripture it cannot render faithfully.
 */
function goldReliefMaps(size: number) {
  const { c, ctx } = canvas(size);
  ctx.fillStyle = '#b8912f';
  ctx.fillRect(0, 0, size, size);
  const height = new Float32Array(size * size);

  ctx.lineWidth = size / 64;
  ctx.strokeStyle = '#e6c766';
  const cells = 6;
  const step = size / cells;
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      const cx = (i + 0.5) * step;
      const cy = (j + 0.5) * step;
      ctx.beginPath();
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const r = step * (k % 2 === 0 ? 0.42 : 0.2);
        const px = cx + Math.cos(a) * r;
        const py = cy + Math.sin(a) * r;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
  ctx.strokeStyle = '#8f6c1c';
  ctx.lineWidth = size / 128;
  ctx.strokeRect(size * 0.04, size * 0.04, size * 0.92, size * 0.92);

  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < size * size; i++) {
    height[i] = img.data[i * 4] / 255;
  }
  return { map: c, normal: heightToNormal(height, size, 1.4) };
}

// ---------------------------------------------------------------------------

export function createMaterials(renderer: THREE.WebGLRenderer, quality: 'low' | 'medium' | 'high'): EnvMaterials {
  const big = quality === 'high' ? 512 : quality === 'medium' ? 256 : 128;
  const small = quality === 'high' ? 256 : 128;
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const disposables: Array<{ dispose(): void }> = [];

  const track = <T extends { dispose(): void }>(t: T): T => {
    disposables.push(t);
    return t;
  };

  const marbleCanvas = marbleTexture(big, 0x9a13, '#f3f1ea', 0.16);
  const marbleMap = track(fromCanvas(marbleCanvas, true, 8));
  marbleMap.anisotropy = maxAniso;

  const marbleBandCanvas = marbleTexture(small, 0x2c71, '#d8d2c4', 0.22);
  const marbleBandMap = track(fromCanvas(marbleBandCanvas, true, 3));

  const marbleDarkCanvas = marbleTexture(small, 0x77af, '#4d4a45', 0.3);
  const marbleDarkMap = track(fromCanvas(marbleDarkCanvas, true, 3));

  const kis = kiswahMaps(big);
  const kiswahMap = track(fromCanvas(kis.map, true, 3));
  const kiswahNormal = track(kis.normal);
  kiswahNormal.repeat.set(3, 3);
  const kiswahRough = track(fromCanvas(kis.rough, false, 3));

  const st = stoneMaps(big, [214, 206, 190]);
  const stoneMap = track(fromCanvas(st.map, true, 4));
  const stoneNormal = track(st.normal);
  stoneNormal.repeat.set(4, 4);

  const stw = stoneMaps(small, [226, 210, 182]);
  const stoneWarmMap = track(fromCanvas(stw.map, true, 3));
  const stoneWarmNormal = track(stw.normal);
  stoneWarmNormal.repeat.set(3, 3);

  const gr = goldReliefMaps(small);
  const goldMap = track(fromCanvas(gr.map, true, 1));
  const goldNormal = track(gr.normal);

  const materials: EnvMaterials = {
    marbleLight: new THREE.MeshStandardMaterial({
      map: marbleMap,
      color: 0xffffff,
      roughness: 0.34,
      metalness: 0.02,
    }),
    marbleBand: new THREE.MeshStandardMaterial({
      map: marbleBandMap,
      roughness: 0.42,
      metalness: 0.02,
    }),
    marbleDark: new THREE.MeshStandardMaterial({
      map: marbleDarkMap,
      roughness: 0.38,
      metalness: 0.03,
    }),
    stone: new THREE.MeshStandardMaterial({
      map: stoneMap,
      normalMap: stoneNormal,
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughness: 0.82,
      metalness: 0.0,
    }),
    stoneWarm: new THREE.MeshStandardMaterial({
      map: stoneWarmMap,
      normalMap: stoneWarmNormal,
      normalScale: new THREE.Vector2(0.6, 0.6),
      roughness: 0.76,
      metalness: 0.0,
    }),
    kiswah: new THREE.MeshStandardMaterial({
      map: kiswahMap,
      normalMap: kiswahNormal,
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughnessMap: kiswahRough,
      roughness: 0.9,
      metalness: 0.0,
      color: 0x14141a,
    }),
    gold: new THREE.MeshStandardMaterial({
      map: goldMap,
      normalMap: goldNormal,
      normalScale: new THREE.Vector2(0.8, 0.8),
      color: 0xe8c169,
      roughness: 0.26,
      metalness: 0.9,
    }),
    goldDark: new THREE.MeshStandardMaterial({
      color: 0x9d7b2a,
      roughness: 0.42,
      metalness: 0.8,
    }),
    blackStoneSurround: new THREE.MeshStandardMaterial({
      color: 0xc9a44e,
      roughness: 0.26,
      metalness: 0.9,
    }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x2a3540,
      roughness: 0.12,
      metalness: 0.4,
      transparent: true,
      opacity: 0.55,
    }),
    lampWarm: new THREE.MeshBasicMaterial({ color: 0xffe4b0 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xb08d4a, roughness: 0.35, metalness: 0.85 }),
    dispose() {
      for (const d of disposables) d.dispose();
      for (const key of Object.keys(materials) as Array<keyof EnvMaterials>) {
        const m = materials[key];
        if (m instanceof THREE.Material) m.dispose();
      }
    },
  };

  return materials;
}
