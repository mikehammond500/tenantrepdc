'use strict';
// Extracts buildings and suites from a CoStar "For Lease" property report (pdftotext -layout output).
//
// Each property's pages start with a two-line header:
//    "  1    10 Pidgeon Hill Dr • Countryside Office Park"
//    "       300 - 24,585 SF • For Lease • Multiple Space Uses • Route 28 Corridor North Submarket • Sterling, VA 20165"
// and contain label/value blocks (Listing Details, Building Details), an "Available Spaces" table,
// "Property Overview" prose and "Leasing Highlights" bullets.

const LABELS = [
  'Available Size', 'Asking Rent', 'Total Asking Rent', 'Service Type', 'Occupancy', 'Lease Type', 'Term',
  'Time On Market', 'Primary Property Type', 'Secondary Type', 'Building Class', 'Year Built', 'Renovated',
  'Building Size', 'Stories', 'Typical Floor', 'Elevators', 'Parking', 'Tenancy', 'Slab to Slab',
  'Ceiling Height', 'Green Ratings', 'CoStar Rating', 'Land Acres', 'Zoning', 'Sprinklers', 'Docks',
  'Drive Ins', 'Cranes', 'Levelators', 'Power', 'Rail Spots', 'Construction', 'Core Factor', 'Amenities',
];
const LABEL_SET = new Set(LABELS.map((l) => l.toLowerCase()));
const SECTION_RE = /^(Listing Details|Leasing Highlights|Available Spaces(?: \(Continued\))?|Property Overview|Building Details|Map|Contacts(?: \(Continued\))?|Leasing Company|True Owner|Property Manager|Sales Company|Floor Plans?|Photos?)\s*$/;
const FOOTER_RE = /CoStar Group - Licensed|^\s*Page \d+\s*$/;
const TYPE_RE = /^(Direct|Sublet|Sublease|Sub-?lease|Relet|Coworking|Co-working)$/i;
const FLOOR_RE = /^(?:[PE]\s+)?(?:\d+(?:st|nd|rd|th)|LL\d?|Lower Level|Ground|GRND|Mezz(?:anine)?|Bsmt|Basement|PH|Penthouse|Roof)$/i;
const SFNUM_RE = /^[\d,]+(?:\s*-\s*(?:[\d,]+)?)?$/;

