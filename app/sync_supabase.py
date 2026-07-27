"""
sync_supabase.py — pulls the latest coverage data from LeadSmart's live
Supabase backend (https://affiliate-bid-coverage.leadsmartinc.com) and writes
it to leadsmart.db, replacing the static workbook snapshot.

Reads:
  - verticals + top_bids from Supabase REST API (anonymous, public)
  - us-cities.csv for city/county/population/density/lat/lng enrichment

Writes:
  app/leadsmart.db  (same schema as before — the tool's frontend works unchanged)
  Updates DATA_DATE in the meta table to the freshest last_updated seen.

Run:
  python sync_supabase.py
"""
import sqlite3, csv, json, re, time
from urllib.request import Request, urlopen
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / 'leadsmart.db'

def _find_cities_csv():
    """Look for us-cities.csv in order of preference.
    Lets the same script run locally (RankLocal data folder) and in CI
    (bundled into the repo)."""
    candidates = [
        ROOT / 'us-cities.csv',                       # bundled next to script (CI)
        ROOT.parent / 'app' / 'us-cities.csv',        # repo layout
        Path(r'C:\Users\PARIS Ali\Desktop\ranklocal 2\data\us-cities.csv'),  # local dev
    ]
    for p in candidates:
        if p.exists():
            return p
    return candidates[0]  # will warn later

CITIES_CSV = _find_cities_csv()

SUPA_URL = 'https://jowsrovyaqprkkbmvtyw.supabase.co'
SUPA_KEY = (
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.'
    'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impvd3Nyb3Z5YXFwcmtrYm12dHl3Iiwicm9sZSI6'
    'ImFub24iLCJpYXQiOjE3NzY3MDM2MDQsImV4cCI6MjA5MjI3OTYwNH0.'
    'GpzsXprIVJYhH9IBGgKYmzmc70svwXmtauneprl5ccM'
)
HEADERS = {'apikey': SUPA_KEY, 'Authorization': f'Bearer {SUPA_KEY}'}

GROUP_TO_TYPE = {
    'Pay-per-Call': 'Call',
    'CPL Call (Pay on Appointment)': 'CPL',
}


def supa_get(path, extra_headers=None):
    """Single GET against Supabase REST. Returns (parsed_json, response_headers).
    Retries on transient network errors (connection reset, timeout, HTTP 5xx)."""
    h = dict(HEADERS)
    if extra_headers:
        h.update(extra_headers)
    url = f'{SUPA_URL}/rest/v1/{path}'
    last_err = None
    for attempt in range(4):
        try:
            req = Request(url, headers=h)
            with urlopen(req, timeout=60) as r:
                body = r.read()
                return json.loads(body), dict(r.headers)
        except Exception as e:
            last_err = e
            wait = 2 ** attempt   # 1, 2, 4, 8 seconds
            print(f'  ! supa_get({path[:60]}) failed (attempt {attempt+1}/4): {e}; retrying in {wait}s')
            time.sleep(wait)
    raise RuntimeError(f'supa_get gave up after 4 attempts on {path}: {last_err}')


def fetch_all(table, columns='*'):
    """Robust paginated fetch. Three protections against the silent-truncation
    bug that the naive 'len(rows) < PAGE' approach has:

      1. Get the exact total count first via Prefer: count=exact + Content-Range.
      2. Loop using offset accumulated by actual rows received, until we hit
         that known total — never trust 'short page = last page'.
      3. If we still come up short after the loop, raise instead of silently
         deploying a truncated DB."""
    PAGE = 1000

    # Step 1 — get the exact total. Supabase returns "Content-Range: 0-0/321822".
    _, hdrs = supa_get(f'{table}?select={columns}&limit=1',
                       extra_headers={'Prefer': 'count=exact'})
    cr = hdrs.get('Content-Range') or hdrs.get('content-range') or '*/0'
    try:
        total = int(cr.split('/')[-1])
    except ValueError:
        total = 0
    print(f'  {table}: total expected = {total:,}')

    out, offset = [], 0
    while offset < total:
        rows, _ = supa_get(f'{table}?select={columns}&offset={offset}&limit={PAGE}')
        if not rows:
            # Could be a transient empty page — try once more then bail.
            print(f'  {table}: got empty page at offset {offset}, retrying once…')
            time.sleep(2)
            rows, _ = supa_get(f'{table}?select={columns}&offset={offset}&limit={PAGE}')
            if not rows:
                break
        out.extend(rows)
        offset += len(rows)
        print(f'  {table}: fetched {len(out):,}/{total:,} rows', end='\r')

    print(f'  {table}: fetched {len(out):,}/{total:,} rows total')
    if total and len(out) < total:
        raise RuntimeError(
            f'Short fetch on {table}: got {len(out):,} but expected {total:,}. '
            f'Refusing to write a truncated DB.')
    return out


