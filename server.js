'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { db, DATA_DIR, surveyDir, tx } = require('./lib/db');
const { processSurvey, enrichExisting, reimportSurvey } = require('./lib/process');
const { matchSuite } = require('./lib/floorplans');
const media = require('./lib/media');
const { geocode } = require('./lib/geocode');
const pdf = require('./lib/pdf');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD is not set; admin login is disabled.');

const APP_VERSION = (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || `dev-${Date.now().toString(36)}`;
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });

const PUB = path.join(__dirname, 'public');
// Serve HTML with versioned asset URLs so browsers pick up new JS/CSS right after a deploy.
const pageCache = {};
function sendPage(res, rel, status = 200) {
  if (!pageCache[rel]) {
    pageCache[rel] = fs.readFileSync(path.join(PUB, rel), 'utf8')
      .replace(/((?:src|href)="\/(?:js|css)\/[^"?]+)"/g, `$1?v=${APP_VERSION}"`);
  }
  res.status(status).set('Cache-Control', 'no-cache').type('html').send(pageCache[rel]);
}
const upload = multer({ dest: path.join(DATA_DIR, 'tmp'), limits: { fileSize: 80 * 1024 * 1024 } });
const newToken = () => crypto.randomBytes(16).toString('base64url'); // 128-bit, 22 chars

// ---------- admin auth (signed cookie) ----------
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');
function readCookie(req, name) {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function isAdmin(req) {
  const c = readCookie(req, 'tc_admin');
  if (!c) return false;
  const [exp, sig] = c.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign('admin:' + exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
const requireAdmin = (req, res, next) => isAdmin(req) ? next()
  : req.originalUrl.startsWith('/api/') ? res.status(401).json({ error: 'login required' }) : res.redirect('/admin/login');

const loginAttempts = new Map();
app.post('/admin/login', express.urlencoded({ extended: false }), (req, res) => {
  const ip = req.ip;
  const a = loginAttempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) return res.status(429).send('Too many attempts. Try again in 15 minutes.');
  const pw = String(req.body.password || '');
  const ok = ADMIN_PASSWORD && pw.length === ADMIN_PASSWORD.length &&
    crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(ADMIN_PASSWORD));
  if (!ok) { a.n++; loginAttempts.set(ip, a); return res.redirect('/admin/login?error=1'); }
  loginAttempts.delete(ip);
  const exp = String(Date.now() + 30 * 24 * 3600e3);
  res.cookie('tc_admin', `${exp}.${sign('admin:' + exp)}`, {
    httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 30 * 24 * 3600e3, path: '/',
  });
  res.redirect('/admin');
});
app.post('/admin/logout', (req, res) => { res.clearCookie('tc_admin', { path: '/' }); res.redirect('/admin/login'); });
app.get('/admin/login', (req, res) => sendPage(res, 'admin/login.html'));
app.get('/admin', requireAdmin, (req, res) => sendPage(res, 'admin/index.html'));
app.get('/admin/surveys/:id', requireAdmin, (req, res) => sendPage(res, 'admin/survey.html'));

// ---------- data helpers ----------
const getSurvey = (id) => db.prepare('SELECT * FROM surveys WHERE id = ?').get(id);
function surveyPayload(survey, { admin }) {
  const buildings = db.prepare(`SELECT * FROM buildings WHERE survey_id = ? ${admin ? '' : 'AND hidden = 0'} ORDER BY ord, id`).all(survey.id);
  const suites = db.prepare('SELECT s.* FROM suites s JOIN buildings b ON b.id = s.building_id WHERE b.survey_id = ? ORDER BY s.ord, s.id').all(survey.id);
  const plans = db.prepare(`SELECT f.* FROM floor_plans f JOIN buildings b ON b.id = f.building_id WHERE b.survey_id = ? ${admin ? '' : 'AND f.hidden = 0'} ORDER BY f.id`).all(survey.id);
  const mediaRows = db.prepare(`SELECT m.* FROM media m JOIN buildings b ON b.id = m.building_id WHERE b.survey_id = ? ${admin ? '' : 'AND m.hidden = 0'} ORDER BY CASE m.kind WHEN 'photo' THEN 0 WHEN 'flyer_page' THEN 1 ELSE 2 END, m.ord, m.id`).all(survey.id);
  const votes = db.prepare('SELECT building_id, vote, comment, updated_at FROM votes WHERE survey_id = ?').all(survey.id);
  const vmap = Object.fromEntries(votes.map((v) => [v.building_id, v]));
  const fileBase = admin ? `/admin/files/${survey.id}/` : `/s/${survey.token}/files/`;
  const out = buildings.map((b) => ({
    ...b,
    highlights: safeJson(b.highlights, []),
    details: safeJson(b.details, []),
    source_pages: undefined, enriched: undefined,
    photo_url: b.photo ? fileBase + b.photo : null,
    listing_page_url: admin && b.listing_page ? fileBase + b.listing_page : undefined,
    listing_page: undefined,
    broker_notes: b.broker_notes,
    suites: suites.filter((s) => s.building_id === b.id),
    floor_plans: plans.filter((f) => f.building_id === b.id).map((f) => ({ id: f.id, suite_id: f.suite_id, caption: f.caption, url: fileBase + f.file, ...(admin ? { hidden: !!f.hidden, source: f.source } : {}) })),
    media: mediaRows.filter((m) => m.building_id === b.id).map((m) => ({ id: m.id, kind: m.kind, caption: m.caption, url: fileBase + m.file, ...(admin ? { hidden: !!m.hidden, source: m.source, file: m.file } : {}) })),
    vote: vmap[b.id] || null,
  }));
  const s = { id: survey.id, title: survey.title, client_name: survey.client_name, status: survey.status, created_at: survey.created_at, nnn_estimate: survey.nnn_estimate,
    ruled_out: db.prepare('SELECT id, name, address, reason, created_at, updated_at FROM ruled_out WHERE survey_id = ? ORDER BY created_at DESC, id DESC').all(survey.id) };
  if (admin) Object.assign(s, { archived: !!survey.archived, token: survey.token, pdf_name: survey.pdf_name, status_detail: survey.status_detail, view_count: survey.view_count, last_viewed_at: survey.last_viewed_at });
  return { survey: s, buildings: out };
}
const safeJson = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

function sendFileFrom(res, surveyId, file) {
  if (!/^[\w.\-]+$/.test(file)) return res.sendStatus(404);
  const p = path.join(DATA_DIR, 'files', String(surveyId), file);
  if (!fs.existsSync(p)) return res.sendStatus(404);
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(p);
}

// ---------- admin API ----------
const A = express.Router();
A.use(requireAdmin);

A.get('/surveys', (req, res) => {
  res.json(db.prepare(`
    SELECT s.id, s.title, s.client_name, s.status, s.status_detail, s.created_at, s.token, s.view_count, s.last_viewed_at, s.archived,
      (SELECT COUNT(*) FROM buildings b WHERE b.survey_id = s.id AND b.hidden = 0 AND b.ruled_out = 0) AS building_count,
      ((SELECT COUNT(*) FROM buildings b WHERE b.survey_id = s.id AND b.hidden = 0 AND b.ruled_out = 1) + (SELECT COUNT(*) FROM ruled_out r WHERE r.survey_id = s.id)) AS ruled_out_count,
      (SELECT COUNT(*) FROM votes v WHERE v.survey_id = s.id AND v.vote = 1) AS up,
      (SELECT COUNT(*) FROM votes v WHERE v.survey_id = s.id AND v.vote = -1) AS down,
      (SELECT MAX(updated_at) FROM votes v WHERE v.survey_id = s.id) AS last_vote_at
    FROM surveys s ORDER BY s.created_at DESC, s.id DESC`).all());
});

A.post('/surveys', upload.single('pdf'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach a CoStar PDF.' });
  const title = String(req.body.title || '').trim() || req.file.originalname.replace(/\.pdf$/i, '');
  const { lastInsertRowid: id } = db.prepare('INSERT INTO surveys (token, title, client_name, pdf_name) VALUES (?, ?, ?, ?)')
    .run(newToken(), title, String(req.body.client_name || '').trim() || null, req.file.originalname);
  const dest = path.join(surveyDir(id), 'source.pdf');
  fs.renameSync(req.file.path, dest);
  processSurvey(Number(id), dest); // runs in background; the UI polls status
  res.json({ id: Number(id) });
});

A.get('/surveys/:id', (req, res) => {
  const s = getSurvey(req.params.id);
  if (!s) return res.sendStatus(404);
  res.json(surveyPayload(s, { admin: true }));
});

A.patch('/surveys/:id', (req, res) => {
  const s = getSurvey(req.params.id);
  if (!s) return res.sendStatus(404);
  const { title = s.title, client_name = s.client_name } = req.body;
  let nnn = 'nnn_estimate' in req.body ? req.body.nnn_estimate : s.nnn_estimate;
  nnn = nnn === '' || nnn == null ? null : Number(String(nnn).replace(/[$,]/g, ''));
  if (nnn != null && !(nnn >= 0 && nnn < 1000)) return res.status(400).json({ error: 'Enter NNN as dollars per SF per year, e.g. 9.50' });
  const archived = 'archived' in req.body ? (req.body.archived ? 1 : 0) : s.archived;
  if (!String(title || '').trim()) return res.status(400).json({ error: 'The survey needs a name.' });
  db.prepare('UPDATE surveys SET title = ?, client_name = ?, nnn_estimate = ?, archived = ? WHERE id = ?').run(String(title).trim(), client_name, nnn, archived, s.id);
  res.json({ ok: true });
});

// Copy a survey (buildings, suites, floor plans, photos, your notes and NNN settings) with a new private link.
// Client votes, notes and view counts are not copied, so it's ready to send to someone new.
A.post('/surveys/:id/duplicate', (req, res) => {
  const s = getSurvey(req.params.id);
  if (!s) return res.sendStatus(404);
  if (s.status === 'processing') return res.status(409).json({ error: 'Wait for this survey to finish processing first.' });
  const title = String(req.body.title || '').trim() || `${s.title} (copy)`;
  const client = 'client_name' in req.body ? (String(req.body.client_name || '').trim() || null) : s.client_name;
  const newId = tx(() => {
    const { lastInsertRowid } = db.prepare(`INSERT INTO surveys (token, title, client_name, pdf_name, status, status_detail, nnn_estimate)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(newToken(), title, client, s.pdf_name, s.status, s.status_detail, s.nnn_estimate);
    const nid = Number(lastInsertRowid);
    const bcols = db.prepare('PRAGMA table_info(buildings)').all().map((c) => c.name).filter((c) => !['id', 'survey_id'].includes(c));
    const scols = db.prepare('PRAGMA table_info(suites)').all().map((c) => c.name).filter((c) => !['id', 'building_id'].includes(c));
    for (const b of db.prepare('SELECT * FROM buildings WHERE survey_id = ?').all(s.id)) {
      const nb = Number(db.prepare(`INSERT INTO buildings (survey_id, ${bcols.join(', ')}) VALUES (?, ${bcols.map(() => '?').join(', ')})`)
        .run(nid, ...bcols.map((c) => b[c])).lastInsertRowid);
      const suiteMap = {};
      for (const su of db.prepare('SELECT * FROM suites WHERE building_id = ?').all(b.id)) {
        suiteMap[su.id] = Number(db.prepare(`INSERT INTO suites (building_id, ${scols.join(', ')}) VALUES (?, ${scols.map(() => '?').join(', ')})`)
          .run(nb, ...scols.map((c) => su[c])).lastInsertRowid);
      }
      for (const f of db.prepare('SELECT * FROM floor_plans WHERE building_id = ?').all(b.id)) {
        db.prepare('INSERT INTO floor_plans (building_id, suite_id, caption, file, source, hidden) VALUES (?, ?, ?, ?, ?, ?)').run(nb, f.suite_id ? suiteMap[f.suite_id] ?? null : null, f.caption, f.file, f.source, f.hidden);
      }
      for (const m of db.prepare('SELECT * FROM media WHERE building_id = ?').all(b.id)) {
        db.prepare('INSERT INTO media (building_id, kind, caption, file, source, hidden, ord) VALUES (?, ?, ?, ?, ?, ?, ?)').run(nb, m.kind, m.caption, m.file, m.source, m.hidden, m.ord);
      }
    }
    for (const r of db.prepare('SELECT * FROM ruled_out WHERE survey_id = ?').all(s.id)) {
      db.prepare('INSERT INTO ruled_out (survey_id, name, address, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(nid, r.name, r.address, r.reason, r.created_at, r.updated_at);
    }
    return nid;
  });
  // Photos, floor plans and the source PDF live in the survey's folder; copy it.
  const from = path.join(DATA_DIR, 'files', String(s.id));
  if (fs.existsSync(from)) fs.cpSync(from, surveyDir(newId), { recursive: true });
  res.json({ id: newId });
});

