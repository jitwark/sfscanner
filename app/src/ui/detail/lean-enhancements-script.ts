import { normalizeBasePath } from '../site-url.mjs';

/**
 * Progressive enhancement script for statically rendered lean pages.
 *
 * Runs without React hydration so that all 11,215 static lean pages provide:
 * 1. Interactive workflow canvas: drag-to-pan with mouse, touch and pen (captured
 *    pointer events), button/scroll zoom, reset, SVG download.
 * 2. In-browser workflow download: direct byte-range fetch of workflow JSON without redirects.
 *
 * `basePath` is the deployment's subpath — `/n8n-Secureflow` on GitHub Pages,
 * where `deploy.yml` sets `NEXT_PUBLIC_BASE_PATH` to the repository name. The
 * pack shard lives under that subpath like every other internal URL, so the
 * prefix is templated in at emission time, exactly as `sitePath()` inlines the
 * same value for the hydrated control `download.ts` drives. A root-absolute
 * URL leaves the site root and 404s there, on every one of the 259 lean pages
 * that offer a download. The prefix is not read back out of the DOM or guessed
 * from `location.pathname`: one build serves one subpath.
 */
export function getLeanPageEnhancementsScript(basePath = ''): string {
  const shardPrefix = `${normalizeBasePath(basePath)}/data/packs/pack-`;
  return `(function(){if(typeof window==='undefined')return;`
    + `document.addEventListener('click',async function(e){`
    + `var b=e.target&&e.target.closest&&e.target.closest('[data-download-pack]');`
    + `if(!b)return;`
    + `var p=b.getAttribute('data-download-pack'),o=parseInt(b.getAttribute('data-download-offset')||'',10),l=parseInt(b.getAttribute('data-download-length')||'',10),s=b.getAttribute('data-download-slug')||'workflow';`
    + `if(!p||isNaN(o)||isNaN(l))return;`
    // The control's `sr-only` region is a live region, so something has to
    // change it or it should not be one. These are the same three states the
    // hydrated control announces for the same control — a live region that is
    // empty on arrival and filled by the click is announcing a real change —
    // and it is cleared when the button takes its own label back, so it never
    // carries a stale result.
    + `var orig=b.textContent,st=b.parentElement&&b.parentElement.querySelector('[data-download-status]');`
    + `function say(m){if(st)st.textContent=m;}`
    + `b.setAttribute('disabled','true');b.textContent='Downloading...';say('Downloading...');`
    + `try{`
    + `var r=await fetch(${JSON.stringify(shardPrefix)}+p+'.jsonl',{headers:{Range:'bytes='+o+'-'+(o+l-1)}});`
    // A lean page has no manifest and no hash of its own, so the only proof it
    // can demand is that the host answered the exact range: a 206 for precisely
    // these bytes out of that pack. A 200 means the pack was sent whole and the
    // reader would slice it blind, so it is a failure, not a slower success.
    + `if(r.status!==206)throw new Error(r.status);`
    + `var cr=r.headers&&r.headers.get?r.headers.get('content-range'):null;`
    + `if(!cr||cr.indexOf('bytes '+o+'-'+(o+l-1)+'/')!==0)throw new Error('content-range');`
    + `var bytes=new Uint8Array(await r.arrayBuffer());`
    + `if(bytes.length!==l)throw new Error('length');`
    + `var j=JSON.parse(new TextDecoder().decode(bytes).trim());`
    + `var bl=new Blob([JSON.stringify(j,null,2)],{type:'application/json'});`
    + `var a=document.createElement('a');a.href=URL.createObjectURL(bl);a.download=s+'.json';document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(a.href);`
    + `b.textContent='Downloaded!';say('Downloaded!');setTimeout(function(){b.removeAttribute('disabled');b.textContent=orig;say('');},2000);`
    + `}catch(_){b.removeAttribute('disabled');b.textContent='Download failed';say('Download failed');setTimeout(function(){b.textContent=orig;say('');},2500);}`
    + `});`
    + `function init(){`
    + `document.querySelectorAll('[data-canvas-viewport]').forEach(function(v){`
    + `if(v.dataset.enhanced)return;v.dataset.enhanced='1';`
    + `var z=1,px=0,py=0,drag=false,sx=0,sy=0,pid=null;`
    + `var t=v.querySelector('[data-viewport-target]'),lb=v.querySelector('[aria-label="Reset zoom to 100%"]');`
    + `if(!t)return;`
    + `function tr(){t.style.transform='translate('+px+'px, '+py+'px) scale('+z+')';if(lb)lb.textContent=Math.round(z*100)+'%';}`
    + `v.addEventListener('click',function(e){`
    + `var b=e.target&&e.target.closest&&e.target.closest('button');if(!b)return;`
    + `var a=b.getAttribute('aria-label')||b.getAttribute('title')||'';`
    + `if(a.indexOf('Zoom in')!==-1){z=Math.min(2.5,Number((z+0.25).toFixed(2)));tr();}`
    + `else if(a.indexOf('Zoom out')!==-1){z=Math.max(0.5,Number((z-0.25).toFixed(2)));tr();}`
    + `else if(a.indexOf('Reset')!==-1||a.indexOf('Fit')!==-1){z=1;px=0;py=0;tr();}`
    + `else if(a.indexOf('SVG')!==-1){`
    + `var svg=t.querySelector('svg');if(svg){`
    + `var bl=new Blob([svg.outerHTML],{type:'image/svg+xml;charset=utf-8'});`
    + `var dl=document.createElement('a');dl.href=URL.createObjectURL(bl);dl.download='workflow-diagram.svg';document.body.appendChild(dl);dl.click();document.body.removeChild(dl);URL.revokeObjectURL(dl.href);`
    + `}}});`
    // Captured Pointer Events, so mouse, touch and pen all pan. The viewport is the
    // capture target and the gesture ends on `pointerup`, `pointercancel` or
    // `lostpointercapture` — a cancelled touch must not leave the canvas stuck
    // mid-drag. The stage already carries `touch-action:none` from
    // `canvas-viewport.tsx` (the same markup, rendered without React here), which is
    // what stops the browser from claiming a touch drag as a page scroll before any
    // `pointermove` arrives. A pointerdown on a toolbar button is skipped: capturing
    // it would retarget the following `click` to the viewport, and the delegated
    // button handler above would stop seeing the button.
    + `function onDown(e){if(!e.isPrimary||e.button!==0||drag)return;if(e.target&&e.target.closest&&e.target.closest('button'))return;drag=true;pid=e.pointerId;sx=e.clientX-px;sy=e.clientY-py;v.style.cursor='grabbing';try{v.setPointerCapture(e.pointerId);}catch(_){}}`
    + `function onMove(e){if(!drag||e.pointerId!==pid)return;px=e.clientX-sx;py=e.clientY-sy;tr();}`
    + `function onEnd(e){if(!drag||e.pointerId!==pid)return;drag=false;pid=null;v.style.cursor=z>1?'grab':'default';}`
    + `v.addEventListener('pointerdown',onDown);`
    + `v.addEventListener('pointermove',onMove);`
    + `v.addEventListener('pointerup',onEnd);`
    + `v.addEventListener('pointercancel',onEnd);`
    + `v.addEventListener('lostpointercapture',onEnd);`
    + `v.addEventListener('wheel',function(e){if(e.ctrlKey||e.metaKey){e.preventDefault();z=Math.min(2.5,Math.max(0.5,Number((z+(e.deltaY<0?0.15:-0.15)).toFixed(2))));tr();}},{passive:false});`
    + `});}`
    + `if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',init);}else{init();}`
    + `})();`;
}
