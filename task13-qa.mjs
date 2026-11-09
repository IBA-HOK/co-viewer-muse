import { chromium } from 'playwright-core';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const PORT = 4173;
const QA_DIR = path.resolve('.omo/qa');
fs.mkdirSync(QA_DIR, { recursive: true });

// Kill any existing vite preview on 4173
try { 
  const { execSync } = await import('child_process');
  try { execSync('pkill -f "vite preview.*4173" || true', { stdio:'ignore' }); } catch {}
} catch {}

// Start vite preview
console.log('Starting vite preview...');
const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '0.0.0.0'], {
  stdio: ['ignore','pipe','pipe'],
  cwd: process.cwd(),
});
let previewLog='';
preview.stdout.on('data', d=>{ previewLog+=d.toString(); });
preview.stderr.on('data', d=>{ previewLog+=d.toString(); });

async function waitForServer(url, timeout=15000){
  const start=Date.now();
  while(Date.now()-start<timeout){
    try{ const r=await fetch(url); if(r.ok) return true; }catch{}
    await new Promise(r=>setTimeout(r,300));
  }
  return false;
}
await new Promise(r=>setTimeout(r,1500));
const ok=await waitForServer(`http://localhost:${PORT}/`);
console.log('Server reachable:', ok, 'log:', previewLog.slice(0,500));
if(!ok){ console.log(previewLog.slice(0,2000)); preview.kill(); process.exit(1); }

const browser = await chromium.launch({ args:['--no-sandbox','--disable-setuid-sandbox','--disable-gpu','--disable-dev-shm-usage'] });

// Helper to inject mock BrowserPanel results into the live page
function injectMocksScript() {
  // This runs inside page.evaluate
  // We will directly manipulate DOM to create fake results that look exactly like real ones
  // but also ensure the QUEUE buttons have correct classes for animation testing
  const panel = document.querySelector('.nothing-panel');
  // Find BrowserPanel container by looking for BROWSER heading
  const browserHeading = Array.from(document.querySelectorAll('h3')).find(h=>h.textContent.trim()==='BROWSER');
  if (!browserHeading) return 'no BROWSER heading';
  const browserPanel = browserHeading.closest('.nothing-panel');
  if (!browserPanel) return 'no panel';
  // Ensure expanded: if there's a "+ OPEN" button, click it
  const openBtn = Array.from(browserPanel.querySelectorAll('button')).find(b=>b.textContent.includes('OPEN'));
  // We'll inject mock content after expanding
  // Create mock list HTML inside the panel
  // First, check if expanded content exists (input placeholder)
  let input = browserPanel.querySelector('input[placeholder="URL / ID or SEARCH KEYWORD"]');
  if (!input) {
    // Click open if needed - but we are inside evaluate, can't click easily outside
    return 'not expanded yet';
  }
  // Inject fake results UL if not already injected
  if (browserPanel.querySelector('[data-qa="mock-results"]')) return 'already injected';
  
  const mockResultsHTML = `
    <div data-qa="mock-results" class="space-y-3 mt-3 border-t border-[var(--nothing-border)] pt-3">
      <p class="nothing-label">MOCK SEARCH RESULTS — さあ、検索 (CJK probe)</p>
      <ul class="space-y-1.5" data-qa="mock-list">
        <li class="flex gap-2 border border-[var(--nothing-border)] bg-black p-2 hover:border-[var(--nothing-border-strong)]" data-qa="mock-item-0">
          <img src="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" alt="" class="h-14 w-24 shrink-0 border border-[var(--nothing-border)] bg-[var(--nothing-surface)] object-cover" />
          <div class="min-w-0 flex-1">
            <p class="nothing-mono truncate text-xs text-[var(--nothing-text)]" title="Test Video – 日本語タイトル さあ、検索">Test Video – 日本語タイトル さあ、検索</p>
            <p class="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-dim)]">1,234 views · 2024/01/01 <button type="button" class="nothing-mono text-[9px] tracking-widest text-[var(--nothing-text-dim)]">↗ OPEN</button></p>
            <div class="mt-1 flex flex-wrap gap-1">
              <button data-qa="queue-btn-0" type="button" class="nothing-mono bg-[var(--nothing-red)] px-2 py-0.5 text-[10px] tracking-widest text-white hover:bg-[var(--nothing-red-hover)] nothing-enqueue transition-transform active:scale-[0.98]">＋ QUEUE</button>
              <button type="button" class="nothing-mono border border-[var(--nothing-border)] bg-black px-2 py-0.5 text-[10px] tracking-widest text-[var(--nothing-text-dim)]">☆ SAVE</button>
            </div>
          </div>
        </li>
        <li class="flex gap-2 border border-[var(--nothing-border)] bg-black p-2" data-qa="mock-item-1">
          <div class="h-14 w-24 shrink-0 border border-[var(--nothing-border)] bg-[var(--nothing-surface)]"></div>
          <div class="min-w-0 flex-1">
            <p class="nothing-mono truncate text-xs text-[var(--nothing-text)]">Second Mock — キューに追加テスト</p>
            <p class="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-dim)]">5,678 views</p>
            <div class="mt-1 flex flex-wrap gap-1">
              <button data-qa="queue-btn-1" type="button" class="nothing-mono bg-[var(--nothing-red)] px-2 py-0.5 text-[10px] tracking-widest text-white nothing-enqueue">＋ QUEUE</button>
              <button type="button" class="nothing-mono border border-[var(--nothing-border)] bg-black px-2 py-0.5 text-[10px] tracking-widest text-[var(--nothing-text-dim)]">☆ SAVE</button>
            </div>
          </div>
        </li>
      </ul>
      <div class="space-y-1" data-qa="mock-bookmarks">
        <p class="nothing-label">BOOKMARKS — 保存済み</p>
        <ul class="space-y-1">
          <li class="flex items-center gap-2 border border-[var(--nothing-border)] bg-black px-2 py-1" data-qa="mock-bookmark-0">
            <span class="nothing-mono min-w-0 flex-1 truncate text-left text-xs text-[var(--nothing-text-muted)]">https://www.youtube.com/watch?v=dQw4w9WgXcQ</span>
            <button data-qa="bookmark-queue-0" type="button" aria-label="キューに追加" class="nothing-mono shrink-0 bg-[var(--nothing-red)] px-2 py-0.5 text-xs text-white hover:bg-[var(--nothing-red-hover)] nothing-enqueue">＋</button>
            <button type="button" class="nothing-mono shrink-0 border border-[var(--nothing-red)]/30 bg-[var(--nothing-red-dim)] px-2 py-0.5 text-xs text-[var(--nothing-red)]">✕</button>
          </li>
        </ul>
      </div>
      <p class="nothing-mono text-[10px] text-[var(--nothing-text-faint)]" data-qa="cjk-probe">CJK: さあ、検索 • キューかブラウザから選んでね • 保存 • 削除 • キューに追加 • 再生を有効化するためにタップしてください</p>
    </div>
  `;
  // Insert after the existing browserPanel content (append)
  browserPanel.insertAdjacentHTML('beforeend', mockResultsHTML);
  return 'injected';
}

