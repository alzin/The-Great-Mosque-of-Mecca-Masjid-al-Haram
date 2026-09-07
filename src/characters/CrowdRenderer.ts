/**
 * CrowdRenderer.ts — draws the whole crowd in a handful of draw calls.
 *
 * One `InstancedBufferGeometry` per LOD, each sharing a material that samples
 * the baked vertex-animation texture. Per instance we upload 11 floats:
 * position, yaw, height, build, two animation frames, a blend weight, a
 * palette index and a brightness jitter. Everything else — the posed vertex
 * positions and normals — comes out of the texture, so each instance can be
 * on a completely different clip at a completely different phase while the
 * whole LOD still costs exactly one draw call.
 *
 * Ground contact is provided by cheap instanced blob shadows rather than by
 * putting several thousand characters into the shadow map. That is a
 * deliberate trade: the architecture casts real shadows, and the crowd gets a
 * grounded look for a fraction of the cost. It is listed in the limitations.
 */

import * as THREE from 'three';
import { LOD_SPECS, buildCharacterMesh, type MeshData } from './CharacterMesh.ts';
import { bakeVertexAnimation, type BakedAnimation } from './VertexAnimationTexture.ts';
import { CLIPS, CLIP_OFFSETS, WALK_STRIDE_FRACTION } from './AnimationBank.ts';
import { Clip } from '../sim/States.ts';

/**
 * Garment palettes: garment, head covering, skin.
 *
 * The weighting matters more than the individual colours. Ihram is two
 * lengths of unstitched white cloth, and the mataf is overwhelmingly white as
 * a result; an even mix of light and dark garments reads as a generic crowd
 * rather than as this one. Eight of the ten entries are white or off-white,
 * and the two muted ones are there because a real crowd is never perfectly
 * uniform. Per-instance brightness jitter breaks up the whites so they do not
 * read as one flat sheet.
 */
const PALETTES: ReadonlyArray<readonly [number, number, number]> = [
  // garment, head covering, skin
  [0xf4f1e8, 0xf8f6f0, 0xc59d78],
  [0xffffff, 0xf6f4ee, 0x8d6748],
  [0xece7db, 0xf2f0e8, 0xe0b892],
  [0xf7f5ef, 0xe6e3d9, 0x6f4e35],
  [0xe4e0d4, 0xf4f2ea, 0xb98d66],
  [0xfaf8f2, 0xeae7dd, 0xd4ab84],
  [0xd6d1c4, 0xf1efe8, 0x9c7550],
  [0xf2efe6, 0xdcd8cd, 0xc0966f],
  [0x3a4148, 0x454c52, 0xb98d66],
  [0x5f6660, 0xe8e6de, 0xd4ab84],
];

export const PALETTE_COUNT = PALETTES.length;

export interface CrowdQuality {
  /** Maximum instances drawn at LOD0 / LOD1. Remainder falls to LOD2. */
  lod0Budget: number;
  lod1Budget: number;
  /** Distance thresholds in metres. */
  lod0Distance: number;
  lod1Distance: number;
  blobShadows: boolean;
}

export interface CrowdRenderStats {
  drawn: number;
  perLod: [number, number, number];
  culled: number;
  drawCalls: number;
  triangles: number;
  bakeMs: number;
  vatBytes: number;
  vertsPerLod: [number, number, number];
}

interface LodResources {
  mesh: MeshData;
  baked: BakedAnimation;
  geometry: THREE.InstancedBufferGeometry;
  object: THREE.Mesh;
  material: THREE.MeshLambertMaterial;
  iPos: THREE.InstancedBufferAttribute;
  iOrient: THREE.InstancedBufferAttribute;
  iAnim: THREE.InstancedBufferAttribute;
  iMisc: THREE.InstancedBufferAttribute;
  count: number;
}

const VERTEX_HEADER = /* glsl */ `
uniform sampler2D uVatPos;
uniform sampler2D uVatNrm;
uniform vec2 uVatSize;
uniform vec3 uPalette[${PALETTE_COUNT * 3}];

attribute float aVatU;
attribute float aZone;
attribute vec3 iPos;
attribute vec3 iOrient;   // yaw, heightScale, buildScale
attribute vec4 iAnim;     // frameA0, frameA1, frac, frameB
attribute vec3 iMisc;     // paletteIndex, brightnessJitter, blend

varying vec3 vBaseColor;

vec3 vatPos(float frame) {
  return texture2D(uVatPos, vec2(aVatU, (frame + 0.5) / uVatSize.y)).xyz;
}
vec3 vatNrm(float frame) {
  return texture2D(uVatNrm, vec2(aVatU, (frame + 0.5) / uVatSize.y)).xyz * 2.0 - 1.0;
}
`;

