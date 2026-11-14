// Smoke test for the problem log (debuglog.js) and "Report a problem", in Chromium with Playwright.
// Run from the repo root:  python3 -m http.server 8767 &   then   node tests/debuglog_smoke.js http://localhost:8767/
// Makes its own small PDF, so no book files are needed. Exit code 0 = all checks passed.
const { chromium } = require('playwright');
const fs = require('fs'), os = require('os'), path = require('path');

(async () => {
  const url = process.argv[2] || 'http://localhost:8767/';
  const fails = [];
  const check = (name, ok, info = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fails.push(name); };

  // One place for the version: debuglog.js APP_VERSION must match the service worker cache name.
  const appV = /APP_VERSION = '([^']+)'/.exec(fs.readFileSync('debuglog.js', 'utf8'))[1];
  const swV = /CACHE = 'reflow-([^']+)'/.exec(fs.readFileSync('sw.js', 'utf8'))[1];
  check('version matches service worker', appV === swV, appV + ' vs ' + swV);

  const browser = await chromium.launch();
  const pdfPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reflow-')), 'Secret Title Book.pdf');
  { const p = await browser.newPage();
    const paras = Array.from({ length: 60 }, (_, i) => `<h2>Chapter ${i + 1}</h2><p>${'This is a sentence of the test book. '.repeat(12)}</p>`).join('');
    await p.setContent(`<html><body style="font:12pt serif">${paras}</body></html>`); await p.pdf({ path: pdfPath, format: 'A5' }); await p.close(); }

  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const pageErrors = []; page.on('pageerror', e => pageErrors.push(String(e)));
  await page.goto(url); await page.waitForTimeout(800);
  await page.evaluate(() => RLOG.clear());
  check('version shown in library', (await page.textContent('#ver')) === appV);

  await page.setInputFiles('#file', pdfPath);
  await page.waitForFunction(() => !document.getElementById('reader').classList.contains('hidden') && S.blocks.length, null, { timeout: 60000 });
  const log = await page.evaluate(() => RLOG.text());
  check('log records the pick and open steps', /picked book#\w+/.test(log) && /opened book#\w+: \d+ pages/.test(log), log.split('\n').slice(-3).join(' | '));
  check('log never holds the book title', !/Secret Title/.test(log));
  check('no errors while opening', (await page.evaluate(() => RLOG.errors().length)) === 0, await page.evaluate(() => RLOG.errors().map(e => e.m).join(' | ')));

  // An uncaught error anywhere: logged, a notice appears, and the report shows it.
  await page.evaluate(() => setTimeout(() => { null.boom(); }, 0)); await page.waitForTimeout(300);
  check('uncaught error is logged', await page.evaluate(() => RLOG.errors().some(e => /uncaught/.test(e.m))));
  check('notice shown', await page.isVisible('text=Something went wrong'));
  await page.click('text=Details');
  check('report opens from the notice', await page.isVisible('#sReport'));
  const rep = await page.textContent('#rLog');
  check('report has version, position and the error', rep.includes(appV) && /reading book#\w+: block/.test(rep) && /ERROR uncaught/.test(rep));
  check('report never holds the book title', !/Secret Title/.test(rep));
  await page.click('#rClose');

  // A rejected promise is logged too, and the log survives a reload.
  await page.evaluate(() => { Promise.reject(new Error('lost promise')); }); await page.waitForTimeout(300);
  await page.reload(); await page.waitForTimeout(800);
  check('log survives reload', await page.evaluate(() => RLOG.errors().some(e => /lost promise/.test(e.m))));
  check('library shows new-error count', /new error/.test(await page.textContent('#errBadge')));
  await page.click('#bReport');
  check('badge clears after viewing', await page.isHidden('#errBadge'));
  await page.click('#rLive');
  check('live log appears on screen', await page.isVisible('#liveLog'));
  await page.click('#rLive'); await page.click('#rClose');

  // Reading the picked file fails: used to leave "Opening…" up forever.
  await page.evaluate(() => { File.prototype.arrayBuffer = () => Promise.reject(new DOMException('read failed', 'NotReadableError')); });
  await page.setInputFiles('#file', pdfPath); await page.waitForTimeout(500);
  check('failed file read shows an error, not a stuck loading screen', (await page.isHidden('#load')) && /Could not read this file/.test(await page.textContent('#books')));

  check('no stray page errors besides the planted ones', pageErrors.every(e => /boom|lost promise|null/.test(e)), pageErrors.join(' | '));
  await browser.close();
  console.log('RESULT:', fails.length ? fails.length + ' failed' : 'all passed');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