A.post('/surveys/:id/rotate-link', (req, res) => {
  const token = newToken();
  db.prepare('UPDATE surveys SET token = ? WHERE id = ?').run(token, req.params.id);
  res.json({ token });
});

// Everything needed to debug an import, as plain text the broker can copy and paste.
A.get('/surveys/:id/diagnostics', async (req, res) => {
  const s = getSurvey(req.params.id);
  if (!s) return res.sendStatus(404);
  const run = (cmd, args) => new Promise((r) => require('child_process').execFile(cmd, args, (e, out, err) => r(String(out || err || (e && e.message) || '').trim())));
  const out = [];
  out.push(`App version: ${APP_VERSION}   Node: ${process.version}`);
  out.push(`PDF tool: ${(await run('pdftotext', ['-v'])).split('\n')[0]}`);
  out.push(`Survey ${s.id}: "${s.title}"  status=${s.status}  ${s.status_detail || ''}`);
  const bs = db.prepare('SELECT * FROM buildings WHERE survey_id = ? ORDER BY ord').all(s.id);
  out.push(`Buildings: ${bs.length}`);
  for (const b of bs) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM suites WHERE building_id = ?').get(b.id).n;
    const d = safeJson(b.details, []);
    out.push(`  #${b.ord} ${b.address} | avail=${b.available_size} | rent=${b.asking_rent} | built=${b.year_built} | parking=${b.parking} | stars=${b.costar_rating} | details=${d.length} | suites=${n} | enriched=${b.enriched}`);
  }
  const pdfPath = path.join(DATA_DIR, 'files', String(s.id), 'source.pdf');
  if (fs.existsSync(pdfPath)) {
    const pages = await pdf.pageTexts(pdfPath).catch((e) => [`(could not read PDF: ${e.message})`]);
    out.push(`PDF pages: ${pages.length}`);
    const { extract } = require('./lib/heuristic');
    const parsed = extract(pages).buildings;
    out.push(`Parser now finds: ${parsed.length} buildings; first: ${parsed[0] ? `${parsed[0].address}, ${parsed[0].details.length} details, ${parsed[0].suites.length} suites` : 'none'}`);
    out.push('--- Page 1 text (first 45 lines) ---');
    out.push(...(pages[0] || '').split('\n').slice(0, 45).map((l) => l.replace(/\s+$/, '').replace(/ /g, '·')));
  } else out.push('Stored PDF: MISSING');
  res.type('text').send(out.join('\n'));
});