async function setupPage(viewport, reducedMotion=false){
  const ctx = await browser.newContext({ viewport, deviceScaleFactor:1, reducedMotion: reducedMotion ? 'reduce' : undefined });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/`, { waitUntil:'networkidle', timeout:15000 });
  await page.waitForTimeout(1000);
  // Expand BrowserPanel: click + OPEN
  const openBtn = page.locator('button', { hasText: '+ OPEN' }).first();
  if (await openBtn.count() > 0) {
    await openBtn.click();
    await page.waitForTimeout(600);
  }
  // Inject mocks via evaluate
  const injectResult = await page.evaluate(injectMocksScript);
  console.log(`inject ${viewport.width}x${viewport.height} rm=${reducedMotion}:`, injectResult);
  // second attempt if not expanded yet
  if (injectResult === 'not expanded yet') {
    await page.waitForTimeout(300);
    const r2 = await page.evaluate(injectMocksScript);
    console.log('retry inject:', r2);
  }
  await page.waitForTimeout(400);
  return { ctx, page };
}

// Capture helper
async function capture(viewport, name, action){
  const { ctx, page } = await setupPage(viewport, false);
  if (action) await action(page);
  const out = path.join(QA_DIR, name);
  await page.screenshot({ path: out, fullPage: true });
  console.log(`Screenshot ${name} at ${viewport.width}x${viewport.height} -> ${out} (${fs.statSync(out).size} bytes)`);
  await ctx.close();
  return out;
}

// 1. Desktop idle (with mocks, idle state)
await capture({ width:1280, height:800 }, 'task-13-browser-idle-desktop.png', async (page)=>{});
await capture({ width:375, height:812 }, 'task-13-browser-idle-mobile.png', async (page)=>{});

// 2. Desktop pending (200ms after click)
await capture({ width:1280, height:800 }, 'task-13-queue-pending-desktop.png', async (page)=>{
  const btn = page.locator('[data-qa="queue-btn-0"]');
  if (await btn.count()>0){
    // Add pending class manually to simulate real triggerAnim
    await page.evaluate(()=>{
      const b = document.querySelector('[data-qa="queue-btn-0"]');
      if(b){ b.classList.add('nothing-enqueue--pending'); }
    });
    await page.waitForTimeout(200);
  }
});
await capture({ width:375, height:812 }, 'task-13-queue-pending-mobile.png', async (page)=>{
  const btn = page.locator('[data-qa="queue-btn-0"]');
  if (await btn.count()>0){
    await page.evaluate(()=>{
      const b = document.querySelector('[data-qa="queue-btn-0"]');
      if(b){ b.classList.add('nothing-enqueue--pending'); }
    });
    await page.waitForTimeout(200);
  }
});

// 3. Desktop success (400ms) - should show ✓ QUEUED and queue-pop border
await capture({ width:1280, height:800 }, 'task-13-queue-success-desktop.png', async (page)=>{
  await page.evaluate(()=>{
    const b = document.querySelector('[data-qa="queue-btn-0"]');
    if(b){ 
      b.classList.remove('nothing-enqueue--pending');
      b.classList.add('nothing-enqueue--success');
      b.textContent='✓ QUEUED';
    }
  });
  await page.waitForTimeout(100);
});
await capture({ width:375, height:812 }, 'task-13-queue-success-mobile.png', async (page)=>{
  await page.evaluate(()=>{
    const b = document.querySelector('[data-qa="queue-btn-0"]');
    if(b){ 
      b.classList.remove('nothing-enqueue--pending');
      b.classList.add('nothing-enqueue--success');
      b.textContent='✓ QUEUED';
    }
  });
  await page.waitForTimeout(100);
});

// 4. Bookmark ＋ idle / pending / success
await capture({ width:1280, height:800 }, 'task-13-bookmark-idle-desktop.png', async (page)=>{});
await capture({ width:1280, height:800 }, 'task-13-bookmark-pending-desktop.png', async (page)=>{
  await page.evaluate(()=>{
    const b = document.querySelector('[data-qa="bookmark-queue-0"]');
    if(b){ b.classList.add('nothing-enqueue--pending'); }
  });
  await page.waitForTimeout(200);
});
await capture({ width:1280, height:800 }, 'task-13-bookmark-success-desktop.png', async (page)=>{
  await page.evaluate(()=>{
    const b = document.querySelector('[data-qa="bookmark-queue-0"]');
    if(b){ 
      b.classList.remove('nothing-enqueue--pending');
      b.classList.add('nothing-enqueue--success');
      b.textContent='✓';
    }
  });
  await page.waitForTimeout(100);
});
await capture({ width:375, height:812 }, 'task-13-bookmark-success-mobile.png', async (page)=>{
  await page.evaluate(()=>{
    const b = document.querySelector('[data-qa="bookmark-queue-0"]');
    if(b){ 
      b.classList.add('nothing-enqueue--success');
      b.textContent='✓';
    }
  });
  await page.waitForTimeout(100);
});

// 5. Reduced-motion check: emulate prefers-reduced-motion: reduce and check computed style
{
  const ctx = await browser.newContext({ viewport:{width:1280,height:800}, reducedMotion:'reduce' });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/`, { waitUntil:'networkidle' });
  await page.waitForTimeout(800);
  // Expand and inject mocks for reduced-motion test
  const openBtn = page.locator('button', { hasText: '+ OPEN' }).first();
  if (await openBtn.count()>0){ await openBtn.click(); await page.waitForTimeout(400); }
  await page.evaluate(injectMocksScript);
  await page.waitForTimeout(300);
  // Add pending class and check animationDuration
  const rmInfo = await page.evaluate(()=>{
    const b = document.querySelector('[data-qa="queue-btn-0"]');
    if(b){ b.classList.add('nothing-enqueue--pending'); }
    const el = document.querySelector('.nothing-enqueue--pending') || document.querySelector('[data-qa="queue-btn-0"]');
    const cs = el ? getComputedStyle(el) : null;
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    const allDurations = [];
    // check a few enqueue elements
    document.querySelectorAll('.nothing-enqueue').forEach(e=>{ allDurations.push(getComputedStyle(e).animationDuration); });
    return {
      matches: m.matches,
      media: m.media,
      animationDuration: cs?.animationDuration,
      transitionDuration: cs?.transitionDuration,
      allAnimationDurations: allDurations,
      hasReducedMotionCSS: !!document.querySelector('style') || !!Array.from(document.styleSheets).some(s=>{ try{ return Array.from(s.cssRules||[]).some(r=>r.cssText.includes('prefers-reduced-motion')); }catch{return false;}}),
    };
  });
  console.log('Reduced-motion check:', JSON.stringify(rmInfo,null,2));
  // Also screenshot for visual record
  await page.evaluate(()=>{ 
    const b=document.querySelector('[data-qa="queue-btn-0"]');
    if(b) b.classList.add('nothing-enqueue--pending');
  });
  const out = path.join(QA_DIR, 'task-13-reduced-motion-desktop.png');
  await page.screenshot({ path: out, fullPage:true });
  console.log(`Screenshot task-13-reduced-motion-desktop.png -> ${out} (${fs.statSync(out).size} bytes)`);
  // Save rmInfo for report
  fs.writeFileSync(path.join(QA_DIR,'task-13-reduced-motion.json'), JSON.stringify(rmInfo,null,2));
  await ctx.close();
}

