import { describe, expect, it } from 'vitest';
import { CAMERA_PRESETS, CameraSystem } from '../src/camera/CameraSystem.ts';

/** Pointer events do not need a browser or WebGL to exercise camera input. */
class CameraSurface extends EventTarget {
  readonly captures = new Set<number>();

  setPointerCapture(id: number): void {
    this.captures.add(id);
  }

  hasPointerCapture(id: number): boolean {
    return this.captures.has(id);
  }

  releasePointerCapture(id: number): void {
    this.captures.delete(id);
    this.pointer('lostpointercapture', id);
  }

  pointer(type: string, id: number, x = 0, y = 0): void {
    this.dispatchEvent(Object.assign(new Event(type), {
      pointerId: id,
      button: 0,
      clientX: x,
      clientY: y,
    }));
  }
}

function setup(aspect = 16 / 9) {
  const surface = new CameraSurface();
  const camera = new CameraSystem(surface as unknown as HTMLElement, aspect);
  return { surface, camera };
}

describe('mobile camera gestures', () => {
  it('pinches proportionally without orbiting and resumes one-finger orbit without jumping', () => {
    const { surface, camera } = setup();
    surface.pointer('pointerdown', 1, 100, 100);
    surface.pointer('pointermove', 1, 120, 110);
    const orbit = camera.getState();
    expect(orbit.azimuth).not.toBe(CAMERA_PRESETS[0].azimuth);

    surface.pointer('pointerdown', 2, 220, 110);
    surface.pointer('pointermove', 2, 320, 110);
    expect(camera.getState().distance).toBeCloseTo(orbit.distance / 2);
    expect(camera.getState().azimuth).toBe(orbit.azimuth);
    expect(camera.getState().polar).toBe(orbit.polar);

    // Lift the original finger: orbit must resume from the second finger's
    // latest location, rather than from the former primary finger.
    surface.pointer('pointerup', 1, 120, 110);
    surface.pointer('pointermove', 2, 320, 110);
    expect(camera.getState().azimuth).toBe(orbit.azimuth);
    surface.pointer('pointermove', 2, 330, 110);
    expect(camera.getState().azimuth).toBeCloseTo(orbit.azimuth - 10 * 0.0042);
    camera.dispose();
  });

  it.each(['pointercancel', 'lostpointercapture'])('clears interrupted input on %s', (event) => {
    const { surface, camera } = setup();
    surface.pointer('pointerdown', 1, 100, 100);
    surface.pointer('pointerdown', 2, 200, 100);
    surface.pointer(event, 2, 200, 100);
    const before = camera.getState();
    surface.pointer('pointermove', 2, 400, 300);
    expect(camera.getState()).toEqual(before);
    surface.pointer('pointermove', 1, 110, 100);
    expect(camera.getState().azimuth).toBeCloseTo(before.azimuth - 10 * 0.0042);
    camera.dispose();
    expect(surface.captures.size).toBe(0);
  });

  it('keeps pinch zoom inside the existing distance constraints', () => {
    const { surface, camera } = setup();
    surface.pointer('pointerdown', 1, 0, 0);
    surface.pointer('pointerdown', 2, 10, 0);
    surface.pointer('pointermove', 2, 1000, 0);
    expect(camera.getState().distance).toBe(22);
    surface.pointer('pointermove', 2, 10, 0);
    expect(camera.getState().distance).toBe(240);
    camera.dispose();
  });

  it('retains wheel and keyboard control and removes input listeners on disposal', () => {
    const { surface, camera } = setup();
    const before = camera.getState();
    surface.dispatchEvent(Object.assign(new Event('wheel', { cancelable: true }), { deltaY: 100 }));
    expect(camera.getState().distance).toBeGreaterThan(before.distance);
    expect(camera.handleKey('Equal')).toBe(true);
    expect(camera.handleKey('ArrowLeft')).toBe(true);
    expect(camera.getState().azimuth).toBeGreaterThan(before.azimuth);
    expect(camera.handleKey('KeyQ')).toBe(false);

    surface.pointer('pointerdown', 1, 0, 0);
    camera.dispose();
    const disposed = camera.getState();
    surface.pointer('pointermove', 1, 100, 100);
    expect(camera.getState()).toEqual(disposed);
    expect(surface.captures.size).toBe(0);
  });
});

describe('responsive camera framing', () => {
  it('widens portrait framing without accumulating changes after rotation', () => {
    const { camera } = setup();
    const landscapeFov = camera.camera.fov;
    camera.setAspect(390 / 844);
    expect(camera.camera.fov).toBeGreaterThan(landscapeFov);
    expect(camera.camera.fov).toBeLessThanOrEqual(68);
    const portraitFov = camera.camera.fov;
    camera.setAspect(16 / 9);
    expect(camera.camera.fov).toBeCloseTo(landscapeFov);
    camera.setAspect(390 / 844);
    expect(camera.camera.fov).toBeCloseTo(portraitFov);
    camera.dispose();
  });

  it('preserves preset lenses when rotating during and after a transition', () => {
    const { camera } = setup(390 / 844);
    camera.applyPreset(CAMERA_PRESETS[1]);
    for (let i = 0; i < 40; i++) camera.update(1 / 60);
    camera.setAspect(16 / 9);
    expect(camera.camera.fov).toBeGreaterThan(CAMERA_PRESETS[0].fov);
    expect(camera.camera.fov).toBeLessThan(CAMERA_PRESETS[1].fov);
    for (let i = 0; i < 120; i++) camera.update(1 / 60);
    expect(camera.camera.fov).toBeCloseTo(CAMERA_PRESETS[1].fov);
    camera.setAspect(390 / 844);
    expect(camera.camera.fov).toBeLessThanOrEqual(68);
    camera.applyPreset(CAMERA_PRESETS[2], true);
    camera.setAspect(16 / 9);
    expect(camera.camera.fov).toBeCloseTo(CAMERA_PRESETS[2].fov);
    camera.dispose();
  });
});
