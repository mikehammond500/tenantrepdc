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
    ['parking', 'Parking'], ['costar_rating', 'CoStar stars (0-5)'], ['nnn_override', 'NNN $/SF/yr (overrides area estimate)'], ['ord', 'Pin #'], ['lat', 'Latitude'],
    ['broker_notes', 'Your notes to the client (shown on the survey)', 'w4', 'textarea'],
    ['overview', 'Property overview', 'w4', 'textarea'], ['highlights', 'Highlights (one per line)', 'w4', 'textarea'],
    ['details', 'All CoStar details shown to the client (one per line, "Label: value")', 'w4', 'textarea'],
  ];
  const S_FIELDS = [['suite', 'Suite', 60], ['floor', 'Floor', 50], ['sf', 'SF', 90], ['rent', 'Rent', 80], ['rent_type', 'Type', 45],
    ['space_use', 'Use', 100], ['lease_type', 'Lease', 70], ['occupancy', 'Avail.', 90], ['term', 'Term', 90], ['address', 'Address', 130]];

  async function load() {
    data = await api(`/api/admin/surveys/${id}`);
    const s = data.survey;
    document.title = `${s.title} · Edit survey`;
    $('#title').value = s.title; $('#client').value = s.client_name || '';
    $('#nnn').value = s.nnn_estimate ?? '';
    $('#srcLine').textContent = `Source: ${s.pdf_name || 'PDF'} · ${data.buildings.length} buildings · ${s.view_count} client view${s.view_count === 1 ? '' : 's'}${s.last_viewed_at ? ', last ' + fmtDate(s.last_viewed_at) : ''}`;
    const link = `${location.origin}/s/${s.token}`;
    $('#link').value = link; $('#openBtn').href = link;
    $('#banner').innerHTML = s.status === 'processing' ? `<div class="status-banner">Processing the PDF: ${esc(s.status_detail || '')}…</div>`
      : s.status === 'error' ? `<div class="status-banner err">Could not process this PDF: ${esc(s.status_detail)}</div>`
      : (() => { const miss = data.buildings.filter((b) => b.lat == null).length; return miss ? `<div class="status-banner">${miss} building${miss > 1 ? 's' : ''} could not be located from the address. Open ${miss > 1 ? 'each one' : 'it'} below and use "Place on map by clicking".</div>` : ''; })();
    clearTimeout(pollTimer);
    if (s.status === 'processing') pollTimer = setTimeout(load, 2500);
    renderResults(); renderBuildings(); renderMap();
  }

  function renderResults() {
    const groups = { u: [], d: [], n: [] };
    data.buildings.filter((b) => !b.hidden).forEach((b) => groups[st(b)].push(b));
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

  function renderBuildings() {
    $('#blds').innerHTML = data.buildings.map((b) => {
      const s = st(b);
      const geo = b.lat == null ? '<span class="pill down">Not on map</span>' : b.geocode_status === 'manual' ? '<span class="pill gray">Placed by hand</span>' : '';
      return `<div class="bld ${open.has(b.id) ? 'open' : ''} ${b.hidden ? 'hidden-b' : ''}" data-id="${b.id}" id="bld-${b.id}">
        <div class="bld-head" data-toggle>
          <div class="ph" style="${b.photo_url ? `background-image:url('${b.photo_url}')` : ''}"><span class="num ${s}">${b.ord}</span></div>
          <div><div class="t">${esc(b.name || b.address || 'Untitled')}${b.costar_rating != null ? ` <span class="astars" title="CoStar rating">${'★'.repeat(b.costar_rating)}${'☆'.repeat(5 - b.costar_rating)}</span>` : ''}</div><div class="s">${esc(b.address || '')}${b.city ? ', ' + esc(b.city) : ''} · ${b.suites.length} suite${b.suites.length === 1 ? '' : 's'}${b.floor_plans.length ? ` · ${b.floor_plans.length} floor plan${b.floor_plans.length > 1 ? 's' : ''}` : ''}</div></div>
          <div class="right">${s === 'u' ? '<span class="pill up">👍 Liked</span>' : s === 'd' ? '<span class="pill down">👎 Passed</span>' : ''}${b.hidden ? '<span class="pill gray">Hidden from client</span>' : ''}${geo}</div>
        </div>
        ${b.vote?.comment ? `<div class="vote-note ${s === 'u' ? 'up' : 'down'}" style="margin:0 10px 10px">Client note: "${esc(b.vote.comment)}"</div>` : ''}
        <div class="bld-body">
          <div class="fields">${B_FIELDS.map(([k, label, cls = '', type]) => k === 'lat'
            ? `<label>Latitude<input data-f="lat" value="${b.lat == null ? '' : b.lat.toFixed(6)}"></label><label>Longitude<input data-f="lng" value="${b.lng == null ? '' : b.lng.toFixed(6)}"></label>`
            : `<label class="${cls}">${label}${type === 'textarea' ? `<textarea data-f="${k}">${esc(fieldVal(b, k))}</textarea>` : `<input data-f="${k}" value="${esc(fieldVal(b, k))}">`}</label>`).join('')}</div>
          <div class="sub"><span>Available suites</span><button class="btn small" data-act="addSuite">+ Suite</button></div>
          <table class="suites"><thead><tr>${S_FIELDS.map(([, l]) => `<th>${l}</th>`).join('')}<th></th></tr></thead><tbody>
            ${b.suites.map((su) => `<tr data-sid="${su.id}">${S_FIELDS.map(([k, , w]) => `<td><input data-sf="${k}" value="${esc(su[k] ?? '')}" style="min-width:${w}px"></td>`).join('')}<td><button class="btn small danger" data-act="delSuite" title="Remove suite">×</button></td></tr>`).join('')}
          </tbody></table>
          <div class="sub"><span>Floor plans</span><label class="btn small" style="text-transform:none;letter-spacing:0;font-weight:500">+ Upload (PDF or image)<input type="file" accept="application/pdf,image/*" data-act="uploadPlan" hidden></label></div>
          <div class="plans">${b.floor_plans.map((f) => `<div class="plan" data-fid="${f.id}"><a href="${f.url}" target="_blank"><img src="${f.url}" alt=""></a><div class="pc">
            <input data-pf="caption" value="${esc(f.caption || '')}" placeholder="Caption">
            <select data-pf="suite_id"><option value="">Whole building</option>${b.suites.map((su) => `<option value="${su.id}" ${su.id === f.suite_id ? 'selected' : ''}>Suite ${esc(su.suite || su.floor || su.id)}</option>`).join('')}</select>
            <button class="btn small danger" data-act="delPlan">Remove</button></div></div>`).join('') || '<span class="muted" style="font-size:13px">None. Upload one and link it to a suite.</span>'}</div>
          <div class="actions">
            <label class="btn small">Replace photo<input type="file" accept="image/*" data-act="photo" hidden></label>
            <button class="btn small" data-act="geocode">Re-locate from address</button>
            <button class="btn small" data-act="place">Place on map by clicking</button>
            ${b.listing_page_url ? `<a class="btn small" style="text-decoration:none" target="_blank" href="${b.listing_page_url}">View original CoStar page</a>` : ''}
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
  $('#resetBtn').onclick = async () => { if (!confirm('Clear all of the client\'s votes and notes on this survey?')) return; await api(`/api/admin/surveys/${id}/reset-votes`, { method: 'POST' }); load(); };
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
        toast('Saved');
      } else if (t.dataset.sf) {
        await api(`/api/admin/suites/${t.closest('tr').dataset.sid}`, { method: 'PATCH', json: { [t.dataset.sf]: t.value } }); toast('Saved');
      } else if (t.dataset.pf) {
        const plan = t.closest('.plan');
        await api(`/api/admin/floor-plans/${plan.dataset.fid}`, { method: 'PATCH', json: { caption: plan.querySelector('[data-pf=caption]').value, suite_id: plan.querySelector('[data-pf=suite_id]').value || null } }); toast('Saved');
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

  load();
})();
