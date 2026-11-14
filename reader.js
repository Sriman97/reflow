/* ==CORE-START== : PDF → reflowable blocks */
const CORE_VERSION = 21;

function median(a){ if(!a.length) return 0; const b=[...a].sort((x,y)=>x-y); return b[b.length>>1]; }
function pct(a,p){ if(!a.length) return 0; const b=[...a].sort((x,y)=>x-y); return b[Math.min(b.length-1,Math.floor(p*b.length))]; }

// Read text positions and figure hints from every page.
// safe=true skips the drawing operators and links (used if a page fails on this device).
const EXTRACT_ERRORS=[];
const errText = (e,where) => `${where}: ${e&&e.name||'Error'}: ${e&&e.message||e}` + (e&&e.stack ? ' @ '+String(e.stack).split('\n').slice(0,4).join(' / ') : '');
async function plainPage(pdf,i){   // fallback: text only, no styles, figures or links
  const page=await pdf.getPage(i); const v=Array.from(page.view||[0,0,612,792]);
  const tc=await page.getTextContent(); const items=[];
  for(const it of tc.items||[]){
    if(!it.str || !it.str.trim()) continue;
    const t=Array.from(it.transform||[]); if(t.length<6) continue;
    const size=Math.hypot(t[2],t[3])||it.height||10;
    items.push({s:it.str, x:t[4]-v[0], y:t[5]-v[1], w:it.width||0, size});
  }
  page.cleanup();
  return {w:v[2]-v[0], h:v[3]-v[1], items, fig:false, figs:[]};
}
async function extractPages(pdf, onProg, safe){
  const OPS = pdfjsLib.OPS, pages=[];
  EXTRACT_ERRORS.length=0;
  const onePage = async (i)=>{
    const page = await pdf.getPage(i);
    const [vx0,vy0,vx1,vy1] = Array.from(page.view);
    let ol=null; if(!safe) try{ ol = await page.getOperatorList(); }catch(e){ RLOG.warn('drawing ops p'+i, e); }   // also loads fonts (for bold detection)
    const tc = await page.getTextContent();
    const boldOf=Object.create(null);
    const isBold = fn => {
      if(fn in boldOf) return boldOf[fn];
      let bo=false;
      try{ if(page.commonObjs.has(fn)){ const f=page.commonObjs.get(fn); bo=!!(f.bold||f.black||/bold|black|heavy|semibold|demi/i.test(f.name||'')); } }catch(e){}
      try{ const st=tc.styles&&tc.styles[fn]; if(st && /bold|black|heavy/i.test(st.fontFamily||'')) bo=true; }catch(e){}
      return boldOf[fn]=bo;
    };
    const monoOf=Object.create(null);
    const isMono = fn => {
      if(fn in monoOf) return monoOf[fn];
      let r=false;
      try{ if(page.commonObjs.has(fn)){ const f=page.commonObjs.get(fn); r=/mono|courier|consol|menlo|inconsolata|typewriter|sourcecode|code|fixed|lettergothic|andale/i.test(f.name||''); } }catch(e){}
      try{ const st=tc.styles&&tc.styles[fn]; if(st && /monospace/i.test(st.fontFamily||'')) r=true; }catch(e){}
      return monoOf[fn]=r;
    };
    const italOf=Object.create(null);
    const isItal = fn => {
      if(fn in italOf) return italOf[fn];
      let r=false;
      try{ if(page.commonObjs.has(fn)){ const f=page.commonObjs.get(fn); r=!!(f.italic||/italic|oblique|-it$|-ital/i.test(f.name||'')); } }catch(e){}
      try{ const st=tc.styles&&tc.styles[fn]; if(st && /italic|oblique/i.test(st.fontFamily||'')) r=true; }catch(e){}
      return italOf[fn]=r;
    };
    const items=[];
    for(const it of tc.items){
      if(!it.str || !it.str.trim()) continue;
      const [a,b,c,d,e,f] = Array.from(it.transform||[]);
      if(f===undefined) continue;
      if(Math.abs(b) > 0.05*Math.abs(a) || a<=0) continue;          // skip rotated text
      const size = Math.hypot(c,d) || it.height;
      if(size < 1) continue;
      items.push({s:it.str, x:e-vx0, y:f-vy0, w:it.width, size, b:isBold(it.fontName), i:isItal(it.fontName)||Math.abs(c)>0.12*Math.abs(d), m:isMono(it.fontName)||undefined});
    }
    // Links (footnote references, cross-references, web links).
    const links=[];
    try{
      const an = safe ? [] : await page.getAnnotations({intent:'display'});
      for(const a of an){
        if(a.subtype!=='Link' || !a.rect) continue;
        let key=null;
        if(a.url && /^(https?:|mailto:)/i.test(a.url)) key='u:'+a.url;
        else if(a.dest){
          try{
            let d=a.dest; if(typeof d==='string') d=await pdf.getDestination(d);
            if(Array.isArray(d) && d[0]!=null){
              const tp = typeof d[0]==='object' ? await pdf.getPageIndex(d[0]) : d[0];
              const kind=d[1]&&d[1].name; let ty=null;
              if(kind==='XYZ') ty=d[3]; else if(kind==='FitH'||kind==='FitBH') ty=d[2];
              key='p:'+tp+':'+(typeof ty==='number' ? Math.round(ty-vy0) : '');
            }
          }catch(e){}
        }
        if(key) links.push({x0:Math.min(a.rect[0],a.rect[2])-vx0-1, x1:Math.max(a.rect[0],a.rect[2])-vx0+1, y0:Math.min(a.rect[1],a.rect[3])-vy0-1, y1:Math.max(a.rect[1],a.rect[3])-vy0+1, key});
      }
    }catch(e){}
    if(links.length) for(const it of items){
      const cy=it.y+it.size*0.3;
      for(const L of links){
        if(cy<L.y0 || cy>L.y1) continue;
        const ov=Math.min(it.x+it.w,L.x1)-Math.max(it.x,L.x0);
        if(ov > Math.max(1,it.w)*0.6){ it.lk=L.key; break; }
      }
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
    let figs=[];
    if(ol) try{ figs=findFigures(ol, items, vx0, vy0, vx1-vx0, vy1-vy0); }catch(e){ for(const it of items) delete it.f; EXTRACT_ERRORS.push(errText(e,'figures p'+i)); }
    page.cleanup();
    return {w:vx1-vx0, h:vy1-vy0, items, fig, figs};
  };
  for(let i=1;i<=pdf.numPages;i++){
    try{ pages.push(await onePage(i)); }
    catch(e){ EXTRACT_ERRORS.push(errText(e,'page '+i)); try{ pages.push(await plainPage(pdf,i)); }catch(e2){ pages.push({w:612,h:792,items:[],fig:false,figs:[]}); } }
    if(onProg) await onProg(i, pdf.numPages);
  }
  return pages;
}

// Find tables, charts and pictures on a page: boxes of images and vector drawings,
// merged into regions, plus the small label text inside or next to them.
function findFigures(ol, items, vx0, vy0, pw, ph){
  const O=pdfjsLib.OPS;
  const mul=(m,n)=>[m[0]*n[0]+m[2]*n[1], m[1]*n[0]+m[3]*n[1], m[0]*n[2]+m[2]*n[3], m[1]*n[2]+m[3]*n[3], m[0]*n[4]+m[2]*n[5]+m[4], m[1]*n[4]+m[3]*n[5]+m[5]];
  const pt=(m,x,y)=>[m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]];
  let ctm=[1,0,0,1,0,0]; const stack=[], boxes=[];
  const add=(m,xa,ya,xb,yb,img)=>{
    const q=[pt(m,xa,ya),pt(m,xb,ya),pt(m,xa,yb),pt(m,xb,yb)];
    const b={x0:Math.min(...q.map(v=>v[0]))-vx0, y0:Math.min(...q.map(v=>v[1]))-vy0, x1:Math.max(...q.map(v=>v[0]))-vx0, y1:Math.max(...q.map(v=>v[1]))-vy0, img};
    const w=b.x1-b.x0, h=b.y1-b.y0;
    if(!(w>=0&&h>=0) || w*h > pw*ph*0.85) return;            // page backgrounds
    if(img && w*h < 600) return;                               // tiny icons, glyph masks
    b.n=1; boxes.push(b);
  };
  for(let k=0;k<ol.fnArray.length;k++){
    const fn=ol.fnArray[k], a=ol.argsArray[k];
    if(fn===O.save) stack.push(ctm);
    else if(fn===O.restore) ctm=stack.pop()||ctm;
    else if(fn===O.transform) ctm=mul(ctm,a);
    else if(fn===O.paintFormXObjectBegin){ stack.push(ctm); if(a&&a[0]) ctm=mul(ctm,a[0]); }
    else if(fn===O.paintFormXObjectEnd) ctm=stack.pop()||ctm;
    else if(fn===O.paintImageXObject||fn===O.paintInlineImageXObject||fn===O.paintImageXObjectRepeat||fn===O.paintJpegXObject) add(ctm,0,0,1,1,true);
    else if(fn===O.constructPath && a && a[2]) add(ctm,a[2][0],a[2][1],a[2][2],a[2][3],false);
  }
  if(!boxes.length) return [];
  // Merge boxes that touch or nearly touch.
  const near=(a,b,g)=>a.x0-g<=b.x1 && b.x0-g<=a.x1 && a.y0-g<=b.y1 && b.y0-g<=a.y1;
  let rs=boxes.map(b=>({...b}));
  for(let changed=true; changed;){
    changed=false;
    for(let i=0;i<rs.length && !changed;i++) for(let j=i+1;j<rs.length;j++) if(near(rs[i],rs[j],10)){
      const a=rs[i], b=rs[j]; rs[i]={x0:Math.min(a.x0,b.x0),y0:Math.min(a.y0,b.y0),x1:Math.max(a.x1,b.x1),y1:Math.max(a.y1,b.y1),img:a.img||b.img,n:a.n+b.n};
      rs.splice(j,1); changed=true; break;
    }
  }
  // Keep real figures, not text underlines or lone rules.
  rs=rs.filter(r=>{
    const w=r.x1-r.x0, h=r.y1-r.y0;
    const edge = r.x0<3 || r.y0<3 || r.x1>pw-3 || r.y1>ph-3;          // page decorations, bleeds
    if(r.img) return w*h>2500 && !(edge && w*h<pw*ph*0.05);
    return !edge && r.n>=6 && w>40 && h>30;                              // a drawing has many strokes
  });
  // A frame around paragraphs or a code listing is not a figure: it is mostly text.
  rs=rs.filter(r=>{
    let chars=0;
    for(const it of items){ const cx=it.x+it.w/2, cy=it.y+it.size*0.35; if(cx>=r.x0&&cx<=r.x1&&cy>=r.y0&&cy<=r.y1) chars+=it.s.trim().length; }
    const area=(r.x1-r.x0)*(r.y1-r.y0);
    return chars < 260 && chars < area/90;
  });
  if(!rs.length) return [];
  // Text inside the region, and small label text right next to it, belongs to the figure.
  const sizes=items.map(it=>it.size).sort((a,b)=>a-b); const bodyGuess=sizes[sizes.length>>1]||10;
  for(const r of rs){
    for(let pass=0;pass<4;pass++){
      let grew=false;
      for(const it of items){
        if(it.f) continue;
        const cx=it.x+it.w/2, cy=it.y+it.size*0.35;
        const inside = cx>=r.x0-2 && cx<=r.x1+2 && cy>=r.y0-2 && cy<=r.y1+2;
        const label = it.size < bodyGuess*0.93 && it.x+it.w>=r.x0-36 && it.x<=r.x1+36 && cy>=r.y0-24 && cy<=r.y1+24;
        if(inside || label){
          it.f=1;
          const nx0=Math.min(r.x0,it.x), nx1=Math.max(r.x1,it.x+it.w), ny0=Math.min(r.y0,it.y-it.size*0.3), ny1=Math.max(r.y1,it.y+it.size*0.9);
          if(nx0<r.x0||nx1>r.x1||ny0<r.y0||ny1>r.y1){ r.x0=nx0; r.x1=nx1; r.y0=ny0; r.y1=ny1; grew=true; }
        }
      }
      if(!grew) break;
    }
  }
  return rs.map(r=>({x0:Math.max(0,r.x0-4), y0:Math.max(0,r.y0-4), x1:Math.min(pw,r.x1+4), y1:Math.min(ph,r.y1+4)}));
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

// Inline style markers: \uE000/\uE001 italic, \uE002/\uE003 bold.
// \uE006key\uE007 … \uE008 link, \uE009/\uE00A superscript, \uE00B/\uE00C subscript.
const MARKS=/\uE006[^\uE007]*\uE007|[\uE000-\uE00E]/g;
function collapseMarks(r){ return r.replace(/\uE00E(\s*)\uE00D/g,'$1').replace(/\uE001(\s*)\uE000/g,'$1').replace(/\uE003(\s*)\uE002/g,'$1').replace(/\uE000(\s*)\uE001/g,'$1').replace(/\uE002(\s*)\uE003/g,'$1').replace(/\uE00A\uE009/g,'').replace(/\uE00C\uE00B/g,''); }

// Group text items into lines (same baseline), left to right.
function itemsToLines(items){
  // Width of one monospace character (for code indentation).
  const cws=items.filter(it=>it.m && it.s.length>=3 && it.w>0).map(it=>it.w/it.s.length);
  const cw = median(cws) || 0;
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
    let t='', raw='', lastX1=null, boldC=0, allC=0, monoC=0; const cnt={};
    for(const it of L.items){ const n=it.s.trim().length; allC+=n; if(it.b) boldC+=n; if(it.m) monoC+=n; }
    L.bold = allC>0 && boldC/allC > 0.6;
    L.mono = allC>0 && monoC/allC > 0.8;
    if(L.mono){   // code: place each piece at its character column
      const w = cw || (L.size*0.6); let code='', end=null;
      for(const it of L.items){
        const col=Math.max(0,Math.round((it.x-L.items[0].x)/w));
        if(code.length<col) code+=' '.repeat(col-code.length);
        else if(end!==null && it.x-end > w*0.5 && !/\s$/.test(code) && !/^\s/.test(it.s)) code+=' ';
        code+=it.s; end=it.x+it.w;
      }
      L.code=code.replace(/\s+$/,''); L.cw=w;
    }
    // Baseline and size of the main text of the line (for superscripts).
    const sz={}; for(const it of L.items){ const k=Math.round(it.size*2)/2; sz[k]=(sz[k]||0)+it.s.length; }
    const mainSize=+Object.entries(sz).sort((a,b)=>b[1]-a[1])[0][0];
    const baseY=median(L.items.filter(it=>Math.abs(it.size-mainSize)<0.6).map(it=>it.y));
    let curLk=null;
    for(const it of L.items){
      const lk=it.lk||null;
      if(curLk && lk!==curLk){ raw+='\uE008'; curLk=null; }   // close a link before the space that follows it
      if(lastX1!==null){
        const gap=it.x-lastX1;
        if(gap > it.size*0.15 && !/\s$/.test(t) && !/^\s/.test(it.s)){ t+=' '; raw+=' '; }
      }
      t+=it.s;
      let piece = it.i ? '\uE000'+it.s+'\uE001' : (it.b && !L.bold ? '\uE002'+it.s+'\uE003' : it.s);
      if(it.m && !L.mono) piece='\uE00D'+piece+'\uE00E';
      const small = it.size < mainSize*0.92;
      if(small && it.y-baseY > mainSize*0.15) piece='\uE009'+piece+'\uE00A';
      else if(small && baseY-it.y > mainSize*0.1) piece='\uE00B'+piece+'\uE00C';
      if(lk && lk!==curLk){ raw+='\uE006'+lk+'\uE007'; curLk=lk; }
      raw += piece;
      lastX1 = Math.max(lastX1===null?-1e9:lastX1, it.x+it.w);
      const k=Math.round(it.size*2)/2; cnt[k]=(cnt[k]||0)+it.s.length;
    }
    if(curLk) raw+='\uE008';
    L.raw=collapseMarks(raw.replace(/\s+/g,' ')).trim();
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
    const textItems = pg.items.filter(it=>!it.f);
    pg.cols = splitColumns(textItems, pg.w).map(itemsToLines).map(c=>c.filter(L=>!/^(\d*B\d{2,}){2,}\s*$/.test(L.text)));
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
  const edgeCnt=Object.create(null), prefCnt=Object.create(null);
  const pref = t => norm(t).replace(/[^a-z#]/g,'').slice(0,14);   // running heads that change per section share a prefix
  for(const pg of pages){ pg.edges=edgeLines(pg); const seen=new Set(); for(const L of pg.edges){ const n=norm(L.text); if(!seen.has(n)){ seen.add(n); edgeCnt[n]=(edgeCnt[n]||0)+1; } const q=pref(L.text); if(q.length>=10 && !seen.has('p:'+q)){ seen.add('p:'+q); prefCnt[q]=(prefCnt[q]||0)+1; } } }
  const thr=Math.max(3, pages.length*0.12);
  for(const pg of pages) for(const L of pg.edges){
    const n=norm(L.text);
    if(edgeCnt[n]>=thr || ((prefCnt[pref(L.text)]||0)>=4 && !L.bold && L.size<=body*1.05) || /^(\d*B\d{2,}){2,}\s*$/.test(L.text) || (edgeCnt[n]>=3 && !near(L.size) && L.size<body) || /^(page )?#( of #)?$/.test(n) || (/^[ivxlc]+$/.test(n) && n.length<=5 && L.text.length<=5)) L.drop=true;
  }

  // Typical line spacing (in units of body size).
  const ratios=[];
  for(const pg of pages) for(const c of pg.cols) for(let i=1;i<c.length;i++){
    const a=c[i-1], b=c[i];
    if(near(a.size)&&near(b.size)){ const r=(a.y-b.y)/body; if(r>0.6&&r<4) ratios.push(r); }
  }
  const lead = median(ratios) || 1.25;

  const blocks=[]; let cur=null; const pendingFigs=[];
  const terminal=/[.!?:"”’»)\]](\d{1,3}|[*†‡])?$/;   // allow a trailing footnote number
  const flush=()=>{
    if(cur && cur.t==='pre'){   // lay out code lines with their indentation
      const ls=cur.ls; while(ls.length && ls[ls.length-1]===null) ls.pop();
      const real=ls.filter(Boolean), minX=Math.min(...real.map(l=>l.x)), cw=median(real.map(l=>l.cw))||6;
      cur.text=ls.map(l=>l? ' '.repeat(Math.max(0,Math.round((l.x-minX)/cw)))+l.t : '').join('\n');
      cur.box=cur.box.map(v=>Math.round(v)); delete cur.ls; delete cur.lh;
      if(cur.text.trim()) blocks.push(cur);
      cur=null;
    }
    if(cur){
      const head = cur.t==='h1'||cur.t==='h2';
      const txt = head ? cur.text.trim() : collapseMarks(cur.raw||'').trim();
      if(cur.text.trim()){ cur.text=txt; delete cur.raw; delete cur.x; delete cur.n; delete cur.hang; blocks.push(cur); }
      cur=null;
    }
    while(pendingFigs.length) blocks.push(pendingFigs.shift());
  };
  const append=(L,t=L.text,r=L.raw)=>{
    if(cur.raw===undefined) cur.raw='';
    if(cur.y0===undefined) cur.y0=Math.round(L.y+L.size*0.8);
    cur.n=(cur.n||0)+1;
    if(!cur.text){ cur.text=t; cur.raw=r; return; }
    if((/[A-Za-zÀ-ɏ]-$/.test(cur.text) && /^[a-zß-ÿ]/.test(t)) || /[­¬]$/.test(cur.text)){
      cur.text=cur.text.slice(0,-1)+t;
      cur.raw=cur.raw.replace(/[-­¬]([\uE000-\uE005\uE008-\uE00C]*)$/,'$1')+r;
    } else { cur.text+=' '+t; cur.raw+=' '+r; }
  };
  const listRe=/^(\(?\d{1,3}[.)]|\(?[a-h][.)]|\(?[A-H]\)|\(?[ivx]{1,4}[.)]|\([ivxlc]{1,5}\)|[•●▪◦■‣⁃○–—-])\s+(?=\S)/;

  // Typical first-line paragraph indent (from body lines).
  const offs=[];
  for(const pg of pages) for(const c of pg.cols){
    const ref=c.filter(L=>!L.drop && near(L.size)); if(ref.length<3) continue;
    const lf=pct(ref.map(L=>L.x0),0.15);
    for(const L of ref){ const o=L.x0-lf; if(o>body*0.6 && o<body*4) offs.push(o); }
  }
  const paraIndent = median(offs) || body*1.5;

  const chapRe=/^(chapter|part|book|appendix|prologue|epilogue|introduction|preface|foreword|afterword|conclusion|epigraph|acknowledg\w*|bibliography|glossary|index|contents)\b/i;
  const numRe=/^((chapter|part|book|section)\s+)?([0-9]{1,3}|[ivxlc]{1,7}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty[\w-]*|thirty[\w-]*|forty[\w-]*|fifty[\w-]*)\.?$/i;
  const words = t => t.split(' ').length;
  const headish = L => L.text.length<=90 && words(L.text)<=14 && !/[,;]$/.test(L.text) && !/[a-z]{2}\.$/.test(L.text);
  let prevPageEnd = 1;   // y/h of the last line on the previous text page (0 = bottom)

  const figBlock=(pg,pi,r)=>({t:'fig', page:pi, box:[r.x0,r.y0,r.x1,r.y1].map(v=>Math.round(v*10)/10), pw:Math.round(pg.w), ph:Math.round(pg.h)});
  pages.forEach((pg,pi)=>{
    let textChars=0, firstOfPage=true;
    const figQ = (pg.figs||[]).slice().sort((a,b)=>b.y1-a.y1);
    const placeFigs = (L)=>{   // figures that start above this line go into the flow here
      while(figQ.length && (!L || figQ[0].y1 > L.y + L.size)){
        const fb=figBlock(pg,pi,figQ.shift());
        if(cur && cur.t==='p' && L && !terminal.test(cur.text)) pendingFigs.push(fb);   // inside a paragraph: after it
        else { flush(); blocks.push(fb); }
      }
    };
    const cols=pg.cols.map(c=>c.filter(L=>!L.drop));
    const firstL=(cols.find(c=>c.length)||[])[0];
    const sink = firstL ? (pg.h-firstL.y)/pg.h : 0;
    const allL=cols.flat();
    const tocPage = cols.some(c=>c.some(L=>/^(table of )?contents$|^index$/i.test(L.text.trim())))
      || (allL.length>=8 && allL.filter(L=>/\s(\d{1,4}|[ivxlc]{1,6})$/.test(L.text)).length > allL.length*0.6);   // lines ending in page numbers
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
        if(figQ.length) placeFigs(L);
        textChars+=L.text.length;
        const rel=L.size/body;
        const gapB = prev ? (prev.y-L.y)/body : 99, gapA = nx ? (L.y-nx.y)/body : 99;
        const alone = gapB>lead*1.3 && gapA>lead*1.3;
        firstOfPage=false;
        if(L.mono && !tocPage){
          const contCode = cur && cur.t==='pre' && ((prev && gapB>=0 && (prev.y-L.y) < L.size*4) || (!prev && cur.page===pi-1));
          if(!contCode){ flush(); cur={t:'pre', text:'x', page:pi, ls:[], box:[L.x0,L.y-L.size*0.3,L.x1,L.y+L.size]}; }
          else if(prev && cur.page===pi){
            const step=cur.lh||L.size*1.15, blanks=Math.round((prev.y-L.y)/step)-1;
            for(let k=0;k<Math.min(blanks,2);k++) cur.ls.push(null);
          }
          if(prev && cur.page===pi && (prev.y-L.y) > 0 && (prev.y-L.y) < L.size*1.6) cur.lh=Math.min(cur.lh||99, prev.y-L.y);
          cur.ls.push({x:L.x0, t:L.code, cw:L.cw});
          if(cur.page===pi){ const b=cur.box; b[0]=Math.min(b[0],L.x0); b[1]=Math.min(b[1],L.y-L.size*0.3); b[2]=Math.max(b[2],L.x1); b[3]=Math.max(b[3],L.y+L.size); }
          prev=L; continue;
        }
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
          else if(isHead && !cur.text.includes(': ') && dist < Math.max(L.size,prev.size)*4 && (numRe.test(cur.text) || (chapRe.test(cur.text) && words(cur.text)<=3))){ cur.text+=': '+L.text; cur.raw+=': '+L.raw; cur.t='h1'; }
          else { flush(); cur={t:kind,text:'',page:pi}; append(L); }
          prev=L; continue;
        }
        // Lists, indented blocks, centered lines.
        const off=L.x0-left;
        const gapOK = prev && gapB <= lead*1.45 && gapB >= 0;
        const prevEnded = !prev || !gapOK || terminal.test(prev.text) || prev.x1 < right - body*2;
        const hyphenCont = prev && gapOK && /[A-Za-z]-$/.test(prev.text) && /^[a-z]/.test(L.text);
        const lm = !hyphenCont && (L.text.match(listRe) || L.text.match(/^(\d{1,3}\.)(?=[A-Z“"‘(\[])/));
        const lvlOf = o => o < body*0.8 ? 0 : (o < paraIndent + body*2.4 ? 1 : 2);
        if(lm && prevEnded){
          flush();
          const mk=lm[1], at=L.raw.indexOf(mk);
          const mkl = (L.raw.match(/^\uE006([^\uE007]*)\uE007/)||[])[1];   // note number that links back to the text
          const rest = at>=0 ? (L.raw.slice(0,at)+L.raw.slice(at+mk.length)).replace(/^([\uE000-\uE005\uE009-\uE00C]*)\s+/,'$1') : L.text.slice(lm[0].length);
          cur={t:'li', mk, lvl:lvlOf(off), x:L.x0, text:'', page:pi}; if(mkl) cur.mkl=mkl;
          append(L, L.text.slice(lm[0].length).trimStart(), rest.replace(/^\uE006[^\uE007]*\uE007\uE008/,'').trimStart());
          prev=L; continue;
        }
        const pageStart = !prev && cur && cur.page<pi && !terminal.test(cur.text);
        if(cur && cur.t==='li' && !lm && ((gapOK && L.x0 > cur.x - body*0.4 && !(prev.x1 < right - body*2.5 && terminal.test(prev.text) && L.x0 > cur.x + body*1.2)) || (pageStart && L.x0 > cur.x + body*0.4))){
          append(L); prev=L; continue;
        }
        const centered = (L.x1-L.x0) < colW*0.72 && off > body*2 && (right-L.x1) > body*2 && Math.abs((L.x0+L.x1)/2-(left+right)/2) < body*1.2 && L.text.length < 80;
        if(centered && !hyphenCont){
          if(cur && cur.t==='c' && gapOK){ cur.text+='\n'+L.text; cur.raw+='\n'+L.raw; }
          else { flush(); cur={t:'c', text:'', page:pi}; append(L); }
          prev=L; continue;
        }
        const deep = off > paraIndent + body*0.8 && off < colW*0.6;
        if(deep || (cur && cur.t==='q' && gapOK && L.x0 > cur.x - body*1.5 && !prevEnded)){
          const cont = cur && cur.t==='q' && gapOK && (hyphenCont || (!prevEnded && L.x0 <= cur.x + body*0.6) || (Math.abs(L.x0-cur.x) < body*0.6 && !(prev.x1 < right - body*2.5 && terminal.test(prev.text))));
          if(cont && prev && prev.x1 < right - body*4 && Math.abs(L.x0-cur.x) < body*0.6 && !hyphenCont){ cur.text+='\n'+L.text; cur.raw+='\n'+L.raw; cur.n++; }
          else if(cont){ append(L); cur.x=Math.min(cur.x,L.x0); }
          else { flush(); cur={t:'q', lvl:lvlOf(off)>=2?2:1, x:L.x0, text:'', page:pi}; append(L); }
          prev=L; continue;
        }
        if(cur && cur.t==='q' && cur.n===1 && gapOK && off < body*0.5 && !prevEnded){
          cur.t='p'; cur.ind=1; delete cur.lvl; append(L); prev=L; continue;   // chapter openers: deep first line, then normal text
        }
        let brk=false;
        if(!cur || cur.t!=='p') brk=true;
        else if(hyphenCont) brk=false;
        else if(prev){
          if(gapB > lead*1.45 || gapB < 0) brk=true;
          else if(indented(L) && terminal.test(prev.text)) brk=true;
          else if(indented(L) && prev.x1 > right - body*1.5 && !cur.hang && cur.n>1) brk=true;
          else if(indented(L)){ cur.hang=1; }
          else if(prev.x1 < right - body*2.5 && terminal.test(prev.text)) brk=true;
          else if(prev.x1 < right - colW*0.35) brk=true;
          else if(!!cur.small !== (L.size < body*0.85)) brk=true;
        } else {
          if(indented(L) || (terminal.test(cur.text) && !/^[a-z]/.test(L.text))) brk=true;
        }
        if(brk){ flush(); cur={t:'p',text:'',page:pi}; if(indented(L)) cur.ind=1; if(L.size < body*0.85) cur.small=true; }
        append(L); prev=L;
      }
    }
    const lastCol=[...cols].reverse().find(c=>c.length);
    if(lastCol) prevPageEnd = lastCol[lastCol.length-1].y/pg.h;
    if(pg.fig && textChars < 60 && !(pg.figs||[]).length){ flush(); blocks.push({t:'img', page:pi, ar:pg.w/pg.h}); prevPageEnd=1; }
    else {
      while(figQ.length) pendingFigs.push(figBlock(pg,pi,figQ.shift()));          // figures below the last line
      if(pg.fig && !(pg.figs||[]).length) pendingFigs.push({t:'chip', page:pi});   // could not locate it: link to the page
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
  // Failures are logged, then the app carries on without storage (it still works for this visit).
  put(s,v){ return this.run(s,'readwrite',o=>o.put(v)).catch(e=>{ RLOG.error('storage save '+s, e, {notify:s!=='cache'}); return null; }); },
  get(s,id){ return this.run(s,'readonly',o=>o.get(id)).catch(e=>{ RLOG.error('storage read '+s, e); return null; }); },
  all(s){ return this.run(s,'readonly',o=>o.getAll()).catch(e=>{ RLOG.error('storage list '+s, e, {notify:true}); return []; }); },
  del(s,id){ return this.run(s,'readwrite',o=>o.delete(id)).catch(e=>{ RLOG.error('storage delete '+s, e); return null; }); }
};
const LS={ get(k,d){ try{ const v=localStorage.getItem(k); return v?JSON.parse(v):d; }catch(e){ return d; } }, set(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch(e){ RLOG.warn('localStorage save '+k, e); } } };

/* ---------- state ---------- */
const $=id=>document.getElementById(id);
const GAP=60;
const FONTS={serif:"'Literata',Georgia,serif", georgia:"Georgia,'Times New Roman',serif", sans:"'Inter',system-ui,sans-serif"};
const S={ id:null, name:'', pdf:null, blocks:[], toc:[], cum:[], total:1, sec:[], si:0, page:0, pages:1, pos:0, W:300, H:500, meta:null,
  set:Object.assign({size:19,font:'serif',lh:'1.55',margin:'24',align:'justify',theme:'light',flash:'off',mode:'pages',dict:'app'}, LS.get('reflow.settings',{})) };
const content=$('content'), viewport=$('viewport');

function showLoading(msg,frac){ $('load').classList.remove('hidden'); $('loadMsg').textContent=msg; $('loadBar').style.width=((frac||0)*100)+'%'; }
function hideLoading(){ $('load').classList.add('hidden'); }
function esc(s){ return s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
// Text with inline markers -> safe HTML (italic, bold, code, sup, sub, links).
function fmt(t){
  let out='', it=0, bo=0, su=0, sb=0, ln=0, cd=0;
  const re=/([^]*)|[--]|[^-]+/g; let m;
  const TAG=Object.assign(Object.create(null),{'':['em',1],'':['em',0],'':['strong',1],'':['strong',0],'':['sup',1],'':['sup',0],'':['sub',1],'':['sub',0],'':['code',1],'':['code',0]});
  const open={em:0,strong:0,sup:0,sub:0,code:0};
  while((m=re.exec(t))){
    const c=m[0];
    if(m[1]!==undefined){
      if(ln) out+='</a>';
      const k=m[1];
      if(k.startsWith('u:') && /^(https?:|mailto:)/i.test(k.slice(2))) out+=`<a class="xl" href="${esc(k.slice(2))}" target="_blank" rel="noopener">`;
      else out+=`<a class="il" data-to="${esc(k.slice(2))}">`;
      ln=1; continue;
    }
    if(c===''){ if(ln){ out+='</a>'; ln=0; } continue; }
    const tg = c.length===1 ? TAG[c] : undefined;   // text like "toString" must never hit a lookup table
    if(tg){ const [name,on]=tg; if(on && !open[name]){ out+=`<${name}>`; open[name]=1; } else if(!on && open[name]){ out+=`</${name}>`; open[name]=0; } continue; }
    if(c.length===1 && c>='' && c<='') continue;
    out+=esc(c).replace(/\n/g,'<br>');
  }
  for(const name of ['code','sub','sup','strong','em']) if(open[name]) out+=`</${name}>`;
  if(ln) out+='</a>';
  return out;
}
const plain = t => (t||'').replace(/\uE006[^\uE007]*\uE007|[\uE000-\uE00E]/g,'');

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
  RLOG.step('library: open '+RLOG.tag(id));
  showLoading('Opening…',0);
  try{
    const rec=await DB.get('books',id);
    const m=await DB.get('meta',id);
    let buf=null;
    if(rec && rec.data) buf=rec.data;
    else if(rec && rec.blob){ try{ buf=await rec.blob.arrayBuffer(); }catch(err){ buf=null; } }
    if(!buf || !buf.byteLength){ RLOG.error('library open', 'saved PDF missing for '+RLOG.tag(id)+' (record: '+(rec?Object.keys(rec).join(','):'none')+')'); alertBox('This browser did not keep the PDF file. Tap "Open a PDF" and pick it again. Your place in the book is kept.'); return; }
    openBook(id, m?m.name:'Book', buf);
  }catch(err){ RLOG.error('library open', err); alertBox('Could not open this book: '+(err&&err.message||err)); }
});
$('file').addEventListener('change', async e=>{
  const f=e.target.files[0]; e.target.value=''; if(!f) return;
  const id=f.name+'|'+f.size;
  RLOG.step(`picked ${RLOG.tag(id)} (${(f.size/1048576).toFixed(1)} MB, ${f.type||'no type'})`);
  showLoading('Opening '+f.name+'…',0);
  let buf;
  try{ buf=await f.arrayBuffer(); }
  catch(err){ RLOG.error('read picked file', err); return errorBox('Could not read this file: '+(err&&err.message||err), [errText(err,'read file')]); }   // used to leave the loading screen up forever
  const saved=await DB.put('books',{id, data:buf.slice(0)});
  if(saved==null) toast('This book could not be saved on this device, so you will need to pick it again next time.', RLOG.errors(Date.now()-5000).map(x=>RLOG.line(x)));
  const old=await DB.get('meta',id);
  openBook(id, old&&old.name || f.name.replace(/\.pdf$/i,''), buf);
});
function alertBox(msg){ hideLoading(); const n=document.createElement('p'); n.className='note'; n.style.cssText='color:var(--accent);font-size:14px;margin:0 0 4px'; n.textContent=msg; $('books').prepend(n); setTimeout(()=>n.remove(),9000); }

/* ---------- open + extract ---------- */
async function openBook(id,name,buf,safe){
  let step='start'; const t0=Date.now(); let rebuilt=false;
  if(!safe) EXTRACT_ERRORS.length=0;   // a cached book has no new problems; don't report the previous book's
  RLOG.step(`open ${RLOG.tag(id)}${safe?' in safe mode':''}`);
  try{
    showLoading(safe?'Opening in safe mode…':'Opening…',0);
    step='load PDF';
    S.pdf = await pdfjsLib.getDocument({data:new Uint8Array(buf.slice(0)), isEvalSupported:false}).promise;
    step='read cache';
    let cache = safe ? null : await DB.get('cache',id);
    if(cache && (!Array.isArray(cache.blocks) || !Array.isArray(cache.toc))) cache=null;   // damaged cache: rebuild
    if(!cache || cache.v!==CORE_VERSION){
      let last=0; step='extract'; rebuilt=true;
      const pages = await extractPages(S.pdf, async (i,n)=>{ const now=Date.now(); if(now-last>80||i===n){ last=now; showLoading(`Rebuilding text… page ${i} of ${n}`, i/n); await new Promise(r=>setTimeout(r,0)); } }, safe);
      step='layout';
      showLoading('Laying out paragraphs…',1);
      const r=buildBlocks(pages);
      step='contents';
      let toc=[]; try{ toc=await getToc(S.pdf,r.blocks); }catch(e){ EXTRACT_ERRORS.push(errText(e,'contents')); }
      cache={id, v:CORE_VERSION, blocks:r.blocks, toc};
      if(!safe) await DB.put('cache',cache);
    }
    step='show';
    RLOG.step(`opened ${RLOG.tag(id)}: ${S.pdf.numPages} pages, ${cache.blocks.length} blocks, ${rebuilt?'rebuilt':'from cache'}, ${EXTRACT_ERRORS.length} page problems, ${Date.now()-t0} ms`);
    for(const x of EXTRACT_ERRORS) RLOG.warn('extract', x);
    S.id=id; S.name=name; S.blocks=cache.blocks; S.toc=cache.toc;
    S.meta = (await DB.get('meta',id)) || {id,name,pos:0,pct:0};
    S.meta.opened=Date.now(); DB.put('meta',S.meta);
    { const ps=S.blocks.filter(b=>b.t==='p'&&!b.small); S.blockStyle = ps.length>20 && ps.filter(b=>b.ind).length < ps.length*0.25; }
    S.cum=[]; let c=0; for(const b of S.blocks){ S.cum.push(c); c+= b.text? b.text.length : 400; } S.total=Math.max(1,c);
    buildSections();
    $('lib').classList.add('hidden'); $('reader').classList.remove('hidden'); hideLoading();
    $('ttl').textContent=name; $('hdrL').textContent=name;
    applySettings(false);
    if(!S.blocks.length){ content.innerHTML=''; openOriginal(0); return; }
    const b0=Math.min(S.meta.pos||0, S.blocks.length-1); show(b0, S.meta.off||0);
    if(safe || EXTRACT_ERRORS.length) toast(safe ? 'Opened in safe mode: some formatting is off for this book.' : `${EXTRACT_ERRORS.length} page(s) used simple layout.`, [errText(window.__openErr,'first try')].concat(EXTRACT_ERRORS).filter(x=>!/undefined: undefined/.test(x)));
  }catch(err){
    console.error(err);
    RLOG.error(`open ${RLOG.tag(id)} ${safe?'(safe mode) ':''}at step "${step}"`, err);
    if(!safe){ window.__openErr=err; window.__openErrStep=step; return openBook(id,name,buf,true); }   // second try without figures/links
    $('reader').classList.add('hidden'); $('lib').classList.remove('hidden');
    errorBox('Could not open this PDF: '+(err&&err.message||err), [errText(window.__openErr, 'first try at '+window.__openErrStep), errText(err,'safe mode at '+step)].concat(EXTRACT_ERRORS));
  }
}
function diag(lines){ return ['Reflow '+APP_VERSION+' (core '+CORE_VERSION+')', navigator.userAgent, ...lines].join('\n'); }
function errorBox(msg, lines){
  hideLoading();
  const box=document.createElement('div'); box.className='note'; box.style.cssText='color:var(--accent);font-size:14px;margin:0 0 6px;border:1px solid var(--line);border-radius:10px;padding:10px';
  box.innerHTML=`<div>${esc(msg)}</div><div style="margin-top:8px;display:flex;gap:8px"><button class="cp">Copy details</button><button class="x">Dismiss</button></div>`;
  const txt=diag(lines);
  box.querySelector('.cp').onclick=async e=>{ e.stopPropagation(); try{ await navigator.clipboard.writeText(txt); e.target.textContent='Copied'; }catch(_){ e.target.textContent='Copy failed'; } };
  box.querySelector('.x').onclick=e=>{ e.stopPropagation(); box.remove(); };
  $('books').prepend(box);
}
function toast(msg, lines){
  const t=document.createElement('div');
  t.style.cssText='position:fixed;left:12px;right:12px;top:max(12px,env(safe-area-inset-top));z-index:60;background:var(--fg);color:var(--bg);border-radius:12px;padding:10px 12px;font:13px/1.4 Inter,system-ui,sans-serif;display:flex;gap:10px;align-items:center;box-shadow:0 6px 24px #0004';
  t.innerHTML=`<span style="flex:1">${esc(msg)}</span><button style="color:var(--bg);border-color:#fff4">Copy details</button><button style="color:var(--bg);border:none">✕</button>`;
  const [cp,x]=t.querySelectorAll('button'); const txt=diag(lines||[]);
  cp.onclick=async()=>{ try{ await navigator.clipboard.writeText(txt); cp.textContent='Copied'; }catch(_){ cp.textContent='Copy failed'; } };
  x.onclick=()=>t.remove(); document.body.appendChild(t); setTimeout(()=>t.remove(),15000);
}

async function getToc(pdf,blocks){
  const firstBlock=[]; for(let i=blocks.length-1;i>=0;i--) firstBlock[blocks[i].page]=i;
  const p2b=p=>{ for(let q=p;q<pdf.numPages;q++) if(firstBlock[q]!=null) return firstBlock[q]; return Math.max(0,blocks.length-1); };
  const outline=[]; let ol=null; try{ ol=await pdf.getOutline(); }catch(e){}
  async function walk(items,depth){
    for(const it of items||[]){
      const t=(it.title||'').trim();
      if(!t || /^[A-Za-z_]*\d{3,}$/.test(t)) continue;                  // generated anchor names
      try{ let d=it.dest; if(typeof d==='string') d=await pdf.getDestination(d);
        if(Array.isArray(d) && d[0]!=null){ const p = typeof d[0]==='object' ? await pdf.getPageIndex(d[0]) : d[0]; outline.push({title:it.title, depth, block:p2b(p)}); } }catch(e){}
      if(depth<2 && it.items && it.items.length<=150) await walk(it.items, depth+1);   // a node with hundreds of children is an index
    }
  }
  if(ol) await walk(ol,0);
  // Entries that point into the printed contents pages at the front are noise.
  for(let k=outline.length-1;k>=0;k--){ if(outline.filter(e=>e.block===outline[k].block).length>4 && outline[k].depth>0) outline.splice(k,1); }
  // Detected headings from the text.
  const h1=blocks.filter(b=>b.t==='h1').length, h2=blocks.filter(b=>b.t==='h2').length;
  const withH2 = !(h1>=3 && h2>h1*8);
  const found=[];
  blocks.forEach((b,i)=>{ if(b.t==='h1' || (b.t==='h2' && withH2)) found.push({title:b.text.slice(0,90), depth:(b.t==='h1'||!h1)?0:1, block:i}); });
  // Use the PDF's own outline, and add detected chapters that it lacks.
  const outlineChapters = outline.filter(e=>e.depth===0).length;
  const detectedChapters = found.filter(e=>e.depth===0).length;
  { const seen=new Set(); for(let k=0;k<outline.length;k++){ const key=outline[k].title.toLowerCase().replace(/[^a-z0-9]/g,''); if(seen.has(key)){ outline.splice(k,1); k--; } else seen.add(key); } }
  if(outline.length>=20 || (outline.length && (detectedChapters < 3 || outlineChapters >= detectedChapters*1.5))) return outline;   // a rich outline wins
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
  document.body.className=(s.theme==='light'?'':s.theme)+(s.dict==='ios'?' nativesel':'');
  document.querySelectorAll('#sAa .seg[data-k]').forEach(g=>g.querySelectorAll('button').forEach(b=>b.classList.toggle('on', String(s[g.dataset.k])===b.dataset.v)));
  LS.set('reflow.settings',s);
  if(relayout && S.blocks.length) show(S.pos,S.off);
}

function layoutDims(){
  content.classList.toggle('blk', !!S.blockStyle);
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
  if(b.t==='fig'){
    const bw=b.box[2]-b.box[0], bh=b.box[3]-b.box[1];
    let w = bw < b.pw*0.2 ? S.W*0.6 : S.W, h=w*bh/bw;          // full column width: tables need every pixel
    const mh=S.H*0.9; if(h>mh){ h=mh; w=h*bw/bh; }
    return `<div class="fig crop" data-i="${i}" data-p="${b.page}" data-box="${b.box.join(',')}" style="width:${Math.floor(w)}px;height:${Math.floor(h)}px"></div>`;
  }
  if(b.t==='img'){ const {w,h}=figSize(b.ar); return `<div class="fig" data-i="${i}" data-p="${b.page}" style="width:${w}px;height:${h}px"></div>`; }
  if(b.t==='chip') return `<div class="chip" data-i="${i}" data-p="${b.page}">▣ Figure on page ${b.page+1}. Tap to see the original page.</div>`;
  if(b.t==='li') return `<div class="li l${b.lvl||0}" data-i="${i}"><span class="mk">${b.mkl?`<a class="il" data-to="${esc(b.mkl.slice(2))}">${esc(b.mk)}</a>`:esc(b.mk)}</span><div class="lt">${fmt(b.text)}</div></div>`;
  if(b.t==='q') return `<p class="q l${b.lvl||1}" data-i="${i}">${fmt(b.text)}</p>`;
  if(b.t==='pre') return `<pre class="code" data-i="${i}" data-p="${b.page}" data-box="${b.box?b.box.join(','):''}">${esc(b.text)}</pre>`;
  if(b.t==='c') return `<p class="c" data-i="${i}">${fmt(b.text)}</p>`;
  return `<p data-i="${i}" class="${b.ind?'':'ni'}${b.small?' small':''}">${fmt(b.text)}</p>`;
}

let figToken=0;
async function drawFigs(){
  const tok=++figToken;
  for(const el of content.querySelectorAll('.fig')){
    if(tok!==figToken) return;
    try{
      const page=await S.pdf.getPage(+el.dataset.p+1);
      const dpr=Math.min(3,window.devicePixelRatio||1);
      const w=parseFloat(el.style.width);
      let vp;
      if(el.dataset.box){
        const [x0,y0,x1,y1]=el.dataset.box.split(',').map(Number), pH=page.view[3]-page.view[1];
        const sc=w*dpr/(x1-x0);
        vp=page.getViewport({scale:sc, offsetX:-x0*sc, offsetY:-(pH-y1)*sc});
        vp.width=(x1-x0)*sc; vp.height=(y1-y0)*sc;
      } else vp=page.getViewport({scale:w*dpr/page.view[2]});
      const cv=document.createElement('canvas'); cv.width=Math.floor(vp.width); cv.height=Math.floor(vp.height);
      await page.render({canvasContext:cv.getContext('2d'), viewport:vp}).promise;
      if(tok!==figToken) return;
      el.innerHTML=''; el.appendChild(cv);
    }catch(e){ if(e&&e.name!=='RenderingCancelledException') RLOG.warn('figure p'+(+el.dataset.p+1), e); }
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
function chapterTitle(){ let t=''; for(const e of S.toc){ if(e.block<=S.pos) t=e.title; else break; } return plain(t); }
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

/* ---------- dictionary (long-press a word) ---------- */
const WORD_CH=/[\p{L}\p{M}’'\-]/u;
function caretAt(x,y){
  if(document.caretRangeFromPoint){ const r=document.caretRangeFromPoint(x,y); return r&&{node:r.startContainer,off:r.startOffset}; }
  if(document.caretPositionFromPoint){ const p=document.caretPositionFromPoint(x,y); return p&&{node:p.offsetNode,off:p.offset}; }
  return null;
}
function wordAt(x,y){
  const c=caretAt(x,y); if(!c||!c.node||c.node.nodeType!==3||!content.contains(c.node)) return null;
  const t=c.node.data; let a=c.off;
  if(!WORD_CH.test(t[a]||'') && a>0 && WORD_CH.test(t[a-1])) a--;
  if(!WORD_CH.test(t[a]||'')) return null;
  let b=a; while(a>0 && WORD_CH.test(t[a-1])) a--; while(b<t.length && WORD_CH.test(t[b])) b++;
  while(a<b && /[’'\-]/.test(t[a])) a++; while(b>a && /[’'\-]/.test(t[b-1])) b--;
  const w=t.slice(a,b); if(!/\p{L}/u.test(w)) return null;
  const r=document.createRange(); r.setStart(c.node,a); r.setEnd(c.node,b);
  const rects=[...r.getClientRects()]; const rect=rects.find(q=>x>=q.left-8&&x<=q.right+8&&y>=q.top-8&&y<=q.bottom+8);
  if(!rect) return null;
  return {word:w, rect};
}
function stems(w){
  w=w.toLowerCase().replace(/’/g,"'").replace(/'s$/,'');
  const c=[w], E=(re,f)=>{ if(re.test(w)) c.push(f()); };
  E(/ies$/,()=>w.slice(0,-3)+'y'); E(/(ss|x|ch|sh|o)es$/,()=>w.slice(0,-2)); E(/[^s]s$/,()=>w.slice(0,-1));
  E(/ied$/,()=>w.slice(0,-3)+'y'); E(/ed$/,()=>w.slice(0,-2)); E(/ed$/,()=>w.slice(0,-1)); E(/(.)\1ed$/,()=>w.slice(0,-3));
  E(/ing$/,()=>w.slice(0,-3)); E(/ing$/,()=>w.slice(0,-3)+'e'); E(/(.)\1ing$/,()=>w.slice(0,-4));
  E(/ily$/,()=>w.slice(0,-3)+'y'); E(/ly$/,()=>w.slice(0,-2)); E(/er$/,()=>w.slice(0,-2)); E(/est$/,()=>w.slice(0,-3));
  if(w.includes('-')) c.push(...w.split('-'));
  return [...new Set(c)].filter(x=>x.length>1);
}
const dictCache=Object.assign(Object.create(null), LS.get('reflow.dict',{}));
const hasOwn=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
function cachePut(k,v){ dictCache[k]=v; const ks=Object.keys(dictCache); if(ks.length>400) delete dictCache[ks[0]]; LS.set('reflow.dict',dictCache); }
async function freeDict(w){
  const r=await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/'+encodeURIComponent(w));
  if(r.status===404) return null; if(!r.ok) throw new Error('http '+r.status);
  const j=await r.json(); const e=j[0]; if(!e) return null;
  const senses=[]; let audio=null, phon=e.phonetic||'';
  for(const x of j) for(const p of (x.phonetics||[])){ if(!audio&&p.audio) audio=p.audio; if(!phon&&p.text) phon=p.text; }
  for(const x of j) for(const m of (x.meanings||[])){
    let s=senses.find(q=>q.pos===m.partOfSpeech); if(!s){ s={pos:m.partOfSpeech,defs:[]}; senses.push(s); }
    for(const d of (m.definitions||[])) if(s.defs.length<3) s.defs.push({d:d.definition, ex:d.example||''});
  }
  return {word:e.word, phon, audio, senses:senses.slice(0,4), src:'Wiktionary, via Free Dictionary API', url:'https://en.wiktionary.org/wiki/'+encodeURIComponent(e.word)};
}
async function wiktionary(w){
  const r=await fetch('https://en.wiktionary.org/api/rest_v1/page/definition/'+encodeURIComponent(w));
  if(r.status===404) return null; if(!r.ok) throw new Error('http '+r.status);
  const j=await r.json(); const en=j.en; if(!en||!en.length) return null;
  const txt=h=>{ const d=new DOMParser().parseFromString(h||'','text/html'); return (d.body.textContent||'').trim(); };
  const senses=en.slice(0,4).map(x=>({pos:(x.partOfSpeech||'').toLowerCase(), defs:(x.definitions||[]).map(d=>({d:txt(d.definition), ex:d.examples&&d.examples[0]?txt(d.examples[0]):''})).filter(d=>d.d).slice(0,3)})).filter(x=>x.defs.length);
  return senses.length? {word:w, phon:'', audio:null, senses, src:'Wiktionary', url:'https://en.wiktionary.org/wiki/'+encodeURIComponent(w)} : null;
}
async function define(word){
  const tries=stems(word); let netErr=false;
  for(const w of tries){
    if(hasOwn(dictCache,w)){ if(dictCache[w]) return dictCache[w]; continue; }
    for(const src of [freeDict, wiktionary]){
      try{ const r=await src(w); if(r){ cachePut(w,r); return r; } }catch(e){ netErr=true; RLOG.warn('dictionary '+src.name, e); }
    }
    if(!netErr) cachePut(w,null);
  }
  return netErr ? {error:'net'} : null;
}
let dictTok=0;
async function lookup(hit){
  const m=$('wordMark'); const r=hit.rect;
  m.style.cssText=`left:${r.left-2}px;top:${r.top-1}px;width:${r.width+4}px;height:${r.height+2}px`; m.classList.remove('hidden');
  hideBars(); $('scrim').classList.remove('hidden'); $('dict').classList.remove('hidden');
  const body=$('dictBody'), tok=++dictTok;
  body.innerHTML=`<div class="hd"><p class="w">${esc(hit.word)}</p></div><p class="msg">Looking up…</p>`;
  const d=await define(hit.word); if(tok!==dictTok) return;
  if(!d || d.error){
    body.innerHTML=`<div class="hd"><p class="w">${esc(hit.word)}</p></div><p class="msg">${d&&d.error ? 'No connection to the dictionary. Words you looked up before still work offline.' : 'No definition found for this word.'}</p>
      <p class="src"><a href="https://en.wiktionary.org/wiki/${encodeURIComponent(hit.word.toLowerCase())}" target="_blank" rel="noopener">Search Wiktionary</a></p>`;
    return;
  }
  body.innerHTML=`<div class="hd"><p class="w">${esc(d.word)}</p>${d.audio?'<button id="dictSay" title="Pronounce">🔊</button>':''}</div>
    ${d.phon?`<p class="ph">${esc(d.phon)}</p>`:''}
    ${d.senses.map(s=>`<p class="pos">${esc(s.pos)}</p><ol>${s.defs.map(x=>`<li>${esc(x.d)}${x.ex?` <span class="ex">“${esc(x.ex)}”</span>`:''}</li>`).join('')}</ol>`).join('')}
    <p class="src">Source: ${esc(d.src)} (CC BY-SA). <a href="${esc(d.url)}" target="_blank" rel="noopener">More on Wiktionary</a></p>`;
  const say=$('dictSay'); if(say) say.onclick=()=>{ try{ new Audio(d.audio).play().catch(()=>{}); }catch(e){} };
}
var lpFired=0; let lpT=null, lpAt=null;
const ownDict=()=>S.set.dict!=='ios';
$('stage').addEventListener('touchstart',e=>{
  if(e.touches.length!==1) return; const t=e.touches[0]; lpAt={x:t.clientX,y:t.clientY};
  clearTimeout(lpT); if(!ownDict()) return; lpT=setTimeout(()=>{ const w=wordAt(lpAt.x,lpAt.y); if(w){ lpFired=Date.now(); lookup(w); } },450);
},{passive:true});
$('stage').addEventListener('touchmove',e=>{ if(lpAt && e.touches[0] && Math.hypot(e.touches[0].clientX-lpAt.x,e.touches[0].clientY-lpAt.y)>10) clearTimeout(lpT); },{passive:true});
$('stage').addEventListener('touchend',()=>clearTimeout(lpT),{passive:true});
$('stage').addEventListener('touchcancel',()=>clearTimeout(lpT),{passive:true});
$('stage').addEventListener('contextmenu',e=>{ if(!ownDict()) return; e.preventDefault(); if(Date.now()-lpFired<800) return; const w=wordAt(e.clientX,e.clientY); if(w){ lpFired=Date.now(); lookup(w); } });
content.addEventListener('dblclick',e=>{ if(!ownDict()) return; const w=wordAt(e.clientX,e.clientY); if(w){ lpFired=Date.now(); lookup(w); } });

/* ---------- internal links (footnotes) ---------- */
const backStack=[];
function linkTarget(to){
  const [ps,ys]=String(to).split(':'); const p=+ps, y=ys===''||ys==null?null:+ys;
  let first=-1;
  for(let i=0;i<S.blocks.length;i++){
    const b=S.blocks[i]; if(b.page<p) continue;
    if(b.page>p) return first>=0?first:i;
    if(first<0) first=i;
    if(y==null || b.y0==null || b.y0 <= y+4) return i;
  }
  return first>=0?first:S.blocks.length-1;
}
// A tap close to a small footnote number counts as a tap on it.
function nearestLink(x,y,maxD){
  let best=null, bd=maxD;
  const vr=viewport.getBoundingClientRect();
  for(const a of content.querySelectorAll('a.il')){
    for(const r of a.getClientRects()){
      if(r.right<vr.left || r.left>vr.right || r.bottom<vr.top || r.top>vr.bottom) continue;
      const dx=Math.max(r.left-x,0,x-r.right), dy=Math.max(r.top-y,0,y-r.bottom), d=Math.hypot(dx,dy);
      if(d<bd){ bd=d; best=a; }
    }
  }
  return best;
}
function followLink(to, src){
  const i=linkTarget(to); if(i<0) return;
  const from=src && src.closest('[data-i]');
  backStack.push({pos:S.pos, off:S.off, block: from? +from.dataset.i : null, to}); if(backStack.length>20) backStack.shift();
  $('backPill').classList.remove('hidden');
  hideBars(); show(i,0);
  const el=content.querySelector(`[data-i="${i}"]`);   // show which note it is
  if(el){ el.classList.remove('hit'); void el.offsetWidth; el.classList.add('hit'); }
}
$('backPill').addEventListener('click',e=>{
  e.stopPropagation();
  const b=backStack.pop();
  if(b){
    if(b.block!=null) show(b.block,0); else show(b.pos,b.off);   // the page that holds the footnote number
    const a=b.block!=null && content.querySelector(`[data-i="${b.block}"] a.il[data-to="${CSS.escape(b.to)}"]`);
    if(a){ a.classList.remove('hitlink'); void a.offsetWidth; a.classList.add('hitlink'); }
  }
  if(!backStack.length) $('backPill').classList.add('hidden');
});
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
  if(Date.now()-swipedAt<450 || Date.now()-lpFired<700) return;
  const sel=window.getSelection&&window.getSelection(); if(sel && String(sel).trim()) return;
  const xl=e.target.closest('a.xl'); if(xl) return;   // web link: let the browser open it
  const il=e.target.closest('a.il') || nearestLink(e.clientX,e.clientY,30);
  if(il){ e.preventDefault(); followLink(il.dataset.to, il); return; }
  const pre=e.target.closest('pre.code'); if(pre && pre.dataset.box){ openOriginal(+pre.dataset.p, pre.dataset.box); return; }
  const fig=e.target.closest('.chip,.fig'); if(fig){ openOriginal(+fig.dataset.p, fig.dataset.box); return; }
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
function closeSheets(){ $('scrim').classList.add('hidden'); $('sAa').classList.add('hidden'); $('sToc').classList.add('hidden'); $('dict').classList.add('hidden'); $('wordMark').classList.add('hidden'); }
$('scrim').onclick=()=>{ if(Date.now()-lpFired<800) return; closeSheets(); };   // ignore the tap that ends a long press
$('bLib').onclick=async()=>{ RLOG.step('back to library'); hideBars(); await saveNow(); $('reader').classList.add('hidden'); $('lib').classList.remove('hidden'); renderLibrary(); };
$('bAa').onclick=()=>openSheet('sAa');
$('bToc').onclick=()=>{
  const cur=S.toc.reduce((acc,e,k)=>e.block<=S.pos?k:acc,-1);
  $('tocList').innerHTML = S.toc.length ? S.toc.map((e,k)=>`<a class="d${Math.min(2,e.depth)}${k===cur?' cur':''}" data-b="${e.block}">${esc(e.title)}</a>`).join('') : '<p class="note">No chapters found in this PDF.</p>';
  openSheet('sToc');
};
$('tocList').onclick=e=>{ const a=e.target.closest('a'); if(!a) return; RLOG.step('contents: jump to block '+a.dataset.b); closeSheets(); hideBars(); backStack.length=0; $('backPill').classList.add('hidden'); jump(+a.dataset.b); };
$('slider').addEventListener('change',e=>{
  const target=e.target.value/1000*S.total; let i=0; while(i<S.cum.length-1 && S.cum[i+1]<=target) i++; jump(i);
});
$('sAa').addEventListener('click',e=>{
  const b=e.target.closest('button'); if(!b) return;
  if(b.dataset.a==='fs-') S.set.size=Math.max(13,S.set.size-1);
  else if(b.dataset.a==='fs+') S.set.size=Math.min(32,S.set.size+1);
  else { const g=b.closest('.seg'); if(!g||!g.dataset.k) return; S.set[g.dataset.k]=b.dataset.v; }
  RLOG.step('setting '+(b.dataset.a||b.closest('.seg').dataset.k+'='+b.dataset.v));
  applySettings();
});

/* ---------- original page view ---------- */
const O={page:0, zoom:1, task:null};
$('bOrig').onclick=()=>openOriginal((S.blocks[S.pos]||{page:0}).page);
function openOriginal(p, box){
  RLOG.step('original page '+(p+1)+(box?' (figure)':''));
  O.page=p; O.start=p; O.box = box ? box.split(',').map(Number) : null; O.zoom = O.box ? 1 : 1;
  $('orig').classList.remove('hidden'); renderOrig();
}
function closeOriginal(){
  $('orig').classList.add('hidden');
  if(O.page!==O.start && S.blocks.length){ const i=S.blocks.findIndex(b=>b.page>=O.page); if(i>=0) jump(i); }
  else if(!S.blocks.length){ $('bLib').onclick(); }
}
function origGo(d){ O.box=null; O.page=Math.max(0,Math.min(S.pdf.numPages-1,O.page+d)); renderOrig(); }
async function renderOrig(){
  $('oLbl').textContent = O.box ? `Figure · page ${O.page+1}` : `Page ${O.page+1} of ${S.pdf.numPages}`;
  try{
    if(O.task){ try{ O.task.cancel(); }catch(e){} }
    const page=await S.pdf.getPage(O.page+1);
    const dpr=Math.min(2.5,window.devicePixelRatio||1);
    let vp;
    if(O.box){
      // Zoomed figure: fit the figure to the screen width, then zoom with + / −.
      const [x0,y0,x1,y1]=O.box, pH=page.view[3]-page.view[1];
      const sc=($('oScroll').clientWidth-16)/(x1-x0)*O.zoom*dpr;
      vp=page.getViewport({scale:sc, offsetX:-x0*sc, offsetY:-(pH-y1)*sc}); vp.width=(x1-x0)*sc; vp.height=(y1-y0)*sc;
    } else {
      const fit=($('oScroll').clientWidth-16)/page.view[2];
      vp=page.getViewport({scale:fit*O.zoom*dpr});
    }
    const cv=$('oCan'); cv.width=Math.floor(vp.width); cv.height=Math.floor(vp.height);
    cv.style.width=Math.floor(vp.width/dpr)+'px'; cv.style.height=Math.floor(vp.height/dpr)+'px';
    O.task=page.render({canvasContext:cv.getContext('2d'), viewport:vp});
    await O.task.promise;
  }catch(e){ if(e&&e.name!=='RenderingCancelledException') RLOG.error('original page '+(O.page+1), e, {notify:true}); }
}
$('oBack').onclick=closeOriginal;
$('oPrev').onclick=()=>origGo(-1); $('oNext').onclick=()=>origGo(1);
$('oZi').onclick=()=>{ O.zoom=Math.min(6,O.zoom*1.4); renderOrig(); };
$('oZo').onclick=()=>{ O.zoom=Math.max(0.6,O.zoom/1.4); renderOrig(); };

/* ---------- app extras ---------- */
if(window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc='pdf.worker.min.js';   // real background worker
document.addEventListener('dragover',e=>{ e.preventDefault(); });
document.addEventListener('drop',e=>{
  e.preventDefault();
  const f=[...(e.dataTransfer&&e.dataTransfer.files||[])].find(x=>/\.pdf$/i.test(x.name)||x.type==='application/pdf');
  if(!f) return;
  const dt=new DataTransfer(); dt.items.add(f); $('file').files=dt.files; $('file').dispatchEvent(new Event('change'));
});

/* ---------- report a problem ---------- */
// Everything here stays on the device until the reader copies or shares it. See debuglog.js.
function reportText(){
  const st=S.blocks.length ? `reading ${RLOG.tag(S.id)}: block ${S.pos} of ${S.blocks.length}, section ${S.si+1}/${S.sec.length}, page ${S.page+1}/${S.pages}, ${S.set.mode}` : 'in library';
  const disp=(window.matchMedia&&matchMedia('(display-mode: standalone)').matches)||navigator.standalone ? 'home screen app' : 'browser tab';
  return ['Reflow '+APP_VERSION+' (core '+CORE_VERSION+')', navigator.userAgent,
    `${disp}, ${navigator.onLine===false?'offline':'online'}, screen ${innerWidth}x${innerHeight}@${window.devicePixelRatio||1}, service worker ${navigator.serviceWorker&&navigator.serviceWorker.controller?'active':'none'}`,
    st, 'settings '+JSON.stringify(S.set), '', '--- log (oldest first) ---', RLOG.text()||'(empty)'].join('\n');
}
let reportSeen=+(LS.get('reflow.reportSeen',0))||0;
function updateErrBadge(){ const n=RLOG.errors(reportSeen).length; const b=$('errBadge'); b.textContent=n?`(${n} new error${n>1?'s':''})`:''; b.classList.toggle('hidden',!n); }
function openReport(){
  const errs=RLOG.errors(), recent=RLOG.errors(Date.now()-864e5);
  $('rSum').textContent = errs.length ? `${errs.length} error${errs.length>1?'s':''} logged, ${recent.length} in the last day. Copy or share this with whoever is fixing Reflow.` : 'No errors logged. If something looked wrong, copy this anyway: the steps help show what happened.';
  $('rLog').textContent=reportText(); $('rLive').checked=RDEBUG.on;
  $('rShare').classList.toggle('hidden', !navigator.share);
  $('rScrim').classList.remove('hidden'); $('sReport').classList.remove('hidden');
  setTimeout(()=>{ const l=$('rLog'); l.scrollTop=l.scrollHeight; },0);
  reportSeen=Date.now(); LS.set('reflow.reportSeen',reportSeen); updateErrBadge();
}
function closeReport(){ $('rScrim').classList.add('hidden'); $('sReport').classList.add('hidden'); }
async function copyText(txt, btn, label){ try{ await navigator.clipboard.writeText(txt); btn.textContent='Copied'; }catch(_){ const r=document.createRange(); r.selectNodeContents($('rLog')); const sel=getSelection(); sel.removeAllRanges(); sel.addRange(r); btn.textContent='Selected: copy it'; } setTimeout(()=>btn.textContent=label,2500); }
$('bReport').onclick=e=>{ e.preventDefault(); openReport(); };
$('bReport2').onclick=()=>{ closeSheets(); openReport(); };
$('rScrim').onclick=closeReport; $('rClose').onclick=closeReport;
$('rCopy').onclick=e=>copyText(reportText(), e.target, 'Copy log');
$('rShare').onclick=()=>{ navigator.share({title:'Reflow problem report', text:reportText()}).catch(()=>{}); };
$('rIssue').onclick=e=>{
  // GitHub pre-fills the issue from the link. Long logs are cut to the newest part; the full log is also copied.
  const full=reportText(); let body=full; const max=5500;
  if(body.length>max){ const head=body.slice(0,body.indexOf('--- log')); body=head+'--- log (newest part; full log is on the clipboard) ---\n…'+full.slice(-(max-head.length)); }
  try{ navigator.clipboard.writeText(full).catch(()=>{}); }catch(_){}
  const last=RLOG.errors().pop();
  const title='Problem: '+(last? last.m.slice(0,80) : 'describe what went wrong');
  window.open('https://github.com/Sriman97/reflow/issues/new?title='+encodeURIComponent(title)+'&body='+encodeURIComponent('**What happened:**\n\n\n**Log:**\n```\n'+body+'\n```'), '_blank');
};
$('rClear').onclick=()=>{ RLOG.clear(); RLOG.step('log cleared'); $('rLog').textContent=reportText(); updateErrBadge(); };
$('rLive').onchange=e=>{ RDEBUG.set(e.target.checked); RDEBUG.on=e.target.checked; liveLog(); };
function liveLog(){
  const el=$('liveLog'); el.classList.toggle('hidden', !RDEBUG.on); if(!RDEBUG.on) return;
  el.innerHTML=RLOG.entries().slice(-30).map(x=>`<div class="${x.k}">${esc(RLOG.line(x))}</div>`).join(''); el.scrollTop=el.scrollHeight;
}
// A visible sign when something breaks, at most once a minute, so errors are not missed but don't nag.
let lastNotice=0;
RLOG.onAdd((e,o)=>{
  if(RDEBUG.on) liveLog();
  if(e.k!=='error') return;
  updateErrBadge();
  if(o.notify && Date.now()-lastNotice>60000){ lastNotice=Date.now(); noticeError(e); }
});
function noticeError(e){
  const t=document.createElement('div');
  t.style.cssText='position:fixed;left:12px;right:12px;bottom:max(12px,env(safe-area-inset-bottom));z-index:60;background:var(--fg);color:var(--bg);border-radius:12px;padding:10px 12px;font:13px/1.4 Inter,system-ui,sans-serif;display:flex;gap:10px;align-items:center;box-shadow:0 6px 24px #0004';
  t.innerHTML=`<span style="flex:1">Something went wrong. It was saved to the problem log.</span><button style="color:var(--bg);border-color:#fff4">Details</button><button style="color:var(--bg);border:none">✕</button>`;
  const [d,x]=t.querySelectorAll('button');
  d.onclick=()=>{ t.remove(); openReport(); }; x.onclick=()=>t.remove();
  document.body.appendChild(t); setTimeout(()=>t.remove(),12000);
}

/* ---------- boot ---------- */
$('ver').textContent=APP_VERSION;
updateErrBadge(); liveLog();
applySettings(false);
renderLibrary();
if(!window.pdfjsLib){ RLOG.error('boot', 'PDF.js did not load'); alertBox('The PDF engine did not load. Check your connection and reload.'); }