// "Buildings ruled out": addresses outside the survey the broker has looked at and rejected, with the reason.
A.post('/surveys/:id/ruled-out', (req, res) => {
  if (!getSurvey(req.params.id)) return res.sendStatus(404);
  const { name = '', address = '', reason = '' } = req.body;
  if (!String(name).trim() && !String(address).trim()) return res.status(400).json({ error: 'Enter a building name or address.' });
  const r = db.prepare('INSERT INTO ruled_out (survey_id, name, address, reason) VALUES (?, ?, ?, ?)').run(req.params.id, String(name).trim() || null, String(address).trim() || null, String(reason).trim() || null);
  res.json({ id: Number(r.lastInsertRowid) });
});
A.patch('/ruled-out/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM ruled_out WHERE id = ?').get(req.params.id);
  if (!r) return res.sendStatus(404);
  const { name = r.name, address = r.address, reason = r.reason } = req.body;
  db.prepare("UPDATE ruled_out SET name = ?, address = ?, reason = ?, updated_at = datetime('now') WHERE id = ?").run(name || null, address || null, reason || null, r.id);
  res.json({ ok: true });
});
A.delete('/ruled-out/:id', (req, res) => { db.prepare('DELETE FROM ruled_out WHERE id = ?').run(req.params.id); res.json({ ok: true }); });

