"""
precompute.py — turns leadsmart.db into a tree of small static JSON files so the
browser never downloads the 35 MB SQLite database.

The old frontend loaded the whole DB via sql.js and queried it client-side. Every
visitor paid a ~9.5 MB (brotli) download before the tool worked, and slow links
stalled. Because the data only changes once a day, every possible query result can
instead be computed here, in CI, and served as tiny static files. The rewritten
data.js fetches these instead of the DB.

Output layout (under OUT, default ../netlify-build/api):
  meta.json                    /api/meta
  states.json                  /api/states
  niche_summary.json           /api/niche_summary
  top_markets.json             /api/top_markets
  niche/<slug>.json            raw city list for one niche+ptype (client filters)
  niche_states/<slug>.json     /api/niche_states
  state_summary/<ST>.json      /api/state
  state/<ST>.json              columnar shard: every row for that state. Powers
                               coverage / zips / state_zips / findBundle client-side.
  bundles/<ST|_all>__<n>.json  precomputed bundles for scope × min_niches (2..6)
  cities.json                  suggest + nearby index (lazy)
  zipmap.json                  zip -> state (lazy, for /api/coverage_zip)
  index.json                   manifest: slugs, states, data_date (sanity/debug)

Run:  python precompute.py [DB_PATH] [OUT_DIR]
"""
import sqlite3, json, sys, re, math, os
from collections import defaultdict, OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'leadsmart.db'
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT.parent / 'netlify-build' / 'api'

MIN_NICHES_VALUES = [2, 3, 4, 5, 6]   # matches the By-Niche bundles dropdown


def jround(x):
    """JS Math.round(x*100)/100 — round half up (differs from Python's banker's
    rounding), so precomputed numbers match what the old client produced."""
    if x is None:
        return None
    return math.floor(x * 100 + 0.5) / 100


def slugify(name):
    """Stable slug for niche names. MUST match slugify() in data.js exactly."""
    s = (name or '').lower()
    s = re.sub(r'[^a-z0-9]+', '-', s)
    return s.strip('-')


def write(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    # Compact separators — brotli handles the rest; every byte counts on slow links.
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, separators=(',', ':'), ensure_ascii=False)


def q(con, sql, params=()):
    cur = con.execute(sql, params)
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


# ---------- terminal aggregates ----------
def build_meta(con):
    meta = {}
    for r in q(con, 'SELECT k,v FROM meta'):
        meta[r['k']] = r['v']
    meta['total_cities'] = con.execute(
        'SELECT COUNT(DISTINCT city||"|"||state_id) FROM coverage '
        'WHERE city IS NOT NULL AND state_id IS NOT NULL').fetchone()[0]
    meta['niches'] = [r['niche'] for r in q(
        con, 'SELECT DISTINCT niche FROM coverage ORDER BY niche')]
    nt = {}
    for r in q(con, '''SELECT niche,payout_type,COUNT(DISTINCT zip) zips,
                    COUNT(DISTINCT city||"|"||state_id) cities,MAX(payout) top_payout
             FROM coverage GROUP BY niche,payout_type ORDER BY niche,payout_type'''):
        nt.setdefault(r['niche'], []).append({
            'payout_type': r['payout_type'], 'zips': r['zips'],
            'cities': r['cities'], 'top_payout': r['top_payout']})
    meta['niche_types'] = nt
    return meta


def build_niche_summary(con):
    base = q(con, '''SELECT niche, payout_type,
              COUNT(DISTINCT zip) AS zips,
              MIN(payout) AS min, MAX(payout) AS max, AVG(payout) AS avg
            FROM coverage GROUP BY niche, payout_type''')
    med = {}
    for r in q(con, '''SELECT niche, payout_type, payout AS median FROM (
              SELECT niche, payout_type, payout,
                     ROW_NUMBER() OVER (PARTITION BY niche, payout_type ORDER BY payout) AS rn,
                     COUNT(*)     OVER (PARTITION BY niche, payout_type) AS n
              FROM coverage
            ) WHERE rn = (n + 1) / 2'''):
        med[r['niche'] + '|' + r['payout_type']] = r['median']
    for r in base:
        r['median'] = med.get(r['niche'] + '|' + r['payout_type'])
        if r['median'] is None:
            r['median'] = jround(r['avg'])
        r['avg'] = jround(r['avg'])
    base.sort(key=lambda r: (r['median'] is None, -(r['median'] or 0)))
    return {'niches': base}


