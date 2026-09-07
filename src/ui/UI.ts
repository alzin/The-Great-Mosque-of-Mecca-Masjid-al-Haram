/**
 * UI.ts — the whole overlay: controls, diagnostics, phase banner, event log,
 * loading and error states.
 *
 * PRINCIPLES
 *   * Restrained. The simulation is the subject. Panels are translucent, the
 *     type is small, and nothing animates for its own sake.
 *   * Keyboard-complete. Every control is a real focusable element with a
 *     label, and the frequently used ones also have single-key shortcuts.
 *     Nothing requires a pointer.
 *   * Honest. The "3D simulation" badge is not dismissible, the diagnostics
 *     report what is measured rather than what is hoped for, and failures
 *     surface as readable errors rather than a black screen.
 */

import { AGENT_STATE_NAMES, GLOBAL_PHASE_NAMES, GlobalPhase } from '../sim/States.ts';
import type { AudioState } from '../audio/AudioSystem.ts';
import { RECITATION } from '../audio/recitation.ts';
import { ADHAN } from '../audio/AdhanPlayer.ts';

export type QualityName = 'low' | 'medium' | 'high';

export interface UIModel {
  population: number;
  targetPopulation: number;
  waiting: number;
  capacity: number;
  prayerCapacity: number;
  byState: Int32Array;
  phase: GlobalPhase;
  phaseDetail: string;
  simTime: number;
  paused: boolean;
  speed: number;
  circuitsCompleted: number;
  arrivals: number;
  departures: number;
  stuckRecoveries: number;
  settledFraction: number;
  completedPrayers: number;
  fps: number;
  frameMs: number;
  frameP95: number;
  simMs: number;
  drawCalls: number;
  triangles: number;
  instances: number;
  perLod: readonly number[];
  culled: number;
  droppedTicks: number;
  audio: string;
}

export interface UICallbacks {
  setTargetPopulation(n: number): void;
  setArrivalRate(n: number): void;
  setCircuits(n: number): void;
  togglePause(): void;
  setSpeed(v: number): void;
  callPrayer(): void;
  cancelPrayer(): void;
  setRakahs(n: number): void;
  setPrayerScale(v: number): void;
  setSchedule(on: boolean): void;
  setCamera(id: string): void;
  setCinematic(on: boolean): void;
  setQuality(q: QualityName): void;
  reset(): void;
  toggleAudio(): void;
  setDebugCollision(on: boolean): void;
}

export interface CameraOption {
  id: string;
  label: string;
  description: string;
}

const MAX_EVENTS = 6;
type MobileGroup = 'controls' | 'camera' | 'info';
type MobilePage = 'crowd' | 'prayer' | 'camera' | 'display' | 'diagnostics' | 'help';
const MOBILE_PAGES: Record<MobileGroup, readonly [MobilePage, string][]> = {
  controls: [['crowd', 'Crowd'], ['prayer', 'Prayer']],
  camera: [['camera', 'Camera']],
  info: [['display', 'Display'], ['diagnostics', 'Diagnostics'], ['help', 'Help']],
};

export class UI {
  readonly root: HTMLDivElement;

  private readonly popNumber: HTMLInputElement;
  private readonly popSlider: HTMLInputElement;
  private readonly popError: HTMLParagraphElement;
  private readonly arrivalNumber: HTMLInputElement;
  private readonly arrivalSlider: HTMLInputElement;
  private readonly circuitsNumber: HTMLInputElement;
  private readonly speedSlider: HTMLInputElement;
  private readonly speedLabel: HTMLSpanElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly prayerButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly scheduleButton: HTMLButtonElement;
  private readonly cinematicButton: HTMLButtonElement;
  private readonly audioButton: HTMLButtonElement;
  private readonly audioTrack: HTMLParagraphElement;
  private readonly debugButton: HTMLButtonElement;
  private readonly cameraButtons = new Map<string, HTMLButtonElement>();
  private readonly qualityButtons = new Map<QualityName, HTMLButtonElement>();

  private readonly readoutValues = new Map<string, HTMLElement>();
  private readonly diagValues = new Map<string, HTMLElement>();
  private readonly phaseLabel: HTMLDivElement;
  private readonly phaseDetail: HTMLDivElement;
  private readonly eventList: HTMLUListElement;
  private readonly liveRegion: HTMLDivElement;
  private readonly diagnosticsPanel: HTMLDivElement;
  private readonly helpPanel: HTMLDivElement;
  private readonly noticeEl: HTMLDivElement;

  private readonly loadingOverlay: HTMLDivElement;
  private readonly progressFill: HTMLDivElement;
  private readonly progressLabel: HTMLDivElement;
  private readonly mobileQuery = window.matchMedia('(max-width: 900px), (max-height: 500px) and (pointer: coarse)');
  private readonly sheetPanel = el('div', 'sheet-panel');
  private readonly sheetContent = el('div', 'sheet-content');
  private readonly sheetTabs = el('div', 'sheet-tabs');
  private readonly sheetTitle = el('h2');
  private readonly sheetBackdrop = button('Dismiss panel', () => this.closeSheet());
  private readonly dockButtons = new Map<MobileGroup, HTMLButtonElement>();
  private mobilePauseButton!: HTMLButtonElement;
  private mobileGroup: MobileGroup | null = null;
  private mobilePage: MobilePage = 'crowd';
  private helpVisible = false;


