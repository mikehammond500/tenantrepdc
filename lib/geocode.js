'use strict';
// Geocoding: US Census Bureau geocoder (free, no key), falling back to OpenStreetMap Nominatim.
const UA = 'TenantRepSurvey/1.0 (+https://tenantrepdc.com)';

async function census(q) {
  const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return null;
  const j = await r.json();
  const m = j?.result?.addressMatches?.[0];
  return m ? { lat: m.coordinates.y, lng: m.coordinates.x, source: 'census' } : null;
}

async function nominatim(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return null;
  const j = await r.json();
  return j[0] ? { lat: Number(j[0].lat), lng: Number(j[0].lon), source: 'osm' } : null;
}

async function geocode({ address, city, state, zip }) {
  const q = [address, city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  for (const fn of [census, nominatim]) {
    try { const hit = await fn(q); if (hit) return hit; } catch { /* try next */ }
  }
  // CoStar sometimes lists ranges like "6-14 Pidgeon Hill Dr"; try the first number alone.
  const simplified = address && address.replace(/^(\d+)\s*-\s*\d+/, '$1');
  if (simplified && simplified !== address) return geocode({ address: simplified, city, state, zip });
  return null;
}

module.exports = { geocode };
