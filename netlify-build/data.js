/*
 * data.js — fully-static client-side data layer using sql.js.
 *
 * Loads the SQLite database into the browser via sql.js (WebAssembly),
 * then services every /api/* URL the frontend used to hit on the Python
 * server. Same response shapes — so the existing index.html works unchanged.
 *
 * Exposes:
 *   window.dataReady — Promise that resolves when the DB is loaded
 *   window.j(url)    — replacement for fetch(url).then(r=>r.json())
 */
(function () {
  // The DB filename never changes, but it's served with `immutable` for 1 year.
  // We append a version suffix here so a bad/truncated previous DB doesn't keep
  // serving from the user's browser cache. Bump this whenever the DB schema
  // or full content materially changes (CI also does this automatically).
  const DB_VERSION = '20260606-r2';
  const DB_URL = 'leadsmart.db?v=' + DB_VERSION;
  const SQL_JS_URL = 'https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/';
  let DB = null;

  // ---------- helpers ----------
  function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
  function intnum(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
  function rows(stmt) {
    const r = [];
    while (stmt.step()) r.push(stmt.getAsObject());
    stmt.free();
    return r;
  }
  // sql.js .bind() returns a boolean, not the statement. Wrap so we can
  // still write `query(sql, params)` cleanly across all endpoints.
  function query(sql, params) {
    const stmt = DB.prepare(sql);
    if (params && params.length) stmt.bind(params);
    return rows(stmt);
  }
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
    new URLSearchParams(u.slice(i + 1)).forEach((v, k) => { q[k] = v; });
    return q;
  }

  // ---------- endpoint implementations ----------
  const API = {
    '/api/meta': () => {
      const meta = {};
      query('SELECT k,v FROM meta').forEach(r => { meta[r.k] = r.v; });
      meta.total_cities = query(
        'SELECT COUNT(DISTINCT city||"|"||state_id) AS c FROM coverage WHERE city IS NOT NULL AND state_id IS NOT NULL'
      )[0].c;
      meta.niches = query('SELECT DISTINCT niche FROM coverage ORDER BY niche').map(r => r.niche);
      const nt = {};
      query(`SELECT niche,payout_type,COUNT(DISTINCT zip) zips,
                    COUNT(DISTINCT city||"|"||state_id) cities,MAX(payout) top_payout
             FROM coverage GROUP BY niche,payout_type ORDER BY niche,payout_type`)
        .forEach(r => {
          (nt[r.niche] = nt[r.niche] || []).push({
            payout_type: r.payout_type, zips: r.zips, cities: r.cities, top_payout: r.top_payout
          });
        });
      meta.niche_types = nt;
      return meta;
    },

    '/api/suggest': (q) => {
      const s = (q.q || '').trim();
      if (s.length < 2) return [];
      // Rank so the big-city the user almost certainly means comes first:
      //   1. Exact name match  (so "Phoenix" beats "Phoenixville")
      //   2. Population        (so Phoenix AZ beats Phoenix MD)
      //   3. ZIP coverage      (tiebreaker for unknown-pop entries)
      //   4. Niche breadth     (final tiebreaker)
      return query(`SELECT city, state_id,
            COUNT(DISTINCT niche) AS niches,
            COUNT(DISTINCT zip)   AS zips,
            MAX(population)       AS population
          FROM coverage
          WHERE city IS NOT NULL AND state_id IS NOT NULL
            AND city LIKE ? COLLATE NOCASE
          GROUP BY city, state_id
          ORDER BY
            CASE WHEN LOWER(city)=LOWER(?) THEN 0 ELSE 1 END,
            COALESCE(population,0) DESC,
            zips DESC,
            niches DESC
          LIMIT 12`, [s + '%', s]);
    },

    '/api/coverage': (q) => coverageFor(q.city, q.state),
    '/api/coverage_zip': (q) => {
      const z = intnum(q.zip);
      if (z == null) return { error: 'invalid zip' };
      const r = query('SELECT DISTINCT city,state_id FROM coverage WHERE zip=? LIMIT 1', [z]);
      if (!r.length) return { error: 'ZIP not covered for any niche', zip: z };
      return coverageFor(r[0].city, r[0].state_id);
    },

    '/api/zips': (q) => {
      const r = query(`SELECT zip,payout FROM coverage
            WHERE city=? COLLATE NOCASE AND state_id=? COLLATE NOCASE
              AND niche=? AND payout_type=?
            ORDER BY payout DESC, zip ASC`,
        [q.city || '', q.state || '', q.niche || '', q.ptype || 'CPL']);
      const pays = r.map(x => x.payout);
      return {
        city: q.city, state: q.state, niche: q.niche, payout_type: q.ptype || 'CPL',
        count: r.length, min: pays.length ? Math.min(...pays) : null,
        max: pays.length ? Math.max(...pays) : null, zips: r
      };
    },

    '/api/nearby': (q) => {
      const anchor = query(`SELECT lat,lng FROM coverage
          WHERE city=? COLLATE NOCASE AND state_id=? COLLATE NOCASE
            AND lat IS NOT NULL AND lng IS NOT NULL LIMIT 1`,
        [q.city || '', q.state || ''])[0];
      if (!anchor) return [];
      const radius = num(q.radius) || 25;
      const cand = query(`SELECT city,state_id,AVG(lat) lat,AVG(lng) lng,
              COUNT(DISTINCT niche) niches, COUNT(DISTINCT zip) zips
            FROM coverage
            WHERE lat IS NOT NULL AND lng IS NOT NULL
              AND NOT (city=? COLLATE NOCASE AND state_id=? COLLATE NOCASE)
            GROUP BY city,state_id`, [q.city || '', q.state || '']);
      const out = [];
      for (const r of cand) {
        const d = haversine(anchor.lat, anchor.lng, r.lat, r.lng);
        if (d <= radius) out.push({ city: r.city, state: r.state_id, distance: Math.round(d * 10) / 10, niches: r.niches, zips: r.zips });
      }
      out.sort((a, b) => a.distance - b.distance);
      return out.slice(0, 10);
    },

    '/api/compare': (q) => {
      const pairs = (q.targets || '').split(';').map(t => t.split('|')).filter(p => p.length === 2);
      const data = {}, niches = new Set();
      const list = [];
      pairs.forEach(([c, s]) => {
        const cov = coverageFor(c.trim(), s.trim());
        const key = `${cov.city}, ${cov.state}`;
        list.push(key);
        data[key] = {};
        cov.niches.forEach(n => {
          const k = `${n.niche} (${n.payout_type})`;
          niches.add(k);
          data[key][k] = { payout: n.payout, zips: n.zips, score: n.score };
        });
        data[key]._meta = { population: cov.total_population, zips: cov.total_zips };
      });
      return { cities: list, niches: [...niches].sort(), data };
    },

    '/api/niche': (q) => nicheCities(q),
    '/api/state': (q) => stateSummary(q.state || ''),
    '/api/state_zips': (q) => stateNicheZips(q.state || '', q.niche || '', q.ptype || 'CPL', q.dir),
    '/api/states': () => query(`SELECT state_id,
            COUNT(DISTINCT niche) niches, COUNT(DISTINCT zip) zips,
            COUNT(DISTINCT city||"|"||state_id) cities
          FROM coverage WHERE state_id IS NOT NULL GROUP BY state_id ORDER BY state_id`),

    '/api/bundles': (q) => bundles(q),
  };

  // ---------- by-city helpers ----------
  function coverageFor(city, state) {
    city = city || ''; state = state || '';
    const niches = query(`SELECT niche,payout_type,
          MAX(payout) payout, AVG(payout) avg_payout, MIN(payout) min_payout,
          COUNT(DISTINCT zip) zips, MAX(population) population
        FROM coverage
        WHERE city=? COLLATE NOCASE AND state_id=? COLLATE NOCASE
        GROUP BY niche,payout_type ORDER BY payout DESC`, [city, state])
      .map(r => {
        r.avg_payout = r.avg_payout ? Math.round(r.avg_payout * 100) / 100 : null;
        r.score = score(r.payout, r.zips, r.population);
        return r;
      });
    const tot = query(`SELECT COUNT(DISTINCT zip) zips, MAX(population) pop, MAX(county_name) county_name
        FROM coverage WHERE city=? COLLATE NOCASE AND state_id=? COLLATE NOCASE`, [city, state])[0] || {};
    const distinct = new Set(niches.map(n => n.niche)).size;
    return {
      city, state, county: tot.county_name || null,
      total_zips: tot.zips || 0, total_population: tot.pop || null,
      niche_count: distinct, row_count: niches.length, niches,
      bundles: findBundle(city, state)
    };
  }

  function findBundle(city, state) {
    const r = query(`SELECT zip,niche,payout_type,payout FROM coverage
        WHERE city=? COLLATE NOCASE AND state_id=? COLLATE NOCASE`, [city, state]);
    const byZip = {};
    r.forEach(x => {
      const z = x.zip; byZip[z] = byZip[z] || {};
      const k = `${x.niche} (${x.payout_type})`;
      if (!byZip[z][k] || byZip[z][k] < x.payout) byZip[z][k] = x.payout;
    });
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

  // ---------- by-niche ----------
  const DENSITY_BANDS = { urban: [1000, 1e9], suburban: [200, 1000], rural: [0, 200] };

  function nicheCities(q) {
    // City name search ("Find a city" box) is a "find by name" lookup, not
    // a refinement filter. When the user types in it we bypass the numeric
    // population / payout / ZIP / density filters so the city they typed
    // actually appears — even if some active preset (e.g. Top picks with
    // max_pop=50k) would otherwise hide it. State filter is kept because
    // it's geographic, not size-based.
    const cityQ = (q.q || '').trim();
    const hasCityQ = cityQ.length > 0;

    const where = ['niche=?', 'payout_type=?', 'city IS NOT NULL', 'state_id IS NOT NULL'];
    const args = [q.niche || '', q.ptype || 'CPL'];
    if (q.state) { where.push('state_id=?'); args.push(q.state.toUpperCase()); }
    if (hasCityQ) {
      // contains-match (was prefix), so "york" finds "New York" and "York"
      where.push('city LIKE ? COLLATE NOCASE');
      args.push('%' + cityQ + '%');
    }
    const sql = `SELECT city,state_id,
                        MAX(payout) payout, AVG(payout) avg_payout, MIN(payout) min_payout,
                        COUNT(DISTINCT zip) zips, MAX(population) population,
                        MAX(density) density, MAX(county_name) county
                 FROM coverage WHERE ${where.join(' AND ')} GROUP BY city,state_id`;
    let all = query(sql, args);

    const minPay = num(q.min_payout), maxPay = num(q.max_payout);
    const minPop = intnum(q.min_pop), maxPop = intnum(q.max_pop);
    const minZ = intnum(q.min_zips);
    const dband = DENSITY_BANDS[(q.density || '').toLowerCase()];
    const numericFiltersActive =
      minPay != null || maxPay != null || minPop != null || maxPop != null || minZ != null || !!dband;

    const states = new Set();
    let totalZips = 0;

    const out = [];
    for (const r of all) {
      states.add(r.state_id);
      // When city search is active, skip the numeric/density filters so the
      // user finds the city by name regardless of which preset is applied.
      if (!hasCityQ) {
        if (minPay != null && r.payout < minPay) continue;
        if (maxPay != null && r.payout > maxPay) continue;
        if (maxPop != null && (r.population || 0) > maxPop) continue;
        if (minPop != null && (r.population || 0) < minPop) continue;
        if (minZ != null && r.zips < minZ) continue;
        if (dband) { const d = r.density || 0; if (!(d >= dband[0] && d < dband[1])) continue; }
      }
      r.avg_payout = r.avg_payout ? Math.round(r.avg_payout * 100) / 100 : null;
      r.density = r.density ? Math.round(r.density) : null;
      r.score = score(r.payout, r.zips, r.population);
      if (!r.population) r.population = null;
      totalZips += r.zips;
      out.push(r);
    }

    const sort = q.sort || 'score', dir = parseInt(q.dir || '-1', 10);
    const keyf = {
      payout: x => x.payout,
      population: x => (x.population || 1e15),
      zips: x => x.zips,
      score: x => x.score,
      city: x => x.city.toLowerCase()
    }[sort] || (x => x.score);
    if (sort === 'population') {
      out.sort((a, b) => keyf(a) - keyf(b));
      if (dir === 1) out.reverse();
    } else if (sort === 'city') {
      out.sort((a, b) => keyf(a) < keyf(b) ? -1 : keyf(a) > keyf(b) ? 1 : 0);
      if (dir === 1) out.reverse();
    } else {
      out.sort((a, b) => keyf(b) - keyf(a));
      if (dir === 1) out.reverse();
    }

    const limit = intnum(q.limit) || 100, offset = intnum(q.offset) || 0;
    return {
      niche: q.niche || '', payout_type: q.ptype || 'CPL', total: out.length,
      total_zips: totalZips, states: [...states].sort(),
      cities: out.slice(offset, offset + limit), offset, limit,
      filters_bypassed: hasCityQ && numericFiltersActive,
    };
  }

  function stateSummary(state) {
    state = (state || '').toUpperCase();
    // Per niche/type in this state: ZIP count, distinct cities, payout range
    // (lowest → highest), average, and population reached.
    const r = query(`SELECT niche, payout_type,
            COUNT(DISTINCT city||'|'||state_id) AS cities,
            COUNT(DISTINCT zip) AS zips,
            MAX(payout) AS top_payout,
            MIN(payout) AS low_payout,
            AVG(payout) AS avg_payout
          FROM coverage WHERE state_id=?
          GROUP BY niche, payout_type
          ORDER BY top_payout DESC`, [state]);

    // population reached per niche (distinct city populations summed)
    const popRows = query(`SELECT niche, payout_type, SUM(pop) AS population FROM (
            SELECT niche, payout_type, city, state_id, MAX(population) AS pop
            FROM coverage WHERE state_id=?
            GROUP BY niche, payout_type, city, state_id
          ) GROUP BY niche, payout_type`, [state]);
    const popMap = {};
    popRows.forEach(p => { popMap[p.niche + '|' + p.payout_type] = p.population || 0; });

    r.forEach(x => {
      x.avg_payout = x.avg_payout ? Math.round(x.avg_payout * 100) / 100 : null;
      x.population = popMap[x.niche + '|' + x.payout_type] || 0;
    });
    return { state, count: r.length, niches: r };
  }

  function stateNicheZips(state, niche, ptype, sortDir) {
    // Every ZIP for one niche+type across the whole state, with its city and
    // payout. Sorted by payout (default lowest→highest so people see the floor
    // first), plus a payout-tier distribution and top-city rollup.
    state = (state || '').toUpperCase();
    const dir = sortDir === 'desc' ? 'DESC' : 'ASC';
    const rows = query(`SELECT zip, city, payout, population, county_name AS county
          FROM coverage
          WHERE state_id=? AND niche=? AND payout_type=?
          ORDER BY payout ${dir}, zip ASC`, [state, niche, ptype]);

    // payout-tier distribution (how many ZIPs at each distinct payout)
    const tierMap = {};
    rows.forEach(x => { tierMap[x.payout] = (tierMap[x.payout] || 0) + 1; });
    const tiers = Object.keys(tierMap)
      .map(p => ({ payout: +p, zips: tierMap[p] }))
      .sort((a, b) => b.payout - a.payout);

    // top cities by best payout in this state for this niche
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
  }

  function bundles(q) {
    const state = q.state || '', minNiches = intnum(q.min_niches) || 2;
    const where = ['city IS NOT NULL', 'state_id IS NOT NULL'];
    const args = [];
    if (state) { where.push('state_id=?'); args.push(state.toUpperCase()); }
    const r = query(`SELECT city,state_id,zip,niche,payout_type,
            MAX(payout) payout, MAX(population) population, MAX(county_name) county
          FROM coverage WHERE ${where.join(' AND ')}
          GROUP BY city,state_id,zip,niche,payout_type`, args);
    const byZip = {};
    r.forEach(x => {
      const k = x.city + '|' + x.state_id + '|' + x.zip;
      const d = byZip[k] = byZip[k] || { pop: x.population, county: x.county, n: {} };
      if (!d.n[x.niche] || d.n[x.niche].payout < x.payout) d.n[x.niche] = { payout: x.payout, ptype: x.payout_type };
    });
    const byCity = {};
    for (const k in byZip) {
      const [city, st, zip] = k.split('|');
      const d = byZip[k]; const nk = Object.keys(d.n);
      if (nk.length < minNiches) continue;
      const top = nk.sort((a, b) => d.n[b].payout - d.n[a].payout).slice(0, 4);
      const combined = Math.round(top.reduce((s, n) => s + d.n[n].payout, 0) * 100) / 100;
      const cand = { city, state_id: st, zip: +zip, population: d.pop, county: d.county,
                     niche_count: nk.length, combined,
                     stack: top.map(n => ({ niche: n, payout: d.n[n].payout, ptype: d.n[n].ptype })) };
      const ck = city + '|' + st;
      if (!byCity[ck] || byCity[ck].combined < combined) byCity[ck] = cand;
    }
    let out = Object.values(byCity);
    const minPop = intnum(q.min_pop);
    if (minPop != null) out = out.filter(c => (c.population || 0) >= minPop);
    const sort = q.sort || 'combined';
    const keyf = { combined: x => x.combined, niches: x => x.niche_count,
                   population: x => (x.population || 1e15) }[sort] || (x => x.combined);
    if (sort === 'population') out.sort((a, b) => keyf(a) - keyf(b));
    else out.sort((a, b) => keyf(b) - keyf(a));
    const limit = intnum(q.limit) || 50, offset = intnum(q.offset) || 0;
    return { total: out.length, items: out.slice(offset, offset + limit), offset, limit };
  }

  // ---------- public API ----------
  window.dataReady = (async () => {
    // Load sql.js then the database
    const initSqlJs = await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SQL_JS_URL + 'sql-wasm.js';
      s.onload = () => resolve(window.initSqlJs);
      s.onerror = reject;
      document.head.appendChild(s);
    });
    const SQL = await initSqlJs({ locateFile: f => SQL_JS_URL + f });
    const bar = document.getElementById('boot-bar');
    const pct = document.getElementById('boot-pct');

    const res = await fetch(DB_URL);
    if (!res.ok) throw new Error('failed to load database');
    const total = +res.headers.get('Content-Length') || 41000000;
    const reader = res.body.getReader();
    const chunks = []; let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); received += value.length;
      if (bar) bar.style.width = Math.min(99, Math.round(100 * received / total)) + '%';
      if (pct) pct.textContent = Math.round(received / 1024 / 1024) + ' MB';
    }
    const buf = new Uint8Array(received); let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    DB = new SQL.Database(buf);
    if (bar) bar.style.width = '100%';
    const boot = document.getElementById('boot');
    if (boot) setTimeout(() => { boot.style.opacity = '0'; setTimeout(() => boot.remove(), 350); }, 200);
  })();

  // Replace fetch().then(json) shim used by index.html
  window.j = async function (url) {
    await window.dataReady;
    const path = url.split('?')[0];
    const handler = API[path];
    if (!handler) return { error: 'unknown endpoint: ' + path };
    try {
      return handler(parseQS(url));
    } catch (e) {
      return { error: e.message };
    }
  };
})();
