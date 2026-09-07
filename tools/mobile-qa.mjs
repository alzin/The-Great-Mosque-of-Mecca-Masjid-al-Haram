/**
 * Touch and responsive regression checks for the simulation overlay.
 *
 * npm run qa:mobile
 * npm run qa:mobile -- --only=phone,small
 * MOBILE_QA_BASE_URL=http://127.0.0.1:5173 npm run qa:mobile
 * MOBILE_QA_BROWSER=msedge npm run qa:mobile
 * MOBILE_QA_EXECUTABLE=/path/to/chrome npm run qa:mobile
 *
 * Screenshots and a machine-readable report are written to qa-output/.
 * Chromium touch emulation verifies interaction and layout, not native iOS
 * browser chrome, the software keyboard, or physical-device frame rates.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = fileURLToPath(new URL('../qa-output/', import.meta.url));
const PORT = Number(process.env.MOBILE_QA_PORT ?? 5232);
const BASE = process.env.MOBILE_QA_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const TIMEOUT = 120_000;
const results = [];
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7).split(',');

function browserOptions() {
  if (process.env.MOBILE_QA_BROWSER) return { channel: process.env.MOBILE_QA_BROWSER };
  if (process.env.MOBILE_QA_EXECUTABLE) return { executablePath: process.env.MOBILE_QA_EXECUTABLE };
  if (existsSync(chromium.executablePath())) return {};
  // A workstation can have a newer Playwright browser cache than this repo.
  // Reuse an available Chromium before requiring another large download.
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
    : path.join(process.env.HOME ?? '', process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright'));
  if (existsSync(cache)) {
    const directories = readdirSync(cache).filter((name) => /^chromium[-_]/.test(name)).sort().reverse();
    for (const directory of directories) {
      for (const relative of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe',
        'chrome-linux/chrome', 'chrome-linux64/chrome',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-headless-shell-win64/chrome-headless-shell.exe', 'chrome-win/headless_shell.exe',
        'chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/headless_shell']) {
        const executablePath = path.join(cache, directory, relative);
        if (existsSync(executablePath)) return { executablePath };
      }
    }
  }
  return {};
}

async function startServer() {
  if (process.env.MOBILE_QA_BASE_URL) return null;
  const server = spawn(process.execPath,
    [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
      '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  let spawnError;
  server.stdout.on('data', (data) => { log += data; });
  server.stderr.on('data', (data) => { log += data; });
  server.on('error', (error) => { spawnError = error; });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (server.exitCode !== null) throw new Error(`Vite exited: ${log}`);
    try {
      const response = await fetch(BASE, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return server;
    } catch { /* Wait for the listening socket, without depending on banner text. */ }
    await sleep(200);
  }
  server.kill();
  throw new Error(`Vite did not become ready: ${log}`);
}

async function noOverflow(page) {
  const sizes = await page.evaluate(() => ({
    width: window.innerWidth, height: window.innerHeight,
    htmlWidth: document.documentElement.scrollWidth,
    htmlHeight: document.documentElement.scrollHeight,
    bodyWidth: document.body.scrollWidth,
    bodyHeight: document.body.scrollHeight,
  }));
  assert.ok(Math.max(sizes.htmlWidth, sizes.bodyWidth) <= sizes.width + 1,
    `Page overflows horizontally: ${JSON.stringify(sizes)}`);
  assert.ok(Math.max(sizes.htmlHeight, sizes.bodyHeight) <= sizes.height + 1,
    `Page overflows vertically: ${JSON.stringify(sizes)}`);
}

async function onScreen(locator, page, label) {
  await locator.waitFor({ state: 'visible' });
  const box = await locator.boundingBox();
  const { width, height } = page.viewportSize();
  assert.ok(box && box.x >= -1 && box.y >= -1 &&
    box.x + box.width <= width + 1 && box.y + box.height <= height + 1,
    `${label} is outside the viewport: ${JSON.stringify(box)}`);
}

async function touchTargets(page) {
  const tooSmall = await page.locator('.mobile-dock button, .sheet-panel button, .sheet-panel input, .sheet-panel select')
    .evaluateAll((nodes) => nodes.flatMap((node) => {
      const r = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (r.width === 0 || r.height === 0 || style.visibility === 'hidden') return [];
      return r.width < 43.5 || r.height < 43.5 ? [{
        label: node.getAttribute('aria-label') || node.textContent || node.type,
        width: r.width, height: r.height,
      }] : [];
    }));
  assert.deepEqual(tooSmall, [], 'All mobile controls should provide a 44px touch target');
}

async function tapDock(page, label) {
  await page.locator('.mobile-dock').getByRole('button', { name: label, exact: true }).tap();
}

