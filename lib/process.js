'use strict';
// Turns an uploaded CoStar PDF into buildings/suites/photos for a survey.
const path = require('path');
const fs = require('fs');
const { db, surveyDir, tx } = require('./db');
const pdf = require('./pdf');
const { extract } = require('./heuristic');
const { geocode } = require('./geocode');

const BUILDING_COLS = ['name', 'address', 'city', 'state', 'zip', 'submarket', 'property_type', 'building_class',
  'rba_sf', 'year_built', 'renovated', 'stories', 'typical_floor', 'parking', 'available_size', 'asking_rent',
  'service_type', 'occupancy', 'term', 'overview'];
const SUITE_COLS = ['address', 'floor', 'floor_status', 'suite', 'space_use', 'lease_type', 'sf', 'sf_max',
  'floor_contig', 'bldg_contig', 'rent', 'rent_type', 'occupancy', 'term'];

const setStatus = (id, status, detail) =>
  db.prepare('UPDATE surveys SET status = ?, status_detail = ? WHERE id = ?').run(status, detail || null, id);

async function processSurvey(surveyId, pdfPath) {
  const dir = surveyDir(surveyId);
  try {
    setStatus(surveyId, 'processing', 'Reading PDF');
    const pages = await pdf.pageTexts(pdfPath);
    const { buildings } = extract(pages);
    if (!buildings.length) throw new Error('No properties found. Is this a CoStar property report?');

    setStatus(surveyId, 'processing', `Found ${buildings.length} buildings; extracting photos`);
    for (const b of buildings) {
      const stem = `b${b.item_number}`;
      const photo = await pdf.largestImageOnPage(pdfPath, b.first_page, path.join(dir, `${stem}-photo`)).catch(() => null);
      b.photo = photo && path.basename(photo);
      const lp = await pdf.renderPage(pdfPath, b.first_page, path.join(dir, `${stem}-listing`)).catch(() => null);
      b.listing_page = lp && path.basename(lp);
      for (const fp of b.floor_plans) {
        const f = await pdf.renderPage(pdfPath, fp.page, path.join(dir, `${stem}-fp-p${fp.page}`), 130).catch(() => null);
        fp.file = f && path.basename(f);
      }
    }

    tx(() => {
      const insB = db.prepare(`INSERT INTO buildings (survey_id, ord, ${BUILDING_COLS.join(', ')}, highlights, photo, listing_page, source_page)
        VALUES (?, ?, ${BUILDING_COLS.map(() => '?').join(', ')}, ?, ?, ?, ?)`);
      const insS = db.prepare(`INSERT INTO suites (building_id, ord, ${SUITE_COLS.join(', ')}) VALUES (?, ?, ${SUITE_COLS.map(() => '?').join(', ')})`);
      const insF = db.prepare('INSERT INTO floor_plans (building_id, suite_id, caption, file) VALUES (?, ?, ?, ?)');
      for (const b of buildings) {
        const { lastInsertRowid: bid } = insB.run(surveyId, b.item_number, ...BUILDING_COLS.map((c) => b[c] ?? null),
          JSON.stringify(b.highlights || []), b.photo || null, b.listing_page || null, b.first_page);
        const suiteIds = {};
        b.suites.forEach((s, i) => {
          const { lastInsertRowid } = insS.run(bid, i, ...SUITE_COLS.map((c) => s[c] ?? null));
          if (s.suite) suiteIds[String(s.suite).toLowerCase()] = lastInsertRowid;
        });
        for (const fp of b.floor_plans) {
          if (fp.file) insF.run(bid, (fp.suite && suiteIds[fp.suite.toLowerCase()]) || null, fp.caption, fp.file);
        }
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

module.exports = { processSurvey };
