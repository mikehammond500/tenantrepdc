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

module.exports = { pageCount, pageTexts, largestImageOnPage, renderPage };