A.post('/surveys/:id/reimport', (req, res) => {
  const s = getSurvey(req.params.id);
  if (!s) return res.sendStatus(404);
  db.prepare("UPDATE surveys SET status = 'processing', status_detail = 'Re-reading PDF' WHERE id = ?").run(s.id);
  reimportSurvey(s.id).catch((e) => db.prepare("UPDATE surveys SET status = 'error', status_detail = ? WHERE id = ?").run(e.message, s.id));
  res.json({ ok: true });
});

A.post('/surveys/:id/reset-votes', (req, res) => {
  db.prepare('DELETE FROM votes WHERE survey_id = ?').run(req.params.id);
  res.json({ ok: true });
});

A.delete('/surveys/:id', (req, res) => {
  db.prepare('DELETE FROM surveys WHERE id = ?').run(req.params.id);
  fs.rmSync(path.join(DATA_DIR, 'files', String(Number(req.params.id))), { recursive: true, force: true });
  res.json({ ok: true });
});

const B_EDITABLE = ['name', 'address', 'city', 'state', 'zip', 'submarket', 'property_type', 'building_class', 'rba_sf',
  'year_built', 'renovated', 'stories', 'typical_floor', 'parking', 'available_size', 'asking_rent', 'service_type',
  'occupancy', 'term', 'overview', 'broker_notes', 'lat', 'lng', 'hidden', 'ord', 'costar_rating', 'nnn_override', 'tour_url', 'ruled_out', 'ruled_out_reason'];
