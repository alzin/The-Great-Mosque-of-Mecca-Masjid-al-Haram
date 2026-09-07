/**
 * Kaaba.ts — the central structures: the Kaaba itself, its shadharwan base,
 * the Hijr Ismail wall, Maqam Ibrahim and the Zamzam kiosk.
 *
 * PROPORTION, NOT PORTRAITURE
 *   The geometry follows the published dimensions in config/site.ts. It is a
 *   massing reconstruction: correct in size, orientation and the placement of
 *   the major elements, and deliberately restrained about detail it cannot
 *   verify. In particular the kiswah's woven Qur'anic calligraphy is NOT
 *   reproduced — the hizam and the door are rendered as gold bands and panels
 *   with abstract relief. Rendering approximate scripture would be both
 *   inaccurate and disrespectful.
 *
 * RENDER VS COLLISION
 *   Nothing in this file is used by the simulation. The crowd sees only the
 *   convex primitives in sim/Obstacles.ts. Mouldings and bevels added here
 *   can never trap an agent.
 */

import * as THREE from 'three';
import { HIJR, KAABA, MAQAM, ZAMZAM } from '../config/site.ts';
import { HIJR_CENTRE, HIJR_NORMAL } from '../sim/Obstacles.ts';
import type { EnvMaterials } from './Materials.ts';

/** Build the Kaaba with its kiswah, hizam band, door and stone base. */
export function buildKaaba(mat: EnvMaterials): THREE.Group {
  const g = new THREE.Group();
  g.name = 'kaaba';

  const w = KAABA.lengthNE; // along the local X axis (NE and SW walls)
  const d = KAABA.lengthNW; // along the local Z axis
  const h = KAABA.height;

  // --- Shadharwan: the sloped marble skirt around the base ----------------
  const base = new THREE.Mesh(
    bevelledBox(
      w + KAABA.baseProjection * 2,
      KAABA.baseHeight,
      d + KAABA.baseProjection * 2,
      w + KAABA.baseProjection * 0.4,
      d + KAABA.baseProjection * 0.4,
    ),
    mat.marbleBand,
  );
  base.position.y = KAABA.baseHeight / 2;
  base.castShadow = true;
  base.receiveShadow = true;
  g.add(base);

  // --- The cloth-covered cube ---------------------------------------------
  // Slightly tapered: the kiswah hangs, it does not stand rigid.
  const body = new THREE.Mesh(taperedBox(w, h, d, 0.994), mat.kiswah);
  body.position.y = KAABA.baseHeight + h / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  // --- Hizam: the gold band about two thirds up ---------------------------
  const hizam = new THREE.Mesh(
    bandGeometry(w * 1.004, d * 1.004, KAABA.hizamHeight),
    mat.gold,
  );
  hizam.position.y = KAABA.baseHeight + KAABA.hizamCentreHeight;
  hizam.castShadow = false;
  hizam.receiveShadow = true;
  g.add(hizam);

  // A narrower band near the top edge, as on the real covering.
  const upper = new THREE.Mesh(bandGeometry(w * 1.003, d * 1.003, 0.28), mat.goldDark);
  upper.position.y = KAABA.baseHeight + h - 0.55;
  g.add(upper);

  // --- Door, on the NE wall (local +X face), raised above the courtyard ---
  const doorFrame = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, KAABA.doorHeight + 0.5, KAABA.doorWidth + 0.5),
    mat.gold,
  );
  doorFrame.position.set(
    w / 2 + 0.05,
    KAABA.baseHeight + KAABA.doorSill + KAABA.doorHeight / 2,
    0,
  );
  doorFrame.castShadow = true;
  g.add(doorFrame);

  const door = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, KAABA.doorHeight, KAABA.doorWidth),
    mat.goldDark,
  );
  door.position.set(w / 2 + 0.16, KAABA.baseHeight + KAABA.doorSill + KAABA.doorHeight / 2, 0);
  g.add(door);

  // Two door leaves suggested by a recessed centre line.
  const split = new THREE.Mesh(
    new THREE.BoxGeometry(0.13, KAABA.doorHeight - 0.15, 0.06),
    mat.brass,
  );
  split.position.copy(door.position);
  split.position.x += 0.02;
  g.add(split);

  // --- Black Stone surround at the East corner (local +X +Z corner) -------
  // In local coordinates the East corner sits at (+w/2, ., +d/2) before the
  // group's 45 degree yaw is applied.
  const surround = new THREE.Mesh(
    new THREE.TorusGeometry(0.32, 0.075, 8, 20, Math.PI * 1.55),
    mat.blackStoneSurround,
  );
  surround.position.set(w / 2 - 0.28, KAABA.baseHeight + 1.5, d / 2 - 0.28);
  surround.rotation.set(0, Math.PI * 0.25, 0);
  g.add(surround);

  const stone = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0x110f10, roughness: 0.55, metalness: 0.1 }),
  );
  stone.position.copy(surround.position);
  g.add(stone);

  // --- Multazam / corner reinforcement stitching --------------------------
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const seam = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, h - 0.4, 0.1),
        mat.goldDark,
      );
      seam.position.set((sx * w) / 2, KAABA.baseHeight + h / 2, (sz * d) / 2);
      g.add(seam);
    }
  }

  g.rotation.y = KAABA.yaw;
  return g;
}

