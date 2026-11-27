'use strict';
const path = require('path');
const fs = require('fs');
process.removeAllListeners('warning'); // silence node:sqlite experimental warning
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'files'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS surveys (
  id INTEGER PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  client_name TEXT,
  pdf_name TEXT,
  status TEXT NOT NULL DEFAULT 'processing',
  status_detail TEXT,
  view_count INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS buildings (
  id INTEGER PRIMARY KEY,
  survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  name TEXT, address TEXT, city TEXT, state TEXT, zip TEXT, submarket TEXT,
  property_type TEXT, building_class TEXT, rba_sf INTEGER, year_built INTEGER, renovated TEXT,
  stories INTEGER, typical_floor TEXT, parking TEXT,
  available_size TEXT, asking_rent TEXT, service_type TEXT, occupancy TEXT, term TEXT,
  overview TEXT, highlights TEXT, broker_notes TEXT,
  lat REAL, lng REAL, geocode_status TEXT,
  photo TEXT, listing_page TEXT, source_page INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS suites (
  id INTEGER PRIMARY KEY,
  building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL DEFAULT 0,
  address TEXT, floor TEXT, floor_status TEXT, suite TEXT, space_use TEXT, lease_type TEXT,
  sf TEXT, sf_max INTEGER, floor_contig TEXT, bldg_contig TEXT,
  rent TEXT, rent_type TEXT, occupancy TEXT, term TEXT
);
CREATE TABLE IF NOT EXISTS floor_plans (
  id INTEGER PRIMARY KEY,
  building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  suite_id INTEGER REFERENCES suites(id) ON DELETE SET NULL,
  caption TEXT, file TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY,
  building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,          -- photo | flyer_page | pdf
  caption TEXT, file TEXT NOT NULL, source TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  ord INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS votes (
  survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  vote INTEGER NOT NULL,
  comment TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (survey_id, building_id)
);
`);

// Columns added after the first release.
const MIGRATIONS = [
  ['buildings', 'costar_rating', 'INTEGER'],
  ['buildings', 'details', 'TEXT'],
  ['buildings', 'source_pages', 'TEXT'],
  ['buildings', 'enriched', 'INTEGER NOT NULL DEFAULT 0'],
  ['surveys', 'nnn_estimate', 'REAL'],      // area-wide NNN estimate, $/SF/yr
  ['buildings', 'nnn_override', 'REAL'],    // broker-confirmed NNN for this building, $/SF/yr
  ['surveys', 'archived', 'INTEGER NOT NULL DEFAULT 0'],
  ['suites', 'notes', 'TEXT'],
  ['buildings', 'tour_url', 'TEXT'],
  ['floor_plans', 'source', 'TEXT'],       // 'upload' for plans the broker added (kept on re-import)
  ['floor_plans', 'hidden', 'INTEGER NOT NULL DEFAULT 0'],
];
for (const [table, col, type] of MIGRATIONS) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

function surveyDir(surveyId) {
  const d = path.join(DATA_DIR, 'files', String(surveyId));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Run fn inside a transaction. */
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, DATA_DIR, surveyDir, tx };