/**
 * The primary clip is sampled at two adjacent frames and interpolated, which
 * is what keeps a 28-frame walk cycle smooth at any playback rate. The blend
 * target uses a single nearest frame: cross-fades are short enough that the
 * extra fetches would not be visible.
 */
/**
 * The primary clip is sampled at two explicit, pre-resolved frames and
 * interpolated, which keeps a 28-frame walk smooth at any playback rate. The
 * two frames are computed on the CPU rather than as `f0` and `f0 + 1` in the
 * shader, because clips are packed end to end in one texture: the frame after
 * the last frame of a looping clip is the FIRST frame of the NEXT clip, and
 * sampling it would pop once per cycle. The clip being blended out of uses a
 * single nearest frame; cross-fades are short enough that the extra fetches
 * would not be visible.
 */
const VERTEX_BODY = /* glsl */ `
  vec3 pA = mix(vatPos(iAnim.x), vatPos(iAnim.y), iAnim.z);
  vec3 nA = vatNrm(iAnim.x);

  vec3 p = pA;
  vec3 n = nA;
  if (iMisc.z > 0.001) {
    p = mix(pA, vatPos(iAnim.w), iMisc.z);
    n = mix(nA, vatNrm(iAnim.w), iMisc.z);
  }

  // Height-fraction space -> metres, with a per-instance build width.
  vec3 sp = vec3(p.x * iOrient.z, p.y, p.z * iOrient.z) * iOrient.y;
  float sy = sin(iOrient.x);
  float cy = cos(iOrient.x);
  vec3 worldPos = vec3(sp.x * cy + sp.z * sy, sp.y, -sp.x * sy + sp.z * cy) + iPos;
  vec3 worldNrm = normalize(vec3(n.x * cy + n.z * sy, n.y, -n.x * sy + n.z * cy));
`;

export class CrowdRenderer {
  readonly group = new THREE.Group();
  private readonly lods: LodResources[] = [];
  private readonly capacity: number;
  private readonly paletteUniform: THREE.Color[] = [];
  quality: CrowdQuality;

  stats: CrowdRenderStats = {
    drawn: 0,
    perLod: [0, 0, 0],
    culled: 0,
    drawCalls: 0,
    triangles: 0,
    bakeMs: 0,
    vatBytes: 0,
    vertsPerLod: [0, 0, 0],
  };

  // Blob shadows
  private blobGeom: THREE.InstancedBufferGeometry | null = null;
  private blobMesh: THREE.Mesh | null = null;
  private blobPos: THREE.InstancedBufferAttribute | null = null;

  constructor(capacity: number, quality: CrowdQuality) {
    this.capacity = capacity;
    this.quality = quality;
    this.group.name = 'crowd';

    for (const c of PALETTES) {
      for (let k = 0; k < 3; k++) {
        this.paletteUniform.push(new THREE.Color(c[k]).convertSRGBToLinear());
      }
    }

    let bakeMs = 0;
    let vatBytes = 0;
    for (let lod = 0; lod < LOD_SPECS.length; lod++) {
      const res = this.buildLod(lod);
      bakeMs += res.baked.bakeMs;
      vatBytes += res.baked.bytes;
      this.lods.push(res);
      this.group.add(res.object);
      this.stats.vertsPerLod[lod] = res.mesh.vertexCount;
    }
    this.stats.bakeMs = bakeMs;
    this.stats.vatBytes = vatBytes;

    this.buildBlobShadows();
  }

  private buildLod(lod: number): LodResources {
    const mesh = buildCharacterMesh(lod);
    const baked = bakeVertexAnimation(mesh);

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex(new THREE.BufferAttribute(mesh.index, 1));
    // `position` must exist for three's pipeline even though we overwrite it.
    geometry.setAttribute('position', new THREE.BufferAttribute(mesh.position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normal, 3));

    const vatU = new Float32Array(mesh.vertexCount);
    for (let i = 0; i < mesh.vertexCount; i++) vatU[i] = (i + 0.5) / mesh.vertexCount;
    geometry.setAttribute('aVatU', new THREE.BufferAttribute(vatU, 1));
    const zone = new Float32Array(mesh.vertexCount);
    for (let i = 0; i < mesh.vertexCount; i++) zone[i] = mesh.zone[i];
    geometry.setAttribute('aZone', new THREE.BufferAttribute(zone, 1));

    const iPos = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    const iOrient = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    const iAnim = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    const iMisc = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    iPos.setUsage(THREE.DynamicDrawUsage);
    iOrient.setUsage(THREE.DynamicDrawUsage);
    iAnim.setUsage(THREE.DynamicDrawUsage);
    iMisc.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('iPos', iPos);
    geometry.setAttribute('iOrient', iOrient);
    geometry.setAttribute('iAnim', iAnim);
    geometry.setAttribute('iMisc', iMisc);
    geometry.instanceCount = 0;

    // The characters live in world space, so the object's own bounds must
    // cover the whole precinct or three will frustum-cull the lot.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 200);
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(-200, -1, -200),
      new THREE.Vector3(200, 20, 200),
    );

