/**
 * CameraSystem.ts — camera presets, a constrained orbit, and a slow
 * cinematic move.
 *
 * The brief is an elevated broadcast view, so the camera is deliberately not
 * a free-fly. It orbits a target on a spherical shell with clamped pitch and
 * distance, which makes it impossible to end up inside the Kaaba, under the
 * floor, or a kilometre away looking at nothing. Every preset is a point on
 * that same shell, so switching between them is a smooth move rather than a
 * cut, and the user can take over at any time without a discontinuity.
 *
 * ACCESSIBILITY
 *   Everything the pointer can do, the keyboard can do: arrow keys orbit,
 *   +/- dolly, and number keys jump to presets. Nothing here requires a
 *   mouse or a trackpad gesture.
 */

import * as THREE from 'three';
import { GALLERY, MATAF } from '../config/site.ts';

export interface CameraPreset {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Spherical coordinates about the target. */
  readonly azimuth: number;
  readonly polar: number;
  readonly distance: number;
  readonly target: readonly [number, number, number];
  readonly fov: number;
}

/**
 * Three presets plus the cinematic orbit. Heights and framings are chosen to
 * read as an elevated fixed camera on the galleries rather than a drone.
 */
export const CAMERA_PRESETS: readonly CameraPreset[] = [
  {
    id: 'broadcast',
    label: 'Broadcast',
    description: 'Elevated wide view from the eastern gallery, the whole mataf in frame.',
    azimuth: 0.42,
    polar: 0.88,
    distance: 112,
    target: [0, 8, 0],
    fov: 38,
  },
  {
    id: 'mataf',
    label: 'Mataf level',
    description: 'Low camera just above the crowd, close to the circulation.',
    azimuth: -0.9,
    polar: 1.42,
    distance: 46,
    target: [0, 3.5, 0],
    fov: 46,
  },
  {
    id: 'overhead',
    label: 'Overhead',
    description: 'Near-vertical plan view showing the circulation pattern and the prayer rows.',
    azimuth: -1.57,
    polar: 0.22,
    distance: 132,
    target: [0, 0, 0],
    fov: 40,
  },
  {
    id: 'door',
    label: 'Maqam side',
    description: 'Three-quarter view across the Maqam Ibrahim toward the Kaaba door.',
    azimuth: -0.78,
    polar: 1.18,
    distance: 62,
    target: [4, 5, -4],
    fov: 42,
  },
];

const MIN_POLAR = 0.12;
const MAX_POLAR = 1.5;
const MIN_DISTANCE = 22;
const MAX_DISTANCE = 240;
/** Widen portrait framing without the distortion of an extreme wide lens. */
const MAX_PORTRAIT_FOV = 68;
/** Never let the camera drop below this height above the courtyard. */
const MIN_HEIGHT = 2.6;

export class CameraSystem {
  readonly camera: THREE.PerspectiveCamera;

  /** Current spherical state. */
  private azimuth = CAMERA_PRESETS[0].azimuth;
  private polar = CAMERA_PRESETS[0].polar;
  private distance = CAMERA_PRESETS[0].distance;
  private readonly target = new THREE.Vector3(0, 6, 0);

  /** Where we are heading, when a preset transition is in flight. */
  private goalAzimuth = this.azimuth;
  private goalPolar = this.polar;
  private goalDistance = this.distance;
  private readonly goalTarget = new THREE.Vector3(0, 6, 0);
  private goalFov = CAMERA_PRESETS[0].fov;
  /** Preset FOV before adapting it to the viewport's shape. */
  private baseFov = CAMERA_PRESETS[0].fov;

  /** 0 = no transition running. */
  private transition = 0;
  private transitionLength = 1;

  cinematic = false;
  /** Radians per second of the cinematic orbit — deliberately very slow. */
  cinematicSpeed = 0.017;

  activePreset = CAMERA_PRESETS[0].id;

  private readonly domElement: HTMLElement;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private gesture: { x: number; y: number; span: number; count: number } | null = null;
  private readonly cleanups: Array<() => void> = [];