async function closeSheet(page) {
  await page.getByRole('button', { name: 'Close panel', exact: true }).tap();
  await page.locator('.sheet-panel').waitFor({ state: 'hidden' });
}

async function screenshot(page, name) {
  await page.screenshot({ path: `${OUT}/mobile-${name}.png`, animations: 'disabled', scale: 'css', timeout: TIMEOUT });
}

async function dragTouch(cdp, points) {
  const touchPoints = points[0].map((point, i) => ({ ...point, id: i + 1, radiusX: 4, radiusY: 4, force: 1 }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints });
  for (const frame of points.slice(1)) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove',
      touchPoints: frame.map((point, i) => ({ ...point, id: i + 1, radiusX: 4, radiusY: 4, force: 1 })) });
    await sleep(25);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function scrollSheet(page, cdp) {
  const content = page.locator('.sheet-content');
  const dimensions = await content.evaluate((node) => ({
    scrollHeight: node.scrollHeight, height: node.clientHeight,
    overflow: getComputedStyle(node).overflowY,
  }));
  assert.ok(['auto', 'scroll'].includes(dimensions.overflow), 'Sheet content must own its scroll');
  if (dimensions.scrollHeight <= dimensions.height + 1) return false;
  const box = await content.boundingBox();
  // Swipe the content gutter so a range input does not intentionally capture it.
  const x = box.x + 6;
  const start = box.y + box.height * 0.8;
  const end = box.y + box.height * 0.2;
  await dragTouch(cdp, Array.from({ length: 9 }, (_, i) => [{ x, y: start + (end - start) * i / 8 }]));
  await page.waitForFunction(() => document.querySelector('.sheet-content').scrollTop > 10);
  await onScreen(page.getByRole('button', { name: 'Close panel', exact: true }), page, 'Close panel');
  await noOverflow(page);
  return true;
}

async function assertDefaultMobile(page) {
  await onScreen(page.locator('.mobile-dock'), page, 'Mobile dock');
  await page.locator('.sheet-panel').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.diagnostics').isVisible(), false, 'Diagnostics obscures the default mobile scene');
  assert.equal(await page.locator('.controls').isVisible(), false, 'Controls must start collapsed');
  await noOverflow(page);
  await touchTargets(page);
  const canvas = await page.locator('canvas#viewport').boundingBox();
  const viewport = page.viewportSize();
  assert.ok(canvas && Math.abs(canvas.width - viewport.width) <= 1 &&
    Math.abs(canvas.height - viewport.height) <= 1,
    `The canvas drawing-buffer resolution must not enlarge its CSS bounds: ${JSON.stringify(canvas)}`);
}

async function simulatedKeyboardViewport(page, name) {
  await tapDock(page, 'Controls');
  const target = page.getByRole('spinbutton', { name: 'Target', exact: true });
  await target.focus();
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 310 });
    window.visualViewport.dispatchEvent(new Event('resize'));
  });
  try {
    await page.waitForFunction(() => document.querySelector('.ui-root').classList.contains('viewport-compact'));
    const boxes = await page.evaluate(() => Object.fromEntries(
      ['.ui-root', '.mobile-dock', '.sheet-panel', '.sheet-content'].map((selector) => {
        const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
        return [selector, { x, y, width, height }];
      })));
    for (const [selector, box] of Object.entries(boxes)) {
      assert.ok(box.y >= -1 && box.y + box.height <= 311,
        `${selector} must stay inside the simulated keyboard viewport: ${JSON.stringify(box)}`);
    }
    assert.ok(boxes['.sheet-content'].height >= 44, 'Keyboard leaves no usable input space');
    await target.scrollIntoViewIfNeeded();
    const input = await target.boundingBox();
    const content = boxes['.sheet-content'];
    assert.ok(input.y >= content.y - 1 && input.y + input.height <= content.y + content.height + 1,
      'The focused number input must remain fully reachable above the keyboard');
    await screenshot(page, `${name}-simulated-keyboard`);
  } finally {
    await page.evaluate(() => {
      delete window.visualViewport.height;
      window.visualViewport.dispatchEvent(new Event('resize'));
    });
    await closeSheet(page);
  }
}

