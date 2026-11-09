import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';

async function diff(aPath,bPath){
  const aData=PNG.sync.read(fs.readFileSync(aPath));
  const bData=PNG.sync.read(fs.readFileSync(bPath));
  if(aData.width!==bData.width || aData.height!==bData.height){
    // if size mismatch, we can't diff directly; report note and compute via smallest size?
    // For now return 100 and size mismatch
    return { diffPct:100, diffPixels:0, total:0, note:`size mismatch ${aData.width}x${aData.height} vs ${bData.width}x${bData.height}`};
  }
  let diffPixels=0;
  const total=aData.width*aData.height;
  for(let i=0;i<aData.data.length;i+=4){
    const dr=Math.abs(aData.data[i]-bData.data[i]);
    const dg=Math.abs(aData.data[i+1]-bData.data[i+1]);
    const db=Math.abs(aData.data[i+2]-bData.data[i+2]);
    if(dr>16||dg>16||db>16) diffPixels++;
  }
  return { diffPct: diffPixels/total*100, diffPixels, total, width:aData.width,height:aData.height };
}

const QA='.omo/qa';
const pairs=[
  ['task-13-browser-idle-desktop.png','task-13-queue-pending-desktop.png','idle vs pending desktop (expect small diff <8% - shimmer)'],
  ['task-13-queue-pending-desktop.png','task-13-queue-success-desktop.png','pending vs success desktop (border/pop)'],
  ['task-13-browser-idle-desktop.png','task-13-queue-success-desktop.png','idle vs success desktop'],
  ['task-13-browser-idle-desktop.png','task-13-bookmark-pending-desktop.png','idle vs bookmark pending'],
  ['task-13-browser-idle-desktop.png','task-13-bookmark-success-desktop.png','idle vs bookmark success'],
  ['task-13-browser-idle-desktop.png','task-13-browser-idle-mobile.png','desktop vs mobile (size mismatch expected)'],
];

for(const [a,b,note] of pairs){
  const ap=path.join(QA,a);
  const bp=path.join(QA,b);
  if(!fs.existsSync(ap)||!fs.existsSync(bp)){ console.log(`SKIP ${a} vs ${b} : missing file`); continue; }
  const r=await diff(ap,bp);
  console.log(`${a} vs ${b} [${note}]: ${r.diffPct.toFixed(3)}% (${r.diffPixels}/${r.total}) ${r.note||''} ${r.diffPct<=8 ? '✅ PASS ≤8%' : '❌ FAIL >8%'}`);
}

console.log('\n--- All task-13 png sizes ---');
for(const f of fs.readdirSync(QA).filter(x=>x.startsWith('task-13-')).sort()){
  const s=fs.statSync(path.join(QA,f));
  const png=PNG.sync.read(fs.readFileSync(path.join(QA,f)));
  console.log(`${f}: ${s.size} bytes ${png.width}x${png.height}`);
}
