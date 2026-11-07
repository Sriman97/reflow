/* ==CORE-START== : PDF → reflowable blocks */
const CORE_VERSION = 7;

function median(a){ if(!a.length) return 0; const b=[...a].sort((x,y)=>x-y); return b[b.length>>1]; }
function pct(a,p){ if(!a.length) return 0; const b=[...a].sort((x,y)=>x-y); return b[Math.min(b.length-1,Math.floor(p*b.length))]; }

// Read text positions and figure hints from every page.
async function extractPages(pdf, onProg){
  const OPS = pdfjsLib.OPS, pages=[];
  for(let i=1;i<=pdf.numPages;i++){
    const page = await pdf.getPage(i);
    const [vx0,vy0,vx1,vy1] = page.view;
    let ol=null; try{ ol = await page.getOperatorList(); }catch(e){}   // also loads fonts (for bold detection)
    const tc = await page.getTextContent();
    const boldOf={};
    const isBold = fn => {
      if(fn in boldOf) return boldOf[fn];
      let bo=false;
      try{ if(page.commonObjs.has(fn)){ const f=page.commonObjs.get(fn); bo=!!(f.bold||f.black||/bold|black|heavy|semibold|demi/i.test(f.name||'')); } }catch(e){}
      try{ const st=tc.styles&&tc.styles[fn]; if(st && /bold|black|heavy/i.test(st.fontFamily||'')) bo=true; }catch(e){}
      return boldOf[fn]=bo;
    };
    const items=[];
    for(const it of tc.items){
      if(!it.str || !it.str.trim()) continue;
      const [a,b,c,d,e,f] = it.transform;
      if(Math.abs(b) > 0.05*Math.abs(a) || a<=0) continue;          // skip rotated text
      const size = Math.hypot(c,d) || it.height;
      if(size < 1) continue;
      items.push({s:it.str, x:e-vx0, y:f-vy0, w:it.width, size, b:isBold(it.fontName)});
    }
    let fig=false;
    try{
      if(!ol) throw 0;
      let paths=0;
      for(let k=0;k<ol.fnArray.length;k++){
        const fn=ol.fnArray[k], args=ol.argsArray[k];
        if(fn===OPS.paintImageXObject || fn===OPS.paintJpegXObject){ if(args && args[1]*args[2] > 40000){ fig=true; break; } }
        else if(fn===OPS.paintInlineImageXObject){ const im=args&&args[0]; if(im && im.width*im.height>40000){ fig=true; break; } }
        else if(fn===OPS.constructPath) paths++;
      }
      if(paths > 150) fig=true;
    }catch(e){}
    pages.push({w:vx1-vx0, h:vy1-vy0, items, fig});
    page.cleanup();
    if(onProg) await onProg(i, pdf.numPages);
  }
  return pages;
}

// Detect a two-column page: an empty vertical band near the middle.
function splitColumns(items, pw){
  const narrow = items.filter(it => it.w < pw*0.55);
  if(narrow.length < 16) return [items];
  const bins = new Array(100).fill(0);
  for(const it of narrow){
    const a=Math.max(0,Math.floor(it.x/pw*100)), b=Math.min(99,Math.floor((it.x+it.w)/pw*100));
    for(let i=a;i<=b;i++) bins[i]++;
  }
  let best=-1, bv=Infinity;
  for(let i=38;i<=62;i++) if(bins[i]<bv){ bv=bins[i]; best=i; }
  const split=(best+0.5)/100*pw;
  let lc=0, rc=0;
  for(const it of items){ if(it.x+it.w/2 < split) lc+=it.s.length; else rc+=it.s.length; }
  const tot=lc+rc;
  if(bv <= narrow.length*0.01 && lc > tot*0.25 && rc > tot*0.25)
    return [items.filter(it=>it.x+it.w/2<split), items.filter(it=>it.x+it.w/2>=split)];
  return [items];
}

// Group text items into lines (same baseline), left to right.
function itemsToLines(items){
  items = [...items].sort((a,b)=>(b.y-a.y)||(a.x-b.x));
  const lines=[];
  for(const it of items){
    let line=null;
    for(let k=lines.length-1;k>=Math.max(0,lines.length-3);k--){
      const L=lines[k];
      if(Math.abs(L.y-it.y) < Math.max(L.size,it.size)*0.5){ line=L; break; }
    }
    if(!line){ line={y:it.y,size:it.size,items:[]}; lines.push(line); }
    line.items.push(it);
  }
  for(const L of lines){
    L.items.sort((a,b)=>a.x-b.x);
    let t='', lastX1=null, boldC=0, allC=0; const cnt={};
    for(const it of L.items){
      if(lastX1!==null){
        const gap=it.x-lastX1;
        if(gap > it.size*0.15 && !/\s$/.test(t) && !/^\s/.test(it.s)) t+=' ';
      }
      t+=it.s;
      lastX1 = Math.max(lastX1===null?-1e9:lastX1, it.x+it.w);
      const k=Math.round(it.size*2)/2; cnt[k]=(cnt[k]||0)+it.s.length;
      allC+=it.s.length; if(it.b) boldC+=it.s.length;
    }
    L.bold = allC>0 && boldC/allC > 0.6;
    L.text=t.replace(/\s+/g,' ').trim();
    L.x0=L.items[0].x; L.x1=lastX1;
    L.size=+Object.entries(cnt).sort((a,b)=>b[1]-a[1])[0][0];
  }
  lines.sort((a,b)=>b.y-a.y);
  return lines.filter(L=>L.text);
}