async function inspectMobile(page, cdp, name, comprehensive) {
  await assertDefaultMobile(page);
  await screenshot(page, `${name}-scene`);
  // Keep the default scene capture, then reduce software-rendering cost while
  // exercising UI behavior. This is not a rendering-performance benchmark.
  await tapDock(page, 'Info');
  await page.getByRole('button', { name: 'Low', exact: true }).tap();
  await closeSheet(page);

  await tapDock(page, 'Controls');
  await onScreen(page.locator('.sheet-panel'), page, 'Controls sheet');
  await touchTargets(page);
  await noOverflow(page);
  const target = page.getByRole('spinbutton', { name: 'Target', exact: true });
  await target.fill('250');
  await target.press('Tab');
  await page.waitForFunction(() => window.__haram.crowd.tunables.targetPopulation === 250);
  assert.equal(await target.inputValue(), '250', 'Population edit was not preserved');
  await screenshot(page, `${name}-controls-top`);
  const scrolled = await scrollSheet(page, cdp);
  if (name === 'small') assert.equal(scrolled, true, 'Small-phone controls should scroll within the sheet');
  await screenshot(page, `${name}-controls`);
  await page.locator('.sheet-tabs').getByRole('button', { name: 'Prayer', exact: true }).tap();
  await page.getByRole('button', { name: 'Call to prayer', exact: true }).waitFor({ state: 'visible' });
  await touchTargets(page);
  await noOverflow(page);
  await closeSheet(page);

  await tapDock(page, 'Info');
  await page.locator('.sheet-tabs').getByRole('button', { name: 'Diagnostics', exact: true }).tap();
  await page.locator('.diagnostics').waitFor({ state: 'visible' });
  await noOverflow(page);
  await screenshot(page, `${name}-diagnostics`);
  await page.locator('.sheet-tabs').getByRole('button', { name: 'Help', exact: true }).tap();
  await page.locator('.help').waitFor({ state: 'visible' });
  await closeSheet(page);

  await tapDock(page, 'Camera');
  const preset = page.getByRole('button', { name: 'Overhead', exact: true });
  await preset.tap();
  await page.waitForFunction(() => window.__haram.cameraSystem.activePreset === 'overhead');
  await page.locator('.sheet-panel').waitFor({ state: 'hidden' });
  await noOverflow(page);

  if (!comprehensive) return;
  await tapDock(page, 'Pause');
  const resume = page.locator('.mobile-dock').getByRole('button', { name: 'Resume', exact: true });
  await resume.waitFor({ state: 'visible' });
  const pausedTime = await page.evaluate(() => window.__haram.clock.stats.simTime);
  await sleep(300);
  assert.equal(await page.evaluate(() => window.__haram.clock.stats.simTime), pausedTime,
    'Pause must stop simulated time');
  await resume.tap();
  await page.waitForFunction((time) => window.__haram.clock.stats.simTime > time, pausedTime);

  // Letter shortcuts remain available after a sheet returns focus to a dock
  // button, while Space retains the native button activation behavior.
  await page.keyboard.press('g');
  await page.locator('.diagnostics').waitFor({ state: 'visible' });
  await page.keyboard.press('g');
  await page.locator('.sheet-panel').waitFor({ state: 'hidden' });
  await page.keyboard.press('g');
  await page.locator('.diagnostics').waitFor({ state: 'visible' });
  await closeSheet(page);
  const controlsOpener = page.locator('.mobile-dock').getByRole('button', { name: 'Controls', exact: true });
  await controlsOpener.focus();
  await page.keyboard.press('Space');
  await page.locator('.sheet-panel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.mobile-dock').getByRole('button', { name: 'Pause', exact: true })
    .getAttribute('aria-pressed'), 'false', 'Space on Controls must open the panel without pausing the simulation');
  await closeSheet(page);

  await tapDock(page, 'Controls');
  await page.keyboard.press('Escape');
  await page.locator('.sheet-panel').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.mobile-dock').getByRole('button', { name: 'Controls', exact: true })
    .evaluate((node) => node === document.activeElement), true, 'Escape should return focus to the opener');

  await tapDock(page, 'Info');
  const panel = await page.locator('.sheet-panel').boundingBox();
  const viewport = page.viewportSize();
  const point = panel.y > 50 ? { x: viewport.width / 2, y: panel.y - 20 }
    : { x: panel.x > 30 ? panel.x - 15 : panel.x + panel.width + 15, y: 70 };
  await page.touchscreen.tap(point.x, point.y);
  await page.locator('.sheet-panel').waitFor({ state: 'hidden' });

  // Use native Chromium touch dispatch so pointer capture and browser touch
  // arbitration are exercised, rather than invoking camera methods directly.
  await sleep(2300); // Finish the camera preset transition before measuring gesture movement.
  const before = await page.evaluate(() => window.__haram.cameraSystem.getState());
  const { width, height } = page.viewportSize();
  const y = height * 0.43;
  await dragTouch(cdp, Array.from({ length: 9 }, (_, i) => {
    const halfGap = width * (0.10 + i / 8 * 0.13);
    return [{ x: width / 2 - halfGap, y }, { x: width / 2 + halfGap, y }];
  }));
  const after = await page.evaluate(() => window.__haram.cameraSystem.getState());
  assert.ok(after.distance < before.distance - 2, `Pinch apart should zoom in: ${before.distance} -> ${after.distance}`);
  assert.ok(Number.isFinite(after.azimuth) && Number.isFinite(after.polar), 'Pinch must preserve a valid camera');
  assert.ok(Math.abs(after.azimuth - before.azimuth) < 0.05, 'Symmetric pinch should not orbit the scene');
  await screenshot(page, `${name}-pinch`);

  await tapDock(page, 'Controls');
  await target.fill('375');
  await target.press('Tab');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.mobile-dock').waitFor({ state: 'hidden' });
  await page.locator('.controls').waitFor({ state: 'visible' });
  assert.equal(await target.inputValue(), '375', 'Resize discarded the population selection');
  await noOverflow(page);
  await page.setViewportSize({ width, height });
  await assertDefaultMobile(page);
  await tapDock(page, 'Controls');
  assert.equal(await target.inputValue(), '375', 'Returning to mobile discarded the population selection');
  await closeSheet(page);
  await simulatedKeyboardViewport(page, name);
}