const S_EDITABLE = ['address', 'floor', 'floor_status', 'suite', 'space_use', 'lease_type', 'sf', 'floor_contig',
  'bldg_contig', 'rent', 'rent_type', 'occupancy', 'term', 'notes', 'ord'];

function patch(table, allowed, id, body) {
  const keys = Object.keys(body).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  const vals = keys.map((k) => (body[k] === '' ? null : body[k]));
  db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...vals, id);
}

A.patch('/buildings/:id', (req, res) => {
  const body = { ...req.body };
  if ('details' in body) db.prepare('UPDATE buildings SET details = ? WHERE id = ?').run(JSON.stringify(body.details || []), req.params.id);
  if ('highlights' in body) db.prepare('UPDATE buildings SET highlights = ? WHERE id = ?').run(JSON.stringify(body.highlights || []), req.params.id);
  if ('lat' in body) db.prepare("UPDATE buildings SET geocode_status = 'manual' WHERE id = ?").run(req.params.id);
  if ('ruled_out' in body) db.prepare(`UPDATE buildings SET ruled_out_at = ${body.ruled_out ? "datetime('now')" : 'NULL'} WHERE id = ?`).run(req.params.id);
  if ('tour_url' in body && body.tour_url) {
    let u = String(body.tour_url).trim();
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    try { const parsed = new URL(u); if (!/^https?:$/.test(parsed.protocol)) throw 0; body.tour_url = parsed.href; }
    catch { return res.status(400).json({ error: 'That doesn\'t look like a web link. Paste the full virtual tour address, e.g. https://my.matterport.com/show/?m=…' }); }
  }
  patch('buildings', B_EDITABLE, req.params.id, body);
  res.json({ ok: true });
});

A.post('/buildings/:id/geocode', async (req, res) => {
  const b = db.prepare('SELECT * FROM buildings WHERE id = ?').get(req.params.id);
  if (!b) return res.sendStatus(404);
  const hit = await geocode(b);
  if (!hit) return res.status(422).json({ error: 'Address not found. Drag the pin or click the map to place it.' });
  db.prepare('UPDATE buildings SET lat = ?, lng = ?, geocode_status = ? WHERE id = ?').run(hit.lat, hit.lng, hit.source, b.id);
  res.json(hit);
});

A.delete('/buildings/:id', (req, res) => { db.prepare('DELETE FROM buildings WHERE id = ?').run(req.params.id); res.json({ ok: true }); });

A.post('/surveys/:id/buildings', (req, res) => {
  const max = db.prepare('SELECT COALESCE(MAX(ord), 0) AS m FROM buildings WHERE survey_id = ?').get(req.params.id).m;
  const { lastInsertRowid } = db.prepare('INSERT INTO buildings (survey_id, ord, name, address) VALUES (?, ?, ?, ?)')
    .run(req.params.id, max + 1, 'New building', req.body.address || null);
  res.json({ id: Number(lastInsertRowid) });
});