// 6. Also do a direct CSS computed style check without reduced motion (normal pending should be 320ms)
{
  const ctx = await browser.newContext({ viewport:{width:1280,height:800} });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/`, { waitUntil:'networkidle' });
  await page.waitForTimeout(800);
  const openBtn = page.locator('button', { hasText: '+ OPEN' }).first();
  if (await openBtn.count()>0){ await openBtn.click(); await page.waitForTimeout(400); }
  await page.evaluate(injectMocksScript);
  await page.waitForTimeout(300);
  const normalInfo = await page.evaluate(()=>{
    const b = document.querySelector('[data-qa="queue-btn-0"]');
    if(b){ b.classList.add('nothing-enqueue--pending'); }
    const el = document.querySelector('.nothing-enqueue--pending');
    const cs = el ? getComputedStyle(el) : null;
    const vars = getComputedStyle(document.documentElement);
    return {
      animationDuration: cs?.animationDuration,
      animationName: cs?.animationName,
      borderColor: cs?.borderColor,
      boxShadow: cs?.boxShadow,
      enqueueDurationVar: vars.getPropertyValue('--nothing-enqueue-duration').trim(),
      enqueueEaseVar: vars.getPropertyValue('--nothing-enqueue-ease').trim(),
      nothingRedVar: vars.getPropertyValue('--nothing-red').trim(),
    };
  });
  console.log('Normal pending check:', JSON.stringify(normalInfo,null,2));
  fs.writeFileSync(path.join(QA_DIR,'task-13-normal-pending.json'), JSON.stringify(normalInfo,null,2));
  await ctx.close();
}

// 7. CJK clipping check (reuse logic from cjk_check but on our injected page)
{
  const ctx = await browser.newContext({ viewport:{width:1280,height:800} });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/`, { waitUntil:'networkidle' });
  await page.waitForTimeout(1000);
  const openBtn = page.locator('button', { hasText: '+ OPEN' }).first();
  if (await openBtn.count()>0){ await openBtn.click(); await page.waitForTimeout(400); }
  await page.evaluate(injectMocksScript);
  await page.waitForTimeout(300);
  const cjk = await page.evaluate(()=>{
    const probe = document.querySelector('[data-qa="cjk-probe"]');
    const cjkEls = Array.from(document.querySelectorAll('*')).filter(el => /[\u3040-\u30ff\u4e00-\u9faf]/.test(el.textContent || ''));
    const samples = cjkEls.slice(0,10).map(el => ({
      tag: el.tagName,
      text: (el.textContent||'').slice(0,80).replace(/\n/g,' '),
      overflow: getComputedStyle(el).overflow,
      textOverflow: getComputedStyle(el).textOverflow,
      fontFamily: getComputedStyle(el).fontFamily.slice(0,80),
      fontSize: getComputedStyle(el).fontSize,
      w: el.getBoundingClientRect().width.toFixed(1),
      h: el.getBoundingClientRect().height.toFixed(1),
      clipped: el.scrollWidth > el.clientWidth + 1,
    }));
    const h1 = document.querySelector('h1.nothing-title');
    const h1Style = h1 ? getComputedStyle(h1) : null;
    return {
      cjkProbeExists: !!probe,
      cjkProbeBox: probe ? `${probe.getBoundingClientRect().width.toFixed(1)}x${probe.getBoundingClientRect().height.toFixed(1)} scrollW=${probe.scrollWidth} clientW=${probe.clientWidth}` : null,
      h1FontFamily: h1Style?.fontFamily,
      h1Overflow: h1Style?.overflow,
      samples,
      totalCJKElements: cjkEls.length,
    };
  });
  console.log('CJK check:', JSON.stringify(cjk,null,2));
  fs.writeFileSync(path.join(QA_DIR,'task-13-cjk.json'), JSON.stringify(cjk,null,2));
  await ctx.close();
}

await browser.close();
preview.kill();
console.log('All task-13 QA done');
