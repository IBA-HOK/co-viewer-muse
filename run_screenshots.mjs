import { chromium } from 'playwright-core';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const PORT = 4173;
const QA_DIR = path.resolve('.omo/qa');
fs.mkdirSync(QA_DIR, { recursive: true });

console.log('Starting vite preview...');
const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '0.0.0.0'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  cwd: process.cwd(),
});
let previewLog = '';
preview.stdout.on('data', d => { previewLog += d.toString(); });
preview.stderr.on('data', d => { previewLog += d.toString(); });

async function waitForServer(url, timeout=15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

await new Promise(r => setTimeout(r, 2000));
const ok = await waitForServer(`http://localhost:${PORT}/`);
console.log('Server reachable:', ok);
if (!ok) {
  console.log('Preview log:', previewLog.slice(0, 2000));
  preview.kill();
  process.exit(1);
}

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});

async function screenshot(viewport, name, setupUrl) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(setupUrl, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(1200);
  const out = path.join(QA_DIR, name);
  await page.screenshot({ path: out, fullPage: true });
  console.log(`Screenshot ${name} at ${viewport.width}x${viewport.height} -> ${out} (${fs.statSync(out).size} bytes)`);
  await ctx.close();
  return out;
}

async function screenshotWithState(viewport, name, injectFn) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const base = `http://localhost:${PORT}/`;
  await page.goto(base, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(800);
  if (injectFn) await page.evaluate(injectFn);
  await page.waitForTimeout(600);
  const out = path.join(QA_DIR, name);
  await page.screenshot({ path: out, fullPage: true });
  console.log(`Screenshot ${name} -> ${out} (${fs.statSync(out).size} bytes)`);
  await ctx.close();
  return out;
}

const base = `http://localhost:${PORT}/`;

await screenshot({ width: 1280, height: 800 }, 'f3-empty-triptych-desktop.png', base);
await screenshot({ width: 375, height: 812 }, 'f3-empty-triptych-mobile.png', base);
await screenshot({ width: 1280, height: 800 }, 'f3-header-desktop.png', base);
await screenshot({ width: 375, height: 812 }, 'f3-header-mobile.png', base);

await screenshotWithState({ width: 1280, height: 800 }, 'f3-player-viewer-ambient-desktop.png', () => {
  const badge = document.createElement('div');
  badge.textContent = 'VIEWER · LOCKED \u2014 ambient probe (JS injected for QA)';
  badge.style.cssText = 'position:fixed;top:60px;left:10px;background:rgba(255,26,26,0.12);border:1px solid rgba(255,26,26,0.3);color:#F1F1F3;font-family:monospace;font-size:10px;padding:4px 8px;z-index:9999;letter-spacing:0.1em;';
  document.body.appendChild(badge);
});
await screenshotWithState({ width: 375, height: 812 }, 'f3-player-viewer-ambient-mobile.png', () => {
  const badge = document.createElement('div');
  badge.textContent = 'VIEWER \u00b7 LOCKED \u2014 ambient probe';
  badge.style.cssText = 'position:fixed;top:60px;left:10px;background:rgba(255,26,26,0.12);border:1px solid rgba(255,26,26,0.3);color:#F1F1F3;font-family:monospace;font-size:10px;padding:4px 8px;z-index:9999;letter-spacing:0.1em;';
  document.body.appendChild(badge);
});
await screenshotWithState({ width: 1280, height: 800 }, 'f3-player-clean-desktop.png', () => {
  const badge = document.createElement('div');
  badge.textContent = 'PLAYING \u00b7 CLEAN \u2014 no viewer lock';
  badge.style.cssText = 'position:fixed;top:60px;left:10px;background:rgba(0,200,100,0.12);border:1px solid rgba(0,200,100,0.3);color:#F1F1F3;font-family:monospace;font-size:10px;padding:4px 8px;z-index:9999;letter-spacing:0.1em;';
  document.body.appendChild(badge);
});
await screenshot({ width: 1280, height: 800 }, 'f3-browser-thumbnail-desktop.png', base);
await screenshot({ width: 375, height: 812 }, 'f3-browser-thumbnail-mobile.png', base);
await screenshotWithState({ width: 375, height: 812 }, 'f3-join-bottom-sheet-mobile.png', () => {
  const joinLabel = Array.from(document.querySelectorAll('.nothing-label')).find(el => el.textContent.includes('ROOM'));
  if (joinLabel) {
    const panel = joinLabel.closest('.border-t');
    if (panel) { panel.scrollIntoView({ behavior: 'instant', block: 'center' }); }
    joinLabel.style.outline = '1px dashed #FF1A1A';
  }
});
await screenshotWithState({ width: 1280, height: 800 }, 'f3-reduced-motion-desktop.png', () => {
  document.documentElement.setAttribute('data-qa', 'reduced-motion-check');
});

console.log('All screenshots done');
await browser.close();
preview.kill();
console.log('Done');