const imageUpload = multer({ dest: path.join(DATA_DIR, 'tmp'), limits: { fileSize: 40 * 1024 * 1024 } });
A.post('/buildings/:id/photo', imageUpload.single('file'), (req, res) => {
  const b = db.prepare('SELECT * FROM buildings WHERE id = ?').get(req.params.id);
  if (!b || !req.file) return res.sendStatus(400);
  const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[req.file.mimetype];
  if (!ext) { fs.rmSync(req.file.path, { force: true }); return res.status(400).json({ error: 'Use a JPG, PNG or WebP image.' }); }
  const name = `b${b.id}-photo-${Date.now()}${ext}`;
  fs.renameSync(req.file.path, path.join(surveyDir(b.survey_id), name));
  db.prepare('UPDATE buildings SET photo = ? WHERE id = ?').run(name, b.id);
  res.json({ ok: true });
});

// Flyers, brochures, photos and plan sets for one building (several files at once).
const mediaUpload = multer({ dest: path.join(DATA_DIR, 'tmp'), limits: { fileSize: 60 * 1024 * 1024, files: 30 } });
A.post('/buildings/:id/media', mediaUpload.array('files', 30), async (req, res) => {
  const b = db.prepare('SELECT * FROM buildings WHERE id = ?').get(req.params.id);
  if (!b) return res.sendStatus(404);
  const dir = surveyDir(b.survey_id);
  const suites = db.prepare('SELECT * FROM suites WHERE building_id = ? ORDER BY ord, id').all(b.id);
  const added = { photos: 0, flyer_pages: 0, pdfs: 0, floor_plans: 0, matched: 0 }, errors = [];
  const maxOrd = db.prepare('SELECT COALESCE(MAX(ord), 0) AS m FROM media WHERE building_id = ?').get(b.id).m;
  let ord = maxOrd;
  for (const f of req.files || []) {
    try {
      const r = await media.ingest(f, b, suites, dir);
      for (const m of r.media) {
        db.prepare('INSERT INTO media (building_id, kind, caption, file, source, ord, hidden) VALUES (?, ?, ?, ?, ?, ?, ?)').run(b.id, m.kind, m.caption, m.file, m.source, ++ord, m.hidden ? 1 : 0);
        if (m.hidden) added.hidden = (added.hidden || 0) + 1;
        added[m.kind === 'photo' ? 'photos' : m.kind === 'pdf' ? 'pdfs' : 'flyer_pages']++;
      }
      for (const p of r.plans) {
        if (p.suite_id == null && r.plans.some((q) => q.file === p.file && q.suite_id != null)) continue;
        db.prepare("INSERT INTO floor_plans (building_id, suite_id, caption, file, source) VALUES (?, ?, ?, ?, 'upload')").run(b.id, p.suite_id, p.caption, p.file);
        added.floor_plans++; if (p.suite_id) added.matched++;
      }
      // First photo for a building that has none becomes its main photo.
      const firstPhoto = r.media.find((m) => m.kind === 'photo');
      if (firstPhoto && !db.prepare('SELECT photo FROM buildings WHERE id = ?').get(b.id).photo) db.prepare('UPDATE buildings SET photo = ? WHERE id = ?').run(firstPhoto.file, b.id);
    } catch (e) { errors.push(e.message.split('\n')[0]); }
    finally { fs.rmSync(f.path, { force: true }); }
  }
  res.json({ added, errors });
});
A.patch('/media/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!m) return res.sendStatus(404);
  const { caption = m.caption, hidden = m.hidden, kind = m.kind } = req.body;
  if (!['photo', 'flyer_page', 'pdf'].includes(kind)) return res.status(400).json({ error: 'bad kind' });
  db.prepare('UPDATE media SET caption = ?, hidden = ?, kind = ? WHERE id = ?').run(caption, hidden ? 1 : 0, kind, m.id);
  res.json({ ok: true });
});
A.post('/media/:id/make-main', (req, res) => {
  const m = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!m || m.kind === 'pdf') return res.sendStatus(400);
  db.prepare('UPDATE buildings SET photo = ? WHERE id = ?').run(m.file, m.building_id);
  res.json({ ok: true });
});
A.post('/media/:id/to-floor-plan', (req, res) => {
  const m = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!m || m.kind === 'pdf') return res.sendStatus(400);
  const suites = db.prepare('SELECT * FROM suites WHERE building_id = ? ORDER BY ord, id').all(m.building_id);
  const i = matchSuite(m.caption || '', suites);
  db.prepare("INSERT INTO floor_plans (building_id, suite_id, caption, file, source, hidden) VALUES (?, ?, ?, ?, 'upload', ?)").run(m.building_id, i >= 0 ? suites[i].id : null, m.caption || 'Floor plan', m.file, m.hidden);
  db.prepare('DELETE FROM media WHERE id = ?').run(m.id);
  res.json({ ok: true });
});
A.delete('/media/:id', (req, res) => { db.prepare('DELETE FROM media WHERE id = ?').run(req.params.id); res.json({ ok: true }); });