  constructor(
    parent: HTMLElement,
    cb: UICallbacks,
    cameras: readonly CameraOption[],
    maxPopulation: number,
    defaults: {
      population: number;
      arrivalRate: number;
      circuits: number;
      quality: QualityName;
      camera: string;
    },
  ) {
    this.root = el('div', 'ui-root');
    this.root.setAttribute('role', 'region');
    this.root.setAttribute('aria-label', 'Simulation controls');

    // --- Title -------------------------------------------------------------
    const title = el('div', 'title-block');
    const h1 = el('h1');
    h1.append(document.createTextNode('Masjid al-Haram'));
    const titleDetail = el('span', 'title-detail');
    titleDetail.textContent = ' \u2014 central precinct';
    h1.append(titleDetail);
    const sub = el('p');
    sub.textContent =
      'Agent-based reconstruction of tawaf and congregational prayer. Approximate dimensions.';
    const badge = el('div', 'not-live');
    badge.textContent = '3D simulation \u2014 not a live feed';
    title.append(h1, sub, badge);
    this.root.append(title);

    this.audioButton = button('', () => cb.toggleAudio());
    this.audioButton.className = 'audio-toggle';
    this.audioButton.setAttribute('aria-label', 'Play Quran');
    this.audioButton.setAttribute('aria-pressed', 'false');
    this.audioButton.title = 'Play Quran (M)';
    setDockLabel(this.audioButton, 'sound-off', 'Quran');
    this.root.append(this.audioButton);

    // --- Controls ----------------------------------------------------------
    const controls = el('div', 'panel controls');
    controls.setAttribute('aria-label', 'Controls');

    // Population
    {
      const s = section('Population', 'crowd');
      const { number, slider, error } = numberWithSlider(
        'Target',
        0,
        maxPopulation,
        1,
        defaults.population,
        (v) => cb.setTargetPopulation(v),
      );
      this.popNumber = number;
      this.popSlider = slider;
      this.popError = error;
      s.append(number.parentElement!, slider.parentElement!, error);

      const dl = el('dl', 'readout');
      for (const [key, label] of [
        ['current', 'In the precinct'],
        ['target', 'Target'],
        ['waiting', 'Waiting to enter'],
        ['tawaf', 'Performing tawaf'],
        ['praying', 'In prayer'],
      ] as const) {
        const dt = el('dt');
        dt.textContent = label;
        const dd = el('dd');
        dd.textContent = '\u2014';
        this.readoutValues.set(key, dd);
        dl.append(dt, dd);
      }
      s.append(dl);

      const hint = el('p', 'hint');
      hint.textContent = `Capacity ${maxPopulation.toLocaleString()}. People arrive through the gates and leave on foot; changing the target never makes anyone appear or vanish in place.`;
      s.append(hint);
      controls.append(s);
    }

    // Flow
    {
      const s = section('Flow', 'crowd');
      const arrival = numberWithSlider(
        'Arrivals /min',
        0,
        180,
        1,
        defaults.arrivalRate,
        (v) => cb.setArrivalRate(v),
      );
      this.arrivalNumber = arrival.number;
      this.arrivalSlider = arrival.slider;
      s.append(arrival.number.parentElement!, arrival.slider.parentElement!);

      const circuits = labelledNumber('Circuits', 1, 7, 1, defaults.circuits, (v) =>
        cb.setCircuits(v),
      );
      this.circuitsNumber = circuits.input;
      s.append(circuits.row);
      controls.append(s);
    }

    // Simulation
    {
      const s = section('Simulation', 'crowd');
      const row = el('div', 'button-row');
      this.pauseButton = button('Pause', () => cb.togglePause());
      this.pauseButton.setAttribute('aria-pressed', 'false');
      const resetButton = button('Reset', () => cb.reset());
      row.append(this.pauseButton, resetButton);
      s.append(row);

      const speedRow = el('div', 'row');
      const lbl = el('label');
      lbl.textContent = 'Speed';
      const slider = el('input') as HTMLInputElement;
      slider.type = 'range';
      slider.min = '0.25';
      slider.max = '4';
      slider.step = '0.25';
      slider.value = '1';
      slider.className = 'grow';
      slider.setAttribute('aria-label', 'Simulation speed multiplier');
      const id = uid();
      slider.id = id;
      lbl.htmlFor = id;
      const out = el('span');
      out.style.fontFamily = 'var(--ui-mono)';
      out.style.minWidth = '34px';
      out.style.textAlign = 'right';
      out.textContent = '1.00x';
      slider.addEventListener('input', () => {
        const v = Number(slider.value);
        out.textContent = `${v.toFixed(2)}x`;
        cb.setSpeed(v);
      });
      speedRow.append(lbl, slider, out);
      this.speedSlider = slider;
      this.speedLabel = out;
      s.append(speedRow);

      const clock = el('dl', 'readout');
      const dt = el('dt');
      dt.textContent = 'Simulated time';
      const dd = el('dd');
      dd.textContent = '00:00:00';
      this.readoutValues.set('clock', dd);
      clock.append(dt, dd);
      s.append(clock);
      controls.append(s);
    }

    // Prayer
    {
      const s = section('Congregational prayer', 'prayer');
      const row = el('div', 'button-row');
      this.prayerButton = button('Call to prayer', () => cb.callPrayer());
      this.cancelButton = button('Cancel', () => cb.cancelPrayer());
      this.cancelButton.disabled = true;
      row.append(this.prayerButton, this.cancelButton);
      s.append(row);

      const rakahRow = el('div', 'row');
      const rl = el('label');
      rl.textContent = "Rak\u2018ahs";
      const sel = el('select') as HTMLSelectElement;
      for (const n of [2, 3, 4]) {
        const o = el('option') as HTMLOptionElement;
        o.value = String(n);
        o.textContent = String(n);
        sel.append(o);
      }
      sel.value = '2';
      const rid = uid();
      sel.id = rid;
      rl.htmlFor = rid;
      sel.addEventListener('change', () => cb.setRakahs(Number(sel.value)));
      rakahRow.append(rl, sel);
      s.append(rakahRow);

      const scaleRow = el('div', 'row');
      const sl = el('label');
      sl.textContent = 'Pace';
      const scale = el('input') as HTMLInputElement;
      scale.type = 'range';
      scale.min = '0.3';
      scale.max = '1.5';
      scale.step = '0.1';
      scale.value = '1';
      scale.className = 'grow';
      const sid = uid();
      scale.id = sid;
      sl.htmlFor = sid;
      scale.setAttribute('aria-label', 'Prayer posture duration scale');
      scale.addEventListener('input', () => cb.setPrayerScale(Number(scale.value)));
      scaleRow.append(sl, scale);
      s.append(scaleRow);

      this.scheduleButton = button('Repeat on a timer', () => {
        const on = this.scheduleButton.getAttribute('aria-pressed') !== 'true';
        this.scheduleButton.setAttribute('aria-pressed', String(on));
        cb.setSchedule(on);
      });
      this.scheduleButton.setAttribute('aria-pressed', 'false');
      const schedRow = el('div', 'button-row');
      schedRow.append(this.scheduleButton);
      s.append(schedRow);

      const hint = el('p', 'hint');
      hint.textContent =
        'Call to prayer plays the Haram adhan by Ali Ahmed Mulla and pauses Quran playback until it finishes. The demonstration clock runs independently of the recording.';
      s.append(hint);
      const adhanSource = el('a') as HTMLAnchorElement;
      adhanSource.href = ADHAN.sourcePage;
      adhanSource.textContent = 'Adhan recording · Islamweb';
      adhanSource.className = 'audio-source';
      adhanSource.target = '_blank';
      adhanSource.rel = 'noopener noreferrer';
      s.append(adhanSource);
      controls.append(s);
    }

    // Camera
    {
      const s = section('Camera', 'camera');
      const row = el('div', 'button-row');
      cameras.forEach((c, i) => {
        const b = button(c.label, () => {
          cb.setCamera(c.id);
          if (this.mobileQuery.matches) this.closeSheet();
        });
        b.title = `${c.description} (key ${i + 1})`;
        b.setAttribute('aria-pressed', String(c.id === defaults.camera));
        this.cameraButtons.set(c.id, b);
        row.append(b);
      });
      s.append(row);

      const row2 = el('div', 'button-row');
      this.cinematicButton = button('Cinematic drift', () => {
        const on = this.cinematicButton.getAttribute('aria-pressed') !== 'true';
        this.cinematicButton.setAttribute('aria-pressed', String(on));
        cb.setCinematic(on);
      });
      this.cinematicButton.setAttribute('aria-pressed', 'false');
      row2.append(this.cinematicButton);
      s.append(row2);

      const hint = el('p', 'hint');
      hint.textContent = 'Drag with one finger to orbit. Pinch with two fingers to zoom. With a mouse, drag to orbit and scroll to zoom. Arrow keys also move the camera.';
      s.append(hint);
      controls.append(s);
    }

    // Display
    {
      const s = section('Display', 'display');
      const row = el('div', 'button-row');
      for (const q of ['low', 'medium', 'high'] as const) {
        const b = button(q[0].toUpperCase() + q.slice(1), () => cb.setQuality(q));
        b.setAttribute('aria-pressed', String(q === defaults.quality));
        this.qualityButtons.set(q, b);
        row.append(b);
      }
      s.append(row);

      this.audioTrack = el('p', 'hint');
      this.audioTrack.setAttribute('aria-live', 'polite');
      this.audioTrack.textContent = 'Al-Fatihah · Surah 1 of 114';
      s.append(this.audioTrack);
      const credit = el('p', 'hint');
      const reciter = el('span');
      reciter.lang = 'ar';
      reciter.dir = 'rtl';
      reciter.textContent = RECITATION.reciterArabic;
      const source = el('a') as HTMLAnchorElement;
      source.href = RECITATION.sourcePage;
      source.target = '_blank';
      source.rel = 'noopener noreferrer';
      source.textContent = 'MP3Quran';
      source.style.color = 'var(--ui-accent)';
      credit.append(reciter, ' · ', source, document.createElement('br'), 'Continues in Quran order. Internet required.');
      s.append(credit);

      const row3 = el('div', 'button-row');
      this.debugButton = button('Collision view', () => {
        const on = this.debugButton.getAttribute('aria-pressed') !== 'true';
        this.debugButton.setAttribute('aria-pressed', String(on));
        cb.setDebugCollision(on);
      });
      this.debugButton.setAttribute('aria-pressed', 'false');
      this.debugButton.title =
        'Show the simplified collision primitives the crowd actually steers around.';
      row3.append(this.debugButton);
      s.append(row3);
      controls.append(s);
    }

    this.root.append(controls);

    // --- Diagnostics -------------------------------------------------------
    this.diagnosticsPanel = el('div', 'panel diagnostics');
    this.diagnosticsPanel.dataset.mobilePage = 'diagnostics';
    this.diagnosticsPanel.setAttribute('aria-label', 'Performance diagnostics');
    const dh = el('h2');
    dh.textContent = 'Diagnostics';
    this.diagnosticsPanel.append(dh);
    const dl = el('dl', 'readout');
    for (const [key, label] of [
      ['fps', 'FPS'],
      ['frame', 'Frame ms'],
      ['p95', 'Frame p95'],
      ['sim', 'Sim ms/tick'],
      ['pop', 'Agents'],
      ['drawn', 'Drawn'],
      ['lod', 'LOD 0/1/2'],
      ['calls', 'Draw calls'],
      ['tris', 'Triangles'],
      ['dropped', 'Dropped ticks'],
    ] as const) {
      const dt = el('dt');
      dt.textContent = label;
      const dd = el('dd');
      dd.textContent = '\u2014';
      this.diagValues.set(key, dd);
      dl.append(dt, dd);
    }
    this.diagnosticsPanel.append(dl);
    this.root.append(this.diagnosticsPanel);

    // --- Phase banner ------------------------------------------------------
    const banner = el('div', 'panel phase-banner');
    this.phaseLabel = el('div', 'phase');
    this.phaseLabel.textContent = 'Normal activity';
    this.phaseDetail = el('div', 'detail');
    this.phaseDetail.textContent = '';
    banner.append(this.phaseLabel, this.phaseDetail);
    this.root.append(banner);

    // --- Event log ---------------------------------------------------------
    const log = el('div', 'panel event-log');
    log.dataset.mobilePage = 'diagnostics';
    const lh = el('h2');
    lh.textContent = 'Events';
    this.eventList = el('ul') as HTMLUListElement;
    log.append(lh, this.eventList);
    this.root.append(log);

    // --- Notice + live region ---------------------------------------------
    this.noticeEl = el('div', 'panel notice');
    this.noticeEl.style.display = 'none';
    this.root.append(this.noticeEl);

    this.liveRegion = el('div', 'visually-hidden');
    this.liveRegion.setAttribute('role', 'status');
    this.liveRegion.setAttribute('aria-live', 'polite');
    this.root.append(this.liveRegion);

    // --- Help --------------------------------------------------------------
    this.helpPanel = el('div', 'panel help');
    this.helpPanel.dataset.mobilePage = 'help';
    const hh = el('h2');
    hh.textContent = 'Getting around';
    const touchHelp = el('p', 'touch-help');
    touchHelp.textContent = 'Drag to explore the courtyard. Pinch to zoom. Use the bottom bar for controls and camera views. Swipe down on a panel’s header or tap × to close it.';
    const hdl = el('dl');
    for (const [k, v] of [
      ['Space', 'Pause / resume'],
      ['1 – 4', 'Camera presets'],
      ['C', 'Cinematic drift'],
      ['P', 'Call to prayer'],
      ['\u2190 \u2192 \u2191 \u2193', 'Orbit the camera'],
      ['+ / \u2212', 'Dolly in and out'],
      ['M', 'Quran play / pause'],
      ['G', 'Diagnostics panel'],
      ['R', 'Reset'],
      ['?', 'This list'],
    ]) {
      const dt = el('dt');
      dt.textContent = k;
      const dd = el('dd');
      dd.textContent = v;
      hdl.append(dt, dd);
    }
    this.helpPanel.append(hh, touchHelp, hdl);
    this.root.append(this.helpPanel);

    this.setupMobileNavigation(cb, controls, log);

    // --- Loading overlay ---------------------------------------------------
    this.loadingOverlay = el('div', 'overlay');
    const oi = el('div', 'overlay-inner');
    const oh = el('h1');
    oh.textContent = 'Masjid al-Haram \u2014 3D simulation';
    const op = el('p');
    op.textContent = 'Generating geometry, textures and animation. Nothing is downloaded.';
    const track = el('div', 'progress-track');
    this.progressFill = el('div', 'progress-fill');
    track.append(this.progressFill);
    this.progressLabel = el('div', 'progress-label');
    this.progressLabel.textContent = 'Starting\u2026';
    oi.append(oh, op, track, this.progressLabel);
    this.loadingOverlay.append(oi);
    parent.append(this.loadingOverlay);

    parent.append(this.root);

    // Reflect defaults.
    this.setPopulationInputs(defaults.population);
    this.arrivalNumber.value = String(defaults.arrivalRate);
    this.arrivalSlider.value = String(defaults.arrivalRate);
    this.circuitsNumber.value = String(defaults.circuits);
  }

