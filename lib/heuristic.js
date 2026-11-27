'use strict';
// Extracts buildings and suites from CoStar property reports (pdftotext -layout output).
// Two CoStar layouts are supported:
//  A) "For Lease" report: header "1  10 Pidgeon Hill Dr • Name" / "… • Submarket • City, ST ZIP",
//     with Listing Details / Building Details / Available Spaces / Property Overview sections.
//  B) Classic survey: header "1  8120 Woodmont Ave - Woodmont Plaza" / "City, ST ZIP (County) - X Submarket   Office",
//     then label/value lines (RBA (% Leased), Built/Renovated, Available, Max Contiguous…) and a suite table
//     whose rows ("P1  106  Office/Medical …") can be followed by free-text suite notes.
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
  'Lot Size', 'Building FAR', 'Parking Ratio', 'Column Spacing', 'Clear Height', 'Walk Score', 'Transit Score',
  'Owner Occupied', 'Load Factor', 'Loading', 'Rail Lines', 'Gas', 'Water', 'Sewer', 'Heating', 'Units',
  'Construction Material', 'Electricity', 'Air Conditioning', 'Exterior Walls', 'Floor Area Ratio', 'Sale Status',
  'Days On Market', 'Max Contiguous', 'Smallest Space', 'Rentable Building Area', 'Land Area', 'Year Renovated',
  'Number of Floors', 'Elevators Passenger', 'Freight Elevators', 'Ceiling Heights', 'Energy Star', 'LEED Certified',
  'Expenses', 'Taxes', 'Operating Expenses', 'Opex', 'Net Absorption', 'Vacancy', 'Leased', 'Percent Leased',
  'Property Manager', 'Tenancy Type', 'Building Status', 'Zoning Description',
  'RBA (% Leased)', 'GLA (% Leased)', 'RBA', 'GLA', 'Built/Renovated', 'Built', 'Available', 'Max Contiguous',
  'Parking Spaces', 'True Owner', 'Class', 'Total Available', 'Direct Available', 'Sublet Available',
  'Developer', 'Architect', 'Management', 'Rent/SF/Year', 'Lot Area', 'Year Built/Renovated', 'Star Rating',
  'Building Amenities', 'Expenses (per SF)', 'Taxes (per SF)', 'Opex (per SF)', 'Signage', 'Lease Type(s)',
];
const LABEL_SET = new Set(LABELS.map((l) => l.toLowerCase()));
const SECTION_RE = /^(Listing Details|Leasing Highlights|Available Spaces(?: \(Continued\))?|Property Overview|Building Details|Map|Contacts(?: \(Continued\))?|Leasing Company|True Owner|Property Manager|Sales Company|Floor Plans?|Photos?)\s*$/;
const FOOTER_RE = /CoStar Group - Licensed|^\s*Page \d+\s*$/;
const TYPE_RE = /^(Direct|Sublet|Sublease|Sub-?lease|Relet|Coworking|Co-working)$/i;
const FLOOR_RE = /^(?:(?:[PE]\s+)?(?:\d+(?:st|nd|rd|th)|LL\d?|Lower Level|Ground|GRND|Mezz(?:anine)?|Bsmt|Basement|PH|Penthouse|Roof)|[PE](?:\d{1,3}|LL\d?|GRND|PH|B\d?|M|G))$/i;
const ORD = (n) => { const v = n % 100; return n + (v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'); };
const TABLE_HEADER_RE = /\bSF Avail|\bFloor\s+Suite\s+Use\b|\bFloor\s+Use\s+Type\b/;
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
  if (!m1 || !/For (Lease|Sale)|Submarket|,\s+[A-Z]{2}\s+\d{5}/.test(h2)) return null;
  const head = m1[2].trim();
  const base = { item: Number(m1[1]), bodyStart: nonEmpty[1].i + 1 };
  if (h2.includes(' • ')) {
    // Layout A
    const [address, ...nameParts] = head.split(' • ');
    const parts = h2.trim().split(' • ').map(clean);
    const loc = parts[parts.length - 1].match(/^(.+?),\s+([A-Z]{2})\s+(\d{5})/);
    const sub = parts.find((p) => /Submarket$/.test(p));
    return {
      ...base, layout: 'A',
      address: clean(address), name: clean(nameParts.join(' • ')) || null,
      size_range: parts[0] && /SF/.test(parts[0]) ? parts[0] : null,
      property_use: parts.length >= 5 ? parts[2] : null,
      submarket: sub ? sub.replace(/\s+Submarket$/, '') : null,
      city: loc ? loc[1] : null, state: loc ? loc[2] : null, zip: loc ? loc[3] : null,
    };
  }
  // Layout B: "8120 Woodmont Ave - Woodmont Plaza" / "Bethesda, MD 20814 (Montgomery County) - Bethesda/Chevy Chase Submarket   Office"
  const dash = head.indexOf(' - ');
  const address = dash > 0 ? head.slice(0, dash) : head;
  const name = dash > 0 ? head.slice(dash + 3) : null;
  const [left, ...right] = h2.trim().split(/\s{2,}/);
  const loc = left.match(/^(.+?),\s+([A-Z]{2})\s+(\d{5})(?:-\d{4})?(?:\s*\(([^)]*)\))?(?:\s*-\s*(.+?)(?:\s+Submarket)?)?$/);
  return {
    ...base, layout: 'B',
    address: clean(address), name: name ? clean(name) : null, size_range: null,
    property_use: right.length ? clean(right.join(' ')) : null,
    county: loc && loc[4] ? loc[4] : null,
    submarket: loc && loc[5] ? clean(loc[5]) : null,
    city: loc ? loc[1] : null, state: loc ? loc[2] : null, zip: loc ? loc[3] : null,
  };
}

