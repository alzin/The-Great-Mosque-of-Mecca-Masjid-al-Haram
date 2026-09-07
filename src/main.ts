/**
 * main.ts — the application.
 *
 * Wiring, in order: renderer -> environment -> crowd simulation -> character
 * rendering -> camera -> audio -> interface -> loop.
 *
 * The loop is: advance the fixed-step simulation as many times as real time
 * demands (capped), then render once with an interpolation factor. Everything
 * expensive that is not the simulation — LOD selection, culling, instance
 * upload — happens once per rendered frame, not once per tick.
 */

import * as THREE from 'three';
import './ui/ui.css';

import { Crowd } from './sim/Crowd.ts';
import { PrayerOrchestrator } from './sim/PrayerOrchestrator.ts';
import { GlobalPhase } from './sim/States.ts';
import { AnimationDirector } from './characters/AnimationDirector.ts';
import { CrowdRenderer } from './characters/CrowdRenderer.ts';
import { CrowdView } from './characters/CrowdView.ts';
import { Environment, type QualityName } from './env/Environment.ts';
import { DebugCollisionView } from './env/DebugCollision.ts';
import { CameraSystem, CAMERA_PRESETS } from './camera/CameraSystem.ts';
import { AudioSystem } from './audio/AudioSystem.ts';
import { startAutoplay } from './audio/autoplay.ts';
import { AdhanPlayer } from './audio/AdhanPlayer.ts';
import { FixedClock, FrameTimer } from './core/Clock.ts';
import { UI, type UIModel } from './ui/UI.ts';

/** Population ceiling. Documented in the README alongside the benchmarks. */
const CAPACITY = 5000;
const DEFAULT_POPULATION = 900;
const DEFAULT_ARRIVAL_RATE = 22;
const DEFAULT_CIRCUITS = 7;
const SIM_HZ = 30;

const CROWD_QUALITY: Record<QualityName, {
  lod0Budget: number;
  lod1Budget: number;
  lod0Distance: number;
  lod1Distance: number;
  blobShadows: boolean;
}> = {
  low: { lod0Budget: 120, lod1Budget: 700, lod0Distance: 14, lod1Distance: 40, blobShadows: false },
  medium: { lod0Budget: 420, lod1Budget: 1800, lod0Distance: 24, lod1Distance: 62, blobShadows: true },
  high: { lod0Budget: 900, lod1Budget: 3200, lod0Distance: 36, lod1Distance: 92, blobShadows: true },
};

const PIXEL_RATIO_CAP: Record<QualityName, number> = { low: 1, medium: 1.5, high: 2 };

