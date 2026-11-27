(() => {
  'use strict';
  const token = location.pathname.split('/')[2];
  const API = `/api/s/${token}`;
  const cfg = window.APP_CONFIG || {};
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = {
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3zm0 0 4-7a2.5 2.5 0 0 1 3 2.6L13.5 9H19a2 2 0 0 1 2 2.3l-1.3 8A2 2 0 0 1 17.7 21H7"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3zm0 0-4 7a2.5 2.5 0 0 1-3-2.6l.5-3.4H5a2 2 0 0 1-2-2.3l1.3-8A2 2 0 0 1 6.3 3H17"/></svg>',
  };
  const COLORS = { n: '#12294a', u: '#2f8a5b', d: '#b9473a' };
  const REASONS = {
    down: ['Too far', 'Building too old', 'Too expensive', 'Too small', 'Too large', 'Not enough parking', 'Poor access', "Don't like the look"],
    up: ['Great location', 'Good price', 'Like the building', 'Good parking', 'Want to tour'],
  };
  const STAR = '<svg viewBox="0 0 24 24"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/></svg>';
  const starsHtml = (n) => n == null ? '' : `<span class="stars" title="CoStar rating: ${n} of 5 stars" aria-label="CoStar rating ${n} of 5">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? 'on' : ''}">${STAR}</i>`).join('')}</span>`;
  const yearOf = (b) => b.year_built || null;
  const { money, money2 } = window.Cost;
  const monthly = (s, b) => window.Cost.monthly(s, b, data.survey.nnn_estimate);
  const moneyRange = (m) => window.Cost.range(m.lo, m.hi);
  function minMonthly(b) {
    const ms = b.suites.map((s) => monthly(s, b)).filter(Boolean);
    if (!ms.length) return null;
    return { lo: Math.min(...ms.map((m) => m.lo)), est: ms.some((m) => m.nnnSource === 'estimate'), missing: ms.some((m) => m.nnnSource === 'missing') };
  }
  const quickFacts = (b) => [
    yearOf(b) ? `Built ${yearOf(b)}` : null,
    b.renovated ? `Renov. ${String(b.renovated).replace(/^[A-Za-z]{3}\s+/, '')}` : null,
    b.parking ? `${String(b.parking).replace(/Spaces?/i, 'parking')}` : null,
  ].filter(Boolean).join(' · ');
  // CoStar label -> editable column, so broker edits win over the PDF value.
  const LABEL_COL = { 'Available Size': 'available_size', 'Asking Rent': 'asking_rent', 'Service Type': 'service_type', 'Occupancy': 'occupancy',
    'Term': 'term', 'Primary Property Type': 'property_type', 'Building Class': 'building_class', 'Year Built': 'year_built',
    'Renovated': 'renovated', 'Stories': 'stories', 'Typical Floor': 'typical_floor', 'Parking': 'parking', 'Building Size': 'rba_sf' };

  let data = null, map, markers = {}, selected = null, filter = 'all';
  const openNotes = new Set();
  let activeTab = 'overview';
  let lb = { items: [], i: 0 };

  const state = (b) => (b.vote?.vote === 1 ? 'u' : b.vote?.vote === -1 ? 'd' : 'n');
  const visible = () => data.buildings.filter((b) => filter === 'all' || (filter === 'up' && state(b) === 'u') || (filter === 'down' && state(b) === 'd') || (filter === 'none' && state(b) === 'n'));
  const fmtInt = (n) => (n == null ? null : Number(n).toLocaleString('en-US'));
  const rentStr = (b) => b.asking_rent && !/not disclosed/i.test(b.asking_rent) ? `${b.asking_rent.replace('/SF/year', '/SF/yr')}${b.service_type ? ` (${b.service_type})` : ''}` : 'Rent not disclosed';

  function pinIcon(b) {
    const st = state(b), sel = selected === b.id;
    return L.divIcon({
      className: `pin${sel ? ' sel' : ''}`, iconSize: [30, 40], iconAnchor: [15, 40], tooltipAnchor: [0, -36],
      html: `<svg width="30" height="40" viewBox="0 0 30 40"><path d="M15 39s13-13.6 13-24A13 13 0 0 0 2 15c0 10.4 13 24 13 24z" fill="${COLORS[st]}" stroke="${sel ? '#c9a24b' : '#fff'}" stroke-width="${sel ? 3 : 2}"/></svg><span>${b.ord}</span>`,
    });
  }

  async function load() {
    const r = await fetch(API);
    if (!r.ok) { $('#surveyTitle').textContent = 'Survey not found'; return; }
    data = await r.json();
    document.title = `${data.survey.title} · Tenant Consulting`;
    $('#surveyTitle').textContent = data.survey.title;
    $('#clientLine').textContent = data.survey.client_name ? `Prepared for ${data.survey.client_name}` : 'Property Survey';
    if (cfg.companyUrl) $('#logoLink').href = cfg.companyUrl;
    if (cfg.brokerName || cfg.brokerEmail || cfg.brokerPhone) {
      $('#contact').innerHTML = `<div class="eyebrow">Your Tenant Consulting advisor</div><b>${esc(cfg.brokerName)}</b>
        ${cfg.brokerPhone ? `<a href="tel:${esc(cfg.brokerPhone.replace(/[^\d+]/g, ''))}">${esc(cfg.brokerPhone)}</a>` : ''}
        ${cfg.brokerEmail ? `<a href="mailto:${esc(cfg.brokerEmail)}?subject=${encodeURIComponent(data.survey.title)}">${esc(cfg.brokerEmail)}</a>` : ''}`;
    }
    if (data.survey.status !== 'ready') {
      $('#cards').innerHTML = '<li class="empty">This survey is still being prepared. Please check back shortly.</li>';
      return;
    }
    initMap();
    renderList();
    renderTally();
    const m = location.hash.match(/^#b(\d+)$/);
    if (m && data.buildings.find((b) => b.id === Number(m[1]))) openDetail(Number(m[1]), { fly: true });
  }

  function initMap() {
    map = L.map('map', { zoomControl: true, scrollWheelZoom: true });
    L.tileLayer(cfg.tileUrl, { maxZoom: 19, attribution: cfg.tileAttribution, subdomains: 'abc' }).addTo(map);
    for (const b of data.buildings) {
      if (b.lat == null || b.lng == null) continue;
      const m = L.marker([b.lat, b.lng], { icon: pinIcon(b), riseOnHover: true, title: b.name || b.address })
        .addTo(map)
        .bindTooltip(`${b.ord}. ${esc(b.name || b.address)}`, { className: 'pin-tip', direction: 'top' })
        .on('click', () => openDetail(b.id));
      markers[b.id] = m;
    }
    fitAll();
    $('#fitBtn').onclick = fitAll;
  }
  function fitAll() {
    const pts = Object.values(markers).map((m) => m.getLatLng());
    if (pts.length === 1) map.setView(pts[0], 15);
    else if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 15 });
    else map.setView([38.9072, -77.0369], 11);
  }
  function refreshPin(b) { markers[b.id]?.setIcon(pinIcon(b)); }

  function voteButtons(b, big) {
    const v = b.vote?.vote;
    return `<span class="votes" data-bid="${b.id}">
      <button class="vbtn up ${big ? 'big' : ''} ${v === 1 ? 'on' : ''}" data-v="1" aria-pressed="${v === 1}" title="Thumbs up">${ICON.up}${big ? 'Interested' : ''}</button>
      <button class="vbtn down ${big ? 'big' : ''} ${v === -1 ? 'on' : ''}" data-v="-1" aria-pressed="${v === -1}" title="Thumbs down">${ICON.down}${big ? 'Pass' : ''}</button></span>`;
  }

  /** Note area: collapsed shows the note (or an "Add a note" link); open shows reason chips + text box. */
  function noteBlock(b, open, inDetail) {
    const note = b.vote?.comment || '';
    const kind = b.vote?.vote === -1 ? 'down' : b.vote?.vote === 1 ? 'up' : null;
    const chips = (kind ? REASONS[kind] : [...REASONS.down.slice(0, 4), ...REASONS.up.slice(0, 3)]);
    if (!open && !inDetail) {
      return `<div class="note-line" data-bid="${b.id}">${note ? `<span class="note-text">“${esc(note)}”</span> <button class="linkbtn" data-note-open>Edit note</button>` : `<button class="linkbtn" data-note-open>＋ Add a note for your advisor</button>`}</div>`;
    }
    return `<div class="note-ed" data-bid="${b.id}">
      ${inDetail ? '' : `<div class="note-q">${kind === 'down' ? 'What ruled it out?' : kind === 'up' ? 'What do you like about it?' : 'Note for your advisor'}</div>`}
      <div class="chips">${chips.map((c) => `<button class="chip ${note.toLowerCase().includes(c.toLowerCase()) ? 'on' : ''}" data-chip="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <textarea class="note-input" rows="2" placeholder="Type a note, e.g. “too far from Metro”, “building too old”">${esc(note)}</textarea>
      <div class="note-foot"><span class="saved"></span>${inDetail ? '' : '<button class="linkbtn" data-note-close>Done</button>'}</div>
    </div>`;
  }

  function renderList() {
    const counts = { all: data.buildings.length, up: 0, down: 0, none: 0 };
    data.buildings.forEach((b) => { const s = state(b); counts[s === 'u' ? 'up' : s === 'd' ? 'down' : 'none']++; });
    document.querySelectorAll('#filters button').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset.f === filter);
      btn.innerHTML = `${btn.textContent.replace(/\s*\d+$/, '')}<span class="c">${counts[btn.dataset.f]}</span>`;
    });
    const list = visible();
    $('#cards').innerHTML = list.length ? list.map((b) => {
      const st = state(b);
      const nSuites = b.suites.length;
      return `<li class="card ${st === 'u' ? 'voted-up' : st === 'd' ? 'voted-down' : ''}" data-id="${b.id}">
        <div class="ph" style="${b.photo_url ? `background-image:url('${b.photo_url}')` : ''}"><span class="num ${st}">${b.ord}</span></div>
        <div class="body">
          <div class="nm">${esc(b.name || b.address)}</div>
          <div class="ad">${esc(b.name ? b.address : '')}${b.name ? ', ' : ''}${esc(b.city || '')}${b.state ? ', ' + esc(b.state) : ''}</div>
          <div class="facts">
            ${b.available_size ? `<span><b>${esc(b.available_size)}</b> avail.</span>` : ''}
            <span>${esc(rentStr(b))}</span>
            ${nSuites ? `<span>${nSuites} suite${nSuites > 1 ? 's' : ''}</span>` : ''}
            ${(() => { const m = minMonthly(b); return m ? `<span class="mo">From <b>${money(m.lo)}/mo</b>${m.est ? '<sup title="Includes estimated NNN">*</sup>' : ''}${m.missing ? '<sup title="Base rent only; NNN not included">†</sup>' : ''}</span>` : ''; })()}
          </div>
          ${quickFacts(b) ? `<div class="qf">${esc(quickFacts(b))}</div>` : ''}
          ${b.tour_url || (b.media || []).some((m) => m.kind === 'photo') || b.floor_plans.length ? `<div class="badges">${b.tour_url ? '<span>▶ Virtual tour</span>' : ''}${(b.media || []).filter((m) => m.kind === 'photo').length ? `<span>📷 ${(b.media || []).filter((m) => m.kind === 'photo').length} photos</span>` : ''}${b.floor_plans.length ? '<span>Floor plans</span>' : ''}</div>` : ''}
          <div class="row"><span class="muted" style="font-size:12px">${starsHtml(b.costar_rating)} ${esc([b.building_class && `Class ${b.building_class}`, b.property_type].filter(Boolean).join(' · '))}</span>${voteButtons(b)}</div>
          ${noteBlock(b, openNotes.has(b.id))}
        </div></li>`;
    }).join('') : '<li class="empty">No buildings in this view.</li>';
  }

  function renderTally() {
    const up = data.buildings.filter((b) => state(b) === 'u').length;
    const down = data.buildings.filter((b) => state(b) === 'd').length;
    $('#tally').innerHTML = `<span>${ICON.up} ${up}</span><span>${ICON.down} ${down}</span><span>${data.buildings.length} buildings</span>`;
  }

  function specRow(label, val) { return val == null || val === '' ? '' : `<div><dt>${label}</dt><dd>${esc(val)}</dd></div>`; }

  /** Every CoStar label/value pair, with the broker's edited values taking priority. */
  function detailRows(b) {
    const rows = []; const seen = new Set();
    for (const [label, val] of b.details || []) {
      const col = LABEL_COL[label];
      let v = col ? b[col] : val;
      if (col === 'rba_sf' && v) v = `${fmtInt(v)} SF`;
      if (v == null || v === '') v = val;
      rows.push([label, v]); if (col) seen.add(col);
    }
    for (const [label, col] of Object.entries(LABEL_COL)) {
      if (seen.has(col) || b[col] == null || b[col] === '') continue;
      rows.push([label, col === 'rba_sf' ? `${fmtInt(b[col])} SF` : b[col]]);
    }
    if (b.costar_rating != null) rows.splice(Math.min(rows.length, 1), 0, ['CoStar Rating', `${b.costar_rating} of 5 stars`]);
    return rows.map(([l, v]) => specRow(l, v)).join('');
  }

  function openDetail(id, { fly = true } = {}) {
    const b = data.buildings.find((x) => x.id === id);
    if (!b) return;
    const prevSel = selected; selected = id;
    if (prevSel) { const pb = data.buildings.find((x) => x.id === prevSel); pb && refreshPin(pb); }
    refreshPin(b);
    history.replaceState(null, '', `#b${id}`);
    const idx = data.buildings.indexOf(b);
    const prev = data.buildings[idx - 1], next = data.buildings[idx + 1];
    const plansBySuite = (sid) => b.floor_plans.filter((f) => f.suite_id === sid);
    const thumbs = (arr) => arr.length ? `<div class="fp-thumbs">${arr.map((f) => `<button class="fp-thumb" data-src="${f.url}" data-cap="${esc(f.caption || 'Floor plan')}"><img loading="lazy" src="${f.url}" alt=""><span>${esc(f.caption || 'Floor plan')}</span></button>`).join('')}</div>` : '';
    const st = state(b);
    const photos = (b.media || []).filter((m) => m.kind === 'photo');
    const flyerPages = (b.media || []).filter((m) => m.kind === 'flyer_page');
    const pdfs = (b.media || []).filter((m) => m.kind === 'pdf');
    const allPlans = b.floor_plans.filter((f, i, arr) => arr.findIndex((x) => x.url === f.url) === i); // a plan shared by 2 suites shows once
    const nMedia = photos.length + allPlans.length + flyerPages.length;
    const costs = b.suites.map((s) => ({ s, m: monthly(s, b) })).filter((x) => x.m);
    const tabs = [['overview', 'Overview'], ['suites', `Suites (${b.suites.length})`], ...(costs.length ? [['cost', 'Monthly cost']] : []), ...(nMedia ? [['media', `Photos & plans (${nMedia})`]] : [])];
    if (!tabs.some(([k]) => k === activeTab)) activeTab = 'overview';
    const gallery = (items, cls = '') => `<div class="gallery ${cls}">${items.map((m, i) => `<button class="g-item" data-gal="${cls}" data-i="${i}" data-src="${m.url}" data-cap="${esc(m.caption || '')}"><img loading="lazy" src="${m.url}" alt="${esc(m.caption || '')}">${m.caption ? `<span>${esc(m.caption)}</span>` : ''}</button>`).join('')}</div>`;

    const costNotes = () => {
      const ms = costs.map((x) => x.m); const notes = [];
      if (ms.some((m) => m.nnnSource === 'estimate')) notes.push(`* NNN charges (taxes, insurance, common area) are an <b>estimate only</b> of ${money2(Number(data.survey.nnn_estimate))}/SF/yr for this area, not a figure quoted by the landlord. Actual NNN for this building may differ.`);
      if (ms.some((m) => m.nnnSource === 'advisor')) notes.push(`NNN of ${money2(Number(b.nnn_override))}/SF/yr provided by your advisor for this building.`);
      if (ms.some((m) => m.nnnSource === 'missing')) notes.push('† This space is quoted triple net (NNN); taxes, insurance and common area charges are extra and not included here.');
      notes.push('Estimates before concessions, escalations and any utilities not included in the rent.');
      return `<div class="cost-notes">${notes.map((n) => `<p>${n}</p>`).join('')}</div>`;
    };
    const suiteLabel = (s) => [s.suite ? `Suite ${s.suite}` : null, s.floor ? `${s.floor} floor` : null].filter(Boolean).join(' · ') || 'Space';
    const sfRange = (m) => (m.sfLo === m.sfHi ? fmtInt(m.sfLo) : `${fmtInt(m.sfLo)}–${fmtInt(m.sfHi)}`);

    const panes = {
      overview: `
        ${b.broker_notes ? `<h3 class="sec">Advisor notes</h3><div class="prose advisor"><p>${esc(b.broker_notes).replace(/\n/g, '<br>')}</p></div>` : ''}
        <h3 class="sec">Property details</h3>
        <dl class="specs">${detailRows(b)}</dl>
        ${b.highlights?.length ? `<h3 class="sec">Highlights</h3><div class="prose"><ul>${b.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul></div>` : ''}
        ${b.overview ? `<h3 class="sec">About the property</h3><div class="prose">${b.overview.split(/\n\n+/).map((p) => `<p>${esc(p)}</p>`).join('')}</div>` : ''}`,
      suites: b.suites.length ? b.suites.map((s) => {
        const m = monthly(s, b);
        const plans = b.floor_plans.filter((f) => f.suite_id === s.id);
        return `<div class="suite">
            <div class="top"><span class="label">${esc(suiteLabel(s))}</span><span class="sf">${esc(s.sf || '')}${s.sf ? ' SF' : ''}</span></div>
            <div class="meta">
              ${s.address ? `<span>${esc(s.address)}</span>` : ''}
              <span>Rent <b>${esc(s.rent || '—')}${s.rent_type ? ' ' + esc(s.rent_type) : ''}</b></span>
              ${s.space_use ? `<span>${esc(s.space_use)}</span>` : ''}
              ${s.lease_type ? `<span>${esc(s.lease_type)}</span>` : ''}
              ${s.occupancy ? `<span>Avail. <b>${esc(s.occupancy)}</b></span>` : ''}
              ${s.term ? `<span>Term <b>${esc(s.term)}</b></span>` : ''}
              ${s.floor_status ? `<span>${esc(s.floor_status)} floor</span>` : ''}
            </div>
            ${s.notes ? `<ul class="suite-notes">${s.notes.split('\n').filter(Boolean).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
            ${m ? `<div class="monthly"><span>Est. monthly <b>${moneyRange(m)}</b>${m.nnnSource === 'estimate' ? '<sup>*</sup>' : m.nnnSource === 'missing' ? '<sup>†</sup>' : ''}</span><button class="linkbtn" data-tab="cost">See cost breakdown</button></div>` : ''}
            ${plans.length ? gallery(plans.map((f) => ({ url: f.url, caption: f.caption || 'Floor plan' })), 'plans-s' + s.id) : ''}
          </div>`;
      }).join('') + (costs.length ? costNotes() : '') : '<p class="muted">Contact your advisor for suite details.</p>',
      cost: `
        <p class="muted" style="margin:0 0 10px;font-size:12.5px">Estimated monthly and annual occupancy cost for each available space.</p>
        <div class="cost-table-wrap"><table class="cost-table">
          <thead><tr><th>Space</th><th class="r">SF</th><th class="r">Rent<br><small>$/SF/yr</small></th><th class="r">NNN<br><small>$/SF/yr</small></th><th class="r">Total<br><small>$/SF/yr</small></th><th class="r">Monthly<br><small>annual</small></th></tr></thead>
          <tbody>${costs.map(({ s, m }) => `<tr>
            <td>${esc(s.suite ? `Suite ${s.suite}` : suiteLabel(s))}${s.rent_type ? ` <small class="muted">${esc(s.rent_type)}</small>` : ''}</td>
            <td class="r">${sfRange(m)}</td>
            <td class="r">${window.Cost.range(m.rLo, m.rHi, money2)}</td>
            <td class="r">${m.nnnSource === 'advisor' ? money2(m.nnn) : m.nnnSource === 'estimate' ? `${money2(m.nnn)}<sup>*</sup>` : m.nnnSource === 'missing' ? '<span class="muted">extra†</span>' : '<span class="muted">incl.</span>'}</td>
            <td class="r">${window.Cost.range(m.rLo + m.nnn, m.rHi + m.nnn, money2)}</td>
            <td class="r"><b>${moneyRange(m)}</b><br><small class="muted">${window.Cost.range(m.lo * 12, m.hi * 12)}/yr</small></td></tr>`).join('')}</tbody>
        </table></div>
        ${b.suites.length > costs.length ? `<p class="muted" style="font-size:12px">${b.suites.length - costs.length} space(s) not shown: rent not disclosed.</p>` : ''}
        ${costNotes()}`,
      media: `
        ${photos.length ? `<h3 class="sec">Photos (${photos.length})</h3>${gallery(photos, 'photos')}` : ''}
        ${allPlans.length ? `<h3 class="sec">Floor plans (${allPlans.length})</h3>${gallery(allPlans.map((f) => ({ url: f.url, caption: f.caption || 'Floor plan' })), 'plans')}` : ''}
        ${flyerPages.length ? `<h3 class="sec">Flyer</h3>${gallery(flyerPages, 'flyer')}` : ''}
        ${pdfs.length ? `<div class="downloads">${pdfs.map((d) => `<a class="btn small" href="${d.url}" target="_blank" rel="noopener">📄 ${esc(d.caption || 'Flyer')} (PDF)</a>`).join('')}</div>` : ''}`,
    };

    $('#detailView').innerHTML = `
      <div class="detail-top">
        <button class="btn small" id="backBtn">← All buildings</button>
        <div class="nav"><button class="btn small" ${prev ? `data-go="${prev.id}"` : 'disabled'}>‹ Prev</button><button class="btn small" ${next ? `data-go="${next.id}"` : 'disabled'}>Next ›</button></div>
      </div>
      <div class="hero" style="${b.photo_url ? `background-image:url('${b.photo_url}')` : ''}" ${photos.length ? 'data-tab="media" title="See all photos"' : ''}><span class="num ${st}">${b.ord}</span>${photos.length ? `<span class="hero-count">📷 ${photos.length}</span>` : ''}</div>
      <div class="dbody">
        <h2>${esc(b.name || b.address)}</h2>
        ${b.costar_rating != null ? `<div class="rating-line">${starsHtml(b.costar_rating)}<span class="muted">CoStar rating</span></div>` : ''}
        <div class="addr">${esc(b.address)}, ${esc(b.city || '')}${b.state ? ', ' + esc(b.state) : ''} ${esc(b.zip || '')}${b.submarket ? `<br><span class="pill">${esc(b.submarket)}</span>` : ''}</div>
        ${b.tour_url || pdfs.length ? `<div class="quick-links">
          ${b.tour_url ? `<a class="btn small tour" href="${esc(b.tour_url)}" target="_blank" rel="noopener">▶ Virtual tour</a>` : ''}
          ${pdfs.map((d) => `<a class="btn small" href="${d.url}" target="_blank" rel="noopener">📄 Flyer</a>`).join('')}
        </div>` : ''}
        <div class="vote-panel">
          <div class="q">Is this building worth a closer look?</div>
          ${voteButtons(b, true)}
          ${noteBlock(b, true, true)}
        </div>
        <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" class="tab ${k === activeTab ? 'on' : ''}" data-tab="${k}" aria-selected="${k === activeTab}">${l}</button>`).join('')}</div>
        ${tabs.map(([k]) => `<section class="pane" data-pane="${k}" ${k === activeTab ? '' : 'hidden'}>${panes[k]}</section>`).join('')}
      </div>`;
    $('#listView').hidden = true;
    $('#detailView').hidden = false;
    $('#side').classList.add('detail-open');
    $('#side').scrollTop = 0;
    if (fly && markers[id]) map.flyTo(markers[id].getLatLng(), Math.max(map.getZoom(), 15), { duration: 0.6 });
  }

  function closeDetail() {
    const prevSel = selected; selected = null;
    const pb = data.buildings.find((x) => x.id === prevSel); pb && refreshPin(pb);
    history.replaceState(null, '', location.pathname);
    $('#detailView').hidden = true; $('#listView').hidden = false;
    $('#side').classList.remove('detail-open');
    renderList();
    const card = document.querySelector(`.card[data-id="${prevSel}"]`);
    card?.scrollIntoView({ block: 'nearest' });
  }

  async function sendVote(b, vote, comment) {
    const before = b.vote;
    b.vote = vote === 0 && !comment ? null : { vote, comment: comment ?? b.vote?.comment ?? null };
    refreshPin(b); renderTally();
    const r = await fetch(`${API}/vote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ building_id: b.id, vote, comment }) });
    if (!r.ok) { b.vote = before; refreshPin(b); renderTally(); alert('Sorry, your vote could not be saved. Please try again.'); return; }
    document.querySelectorAll(`.note-ed[data-bid="${b.id}"] .saved`).forEach((m) => { m.textContent = 'Saved ✓'; setTimeout(() => { m.textContent = ''; }, 1500); });
  }

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  document.addEventListener('click', (e) => {
    const vb = e.target.closest('.vbtn');
    if (vb) {
      e.stopPropagation();
      const bid = Number(vb.closest('.votes').dataset.bid);
      const b = data.buildings.find((x) => x.id === bid);
      const v = Number(vb.dataset.v);
      const nv = b.vote?.vote === v ? 0 : v; // tap again to clear
      sendVote(b, nv, b.vote?.comment ?? undefined);
      vb.closest('.votes').querySelectorAll('.vbtn').forEach((x) => { const on = Number(x.dataset.v) === nv; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
      if (!$('#listView').hidden) { if (nv !== 0 && !b.vote?.comment) openNotes.add(bid); renderList(); }
      else {
        const n = document.querySelector('.hero .num'); if (n) n.className = `num ${state(b)}`;
        const ed = document.querySelector('#detailView .note-ed'); if (ed) ed.outerHTML = noteBlock(b, true, true);
      }
      return;
    }
    const noteArea = e.target.closest('.note-line, .note-ed');
    if (noteArea) {
      e.stopPropagation();
      const bid = Number(noteArea.dataset.bid);
      const b = data.buildings.find((x) => x.id === bid);
      if (e.target.closest('[data-note-open]')) { openNotes.add(bid); renderList(); document.querySelector(`.note-ed[data-bid="${bid}"] textarea`)?.focus(); }
      else if (e.target.closest('[data-note-close]')) { openNotes.delete(bid); renderList(); }
      else if (e.target.closest('[data-chip]')) {
        const chip = e.target.closest('[data-chip]'); const ta = noteArea.querySelector('textarea');
        const c = chip.dataset.chip; let parts = ta.value.split(/;\s*/).map((x) => x.trim()).filter(Boolean);
        const has = parts.some((p) => p.toLowerCase() === c.toLowerCase());
        parts = has ? parts.filter((p) => p.toLowerCase() !== c.toLowerCase()) : [...parts, c];
        ta.value = parts.join('; '); chip.classList.toggle('on', !has);
        sendVote(b, b.vote?.vote ?? 0, ta.value);
      }
      return;
    }
    const card = e.target.closest('.card');
    if (card) return openDetail(Number(card.dataset.id));
    if (e.target.id === 'backBtn') return closeDetail();
    const go = e.target.closest('[data-go]');
    if (go) return openDetail(Number(go.dataset.go));
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      activeTab = tab.dataset.tab;
      document.querySelectorAll('#detailView .tab').forEach((t) => { const on = t.dataset.tab === activeTab; t.classList.toggle('on', on); t.setAttribute('aria-selected', on); });
      document.querySelectorAll('#detailView .pane').forEach((p) => { p.hidden = p.dataset.pane !== activeTab; });
      document.querySelector('#detailView .tabs')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    const g = e.target.closest('.g-item');
    if (g) {
      lb.items = [...document.querySelectorAll(`.g-item[data-gal="${g.dataset.gal}"]`)].map((x) => ({ src: x.dataset.src, cap: x.dataset.cap }));
      lb.i = Number(g.dataset.i); showLb(); return;
    }
    if (e.target.closest('.lb-nav')) { lb.i = (lb.i + (e.target.closest('.lb-nav').classList.contains('next') ? 1 : -1) + lb.items.length) % lb.items.length; showLb(); return; }
    if (e.target.closest('#lightbox')) { $('#lightbox').hidden = true; return; }
    const f = e.target.closest('#filters button');
    if (f) { filter = f.dataset.f; renderList(); }
  });
  const saveNote = debounce((ta) => {
    const bid = Number(ta.closest('.note-ed').dataset.bid);
    const b = data.buildings.find((x) => x.id === bid);
    sendVote(b, b.vote?.vote ?? 0, ta.value);
  }, 700);
  document.addEventListener('input', (e) => { if (e.target.classList.contains('note-input')) saveNote(e.target); });
  document.addEventListener('mouseover', (e) => {
    const card = e.target.closest('.card');
    document.querySelectorAll('.pin.hover').forEach((p) => p.classList.remove('hover'));
    if (card && markers[card.dataset.id]) markers[card.dataset.id].openTooltip();
  });
  function showLb() {
    const it = lb.items[lb.i]; if (!it) return;
    $('#lbImg').src = it.src; $('#lbCap').textContent = `${it.cap || ''}${lb.items.length > 1 ? `  (${lb.i + 1} of ${lb.items.length})` : ''}`;
    document.querySelectorAll('.lb-nav').forEach((n) => { n.hidden = lb.items.length < 2; });
    $('#lightbox').hidden = false;
  }
  document.addEventListener('keydown', (e) => {
    if (!$('#lightbox').hidden && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { lb.i = (lb.i + (e.key === 'ArrowRight' ? 1 : -1) + lb.items.length) % lb.items.length; showLb(); return; }
    if (e.key === 'Escape') { if (!$('#lightbox').hidden) $('#lightbox').hidden = true; else if (selected) closeDetail(); }
  });

  load();
})();
