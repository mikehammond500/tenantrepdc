'use strict';
// Turns broker uploads (building flyers, photos, floor plans) into gallery items for a building.
//
// Images (JPG/PNG/WebP) become photos, or floor plans when the file name says so ("Suite 350 plan.png").
// PDF flyers are read page by page, using where text sits relative to each picture:
//   - "Floor Plans" pages: each plan image is cut out with the caption beside it ("Second Floor ·
//     Suite 200: 3,151 SF · Suite 210: 1,976 SF") and attached to every suite it names.
//   - Photo pages ("Property Gallery", the cover): each photo is cut out with the caption printed on it.
//   - Every page is also kept as a full-page image ("flyer page") and the PDF is kept for download.
// Pages and PDFs that carry listing-broker contact details (emails / phone numbers) start hidden from
// clients; the broker can show them with one click.
const fs = require('fs');
const os = require('os');
const path = require('path');
const pdf = require('./pdf');
const { matchSuite, matchSuites, pageLayout, captionImages, CAPTION_RE } = require('./floorplans');

const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
// A file name marks an image as a floor plan only if it says so; "Suite 330 view.jpg" stays a photo.
const PLAN_NAME_RE = /floor\s*-?\s*plans?|space\s*plans?|test\s*-?\s*fits?|\bplans?\b/i;
const PLAN_PAGE_RE = /floor\s*plans?\b|space\s*plans?\b|test\s*fits?\b/i;
const PHOTO_PAGE_RE = /\b(gallery|photos|photography|images)\b/i;
const CONTACT_RE = /[\w.+-]+@[\w-]+\.[\w.]+|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\+1\s?\d{3}\s?\d{3}\s?\d{4}/;
const MAX_PDF_PAGES = 30;

async function ingest(file, b, suites, dir) {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const stem = `b${b.id}-u${stamp}`;
  const name = file.originalname || 'upload';
  const base = name.replace(/\.[^.]+$/, '');
  const out = { media: [], plans: [] };

  if (IMAGE_EXT[file.mimetype]) {
    const dest = stem + IMAGE_EXT[file.mimetype];
    fs.copyFileSync(file.path, path.join(dir, dest));
    if (PLAN_NAME_RE.test(base)) {
      const idx = matchSuites(base, suites);
      if (idx.length) for (const i of idx) out.plans.push({ caption: base, file: dest, suite_id: suites[i].id });
      else out.plans.push({ caption: base, file: dest, suite_id: null });
    } else out.media.push({ kind: 'photo', caption: null, file: dest, source: name });
    return out;
  }
  if (/heic|heif/i.test(file.mimetype) || /\.hei[cf]$/i.test(name)) {
    throw new Error(`${name}: iPhone HEIC photos can't be shown in web browsers. Export as JPG (in Photos: Share → Save as JPEG, or set Camera → Formats → Most Compatible) and upload again.`);
  }
  if (file.mimetype !== 'application/pdf' && !/\.pdf$/i.test(name)) throw new Error(`${name}: use a PDF, JPG, PNG or WebP file.`);

  const texts = await pdf.pageTexts(file.path).catch(() => []);
  const n = Math.min(await pdf.pageCount(file.path), MAX_PDF_PAGES);
  const anyContacts = texts.some((t) => CONTACT_RE.test(t));
  const pdfName = `${stem}.pdf`;
  fs.copyFileSync(file.path, path.join(dir, pdfName));
  out.media.push({ kind: 'pdf', caption: base, file: pdfName, source: name, hidden: anyContacts ? 1 : 0 });

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flyer-'));
  try {
    for (let p = 1; p <= n; p++) {
      const text = texts[p - 1] || '';
      const words = text.split(/\s+/).filter(Boolean).length;
      const pageImg = path.basename(await pdf.renderPage(file.path, p, path.join(dir, `${stem}-p${p}`), 130));
      const hasContacts = CONTACT_RE.test(text);
      out.media.push({ kind: 'flyer_page', caption: `${base} · page ${p}`, file: pageImg, source: name, hidden: hasContacts ? 1 : 0 });

      const planPage = PLAN_PAGE_RE.test(text) || (CAPTION_RE.test(text) && /\bSuite\b/i.test(text) && words < 80) || (n === 1 && PLAN_NAME_RE.test(base));
      const photoPage = !planPage && !hasContacts && (PHOTO_PAGE_RE.test(text) || words < 70);
      if (!planPage && !photoPage) continue;

      const dirP = fs.mkdtempSync(path.join(tmpRoot, `p${p}-`));
      let imgs = [];
      try { imgs = captionImages(await pageLayout(file.path, p, dirP), planPage ? {} : { minW: 250, minH: 180 }); } catch { imgs = []; }
      if (planPage) {
        if (!imgs.length) {
          // Plans drawn as vector art (no embedded picture): use the whole page.
          const cap = text.split('\n').map((l) => l.trim()).filter((l) => CAPTION_RE.test(l) || /\bSuite\b/i.test(l)).join(' · ').replace(/\s{2,}/g, ' ') || `${base} · page ${p}`;
          const idx = matchSuites(cap, suites);
          (idx.length ? idx : [null]).forEach((i) => out.plans.push({ caption: cap, file: pageImg, suite_id: i == null ? null : suites[i].id }));
          continue;
        }
        imgs.forEach((im, k) => {
          const dest = `${stem}-p${p}-plan${k + 1}${path.extname(im.src)}`;
          fs.copyFileSync(im.src, path.join(dir, dest));
          const cap = im.captionText || `${base} · floor plan`;
          const idx = matchSuites(cap, suites);
          (idx.length ? idx : [null]).forEach((i) => out.plans.push({ caption: cap, file: dest, suite_id: i == null ? null : suites[i].id }));
        });
      } else {
        imgs.forEach((im, k) => {
          const dest = `${stem}-p${p}-photo${k + 1}${path.extname(im.src)}`;
          fs.copyFileSync(im.src, path.join(dir, dest));
          out.media.push({ kind: 'photo', caption: im.captionText || null, file: dest, source: name, hidden: 0 });
        });
      }
    }
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
  return out;
}

module.exports = { ingest };
