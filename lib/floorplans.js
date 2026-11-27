'use strict';
// Finds floor plan images in a CoStar report and works out which suite each one belongs to.
//
// CoStar captions floor plans like "Partial 3rd Floor • Suite 350" or "Entire 2nd Floor".
// pdftohtml -xml gives us every text run and image with its position on the page, so each
// caption is paired with the nearest large image above or below it.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CAPTION_RE = /\b(?:(?:Partial|Entire|Full)\s+)?(?:\d+(?:st|nd|rd|th)|First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth|Eleventh|Twelfth|Ground|Lower Level|LL|Penthouse|Mezzanine|Basement)\s+Floor\b|\bFloor\s*Plans?\b|\bFloor\s+\d+\b/i;
const NOT_CAPTION_RE = /Contig|Typical Floor|SF Avail|Floor\s+Suite\s+Use|Floor Area/i;

const WORD_ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20 };
const WORD_ORD_RE = new RegExp(`\\b(${Object.keys(WORD_ORD).join('|')})\\s+Floor\\b`, 'i');
const ORD = (n) => { const v = n % 100; return n + (v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'); };
const norm = (s) => String(s || '').toLowerCase().replace(/^0+(?=\d)/, '').replace(/[^a-z0-9]/g, '');

/** Pull the floor and suite out of a caption or file name. */
function parseCaption(text) {
  const t = String(text || '');
  const suite = (t.match(/\b(?:Suite|Ste\.?|Unit|Space)\s*#?\s*([A-Za-z]?\d+[A-Za-z\-]*|[A-Z])\b/i) || [])[1] || null;
  let floor = null;
  const f1 = t.match(/\b(\d+)(?:st|nd|rd|th)\s+Floor\b/i) || t.match(/\bFloor\s+(\d+)\b/i) || t.match(/\b(\d+)(?:st|nd|rd|th)\s+Fl\b/i);
  const fw = t.match(WORD_ORD_RE);
  if (f1) floor = ORD(Number(f1[1]));
  else if (fw) floor = ORD(WORD_ORD[fw[1].toLowerCase()]);
  else if (/\b(Ground|Lower Level|LL|Penthouse|Mezzanine|Basement)\s+Floor\b/i.test(t)) floor = RegExp.$1;
  const entire = /\b(Entire|Full)\s/i.test(t);
  return { suite, floor, entire };
}

/**
 * Choose the suite a floor plan belongs to. Returns the index in `suites`, or -1.
 * suites: [{ suite, floor, floor_status }]
 */
function matchSuite(text, suites) {
  text = String(text || '').replace(/[_]+/g, ' ');
  const { suite, floor, entire } = parseCaption(text);
  if (suite) {
    const i = suites.findIndex((s) => s.suite && norm(s.suite) === norm(suite));
    if (i >= 0) return i;
  }
  if (floor) {
    const onFloor = suites.map((s, i) => ({ s, i })).filter(({ s }) => s.floor && norm(s.floor) === norm(floor));
    if (onFloor.length === 1) return onFloor[0].i;
    if (entire) { const e = onFloor.find(({ s }) => /entire/i.test(s.floor_status || '')); if (e) return e.i; }
  }
  // Bare numbers in a file name like "350.pdf" or "Ste350_plan.pdf".
  if (!suite) {
    for (const n of String(text).match(/\b[A-Za-z]?\d{2,5}[A-Za-z]?\b/g) || []) {
      const i = suites.findIndex((s) => s.suite && norm(s.suite) === norm(n));
      if (i >= 0) return i;
    }
  }
  return -1;
}

/** Every suite a caption names ("Suite 200: 3,151 SF · Suite 210: 1,976 SF"); falls back to matchSuite. */
function matchSuites(text, suites) {
  const found = new Set();
  for (const m of String(text || '').matchAll(/\b(?:Suite|Ste\.?|Unit|Space)\s*#?\s*([A-Za-z]?\d+[A-Za-z\-]*)\b/gi)) {
    const i = suites.findIndex((s) => s.suite && norm(s.suite) === norm(m[1]));
    if (i >= 0) found.add(i);
  }
  if (found.size) return [...found];
  const one = matchSuite(text, suites);
  return one >= 0 ? [one] : [];
}

function pdftohtml(pdf, page, outDir) {
  return new Promise((resolve, reject) => {
    execFile('pdftohtml', ['-xml', '-q', '-nodrm', '-f', String(page), '-l', String(page), pdf, path.join(outDir, 'p')],
      { maxBuffer: 32 * 1024 * 1024 }, (err) => (err ? reject(err) : resolve(path.join(outDir, 'p.xml'))));
  });
}

const decode = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));

/** Group text runs into lines (same baseline, close together) so split captions are joined. */
function lines(texts) {
  const sorted = [...texts].sort((a, b) => a.top - b.top || a.left - b.left);
  const out = [];
  for (const t of sorted) {
    const l = out.find((o) => Math.abs(o.top - t.top) <= 3 && t.left - (o.left + o.width) < 25 && t.left >= o.left);
    if (l) { l.text += ' ' + t.text; l.width = t.left + t.width - l.left; l.height = Math.max(l.height, t.height); }
    else out.push({ ...t });
  }
  return out;
}

/** Text lines and images (with files) on one PDF page, positioned in pdftohtml's page units. */
async function pageLayout(pdf, page, dir) {
  const xml = fs.readFileSync(await pdftohtml(pdf, page, dir), 'utf8');
  const pageH = Number((xml.match(/<page [^>]*height="(\d+)"/) || [])[1] || 1188);
  const pageW = Number((xml.match(/<page [^>]*width="(\d+)"/) || [])[1] || 918);
  const texts = [...xml.matchAll(/<text top="(-?\d+)" left="(-?\d+)" width="(\d+)" height="(\d+)"[^>]*>(.*?)<\/text>/g)]
    .map((m) => ({ top: +m[1], left: +m[2], width: +m[3], height: +m[4], text: decode(m[5]).trim() })).filter((t) => t.text);
  const images = [...xml.matchAll(/<image top="(-?\d+)" left="(-?\d+)" width="(\d+)" height="(\d+)" src="([^"]+)"/g)]
    .map((m) => ({ top: +m[1], left: +m[2], width: +m[3], height: +m[4], src: path.isAbsolute(m[5]) ? m[5] : path.join(dir, path.basename(m[5])) }))
    .filter((im) => fs.existsSync(im.src));
  return { pageH, pageW, texts, lines: lines(texts), images };
}

/**
 * Give each image the text lines that belong to it: lines printed on the image (gallery captions) or
 * beside/above it within its vertical span (plan captions). Page titles and headers are skipped.
 */
function captionImages(layout, { minW = 150, minH = 120 } = {}) {
  const imgs = layout.images.filter((im) => im.width >= minW && im.height >= minH).map((im) => ({ ...im, caption: [] }));
  for (const l of layout.lines) {
    if (l.top < layout.pageH * 0.08 || /^(Floor\s*Plans?|Property Gallery|Gallery|Photos|Site Plan|For Lease)$/i.test(l.text)) continue;
    let best = null;
    for (const im of imgs) {
      const inSpan = l.top >= im.top - 30 && l.top <= im.top + im.height;
      const hgap = l.left > im.left + im.width ? l.left - (im.left + im.width) : im.left > l.left + l.width ? im.left - (l.left + l.width) : 0;
      const vgap = l.top > im.top + im.height ? l.top - (im.top + im.height) : im.top > l.top ? im.top - l.top : 0;
      const score = inSpan ? hgap : 1000 + vgap + hgap;
      if (score > (inSpan ? 220 : 1060)) continue;
      if (!best || score < best.score) best = { im, score };
    }
    if (best) best.im.caption.push(l);
  }
  // A full-bleed cover photo has the whole page's text printed over it; that isn't a caption.
  return imgs.map((im) => ({ ...im, captionText: im.width > layout.pageW * 0.85 && im.height > layout.pageH * 0.5 ? '' : im.caption.sort((a, b) => a.top - b.top || a.left - b.left).map((c) => c.text).join(' · ') }));
}

/**
 * Scan the given pages for captioned floor plan images.
 * Returns [{ page, caption, file (temp path), suiteIndex }]. Caller copies files it keeps.
 */
async function findFloorPlans(pdf, pages, suites, tmpRoot = os.tmpdir()) {
  const found = [];
  for (const page of pages) {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'fp-'));
    let xml;
    try { xml = fs.readFileSync(await pdftohtml(pdf, page, dir), 'utf8'); } catch { continue; }
    const pageH = Number((xml.match(/<page [^>]*height="(\d+)"/) || [])[1] || 1188);
    const texts = [...xml.matchAll(/<text top="(-?\d+)" left="(-?\d+)" width="(\d+)" height="(\d+)"[^>]*>(.*?)<\/text>/g)]
      .map((m) => ({ top: +m[1], left: +m[2], width: +m[3], height: +m[4], text: decode(m[5]).trim() })).filter((t) => t.text);
    const images = [...xml.matchAll(/<image top="(-?\d+)" left="(-?\d+)" width="(\d+)" height="(\d+)" src="([^"]+)"/g)]
      .map((m) => ({ top: +m[1], left: +m[2], width: +m[3], height: +m[4], src: path.isAbsolute(m[5]) ? m[5] : path.join(dir, path.basename(m[5])) }))
      .filter((im) => im.width >= 120 && im.height >= 120 && fs.existsSync(im.src)); // skip logos and icons
    const captions = lines(texts).filter((l) => CAPTION_RE.test(l.text) && !NOT_CAPTION_RE.test(l.text) && l.text.length < 90);
    const heading = captions.find((c) => /^Floor\s*Plans?$/i.test(c.text));
    const used = new Set();
    for (const c of captions) {
      if (c === heading) continue;
      // Nearest unused image that overlaps horizontally, within ~1/4 page vertically.
      let best = null;
      for (const im of images) {
        if (used.has(im)) continue;
        const overlap = Math.min(im.left + im.width, c.left + c.width) - Math.max(im.left, c.left);
        if (overlap < -40) continue;
        const gap = c.top >= im.top + im.height ? c.top - (im.top + im.height) : im.top >= c.top + c.height ? im.top - (c.top + c.height) : 0;
        if (gap > pageH / 4) continue;
        if (!best || gap < best.gap) best = { im, gap };
      }
      if (!best) continue;
      used.add(best.im);
      found.push({ page, caption: c.text, file: best.im.src, suiteIndex: matchSuite(c.text, suites) });
    }
    // A "Floor Plans" section with uncaptioned images: take the large images below the heading.
    if (heading) {
      for (const im of images) {
        if (used.has(im) || im.top < heading.top) continue;
        used.add(im);
        found.push({ page, caption: 'Floor plan', file: im.src, suiteIndex: -1 });
      }
    }
  }
  return found;
}

module.exports = { findFloorPlans, matchSuite, matchSuites, parseCaption, pageLayout, captionImages, CAPTION_RE };