// Turn lines into blocks: paragraphs, headings, figures.
function buildBlocks(pages){
  const sizeCnt={};
  for(const pg of pages){
    pg.cols = splitColumns(pg.items, pg.w).map(itemsToLines);
    for(const c of pg.cols) for(const L of c) sizeCnt[L.size]=(sizeCnt[L.size]||0)+L.text.length;
  }
  const body = +((Object.entries(sizeCnt).sort((a,b)=>b[1]-a[1])[0]||[10])[0]);
  const near = (s)=>Math.abs(s-body) < body*0.06+0.3;

  // Running headers, footers and page numbers.
  const chapLike = t=>/^(chapter|part|book|section)\s+\S+$/i.test(t.trim());
  const norm = t=>{ const x=t.toLowerCase().replace(/\s+/g,' ').trim(); return chapLike(x) ? x : x.replace(/\d+/g,'#'); };
  const edgeLines = pg=>{
    const ls=pg.cols.flat().sort((a,b)=>b.y-a.y);
    if(ls.length<4) return new Set(ls.filter(L=>/^#$/.test(norm(L.text))));
    return new Set([ls[0],ls[1],ls[ls.length-2],ls[ls.length-1]]);
  };
  const edgeCnt={};
  for(const pg of pages){ pg.edges=edgeLines(pg); const seen=new Set(); for(const L of pg.edges){ const n=norm(L.text); if(!seen.has(n)){ seen.add(n); edgeCnt[n]=(edgeCnt[n]||0)+1; } } }
  const thr=Math.max(3, pages.length*0.12);
  for(const pg of pages) for(const L of pg.edges){
    const n=norm(L.text);
    if(edgeCnt[n]>=thr || (edgeCnt[n]>=3 && !near(L.size) && L.size<body) || /^(page )?#( of #)?$/.test(n) || (/^[ivxlc]+$/.test(n) && n.length<=5 && L.text.length<=5)) L.drop=true;
  }

  // Typical line spacing (in units of body size).
  const ratios=[];
  for(const pg of pages) for(const c of pg.cols) for(let i=1;i<c.length;i++){
    const a=c[i-1], b=c[i];
    if(near(a.size)&&near(b.size)){ const r=(a.y-b.y)/body; if(r>0.6&&r<4) ratios.push(r); }
  }
  const lead = median(ratios) || 1.25;

  const blocks=[]; let cur=null; const pendingFigs=[];
  const terminal=/[.!?:"”’»)\]]$/;
  const flush=()=>{
    if(cur){ cur.text=cur.text.trim(); if(cur.text) blocks.push(cur); cur=null; }
    while(pendingFigs.length) blocks.push({t:'chip', page:pendingFigs.shift()});
  };
  const append=(L)=>{
    const t=L.text;
    if(!cur.text){ cur.text=t; return; }
    if(/[A-Za-zÀ-ɏ]-$/.test(cur.text) && /^[a-zß-ÿ]/.test(t)) cur.text=cur.text.slice(0,-1)+t;
    else if(/[­¬]$/.test(cur.text)) cur.text=cur.text.slice(0,-1)+t;
    else cur.text+=' '+t;
  };

  const chapRe=/^(chapter|part|book|appendix|prologue|epilogue|introduction|preface|foreword|afterword|conclusion|epigraph|acknowledg\w*|bibliography|glossary|index|contents)\b/i;
  const numRe=/^((chapter|part|book|section)\s+)?([0-9]{1,3}|[ivxlc]{1,7}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty[\w-]*|thirty[\w-]*|forty[\w-]*|fifty[\w-]*)\.?$/i;
  const words = t => t.split(' ').length;
  const headish = L => L.text.length<=90 && words(L.text)<=14 && !/[,;]$/.test(L.text) && !/[a-z]{2}\.$/.test(L.text);
  let prevPageEnd = 1;   // y/h of the last line on the previous text page (0 = bottom)

  pages.forEach((pg,pi)=>{
    let textChars=0, firstOfPage=true;
    const cols=pg.cols.map(c=>c.filter(L=>!L.drop));
    const firstL=(cols.find(c=>c.length)||[])[0];
    const sink = firstL ? (pg.h-firstL.y)/pg.h : 0;
    const tocPage = cols.some(c=>c.some(L=>/^(table of )?contents$/i.test(L.text.trim())));
    for(const ls of cols){
      if(!ls.length) continue;
      const bodyLs=ls.filter(L=>near(L.size));
      const ref = bodyLs.length>=3 ? bodyLs : ls;
      const left=pct(ref.map(L=>L.x0),0.15), right=pct(ref.map(L=>L.x1),0.85);
      const colW=Math.max(right-left, body*10);
      const indented = L => L.x0-left > body*0.8 && L.x0-left < colW*0.4;
      let prev=null;
      for(let j=0;j<ls.length;j++){
        const L=ls[j], nx=ls[j+1];
        textChars+=L.text.length;
        const rel=L.size/body;
        const gapB = prev ? (prev.y-L.y)/body : 99, gapA = nx ? (L.y-nx.y)/body : 99;
        const alone = gapB>lead*1.3 && gapA>lead*1.3;
        firstOfPage=false;
        let kind=null;
        const standsOut = alone || (!prev && gapA>lead*1.2);
        if(tocPage) kind=null;
        else if((rel>=1.12 || (rel>=1.05 && L.bold)) && L.text.length<140) kind = rel>=1.6 ? 'h1' : 'h2';
        else if(headish(L)){
          const named = chapRe.test(L.text) || (/^(chapter|part|book|section)\s/i.test(L.text) && numRe.test(L.text));
          if(named && words(L.text)<=10 && standsOut) kind='h1';
          else if(numRe.test(L.text) && L.bold && standsOut) kind='h1';
          else if(L.bold && standsOut) kind='h2';
        }
        if(kind){
          const isHead = cur && (cur.t==='h1'||cur.t==='h2') && cur.page===pi && prev;
          const dist = isHead ? (prev.y-L.y) : 1e9;
          if(isHead && Math.abs(prev.size-L.size)<0.6 && dist < L.size*2.2 && !numRe.test(cur.text) && (cur.t===kind || cur.text.includes(': '))) append(L);
          else if(isHead && !cur.text.includes(': ') && dist < Math.max(L.size,prev.size)*4 && (numRe.test(cur.text) || (chapRe.test(cur.text) && words(cur.text)<=3))){ cur.text+=': '+L.text; cur.t='h1'; }
          else { flush(); cur={t:kind,text:'',page:pi}; append(L); }
          prev=L; continue;
        }
        let brk=false;
        if(!cur || cur.t!=='p') brk=true;
        else if(prev && /[A-Za-z]-$/.test(prev.text) && /^[a-z]/.test(L.text)) brk=false;
        else if(prev){
          if(gapB > lead*1.45 || gapB < 0) brk=true;
          else if(indented(L)) brk=true;
          else if(prev.x1 < right - body*2.5 && terminal.test(prev.text)) brk=true;
          else if(prev.x1 < right - colW*0.35) brk=true;
          else if(!!cur.small !== (L.size < body*0.85)) brk=true;
        } else {
          if(indented(L) || (terminal.test(cur.text) && !/^[a-z]/.test(L.text))) brk=true;
        }
        if(brk){ flush(); cur={t:'p',text:'',page:pi}; if(L.size < body*0.85) cur.small=true; }
        append(L); prev=L;
      }
    }
    const lastCol=[...cols].reverse().find(c=>c.length);
    if(lastCol) prevPageEnd = lastCol[lastCol.length-1].y/pg.h;
    if(pg.fig){
      if(textChars < 60){ flush(); blocks.push({t:'img', page:pi, ar:pg.w/pg.h}); prevPageEnd=1; }
      else pendingFigs.push(pi);
    }
  });
  flush();
  // A repeated chapter label later in the book (e.g. in the notes) is a sub-heading, not a new chapter.
  const seen=new Set();
  for(const b of blocks) if(b.t==='h1'){
    const k=b.text.split(':')[0].toLowerCase().replace(/[^a-z0-9]/g,'');
    if(seen.has(k)) b.t='h2'; else seen.add(k);
  }
  return {blocks, body, lead};
}
/* ==CORE-END== */

/* ---------- storage (IndexedDB; optional) ---------- */
const DB={
  db:null,
  open(){ if(this.db) return Promise.resolve(this.db);
    return new Promise((res,rej)=>{ let r; try{ r=indexedDB.open('reflow-reader',1); }catch(e){ return rej(e); }
      r.onupgradeneeded=()=>{ const d=r.result; ['books','meta','cache'].forEach(n=>d.createObjectStore(n,{keyPath:'id'})); };
      r.onsuccess=()=>{ this.db=r.result; res(this.db); }; r.onerror=()=>rej(r.error); }); },
  async run(store,mode,fn){ const db=await this.open(); return new Promise((res,rej)=>{ const t=db.transaction(store,mode); const req=fn(t.objectStore(store)); t.oncomplete=()=>res(req&&req.result); t.onerror=()=>rej(t.error); t.onabort=()=>rej(t.error); }); },
  put(s,v){ return this.run(s,'readwrite',o=>o.put(v)).catch(()=>null); },
  get(s,id){ return this.run(s,'readonly',o=>o.get(id)).catch(()=>null); },
  all(s){ return this.run(s,'readonly',o=>o.getAll()).catch(()=>[]); },
  del(s,id){ return this.run(s,'readwrite',o=>o.delete(id)).catch(()=>null); }
};
const LS={ get(k,d){ try{ const v=localStorage.getItem(k); return v?JSON.parse(v):d; }catch(e){ return d; } }, set(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch(e){} } };

/* ---------- state ---------- */
const $=id=>document.getElementById(id);
const GAP=60;
const FONTS={serif:"'Literata',Georgia,serif", georgia:"Georgia,'Times New Roman',serif", sans:"'Inter',system-ui,sans-serif"};
const S={ id:null, name:'', pdf:null, blocks:[], toc:[], cum:[], total:1, sec:[], si:0, page:0, pages:1, pos:0, W:300, H:500, meta:null,
  set:Object.assign({size:19,font:'serif',lh:'1.55',margin:'24',align:'justify',theme:'light',flash:'off',mode:'pages'}, LS.get('reflow.settings',{})) };
const content=$('content'), viewport=$('viewport');

function showLoading(msg,frac){ $('load').classList.remove('hidden'); $('loadMsg').textContent=msg; $('loadBar').style.width=((frac||0)*100)+'%'; }
function hideLoading(){ $('load').classList.add('hidden'); }
function esc(s){ return s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

/* ---------- library ---------- */
async function renderLibrary(){
  const metas=(await DB.all('meta')).sort((a,b)=>(b.opened||0)-(a.opened||0));
  $('books').innerHTML = metas.map(m=>`<div class="book" data-id="${esc(m.id)}"><div class="nm"><div class="t">${esc(m.name)}</div><div class="bar"><i style="width:${Math.round((m.pct||0)*100)}%"></i></div><div class="pc">${Math.round((m.pct||0)*100)}% read</div></div><button data-del="${esc(m.id)}" title="Remove">×</button></div>`).join('');
}
$('books').addEventListener('click', async e=>{
  const del=e.target.closest('[data-del]');
  if(del){ e.stopPropagation(); const id=del.dataset.del; await DB.del('books',id); await DB.del('meta',id); await DB.del('cache',id); renderLibrary(); return; }
  const b=e.target.closest('.book'); if(!b) return;
  const id=b.dataset.id;
  showLoading('Opening…',0);
  try{
    const rec=await DB.get('books',id);
    const m=await DB.get('meta',id);
    let buf=null;
    if(rec && rec.data) buf=rec.data;
    else if(rec && rec.blob){ try{ buf=await rec.blob.arrayBuffer(); }catch(err){ buf=null; } }
    if(!buf || !buf.byteLength){ alertBox('This browser did not keep the PDF file. Tap "Open a PDF" and pick it again. Your place in the book is kept.'); return; }
    openBook(id, m?m.name:'Book', buf);
  }catch(err){ alertBox('Could not open this book: '+(err&&err.message||err)); }
});
$('file').addEventListener('change', async e=>{
  const f=e.target.files[0]; e.target.value=''; if(!f) return;
  const id=f.name+'|'+f.size;
  showLoading('Opening '+f.name+'…',0);
  const buf=await f.arrayBuffer();
  await DB.put('books',{id, data:buf.slice(0)});
  const old=await DB.get('meta',id);
  openBook(id, old&&old.name || f.name.replace(/\.pdf$/i,''), buf);
});
function alertBox(msg){ hideLoading(); const n=document.createElement('p'); n.className='note'; n.style.cssText='color:var(--accent);font-size:14px;margin:0 0 4px'; n.textContent=msg; $('books').prepend(n); setTimeout(()=>n.remove(),9000); }

/* ---------- open + extract ---------- */
async function openBook(id,name,buf){
  try{
    showLoading('Opening…',0);
    S.pdf = await pdfjsLib.getDocument({data:new Uint8Array(buf), isEvalSupported:false}).promise;
    let cache=await DB.get('cache',id);
    if(!cache || cache.v!==CORE_VERSION){
      let last=0;
      const pages = await extractPages(S.pdf, async (i,n)=>{ const now=Date.now(); if(now-last>80||i===n){ last=now; showLoading(`Rebuilding text… page ${i} of ${n}`, i/n); await new Promise(r=>setTimeout(r,0)); } });
      showLoading('Laying out paragraphs…',1);
      const r=buildBlocks(pages);
      cache={id, v:CORE_VERSION, blocks:r.blocks, toc:await getToc(S.pdf,r.blocks)};
      await DB.put('cache',cache);
    }
    S.id=id; S.name=name; S.blocks=cache.blocks; S.toc=cache.toc;
    S.meta = (await DB.get('meta',id)) || {id,name,pos:0,pct:0};
    S.meta.opened=Date.now(); DB.put('meta',S.meta);
    S.cum=[]; let c=0; for(const b of S.blocks){ S.cum.push(c); c+= b.text? b.text.length : 400; } S.total=Math.max(1,c);
    buildSections();
    $('lib').classList.add('hidden'); $('reader').classList.remove('hidden'); hideLoading();
    $('ttl').textContent=name; $('hdrL').textContent=name;
    applySettings(false);
    if(!S.blocks.length){ content.innerHTML=''; openOriginal(0); return; }
    const b0=Math.min(S.meta.pos||0, S.blocks.length-1); show(b0, S.meta.off||0);
  }catch(err){ console.error(err); alertBox('Could not open this PDF: '+(err&&err.message||err)); $('reader').classList.add('hidden'); $('lib').classList.remove('hidden'); }
}

async function getToc(pdf,blocks){
  const firstBlock=[]; for(let i=blocks.length-1;i>=0;i--) firstBlock[blocks[i].page]=i;
  const p2b=p=>{ for(let q=p;q<pdf.numPages;q++) if(firstBlock[q]!=null) return firstBlock[q]; return Math.max(0,blocks.length-1); };
  const outline=[]; let ol=null; try{ ol=await pdf.getOutline(); }catch(e){}
  async function walk(items,depth){
    for(const it of items||[]){
      try{ let d=it.dest; if(typeof d==='string') d=await pdf.getDestination(d);
        if(Array.isArray(d) && d[0]!=null){ const p = typeof d[0]==='object' ? await pdf.getPageIndex(d[0]) : d[0]; outline.push({title:it.title, depth, block:p2b(p)}); } }catch(e){}
      if(depth<2) await walk(it.items, depth+1);
    }
  }
  if(ol) await walk(ol,0);
  // Detected headings from the text.
  const h1=blocks.filter(b=>b.t==='h1').length, h2=blocks.filter(b=>b.t==='h2').length;
  const withH2 = !(h1>=3 && h2>h1*8);
  const found=[];
  blocks.forEach((b,i)=>{ if(b.t==='h1' || (b.t==='h2' && withH2)) found.push({title:b.text.slice(0,90), depth:(b.t==='h1'||!h1)?0:1, block:i}); });
  // Use the PDF's own outline, and add detected chapters that it lacks.
  const outlineChapters = outline.filter(e=>e.depth===0).length;
  const detectedChapters = found.filter(e=>e.depth===0).length;
  if(outline.length && (detectedChapters < 3 || outlineChapters >= detectedChapters*1.5)) return outline;
  const norm=t=>t.toLowerCase().replace(/[^a-z0-9]/g,'');
  const out=[...outline];
  for(const f of found){
    if(out.some(o=>Math.abs(o.block-f.block)<=2 && (o.depth===0||f.depth===0) && (norm(o.title).startsWith(norm(f.title).slice(0,6))||norm(f.title).startsWith(norm(o.title).slice(0,6))||o.block===f.block))) continue;
    out.push(f);
  }
  out.sort((a,b)=>a.block-b.block || a.depth-b.depth);
  return out;
}

/* ---------- sections + layout ---------- */
function buildSections(){
  S.sec=[]; let st=0; const n=S.blocks.length;
  for(let i=1;i<=n;i++){
    const b=S.blocks[i], len=i-st;
    if(i===n || ((b.t==='h1'||b.t==='h2') && len>=25) || len>=180){ S.sec.push([st,i]); st=i; }
  }
}
const secOf=i=>{ for(let k=0;k<S.sec.length;k++) if(i<S.sec[k][1]) return k; return S.sec.length-1; };

function applySettings(relayout=true){
  const s=S.set, r=document.documentElement.style;
  r.setProperty('--fs',s.size+'px'); r.setProperty('--lh',s.lh); r.setProperty('--ff',FONTS[s.font]||FONTS.serif);
  r.setProperty('--ta',s.align); r.setProperty('--m',s.margin+'px');
  document.body.className=s.theme==='light'?'':s.theme;
  document.querySelectorAll('#sAa .seg[data-k]').forEach(g=>g.querySelectorAll('button').forEach(b=>b.classList.toggle('on', String(s[g.dataset.k])===b.dataset.v)));
  LS.set('reflow.settings',s);
  if(relayout && S.blocks.length) show(S.pos,S.off);
}

function layoutDims(){
  const m=+S.set.margin, top=40, bot=38;
  S.W=Math.floor(window.innerWidth-2*m); S.H=Math.floor(window.innerHeight-top-bot);
  if(isScroll()){
    viewport.style.cssText=`left:0;top:${top}px;width:100%;height:${S.H}px;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 ${m}px`;
    content.style.width=S.W+'px'; content.style.height='auto';
    content.style.columnWidth='auto'; content.style.columnGap='normal'; content.style.transform='none';
    content.style.paddingBottom=Math.floor(S.H*0.4)+'px';
  } else {
    viewport.style.cssText=`left:${m}px;top:${top}px;width:${S.W}px;height:${S.H}px`;
    content.style.width=S.W+'px'; content.style.height=S.H+'px';
    content.style.columnWidth=S.W+'px'; content.style.columnGap=GAP+'px'; content.style.paddingBottom='0';
  }
}
function figSize(ar){ let w=S.W, h=w/ar; const mh=S.H*0.94; if(h>mh){ h=mh; w=h*ar; } return {w:Math.floor(w),h:Math.floor(h)}; }

function blockHTML(b,i){
  if(b.t==='h1'||b.t==='h2') return `<${b.t} data-i="${i}">${esc(b.text)}</${b.t}>`;
  if(b.t==='img'){ const {w,h}=figSize(b.ar); return `<div class="fig" data-i="${i}" data-p="${b.page}" style="width:${w}px;height:${h}px"></div>`; }
  if(b.t==='chip') return `<div class="chip" data-i="${i}" data-p="${b.page}">▣ Figure on page ${b.page+1}. Tap to see the original page.</div>`;
  const pt=i>0?S.blocks[i-1].t:'h1';
  return `<p data-i="${i}" class="${pt!=='p'?'first':''}${b.small?' small':''}">${esc(b.text)}</p>`;
}

let figToken=0;
async function drawFigs(){
  const tok=++figToken;
  for(const el of content.querySelectorAll('.fig')){
    if(tok!==figToken) return;
    try{
      const page=await S.pdf.getPage(+el.dataset.p+1);
      const dpr=Math.min(2,window.devicePixelRatio||1);
      const w=parseFloat(el.style.width);
      const vp=page.getViewport({scale:w*dpr/page.view[2]});
      const cv=document.createElement('canvas'); cv.width=Math.floor(vp.width); cv.height=Math.floor(vp.height);
      await page.render({canvasContext:cv.getContext('2d'), viewport:vp}).promise;
      if(tok!==figToken) return;
      el.innerHTML=''; el.appendChild(cv);
    }catch(e){}
  }
}

const offsetOf=el=>{ const r=el.getClientRects()[0]||el.getBoundingClientRect(); return r.left-content.getBoundingClientRect().left; };
function pageOfBlock(i){ const el=content.querySelector(`[data-i="${i}"]`); return el? Math.max(0,Math.floor((offsetOf(el)+2)/(S.W+GAP))) : 0; }
// Position = first block that STARTS on this page (+ page offset if a long paragraph fills the page).
function firstBlockOnPage(p){
  const step=S.W+GAP, base=content.getBoundingClientRect().left;
  let cand=null;
  for(const el of content.querySelectorAll('[data-i]')){
    const rs=[...el.getClientRects()].filter(r=>r.height>0); if(!rs.length) continue;
    const pages=rs.map(r=>Math.floor((r.left-base+2)/step));
    const start=pages[0];
    if(start===p) return {i:+el.dataset.i, off:0};
    if(start>p) break;
    if(pages.includes(p)) cand={i:+el.dataset.i, off:p-start};
  }
  return cand || {i:S.sec[S.si][0], off:0};
}

function renderSection(si,target={}){
  S.si=si; const [a,b]=S.sec[si];
  layoutDims();
  let html=''; for(let i=a;i<b;i++) html+=blockHTML(S.blocks[i],i);
  content.innerHTML=html+'<div id="endMark" style="height:1px"></div>';
  S.pages=Math.max(1, Math.floor((offsetOf($('endMark'))+2)/(S.W+GAP))+1);
  drawFigs();
  let p=0;
  if(target.block!=null) p=pageOfBlock(target.block)+(target.off||0);
  else if(target.last) p=S.pages-1;
  goPage(p);
}

let saveT=null;
function goPage(p){
  S.page=Math.max(0,Math.min(S.pages-1,p));
  content.style.transform=`translateX(${-S.page*(S.W+GAP)}px)`;
  const fb=firstBlockOnPage(S.page); S.pos=fb.i; S.off=fb.off;
  updateLabels();
  savePos();
}
function savePos(){ if(S.meta){ S.meta.pos=S.pos; S.meta.off=S.off; S.meta.pct=progress(); } clearTimeout(saveT); saveT=setTimeout(saveNow,400); }
function saveNow(){ clearTimeout(saveT); if(S.meta) return DB.put('meta',S.meta); }
document.addEventListener('visibilitychange',()=>{ if(document.hidden) saveNow(); });
window.addEventListener('pagehide',saveNow);
function progress(){ if(isScroll()){ const mx=viewport.scrollHeight-viewport.clientHeight; return mx>0? Math.min(1,viewport.scrollTop/mx) : 0; } const [a,b]=S.sec[S.si]; const s0=S.cum[a], s1=b<S.cum.length?S.cum[b]:S.total; return Math.min(1,(s0+(s1-s0)*(S.page/Math.max(1,S.pages)))/S.total); }
function chapterTitle(){ let t=''; for(const e of S.toc){ if(e.block<=S.pos) t=e.title; else break; } return t; }
function updateLabels(){
  const pc=Math.round(progress()*100);
  const left=S.pages-1-S.page;
  if(isScroll()) $('ftrL').textContent = `Loc ${S.pos+1} of ${S.blocks.length}`;
  else $('ftrL').textContent = left>0 ? `${left} page${left>1?'s':''} left in section` : 'Last page in section';
  $('ftrR').textContent = pc+'%';
  $('hdrR').textContent = '';
  $('hdrL').textContent = chapterTitle() || S.name;
  $('slider').value = Math.round(progress()*1000);
  $('botLbl').textContent = `${pc}% · Loc ${S.pos+1} of ${S.blocks.length} · PDF page ${(S.blocks[S.pos]||{page:0}).page+1}`;
}

function inkFlash(){
  if(S.set.flash!=='on') return;
  const f=$('flash'); f.style.transition='none'; f.style.opacity='.92';
  requestAnimationFrame(()=>requestAnimationFrame(()=>{ f.style.transition='opacity .18s ease-out'; f.style.opacity='0'; }));
}
function next(){ if(isScroll()){ viewport.scrollBy({top:S.H*0.9,behavior:'smooth'}); hideBars(); return; } inkFlash(); if(S.page<S.pages-1) goPage(S.page+1); else if(S.si<S.sec.length-1) renderSection(S.si+1); hideBars(); }
function prev(){ if(isScroll()){ viewport.scrollBy({top:-S.H*0.9,behavior:'smooth'}); hideBars(); return; } inkFlash(); if(S.page>0) goPage(S.page-1); else if(S.si>0) renderSection(S.si-1,{last:true}); hideBars(); }
function isScroll(){ return S.set.mode==='scroll'; }
function show(block,off){ if(isScroll()) renderScroll(block); else renderSection(secOf(block),{block,off}); }
function jump(block){ show(block,0); }

/* ---------- scroll mode ---------- */
function renderScroll(block){
  S.si=0; layoutDims();
  let html=''; for(let i=0;i<S.blocks.length;i++) html+=blockHTML(S.blocks[i],i);
  content.innerHTML=html;
  drawFigs();
  const el=content.querySelector(`[data-i="${block}"]`);
  viewport.scrollTop = el ? Math.max(0, el.offsetTop-6) : 0;
  onScroll();
}
function onScroll(){
  const els=content.children; if(!els.length) return;
  const st=viewport.scrollTop+8; let lo=0, hi=els.length-1;
  while(lo<hi){ const mid=(lo+hi+1)>>1; if(els[mid].offsetTop<=st) lo=mid; else hi=mid-1; }
  S.pos=+els[lo].dataset.i||0; S.off=0;
  updateLabels(); savePos();
}
let scrollRaf=0;
viewport.addEventListener('scroll',()=>{ if(!isScroll()||scrollRaf) return; scrollRaf=requestAnimationFrame(()=>{ scrollRaf=0; onScroll(); }); },{passive:true});

/* ---------- input ---------- */
let tx=null, ty=null, swipedAt=0;
const stage=$('stage');
stage.addEventListener('touchstart',e=>{ if(e.touches.length===1){ tx=e.touches[0].clientX; ty=e.touches[0].clientY; } },{passive:true});
stage.addEventListener('touchend',e=>{
  if(tx===null || isScroll()){ tx=null; return; } const t=e.changedTouches[0], dx=t.clientX-tx, dy=t.clientY-ty; tx=null;
  if(Math.abs(dx)>45 && Math.abs(dx)>Math.abs(dy)*1.4){ swipedAt=Date.now(); dx<0?next():prev(); }
});
stage.addEventListener('click',e=>{
  if(Date.now()-swipedAt<450) return;
  const sel=window.getSelection&&window.getSelection(); if(sel && String(sel).trim()) return;
  const fig=e.target.closest('.chip,.fig'); if(fig){ openOriginal(+fig.dataset.p); return; }
  const x=e.clientX/window.innerWidth;
  if(x<0.3) prev(); else if(x>0.7) next(); else toggleBars();
});
document.addEventListener('keydown',e=>{
  if($('reader').classList.contains('hidden')) return;
  if(!$('orig').classList.contains('hidden')){ if(e.key==='Escape') closeOriginal(); if(e.key==='ArrowRight') origGo(1); if(e.key==='ArrowLeft') origGo(-1); return; }
  if(e.key==='ArrowRight'||e.key===' '||e.key==='PageDown'){ e.preventDefault(); next(); }
  if(e.key==='ArrowLeft'||e.key==='PageUp'){ e.preventDefault(); prev(); }
});
let rz=null; window.addEventListener('resize',()=>{ clearTimeout(rz); rz=setTimeout(()=>{ if(!$('reader').classList.contains('hidden') && S.blocks.length) show(S.pos,S.off); },200); });

function toggleBars(){ const off=$('top').classList.contains('off'); $('top').classList.toggle('off',!off); $('bot').classList.toggle('off',!off); }
function hideBars(){ $('top').classList.add('off'); $('bot').classList.add('off'); }
function openSheet(id){ $('scrim').classList.remove('hidden'); $(id).classList.remove('hidden'); }
function closeSheets(){ $('scrim').classList.add('hidden'); $('sAa').classList.add('hidden'); $('sToc').classList.add('hidden'); }
$('scrim').onclick=closeSheets;
$('bLib').onclick=async()=>{ hideBars(); await saveNow(); $('reader').classList.add('hidden'); $('lib').classList.remove('hidden'); renderLibrary(); };
$('bAa').onclick=()=>openSheet('sAa');
$('bToc').onclick=()=>{
  const cur=S.toc.reduce((acc,e,k)=>e.block<=S.pos?k:acc,-1);
  $('tocList').innerHTML = S.toc.length ? S.toc.map((e,k)=>`<a class="d${Math.min(2,e.depth)}${k===cur?' cur':''}" data-b="${e.block}">${esc(e.title)}</a>`).join('') : '<p class="note">No chapters found in this PDF.</p>';
  openSheet('sToc');
};
$('tocList').onclick=e=>{ const a=e.target.closest('a'); if(!a) return; closeSheets(); hideBars(); jump(+a.dataset.b); };
$('slider').addEventListener('change',e=>{
  const target=e.target.value/1000*S.total; let i=0; while(i<S.cum.length-1 && S.cum[i+1]<=target) i++; jump(i);
});
$('sAa').addEventListener('click',e=>{
  const b=e.target.closest('button'); if(!b) return;
  if(b.dataset.a==='fs-') S.set.size=Math.max(13,S.set.size-1);
  else if(b.dataset.a==='fs+') S.set.size=Math.min(32,S.set.size+1);
  else { const g=b.closest('.seg'); if(!g||!g.dataset.k) return; S.set[g.dataset.k]=b.dataset.v; }
  applySettings();
});

/* ---------- original page view ---------- */
const O={page:0, zoom:1, task:null};
$('bOrig').onclick=()=>openOriginal((S.blocks[S.pos]||{page:0}).page);
function openOriginal(p){ O.page=p; O.start=p; O.zoom=1; $('orig').classList.remove('hidden'); renderOrig(); }
function closeOriginal(){
  $('orig').classList.add('hidden');
  if(O.page!==O.start && S.blocks.length){ const i=S.blocks.findIndex(b=>b.page>=O.page); if(i>=0) jump(i); }
  else if(!S.blocks.length){ $('bLib').onclick(); }
}
function origGo(d){ O.page=Math.max(0,Math.min(S.pdf.numPages-1,O.page+d)); renderOrig(); }
async function renderOrig(){
  $('oLbl').textContent=`Page ${O.page+1} of ${S.pdf.numPages}`;
  try{
    if(O.task){ try{ O.task.cancel(); }catch(e){} }
    const page=await S.pdf.getPage(O.page+1);
    const dpr=Math.min(2.5,window.devicePixelRatio||1);
    const fit=($('oScroll').clientWidth-16)/page.view[2];
    const vp=page.getViewport({scale:fit*O.zoom*dpr});
    const cv=$('oCan'); cv.width=Math.floor(vp.width); cv.height=Math.floor(vp.height);
    cv.style.width=Math.floor(vp.width/dpr)+'px'; cv.style.height=Math.floor(vp.height/dpr)+'px';
    O.task=page.render({canvasContext:cv.getContext('2d'), viewport:vp});
    await O.task.promise;
  }catch(e){}
}
$('oBack').onclick=closeOriginal;
$('oPrev').onclick=()=>origGo(-1); $('oNext').onclick=()=>origGo(1);
$('oZi').onclick=()=>{ O.zoom=Math.min(4,O.zoom*1.4); renderOrig(); };
$('oZo').onclick=()=>{ O.zoom=Math.max(0.6,O.zoom/1.4); renderOrig(); };

/* ---------- extension extras ---------- */
if(window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc='pdf.worker.min.js';   // real background worker
document.addEventListener('dragover',e=>{ e.preventDefault(); });
document.addEventListener('drop',e=>{
  e.preventDefault();
  const f=[...(e.dataTransfer&&e.dataTransfer.files||[])].find(x=>/\.pdf$/i.test(x.name)||x.type==='application/pdf');
  if(!f) return;
  const dt=new DataTransfer(); dt.items.add(f); $('file').files=dt.files; $('file').dispatchEvent(new Event('change'));
});

/* ---------- boot ---------- */
applySettings(false);
renderLibrary();
if(!window.pdfjsLib){ alertBox('The PDF engine did not load. Check your connection and reload.'); }