def norm_city(name):
    if not name:
        return ''
    s = str(name).strip().lower().replace('.', '')
    s = re.sub(r'\s+', ' ', s)
    s = re.sub(r'^st ', 'saint ', s)
    s = re.sub(r'^ft ', 'fort ', s)
    s = re.sub(r'^mt ', 'mount ', s)
    return s


def load_us_cities():
    """Return (by_name_state, by_zip) dicts with population/county/density/lat/lng."""
    by_name, by_zip = {}, {}
    if not CITIES_CSV.exists():
        print(f'  WARNING: {CITIES_CSV} not found — coverage will lack enrichment')
        return by_name, by_zip
    with open(CITIES_CSV, encoding='utf-8') as f:
        for r in csv.DictReader(f):
            state = (r.get('state_id') or '').strip().upper()
            try:
                pop = int(float(r.get('population') or 0))
            except (ValueError, TypeError):
                pop = 0
            try:
                dens = float(r.get('density') or 0) or None
            except (ValueError, TypeError):
                dens = None
            try:
                lat = float(r.get('lat')) if r.get('lat') else None
                lng = float(r.get('lng')) if r.get('lng') else None
            except ValueError:
                lat = lng = None
            rec = {
                'city': r.get('city'),
                'state_id': state,
                'population': pop,
                'county': r.get('county_name') or None,
                'density': dens,
                'lat': lat,
                'lng': lng,
            }
            key = norm_city(r.get('city')) + '|' + state
            if key not in by_name or pop > by_name[key]['population']:
                by_name[key] = rec
            for zt in (r.get('zips') or '').split():
                try:
                    zi = int(zt)
                except ValueError:
                    continue
                if zi not in by_zip or pop > by_zip[zi]['population']:
                    by_zip[zi] = rec
    print(f'  us-cities loaded: {len(by_name):,} city/state names, {len(by_zip):,} ZIPs')
    return by_name, by_zip


