/**
 * Environment.ts — assembles the whole static scene and its lighting.
 *
 * LIGHTING CHOICE
 *   Late afternoon. A low warm key light gives the Kaaba a long shadow across
 *   the marble, which is what makes the courtyard read as a real space and
 *   gives the crowd something to be grounded against. A hemisphere fill
 *   stands in for the bounce off several hectares of white marble, which in
 *   the real place is the dominant source of light on people's faces.
 *
 * SHADOWS
 *   One directional shadow map covers the central precinct. Its extent is
 *   deliberately tight: a map stretched over the whole 96 m precinct would
 *   have too few texels per metre to resolve anything. The architecture casts;
 *   the crowd does not (see CrowdRenderer for why).
 */

import * as THREE from 'three';
import { GALLERY, MATAF } from '../config/site.ts';
import { createMaterials, type EnvMaterials } from './Materials.ts';
import { buildHijr, buildKaaba, buildMaqam, buildZamzam } from './Kaaba.ts';
import { buildCourtyard, buildGalleries, buildMinarets } from './Precinct.ts';

export type QualityName = 'low' | 'medium' | 'high';

export interface EnvironmentQuality {
  shadows: boolean;
  shadowMapSize: number;
  environmentMap: boolean;
  textureSize: QualityName;
}

export const ENVIRONMENT_QUALITY: Record<QualityName, EnvironmentQuality> = {
  low: { shadows: false, shadowMapSize: 512, environmentMap: false, textureSize: 'low' },
  medium: { shadows: true, shadowMapSize: 1024, environmentMap: true, textureSize: 'medium' },
  high: { shadows: true, shadowMapSize: 2048, environmentMap: true, textureSize: 'high' },
};

export interface EnvironmentStats {
  meshes: number;
  triangles: number;
  columns: number;
  arches: number;
  buildMs: number;
}

export class Environment {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly ambient: THREE.AmbientLight;
  readonly stats: EnvironmentStats = {
    meshes: 0,
    triangles: 0,
    columns: 0,
    arches: 0,
    buildMs: 0,
  };

  private readonly materials: EnvMaterials;
  /** Meshes that were built as shadow casters, recorded once. */
  private readonly casters = new Set<THREE.Mesh>();
  private readonly sky: THREE.Mesh;
  private envTexture: THREE.Texture | null = null;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    quality: QualityName,
  ) {
    const t0 = performance.now();
    const q = ENVIRONMENT_QUALITY[quality];
    this.group.name = 'environment';

    this.materials = createMaterials(renderer, q.textureSize);

    // --- Sky ---------------------------------------------------------------
    this.sky = buildSky();
    this.group.add(this.sky);

    // --- Lights ------------------------------------------------------------
    this.sun = new THREE.DirectionalLight(0xfff0d6, 3.1);
    // Mid-afternoon, about 45 degrees up in the west. Lower than this and the
    // 34 m gallery roof throws the entire courtyard into shade, which is both
    // accurate and useless to look at; much higher and the Kaaba stops
    // casting a shadow long enough to read.
    this.sun.position.set(-108, 120, 56);
    this.sun.target.position.set(0, 0, 0);
    this.group.add(this.sun.target);
    this.configureShadow(q);
    this.group.add(this.sun);

    this.hemi = new THREE.HemisphereLight(0xc4dbff, 0xe4d9c2, 1.7);
    this.hemi.position.set(0, 60, 0);
    this.group.add(this.hemi);

    this.ambient = new THREE.AmbientLight(0xfff6e8, 0.3);
    this.group.add(this.ambient);

    // --- Geometry ----------------------------------------------------------
    this.group.add(buildCourtyard(this.materials));
    this.group.add(buildKaaba(this.materials));
    this.group.add(buildHijr(this.materials));
    this.group.add(buildMaqam(this.materials));
    this.group.add(buildZamzam(this.materials));

    const galleries = buildGalleries(this.materials);
    this.group.add(galleries.group);
    this.stats.columns = galleries.instanceCounts.columns ?? 0;
    this.stats.arches = galleries.instanceCounts.arches ?? 0;

    this.group.add(buildMinarets(this.materials));

    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.castShadow) this.casters.add(m);
    });

    this.measure();

    if (q.environmentMap) this.buildEnvironmentMap();

    this.stats.buildMs = performance.now() - t0;
  }

  private configureShadow(q: EnvironmentQuality): void {
    this.sun.castShadow = q.shadows;
    if (!q.shadows) return;
    const cam = this.sun.shadow.camera;
    // The map must cover the whole open courtyard. Anything smaller and the
    // edge of the shadow camera becomes a visible straight line across the
    // marble, with the roof's shadow simply stopping in mid-air.
    const extent = MATAF.outerRadius + 12;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = 20;
    cam.far = 320;
    cam.updateProjectionMatrix();
    this.sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
    this.sun.shadow.bias = -0.0009;
    this.sun.shadow.normalBias = 0.08;
  }

  /**
   * A tiny pre-filtered environment map from the sky gradient. Without it the
   * gold and the glass have nothing to reflect and read as flat plastic.
   */
  private buildEnvironmentMap(): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const src = new THREE.Scene();
    src.add(buildSky());
    const target = pmrem.fromScene(src, 0.04);
    this.envTexture = target.texture;
    this.scene.environment = this.envTexture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
  }

  private measure(): void {
    let meshes = 0;
    let triangles = 0;
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry) return;
      meshes++;
      const index = m.geometry.getIndex();
      const pos = m.geometry.getAttribute('position');
      if (!pos) return;
      const tri = index ? index.count / 3 : pos.count / 3;
      const instances = (m as THREE.InstancedMesh).isInstancedMesh
        ? (m as THREE.InstancedMesh).count
        : 1;
      triangles += tri * instances;
    });
    this.stats.meshes = meshes;
    this.stats.triangles = Math.round(triangles);
  }

  setQuality(quality: QualityName): void {
    const q = ENVIRONMENT_QUALITY[quality];
    this.configureShadow(q);
    if (q.environmentMap && !this.envTexture) {
      this.buildEnvironmentMap();
    } else if (!q.environmentMap && this.envTexture) {
      this.scene.environment = null;
      this.envTexture.dispose();
      this.envTexture = null;
    }
    // Shadow casting flags live on the meshes; toggle in one pass.
    // Only the things that were casters at construction time may cast; the
    // sky dome and the floor must never be added to that set.
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && this.casters.has(m)) m.castShadow = q.shadows;
    });
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry?.dispose();
    });
    this.materials.dispose();
    this.envTexture?.dispose();
  }
}

/**
 * A gradient dome. Not a photograph of a sky: a smooth haze-to-zenith ramp
 * with a warm band low on the horizon in the direction of the sun.
 */
function buildSky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(GALLERY.outerWallRadius * 6, 24, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uZenith: { value: new THREE.Color(0x3f6ea8).convertSRGBToLinear() },
      uHorizon: { value: new THREE.Color(0xd9d0be).convertSRGBToLinear() },
      uGlow: { value: new THREE.Color(0xffd8a0).convertSRGBToLinear() },
      uSunDir: { value: new THREE.Vector3(-108, 120, 56).normalize() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform vec3 uGlow;
      uniform vec3 uSunDir;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y * 1.15 + 0.06, 0.0, 1.0);
        vec3 col = mix(uHorizon, uZenith, pow(h, 0.62));
        float glow = pow(max(0.0, dot(d, normalize(uSunDir))), 6.0);
        col = mix(col, uGlow, glow * 0.55 * (1.0 - h * 0.6));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  return mesh;
}
