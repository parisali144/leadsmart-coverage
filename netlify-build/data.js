/*
 * data.js — fully-static client-side data layer, JSON edition.
 *
 * The tool used to download the whole 35 MB SQLite DB (sql.js) on first load.
 * That's gone. The daily CI run (app/precompute.py) now bakes every possible
 * query result into small static JSON under /api/, and this shim fetches only
 * the handful of files a given interaction needs — a few KB to open the site,
 * a few hundred KB at most for the heaviest drill-down.
 *
 * The public contract is unchanged, so index.html works as-is:
 *   window.dataReady — Promise that resolves once meta is loaded
 *   window.j(url)    — replacement for fetch(url).then(r=>r.json())
 *
 * Response shapes are byte-for-byte the same as the old sql.js layer; the
 * aggregation-heavy endpoints are precomputed, and the row-level ones
 * (coverage / zips / state_zips / suggest / nearby / compare / bundles filters)
 * are recomputed here from small per-state shards and index files.
 */
(function () {
  // CI stamps this on every deploy (see refresh.yml). It cache-busts every /api
  // file at once, so a new deploy is picked up immediately while same-deploy
  // repeat visits and drill-downs stay instant from the immutable cache.
  const DB_VERSION = '20260606-r2';
  const API = 'api/';
  const v = (p) => API + p + '?v=' + DB_VERSION;

  // ---------- fetch + cache ----------
  const cache = new Map();        // path -> Promise<json>
  function getJSON(path) {
    let p = cache.get(path);
    if (!p) {
      p = fetch(v(path)).then(r => {
        if (!r.ok) throw new Error(path + ' -> ' + r.status);
        return r.json();
      }).catch(e => { cache.delete(path); throw e; });
      cache.set(path, p);
    }
    return p;
  }
  // Optional file (missing 404 -> null instead of throwing).
  function getJSONOpt(path) {
    return getJSON(path).catch(() => null);
  }

  // ---------- helpers (identical math to the old layer) ----------
  function num(x) { const n = parseFloat(x); return Number.isFinite(n) ? n : null; }
  function intnum(x) { const n = parseInt(x, 10); return Number.isFinite(n) ? n : null; }
  function r2(x) { return x == null ? null : Math.round(x * 100) / 100; }
  function score(payout, zips, population) {
    if (!payout || !zips || !population || population <= 0) return 0;
    const pop = Math.max(population, 2500);
    return Math.round(payout * Math.pow(zips, 0.6) / Math.pow(pop / 1000, 0.4) * 100) / 100;
  }
  function haversine(la1, lo1, la2, lo2) {
    const R = 3958.8, T = Math.PI / 180;
    const dp = (la2 - la1) * T, dl = (lo2 - lo1) * T;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(la1 * T) * Math.cos(la2 * T) * Math.sin(dl / 2) ** 2;
    return R * 2 * Math.asin(Math.sqrt(a));
  }
  function parseQS(u) {
    const i = u.indexOf('?'); const q = {};
    if (i < 0) return q;
    new URLSearchParams(u.slice(i + 1)).forEach((val, k) => { q[k] = val; });
    return q;
  }
  function slugify(name) {   // MUST match slugify() in precompute.py
    return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  // Normalize a city name for search matching only (never for display or lookup).
  // Folds the abbreviation spellings LeadSmart's feed mixes (St.↔Saint, Ft↔Fort,
  // Mt↔Mount) and strips punctuation/apostrophes so "OFallon"/"O Fallon" match
  // "O'Fallon". Mirrors norm_city() in sync_supabase.py, minus the trailing-space
  // anchors (we compare word-by-word here, not against a fixed key).
  function normCity(name) {
    let s = (name || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/^st /, 'saint ').replace(/^ft /, 'fort ').replace(/^mt /, 'mount ');
    return s;
  }
  // Expand a {cols,rows} array-of-arrays table into row objects.
  function expand(table) {
    const cols = table.cols;
    return table.rows.map(r => { const o = {}; for (let i = 0; i < cols.length; i++) o[cols[i]] = r[i]; return o; });
  }
  // Expand one row of a dictionary-encoded state shard.
  function shardRow(shard, r) {
    return {
      city: r[0] < 0 ? null : shard.city[r[0]],
      zip: r[1],
      niche: r[2] < 0 ? null : shard.niche[r[2]],
      payout_type: r[3] < 0 ? null : shard.ptype[r[3]],
      payout: r[4],
      population: r[5],
      density: r[6],
      lat: r[7],
      lng: r[8],
      county_name: r[9] < 0 ? null : shard.county[r[9]],
    };
  }

  // ---------- shard loaders ----------
  function loadShard(state) { return getJSON('state/' + (state || '').toUpperCase() + '.json'); }
  let CITIES = null;   // suggest/nearby index (lazy)
  function loadCities() { return CITIES || (CITIES = getJSON('cities.json').then(expand)); }
  let ZIPMAP = null;
  function loadZipmap() { return ZIPMAP || (ZIPMAP = getJSON('zipmap.json')); }

  // ---------- by-city (from a state shard) ----------
  function rowsForCity(shard, city) {
    const cl = (city || '').toLowerCase();
    const out = [];
    for (const raw of shard.rows) {
      const c = raw[0] < 0 ? '' : shard.city[raw[0]];
      if (c.toLowerCase() === cl) out.push(shardRow(shard, raw));
    }
    return out;
  }

  function coverageFromRows(city, state, rows) {
    // GROUP BY niche,payout_type: MAX/AVG/MIN payout, COUNT DISTINCT zip, MAX pop
    const g = new Map();
    for (const r of rows) {
      const k = r.niche + '|' + r.payout_type;
      let a = g.get(k);
      if (!a) { a = { niche: r.niche, payout_type: r.payout_type, max: -Infinity, sum: 0, n: 0, min: Infinity, zips: new Set(), pop: null }; g.set(k, a); }
      a.max = Math.max(a.max, r.payout);
      a.min = Math.min(a.min, r.payout);
      a.sum += r.payout; a.n++;
      a.zips.add(r.zip);
      if (r.population != null && (a.pop == null || r.population > a.pop)) a.pop = r.population;
    }
    const niches = [...g.values()].map(a => {
      const avg = a.n ? a.sum / a.n : null;
      const o = {
        niche: a.niche, payout_type: a.payout_type,
        payout: a.max, avg_payout: avg ? r2(avg) : null, min_payout: a.min,
        zips: a.zips.size, population: a.pop,
      };
      o.score = score(o.payout, o.zips, o.population);
      return o;
    }).sort((x, y) => y.payout - x.payout);

    // totals
    const allZ = new Set(); let pop = null, county = null;
    for (const r of rows) {
      allZ.add(r.zip);
      if (r.population != null && (pop == null || r.population > pop)) pop = r.population;
      if (r.county_name != null && (county == null || r.county_name > county)) county = r.county_name;
    }
    const distinct = new Set(niches.map(n => n.niche)).size;
    return {
      city, state, county: county || null,
      total_zips: allZ.size, total_population: pop,
      niche_count: distinct, row_count: niches.length, niches,
      bundles: findBundle(rows),
    };
  }

  function findBundle(rows) {
    const byZip = {};
    for (const x of rows) {
      const z = x.zip; byZip[z] = byZip[z] || {};
      const k = x.niche + ' (' + x.payout_type + ')';
      if (!byZip[z][k] || byZip[z][k] < x.payout) byZip[z][k] = x.payout;
    }
    let best = null;
    for (const z in byZip) {
      const n = byZip[z]; const keys = Object.keys(n);
      if (keys.length < 2) continue;
      const top = keys.sort((a, b) => n[b] - n[a]).slice(0, 4);
      const combined = Math.round(top.reduce((a, k) => a + n[k], 0) * 100) / 100;
      const cand = { zip: +z, combined, count: keys.length, stack: top.map(k => ({ niche: k, payout: n[k] })) };
      if (!best || cand.combined > best.combined) best = cand;
    }
    return best;
  }

  async function coverageFor(city, state) {
    city = city || ''; state = (state || '').toUpperCase();
    const shard = await loadShard(state);
    return coverageFromRows(city, state, rowsForCity(shard, city));
  }

  // ---------- endpoint handlers ----------
  const HANDLERS = {
    '/api/meta': () => getJSON('meta.json'),
    '/api/states': () => getJSON('states.json'),
    '/api/niche_summary': () => getJSON('niche_summary.json'),
    '/api/top_markets': () => getJSON('top_markets.json'),

    '/api/suggest': async (q) => {
      const s = (q.q || '').trim();
      if (s.length < 2) return [];
      const sl = s.toLowerCase();
      const cities = await loadCities();
      const nq = normCity(s);
      // Rank by match quality: exact (0) > prefix (1) > word-boundary (2) >
      // anywhere (3). This surfaces cities LeadSmart covers that a literal
      // startsWith would hide — spelling variants (St.↔Saint) and mid-name
      // typing ("Fallon" → "O'Fallon").
      const nqc = nq.replace(/ /g, '');   // space-insensitive form ("ofallon")
      const hit = [];
      for (const c of cities) {
        if (!c.city) continue;
        const nc = normCity(c.city);
        let tier;
        if (nc === nq) tier = 0;
        else if (nc.startsWith(nq)) tier = 1;
        else if (nc.includes(' ' + nq)) tier = 2;
        else if (nc.includes(nq)) tier = 3;
        else if (nc.replace(/ /g, '').includes(nqc)) tier = 4;  // "OFallon"→"O'Fallon"
        else continue;
        hit.push([tier, c]);
      }
      hit.sort((a, b) =>
        a[0] - b[0] ||
        (b[1].population || 0) - (a[1].population || 0) ||
        b[1].zips - a[1].zips ||
        b[1].niches - a[1].niches);
      return hit.slice(0, 12).map(([, c]) => ({
        city: c.city, state_id: c.state_id, niches: c.niches, zips: c.zips, population: c.population,
      }));
    },

    '/api/coverage': (q) => coverageFor(q.city, q.state),

    '/api/coverage_zip': async (q) => {
      const z = intnum(q.zip);
      if (z == null) return { error: 'invalid zip' };
      const zm = await loadZipmap();
      const st = zm[String(z)];
      if (!st) return { error: 'ZIP not covered for any niche', zip: z };
      const shard = await loadShard(st);
      let city = null;
      for (const raw of shard.rows) { if (raw[1] === z) { city = raw[0] < 0 ? null : shard.city[raw[0]]; break; } }
      if (city == null) return { error: 'ZIP not covered for any niche', zip: z };
      return coverageFromRows(city, st, rowsForCity(shard, city));
    },

    '/api/zips': async (q) => {
      const shard = await loadShard(q.state);
      const city = (q.city || '').toLowerCase(), niche = q.niche || '', ptype = q.ptype || 'CPL';
      const r = [];
      for (const raw of shard.rows) {
        if ((raw[2] < 0 ? '' : shard.niche[raw[2]]) !== niche) continue;
        if ((raw[3] < 0 ? '' : shard.ptype[raw[3]]) !== ptype) continue;
        if ((raw[0] < 0 ? '' : shard.city[raw[0]]).toLowerCase() !== city) continue;
        r.push({ zip: raw[1], payout: raw[4] });
      }
      r.sort((a, b) => b.payout - a.payout || a.zip - b.zip);
      const pays = r.map(x => x.payout);
      return {
        city: q.city, state: q.state, niche, payout_type: ptype,
        count: r.length, min: pays.length ? Math.min(...pays) : null,
        max: pays.length ? Math.max(...pays) : null, zips: r,
      };
    },

    '/api/nearby': async (q) => {
      const cities = await loadCities();
      const cl = (q.city || '').toLowerCase(), sl = (q.state || '').toLowerCase();
      const anchor = cities.find(c => c.city && c.city.toLowerCase() === cl &&
        (c.state_id || '').toLowerCase() === sl && c.lat != null && c.lng != null);
      if (!anchor) return [];
      const radius = num(q.radius) || 25;
      const out = [];
      for (const r of cities) {
        if (r.lat == null || r.lng == null) continue;
        if (r.city && r.city.toLowerCase() === cl && (r.state_id || '').toLowerCase() === sl) continue;
        const d = haversine(anchor.lat, anchor.lng, r.lat, r.lng);
        if (d <= radius) out.push({ city: r.city, state: r.state_id, distance: Math.round(d * 10) / 10, niches: r.niches, zips: r.zips });
      }
      out.sort((a, b) => a.distance - b.distance);
      return out.slice(0, 10);
    },

    '/api/compare': async (q) => {
      const pairs = (q.targets || '').split(';').map(t => t.split('|')).filter(p => p.length === 2);
      const data = {}, niches = new Set(), list = [];
      for (const [c, s] of pairs) {
        const cov = await coverageFor(c.trim(), s.trim());
        const key = `${cov.city}, ${cov.state}`;
        list.push(key); data[key] = {};
        cov.niches.forEach(n => {
          const k = `${n.niche} (${n.payout_type})`;
          niches.add(k);
          data[key][k] = { payout: n.payout, zips: n.zips, score: n.score };
        });
        data[key]._meta = { population: cov.total_population, zips: cov.total_zips };
      }
      return { cities: list, niches: [...niches].sort(), data };
    },

    '/api/niche': async (q) => {
      const niche = q.niche || '', ptype = q.ptype || 'CPL';
      const file = await getJSONOpt('niche/' + slugify(niche) + '__' + ptype + '.json');
      let all = file ? expand(file) : [];

      const cityQ = (q.q || '').trim(), hasCityQ = cityQ.length > 0;
      const stateF = q.state ? q.state.toUpperCase() : null;
      const cql = cityQ.toLowerCase();

      const minPay = num(q.min_payout), maxPay = num(q.max_payout);
      const minPop = intnum(q.min_pop), maxPop = intnum(q.max_pop);
      const minZ = intnum(q.min_zips);
      const DENSITY_BANDS = { urban: [1000, 1e9], suburban: [200, 1000], rural: [0, 200] };
      const dband = DENSITY_BANDS[(q.density || '').toLowerCase()];
      const numericFiltersActive =
        minPay != null || maxPay != null || minPop != null || maxPop != null || minZ != null || !!dband;

      const states = new Set();
      let totalZips = 0;
      const out = [];
      for (const r of all) {
        if (r.city == null || r.state_id == null) continue;
        if (stateF && r.state_id !== stateF) continue;
        if (hasCityQ && !(r.city.toLowerCase().includes(cql))) continue;
        states.add(r.state_id);
        if (!hasCityQ) {
          if (minPay != null && r.payout < minPay) continue;
          if (maxPay != null && r.payout > maxPay) continue;
          if (maxPop != null && (r.population || 0) > maxPop) continue;
          if (minPop != null && (r.population || 0) < minPop) continue;
          if (minZ != null && r.zips < minZ) continue;
          if (dband) { const d = r.density || 0; if (!(d >= dband[0] && d < dband[1])) continue; }
        }
        const o = {
          city: r.city, state_id: r.state_id, payout: r.payout,
          avg_payout: r.avg_payout ? Math.round(r.avg_payout * 100) / 100 : null,
          min_payout: r.min_payout, zips: r.zips,
          population: r.population || null,
          density: r.density ? Math.round(r.density) : null,
          county: r.county,
        };
        o.score = score(o.payout, o.zips, o.population);
        totalZips += o.zips;
        out.push(o);
      }

      const sort = q.sort || 'score', dir = parseInt(q.dir || '-1', 10);
      const keyf = {
        payout: x => x.payout, population: x => (x.population || 1e15),
        zips: x => x.zips, score: x => x.score, city: x => x.city.toLowerCase(),
      }[sort] || (x => x.score);
      if (sort === 'population') { out.sort((a, b) => keyf(a) - keyf(b)); if (dir === 1) out.reverse(); }
      else if (sort === 'city') { out.sort((a, b) => keyf(a) < keyf(b) ? -1 : keyf(a) > keyf(b) ? 1 : 0); if (dir === 1) out.reverse(); }
      else { out.sort((a, b) => keyf(b) - keyf(a)); if (dir === 1) out.reverse(); }

      const limit = intnum(q.limit) || 100, offset = intnum(q.offset) || 0;
      return {
        niche, payout_type: ptype, total: out.length, total_zips: totalZips,
        states: [...states].sort(), cities: out.slice(offset, offset + limit),
        offset, limit, filters_bypassed: hasCityQ && numericFiltersActive,
      };
    },

    '/api/niche_states': (q) =>
      getJSONOpt('niche_states/' + slugify(q.niche || '') + '__' + (q.ptype || 'CPL') + '.json')
        .then(r => r || { niche: q.niche || '', payout_type: q.ptype || 'CPL', states: [], state_count: 0, total_zips: 0, total_cities: 0 }),

    '/api/state': (q) =>
      getJSONOpt('state_summary/' + (q.state || '').toUpperCase() + '.json')
        .then(r => r || { state: (q.state || '').toUpperCase(), count: 0, niches: [] }),

    '/api/state_zips': async (q) => {
      const state = (q.state || '').toUpperCase(), niche = q.niche || '', ptype = q.ptype || 'CPL';
      const shard = await loadShard(state);
      const rows = [];
      for (const raw of shard.rows) {
        if ((raw[2] < 0 ? '' : shard.niche[raw[2]]) !== niche) continue;
        if ((raw[3] < 0 ? '' : shard.ptype[raw[3]]) !== ptype) continue;
        rows.push({ zip: raw[1], city: raw[0] < 0 ? null : shard.city[raw[0]], payout: raw[4], population: raw[5], county: raw[9] < 0 ? null : shard.county[raw[9]] });
      }
      const desc = q.dir === 'desc';
      rows.sort((a, b) => (desc ? b.payout - a.payout : a.payout - b.payout) || a.zip - b.zip);

      const tierMap = {};
      rows.forEach(x => { tierMap[x.payout] = (tierMap[x.payout] || 0) + 1; });
      const tiers = Object.keys(tierMap).map(p => ({ payout: +p, zips: tierMap[p] })).sort((a, b) => b.payout - a.payout);

      const cityMap = {};
      rows.forEach(x => {
        if (!x.city) return;
        const c = cityMap[x.city] = cityMap[x.city] || { city: x.city, zips: 0, max: 0, min: Infinity, population: x.population };
        c.zips++; if (x.payout > c.max) c.max = x.payout; if (x.payout < c.min) c.min = x.payout;
      });
      const cities = Object.values(cityMap).sort((a, b) => b.max - a.max || b.zips - a.zips);

      const pays = rows.map(x => x.payout);
      return {
        state, niche, payout_type: ptype, count: rows.length,
        min: pays.length ? Math.min(...pays) : null,
        max: pays.length ? Math.max(...pays) : null,
        avg: pays.length ? Math.round(pays.reduce((a, b) => a + b, 0) / pays.length * 100) / 100 : null,
        tiers, cities, zips: rows,
      };
    },

    '/api/bundles': async (q) => {
      const state = q.state ? q.state.toUpperCase() : '_all';
      let mn = intnum(q.min_niches) || 2;
      if (mn < 2) mn = 2; if (mn > 6) mn = 6;   // precomputed set is 2..6
      const file = await getJSONOpt('bundles/' + state + '__' + mn + '.json');
      let out = (file && file.items) ? file.items.slice() : [];
      const minPop = intnum(q.min_pop);
      if (minPop != null) out = out.filter(c => (c.population || 0) >= minPop);
      const sort = q.sort || 'combined';
      const keyf = { combined: x => x.combined, niches: x => x.niche_count, population: x => (x.population || 1e15) }[sort] || (x => x.combined);
      if (sort === 'population') out.sort((a, b) => keyf(a) - keyf(b));
      else out.sort((a, b) => keyf(b) - keyf(a));
      const limit = intnum(q.limit) || 50, offset = intnum(q.offset) || 0;
      return { total: out.length, items: out.slice(offset, offset + limit), offset, limit };
    },
  };

  // ---------- boot ----------
  window.dataReady = (async () => {
    // The landing page only needs meta; fetch it, then dismiss the boot overlay.
    // Everything else streams in on demand as the user navigates.
    try { await getJSON('meta.json'); } catch (e) { /* j() will surface errors */ }
    const bar = document.getElementById('boot-bar');
    if (bar) bar.style.width = '100%';
    const boot = document.getElementById('boot');
    if (boot) setTimeout(() => { boot.style.opacity = '0'; setTimeout(() => boot.remove(), 350); }, 120);
  })();

  window.j = async function (url) {
    await window.dataReady;
    const path = url.split('?')[0];
    const handler = HANDLERS[path];
    if (!handler) return { error: 'unknown endpoint: ' + path };
    try { return await handler(parseQS(url)); }
    catch (e) { return { error: e.message }; }
  };
})();