A.post('/buildings/:id/floor-plans', imageUpload.single('file'), async (req, res) => {
  const b = db.prepare('SELECT * FROM buildings WHERE id = ?').get(req.params.id);
  if (!b || !req.file) return res.sendStatus(400);
  const dir = surveyDir(b.survey_id);
  const suiteId = req.body.suite_id ? Number(req.body.suite_id) : null;
  const caption = String(req.body.caption || '').trim() || 'Floor plan';
  const stem = `b${b.id}-fp-${Date.now()}`;
  try {
    let files = [];
    if (req.file.mimetype === 'application/pdf') {
      const n = Math.min(await pdf.pageCount(req.file.path), 10);
      for (let p = 1; p <= n; p++) files.push(path.basename(await pdf.renderPage(req.file.path, p, path.join(dir, `${stem}-${p}`), 130)));
    } else {
      const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[req.file.mimetype];
      if (!ext) return res.status(400).json({ error: 'Use a PDF, JPG, PNG or WebP file.' });
      fs.copyFileSync(req.file.path, path.join(dir, stem + ext));
      files.push(stem + ext);
    }
    // No suite chosen: try to work it out from the file name, then from each page's text.
    const suites = db.prepare('SELECT * FROM suites WHERE building_id = ? ORDER BY ord, id').all(b.id);
    let pageTexts = [];
    if (!suiteId && req.file.mimetype === 'application/pdf') pageTexts = await pdf.pageTexts(req.file.path).catch(() => []);
    const fromName = suiteId ? -1 : matchSuite(req.file.originalname || '', suites);
    const ins = db.prepare("INSERT INTO floor_plans (building_id, suite_id, caption, file, source) VALUES (?, ?, ?, ?, 'upload')");
    let matched = 0;
    files.forEach((f, i) => {
      let sid = suiteId;
      if (!sid) {
        const idx = pageTexts[i] ? matchSuite(pageTexts[i].split('\n').filter((l) => /floor|suite|ste\b/i.test(l)).join(' '), suites) : -1;
        const pick = idx >= 0 ? idx : fromName;
        if (pick >= 0) { sid = suites[pick].id; matched++; }
      }
      ins.run(b.id, sid || null, files.length > 1 ? `${caption} (${i + 1})` : caption, f);
    });
    return res.json({ ok: true, matched, total: files.length });
  } finally { fs.rmSync(req.file.path, { force: true }); }
});
A.patch('/floor-plans/:id', (req, res) => {
  const fp = db.prepare('SELECT * FROM floor_plans WHERE id = ?').get(req.params.id);
  if (!fp) return res.sendStatus(404);
  const { caption = fp.caption, suite_id = fp.suite_id, hidden = fp.hidden } = req.body;
  db.prepare('UPDATE floor_plans SET caption = ?, suite_id = ?, hidden = ? WHERE id = ?').run(caption, suite_id || null, hidden ? 1 : 0, fp.id);
  res.json({ ok: true });
});
A.delete('/floor-plans/:id', (req, res) => { db.prepare('DELETE FROM floor_plans WHERE id = ?').run(req.params.id); res.json({ ok: true }); });

A.post('/buildings/:id/suites', (req, res) => {
  const { lastInsertRowid } = db.prepare('INSERT INTO suites (building_id, ord) VALUES (?, 999)').run(req.params.id);
  res.json({ id: Number(lastInsertRowid) });
});
A.patch('/suites/:id', (req, res) => {
  patch('suites', S_EDITABLE, req.params.id, req.body);
  if ('sf' in req.body) {
    const nums = String(req.body.sf || '').match(/[\d,]+/g) || [];
    const max = nums.length ? Math.max(...nums.map((n) => Number(n.replace(/,/g, '')))) : null;
    db.prepare('UPDATE suites SET sf_max = ? WHERE id = ?').run(max, req.params.id);
  }
  res.json({ ok: true });
});
A.delete('/suites/:id', (req, res) => { db.prepare('DELETE FROM suites WHERE id = ?').run(req.params.id); res.json({ ok: true }); });