def build_states(con):
    return q(con, '''SELECT state_id,
            COUNT(DISTINCT niche) niches, COUNT(DISTINCT zip) zips,
            COUNT(DISTINCT city||"|"||state_id) cities
          FROM coverage WHERE state_id IS NOT NULL GROUP BY state_id ORDER BY state_id''')


def build_top_markets(con):
    has = con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='top_markets'").fetchone()
    if not has:
        return {'markets': [], 'unavailable': True}
    return {'markets': q(con, 'SELECT * FROM top_markets ORDER BY rank')}


# ---------- per niche+ptype ----------
def build_niche_files(con):
    """Raw aggregated city list per niche+ptype. The client applies the numeric
    filters, score, rounding, sort, paging and city-name search (nicheCities)."""
    pairs = q(con, 'SELECT DISTINCT niche,payout_type FROM coverage')
    slugs = {}
    for p in pairs:
        niche, ptype = p['niche'], p['payout_type']
        rows = q(con, '''SELECT city,state_id,
                        MAX(payout) payout, AVG(payout) avg_payout, MIN(payout) min_payout,
                        COUNT(DISTINCT zip) zips, MAX(population) population,
                        MAX(density) density, MAX(county_name) county
                 FROM coverage
                 WHERE niche=? AND payout_type=? AND city IS NOT NULL AND state_id IS NOT NULL
                 GROUP BY city,state_id''', (niche, ptype))
        # array-of-arrays to shrink the file; client zips it back to objects.
        cols = ['city', 'state_id', 'payout', 'avg_payout', 'min_payout',
                'zips', 'population', 'density', 'county']
        data = {'niche': niche, 'payout_type': ptype, 'cols': cols,
                'rows': [[r[c] for c in cols] for r in rows]}
        slug = slugify(niche) + '__' + ptype
        write(OUT / 'niche' / (slug + '.json'), data)
        slugs.setdefault(niche, {})[ptype] = slug

        # niche_states (terminal) for the same pair
        write(OUT / 'niche_states' / (slug + '.json'),
              build_niche_states(con, niche, ptype))
    return slugs


def build_niche_states(con, niche, ptype):
    r = q(con, '''SELECT state_id,
            COUNT(DISTINCT city||'|'||state_id) AS cities,
            COUNT(DISTINCT zip) AS zips,
            MAX(payout) AS top_payout, MIN(payout) AS low_payout, AVG(payout) AS avg_payout
          FROM coverage
          WHERE niche=? AND payout_type=? AND state_id IS NOT NULL
          GROUP BY state_id ORDER BY zips DESC''', (niche, ptype))
    popmap = {}
    for p in q(con, '''SELECT state_id, SUM(pop) AS population FROM (
            SELECT state_id, city, MAX(population) AS pop FROM coverage
            WHERE niche=? AND payout_type=? AND state_id IS NOT NULL
            GROUP BY state_id, city) GROUP BY state_id''', (niche, ptype)):
        popmap[p['state_id']] = p['population'] or 0
    total_zips = total_cities = 0
    for x in r:
        x['avg_payout'] = jround(x['avg_payout'])
        x['population'] = popmap.get(x['state_id'], 0)
        total_zips += x['zips']; total_cities += x['cities']
    return {'niche': niche, 'payout_type': ptype, 'states': r,
            'state_count': len(r), 'total_zips': total_zips, 'total_cities': total_cities}