/**
 * Hijr Ismail: the low semicircular marble wall off the NW face. It is open
 * at both ends, and pilgrims performing tawaf pass outside it — which is why
 * the simulation's minimum tawaf radius bulges here.
 */
export function buildHijr(mat: EnvMaterials): THREE.Group {
  const g = new THREE.Group();
  g.name = 'hijr-ismail';

  const segments = 48;
  const shape = new THREE.Shape();
  const inner = HIJR.radius - HIJR.wallThickness / 2;
  const outer = HIJR.radius + HIJR.wallThickness / 2;
  const a0 = -HIJR.halfAngle;
  const a1 = HIJR.halfAngle;

  shape.moveTo(Math.cos(a0) * inner, Math.sin(a0) * inner);
  for (let i = 0; i <= segments; i++) {
    const a = a0 + ((a1 - a0) * i) / segments;
    shape.lineTo(Math.cos(a) * inner, Math.sin(a) * inner);
  }
  for (let i = segments; i >= 0; i--) {
    const a = a0 + ((a1 - a0) * i) / segments;
    shape.lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
  }
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: HIJR.wallHeight,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.05,
    bevelSegments: 1,
  });
  geo.rotateX(-Math.PI / 2);

  const wall = new THREE.Mesh(geo, mat.marbleBand);
  wall.castShadow = true;
  wall.receiveShadow = true;
  g.add(wall);

  // Rounded coping along the top of the wall reads well from above.
  const copGeo = new THREE.TorusGeometry(
    HIJR.radius,
    HIJR.wallThickness * 0.5,
    6,
    segments,
    a1 - a0,
  );
  copGeo.rotateZ(a0);
  copGeo.rotateX(-Math.PI / 2);
  copGeo.scale(1, 0.55, 1);
  copGeo.translate(0, HIJR.wallHeight, 0);
  const cop = new THREE.Mesh(copGeo, mat.marbleLight);
  cop.castShadow = true;
  g.add(cop);

  // The enclosed floor is paved differently from the mataf.
  const floorShape = new THREE.Shape();
  floorShape.moveTo(0, 0);
  for (let i = 0; i <= segments; i++) {
    const a = a0 + ((a1 - a0) * i) / segments;
    floorShape.lineTo(Math.cos(a) * inner, Math.sin(a) * inner);
  }
  floorShape.closePath();
  const floorGeo = new THREE.ShapeGeometry(floorShape, 8);
  floorGeo.rotateX(-Math.PI / 2);
  const floor = new THREE.Mesh(floorGeo, mat.marbleDark);
  floor.position.y = 0.03;
  floor.receiveShadow = true;
  g.add(floor);

  // The arc is struck from the midpoint of the Kaaba's NW wall and opens
  // outward along the NW normal. Both the centre and the normal come from the
  // collision model, so the wall the crowd steers around is exactly the wall
  // that is drawn.
  g.rotation.y = -HIJR_NORMAL;
  g.position.set(HIJR_CENTRE.x, 0, HIJR_CENTRE.z);
  return g;
}