app.use('/api/admin', A);
app.get('/admin/files/:sid/:file', requireAdmin, (req, res) => sendFileFrom(res, req.params.sid, req.params.file));

// ---------- client survey (private link) ----------
const byToken = (t) => (typeof t === 'string' && /^[\w-]{16,64}$/.test(t)) ? db.prepare('SELECT * FROM surveys WHERE token = ?').get(t) : null;

app.get('/s/:token', (req, res) => {
  const s = byToken(req.params.token);
  if (!s) return sendPage(res, 'notfound.html', 404);
  if (!isAdmin(req)) db.prepare("UPDATE surveys SET view_count = view_count + 1, last_viewed_at = datetime('now') WHERE id = ?").run(s.id);
  sendPage(res, 'survey.html');
});
app.get('/api/s/:token', (req, res) => {
  const s = byToken(req.params.token);
  if (!s) return res.sendStatus(404);
  if (s.status !== 'ready') return res.json({ survey: { title: s.title, status: s.status }, buildings: [] });
  const payload = surveyPayload(s, { admin: false });
  if (isAdmin(req)) payload.broker = { survey_id: s.id }; // broker viewing the client page: show "Rule out" controls
  res.json(payload);
});
app.post('/api/s/:token/vote', (req, res) => {
  const s = byToken(req.params.token);
  if (!s) return res.sendStatus(404);
  const bid = Number(req.body.building_id);
  const b = db.prepare('SELECT id FROM buildings WHERE id = ? AND survey_id = ? AND hidden = 0').get(bid, s.id);
  if (!b) return res.sendStatus(404);
  const vote = Number(req.body.vote);
  const comment = req.body.comment == null ? undefined : String(req.body.comment).slice(0, 2000);
  if (vote === 0 && !comment) {
    db.prepare('DELETE FROM votes WHERE survey_id = ? AND building_id = ?').run(s.id, bid);
  } else if ([1, -1, 0].includes(vote)) {
    const prev = db.prepare('SELECT comment FROM votes WHERE survey_id = ? AND building_id = ?').get(s.id, bid);
    db.prepare(`INSERT INTO votes (survey_id, building_id, vote, comment, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT (survey_id, building_id) DO UPDATE SET vote = excluded.vote, comment = excluded.comment, updated_at = excluded.updated_at`)
      .run(s.id, bid, vote, comment !== undefined ? comment : prev?.comment ?? null);
  } else return res.status(400).json({ error: 'bad vote' });
  res.json({ ok: true });
});
app.get('/s/:token/files/:file', (req, res) => {
  const s = byToken(req.params.token);
  if (!s) return res.sendStatus(404);
  sendFileFrom(res, s.id, req.params.file);
});

// ---------- static ----------
app.get('/config.js', (req, res) => {
  res.type('application/javascript').send(`window.APP_CONFIG = ${JSON.stringify({
    tileUrl: process.env.TILE_URL || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileAttribution: process.env.TILE_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    brokerName: process.env.BROKER_NAME || '',
    brokerEmail: process.env.BROKER_EMAIL || '',
    brokerPhone: process.env.BROKER_PHONE || '',
    companyUrl: process.env.COMPANY_URL || 'https://www.tenantconsulting.com',
  })};`);
});
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist'), { maxAge: '7d' }));
app.use(express.static(PUB, { index: false, maxAge: '1y', immutable: true, setHeaders: (res, p) => { if (!/\.(js|css)$/.test(p)) res.set('Cache-Control', 'public, max-age=3600'); } }));
app.get('/', (req, res) => sendPage(res, 'index.html'));
app.get('/healthz', (req, res) => res.send('ok'));

// Surveys left mid-processing by a restart: re-run them.
for (const s of db.prepare("SELECT id FROM surveys WHERE status = 'processing'").all()) {
  const p = path.join(DATA_DIR, 'files', String(s.id), 'source.pdf');
  db.prepare('DELETE FROM buildings WHERE survey_id = ?').run(s.id);
  if (fs.existsSync(p)) processSurvey(s.id, p);
}

enrichExisting().catch((e) => console.error(e));

app.listen(PORT, () => console.log(`Tenant rep survey app on http://localhost:${PORT}`));