    const material = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      dithering: true,
    });

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uVatPos = { value: baked.positionTexture };
      shader.uniforms.uVatNrm = { value: baked.normalTexture };
      shader.uniforms.uVatSize = {
        value: new THREE.Vector2(baked.vertexCount, baked.frameCount),
      };
      shader.uniforms.uPalette = { value: this.paletteUniform };

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERTEX_HEADER}`)
        .replace(
          '#include <beginnormal_vertex>',
          `${VERTEX_BODY}\n  vec3 objectNormal = worldNrm;`,
        )
        .replace('#include <begin_vertex>', '  vec3 transformed = worldPos;')
        .replace(
          '#include <project_vertex>',
          `
  int pal = int(iMisc.x);
  vec3 garment = uPalette[pal * 3];
  vec3 accent = uPalette[pal * 3 + 1];
  vec3 skin = uPalette[pal * 3 + 2];
  vec3 base = garment;
  if (aZone > 2.5) base = garment * 0.66;
  else if (aZone > 1.5) base = accent;
  else if (aZone > 0.5) base = skin;
  vBaseColor = base * iMisc.y;
  #include <project_vertex>
`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vBaseColor;')
        .replace('#include <color_fragment>', '  diffuseColor.rgb *= vBaseColor;');
    };
    material.customProgramCacheKey = () => `crowd-vat-${lod}`;

    const object = new THREE.Mesh(geometry, material);
    object.frustumCulled = false;
    object.receiveShadow = true;
    object.castShadow = false;
    object.matrixAutoUpdate = false;
    object.renderOrder = 2;
    object.name = `crowd-lod${lod}`;

    return { mesh, baked, geometry, object, material, iPos, iOrient, iAnim, iMisc, count: 0 };
  }

  private buildBlobShadows(): void {
    const g = new THREE.InstancedBufferGeometry();
    const seg = 8;
    const pos: number[] = [0, 0, 0];
    const idx: number[] = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      pos.push(Math.cos(a), 0, Math.sin(a));
    }
    for (let i = 0; i < seg; i++) {
      idx.push(0, 1 + ((i + 1) % seg), 1 + i);
    }
    g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pos), 3));
    const alpha = new Float32Array(seg + 1);
    alpha[0] = 1;
    g.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    g.setIndex(idx);

    const bPos = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    bPos.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('bPos', bPos);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 200);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uOpacity: { value: 0.3 } },
      vertexShader: /* glsl */ `
        attribute vec4 bPos;   // x, y, z, radius
        attribute float aAlpha;
        varying float vA;
        void main() {
          vA = aAlpha;
          vec3 p = position * bPos.w + vec3(bPos.x, bPos.y + 0.012, bPos.z);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        varying float vA;
        void main() {
          gl_FragColor = vec4(0.0, 0.0, 0.0, vA * uOpacity);
        }
      `,
    });

    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = false;
    m.matrixAutoUpdate = false;
    m.renderOrder = 1;
    m.name = 'crowd-contact-shadows';
    this.blobGeom = g;
    this.blobMesh = m;
    this.blobPos = bPos;
    this.group.add(m);
  }

  setQuality(q: CrowdQuality): void {
    this.quality = q;
    if (this.blobMesh) this.blobMesh.visible = q.blobShadows;
  }

  /** Total frames in the baked bank — used to validate frame indices. */
  get frameCount(): number {
    return this.lods[0].baked.frameCount;
  }

  beginFrame(): void {
    for (const l of this.lods) l.count = 0;
    this.stats.perLod = [0, 0, 0];
    this.stats.culled = 0;
    this.stats.drawn = 0;
  }

  /**
   * Submit one agent. `frameA0`/`frameA1` are the two integer frame rows of
   * the current clip to interpolate between (weight `frac`), and `frameB` is
   * the single frame of the clip being blended out of (weight `blend`). All
   * are absolute rows in the packed animation bank.
   */
  submit(
    lod: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    height: number,
    build: number,
    frameA0: number,
    frameA1: number,
    frac: number,
    frameB: number,
    blend: number,
    palette: number,
    bright: number,
  ): void {
    const l = this.lods[lod];
    const i = l.count;
    if (i >= this.capacity) return;
    l.iPos.array[i * 3] = x;
    l.iPos.array[i * 3 + 1] = y;
    l.iPos.array[i * 3 + 2] = z;
    l.iOrient.array[i * 3] = yaw;
    l.iOrient.array[i * 3 + 1] = height;
    l.iOrient.array[i * 3 + 2] = build;
    l.iAnim.array[i * 4] = frameA0;
    l.iAnim.array[i * 4 + 1] = frameA1;
    l.iAnim.array[i * 4 + 2] = frac;
    l.iAnim.array[i * 4 + 3] = frameB;
    l.iMisc.array[i * 3] = palette;
    l.iMisc.array[i * 3 + 1] = bright;
    l.iMisc.array[i * 3 + 2] = blend;
    l.count = i + 1;

    if (this.blobPos && this.quality.blobShadows) {
      const b = this.blobPos.array as Float32Array;
      const bi = this.stats.drawn;
      if (bi < this.capacity) {
        b[bi * 4] = x;
        b[bi * 4 + 1] = y;
        b[bi * 4 + 2] = z;
        b[bi * 4 + 3] = 0.42 * build * (height / 1.7);
      }
    }
    this.stats.drawn++;
  }

  endFrame(): void {
    let tris = 0;
    let calls = 0;
    for (let i = 0; i < this.lods.length; i++) {
      const l = this.lods[i];
      l.geometry.instanceCount = l.count;
      this.stats.perLod[i] = l.count;
      if (l.count > 0) {
        l.iPos.addUpdateRange(0, l.count * 3);
        l.iOrient.addUpdateRange(0, l.count * 3);
        l.iAnim.addUpdateRange(0, l.count * 4);
        l.iMisc.addUpdateRange(0, l.count * 3);
        l.iPos.needsUpdate = true;
        l.iOrient.needsUpdate = true;
        l.iAnim.needsUpdate = true;
        l.iMisc.needsUpdate = true;
        tris += l.mesh.triangleCount * l.count;
        calls++;
      }
      l.object.visible = l.count > 0;
    }
    if (this.blobGeom && this.blobPos) {
      const n = this.quality.blobShadows ? this.stats.drawn : 0;
      this.blobGeom.instanceCount = n;
      if (n > 0) {
        this.blobPos.addUpdateRange(0, n * 4);
        this.blobPos.needsUpdate = true;
        calls++;
        tris += 8 * n;
      }
      if (this.blobMesh) this.blobMesh.visible = n > 0;
    }
    this.stats.drawCalls = calls;
    this.stats.triangles = tris;
  }

  dispose(): void {
    for (const l of this.lods) {
      l.geometry.dispose();
      l.material.dispose();
      l.baked.positionTexture.dispose();
      l.baked.normalTexture.dispose();
    }
    this.blobGeom?.dispose();
    (this.blobMesh?.material as THREE.Material | undefined)?.dispose();
  }
}

// ---------------------------------------------------------------------------
// Clip -> absolute frame index helpers
// ---------------------------------------------------------------------------

/**
 * Convert a clip and a normalised phase into an absolute, fractional frame
 * index inside the packed bank. Looping clips wrap; one-shot clips clamp to
 * the last frame.
 */
export function clipFrame(clip: number, u: number): number {
  const def = CLIPS[clip];
  const base = CLIP_OFFSETS[clip];
  if (def.loop) {
    let t = u % 1;
    if (t < 0) t += 1;
    return base + t * def.frames;
  }
  const t = Math.max(0, Math.min(0.9999, u));
  return base + t * (def.frames - 1);
}

/** Frame count of a clip, exposed for tests. */
export function clipFrames(clip: number): number {
  return CLIPS[clip].frames;
}

/**
 * Playback rate, in cycles per second, that makes a walk cycle cover exactly
 * the ground the agent is actually covering. This is what removes foot
 * sliding: the animation is driven by speed, not the other way round.
 */
export function locomotionRate(speed: number, height: number, clip: number): number {
  const strideScale = clip === Clip.SHUFFLE ? 0.5 : 1;
  const strideMetres = WALK_STRIDE_FRACTION * height * strideScale;
  return speed / Math.max(0.2, strideMetres);
}