async function boot(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) throw new Error('#app container is missing from the document.');

  const canvas = document.createElement('canvas');
  canvas.id = 'viewport';
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', '3D simulation viewport. Drag to orbit and pinch to zoom, or use arrow keys and plus or minus.');
  app.append(canvas);

  let quality: QualityName = 'medium';

  const ui = new UI(
    app,
    {
      setTargetPopulation: (n) => setTargetPopulation(n),
      setArrivalRate: (n) => {
        crowd.tunables.arrivalRate = n;
        crowd.tunables.departureRate = Math.max(6, n);
      },
      setCircuits: (n) => {
        crowd.tunables.circuits = n;
      },
      togglePause: () => togglePause(),
      setSpeed: (v) => {
        speed = v;
      },
      callPrayer: () => callPrayer(),
      cancelPrayer: () => {
        adhan.stop(true);
        orchestrator.cancel(clock.stats.simTime);
        flushEvents();
      },
      setRakahs: (n) => {
        orchestrator.settings.rakahs = n;
        orchestrator.rebuildTimeline();
      },
      setPrayerScale: (v) => {
        orchestrator.settings.durationScale = v;
        orchestrator.rebuildTimeline();
      },
      setSchedule: (on) => {
        orchestrator.settings.scheduleEnabled = on;
      },
      setCamera: (id) => {
        cameraSystem.applyPresetById(id);
        ui.setCameraActive(id);
        cameraSystem.cinematic = false;
        ui.setCinematicActive(false);
      },
      setCinematic: (on) => {
        cameraSystem.cinematic = on;
      },
      setQuality: (q) => applyQuality(q),
      reset: () => resetAll(),
      toggleAudio: () => toggleAudio(),
      setDebugCollision: (on) => {
        debugView.setVisible(on);
      },
    },
    CAMERA_PRESETS.map((c) => ({ id: c.id, label: c.label, description: c.description })),
    CAPACITY,
    {
      population: DEFAULT_POPULATION,
      arrivalRate: DEFAULT_ARRIVAL_RATE,
      circuits: DEFAULT_CIRCUITS,
      quality,
      camera: CAMERA_PRESETS[0].id,
    },
  );

  // --- Renderer ------------------------------------------------------------
  ui.setProgress(0.04, 'Creating the WebGL context\u2026');
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
  } catch (err) {
    ui.showFatalError('WebGL is unavailable', err instanceof Error ? err.stack ?? err.message : String(err));
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP[quality]));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.94;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xc8c2b4, 210, 900);

  await nextFrame();

  // --- Environment ---------------------------------------------------------
  ui.setProgress(0.14, 'Generating marble, stone and cloth\u2026');
  await nextFrame();
  const environment = new Environment(renderer, scene, quality);
  scene.add(environment.group);

  // --- Simulation ----------------------------------------------------------
  ui.setProgress(0.42, 'Laying out prayer rows\u2026');
  await nextFrame();
  const crowd = new Crowd({ capacity: CAPACITY, seed: 0x51de1a });
  crowd.tunables.targetPopulation = DEFAULT_POPULATION;
  crowd.tunables.arrivalRate = DEFAULT_ARRIVAL_RATE;
  crowd.tunables.departureRate = DEFAULT_ARRIVAL_RATE;
  crowd.tunables.circuits = DEFAULT_CIRCUITS;
  const orchestrator = new PrayerOrchestrator(crowd);
  const director = new AnimationDirector(CAPACITY);

  // --- Characters ----------------------------------------------------------
  ui.setProgress(0.55, 'Baking character animation\u2026');
  await nextFrame();
  const crowdRenderer = new CrowdRenderer(CAPACITY, CROWD_QUALITY[quality]);
  const crowdView = new CrowdView(crowdRenderer);
  scene.add(crowdRenderer.group);

  const debugView = new DebugCollisionView(CAPACITY);
  scene.add(debugView.group);

  ui.setProgress(0.84, 'Populating the courtyard\u2026');
  await nextFrame();
  crowd.populate(DEFAULT_POPULATION);

  // --- Camera / audio ------------------------------------------------------
  const cameraSystem = new CameraSystem(canvas, window.innerWidth / window.innerHeight);
  const audio = new AudioSystem((state, error) => {
    refreshAudioControls();
    if (state === 'unavailable' && error) ui.showNotice(error);
    if (state === 'blocked') ui.showNotice('Tap, click, or press a key to start Quran recitation.', 10000);
  });
  const adhan = new AdhanPlayer(audio, (_state, error) => {
    refreshAudioControls();
    if (error) ui.showNotice(error);
  });

  // --- Loop state ----------------------------------------------------------
  const clock = new FixedClock(SIM_HZ, 5);
  const frameTimer = new FrameTimer(90);
  let paused = false;
  let speed = 1;
  let simMsAverage = 0;
  let running = true;
  let lastEventCount = 0;
  let uiAccumulator = 0;

  ui.setProgress(1, 'Ready.');
  await nextFrame();
  ui.hideLoading();
  if (window.matchMedia('(pointer: fine)').matches) canvas.focus({ preventScroll: true });

  // --- Helpers -------------------------------------------------------------

  function refreshAudioControls(): void {
    ui.setAudioState(adhan.active ? adhan.state : audio.state, audio.currentSurah, adhan.active);
  }

  function toggleAudio(): void {
    if (adhan.active) {
      adhan.stop();
      audio.stop();
    } else {
      void audio.toggle();
    }
  }

  function callPrayer(): void {
    if (!orchestrator.prepare(clock.stats.simTime)) return;
    void adhan.start();
    flushEvents();
  }

  function setTargetPopulation(n: number): void {
    const clamped = Math.max(0, Math.min(CAPACITY, Math.round(n)));
    crowd.tunables.targetPopulation = clamped;
    if (clamped > crowd.prayerCapacity) {
      ui.reportPopulationError(
        `Prayer layout seats ${crowd.prayerCapacity.toLocaleString()}; the surplus will wait outside the rows.`,
      );
    } else {
      ui.reportPopulationError(null);
    }
  }

  function togglePause(): void {
    paused = !paused;
    ui.setPaused(paused);
    if (!paused) clock.resync(performance.now());
  }

  function applyQuality(q: QualityName): void {
    quality = q;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP[q]));
    renderer.shadowMap.enabled = q !== 'low';
    environment.setQuality(q);
    crowdRenderer.setQuality(CROWD_QUALITY[q]);
    ui.setQualityActive(q);
    frameTimer.reset();
  }

  function resetAll(): void {
    adhan.stop(true);
    orchestrator.reset();
    crowd.reset(crowd.tunables.targetPopulation);
    clock.reset();
    frameTimer.reset();
    paused = false;
    ui.setPaused(false);
    lastEventCount = 0;
    cameraSystem.applyPreset(CAMERA_PRESETS[0]);
    ui.setCameraActive(CAMERA_PRESETS[0].id);
    ui.showNotice('Simulation reset.');
  }

  function flushEvents(): void {
    const events = orchestrator.recentEvents;
    if (events.length === lastEventCount) return;
    // Events are newest-first; emit only the ones we have not shown.
    const fresh = events.length - lastEventCount;
    for (let i = Math.min(fresh, events.length) - 1; i >= 0; i--) {
      ui.pushEvent(events[i].t, events[i].text);
    }
    lastEventCount = events.length;
  }

  // --- Input ---------------------------------------------------------------

  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement | null;
    // Keep native editing / button activation, while allowing letter shortcuts.
    if (target?.closest('input, select, textarea, [contenteditable="true"]')) return;
    if (target?.closest('button') && (e.code === 'Space' || e.code === 'Enter')) return;
    if (cameraSystem.handleKey(e.code)) {
      ui.setCameraActive('free');
      ui.setCinematicActive(cameraSystem.cinematic);
      e.preventDefault();
      return;
    }
    switch (e.code) {
      case 'Space':
        togglePause();
        e.preventDefault();
        break;
      case 'Digit1':
      case 'Digit2':
      case 'Digit3':
      case 'Digit4': {
        const idx = Number(e.code.slice(5)) - 1;
        const preset = CAMERA_PRESETS[idx];
        if (preset) {
          cameraSystem.applyPreset(preset);
          cameraSystem.cinematic = false;
          ui.setCameraActive(preset.id);
          ui.setCinematicActive(false);
        }
        break;
      }
      case 'KeyC':
        cameraSystem.cinematic = !cameraSystem.cinematic;
        ui.setCinematicActive(cameraSystem.cinematic);
        break;
      case 'KeyP':
        callPrayer();
        break;
      case 'KeyM':
        toggleAudio();
        break;
      case 'KeyG':
        ui.toggleDiagnostics();
        break;
      case 'KeyR':
        resetAll();
        break;
      case 'Slash':
        if (e.shiftKey) ui.toggleHelp();
        break;
      default:
        break;
    }
  });

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    cameraSystem.setAspect(window.innerWidth / window.innerHeight);
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) clock.resync(performance.now());
  });

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    running = false;
    ui.showNotice('The graphics context was lost. Reload the page to restart the simulation.', 60000);
  });

  // --- Frame ---------------------------------------------------------------

  let lastRenderMs = performance.now();

  function frame(now: number): void {
    if (!running) return;
    requestAnimationFrame(frame);

    const frameStart = now;
    const renderDelta = Math.min(0.25, (now - lastRenderMs) / 1000);
    lastRenderMs = now;

    let simMs = 0;
    const alpha = clock.advance(now, paused ? 0 : speed, (dt) => {
      const t0 = performance.now();
      orchestrator.update(dt, clock.stats.simTime);
      crowd.step(dt);
      director.update(
        crowd,
        dt,
        orchestrator.timeline,
        orchestrator.phase === GlobalPhase.PRAYER ? crowd.prayerClock : -1,
      );
      simMs += performance.now() - t0;
    });

    if (clock.stats.ticks > 0) {
      simMsAverage = simMsAverage * 0.9 + (simMs / clock.stats.ticks) * 0.1;
    }

    cameraSystem.update(renderDelta);
    crowdView.update(crowd, director, cameraSystem.camera, alpha);
    debugView.update(crowd);

    renderer.render(scene, cameraSystem.camera);

    frameTimer.push(performance.now() - frameStart);

    // The interface does not need 60 Hz.
    uiAccumulator += renderDelta;
    if (uiAccumulator >= 0.2) {
      uiAccumulator = 0;
      updateUi();
      flushEvents();
    }
  }

  function updateUi(): void {
    ui.setCameraActive(cameraSystem.activePreset);
    ui.setCinematicActive(cameraSystem.cinematic);
    const model: UIModel = {
      population: crowd.liveCount,
      targetPopulation: crowd.tunables.targetPopulation,
      waiting: crowd.waiting,
      capacity: CAPACITY,
      prayerCapacity: crowd.prayerCapacity,
      byState: crowd.counters.byState,
      phase: orchestrator.phase,
      phaseDetail: orchestrator.currentLabel,
      simTime: clock.stats.simTime,
      paused,
      speed,
      circuitsCompleted: crowd.counters.circuitsCompleted,
      arrivals: crowd.counters.arrivals,
      departures: crowd.counters.departures,
      stuckRecoveries: crowd.counters.stuckRecoveries,
      settledFraction: crowd.settledFraction(),
      completedPrayers: orchestrator.completedPrayers,
      fps: frameTimer.fps,
      frameMs: frameTimer.average,
      frameP95: frameTimer.p95,
      simMs: simMsAverage,
      drawCalls: crowdRenderer.stats.drawCalls + renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      instances: crowdRenderer.stats.drawn,
      perLod: crowdRenderer.stats.perLod,
      culled: crowdRenderer.stats.culled,
      droppedTicks: clock.stats.dropped,
      audio: audio.state,
    };
    ui.update(model);
  }

  ui.setDiagnosticsVisible(true);
  updateUi();
  clock.resync(performance.now());
  requestAnimationFrame(frame);

  const cancelAutoplay = startAutoplay(audio);
  window.addEventListener('pagehide', () => {
    cancelAutoplay();
    adhan.stop();
    audio.stop();
  });

  // Expose a small handle for the automated visual QA harness. This is read
  // by tools/visual-qa.mjs; it is not part of the public interface.
  (window as unknown as Record<string, unknown>).__haram = {
    crowd,
    orchestrator,
    cameraSystem,
    crowdRenderer,
    environment,
    clock,
    setPopulation: (n: number) => {
      crowd.reset(n);
    },
    setPaused: (p: boolean) => {
      paused = p;
      if (!p) clock.resync(performance.now());
    },
    step: (seconds: number) => {
      const dt = 1 / SIM_HZ;
      const steps = Math.round(seconds / dt);
      for (let i = 0; i < steps; i++) {
        orchestrator.update(dt, clock.stats.simTime);
        crowd.step(dt);
        director.update(
          crowd,
          dt,
          orchestrator.timeline,
          orchestrator.phase === GlobalPhase.PRAYER ? crowd.prayerClock : -1,
        );
        clock.stats.simTime += dt;
      }
    },
    stats: () => ({
      population: crowd.liveCount,
      phase: orchestrator.phase,
      drawn: crowdRenderer.stats.drawn,
      perLod: crowdRenderer.stats.perLod,
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      envTriangles: environment.stats.triangles,
      bakeMs: crowdRenderer.stats.bakeMs,
      vatBytes: crowdRenderer.stats.vatBytes,
    }),
  };
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

boot().catch((err) => {
  // Last-resort error surface: if boot itself failed we may not have a UI.
  const detail = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
  const app = document.getElementById('app');
  if (app) {
    app.innerHTML = '';
    const pre = document.createElement('pre');
    pre.style.cssText =
      'position:fixed;inset:0;margin:0;padding:32px;background:#0b0d0f;color:#e2705f;font:12px ui-monospace,monospace;white-space:pre-wrap;overflow:auto;';
    pre.textContent = `The simulation failed to start.\n\n${detail}`;
    app.append(pre);
  }
  console.error(err);
});