  /** One set of controls: desktop panels become a compact, non-modal phone sheet. */
  private setupMobileNavigation(cb: UICallbacks, controls: HTMLDivElement, log: HTMLDivElement): void {
    this.sheetPanel.id = uid();
    this.sheetTitle.id = uid();
    this.sheetTitle.tabIndex = -1;
    this.sheetPanel.setAttribute('aria-labelledby', this.sheetTitle.id);
    const header = el('div', 'sheet-header');
    const handle = el('div', 'sheet-handle');
    handle.setAttribute('aria-hidden', 'true');
    const close = button('\u00d7', () => this.closeSheet());
    close.className = 'sheet-close';
    close.setAttribute('aria-label', 'Close panel');
    header.append(handle, this.sheetTitle, close);
    this.sheetContent.append(controls, this.diagnosticsPanel, log, this.helpPanel);
    this.sheetPanel.append(header, this.sheetTabs, this.sheetContent);
    this.sheetBackdrop.className = 'sheet-backdrop';
    this.sheetBackdrop.textContent = '';
    this.sheetBackdrop.tabIndex = -1;
    this.sheetBackdrop.setAttribute('aria-hidden', 'true');

    const dock = el('nav', 'mobile-dock');
    dock.setAttribute('aria-label', 'Simulation navigation');
    this.mobilePauseButton = button('Pause', () => cb.togglePause());
    this.mobilePauseButton.setAttribute('aria-pressed', 'false');
    setDockLabel(this.mobilePauseButton, 'pause', 'Pause');
    dock.append(this.mobilePauseButton);
    for (const [id, label, icon] of [
      ['controls', 'Controls', 'sliders'],
      ['camera', 'Camera', 'camera'],
      ['info', 'Info', 'info'],
    ] as const) {
      const b = button(label, () => {
        if (this.mobileGroup === id) this.closeSheet();
        else this.openSheet(id);
      });
      setDockLabel(b, icon, label);
      b.setAttribute('aria-controls', this.sheetPanel.id);
      b.setAttribute('aria-expanded', 'false');
      this.dockButtons.set(id, b);
      dock.append(b);
    }
    this.root.append(this.sheetBackdrop, this.sheetPanel, dock);

    // A swipe on the header dismisses; scrolling or adjusting sliders never does.
    let swipe: { id: number; x: number; y: number } | null = null;
    header.addEventListener('pointerdown', (e) => {
      if (!this.mobileQuery.matches || (e.target as HTMLElement).closest('button')) return;
      swipe = { id: e.pointerId, x: e.clientX, y: e.clientY };
      header.setPointerCapture(e.pointerId);
    });
    header.addEventListener('pointerup', (e) => {
      if (swipe?.id !== e.pointerId) return;
      if (e.clientY - swipe.y > 48 && Math.abs(e.clientX - swipe.x) < 80) this.closeSheet();
      swipe = null;
      if (header.hasPointerCapture(e.pointerId)) header.releasePointerCapture(e.pointerId);
    });
    header.addEventListener('pointercancel', () => { swipe = null; });
    header.addEventListener('lostpointercapture', () => { swipe = null; });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.mobileQuery.matches && this.mobileGroup) {
        this.closeSheet();
        e.preventDefault();
      }
    });
    this.mobileQuery.addEventListener('change', () => {
      const focusInSheet = this.sheetPanel.contains(document.activeElement);
      const focusInDock = dock.contains(document.activeElement);
      this.mobileGroup = null;
      this.syncSheet();
      if (this.mobileQuery.matches && focusInSheet) this.dockButtons.get('controls')?.focus();
      else if (!this.mobileQuery.matches && (focusInDock || focusInSheet)) document.getElementById('viewport')?.focus();
    });

    // Keep the dock and sheet above the software keyboard / browser chrome.
    const syncViewport = () => {
      const viewport = window.visualViewport;
      const height = viewport?.height ?? window.innerHeight;
      this.root.style.setProperty('--visible-height', `${height}px`);
      this.root.style.setProperty('--visible-top', `${viewport?.offsetTop ?? 0}px`);
      this.root.classList.toggle('viewport-compact', height < 500);
    };
    window.visualViewport?.addEventListener('resize', syncViewport);
    window.visualViewport?.addEventListener('scroll', syncViewport);
    window.addEventListener('resize', syncViewport);
    syncViewport();
    this.syncSheet();
  }

  private openSheet(group: MobileGroup, page = MOBILE_PAGES[group][0][0]): void {
    this.mobileGroup = group;
    this.mobilePage = page;
    this.sheetTitle.textContent = group === 'info' ? 'Information' : group === 'camera' ? 'Camera views' : 'Simulation controls';
    this.sheetTabs.replaceChildren();
    this.sheetTabs.setAttribute('aria-label', `${this.sheetTitle.textContent} sections`);
    const pages = MOBILE_PAGES[group];
    this.sheetTabs.hidden = pages.length < 2;
    for (const [id, label] of pages) {
      const tab = button(label, () => {
        this.mobilePage = id;
        this.syncSheet();
        this.sheetContent.scrollTop = 0;
      });
      tab.dataset.page = id;
      this.sheetTabs.append(tab);
    }
    this.syncSheet();
    this.sheetContent.scrollTop = 0;
    this.sheetTitle.focus({ preventScroll: true });
  }

  private closeSheet(): void {
    const previous = this.mobileGroup;
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.sheetPanel.contains(active)) active.blur();
    this.mobileGroup = null;
    this.syncSheet();
    if (previous) this.dockButtons.get(previous)?.focus({ preventScroll: true });
  }

  private syncSheet(): void {
    const mobile = this.mobileQuery.matches;
    const open = mobile && this.mobileGroup !== null;
    this.sheetPanel.classList.toggle('is-open', open);
    this.sheetPanel.inert = mobile && !open;
    this.sheetPanel.setAttribute('role', mobile ? 'region' : 'presentation');
    this.sheetBackdrop.hidden = !open;
    this.root.classList.toggle('sheet-open', open);
    for (const [id, b] of this.dockButtons) b.setAttribute('aria-expanded', String(open && id === this.mobileGroup));
    for (const node of this.sheetContent.querySelectorAll<HTMLElement>('[data-mobile-page]')) {
      node.dataset.active = String(node.dataset.mobilePage === this.mobilePage);
    }
    for (const tab of this.sheetTabs.querySelectorAll('button')) {
      tab.setAttribute('aria-pressed', String(tab.dataset.page === this.mobilePage));
    }
  }

  // -----------------------------------------------------------------------
  // Loading / error
  // -----------------------------------------------------------------------

  setProgress(fraction: number, label: string): void {
    this.progressFill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
    this.progressLabel.textContent = label;
  }

  hideLoading(): void {
    this.loadingOverlay.classList.add('hidden');
    window.setTimeout(() => {
      this.loadingOverlay.style.display = 'none';
    }, 500);
  }

  /** Replace the loading overlay with a readable failure. */
  showFatalError(title: string, detail: string): void {
    this.loadingOverlay.style.display = 'flex';
    this.loadingOverlay.classList.remove('hidden');
    this.loadingOverlay.textContent = '';
    const inner = el('div', 'overlay-inner');
    const panel = el('div', 'error-panel');
    const h = el('h1');
    h.textContent = title;
    const p = el('p');
    p.textContent =
      'The simulation could not start. This is usually a WebGL problem: a browser without WebGL 2, a disabled GPU, or a driver that refuses the context.';
    const pre = el('pre');
    pre.textContent = detail;
    panel.append(h, p, pre);
    inner.append(panel);
    this.loadingOverlay.append(inner);
  }

  /** A non-fatal message, shown briefly at the top of the screen. */
  showNotice(text: string, ms = 5200): void {
    this.noticeEl.textContent = text;
    this.noticeEl.style.display = 'block';
    this.liveRegion.textContent = text;
    window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => {
      this.noticeEl.style.display = 'none';
    }, ms);
  }

  private noticeTimer = 0;

  // -----------------------------------------------------------------------
  // State reflection
  // -----------------------------------------------------------------------

  private setPopulationInputs(v: number): void {
    this.popNumber.value = String(v);
    this.popSlider.value = String(v);
  }

  /** Called when the app clamps or rejects a typed value. */
  reportPopulationError(message: string | null): void {
    this.popError.textContent = message ?? '';
    this.popError.style.display = message ? 'block' : 'none';
    this.popNumber.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (message) this.liveRegion.textContent = message;
  }

  /** Reflect a speed change that did not come from the slider. */
  setSpeedValue(v: number): void {
    this.speedSlider.value = String(v);
    this.speedLabel.textContent = `${v.toFixed(2)}x`;
  }

  setPaused(paused: boolean): void {
    this.pauseButton.textContent = paused ? 'Resume' : 'Pause';
    this.pauseButton.setAttribute('aria-pressed', String(paused));
    setDockLabel(this.mobilePauseButton, paused ? 'play' : 'pause', paused ? 'Resume' : 'Pause');
    this.mobilePauseButton.setAttribute('aria-pressed', String(paused));
  }

  setCameraActive(id: string): void {
    for (const [key, b] of this.cameraButtons) {
      b.setAttribute('aria-pressed', String(key === id));
    }
  }

  setCinematicActive(on: boolean): void {
    this.cinematicButton.setAttribute('aria-pressed', String(on));
  }

  setQualityActive(q: QualityName): void {
    for (const [key, b] of this.qualityButtons) {
      b.setAttribute('aria-pressed', String(key === q));
    }
  }

  setAudioState(state: AudioState, surah: number, adhan = false): void {
    const on = state === 'on' || state === 'starting';
    const action = adhan ? 'Stop adhan' : on ? 'Pause Quran' : state === 'unavailable' ? 'Retry Quran' : 'Play Quran';
    setDockLabel(this.audioButton, on ? 'sound-on' : 'sound-off', adhan ? 'Adhan' : 'Quran');
    this.audioButton.setAttribute('aria-label', action);
    this.audioButton.title = `${action}${state === 'starting' ? ' · Loading' : ''} (M)`;
    this.audioButton.setAttribute('aria-pressed', String(on));
    this.audioButton.dataset.state = state;
    const name = surah === 1 ? 'Al-Fatihah · ' : surah === 2 ? 'Al-Baqarah · ' : '';
    this.audioTrack.textContent = adhan ? `Haram adhan · ${ADHAN.muezzin}` : `${name}Surah ${surah} of ${RECITATION.surahCount}`;
  }

  setDiagnosticsVisible(on: boolean): void {
    this.diagnosticsPanel.classList.toggle('diagnostics-hidden', !on);
  }

  toggleDiagnostics(): void {
    if (this.mobileQuery.matches) {
      if (this.mobileGroup === 'info' && this.mobilePage === 'diagnostics') this.closeSheet();
      else this.openSheet('info', 'diagnostics');
      return;
    }
    this.setDiagnosticsVisible(this.diagnosticsPanel.classList.contains('diagnostics-hidden'));
  }

  toggleHelp(): void {
    if (this.mobileQuery.matches) {
      if (this.mobileGroup === 'info' && this.mobilePage === 'help') this.closeSheet();
      else this.openSheet('info', 'help');
      return;
    }
    this.helpVisible = !this.helpVisible;
    this.helpPanel.classList.toggle('help-visible', this.helpVisible);
  }

  pushEvent(time: number, text: string): void {
    const li = el('li');
    const t = el('time');
    t.textContent = formatClock(time);
    li.append(t, document.createTextNode(text));
    this.eventList.prepend(li);
    while (this.eventList.children.length > MAX_EVENTS) {
      this.eventList.lastElementChild?.remove();
    }
    this.liveRegion.textContent = text;
  }

  update(m: UIModel): void {
    setText(this.readoutValues.get('current'), m.population.toLocaleString());
    setText(this.readoutValues.get('target'), m.targetPopulation.toLocaleString());
    setText(this.readoutValues.get('waiting'), m.waiting.toLocaleString());

    const tawaf =
      (m.byState[2] ?? 0) + (m.byState[3] ?? 0) + (m.byState[4] ?? 0);
    setText(this.readoutValues.get('tawaf'), tawaf.toLocaleString());
    const praying = (m.byState[7] ?? 0) + (m.byState[6] ?? 0);
    setText(this.readoutValues.get('praying'), praying.toLocaleString());
    setText(this.readoutValues.get('clock'), formatClock(m.simTime));

    // Keep the population inputs in step unless the user is editing them.
    if (document.activeElement !== this.popNumber && document.activeElement !== this.popSlider) {
      this.setPopulationInputs(m.targetPopulation);
    }

    const phase = (GLOBAL_PHASE_NAMES[m.phase] ?? 'Normal activity').toLowerCase().replaceAll('_', ' ');
    setText(this.phaseLabel, phase.charAt(0).toUpperCase() + phase.slice(1));
    setText(this.phaseDetail, m.phaseDetail);
    this.prayerButton.disabled = m.phase !== GlobalPhase.NORMAL_ACTIVITY;
    this.cancelButton.disabled = m.phase === GlobalPhase.NORMAL_ACTIVITY;

    setText(this.diagValues.get('fps'), m.fps.toFixed(0));
    setText(this.diagValues.get('frame'), m.frameMs.toFixed(1));
    setText(this.diagValues.get('p95'), m.frameP95.toFixed(1));
    setText(this.diagValues.get('sim'), m.simMs.toFixed(2));
    setText(this.diagValues.get('pop'), m.population.toLocaleString());
    setText(this.diagValues.get('drawn'), m.instances.toLocaleString());
    setText(this.diagValues.get('lod'), m.perLod.join('/'));
    setText(this.diagValues.get('calls'), String(m.drawCalls));
    setText(this.diagValues.get('tris'), formatCount(m.triangles));
    const dropped = this.diagValues.get('dropped');
    setText(dropped, String(m.droppedTicks));
    if (dropped) dropped.classList.toggle('warn', m.droppedTicks > 0);
  }

  /** State names, exposed so the app can label a debug overlay consistently. */
  static stateName(index: number): string {
    return AGENT_STATE_NAMES[index] ?? `state ${index}`;
  }
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