# ---------- per state ----------
def build_state_summary(con, state):
    r = q(con, '''SELECT niche, payout_type,
            COUNT(DISTINCT city||'|'||state_id) AS cities,
            COUNT(DISTINCT zip) AS zips,
            MAX(payout) AS top_payout, MIN(payout) AS low_payout, AVG(payout) AS avg_payout
          FROM coverage WHERE state_id=?
          GROUP BY niche, payout_type ORDER BY top_payout DESC''', (state,))
    popmap = {}
    for p in q(con, '''SELECT niche, payout_type, SUM(pop) AS population FROM (
            SELECT niche, payout_type, city, state_id, MAX(population) AS pop
            FROM coverage WHERE state_id=?
            GROUP BY niche, payout_type, city, state_id) GROUP BY niche, payout_type''', (state,)):
        popmap[p['niche'] + '|' + p['payout_type']] = p['population'] or 0
    for x in r:
        x['avg_payout'] = jround(x['avg_payout'])
        x['population'] = popmap.get(x['niche'] + '|' + x['payout_type'], 0)
    return {'state': state, 'count': len(r), 'niches': r}


def build_state_shards(con):
    """One columnar file per state holding every row: powers coverage, zips,
    state_zips and per-city bundles client-side. Strings are dictionary-encoded
    (city/niche/ptype/county) so repeats don't bloat the file."""
    rows = con.execute('''SELECT state_id, city, zip, niche, payout_type, payout,
                   population, density, lat, lng, county_name
            FROM coverage WHERE state_id IS NOT NULL''').fetchall()
    by_state = defaultdict(list)
    for row in rows:
        by_state[row[0]].append(row)
    for st, srows in by_state.items():
        cityd, niched, ptyped, countyd = OrderedDict(), OrderedDict(), OrderedDict(), OrderedDict()

        def idx(d, v):
            if v is None:
                return -1
            if v not in d:
                d[v] = len(d)
            return d[v]

        out_rows = []
        for (_st, city, zip_, niche, ptype, payout, pop, density, lat, lng, county) in srows:
            out_rows.append([
                idx(cityd, city), zip_, idx(niched, niche), idx(ptyped, ptype),
                payout, pop, density, lat, lng, idx(countyd, county)])
        shard = {
            'state': st,
            'cols': ['city', 'zip', 'niche', 'ptype', 'payout',
                     'population', 'density', 'lat', 'lng', 'county'],
            'city': list(cityd.keys()),
            'niche': list(niched.keys()),
            'ptype': list(ptyped.keys()),
            'county': list(countyd.keys()),
            'rows': out_rows,
        }
        write(OUT / 'state' / (st + '.json'), shard)
        write(OUT / 'state_summary' / (st + '.json'), build_state_summary(con, st))
    return list(by_state.keys())


# ---------- bundles ----------
def _bundles_for(rows, min_niches):
    """Port of data.js bundles(): best stackable ZIP per city. `rows` are
    (city, state_id, zip, niche, payout_type, payout, population, county) with
    payout already the per-(city,zip,niche,ptype) MAX. Returns the full unsorted
    city list; the client applies min_pop / sort / paging."""
    by_zip = {}
    for (city, st, zip_, niche, ptype, payout, pop, county) in rows:
        k = f'{city}|{st}|{zip_}'
        d = by_zip.get(k)
        if d is None:
            d = by_zip[k] = {'pop': pop, 'county': county, 'n': {}}
        cur = d['n'].get(niche)
        if cur is None or cur['payout'] < payout:
            d['n'][niche] = {'payout': payout, 'ptype': ptype}
    by_city = {}
    for k, d in by_zip.items():
        city, st, zip_ = k.split('|')
        nk = list(d['n'].keys())
        if len(nk) < min_niches:
            continue
        top = sorted(nk, key=lambda n: d['n'][n]['payout'], reverse=True)[:4]
        combined = jround(sum(d['n'][n]['payout'] for n in top))
        cand = {'city': city, 'state_id': st, 'zip': int(zip_),
                'population': d['pop'], 'county': d['county'],
                'niche_count': len(nk), 'combined': combined,
                'stack': [{'niche': n, 'payout': d['n'][n]['payout'],
                           'ptype': d['n'][n]['ptype']} for n in top]}
        ck = city + '|' + st
        if ck not in by_city or by_city[ck]['combined'] < combined:
            by_city[ck] = cand
    return list(by_city.values())


