'use strict';
// Turns an uploaded CoStar PDF into buildings/suites/photos/floor plans for a survey.
const path = require('path');
const fs = require('fs');
const { db, surveyDir, tx, DATA_DIR } = require('./db');
const pdf = require('./pdf');
const { extract } = require('./heuristic');
const { geocode } = require('./geocode');
const { findFloorPlans } = require('./floorplans');

const BUILDING_COLS = ['name', 'address', 'city', 'state', 'zip', 'submarket', 'property_type', 'building_class',
  'rba_sf', 'year_built', 'renovated', 'stories', 'typical_floor', 'parking', 'available_size', 'asking_rent',
  'service_type', 'occupancy', 'term', 'overview'];
const SUITE_COLS = ['address', 'floor', 'floor_status', 'suite', 'space_use', 'lease_type', 'sf', 'sf_max',
  'floor_contig', 'bldg_contig', 'rent', 'rent_type', 'occupancy', 'term'];

const setStatus = (id, status, detail) =>
  db.prepare('UPDATE surveys SET status = ?, status_detail = ? WHERE id = ?').run(status, detail || null, id);

/** Star rating, floor plans (with suite matching) for one parsed building. Files go in `dir`. */
async function enrichParsed(pdfPath, b, dir, stem) {
  b.costar_rating = null;
  for (const p of [b.first_page, ...(b.pages || [])]) {
    b.costar_rating = await pdf.starRating(pdfPath, p).catch(() => null);
    if (b.costar_rating != null) break;
  }
  const tmp = fs.mkdtempSync(path.join(DATA_DIR, 'tmp-fp-'));
  try {
    const plans = await findFloorPlans(pdfPath, b.pages || [b.first_page], b.suites, tmp).catch(() => []);
    b.floor_plan_files = plans.map((fp, i) => {
      const name = `${stem}-fp${i + 1}${path.extname(fp.file) || '.jpg'}`;
      fs.copyFileSync(fp.file, path.join(dir, name));
      return { caption: fp.caption, file: name, suiteIndex: fp.suiteIndex };
    });
    // Captioned floor plan pages where no image could be pulled out: use the whole page.
    const covered = new Set(plans.map((p) => p.page));
    for (const fp of b.floor_plans || []) {
      if (covered.has(fp.page)) continue;
      const f = await pdf.renderPage(pdfPath, fp.page, path.join(dir, `${stem}-fp-p${fp.page}`), 130).catch(() => null);
      if (f) {
        const { matchSuite } = require('./floorplans');
        b.floor_plan_files.push({ caption: fp.caption, file: path.basename(f), suiteIndex: matchSuite(fp.caption, b.suites) });
      }
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

async function processSurvey(surveyId, pdfPath) {
  const dir = surveyDir(surveyId);
  try {
    setStatus(surveyId, 'processing', 'Reading PDF');
    const pages = await pdf.pageTexts(pdfPath);
    const { buildings } = extract(pages);
    if (!buildings.length) throw new Error('No properties found. Is this a CoStar property report?');

    setStatus(surveyId, 'processing', `Found ${buildings.length} buildings; extracting photos, ratings and floor plans`);
    for (const b of buildings) {
      const stem = `b${b.item_number}`;
      const photo = await pdf.largestImageOnPage(pdfPath, b.first_page, path.join(dir, `${stem}-photo`)).catch(() => null);
      b.photo = photo && path.basename(photo);
      const lp = await pdf.renderPage(pdfPath, b.first_page, path.join(dir, `${stem}-listing`)).catch(() => null);
      b.listing_page = lp && path.basename(lp);
      await enrichParsed(pdfPath, b, dir, stem);
    }

    tx(() => {
      const insB = db.prepare(`INSERT INTO buildings (survey_id, ord, ${BUILDING_COLS.join(', ')}, highlights, photo, listing_page, source_page, source_pages, costar_rating, details, enriched)
        VALUES (?, ?, ${BUILDING_COLS.map(() => '?').join(', ')}, ?, ?, ?, ?, ?, ?, ?, 1)`);
      const insS = db.prepare(`INSERT INTO suites (building_id, ord, ${SUITE_COLS.join(', ')}) VALUES (?, ?, ${SUITE_COLS.map(() => '?').join(', ')})`);
      const insF = db.prepare('INSERT INTO floor_plans (building_id, suite_id, caption, file) VALUES (?, ?, ?, ?)');
      for (const b of buildings) {
        const { lastInsertRowid: bid } = insB.run(surveyId, b.item_number, ...BUILDING_COLS.map((c) => b[c] ?? null),
          JSON.stringify(b.highlights || []), b.photo || null, b.listing_page || null, b.first_page,
          JSON.stringify(b.pages || []), b.costar_rating, JSON.stringify(b.details || []));
        const suiteIds = b.suites.map((s, i) => insS.run(bid, i, ...SUITE_COLS.map((c) => s[c] ?? null)).lastInsertRowid);
        for (const fp of b.floor_plan_files || []) insF.run(bid, fp.suiteIndex >= 0 ? suiteIds[fp.suiteIndex] : null, fp.caption, fp.file);
      }
    });

    setStatus(surveyId, 'processing', 'Locating buildings on the map');
    const rows = db.prepare('SELECT id, address, city, state, zip FROM buildings WHERE survey_id = ?').all(surveyId);
    let missing = 0;
    for (const r of rows) {
      const hit = await geocode(r);
      if (hit) db.prepare('UPDATE buildings SET lat = ?, lng = ?, geocode_status = ? WHERE id = ?').run(hit.lat, hit.lng, hit.source, r.id);
      else { missing++; db.prepare("UPDATE buildings SET geocode_status = 'not_found' WHERE id = ?").run(r.id); }
    }
    setStatus(surveyId, 'ready', missing ? `${missing} building(s) could not be located; place them on the map in the editor.` : null);
  } catch (err) {
    console.error('processSurvey failed', err);
    setStatus(surveyId, 'error', err.message.split('\n')[0]);
  }
}

/**
 * Upgrade surveys created before ratings/details/floor-plan matching existed. Re-reads the stored PDF
 * and fills in only what's missing, so your edits and the client's votes are kept.
 */
async function enrichExisting() {
  const surveys = db.prepare(`SELECT DISTINCT s.id FROM surveys s JOIN buildings b ON b.survey_id = s.id
    WHERE s.status = 'ready' AND b.enriched = 0`).all();
  for (const { id } of surveys) {
    const pdfPath = path.join(DATA_DIR, 'files', String(id), 'source.pdf');
    if (!fs.existsSync(pdfPath)) continue;
    try {
      const { buildings } = extract(await pdf.pageTexts(pdfPath));
      const dir = surveyDir(id);
      for (const row of db.prepare('SELECT * FROM buildings WHERE survey_id = ? AND enriched = 0').all(id)) {
        const b = buildings.find((x) => x.item_number === row.ord && x.address === row.address) || buildings.find((x) => x.first_page === row.source_page);
        if (!b) { db.prepare('UPDATE buildings SET enriched = 1 WHERE id = ?').run(row.id); continue; }
        const suites = db.prepare('SELECT * FROM suites WHERE building_id = ? ORDER BY ord, id').all(row.id);
        b.suites = suites; // match floor plans against the suites as they are now
        await enrichParsed(pdfPath, b, dir, `b${row.id}-r`);
        const fill = {};
        for (const c of BUILDING_COLS) if ((row[c] == null || row[c] === '') && b[c] != null) fill[c] = b[c];
        const keys = Object.keys(fill);
        db.prepare(`UPDATE buildings SET costar_rating = COALESCE(costar_rating, ?), details = ?, source_pages = ?, enriched = 1
          ${keys.map((k) => `, ${k} = ?`).join('')} WHERE id = ?`)
          .run(b.costar_rating, JSON.stringify(b.details || []), JSON.stringify(b.pages || []), ...keys.map((k) => fill[k]), row.id);
        const hasPlans = db.prepare('SELECT COUNT(*) AS n FROM floor_plans WHERE building_id = ?').get(row.id).n;
        if (!hasPlans) {
          const ins = db.prepare('INSERT INTO floor_plans (building_id, suite_id, caption, file) VALUES (?, ?, ?, ?)');
          for (const fp of b.floor_plan_files || []) ins.run(row.id, fp.suiteIndex >= 0 ? suites[fp.suiteIndex].id : null, fp.caption, fp.file);
        }
      }
      console.log(`Upgraded survey ${id} with ratings, details and floor plans`);
    } catch (e) { console.error('enrichExisting failed for survey', id, e.message); }
  }
}

module.exports = { processSurvey, enrichExisting };
