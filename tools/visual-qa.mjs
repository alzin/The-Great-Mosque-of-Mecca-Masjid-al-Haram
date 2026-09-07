/**
 * visual-qa.mjs — headless visual inspection.
 *
 * Starts the dev server, opens the pages in headless Chromium, and writes
 * screenshots to qa-output/. This is how the character rig and the scene were
 * actually checked during development: a crowd simulation can pass every
 * numeric assertion and still be visibly wrong.
 *
 * The container this was developed in has no GPU, so Chromium falls back to
 * SwiftShader (software rasterisation). That is fine for checking that things
 * are in the right place and the right shape; it is NOT a frame-rate
 * measurement and this script does not pretend otherwise.
 *
 *   node tools/visual-qa.mjs [--shots=name,name] [--keep]
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const OUT = new URL('../qa-output/', import.meta.url).pathname;
const PORT = 5231;
const BASE = `http://127.0.0.1:${PORT}`;

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith('--shots='))?.split('=')[1]?.split(',') ?? null;

const LAUNCH_ARGS = [
  '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu-sandbox',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
];

async function startServer() {
  const proc = spawn(
    'npx',
    ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'],
    { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  proc.stdout.on('data', (d) => {
    log += d;
  });
  proc.stderr.on('data', (d) => {
    log += d;
    process.stderr.write(`[vite] ${d}`);
  });
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) log += `\nvite exited with code ${code}`;
  });

  // Poll the server rather than parsing its banner: the banner wording is not
  // a stable contract and stdout can be buffered.
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        await sleep(400);
        return proc;
      }
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  proc.kill('SIGKILL');
  throw new Error(`vite dev server did not become ready within 90 s.\n${log}`);
}

const shots = [];
function shot(name, fn) {
  if (only && !only.includes(name)) return;
  shots.push({ name, fn });
}

// --- Character rig -----------------------------------------------------------

shot('character-clips-grid', async (page) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${BASE}/character-preview.html?grid=1&phase=1`, { waitUntil: 'load' });
  await page.waitForFunction('window.__preview?.ready === true', null, { timeout: 120000 });
  await sleep(2500);
});

for (const [name, clip, phase, az] of [
  ['pose-qiyam', 5, 0.5, 0.55],
  ['pose-ruku', 7, 0.5, 1.35],
  ['pose-sujud', 11, 0.5, 1.35],
  ['pose-jalsa', 13, 0.5, 1.35],
  ['pose-tashahhud', 16, 0.5, 1.1],
  ['pose-takbir', 4, 1.0, 0.4],
  ['pose-walk-a', 1, 0.12, 1.35],
  ['pose-walk-b', 1, 0.62, 1.35],
]) {
  shot(name, async (page) => {
    await page.setViewportSize({ width: 760, height: 900 });
    await page.goto(`${BASE}/character-preview.html?clip=${clip}&phase=${phase}&az=${az}`, {
      waitUntil: 'load',
    });
    await page.waitForFunction('window.__preview?.ready === true', null, { timeout: 120000 });
    await sleep(1800);
  });
}

// --- Whole scene -------------------------------------------------------------

const APP_READY = 'window.__haram !== undefined';

async function openApp(page, { width = 1280, height = 760, population = 500 } = {}) {
  await page.setViewportSize({ width, height });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(APP_READY, null, { timeout: 180000 });
  await page.evaluate((n) => {
    window.__haram.setPaused(true);
    window.__haram.setPopulation(n);
  }, population);
  await sleep(500);
}

for (const [name, presetIndex] of [
  ['scene-broadcast', 0],
  ['scene-mataf', 1],
  ['scene-overhead', 2],
  ['scene-maqam', 3],
]) {
  shot(name, async (page) => {
    await openApp(page);
    await page.evaluate((i) => {
      window.__haram.cameraSystem.applyPresetById(
        ['broadcast', 'mataf', 'overhead', 'door'][i],
      );
    }, presetIndex);
    // Presets ease in; let the transition finish, then step the sim so the
    // crowd is not in its spawn arrangement.
    await page.evaluate(() => window.__haram.step(40));
    await sleep(2600);
  });
}

shot('scene-prayer-rows', async (page) => {
  await openApp(page, { population: 700 });
  await page.evaluate(() => {
    window.__haram.cameraSystem.applyPresetById('overhead');
    const o = window.__haram.orchestrator;
    o.settings.adhanToIqamah = 4;
    o.settings.durationScale = 0.4;
    o.prepare(0);
    window.__haram.step(120);
  });
  await sleep(2600);
});

shot('scene-prayer-close', async (page) => {
  await openApp(page, { population: 500 });
  await page.evaluate(() => {
    const o = window.__haram.orchestrator;
    o.settings.adhanToIqamah = 4;
    o.settings.durationScale = 0.4;
    o.prepare(0);
    window.__haram.step(150);
    window.__haram.cameraSystem.applyPresetById('mataf');
  });
  await sleep(2600);
});

shot('scene-debug-collision', async (page) => {
  await openApp(page, { population: 300 });
  await page.evaluate(() => {
    window.__haram.cameraSystem.applyPresetById('overhead');
    window.__haram.step(20);
  });
  await page.getByRole('button', { name: 'Collision view' }).click({ force: true });
  await sleep(2200);
});

// --- Runner ------------------------------------------------------------------

const server = await startServer();
const browser = await chromium.launch({ args: LAUNCH_ARGS });
// Software rasterisation makes a single frame take hundreds of milliseconds
// with a large crowd, so Playwright's default 30 s actionability and
// screenshot timeouts are not generous enough here. This is a property of the
// GPU-less environment, not of the application.
const SLOW_TIMEOUT = 180_000;
await mkdir(OUT, { recursive: true });

const report = [];
let failures = 0;

try {
  for (const s of shots) {
    const page = await browser.newPage();
    page.setDefaultTimeout(SLOW_TIMEOUT);
    page.setDefaultNavigationTimeout(SLOW_TIMEOUT);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    const t0 = Date.now();
    try {
      await s.fn(page);
      await page.screenshot({ path: `${OUT}${s.name}.png`, timeout: SLOW_TIMEOUT, animations: 'disabled' });
      let stats = null;
      try {
        stats = await page.evaluate(() =>
          window.__haram ? window.__haram.stats() : window.__preview ?? null,
        );
      } catch {
        /* preview pages have no stats */
      }
      report.push({ name: s.name, ok: errors.length === 0, ms: Date.now() - t0, errors, stats });
      if (errors.length) failures++;
      console.log(
        `${errors.length ? 'FAIL' : ' ok '}  ${s.name}  (${Date.now() - t0} ms)` +
          (errors.length ? `\n      ${errors.join('\n      ')}` : ''),
      );
    } catch (err) {
      failures++;
      report.push({ name: s.name, ok: false, ms: Date.now() - t0, errors: [String(err)] });
      console.log(`FAIL  ${s.name}: ${err}`);
      await page.screenshot({ path: `${OUT}${s.name}-FAILED.png` }).catch(() => {});
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await writeFile(`${OUT}report.json`, JSON.stringify(report, null, 2));
}

console.log(`\n${shots.length - failures}/${shots.length} shots clean. Output in qa-output/`);
process.exit(failures > 0 ? 1 : 0);