  constructor(domElement: HTMLElement, aspect: number) {
    this.domElement = domElement;
    this.camera = new THREE.PerspectiveCamera(CAMERA_PRESETS[0].fov, validAspect(aspect), 0.5, 2600);
    this.applyPreset(CAMERA_PRESETS[0], true);
    this.bindInput();
    this.update(0);
  }

  // -----------------------------------------------------------------------
  // Input
  // -----------------------------------------------------------------------

  private bindInput(): void {
    const el = this.domElement;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.rebaseGesture();
      el.setPointerCapture(e.pointerId);
      this.cinematic = false;
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!this.pointers.has(e.pointerId)) return;
      const previous = this.gesture;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.rebaseGesture();
      const current = this.gesture;
      if (!previous || !current || previous.count !== current.count) return;

      if (current.count === 1) {
        this.orbit(-(current.x - previous.x) * 0.0042, -(current.y - previous.y) * 0.0035);
      } else if (previous.span >= 8 && current.span >= 8) {
        // Spreading two fingers brings the view closer. Use a ratio so zoom
        // feels consistent at every distance and on different screen sizes.
        this.dolly(this.distance * (previous.span / current.span - 1));
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!this.pointers.delete(e.pointerId)) return;
      // Rebase on the remaining fingers so lifting either finger cannot
      // cause the next orbit or pinch to jump.
      this.rebaseGesture();
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      this.dolly(Math.sign(e.deltaY) * Math.min(12, Math.abs(e.deltaY) * 0.06 + 1.5));
      this.cinematic = false;
    };

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('lostpointercapture', onPointerUp);
    el.addEventListener('wheel', onWheel, { passive: false });

    this.cleanups.push(() => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('lostpointercapture', onPointerUp);
      el.removeEventListener('wheel', onWheel);
    });
  }

  private rebaseGesture(): void {
    const points = this.pointers.values();
    const first = points.next().value;
    if (!first) {
      this.gesture = null;
      return;
    }
    const second = points.next().value;
    this.gesture = {
      x: first.x,
      y: first.y,
      span: second ? Math.hypot(second.x - first.x, second.y - first.y) : 0,
      count: second ? 2 : 1,
    };
  }

  /** Keyboard control, called by the app's global key handler. */
  handleKey(code: string): boolean {
    const step = 0.06;
    switch (code) {
      case 'ArrowLeft':
        this.orbit(step, 0);
        this.cinematic = false;
        return true;
      case 'ArrowRight':
        this.orbit(-step, 0);
        this.cinematic = false;
        return true;
      case 'ArrowUp':
        this.orbit(0, step * 0.6);
        this.cinematic = false;
        return true;
      case 'ArrowDown':
        this.orbit(0, -step * 0.6);
        this.cinematic = false;
        return true;
      case 'Equal':
      case 'NumpadAdd':
        this.dolly(-6);
        return true;
      case 'Minus':
      case 'NumpadSubtract':
        this.dolly(6);
        return true;
      default:
        return false;
    }
  }

  orbit(dAzimuth: number, dPolar: number): void {
    this.cancelTransition();
    this.azimuth += dAzimuth;
    this.polar = clamp(this.polar - dPolar, MIN_POLAR, MAX_POLAR);
  }

  dolly(delta: number): void {
    this.cancelTransition();
    this.distance = clamp(this.distance + delta, MIN_DISTANCE, MAX_DISTANCE);
  }

  private cancelTransition(): void {
    if (this.transition > 0) {
      this.transition = 0;
      this.goalAzimuth = this.azimuth;
      this.goalPolar = this.polar;
      this.goalDistance = this.distance;
      this.goalTarget.copy(this.target);
    }
    this.activePreset = 'free';
  }

  // -----------------------------------------------------------------------
  // Presets
  // -----------------------------------------------------------------------

  applyPreset(preset: CameraPreset, immediate = false): void {
    this.activePreset = preset.id;
    // Choose the equivalent azimuth nearest the current one, so a preset
    // never spins the long way round.
    const current = this.azimuth;
    let goal = preset.azimuth;
    while (goal - current > Math.PI) goal -= Math.PI * 2;
    while (goal - current < -Math.PI) goal += Math.PI * 2;

    this.goalAzimuth = goal;
    this.goalPolar = preset.polar;
    this.goalDistance = preset.distance;
    this.goalTarget.set(preset.target[0], preset.target[1], preset.target[2]);
    this.goalFov = preset.fov;

    if (immediate) {
      this.azimuth = goal;
      this.polar = preset.polar;
      this.distance = preset.distance;
      this.target.copy(this.goalTarget);
      this.baseFov = preset.fov;
      this.updateProjection();
      this.transition = 0;
    } else {
      this.transition = 1;
      this.transitionLength = 1.9;
    }
  }

  applyPresetById(id: string): void {
    const p = CAMERA_PRESETS.find((c) => c.id === id);
    if (p) this.applyPreset(p);
  }

  // -----------------------------------------------------------------------
  // Frame update
  // -----------------------------------------------------------------------

  update(dt: number): void {
    if (this.transition > 0) {
      this.transition = Math.max(0, this.transition - dt / this.transitionLength);
      const t = easeInOut(1 - this.transition);
      this.azimuth = lerp(this.azimuth, this.goalAzimuth, t * 0.16 + dt * 1.2);
      this.polar = lerp(this.polar, this.goalPolar, t * 0.16 + dt * 1.2);
      this.distance = lerp(this.distance, this.goalDistance, t * 0.16 + dt * 1.2);
      this.target.lerp(this.goalTarget, Math.min(1, t * 0.16 + dt * 1.2));
      const fov = this.transition === 0
        ? this.goalFov
        : lerp(this.baseFov, this.goalFov, Math.min(1, dt * 2.2));
      if (Math.abs(fov - this.baseFov) > 0.001) {
        this.baseFov = fov;
        this.updateProjection();
      }
    }

    if (this.cinematic) {
      this.azimuth += this.cinematicSpeed * dt;
    }

    this.polar = clamp(this.polar, MIN_POLAR, MAX_POLAR);
    this.distance = clamp(this.distance, MIN_DISTANCE, MAX_DISTANCE);

    const sinP = Math.sin(this.polar);
    let x = this.target.x + this.distance * sinP * Math.cos(this.azimuth);
    let y = this.target.y + this.distance * Math.cos(this.polar);
    let z = this.target.z + this.distance * sinP * Math.sin(this.azimuth);

    // Constraints: stay above the floor, stay inside the precinct wall.
    if (y < MIN_HEIGHT) y = MIN_HEIGHT;
    const radial = Math.hypot(x, z);
    const maxRadial = GALLERY.outerWallRadius * 2.1;
    if (radial > maxRadial) {
      const k = maxRadial / radial;
      x *= k;
      z *= k;
    }
    // ...and never inside the Kaaba's own footprint.
    const minRadial = MATAF.innerRadius + 6;
    if (radial < minRadial && y < 24) {
      const k = minRadial / Math.max(0.001, radial);
      x *= k;
      z *= k;
    }

    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  setAspect(aspect: number): void {
    this.camera.aspect = validAspect(aspect);
    this.updateProjection();
  }

  private updateProjection(): void {
    // Preserve the square viewport's horizontal coverage in portrait as far
    // as the lens cap allows. Keep the unadapted FOV separate so rotating the
    // device or changing presets cannot accumulate a framing adjustment.
    const portraitScale = Math.min(1, this.camera.aspect);
    const adaptedFov = THREE.MathUtils.radToDeg(
      2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(this.baseFov) / 2) / portraitScale),
    );
    this.camera.fov = Math.min(MAX_PORTRAIT_FOV, adaptedFov);
    this.camera.updateProjectionMatrix();
  }

  /** Serialisable state, used by the tests and the reset path. */
  getState() {
    return {
      azimuth: this.azimuth,
      polar: this.polar,
      distance: this.distance,
      target: this.target.toArray(),
      preset: this.activePreset,
      cinematic: this.cinematic,
    };
  }

  dispose(): void {
    for (const c of this.cleanups) c();
    this.cleanups.length = 0;
    for (const pointerId of this.pointers.keys()) {
      if (this.domElement.hasPointerCapture(pointerId)) this.domElement.releasePointerCapture(pointerId);
    }
    this.pointers.clear();
    this.gesture = null;
  }
}

function validAspect(aspect: number): number {
  return Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.min(1, Math.max(0, t));
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