def build():
    print('Sync starting…')
    verticals = fetch_all('verticals', columns='id,slug,name,group_label,sort_order,priority,enabled')
    top_bids = fetch_all('top_bids', columns='zip,vertical_id,net_payout,city,state,last_updated')

    vmap = {v['id']: v for v in verticals}
    by_name, by_zip = load_us_cities()

    # Build coverage rows
    matched = unmatched = 0
    rows = []
    freshest = None
    for b in top_bids:
        v = vmap.get(b['vertical_id'])
        if not v:
            continue
        try:
            z = int(b['zip'])
        except (ValueError, TypeError):
            continue
        try:
            payout = float(b['net_payout'])
        except (ValueError, TypeError):
            continue
        if payout <= 0:
            continue

        city = (b.get('city') or '').strip() or None
        state = (b.get('state') or '').strip().upper() or None

        # Enrichment lookup
        rec = None
        if city and state:
            rec = by_name.get(norm_city(city) + '|' + state)
        if not rec:
            rec = by_zip.get(z)
        if rec:
            matched += 1
            city = city or rec['city']
            state = state or rec['state_id']
            pop = rec['population'] or None
            county = rec['county']
            dens = rec['density']
            lat = rec['lat']
            lng = rec['lng']
        else:
            unmatched += 1
            pop = county = dens = lat = lng = None

        ptype = GROUP_TO_TYPE.get(v.get('group_label'), 'Call')
        rows.append((v['name'], ptype, z, payout, city, state, pop, dens, lat, lng, county))

        lu = b.get('last_updated')
        if lu and (freshest is None or lu > freshest):
            freshest = lu

    print(f'  enrichment: {matched:,} matched, {unmatched:,} fell back to zero-pop '
          f'({100*matched/max(1,matched+unmatched):.1f}% matched)')
    print(f'  freshest last_updated in feed: {freshest}')

    # Write DB
    if DB_PATH.exists():
        DB_PATH.unlink()
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.executescript('''
        CREATE TABLE coverage (
            niche TEXT, payout_type TEXT, zip INTEGER, payout REAL,
            city TEXT, state_id TEXT, population INTEGER, density REAL,
            lat REAL, lng REAL, county_name TEXT
        );
        CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
    ''')
    cur.executemany('INSERT INTO coverage VALUES (?,?,?,?,?,?,?,?,?,?,?)', rows)

    data_date = (freshest or '')[:10] or time.strftime('%Y-%m-%d')
    cur.execute('INSERT INTO meta VALUES (?,?)', ('data_date', data_date))
    cur.execute('INSERT INTO meta VALUES (?,?)', ('source', 'live · affiliate-bid-coverage.leadsmartinc.com'))
    cur.execute('INSERT INTO meta VALUES (?,?)', ('niche_count', str(len(verticals))))

    cur.executescript('''
        CREATE INDEX idx_cov_citystate ON coverage(city, state_id);
        CREATE INDEX idx_cov_zip ON coverage(zip);
        CREATE INDEX idx_cov_niche ON coverage(niche);
    ''')

    # ---- landing-page leaderboard, precomputed ----
    # sql.js runs synchronously on the browser's main thread, and ranking every
    # city needs a full scan of `coverage` (~2.5s in wasm). Doing that on page
    # load would freeze the UI, so the ranking is computed once, here, in CI.
    # "stacked" = sum of the best payout per niche in that city, i.e. what one
    # site covering every available niche there could earn per lead round.
    cur.execute('''
        CREATE TABLE top_markets (
            rank INTEGER, city TEXT, state_id TEXT,
            niches INTEGER, zips INTEGER, population INTEGER, stacked REAL,
            top_niche TEXT, top_payout REAL, top_ptype TEXT
        )''')
    leaders = cur.execute('''
        SELECT city, state_id, COUNT(*) AS niches, SUM(mx) AS stacked,
               MAX(pop) AS population, SUM(zc) AS zips
        FROM (SELECT city, state_id, niche, MAX(payout) AS mx,
                     MAX(population) AS pop, COUNT(DISTINCT zip) AS zc
              FROM coverage WHERE city IS NOT NULL AND state_id IS NOT NULL
              GROUP BY city, state_id, niche)
        GROUP BY city, state_id ORDER BY stacked DESC LIMIT 12''').fetchall()

    tm_rows = []
    for i, (city, st, niches, stacked, pop, zips) in enumerate(leaders, 1):
        top = cur.execute('''
            SELECT niche, payout_type, MAX(payout) FROM coverage
            WHERE city=? AND state_id=? GROUP BY niche, payout_type
            ORDER BY 3 DESC LIMIT 1''', (city, st)).fetchone()
        tm_rows.append((i, city, st, niches, zips, pop, round(stacked or 0, 2),
                        top[0] if top else None,
                        top[2] if top else None,
                        top[1] if top else None))
    cur.executemany('INSERT INTO top_markets VALUES (?,?,?,?,?,?,?,?,?,?)', tm_rows)
    print(f'  top_markets: {len(tm_rows)} rows '
          f'(leader: {tm_rows[0][1]}, {tm_rows[0][2]} @ ${tm_rows[0][6]:,.2f})' if tm_rows else '  top_markets: empty')

    con.commit()
    cur.execute('VACUUM')

    # Report
    print(f'  coverage rows: {len(rows):,}')
    cur.execute('SELECT COUNT(DISTINCT city||"|"||state_id) FROM coverage WHERE city IS NOT NULL AND state_id IS NOT NULL')
    print(f'  distinct city/state: {cur.fetchone()[0]:,}')
    cur.execute('SELECT niche, payout_type, COUNT(*) FROM coverage GROUP BY niche, payout_type ORDER BY 1')
    print('\n  Per niche/type:')
    for n, t, c in cur.fetchall():
        print(f'    {n:24} {t:5} {c:>7,}')
    con.close()
    print(f'\nDone -> {DB_PATH}  (data_date {data_date})')


if __name__ == '__main__':
    build()
