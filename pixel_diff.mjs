import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';

async function diff(aPath, bPath) {
  const aData = PNG.sync.read(fs.readFileSync(aPath));
  const bData = PNG.sync.read(fs.readFileSync(bPath));
  if (aData.width !== bData.width || aData.height !== bData.height) {
    return { diffPct: 100, note: `size mismatch ${aData.width}x${aData.height} vs ${bData.width}x${bData.height}` };
  }
  let diffPixels = 0;
  const total = aData.width * aData.height;
  for (let i = 0; i < aData.data.length; i += 4) {
    const dr = Math.abs(aData.data[i] - bData.data[i]);
    const dg = Math.abs(aData.data[i+1] - bData.data[i+1]);
    const db = Math.abs(aData.data[i+2] - bData.data[i+2]);
    if (dr > 16 || dg > 16 || db > 16) diffPixels++;
  }
  return { diffPct: (diffPixels / total * 100), diffPixels, total, width: aData.width, height: aData.height };
}

const qa = '.omo/qa';
const pairs = [
  ['f3-empty-triptych-desktop.png', 'f3-header-desktop.png', 'header vs empty (expect ~0% same page)'],
  ['f3-empty-triptych-desktop.png', 'f3-browser-thumbnail-desktop.png', 'browser vs empty (expect ~0% no preview yet)'],
  ['f3-empty-triptych-mobile.png', 'f3-header-mobile.png', 'mobile header vs empty'],
  ['f3-player-clean-desktop.png', 'f3-player-viewer-ambient-desktop.png', 'ambient vs clean (injected badges differ)'],
];

for (const [a,b,note] of pairs) {
  const r = await diff(path.join(qa,a), path.join(qa,b));
  console.log(`${a} vs ${b} [${note}]: ${r.diffPct.toFixed(3)}% (${r.diffPixels}/${r.total}) ${r.note||''}`);
}

for (const f of fs.readdirSync(qa).filter(x=>x.startsWith('f3-')).sort()) {
  const s = fs.statSync(path.join(qa,f));
  console.log(`${f}: ${s.size} bytes`);
}
