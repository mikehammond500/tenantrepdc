'use strict';
// Thin wrappers around poppler-utils (pdftotext, pdfimages, pdftoppm, pdfinfo).
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) { err.message += `\n${stderr}`; reject(err); } else resolve(stdout);
    });
  });
}

async function pageCount(pdf) {
  const out = await run('pdfinfo', [pdf]);
  const m = out.match(/Pages:\s+(\d+)/);
  return m ? Number(m[1]) : 0;
}

/** Returns an array of page texts (index 0 = page 1), layout-preserved. */
async function pageTexts(pdf) {
  const out = await run('pdftotext', ['-layout', pdf, '-']);
  const pages = out.split('\f');
  if (pages.length && pages[pages.length - 1].trim() === '') pages.pop();
  return pages;
}

/** Extract the largest photo-like image on a page. Returns the written file path or null. */
async function largestImageOnPage(pdf, page, destNoExt) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pimg-'));
  try {
    await run('pdfimages', ['-f', String(page), '-l', String(page), '-j', '-png', pdf, path.join(tmp, 'i')]);
    let best = null;
    for (const f of fs.readdirSync(tmp)) {
      if (!/\.(jpg|png)$/i.test(f)) continue;
      const size = fs.statSync(path.join(tmp, f)).size;
      if (size < 8000) continue; // skip logos, icons, rules
      if (!best || size > best.size) best = { f, size };
    }
    if (!best) return null;
    const ext = path.extname(best.f).toLowerCase();
    const dest = destNoExt + ext;
    fs.copyFileSync(path.join(tmp, best.f), dest);
    return dest;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Render a single page to JPEG. Returns the file path. */
async function renderPage(pdf, page, destNoExt, dpi = 110) {
  await run('pdftoppm', ['-f', String(page), '-l', String(page), '-r', String(dpi), '-jpeg',
    '-jpegopt', 'quality=80', '-singlefile', pdf, destNoExt]);
  return destNoExt + '.jpg';
}

/**
 * CoStar draws its 1-5 star rating as vector shapes in the top-right of each property page:
 * filled stars are blue, empty stars are gray outlines. Render that corner and count the
 * separate blue shapes. Returns 0-5, or null when no stars are drawn (unrated).
 */
async function starRating(pdf, page) {
  const buf = await new Promise((resolve, reject) => execFile('pdftoppm',
    ['-f', String(page), '-l', String(page), '-r', '144', '-x', '900', '-y', '30', '-W', '324', '-H', '70', pdf],
    { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 }, (e, out) => (e ? reject(e) : resolve(out))));
  // Parse binary PPM (P6) header.
  let i = 0;
  const tok = () => { while (/\s/.test(String.fromCharCode(buf[i]))) i++; let s = ''; while (!/\s/.test(String.fromCharCode(buf[i]))) s += String.fromCharCode(buf[i++]); return s; };
  if (tok() !== 'P6') return null;
  const W = +tok(), H = +tok(); tok(); i++;
  const rgb = (x, y) => { const p = i + (y * W + x) * 3; return [buf[p], buf[p + 1], buf[p + 2]]; };
  const isBlue = (x, y) => { const [r, , b] = rgb(x, y); return b > 120 && b - r > 60; };
  const isGray = (x, y) => { const [r, , b] = rgb(x, y); return r < 225 && r > 100 && Math.abs(r - b) < 15; };
  const runs = (fn) => {
    const out = []; let w = 0;
    for (let x = 0; x <= W; x++) {
      let hit = false;
      if (x < W) for (let y = 0; y < H && !hit; y++) hit = fn(x, y);
      if (hit) w++; else if (w) { out.push(w); w = 0; }
    }
    return out;
  };
  const starW = (w) => w >= 14 && w <= 32; // one star is ~22px wide at 144dpi
  const filled = runs(isBlue).filter(starW).length;
  const empty = runs(isGray).filter(starW).length;
  if (filled + empty < 5 && filled === 0) return null;
  return Math.min(5, filled);
}

module.exports = { pageCount, pageTexts, largestImageOnPage, renderPage, starRating };
