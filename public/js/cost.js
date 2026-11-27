// Monthly occupancy cost, shared by the client survey and the broker editor so both always agree.
window.Cost = (() => {
  const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const money2 = (n) => '$' + Number(n).toFixed(2);
  const nums = (t) => (String(t || '').match(/\d[\d,]*(?:\.\d+)?/g) || []).map((x) => Number(x.replace(/,/g, '')));
  const isNNN = (s, b) => /\bNNN\b|triple\s*net/i.test(`${s.rent_type || ''} ${s.rent || ''}`)
    || (!s.rent_type && /triple\s*net|\bNNN\b/i.test(`${b.service_type || ''} ${b.asking_rent || ''}`));
  /**
   * (base rent [+ NNN]) x SF / 12 for one suite. Rent or SF ranges give a low-high range.
   * NNN: the building's own figure when the broker entered one ("advisor"), else the survey's area estimate.
   */
  function monthly(s, b, areaEstimate) {
    const rents = nums(s.rent).filter((n) => n > 0 && n < 500);
    const sfs = nums(s.sf).filter((n) => n >= 50);
    if (!rents.length || !sfs.length) return null;
    const perMonth = /\/\s*mo/i.test(s.rent || '');
    let rLo = Math.min(...rents), rHi = Math.max(...rents);
    if (perMonth) { rLo *= 12; rHi *= 12; }
    let nnn = 0, nnnSource = null;
    if (isNNN(s, b)) {
      if (b.nnn_override != null && b.nnn_override !== '') { nnn = Number(b.nnn_override); nnnSource = 'advisor'; }
      else if (areaEstimate != null && areaEstimate !== '') { nnn = Number(areaEstimate); nnnSource = 'estimate'; }
      else nnnSource = 'missing';
    }
    const sfLo = Math.min(...sfs), sfHi = Math.max(...sfs);
    return { lo: (rLo + nnn) * sfLo / 12, hi: (rHi + nnn) * sfHi / 12, rLo, rHi, nnn, nnnSource, sfLo, sfHi, nnnApplies: isNNN(s, b) };
  }
  const range = (lo, hi, f = money) => (Math.round(lo * 100) === Math.round(hi * 100) ? f(lo) : `${f(lo)} – ${f(hi)}`);
  return { money, money2, nums, isNNN, monthly, range };
})();
