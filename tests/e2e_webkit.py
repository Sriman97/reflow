"""Production-like end-to-end test for Reflow.

Runs the exact files that GitHub Pages serves, with the real PDF.js worker,
in WebKit (the engine family of iPhone Safari). Covers: rendering every block in both layouts, upload, library,
reopen, app reload, reopen from the saved copy, page turns, and the
safe-mode retry when opening fails.

Setup (Ubuntu):  apt-get install -y webkit2gtk-driver xvfb && pip install selenium
Run:             python3 -m http.server 8767 &   (from the repo root)
                 xvfb-run -a python3 tests/e2e_webkit.py http://localhost:8767/ book1.pdf [book2.pdf ...]
Exit code 0 = all checks passed. Book files are not part of the repo.
"""
import sys, time
from selenium import webdriver
from selenium.webdriver.common.by import By

HOOK = """if(!window.__errs){ window.__errs=[]; const oe=console.error; console.error=function(...a){ window.__errs.push(a.map(x=>x&&x.stack?String(x)+' @ '+x.stack.split('\\n').slice(0,4).join(' / '):String(x)).join(' ')); oe.apply(console,a); };
 window.addEventListener('error',e=>window.__errs.push('onerror '+e.message));
 window.addEventListener('unhandledrejection',e=>window.__errs.push('rejection '+(e.reason&&e.reason.stack||e.reason))); }"""

def main(url, books):
    drv = webdriver.WebKitGTK(options=webdriver.WebKitGTKOptions())
    fails = []
    def check(name, ok, info=''):
        print(('PASS ' if ok else 'FAIL ') + name + (('  ' + info) if info else ''))
        if not ok: fails.append(name)
    def state():
        return drv.execute_script("return !document.getElementById('reader').classList.contains('hidden') ? 'open' : (document.getElementById('books').innerText.includes('Could not') ? 'error' : '')")
    def wait():
        for _ in range(480):
            s = state()
            if s: return s
            time.sleep(0.5)
        return 'timeout'
    def to_library():
        drv.execute_script("document.getElementById('bLib').click()"); time.sleep(0.8)
    try:
        drv.set_window_size(390, 844)
        drv.get(url); time.sleep(2); drv.execute_script(HOOK); drv.execute_script('RLOG.clear()')
        check('engine is WebKit', 'AppleWebKit' in drv.execute_script('return navigator.userAgent'))
        for f in books:
            drv.find_element(By.ID, 'file').send_keys(f)
            check('upload ' + f.split('/')[-1], wait() == 'open')
            n = drv.execute_script('return S.blocks.length')
            check('  has text blocks', n > 50, f'{n} blocks')
            for _ in range(3): drv.execute_script('next()'); time.sleep(0.15)
            # Draw EVERY block, in both layouts: a crash anywhere in the book must fail the test.
            r = drv.execute_script("""try{ let bad=0; S.blocks.forEach((b,i)=>{ try{ blockHTML(b,i); }catch(e){ bad++; if(!window.__first) window.__first=i+': '+e; } });
              if(bad) return 'blockHTML failed on '+bad+' blocks, first '+window.__first;
              for(let k=0;k<S.sec.length;k++) renderSection(k);
              S.set.mode='scroll'; applySettings(); const n=content.querySelectorAll('[data-i]').length;
              S.set.mode='pages'; applySettings();
              return n===S.blocks.length ? 'ok' : 'scroll drew '+n+' of '+S.blocks.length; }catch(e){ return 'ERROR '+e+' @ '+(e.stack||'').split('\\n')[0]; }""")
            check('  every block renders (pages + scroll)', r == 'ok', r)
            to_library()
        drv.execute_script("document.querySelector('.book').click()")
        check('reopen from library', wait() == 'open'); to_library()
        drv.refresh(); time.sleep(2); drv.execute_script(HOOK)
        n = drv.execute_script("return document.querySelectorAll('.book').length")
        check('library survives reload', n == len(books), f'{n} books')
        for k in range(n):
            drv.execute_script(f"document.querySelectorAll('.book')[{k}].click()")
            check(f'reopen #{k} after reload (saved copy)', wait() == 'open')
            to_library()
        # Safe-mode retry: make the first layout attempt fail like a device-specific bug would.
        drv.execute_script("const orig=buildBlocks; let n=0; window.buildBlocks=p=>{ if(!n++) throw new TypeError('{} is not iterable'); return orig(p); };")
        drv.execute_script("(async()=>{ const id=document.querySelector('.book').dataset.id; await DB.del('cache', id); document.querySelector('.book').click(); })()")
        check('opens in safe mode after a failure', wait() == 'open')
        check('  shows a notice with details', drv.execute_script("return [...document.querySelectorAll('div')].some(d=>/safe mode/.test(d.textContent) && d.querySelector('button'))"))
        errs = [e for e in drv.execute_script('return window.__errs||[]') if 'is not iterable' not in e and 'ERR_' not in e]
        # The app's own problem log (debuglog.js) also sees errors the hook above can't, such as failed storage saves.
        errs += [e for e in drv.execute_script("return RLOG.errors().map(e=>e.m)") if 'is not iterable' not in e]
        check('no unexpected errors', not errs, ' | '.join(errs)[:600])
    finally:
        drv.quit()
    print('RESULT:', 'all passed' if not fails else f'{len(fails)} failed')
    return 1 if fails else 0

if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2:]))
