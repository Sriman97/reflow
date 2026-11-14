# Reflow

A Kindle-style reader for PDF books, as an installable web app (PWA).

Reflow rebuilds paragraphs, headings and chapters from a PDF, so you can change the font, size, spacing, margins and theme. It works offline after the first visit. Your books stay on your device (IndexedDB); nothing is uploaded.

## Install on a phone
1. Open the GitHub Pages link in Chrome or Safari.
2. Share → **Add to Home Screen**.
3. Open Reflow from the home screen icon.

## Features
- Pages (tap/swipe) or continuous scroll
- Fonts: Literata, Georgia, Inter · size, spacing, margins, justify/left
- Themes: light, sepia, paper (e-ink look, optional page flash), dark
- Contents from the PDF outline plus detected chapters
- Original-page view with zoom; figures link to their page
- Long-press a word for its definition (Free Dictionary API / Wiktionary; cached for offline)
- Tappable footnotes with Back, superscripts, lists, quotes, italics
- Library with saved reading position

## Files
- `index.html`, `reader.js` — the app
- `pdf.min.js`, `pdf.worker.min.js` — [PDF.js](https://mozilla.github.io/pdf.js/) 3.11.174 (Apache-2.0)
- `sw.js`, `manifest.webmanifest`, `register-sw.js` — offline + install
- `debuglog.js` — the problem log: keeps the last 80 errors and app steps on the device, catches every uncaught error, and holds `APP_VERSION` (keep it equal to `CACHE` in `sw.js`)

## When something goes wrong
- A notice appears ("Something went wrong") and the error is saved on the device, even across reloads.
- **Report a problem** (library footer, or Aa → Problems) shows the log with the version, device, current position and settings. Copy it, share it, or open a pre-filled GitHub issue. Book titles appear only as a short tag like `book#a4214b`.
- **Show live log on screen** in that panel (or open the app with `?debug=1`) shows the log as it happens, and also records PDF.js console warnings.
- To inspect the installed app on an iPhone: Settings → Safari → Advanced → Web Inspector on, connect to a Mac, then Safari → Develop → your iPhone → Reflow.

## Testing
`tests/e2e_webkit.py` runs the exact files GitHub Pages serves, with the real PDF.js worker, in WebKit (the engine family of iPhone Safari): upload, library, reopen, reload, reopen from the saved copy, and the safe-mode retry. It fails on any error in the app's problem log. See the file header for setup. Book PDFs are not stored in the repo.

`tests/debuglog_smoke.js` checks the problem log and Report a problem in Chromium with Playwright, using a PDF it makes itself: `python3 -m http.server 8767 &` then `node tests/debuglog_smoke.js http://localhost:8767/`.
