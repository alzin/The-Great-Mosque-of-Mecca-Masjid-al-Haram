/**
 * DebugCollision.ts — the hidden diagnostic view.
 *
 * The brief forbids capsule people in the presented simulation, and rightly:
 * a courtyard of capsules is a prototype, not a depiction. But a crowd
 * simulation is very hard to debug without seeing what the agents actually
 * collide with, so the capsules live here, behind a switch that is off by
 * default. What this draws is the SIMULATION's view of the world — the convex
 * primitives from sim/Obstacles.ts, not the rendered architecture — which is
 * precisely what makes it useful: if the two ever disagree, this is how you
 * see it.
 */

import * as THREE from 'three';
import { OBSTACLES, ObstacleKind } from '../sim/Obstacles.ts';
import { MATAF, PRAYER_LAYOUT } from '../config/site.ts';
import type { Crowd } from '../sim/Crowd.ts';

export class DebugCollisionView {
  readonly group = new THREE.Group();
  private readonly capsules: THREE.InstancedMesh;
  private readonly dummy = new THREE.Object3D();
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.group.name = 'debug-collision';
    this.group.visible = false;

    const lineMat = new THREE.LineBasicMaterial({ color: 0x63e6ff });
    const warnMat = new THREE.LineBasicMaterial({ color: 0xffb648 });

    for (const o of OBSTACLES) {
      let points: THREE.Vector3[] = [];
      if (o.kind === ObstacleKind.Box) {
        const c = Math.cos(-Math.atan2(o.sin, o.cos));
        void c;
        const corners: Array<[number, number]> = [
          [-o.halfX, -o.halfZ],
          [o.halfX, -o.halfZ],
          [o.halfX, o.halfZ],
          [-o.halfX, o.halfZ],
          [-o.halfX, -o.halfZ],
        ];
        points = corners.map(([lx, lz]) => {
          const x = o.cx + lx * o.cos - lz * o.sin;
          const z = o.cz + lx * o.sin + lz * o.cos;
          return new THREE.Vector3(x, 0.05, z);
        });
      } else if (o.kind === ObstacleKind.Circle) {
        points = arcPoints(o.cx, o.cz, o.r, 0, Math.PI * 2, 40);
      } else {
        const inner = arcPoints(
          o.cx,
          o.cz,
          o.radius - o.halfThickness,
          o.startAngle,
          o.endAngle,
          32,
        );
        const outer = arcPoints(
          o.cx,
          o.cz,
          o.radius + o.halfThickness,
          o.endAngle,
          o.startAngle,
          32,
        );
        points = [...inner, ...outer, inner[0]];
      }
      const geo = new THREE.BufferGeometry().setFromPoints(points);
      this.group.add(new THREE.Line(geo, lineMat));
    }

    // The tawaf exclusion boundary and the first prayer row: two invariants
    // worth being able to see.
    this.group.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(
          arcPoints(0, 0, MATAF.innerRadius, 0, Math.PI * 2, 96),
        ),
        warnMat,
      ),
    );
    this.group.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(
          arcPoints(0, 0, PRAYER_LAYOUT.firstRowRadius, 0, Math.PI * 2, 96),
        ),
        warnMat,
      ),
    );

    const capsuleGeo = buildCapsule(0.24, 1.7);
    const capsuleMat = new THREE.MeshBasicMaterial({ color: 0x8effa5, wireframe: true });
    this.capsules = new THREE.InstancedMesh(capsuleGeo, capsuleMat, capacity);
    this.capsules.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.capsules.count = 0;
    this.capsules.frustumCulled = false;
    this.group.add(this.capsules);
  }

  get visible(): boolean {
    return this.group.visible;
  }

  setVisible(on: boolean): void {
    this.group.visible = on;
  }

  update(crowd: Crowd): void {
    if (!this.group.visible) return;
    const ids = crowd.liveIdsView();
    const n = Math.min(ids.length, this.capacity);
    for (let k = 0; k < n; k++) {
      const id = ids[k];
      this.dummy.position.set(crowd.px[id], 0, crowd.pz[id]);
      this.dummy.rotation.set(0, crowd.yaw[id], 0);
      this.dummy.scale.set(1, crowd.height[id] / 1.7, 1);
      this.dummy.updateMatrix();
      this.capsules.setMatrixAt(k, this.dummy.matrix);
    }
    this.capsules.count = n;
    this.capsules.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.group.traverse((o) => {
      const any = o as THREE.Mesh | THREE.Line;
      any.geometry?.dispose();
    });
    (this.capsules.material as THREE.Material).dispose();
  }
}

function arcPoints(
  cx: number,
  cz: number,
  r: number,
  a0: number,
  a1: number,
  steps: number,
): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    pts.push(new THREE.Vector3(cx + Math.cos(a) * r, 0.05, cz + Math.sin(a) * r));
  }
  return pts;
}

/**
 * `THREE.CapsuleGeometry` exists in current Three.js, but building it here
 * from a cylinder plus two hemispheres keeps the debug view independent of the
 * exact revision in use.
 */
function buildCapsule(radius: number, height: number): THREE.BufferGeometry {
  const body = new THREE.CylinderGeometry(radius, radius, height - radius * 2, 8, 1, true);
  body.translate(0, height / 2, 0);
  return body;
}
