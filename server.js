'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { db, DATA_DIR, surveyDir } = require('./lib/db');
const { processSurvey, enrichExisting } = require('./lib/process');
const { matchSuite } = require('./lib/floorplans');
const { geocode } = require('./lib/geocode');
const pdf = require('./lib/pdf');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD is not set; admin login is disabled.');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });

const PUB = path.join(__dirname, 'public');
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
app.get('/admin/login', (req, res) => res.sendFile(path.join(PUB, 'admin', 'login.html')));
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(PUB, 'admin', 'index.html')));
app.get('/admin/surveys/:id', requireAdmin, (req, res) => res.sendFile(path.join(PUB, 'admin', 'survey.html')));

// ---------- data helpers ----------
const getSurvey = (id) => db.prepare('SELECT * FROM surveys WHERE id = ?').get(id);
function surveyPayload(survey, { admin }) {
  const buildings = db.prepare(`SELECT * FROM buildings WHERE survey_id = ? ${admin ? '' : 'AND hidden = 0'} ORDER BY ord, id`).all(survey.id);
  const suites = db.prepare('SELECT s.* FROM suites s JOIN buildings b ON b.id = s.building_id WHERE b.survey_id = ? ORDER BY s.ord, s.id').all(survey.id);
  const plans = db.prepare('SELECT f.* FROM floor_plans f JOIN buildings b ON b.id = f.building_id WHERE b.survey_id = ? ORDER BY f.id').all(survey.id);
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
    floor_plans: plans.filter((f) => f.building_id === b.id).map((f) => ({ id: f.id, suite_id: f.suite_id, caption: f.caption, url: fileBase + f.file })),
    vote: vmap[b.id] || null,
  }));
  const s = { id: survey.id, title: survey.title, client_name: survey.client_name, status: survey.status, created_at: survey.created_at, nnn_estimate: survey.nnn_estimate };
  if (admin) Object.assign(s, { token: survey.token, pdf_name: survey.pdf_name, status_detail: survey.status_detail, view_count: survey.view_count, last_viewed_at: survey.last_viewed_at });
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
    SELECT s.id, s.title, s.client_name, s.status, s.status_detail, s.created_at, s.token, s.view_count, s.last_viewed_at,
      (SELECT COUNT(*) FROM buildings b WHERE b.survey_id = s.id AND b.hidden = 0) AS building_count,
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
  db.prepare('UPDATE surveys SET title = ?, client_name = ?, nnn_estimate = ? WHERE id = ?').run(title, client_name, nnn, s.id);
  res.json({ ok: true });
});

A.post('/surveys/:id/rotate-link', (req, res) => {
  const token = newToken();
  db.prepare('UPDATE surveys SET token = ? WHERE id = ?').run(token, req.params.id);
  res.json({ token });
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
  'occupancy', 'term', 'overview', 'broker_notes', 'lat', 'lng', 'hidden', 'ord', 'costar_rating', 'nnn_override'];
const S_EDITABLE = ['address', 'floor', 'floor_status', 'suite', 'space_use', 'lease_type', 'sf', 'floor_contig',
  'bldg_contig', 'rent', 'rent_type', 'occupancy', 'term', 'ord'];

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
    const ins = db.prepare('INSERT INTO floor_plans (building_id, suite_id, caption, file) VALUES (?, ?, ?, ?)');
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
  const { caption, suite_id } = req.body;
  db.prepare('UPDATE floor_plans SET caption = COALESCE(?, caption), suite_id = ? WHERE id = ?').run(caption ?? null, suite_id || null, req.params.id);
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
  if (!s) return res.status(404).sendFile(path.join(PUB, 'notfound.html'));
  if (!isAdmin(req)) db.prepare("UPDATE surveys SET view_count = view_count + 1, last_viewed_at = datetime('now') WHERE id = ?").run(s.id);
  res.sendFile(path.join(PUB, 'survey.html'));
});
app.get('/api/s/:token', (req, res) => {
  const s = byToken(req.params.token);
  if (!s) return res.sendStatus(404);
  if (s.status !== 'ready') return res.json({ survey: { title: s.title, status: s.status }, buildings: [] });
  res.json(surveyPayload(s, { admin: false }));
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
app.use(express.static(PUB, { index: false, maxAge: '1h' }));
app.get('/', (req, res) => res.sendFile(path.join(PUB, 'index.html')));
app.get('/healthz', (req, res) => res.send('ok'));

// Surveys left mid-processing by a restart: re-run them.
for (const s of db.prepare("SELECT id FROM surveys WHERE status = 'processing'").all()) {
  const p = path.join(DATA_DIR, 'files', String(s.id), 'source.pdf');
  db.prepare('DELETE FROM buildings WHERE survey_id = ?').run(s.id);
  if (fs.existsSync(p)) processSurvey(s.id, p);
}

enrichExisting().catch((e) => console.error(e));

app.listen(PORT, () => console.log(`Tenant rep survey app on http://localhost:${PORT}`));