let uidCounter = 0;
function uid(): string {
  uidCounter += 1;
  return `hs-${uidCounter}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function section(title: string, page: MobilePage): HTMLElement {
  const s = el('section', 'section');
  s.dataset.mobilePage = page;
  const h = el('h2');
  h.textContent = title;
  s.append(h);
  return s;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = el('button') as HTMLButtonElement;
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function setDockLabel(b: HTMLButtonElement, name: string, label: string): void {
  const paths: Record<string, string> = {
    'sound-on': 'M11 4 6 8H3v8h3l5 4ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14',
    'sound-off': 'M11 4 6 8H3v8h3l5 4ZM16 9l6 6m0-6-6 6',
    pause: 'M8 5v14M16 5v14',
    play: 'm8 5 11 7-11 7Z',
    sliders: 'M4 7h5m4 0h7M4 17h9m4 0h3M9 4v6m4 4v6',
    camera: 'M4 7h4l2-3h4l2 3h4v13H4ZM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    info: 'M12 11v6m0-10v.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  };
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '1.7');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name]);
  icon.append(path);
  const text = el('span');
  text.textContent = label;
  b.replaceChildren(icon, text);
}

function setText(node: HTMLElement | undefined, text: string): void {
  if (node && node.textContent !== text) node.textContent = text;
}

function labelledNumber(
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  onChange: (v: number) => void,
): { row: HTMLDivElement; input: HTMLInputElement } {
  const row = el('div', 'row');
  const l = el('label');
  l.textContent = label;
  const input = el('input') as HTMLInputElement;
  input.type = 'number';
  input.inputMode = 'numeric';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const id = uid();
  input.id = id;
  l.htmlFor = id;
  const commit = () => {
    const v = Number(input.value);
    if (!Number.isFinite(v)) {
      input.value = String(value);
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(v / step) * step));
    input.value = String(clamped);
    onChange(clamped);
  };
  input.addEventListener('change', commit);
  input.addEventListener('blur', commit);
  row.append(l, input);
  return { row, input };
}

/**
 * A number field and a slider bound to the same value. Both are required by
 * the brief: the slider for exploration, the field for a precise figure.
 * Invalid input is clamped, reported, and never allowed to reach the
 * simulation.
 */
function numberWithSlider(
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  onChange: (v: number) => void,
): {
  number: HTMLInputElement;
  slider: HTMLInputElement;
  error: HTMLParagraphElement;
} {
  const numRow = el('div', 'row');
  const l = el('label');
  l.textContent = label;
  const number = el('input') as HTMLInputElement;
  number.type = 'number';
  number.min = String(min);
  number.max = String(max);
  number.step = String(step);
  number.value = String(value);
  const id = uid();
  number.id = id;
  l.htmlFor = id;
  numRow.append(l, number);

  const sliderRow = el('div', 'row');
  const slider = el('input') as HTMLInputElement;
  slider.type = 'range';
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(value);
  slider.className = 'grow';
  slider.setAttribute('aria-label', `${label} slider`);
  sliderRow.append(slider);

  const error = el('p', 'hint');
  error.style.color = 'var(--ui-danger)';
  error.style.display = 'none';
  error.setAttribute('role', 'alert');

  const clampAndReport = (raw: string): number | null => {
    const v = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(v)) {
      error.textContent = 'Enter a whole number.';
      error.style.display = 'block';
      number.setAttribute('aria-invalid', 'true');
      return null;
    }
    const rounded = Math.round(v);
    const clamped = Math.min(max, Math.max(min, rounded));
    if (clamped !== rounded) {
      error.textContent = `Clamped to the supported range ${min}\u2013${max}.`;
      error.style.display = 'block';
      number.setAttribute('aria-invalid', 'true');
    } else {
      error.textContent = '';
      error.style.display = 'none';
      number.setAttribute('aria-invalid', 'false');
    }
    return clamped;
  };

  number.addEventListener('change', () => {
    const v = clampAndReport(number.value);
    if (v === null) return;
    number.value = String(v);
    slider.value = String(v);
    onChange(v);
  });
  slider.addEventListener('input', () => {
    const v = Number(slider.value);
    number.value = String(v);
    error.style.display = 'none';
    number.setAttribute('aria-invalid', 'false');
    onChange(v);
  });

  return { number, slider, error };
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
