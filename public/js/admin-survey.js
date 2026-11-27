(() => {
  const id = location.pathname.split('/').pop();
  const $ = (s, el = document) => el.querySelector(s);
  const cfg = window.APP_CONFIG || {};
  let data, map, markers = {}, open = new Set(), placing = null, pollTimer;
  const COLORS = { n: '#12294a', u: '#2f8a5b', d: '#b9473a' };
  const st = (b) => (b.vote?.vote === 1 ? 'u' : b.vote?.vote === -1 ? 'd' : 'n');

  const B_FIELDS = [
    ['name', 'Building name', 'w2'], ['address', 'Street address', 'w2'], ['city', 'City'], ['state', 'State'], ['zip', 'ZIP'], ['submarket', 'Submarket'],
    ['available_size', 'Available'], ['asking_rent', 'Asking rent'], ['service_type', 'Service type'], ['occupancy', 'Occupancy'],
    ['term', 'Term'], ['property_type', 'Property type'], ['building_class', 'Class'], ['rba_sf', 'Building SF'],
    ['year_built', 'Year built'], ['renovated', 'Renovated'], ['stories', 'Stories'], ['typical_floor', 'Typical floor'],
    ['parking', 'Parking'], ['costar_rating', 'CoStar stars (0-5)'], ['ord', 'Pin #'], ['lat', 'Latitude'],
    ['tour_url', 'Virtual tour link (Matterport, YouTube, etc.)', 'w4'],
    ['broker_notes', 'Your notes to the client (shown on the survey)', 'w4', 'textarea'],
    ['overview', 'Property overview', 'w4', 'textarea'], ['highlights', 'Highlights (one per line)', 'w4', 'textarea'],
    ['details', 'All CoStar details shown to the client (one per line, "Label: value")', 'w4', 'textarea'],
  ];
  const S_FIELDS = [['suite', 'Suite', 60], ['floor', 'Floor', 50], ['sf', 'SF', 90], ['rent', 'Rent', 80], ['rent_type', 'Type', 45],
    ['space_use', 'Use', 100], ['lease_type', 'Lease', 70], ['occupancy', 'Avail.', 90], ['term', 'Term', 90], ['address', 'Address', 130], ['notes', 'Notes', 200]];

  async function load() {
    data = await api(`/api/admin/surveys/${id}`);
    const s = data.survey;
    document.title = `${s.title} · Edit survey`;
    $('#title').value = s.title; $('#client').value = s.client_name || '';
    $('#nnn').value = s.nnn_estimate ?? '';
    $('#archBtn').textContent = s.archived ? 'Unarchive' : 'Archive';
    $('#srcLine').textContent = `Source: ${s.pdf_name || 'PDF'} · ${data.buildings.length} buildings · ${s.view_count} client view${s.view_count === 1 ? '' : 's'}${s.last_viewed_at ? ', last ' + fmtDate(s.last_viewed_at) : ''}`;
    const link = `${location.origin}/s/${s.token}`;
    $('#link').value = link; $('#openBtn').href = link;
    $('#banner').innerHTML = s.status === 'processing' ? `<div class="status-banner">Processing the PDF: ${esc(s.status_detail || '')}…</div>`
      : s.status === 'error' ? `<div class="status-banner err">Could not process this PDF: ${esc(s.status_detail)}</div>`
      : (() => { const miss = data.buildings.filter((b) => b.lat == null).length; return miss ? `<div class="status-banner">${miss} building${miss > 1 ? 's' : ''} could not be located from the address. Open ${miss > 1 ? 'each one' : 'it'} below and use "Place on map by clicking".</div>` : ''; })();
    clearTimeout(pollTimer);
    if (s.status === 'processing') pollTimer = setTimeout(load, 2500);
    renderResults(); renderBuildings(); renderMap(); renderRuledOutPanel();
  }

  const RO_REASONS = ['Too far from Metro', 'Over budget', 'Too small', 'Too large', 'Building too old', 'Not enough parking', 'Space already leased', "Landlord won't do the term", 'Poor condition', 'Not available in time', 'Location / commute'];
  function renderRuledOutPanel() {
    $('#roForm .ro-chips').innerHTML = RO_REASONS.map((r) => `<button type="button" class="chip" data-ro-chip="${esc(r)}">${esc(r)}</button>`).join('');
    const inSurvey = data.buildings.filter((b) => b.ruled_out);
    const other = data.survey.ruled_out || [];
    $('#roList').innerHTML = (inSurvey.length || other.length) ? `<table class="ro-table"><thead><tr><th>Building</th><th>Address</th><th>Reason (client sees this)</th><th>Date</th><th></th></tr></thead><tbody>
      ${inSurvey.map((b) => `<tr data-ro-bid="${b.id}"><td><b>#${b.ord} ${esc(b.name || b.address)}</b><br><span class="muted" style="font-size:11.5px">From this survey</span></td><td>${esc(b.address || '')}</td>
        <td><textarea data-ro-bf="ruled_out_reason" rows="2">${esc(b.ruled_out_reason || '')}</textarea></td><td class="muted">${fmtDate(b.ruled_out_at)}</td>
        <td><button class="btn small" data-ro-restore="${b.id}">Restore</button></td></tr>`).join('')}
      ${other.map((r) => `<tr data-rid="${r.id}"><td><input data-ro-f="name" value="${esc(r.name || '')}" placeholder="Name"></td><td><input data-ro-f="address" value="${esc(r.address || '')}" placeholder="Address"></td>
        <td><textarea data-ro-f="reason" rows="2">${esc(r.reason || '')}</textarea></td><td class="muted">${fmtDate(r.created_at)}</td>
        <td><button class="btn small danger" data-ro-del="${r.id}">Delete</button></td></tr>`).join('')}
      </tbody></table>` : '<p class="muted" style="font-size:13px;margin:6px 0 0">Nothing ruled out yet. Add a building above, or open a building below and click "Rule out…".</p>';
  }

  function renderResults() {
    const groups = { u: [], d: [], n: [] };
    data.buildings.filter((b) => !b.hidden && !b.ruled_out).forEach((b) => groups[st(b)].push(b));
    const li = (b) => `<li data-jump="${b.id}"><b>${b.ord}.</b> ${esc(b.name || b.address)}${b.vote?.comment ? `<span class="c">"${esc(b.vote.comment)}"</span>` : ''}</li>`;
    $('#results').innerHTML = `
      <div class="col"><h3><span class="pill up">👍 Liked · ${groups.u.length}</span></h3><ul>${groups.u.map(li).join('') || '<li class="muted">None yet</li>'}</ul></div>
      <div class="col"><h3><span class="pill down">👎 Passed · ${groups.d.length}</span></h3><ul>${groups.d.map(li).join('') || '<li class="muted">None yet</li>'}</ul></div>
      <div class="col"><h3><span class="pill gray">Not rated · ${groups.n.length}</span></h3><ul>${groups.n.map(li).join('') || '<li class="muted">All rated</li>'}</ul></div>`;
  }

  function fieldVal(b, k) {
    if (k === 'highlights') return (b.highlights || []).join('\n');
    if (k === 'details') return (b.details || []).map(([l, v]) => `${l}: ${v}`).join('\n');
    return b[k] ?? '';
  }

  /** NNN entry + a live preview of what the client's "Monthly cost" tab will show. */
  function costPanel(b) {
    const area = data.survey.nnn_estimate;
    const rows = b.suites.map((s) => ({ s, m: window.Cost.monthly(s, b, area) })).filter((x) => x.m);
    const anyNNN = b.suites.some((s) => window.Cost.isNNN(s, b));
    const src = b.nnn_override != null && b.nnn_override !== '' ? 'Your figure for this building (shown to client without the "estimate" note)'
      : area != null && area !== '' ? `Area estimate $${Number(area).toFixed(2)} from the top of this page (client sees it marked "estimate only")` : 'None set; NNN spaces show base rent only';
    return `<div class="sub"><span>Monthly cost</span></div>
      <div class="costbox">
        <label>NNN for this building, $/SF/yr <span class="muted">(leave blank to use the area estimate)</span>
          <input data-f="nnn_override" inputmode="decimal" placeholder="${area != null && area !== '' ? `area estimate: ${Number(area).toFixed(2)}` : 'e.g. 11.25'}" value="${b.nnn_override ?? ''}"></label>
        <div class="muted" style="font-size:12px">${anyNNN ? `NNN used: ${src}` : 'No spaces here are quoted NNN, so NNN is not added.'}</div>
        ${rows.length ? `<table class="ctab"><thead><tr><th>Space</th><th>SF</th><th>Rent</th><th>NNN</th><th>Monthly</th></tr></thead><tbody>${rows.map(({ s, m }) => `<tr><td>${esc(s.suite ? 'Suite ' + s.suite : s.floor || 'Space')}</td><td>${m.sfLo === m.sfHi ? m.sfLo.toLocaleString() : m.sfLo.toLocaleString() + '–' + m.sfHi.toLocaleString()}</td><td>${window.Cost.range(m.rLo, m.rHi, window.Cost.money2)}</td><td>${m.nnnSource === 'advisor' ? window.Cost.money2(m.nnn) : m.nnnSource === 'estimate' ? window.Cost.money2(m.nnn) + ' est.' : m.nnnSource === 'missing' ? 'not set' : '—'}</td><td><b>${window.Cost.range(m.lo, m.hi)}</b></td></tr>`).join('')}</tbody></table>`
          : '<div class="muted" style="font-size:12.5px">No monthly figures: suites need a rent and SF.</div>'}
      </div>`;
  }

  function mediaGrid(b) {
    const items = b.media || [];
    if (!items.length) return '';
    const label = { photo: 'Photo', flyer_page: 'Flyer page', pdf: 'PDF download' };
    return `<div class="mgrid">${items.map((m) => `<div class="mitem ${m.hidden ? 'is-hidden' : ''} ${b.photo_url === m.url ? 'is-main' : ''}" data-mid="${m.id}">
        ${m.kind === 'pdf' ? `<a class="pdfbox" href="${m.url}" target="_blank" rel="noopener">📄<span>${esc(m.source || 'PDF')}</span></a>` : `<img src="${m.url}" alt="" data-view="${m.url}" data-cap="${esc(m.caption || '')}">`}
        <div class="mc">
          <span class="kind">${label[m.kind]}${b.photo_url === m.url ? ' · Main photo' : ''}</span>
          <input data-mf="caption" value="${esc(m.caption || '')}" placeholder="Caption">
          <label class="hidechk"><input type="checkbox" data-mf="hidden" ${m.hidden ? 'checked' : ''}> Hide from client</label>
          <div class="mbtns">
            ${m.kind !== 'pdf' && b.photo_url !== m.url ? '<button class="linkbtn" data-act="makeMain">Make main photo</button>' : ''}
            ${m.kind !== 'pdf' ? '<button class="linkbtn" data-act="toPlan">Move to floor plans</button>' : ''}
            <button class="linkbtn danger" data-act="delMedia">Delete</button>
          </div>
        </div></div>`).join('')}</div>`;
  }

  async function uploadMedia(bid, files) {
    if (!files.length) return;
    const fd = new FormData(); for (const f of files) fd.append('files', f);
    const zone = document.querySelector(`[data-drop="${bid}"]`);
    zone?.classList.add('busy'); toast(`Processing ${files.length} file${files.length > 1 ? 's' : ''}…`);
    try {
      const r = await fetch(`/api/admin/buildings/${bid}/media`, { method: 'POST', body: fd });
      const res = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(res.error || 'Upload failed');
      const a = res.added || {};
      const parts = [a.photos && `${a.photos} photo${a.photos > 1 ? 's' : ''}`, a.floor_plans && `${a.floor_plans} floor plan link${a.floor_plans > 1 ? 's' : ''} (${a.matched} matched to suites)`, a.flyer_pages && `${a.flyer_pages} flyer page${a.flyer_pages > 1 ? 's' : ''}`, a.pdfs && `${a.pdfs} PDF`].filter(Boolean);
      alert(`Added ${parts.join(', ') || 'nothing'}.${a.hidden ? `\n\n${a.hidden} item(s) show listing-broker contact details and were hidden from the client. Untick "Hide from client" to show them.` : ''}${res.errors?.length ? `\n\nProblems:\n• ${res.errors.join('\n• ')}` : ''}`);
    } catch (err) { alert(err.message); }
    zone?.classList.remove('busy');
    open.add(bid); load();
  }

  function renderBuildings() {
    $('#blds').innerHTML = data.buildings.map((b) => {
      const s = st(b);
      const geo = b.lat == null ? '<span class="pill down">Not on map</span>' : b.geocode_status === 'manual' ? '<span class="pill gray">Placed by hand</span>' : '';
      return `<div class="bld ${open.has(b.id) ? 'open' : ''} ${b.hidden ? 'hidden-b' : ''}" data-id="${b.id}" id="bld-${b.id}">
        <div class="bld-head" data-toggle>
          <div class="ph" style="${b.photo_url ? `background-image:url('${b.photo_url}')` : ''}"><span class="num ${s}">${b.ord}</span></div>
          <div><div class="t">${esc(b.name || b.address || 'Untitled')}${b.costar_rating != null ? ` <span class="astars" title="CoStar rating">${'★'.repeat(b.costar_rating)}${'☆'.repeat(5 - b.costar_rating)}</span>` : ''}</div><div class="s">${esc(b.address || '')}${b.city ? ', ' + esc(b.city) : ''} · ${b.suites.length} suite${b.suites.length === 1 ? '' : 's'}${b.floor_plans.length ? ` · ${b.floor_plans.length} floor plan${b.floor_plans.length > 1 ? 's' : ''}` : ''}</div></div>
          <div class="right">${s === 'u' ? '<span class="pill up">👍 Liked</span>' : s === 'd' ? '<span class="pill down">👎 Passed</span>' : ''}${b.ruled_out ? '<span class="pill down">Ruled out</span>' : ''}${b.hidden ? '<span class="pill gray">Hidden from client</span>' : ''}${geo}</div>
        </div>
        ${b.vote?.comment ? `<div class="vote-note ${s === 'u' ? 'up' : 'down'}" style="margin:0 10px 10px">Client note: "${esc(b.vote.comment)}"</div>` : ''}
        <div class="bld-body">
          ${b.ruled_out ? `<div class="ro-note">Ruled out ${fmtDate(b.ruled_out_at)}: the client sees this under "Buildings ruled out", not on the map.<label>Reason<textarea data-f="ruled_out_reason" rows="2">${esc(b.ruled_out_reason || '')}</textarea></label></div>` : ''}
          <div class="fields">${B_FIELDS.map(([k, label, cls = '', type]) => k === 'lat'
            ? `<label>Latitude<input data-f="lat" value="${b.lat == null ? '' : b.lat.toFixed(6)}"></label><label>Longitude<input data-f="lng" value="${b.lng == null ? '' : b.lng.toFixed(6)}"></label>`
            : `<label class="${cls}">${label}${type === 'textarea' ? `<textarea data-f="${k}">${esc(fieldVal(b, k))}</textarea>` : `<input data-f="${k}" value="${esc(fieldVal(b, k))}">`}</label>`).join('')}</div>
          <div class="sub"><span>Available suites</span><button class="btn small" data-act="addSuite">+ Suite</button></div>
          <table class="suites"><thead><tr>${S_FIELDS.map(([, l]) => `<th>${l}</th>`).join('')}<th></th></tr></thead><tbody>
            ${b.suites.map((su) => `<tr data-sid="${su.id}">${S_FIELDS.map(([k, , w]) => `<td><input data-sf="${k}" value="${esc(su[k] ?? '')}" style="min-width:${w}px"></td>`).join('')}<td><button class="btn small danger" data-act="delSuite" title="Remove suite">×</button></td></tr>`).join('')}
          </tbody></table>
          ${costPanel(b)}
          <div class="sub"><span>Flyers, photos &amp; floor plans</span></div>
          <label class="dropzone" data-drop="${b.id}">
            <input type="file" multiple accept="application/pdf,image/jpeg,image/png,image/webp" data-act="uploadMedia" hidden>
            <b>Drop building flyers, photos or floor plans here</b><span>or click to choose files: PDF, JPG, PNG. Several at once is fine.</span>
            <span class="dz-hint">Flyer PDFs are split into photos, floor plans (matched to suites) and flyer pages. Pages and PDFs showing listing-broker contacts start hidden from the client.</span>
          </label>
          ${mediaGrid(b)}
          <div class="sub"><span>Floor plans (${b.floor_plans.length})</span></div>
          <div class="plans">${b.floor_plans.map((f) => `<div class="plan ${f.hidden ? 'is-hidden' : ''}" data-fid="${f.id}"><img src="${f.url}" alt="" data-view="${f.url}" data-cap="${esc(f.caption || 'Floor plan')}" style="cursor:zoom-in"><div class="pc">
            <input data-pf="caption" value="${esc(f.caption || '')}" placeholder="Caption">
            <select data-pf="suite_id"><option value="">Whole building</option>${b.suites.map((su) => `<option value="${su.id}" ${su.id === f.suite_id ? 'selected' : ''}>Suite ${esc(su.suite || su.floor || su.id)}</option>`).join('')}</select>
            <label class="hidechk"><input type="checkbox" data-pf="hidden" ${f.hidden ? 'checked' : ''}> Hide from client</label>
            <button class="btn small danger" data-act="delPlan">Remove</button></div></div>`).join('') || '<span class="muted" style="font-size:13px">None yet. Drop a flyer or plan above.</span>'}</div>
          <div class="actions">
            <label class="btn small">Replace photo<input type="file" accept="image/*" data-act="photo" hidden></label>
            <button class="btn small" data-act="geocode">Re-locate from address</button>
            <button class="btn small" data-act="place">Place on map by clicking</button>
            ${b.listing_page_url ? `<button class="btn small" data-act="listing" data-src="${b.listing_page_url}">View original CoStar page</button>` : ''}
            ${b.ruled_out ? '<button class="btn small" data-act="restore">Restore to survey</button>' : '<button class="btn small" data-act="ruleOut">Rule out…</button>'}
            <button class="btn small" data-act="hide">${b.hidden ? 'Show to client' : 'Hide from client'}</button>
            <button class="btn small danger" data-act="delete">Delete building</button>
          </div>
        </div></div>`;
    }).join('') || '<p class="muted">No buildings yet.</p>';
  }

  function pinIcon(b) {
    return L.divIcon({ className: 'pin', iconSize: [30, 40], iconAnchor: [15, 40],
      html: `<svg width="30" height="40" viewBox="0 0 30 40"><path d="M15 39s13-13.6 13-24A13 13 0 0 0 2 15c0 10.4 13 24 13 24z" fill="${b.hidden ? '#9aa1ab' : COLORS[st(b)]}" stroke="#fff" stroke-width="2"/></svg><span>${b.ord}</span>` });
  }
  function renderMap() {
    if (!map) {
      map = L.map('map');
      L.tileLayer(cfg.tileUrl, { maxZoom: 19, attribution: cfg.tileAttribution }).addTo(map);
      map.on('click', async (e) => {
        if (!placing) return;
        const b = data.buildings.find((x) => x.id === placing);
        placing = null; $('#hint').hidden = true; map.getContainer().style.cursor = '';
        await api(`/api/admin/buildings/${b.id}`, { method: 'PATCH', json: { lat: e.latlng.lat, lng: e.latlng.lng } });
        toast('Pin placed'); load();
      });
    }
    Object.values(markers).forEach((m) => m.remove()); markers = {};
    const pts = [];
    for (const b of data.buildings) {
      if (b.lat == null) continue;
      const m = L.marker([b.lat, b.lng], { icon: pinIcon(b), draggable: true }).addTo(map)
        .bindTooltip(`${b.ord}. ${esc(b.name || b.address)}`)
        .on('click', () => focusBuilding(b.id))
        .on('dragend', async (e) => { const ll = e.target.getLatLng(); await api(`/api/admin/buildings/${b.id}`, { method: 'PATCH', json: { lat: ll.lat, lng: ll.lng } }); toast('Pin moved'); b.lat = ll.lat; b.lng = ll.lng; b.geocode_status = 'manual'; });
      markers[b.id] = m; pts.push(m.getLatLng());
    }
    if (!map._fitted) {
      if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 15 }); else map.setView([38.9072, -77.0369], 10);
      map._fitted = pts.length > 0;
    }
  }
  function focusBuilding(bid) {
    open.add(bid); renderBuildings();
    const el = $(`#bld-${bid}`); el.classList.add('sel'); el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => el.classList.remove('sel'), 1500);
  }

  // ----- events -----
  $('#title').addEventListener('change', (e) => api(`/api/admin/surveys/${id}`, { method: 'PATCH', json: { title: e.target.value } }).then(() => toast('Saved')));
  $('#client').addEventListener('change', (e) => api(`/api/admin/surveys/${id}`, { method: 'PATCH', json: { client_name: e.target.value } }).then(() => toast('Saved')));
  $('#nnn').addEventListener('change', (e) => api(`/api/admin/surveys/${id}`, { method: 'PATCH', json: { nnn_estimate: e.target.value } }).then(() => { toast('NNN estimate saved'); data.survey.nnn_estimate = e.target.value; }).catch((err) => alert(err.message)));
  $('#copyBtn').onclick = () => copy($('#link').value);
  $('#rotateBtn').onclick = async () => { if (!confirm('Create a new private link? The current link will stop working immediately.')) return; await api(`/api/admin/surveys/${id}/rotate-link`, { method: 'POST' }); load(); toast('New link created'); };
  function showImage(src, cap) { $('#lbImg').src = src; $('#lbCap').textContent = cap; $('#lightbox').hidden = false; }
  $('#lbClose').onclick = () => { $('#lightbox').hidden = true; };
  $('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') $('#lightbox').hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#lightbox').hidden = true; });
  document.addEventListener('click', (e) => { const v = e.target.closest('[data-view]'); if (v) showImage(v.dataset.view, v.dataset.cap); });
  $('#reimportBtn').onclick = async () => {
    if (!confirm('Re-read the original PDF and rebuild this survey\'s buildings?\n\nKept: client votes and notes, your notes to the client, NNN overrides, hidden buildings and pins you placed by hand.\nReplaced: other field edits, suites and floor plans.')) return;
    await api(`/api/admin/surveys/${id}/reimport`, { method: 'POST' }); toast('Re-importing…'); load();
  };
  async function loadDiag() { $('#diagText').textContent = 'Loading…'; const r = await fetch(`/api/admin/surveys/${id}/diagnostics`); $('#diagText').textContent = await r.text(); }
  $('#diag').addEventListener('toggle', () => { if ($('#diag').open) loadDiag(); });
  $('#diagRefresh').onclick = loadDiag;
  $('#diagCopy').onclick = async () => { if ($('#diagText').textContent === 'Loading…') await loadDiag(); copy($('#diagText').textContent); };
  $('#resetBtn').onclick = async () => { if (!confirm('Clear all of the client\'s votes and notes on this survey?')) return; await api(`/api/admin/surveys/${id}/reset-votes`, { method: 'POST' }); load(); };
  $('#dupBtn').onclick = async () => {
    const title = prompt('Name for the copy (it gets its own private link; client votes are not copied):', `${data.survey.title} (copy)`);
    if (!title) return;
    const r = await api(`/api/admin/surveys/${id}/duplicate`, { json: { title } }); location.href = `/admin/surveys/${r.id}`;
  };
  $('#archBtn').onclick = async () => { await api(`/api/admin/surveys/${id}`, { method: 'PATCH', json: { archived: !data.survey.archived } }); toast(data.survey.archived ? 'Unarchived' : 'Archived. The client link still works.'); load(); };
  $('#deleteBtn').onclick = async () => { if (!confirm('Delete this survey permanently? The client link will stop working.')) return; await api(`/api/admin/surveys/${id}`, { method: 'DELETE' }); location.href = '/admin'; };
  $('#addBld').onclick = async () => { const r = await api(`/api/admin/surveys/${id}/buildings`, { method: 'POST', json: {} }); open.add(r.id); await load(); focusBuilding(r.id); };
  $('#results').addEventListener('click', (e) => { const j = e.target.closest('[data-jump]'); if (j) focusBuilding(Number(j.dataset.jump)); });

  const blds = $('#blds');
  blds.addEventListener('click', async (e) => {
    const card = e.target.closest('.bld'); if (!card) return;
    const bid = Number(card.dataset.id);
    const b = data.buildings.find((x) => x.id === bid);
    if (e.target.closest('[data-toggle]')) {
      open.has(bid) ? open.delete(bid) : open.add(bid);
      card.classList.toggle('open');
      if (markers[bid]) map.panTo(markers[bid].getLatLng());
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    try {
      if (act === 'addSuite') { await api(`/api/admin/buildings/${bid}/suites`, { method: 'POST' }); load(); }
      if (act === 'delSuite') { const sid = e.target.closest('tr').dataset.sid; await api(`/api/admin/suites/${sid}`, { method: 'DELETE' }); load(); }
      if (act === 'delPlan') { const fid = e.target.closest('.plan').dataset.fid; await api(`/api/admin/floor-plans/${fid}`, { method: 'DELETE' }); load(); }
      if (act === 'geocode') { await api(`/api/admin/buildings/${bid}/geocode`, { method: 'POST' }); map._fitted = false; toast('Located'); load(); }
      if (act === 'place') { placing = bid; $('#hint').textContent = `Click the map to place #${b.ord}`; $('#hint').hidden = false; map.getContainer().style.cursor = 'crosshair'; $('.ed-map').scrollIntoView({ behavior: 'smooth' }); }
      if (act === 'ruleOut') {
        const reason = prompt(`Rule out ${b.name || b.address}?\n\nIt leaves the client's map and list and moves to "Buildings ruled out". Reason the client will see:`, b.vote?.comment || '');
        if (reason === null) return;
        await api(`/api/admin/buildings/${bid}`, { method: 'PATCH', json: { ruled_out: 1, ruled_out_reason: reason.trim() || null } }); toast('Ruled out'); load(); return;
      }
      if (act === 'restore') { await api(`/api/admin/buildings/${bid}`, { method: 'PATCH', json: { ruled_out: 0 } }); toast('Restored to survey'); load(); return; }
      if (act === 'makeMain') { await api(`/api/admin/media/${e.target.closest('.mitem').dataset.mid}/make-main`, { method: 'POST' }); toast('Main photo set'); load(); return; }
      if (act === 'toPlan') { await api(`/api/admin/media/${e.target.closest('.mitem').dataset.mid}/to-floor-plan`, { method: 'POST' }); toast('Moved to floor plans'); load(); return; }
      if (act === 'delMedia') { if (!confirm('Delete this item?')) return; await api(`/api/admin/media/${e.target.closest('.mitem').dataset.mid}`, { method: 'DELETE' }); load(); return; }
      if (act === 'listing') { showImage(e.target.closest('[data-act]').dataset.src, `Original CoStar page · ${b.name || b.address}`); return; }
      if (act === 'hide') { await api(`/api/admin/buildings/${bid}`, { method: 'PATCH', json: { hidden: b.hidden ? 0 : 1 } }); load(); }
      if (act === 'delete') { if (!confirm(`Delete ${b.name || b.address} from this survey?`)) return; await api(`/api/admin/buildings/${bid}`, { method: 'DELETE' }); load(); }
    } catch (err) { alert(err.message); }
  });
  blds.addEventListener('change', async (e) => {
    const card = e.target.closest('.bld'); if (!card) return;
    const bid = Number(card.dataset.id);
    const t = e.target;
    try {
      if (t.dataset.f) {
        let v = t.value;
        if (t.dataset.f === 'highlights') v = v.split('\n').map((x) => x.trim()).filter(Boolean);
        if (t.dataset.f === 'details') v = v.split('\n').map((x) => x.split(/:\s*/)).filter((x) => x[0].trim() && x.length > 1).map(([l, ...r]) => [l.trim(), r.join(': ').trim()]);
        if (['lat', 'lng', 'rba_sf', 'year_built', 'stories', 'ord', 'costar_rating', 'nnn_override'].includes(t.dataset.f)) v = v === '' ? '' : Number(String(v).replace(/,/g, ''));
        await api(`/api/admin/buildings/${bid}`, { method: 'PATCH', json: { [t.dataset.f]: v } });
        const b = data.buildings.find((x) => x.id === bid); b[t.dataset.f] = v;
        if (['lat', 'lng', 'ord', 'name', 'address'].includes(t.dataset.f)) { renderMap(); }
        if (t.dataset.f === 'nnn_override') renderBuildings();
        toast('Saved');
      } else if (t.dataset.sf) {
        await api(`/api/admin/suites/${t.closest('tr').dataset.sid}`, { method: 'PATCH', json: { [t.dataset.sf]: t.value } }); toast('Saved');
      } else if (t.dataset.pf) {
        const plan = t.closest('.plan');
        await api(`/api/admin/floor-plans/${plan.dataset.fid}`, { method: 'PATCH', json: { caption: plan.querySelector('[data-pf=caption]').value, suite_id: plan.querySelector('[data-pf=suite_id]').value || null, hidden: plan.querySelector('[data-pf=hidden]').checked } });
        plan.classList.toggle('is-hidden', plan.querySelector('[data-pf=hidden]').checked); toast('Saved');
      } else if (t.dataset.mf) {
        const it = t.closest('.mitem');
        await api(`/api/admin/media/${it.dataset.mid}`, { method: 'PATCH', json: { caption: it.querySelector('[data-mf=caption]').value, hidden: it.querySelector('[data-mf=hidden]').checked } });
        it.classList.toggle('is-hidden', it.querySelector('[data-mf=hidden]').checked); toast('Saved');
      } else if (t.dataset.act === 'uploadMedia') {
        await uploadMedia(bid, [...t.files]); t.value = '';
      } else if (t.dataset.act === 'photo' || t.dataset.act === 'uploadPlan') {
        const fd = new FormData(); fd.append('file', t.files[0]);
        if (t.dataset.act === 'uploadPlan') fd.append('caption', t.files[0].name.replace(/\.\w+$/, ''));
        toast('Uploading…');
        const r = await fetch(`/api/admin/buildings/${bid}/${t.dataset.act === 'photo' ? 'photo' : 'floor-plans'}`, { method: 'POST', body: fd });
        const res = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(res.error || 'Upload failed');
        if (res.total) toast(res.matched ? `Matched ${res.matched} of ${res.total} page(s) to a suite` : 'Uploaded. Pick the suite for each plan below.');
        load();
      }
    } catch (err) { alert(err.message); }
  });

  blds.addEventListener('dragover', (e) => { const z = e.target.closest('.dropzone'); if (z) { e.preventDefault(); z.classList.add('over'); } });
  blds.addEventListener('dragleave', (e) => { const z = e.target.closest('.dropzone'); if (z) z.classList.remove('over'); });
  blds.addEventListener('drop', (e) => { const z = e.target.closest('.dropzone'); if (!z) return; e.preventDefault(); z.classList.remove('over'); uploadMedia(Number(z.dataset.drop), [...e.dataTransfer.files]); });
  $('#nnn').addEventListener('change', () => setTimeout(renderBuildings, 300));
  $('#roForm').addEventListener('click', (e) => {
    const c = e.target.closest('[data-ro-chip]'); if (!c) return;
    const ta = $('#roForm [name=reason]'); const parts = ta.value.split(/;\s*/).filter(Boolean);
    const has = parts.includes(c.dataset.roChip);
    ta.value = (has ? parts.filter((p) => p !== c.dataset.roChip) : [...parts, c.dataset.roChip]).join('; '); c.classList.toggle('on', !has);
  });
  $('#roForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target;
    try {
      await api(`/api/admin/surveys/${id}/ruled-out`, { json: { name: f.name.value, address: f.address.value, reason: f.reason.value } });
      f.reset(); toast('Added to ruled out'); load();
    } catch (err) { alert(err.message); }
  });
  $('#roList').addEventListener('change', async (e) => {
    const t = e.target;
    try {
      if (t.dataset.roF) { const tr = t.closest('tr'); await api(`/api/admin/ruled-out/${tr.dataset.rid}`, { method: 'PATCH', json: { [t.dataset.roF]: t.value } }); toast('Saved'); }
      if (t.dataset.roBf) { const tr = t.closest('tr'); await api(`/api/admin/buildings/${tr.dataset.roBid}`, { method: 'PATCH', json: { ruled_out_reason: t.value } }); toast('Saved'); }
    } catch (err) { alert(err.message); }
  });
  $('#roList').addEventListener('click', async (e) => {
    const d = e.target.closest('[data-ro-del]'); const r = e.target.closest('[data-ro-restore]');
    if (d) { if (!confirm('Remove this building from the ruled-out list?')) return; await api(`/api/admin/ruled-out/${d.dataset.roDel}`, { method: 'DELETE' }); load(); }
    if (r) { await api(`/api/admin/buildings/${r.dataset.roRestore}`, { method: 'PATCH', json: { ruled_out: 0 } }); toast('Restored to survey'); load(); }
  });

  load();
})();
