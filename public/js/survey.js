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

  let data = null, map, markers = {}, selected = null, filter = 'all';

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
          </div>
          <div class="row"><span class="muted" style="font-size:12px">${esc([b.building_class && `Class ${b.building_class}`, b.property_type].filter(Boolean).join(' · '))}</span>${voteButtons(b)}</div>
        </div></li>`;
    }).join('') : '<li class="empty">No buildings in this view.</li>';
  }

  function renderTally() {
    const up = data.buildings.filter((b) => state(b) === 'u').length;
    const down = data.buildings.filter((b) => state(b) === 'd').length;
    $('#tally').innerHTML = `<span>${ICON.up} ${up}</span><span>${ICON.down} ${down}</span><span>${data.buildings.length} buildings</span>`;
  }

  function specRow(label, val) { return val == null || val === '' ? '' : `<div><dt>${label}</dt><dd>${esc(val)}</dd></div>`; }

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
    $('#detailView').innerHTML = `
      <div class="detail-top">
        <button class="btn small" id="backBtn">← All buildings</button>
        <div class="nav"><button class="btn small" ${prev ? `data-go="${prev.id}"` : 'disabled'}>‹ Prev</button><button class="btn small" ${next ? `data-go="${next.id}"` : 'disabled'}>Next ›</button></div>
      </div>
      <div class="hero" style="${b.photo_url ? `background-image:url('${b.photo_url}')` : ''}"><span class="num ${st}">${b.ord}</span></div>
      <div class="dbody">
        <h2>${esc(b.name || b.address)}</h2>
        <div class="addr">${esc(b.address)}, ${esc(b.city || '')}${b.state ? ', ' + esc(b.state) : ''} ${esc(b.zip || '')}${b.submarket ? `<br><span class="pill">${esc(b.submarket)}</span>` : ''}</div>
        <div class="vote-panel">
          <div class="q">Is this building worth a closer look?</div>
          ${voteButtons(b, true)}
          <textarea id="cmt" placeholder="Optional note for your advisor (e.g. 'love the parking', 'too far from Metro')">${esc(b.vote?.comment || '')}</textarea>
          <div class="saved" id="savedMsg"></div>
        </div>
        ${b.broker_notes ? `<h3 class="sec">Advisor notes</h3><div class="prose"><p>${esc(b.broker_notes).replace(/\n/g, '<br>')}</p></div>` : ''}
        <dl class="specs">
          ${specRow('Available', b.available_size)}
          ${specRow('Asking rent', b.asking_rent)}
          ${specRow('Service type', b.service_type)}
          ${specRow('Occupancy', b.occupancy)}
          ${specRow('Term', b.term)}
          ${specRow('Building size', b.rba_sf ? fmtInt(b.rba_sf) + ' SF' : null)}
          ${specRow('Class', b.building_class)}
          ${specRow('Type', b.property_type)}
          ${specRow('Year built', b.year_built)}
          ${specRow('Renovated', b.renovated)}
          ${specRow('Stories', b.stories)}
          ${specRow('Typical floor', b.typical_floor)}
          ${specRow('Parking', b.parking)}
        </dl>
        <h3 class="sec">Available suites (${b.suites.length})</h3>
        ${b.suites.length ? b.suites.map((s) => `
          <div class="suite">
            <div class="top"><span class="label">${esc([s.suite ? `Suite ${s.suite}` : null, s.floor ? `${s.floor} floor` : null].filter(Boolean).join(' · ') || 'Space')}</span><span class="sf">${esc(s.sf || '')}${s.sf ? ' SF' : ''}</span></div>
            <div class="meta">
              ${s.address ? `<span>${esc(s.address)}</span>` : ''}
              <span>Rent <b>${esc(s.rent || '—')}${s.rent_type ? ' ' + esc(s.rent_type) : ''}</b></span>
              ${s.space_use ? `<span>${esc(s.space_use)}</span>` : ''}
              ${s.lease_type ? `<span>${esc(s.lease_type)}</span>` : ''}
              ${s.occupancy ? `<span>Avail. <b>${esc(s.occupancy)}</b></span>` : ''}
              ${s.term ? `<span>Term <b>${esc(s.term)}</b></span>` : ''}
              ${s.floor_status ? `<span>${esc(s.floor_status)} floor</span>` : ''}
            </div>
            ${thumbs(plansBySuite(s.id))}
          </div>`).join('') : '<p class="muted">Contact your advisor for suite details.</p>'}
        ${plansBySuite(null).length ? `<h3 class="sec">Floor plans</h3>${thumbs(plansBySuite(null))}` : ''}
        ${b.highlights?.length ? `<h3 class="sec">Highlights</h3><div class="prose"><ul>${b.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul></div>` : ''}
        ${b.overview ? `<h3 class="sec">About the property</h3><div class="prose">${b.overview.split(/\n\n+/).map((p) => `<p>${esc(p)}</p>`).join('')}</div>` : ''}
      </div>`;
    $('#listView').hidden = true;
    $('#detailView').hidden = false;
    $('#side').classList.add('detail-open');
    $('#side').scrollTop = 0;
    if (fly && markers[id]) map.flyTo(markers[id].getLatLng(), Math.max(map.getZoom(), 15), { duration: 0.6 });
    $('#cmt').addEventListener('input', debounce(() => sendVote(b, b.vote?.vote ?? 0, $('#cmt').value), 700));
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
    const msg = $('#savedMsg'); if (msg) { msg.textContent = 'Saved'; setTimeout(() => { if (msg) msg.textContent = ''; }, 1500); }
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
      const cmt = $('#cmt') && selected === bid ? $('#cmt').value : undefined;
      sendVote(b, nv, cmt);
      vb.closest('.votes').querySelectorAll('.vbtn').forEach((x) => { const on = Number(x.dataset.v) === nv; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
      if (!$('#listView').hidden) renderList();
      else { const n = document.querySelector('.hero .num'); if (n) n.className = `num ${state(b)}`; }
      return;
    }
    const card = e.target.closest('.card');
    if (card) return openDetail(Number(card.dataset.id));
    if (e.target.id === 'backBtn') return closeDetail();
    const go = e.target.closest('[data-go]');
    if (go) return openDetail(Number(go.dataset.go));
    const fp = e.target.closest('.fp-thumb');
    if (fp) { $('#lbImg').src = fp.dataset.src; $('#lbCap').textContent = fp.dataset.cap; $('#lightbox').hidden = false; return; }
    if (e.target.closest('#lightbox')) { $('#lightbox').hidden = true; return; }
    const f = e.target.closest('#filters button');
    if (f) { filter = f.dataset.f; renderList(); }
  });
  document.addEventListener('mouseover', (e) => {
    const card = e.target.closest('.card');
    document.querySelectorAll('.pin.hover').forEach((p) => p.classList.remove('hover'));
    if (card && markers[card.dataset.id]) markers[card.dataset.id].openTooltip();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (!$('#lightbox').hidden) $('#lightbox').hidden = true; else if (selected) closeDetail(); }
  });

  load();
})();