/** Maqam Ibrahim: the small gilt-and-glass enclosure before the Kaaba's door. */
export function buildMaqam(mat: EnvMaterials): THREE.Group {
  const g = new THREE.Group();
  g.name = 'maqam-ibrahim';

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(MAQAM.baseRadius, MAQAM.baseRadius * 1.12, MAQAM.baseHeight, 16),
    mat.marbleLight,
  );
  base.position.y = MAQAM.baseHeight / 2;
  base.castShadow = true;
  base.receiveShadow = true;
  g.add(base);

  const cageHeight = MAQAM.totalHeight - MAQAM.baseHeight - MAQAM.domeRadius;
  const glass = new THREE.Mesh(
    new THREE.CylinderGeometry(MAQAM.domeRadius, MAQAM.domeRadius, cageHeight, 16, 1, true),
    mat.glass,
  );
  glass.position.y = MAQAM.baseHeight + cageHeight / 2;
  g.add(glass);

  // Gilt ribs around the glass.
  const ribs = 8;
  for (let i = 0; i < ribs; i++) {
    const a = (i / ribs) * Math.PI * 2;
    const rib = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, cageHeight, 0.07),
      mat.gold,
    );
    rib.position.set(
      Math.cos(a) * MAQAM.domeRadius,
      MAQAM.baseHeight + cageHeight / 2,
      Math.sin(a) * MAQAM.domeRadius,
    );
    g.add(rib);
  }

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(MAQAM.domeRadius, 0.06, 6, 20),
    mat.gold,
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = MAQAM.baseHeight + cageHeight;
  g.add(ring);

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(MAQAM.domeRadius, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2),
    mat.gold,
  );
  dome.position.y = MAQAM.baseHeight + cageHeight;
  dome.castShadow = true;
  g.add(dome);

  const finial = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.42, 8), mat.gold);
  finial.position.y = MAQAM.baseHeight + cageHeight + MAQAM.domeRadius + 0.18;
  g.add(finial);

  // The NE wall runs between the East (Black Stone) and North (Iraqi)
  // corners, so its outward normal — and the door axis — is at bearing -pi/4.
  const neNormal = -Math.PI / 4;
  g.position.set(
    Math.cos(neNormal) * MAQAM.distanceFromCentre,
    0,
    Math.sin(neNormal) * MAQAM.distanceFromCentre,
  );
  g.rotation.y = -neNormal;
  return g;
}

/** Low kiosk marking the Zamzam access. */
export function buildZamzam(mat: EnvMaterials): THREE.Group {
  const g = new THREE.Group();
  g.name = 'zamzam';

  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(ZAMZAM.radius, ZAMZAM.radius, ZAMZAM.height, 20),
    mat.marbleBand,
  );
  body.position.y = ZAMZAM.height / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(ZAMZAM.radius + 0.14, ZAMZAM.radius + 0.14, 0.16, 20),
    mat.marbleLight,
  );
  cap.position.y = ZAMZAM.height + 0.08;
  g.add(cap);

  g.position.set(
    Math.cos(ZAMZAM.bearing) * ZAMZAM.distanceFromCentre,
    0,
    Math.sin(ZAMZAM.bearing) * ZAMZAM.distanceFromCentre,
  );
  return g;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** A box whose top face is slightly smaller than its bottom face. */
function taperedBox(w: number, h: number, d: number, topScale: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, h, d, 1, 1, 1);
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 0) {
      pos.setX(i, pos.getX(i) * topScale);
      pos.setZ(i, pos.getZ(i) * topScale);
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** A box with a chamfered top, used for the sloped shadharwan skirt. */
function bevelledBox(
  w: number,
  h: number,
  d: number,
  topW: number,
  topD: number,
): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, h, d);
  const pos = geo.getAttribute('position');
  const sx = topW / w;
  const sz = topD / d;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 0) {
      pos.setX(i, pos.getX(i) * sx);
      pos.setZ(i, pos.getZ(i) * sz);
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** A thin open band that wraps the four walls of a rectangular plan. */
function bandGeometry(w: number, d: number, height: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, -d / 2);
  shape.lineTo(w / 2, -d / 2);
  shape.lineTo(w / 2, d / 2);
  shape.lineTo(-w / 2, d / 2);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -height / 2, 0);
  return geo;
}
