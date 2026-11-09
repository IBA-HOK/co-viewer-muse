import { chromium } from 'playwright-core';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const PORT = 4174;
const QA_DIR = path.resolve('.omo/qa');
console.log('Starting vite preview on 4174...');
const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '0.0.0.0'], { stdio: ['ignore','pipe','pipe'], cwd: process.cwd() });
await new Promise(r=>setTimeout(r,2000));
let ok=false;
for(let i=0;i<20;i++){ try{ const res=await fetch(`http://localhost:${PORT}/`); if(res.ok){ok=true;break;} }catch{} await new Promise(r=>setTimeout(r,300)); }
console.log('reachable',ok);
if(!ok){ preview.kill(); process.exit(1); }
const browser = await chromium.launch({ args:['--no-sandbox','--disable-setuid-sandbox'] });
const ctx = await browser.newContext({ viewport:{width:1280,height:800} });
const page = await ctx.newPage();
await page.goto(`http://localhost:${PORT}/`, { waitUntil:'networkidle' });
await page.waitForTimeout(1500);
// CJK probe: check DotGothic16 loaded, title bounding box, overflow
const cjk = await page.evaluate(() => {
  const h1 = document.querySelector('h1.nothing-title');
  const style = h1 ? getComputedStyle(h1) : null;
  const h1Box = h1 ? h1.getBoundingClientRect() : null;
  const checks = [];
  // check all CJK text nodes for clipping
  const cjkEls = Array.from(document.querySelectorAll('*')).filter(el => /[\u3040-\u30ff\u4e00-\u9faf]/.test(el.textContent || ''));
  const samples = cjkEls.slice(0,10).map(el => ({
    tag: el.tagName, text: (el.textContent||'').slice(0,60).replace(/\n/g,' '), 
    overflow: getComputedStyle(el).overflow, textOverflow: getComputedStyle(el).textOverflow,
    fontFamily: getComputedStyle(el).fontFamily, fontSize: getComputedStyle(el).fontSize,
    box: el.getBoundingClientRect().width.toFixed(1)+'x'+el.getBoundingClientRect().height.toFixed(1)
  }));
  return {
    h1Exists: !!h1,
    h1FontFamily: style?.fontFamily,
    h1FontSize: style?.fontSize,
    h1LineHeight: style?.lineHeight,
    h1Box: h1Box ? `${h1Box.width.toFixed(1)}x${h1Box.height.toFixed(1)}` : null,
    h1Overflow: style?.overflow,
    h1TextOverflow: style?.textOverflow,
    documentFonts: document.fonts ? Array.from(document.fonts).map(f=>f.family).slice(0,10) : [],
    cjkSamples: samples,
    viewport: { w: innerWidth, h: innerHeight }
  };
});
console.log(JSON.stringify(cjk,null,2));
// also check prefers-reduced-motion computation
const rm = await page.evaluate(() => {
  const m = window.matchMedia('(prefers-reduced-motion: reduce)');
  return { matches: m.matches, media: m.media };
});
console.log('reduced-motion media:', JSON.stringify(rm));
await browser.close();
preview.kill();
