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

## Testing
`tests/e2e_webkit.py` runs the exact files GitHub Pages serves, with the real PDF.js worker, in WebKit (the engine family of iPhone Safari): upload, library, reopen, reload, reopen from the saved copy, and the safe-mode retry. See the file header for setup. Book PDFs are not stored in the repo.