async function inspectDesktop(page) {
  await page.locator('.mobile-dock').waitFor({ state: 'hidden' });
  await page.locator('.controls').waitFor({ state: 'visible' });
  await page.locator('.diagnostics').waitFor({ state: 'visible' });
  await noOverflow(page);
  await screenshot(page, 'desktop');
}

await mkdir(OUT, { recursive: true });
let previousResults = [];
if (only) {
  try {
    const previous = JSON.parse(await readFile(`${OUT}/mobile-report.json`, 'utf8'));
    previousResults = previous.results.filter((result) => !only.includes(result.name))
      .map((result) => ({ baseUrl: previous.baseUrl, ...result }));
  } catch { /* A filtered first run has no prior results. */ }
}
let server;
let browser;
let failures = 0;
try {
  server = await startServer();
  browser = await chromium.launch({
    ...browserOptions(),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--ignore-gpu-blocklist',
      `--log-file=${path.join(OUT, 'mobile-browser.log')}`,
      ...(process.env.MOBILE_QA_SOFTWARE_GL === '1' ? ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] : [])],
  });
  for (const [name, width, height, mobile] of [
    ['phone', 390, 844, true],
    ['small', 320, 568, true],
    ['landscape', 844, 390, true],
    ['tablet', 768, 1024, true],
    ['desktop', 1440, 900, false],
  ]) {
    if (only && !only.includes(name)) continue;
    const context = await browser.newContext({
      viewport: { width, height }, deviceScaleFactor: name === 'phone' ? 2 : 1,
      isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(TIMEOUT);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    const started = Date.now();
    try {
      await page.goto(BASE, { waitUntil: 'load' });
      await page.waitForFunction(() => Boolean(window.__haram), null, { timeout: TIMEOUT });
      await page.locator('.overlay').waitFor({ state: 'hidden' });
      if (mobile) await inspectMobile(page, await context.newCDPSession(page), name, name === 'phone');
      else await inspectDesktop(page);
      assert.deepEqual(errors, [], 'The page logged uncaught JavaScript errors');
      results.push({ name, width, height, deviceScaleFactor: name === 'phone' ? 2 : 1,
        baseUrl: BASE,
        interactionQuality: mobile ? 'low' : 'default',
        ok: true, checkedAt: new Date().toISOString(), durationMs: Date.now() - started });
      console.log(`PASS mobile-${name} (${Date.now() - started} ms)`);
    } catch (error) {
      failures++;
      results.push({ name, width, height, ok: false, durationMs: Date.now() - started,
        baseUrl: BASE,
        error: String(error.stack ?? error), pageErrors: errors });
      console.error(`FAIL mobile-${name}: ${error}`);
      await screenshot(page, `${name}-FAILED`).catch(() => {});
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  server?.kill();
  await writeFile(`${OUT}/mobile-report.json`, JSON.stringify({
    baseUrl: BASE,
    updatedAt: new Date().toISOString(),
    note: 'Chromium touch emulation; initial scene uses default quality. Interaction quality is recorded per case when changed. Keyboard check simulates visualViewport height; not a native-device performance benchmark.',
    results: [...previousResults, ...results],
  }, null, 2));
}
console.log(`${results.length - failures}/${results.length} responsive checks passed. Results: qa-output/mobile-report.json`);
process.exitCode = failures > 0 ? 1 : 0;