const toInt = (s) => { if (s == null) return null; const m = String(s).match(/[\d,]+/); if (!m) return null; const n = Number(m[0].replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

/** Split a layout line into tokens separated by 2+ spaces, keeping start columns. */
function tokens(line) {
  const out = [];
  for (const m of line.matchAll(/\S+(?: \S+)*/g)) out.push({ text: m[0], start: m.index });
  return out;
}

function parseHeader(lines) {
  const nonEmpty = lines.map((l, i) => ({ l, i })).filter((x) => x.l.trim());
  if (nonEmpty.length < 2) return null;
  const h1 = nonEmpty[0].l, h2 = nonEmpty[1].l;
  const m1 = h1.match(/^\s*(\d{1,3})\s{2,}(\S.*)$/);
  if (!m1 || !/For (Lease|Sale)|Submarket/.test(h2)) return null;
  const [address, ...nameParts] = m1[2].split(' • ');
  const parts = h2.trim().split(' • ').map(clean);
  const loc = parts[parts.length - 1].match(/^(.+?),\s+([A-Z]{2})\s+(\d{5})/);
  const sub = parts.find((p) => /Submarket$/.test(p));
  return {
    item: Number(m1[1]),
    address: clean(address),
    name: clean(nameParts.join(' • ')) || null,
    size_range: parts[0] && /SF/.test(parts[0]) ? parts[0] : null,
    property_use: parts.length >= 5 ? parts[2] : null,
    submarket: sub ? sub.replace(/\s+Submarket$/, '') : null,
    city: loc ? loc[1] : null, state: loc ? loc[2] : null, zip: loc ? loc[3] : null,
    bodyStart: nonEmpty[1].i + 1,
  };
}

function parseLabels(line, into) {
  const t = tokens(line).map((x) => x.text);
  for (let i = 0; i < t.length; i++) {
    const key = t[i].toLowerCase();
    if (!LABEL_SET.has(key)) continue;
    const next = t[i + 1];
    if (next != null && !LABEL_SET.has(next.toLowerCase())) {
      const label = LABELS.find((l) => l.toLowerCase() === key);
      if (into[label] == null) into[label] = next;
      i++;
    }
  }
}

/** Collapse a two-column bullet list into an array of bullet strings. */
function parseBullets(lines) {
  let split = null;
  for (const l of lines) {
    const idx = l.indexOf('•', 20);
    if (idx > 20) { split = split == null ? idx : Math.min(split, idx); }
  }
  const cols = split ? [lines.map((l) => l.slice(0, split)), lines.map((l) => l.slice(split))] : [lines];
  const bullets = [];
  for (const col of cols) {
    let cur = null;
    for (const raw of col) {
      const l = raw.trim();
      if (!l) continue;
      if (l.startsWith('•')) { if (cur) bullets.push(cur); cur = l.slice(1).trim(); }
      else if (cur != null) cur = cur.endsWith('-') ? cur + l : `${cur} ${l}`;
    }
    if (cur) bullets.push(cur);
  }
  return bullets.map(clean).filter((b) => b && !/^No Data Available$/i.test(b));
}

function joinWrap(a, b) {
  // "Office/Med-" + "ical" => "Office/Medical"; "Not Dis- Immediately" + "closed" => "Not Disclosed Immediately"
  if (/[A-Za-z]-(\s|$)/.test(a)) return a.replace(/([A-Za-z])-(\s|$)/, `$1${b}$2`);
  return `${a} ${b}`;
}

function parseSpaceRow(toks) {
  const t = toks.map((x) => x.text);
  const typeIdx = t.findIndex((x) => TYPE_RE.test(x));
  if (typeIdx < 1) return null;
  const floorIdx = t.slice(0, typeIdx).findIndex((x) => FLOOR_RE.test(x));
  if (floorIdx < 0) return null;
  const between = t.slice(floorIdx + 1, typeIdx);
  const s = {
    address: floorIdx > 0 ? clean(t.slice(0, floorIdx).join(' ')) : null,
    floor: t[floorIdx].replace(/^[PE]\s+/, ''),
    floor_status: /^P\s/.test(t[floorIdx]) ? 'Partial' : /^E\s/.test(t[floorIdx]) ? 'Entire' : null,
    suite: between.length >= 2 ? between[0] : null,
    space_use: between.length ? between[between.length - 1] : null,
    lease_type: t[typeIdx],
  };
  let k = typeIdx + 1;
  const nums = [];
  while (k < t.length && SFNUM_RE.test(t[k]) && nums.length < 3) nums.push(t[k++]);
  s.sf = nums[0] ? clean(nums[0]).replace(/\s*-\s*/, ' - ') : null;
  s.sf_max = nums[0] ? Math.max(...(nums[0].match(/[\d,]+/g) || []).map(toInt)) : null;
  s.floor_contig = nums[1] || null;
  s.bldg_contig = nums[2] || null;
  let rest = t.slice(k).join('  ');
  const rm = rest.match(/^(\$[\d.,]+(?:\s*-\s*\$?[\d.,]+)?(?:\/\w+)*)\s*(FS|MG|NNN|IG|TBD|MGS?|\+\s?Elec|Plus Elec(?:tric)?|Mod Gross|Ind Gross|Full Service)?\s*/i)
        || rest.match(/^(Not Disclosed|Withheld|With-held|Negotiable|Call for Rent)\s*/i);
  s.rent = rm ? rm[1] : null;
  s.rent_type = rm && rm[2] ? rm[2] : null;
  if (rm) rest = rest.slice(rm[0].length);
  const parts = rest.split(/\s{2,}/).map(clean).filter(Boolean);
  s.occupancy = parts[0] || null;
  s.term = parts.slice(1).join(' ') || null;
  return s;
}

function parseSpacesBlock(lines) {
  const rows = [];
  let cur = null;
  for (const line of lines) {
    if (!line.trim()) { cur && (cur.closed = true); continue; }
    if (/SF Avail|^\s*SF Flo-|^\s*or Con-/.test(line)) continue;
    const toks = tokens(line);
    const row = parseSpaceRow(toks);
    if (row) { cur = { toks, closed: false }; rows.push(cur); continue; }
    if (!cur || cur.closed) continue; // orphan wrap from previous page
    for (const ct of toks) {
      let best = null;
      for (const rt of cur.toks) {
        const d = Math.abs(rt.start - ct.start);
        if (d <= 8 && (!best || d < best.d)) best = { rt, d };
      }
      if (!best) { // nearest token starting before this one
        for (const rt of cur.toks) if (rt.start <= ct.start && (!best || rt.start > best.rt.start)) best = { rt, d: 0 };
      }
      if (best) best.rt.text = joinWrap(best.rt.text, ct.text);
    }
  }
  return rows.map((r) => parseSpaceRow(r.toks)).filter(Boolean);
}

const FP_RE = /(?:Partial\s+|Entire\s+)?([\w\- ]{1,20}?)\s+Floor\s*[•·]\s*Suite\s+([\w\-]+)/i;

function extract(pages) {
  const buildings = [];
  let cur = null;
  pages.forEach((text, i) => {
    const page = i + 1;
    const lines = text.split('\n').filter((l) => !FOOTER_RE.test(l));
    const h = parseHeader(lines);
    if (!h) return; // cover page, summary table, etc.
    if (!cur || h.item !== cur.item_number) {
      cur = {
        item_number: h.item, name: h.name, address: h.address, city: h.city, state: h.state, zip: h.zip,
        submarket: h.submarket, size_range: h.size_range, property_use: h.property_use,
        first_page: page, pages: [], labels: {}, suites: [], overview: [], highlights: [], floor_plans: [],
      };
      buildings.push(cur);
    }
    cur.pages.push(page);
    // Walk sections on this page.
    let section = null, buf = [];
    const flush = () => {
      if (!section) return;
      if (/^Available Spaces/.test(section)) cur.suites.push(...parseSpacesBlock(buf));
      else if (section === 'Leasing Highlights') cur.highlights.push(...parseBullets(buf));
      else if (section === 'Property Overview') {
        const paras = buf.join('\n').split(/\n\s*\n/).map(clean).filter((p) => p && !/^No Data Available$/i.test(p));
        cur.overview.push(...paras);
      }
    };
    for (const line of lines.slice(h.bodyStart)) {
      const sm = line.trim().match(SECTION_RE);
      if (sm && line.search(/\S/) < 6) { flush(); section = sm[1]; buf = []; continue; }
      if (section === 'Listing Details' || section === 'Building Details') parseLabels(line, cur.labels);
      else buf.push(line);
    }
    flush();
    const fp = text.match(FP_RE);
    if (fp || /^\s*Floor Plans?\s*$/m.test(text)) cur.floor_plans.push({ page, caption: fp ? clean(fp[0]) : 'Floor plan', suite: fp ? fp[2] : null });
  });

  return {
    buildings: buildings.map((b) => {
      const L = b.labels;
      return {
        item_number: b.item_number, name: b.name, address: b.address, city: b.city, state: b.state, zip: b.zip,
        submarket: b.submarket, property_type: L['Primary Property Type'] || b.property_use,
        building_class: L['Building Class'] || null,
        rba_sf: toInt(L['Building Size']), year_built: toInt(L['Year Built']), renovated: L['Renovated'] || null,
        stories: toInt(L['Stories']), typical_floor: L['Typical Floor'] || null, parking: L['Parking'] || null,
        available_size: L['Available Size'] || b.size_range, asking_rent: L['Asking Rent'] || null,
        service_type: L['Service Type'] || null, occupancy: L['Occupancy'] || null, term: L['Term'] || null,
        overview: b.overview.join('\n\n') || null, highlights: b.highlights,
        first_page: b.first_page, pages: b.pages, suites: b.suites, floor_plans: b.floor_plans,
      };
    }),
  };
}

module.exports = { extract };