function parseLabels(line, into) {
  // Values never contain 2+ spaces, so tokens alternate label, value, label, value...
  // A known label with no value (e.g. "CoStar Rating", drawn as stars) is skipped.
  const t = tokens(line).map((x) => x.text);
  for (let i = 0; i < t.length; i++) {
    const known = LABEL_SET.has(t[i].toLowerCase());
    const next = t[i + 1];
    if (known && (next == null || LABEL_SET.has(next.toLowerCase()))) continue; // label with blank value
    if (next == null) break;
    const label = known ? LABELS.find((l) => l.toLowerCase() === t[i].toLowerCase()) : t[i];
    // Unknown labels: accept only if they look like a label (short, starts with a letter, no $ or digits-only).
    if (!known && !(/^[A-Z][A-Za-z/&'()\- ]{1,32}$/.test(label))) { continue; }
    if (into[label] == null) into[label] = next;
    i++;
  }
}

const isKnown = (t) => LABEL_SET.has(String(t).toLowerCase());
const labelName = (t) => LABELS.find((l) => l.toLowerCase() === String(t).toLowerCase()) || t;
const dehyphen = (parts) => parts.reduce((acc, p) => (acc.endsWith('-') ? acc.slice(0, -1) + p : acc ? `${acc} ${p}` : p), '');

/**
 * Label/value block. Handles values CoStar wraps onto several lines, where the label sits on its own line
 * between the value's lines:   "        4.00/1,000 SF; Covered Spaces Avail-" / "Parking Spaces" / "        able"
 */
function parseLabelBlock(lines, into) {
  let orphans = [], pending = null, last = null;
  const finish = () => { if (pending) { into[pending] = dehyphen(into[pending] ? [into[pending]] : []) || null; } };
  for (const line of lines) {
    if (!line.trim()) continue;
    const toks = tokens(line);
    const anyKnown = toks.some((t) => isKnown(t.text));
    if (toks.length === 1 && isKnown(toks[0].text)) {           // label alone: value is wrapped around it
      const label = labelName(toks[0].text);
      if (into[label] == null) { into[label] = dehyphen(orphans); pending = label; last = label; }
      orphans = [];
      continue;
    }
    if (toks.length === 1 && toks[0].start >= 12 && !anyKnown) { // indented fragment of a wrapped value
      if (pending) into[pending] = dehyphen([into[pending], toks[0].text].filter(Boolean));
      else orphans.push(toks[0].text);
      continue;
    }
    pending = null;
    if (orphans.length && last && into[last] != null) { into[last] = dehyphen([into[last], ...orphans]); }
    orphans = [];
    if (anyKnown || (toks.length >= 2 && toks[0].start < 6)) {
      const before = Object.keys(into).length;
      parseLabels(line, into);
      const keys = Object.keys(into); if (keys.length > before) last = keys[keys.length - 1];
    } else if (toks.length === 1 && toks[0].start < 6 && /,/.test(toks[0].text) && into['Amenities'] == null) {
      into['Amenities'] = toks[0].text;                          // "Bus Line, Metro/Subway, Property Manager on Site"
    }
  }
  finish();
  for (const k of Object.keys(into)) if (into[k] === '' || into[k] == null) delete into[k];
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
  const ft = t[floorIdx];
  const compact = ft.match(/^([PE])(\d{1,3}|LL\d?|GRND|PH|B\d?|M|G)$/i);   // "P1", "E10"
  const s = {
    address: floorIdx > 0 ? clean(t.slice(0, floorIdx).join(' ')) : null,
    floor: compact ? (/^\d+$/.test(compact[2]) ? ORD(Number(compact[2])) : compact[2]) : ft.replace(/^[PE]\s+/, ''),
    floor_status: /^P(\s|\d|[A-Z])/i.test(ft) ? 'Partial' : /^E(\s|\d|[A-Z])/i.test(ft) ? 'Entire' : null,
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
  s.notes = null;
  return s;
}

function parseSpacesBlock(lines) {
  const rows = [];
  let cur = null;
  for (const line of lines) {
    if (!line.trim()) { cur && (cur.closed = true); continue; }
    if (TABLE_HEADER_RE.test(line) || /^\s*SF Flo-|^\s*or Con-|^\s+Floor\s+Building\s*$/.test(line)) continue;
    const toks = tokens(line);
    const row = parseSpaceRow(toks);
    if (row) { cur = { toks, closed: false, notes: [] }; rows.push(cur); continue; }
    if (!cur) continue; // orphan wrap from the previous page
    // Free text starting at the left margin under a row is a note about that suite (layout B).
    const isNote = toks[0].start < 6 && (cur.closed || /\s\S+\s/.test(toks[0].text) || toks.length === 1 && toks[0].text.length > 12);
    if (isNote) { cur.notes.push(clean(line)); continue; }
    if (cur.closed) continue;
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
  return rows.map((r) => { const s = parseSpaceRow(r.toks); if (s && r.notes.length) s.notes = r.notes.join('\n'); return s; }).filter(Boolean);
}

const FP_RE = /(?:Partial\s+|Entire\s+)?([\w\- ]{1,20}?)\s+Floor\s*[•·]\s*Suite\s+([\w\-]+)/i;

function extract(pages) {
  const buildings = [];
  let cur = null;
  pages.forEach((text, i) => {
    const page = i + 1;
    const lines = text.split('\n').filter((l) => !FOOTER_RE.test(l));
    const h = parseHeader(lines);
    if (!h) {
      // Page without a property header (e.g. a floor plan page): belongs to the property before it.
      if (cur) {
        cur.pages.push(page);
        const fp = text.match(FP_RE);
        if (fp || /^\s*Floor Plans?\s*$/m.test(text)) cur.floor_plans.push({ page, caption: fp ? clean(fp[0]) : 'Floor plan', suite: fp ? fp[2] : null });
      }
      return;
    }
    if (!cur || h.item !== cur.item_number) {
      cur = {
        item_number: h.item, name: h.name, address: h.address, city: h.city, state: h.state, zip: h.zip,
        submarket: h.submarket, county: h.county || null, size_range: h.size_range, property_use: h.property_use,
        first_page: page, pages: [], labels: {}, suites: [], overview: [], highlights: [], floor_plans: [],
      };
      buildings.push(cur);
    }
    cur.pages.push(page);
    // Walk sections on this page. Text before the first section heading is a label block (layout B).
    let section = 'Labels', buf = [];
    const flush = () => {
      if (!section) return;
      if (/^Available Spaces/.test(section)) cur.suites.push(...parseSpacesBlock(buf));
      else if (section === 'Labels' || section === 'Listing Details' || section === 'Building Details') parseLabelBlock(buf, cur.labels);
      else if (section === 'Leasing Highlights') cur.highlights.push(...parseBullets(buf));
      else if (section === 'Property Overview') {
        const paras = buf.join('\n').split(/\n\s*\n/).map(clean).filter((p) => p && !/^No Data Available$/i.test(p));
        cur.overview.push(...paras);
      }
    };
    for (const line of lines.slice(h.bodyStart)) {
      const sm = line.trim().match(SECTION_RE);
      if (sm && line.search(/\S/) < 6) { flush(); section = sm[1]; buf = []; continue; }
      if (TABLE_HEADER_RE.test(line) && !/^Available Spaces/.test(section)) {
        // Layout B has no "Available Spaces" heading; the table header starts the suite list.
        // Its "Floor / Building" over-header line may already be in the label buffer; drop it.
        if (buf.length && /^\s+Floor\s+Building\s*$/.test(buf[buf.length - 1])) buf.pop();
        flush(); section = 'Available Spaces'; buf = [];
        continue;
      }
      buf.push(line);
    }
    flush();
    const fp = text.match(FP_RE);
    if (fp || /^\s*Floor Plans?\s*$/m.test(text)) cur.floor_plans.push({ page, caption: fp ? clean(fp[0]) : 'Floor plan', suite: fp ? fp[2] : null });
  });

  return {
    buildings: buildings.map((b) => {
      const L = b.labels;
      const [builtY, renovY] = String(L['Built/Renovated'] || L['Year Built/Renovated'] || '').split('/').map((x) => x.trim());
      const rent = L['Asking Rent'] || null;
      const svc = L['Service Type'] || (() => {
        const m = String(rent || '').match(/\/(FS|NNN|MG|IG|TBD|Mod Gross|Full Service|\+\s?Elec)\s*$/i);
        return m ? ({ FS: 'Full Service', NNN: 'Triple Net', MG: 'Modified Gross', IG: 'Industrial Gross' }[m[1].toUpperCase()] || m[1]) : null;
      })();
      if (b.county && !L['County']) L['County'] = b.county;
      return {
        item_number: b.item_number, name: b.name, address: b.address, city: b.city, state: b.state, zip: b.zip,
        submarket: b.submarket, property_type: L['Primary Property Type'] || b.property_use,
        building_class: L['Building Class'] || L['Class'] || null,
        rba_sf: toInt(L['Building Size'] || L['RBA (% Leased)'] || L['GLA (% Leased)'] || L['RBA'] || L['GLA'] || L['Rentable Building Area']),
        year_built: toInt(L['Year Built'] || L['Built'] || builtY), renovated: L['Renovated'] || L['Year Renovated'] || renovY || null,
        stories: toInt(L['Stories'] || L['Number of Floors']), typical_floor: L['Typical Floor'] || null,
        parking: L['Parking'] || L['Parking Spaces'] || null,
        available_size: L['Available Size'] || L['Available'] || L['Total Available'] || b.size_range, asking_rent: rent,
        service_type: svc, occupancy: L['Occupancy'] || null, term: L['Term'] || null,
        overview: b.overview.join('\n\n') || null, highlights: b.highlights,
        details: Object.entries(L).filter(([, v]) => v != null && v !== ''),
        first_page: b.first_page, pages: b.pages, suites: b.suites, floor_plans: b.floor_plans,
      };
    }),
  };
}

module.exports = { extract };