def build_bundles(con):
    grouped = con.execute('''SELECT city,state_id,zip,niche,payout_type,
            MAX(payout) payout, MAX(population) population, MAX(county_name) county
          FROM coverage WHERE city IS NOT NULL AND state_id IS NOT NULL
          GROUP BY city,state_id,zip,niche,payout_type''').fetchall()
    national = grouped
    by_state = defaultdict(list)
    for row in grouped:
        by_state[row[1]].append(row)

    def rowtuple(r):
        return (r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7])

    for mn in MIN_NICHES_VALUES:
        write(OUT / 'bundles' / f'_all__{mn}.json',
              {'scope': 'all', 'min_niches': mn,
               'items': _bundles_for([rowtuple(r) for r in national], mn)})
        for st, srows in by_state.items():
            write(OUT / 'bundles' / f'{st}__{mn}.json',
                  {'scope': st, 'min_niches': mn,
                   'items': _bundles_for([rowtuple(r) for r in srows], mn)})


# ---------- lazy indexes ----------
def build_cities_index(con):
    """suggest + nearby index: one entry per city with the fields both features
    need. Array-of-arrays keyed by `cols`."""
    rows = q(con, '''SELECT city, state_id,
            COUNT(DISTINCT niche) AS niches, COUNT(DISTINCT zip) AS zips,
            MAX(population) AS population, AVG(lat) AS lat, AVG(lng) AS lng
          FROM coverage WHERE city IS NOT NULL AND state_id IS NOT NULL
          GROUP BY city, state_id''')
    cols = ['city', 'state_id', 'niches', 'zips', 'population', 'lat', 'lng']
    write(OUT / 'cities.json',
          {'cols': cols, 'rows': [[r[c] for c in cols] for r in rows]})


def build_zipmap(con):
    """zip -> state, for /api/coverage_zip. Mirrors the old 'SELECT ... WHERE
    zip=? LIMIT 1' by keeping the first state seen for each zip."""
    zm = {}
    for r in con.execute('''SELECT zip, state_id FROM coverage
            WHERE zip IS NOT NULL AND state_id IS NOT NULL'''):
        z = str(r[0])
        if z not in zm:
            zm[z] = r[1]
    write(OUT / 'zipmap.json', zm)


def main():
    if not DB_PATH.exists():
        sys.exit(f'precompute: DB not found at {DB_PATH}')
    con = sqlite3.connect(DB_PATH)
    print(f'precompute: {DB_PATH} -> {OUT}')

    write(OUT / 'meta.json', build_meta(con))
    write(OUT / 'niche_summary.json', build_niche_summary(con))
    write(OUT / 'states.json', build_states(con))
    write(OUT / 'top_markets.json', build_top_markets(con))
    slugs = build_niche_files(con)
    states = build_state_shards(con)
    build_bundles(con)
    build_cities_index(con)
    build_zipmap(con)

    meta = json.load(open(OUT / 'meta.json', encoding='utf-8'))
    write(OUT / 'index.json', {
        'data_date': meta.get('data_date'),
        'states': sorted(states),
        'niche_slugs': slugs,
        'min_niches': MIN_NICHES_VALUES,
    })

    # Small report
    nfiles = sum(len(files) for _, _, files in os.walk(OUT))
    total = sum(f.stat().st_size for f in OUT.rglob('*.json'))
    print(f'precompute: wrote {nfiles} files, {total/1e6:.1f} MB total (uncompressed)')
    print(f'precompute: {len(states)} states, {len(slugs)} niches')
    con.close()


if __name__ == '__main__':
    main()
