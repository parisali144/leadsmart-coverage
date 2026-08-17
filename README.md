# LeadSmart Coverage Intelligence

Live tool: **https://leadsmart-coverage.netlify.app**

A fully-static market-research tool that wraps LeadSmart's live affiliate
coverage feed. Type a city or pick a niche → see every covered ZIP, payouts,
populations, ZIP-level drill-downs, opportunity bundles, and more.

## Architecture

```
LeadSmart Supabase backend ─ daily pull ─→ SQLite (leadsmart.db, CI-only)
(affiliate-bid-coverage)                        │  precompute.py
                                                ▼
                                    static JSON API  (netlify-build/api/*)
                                                │
                                                ▼
                                       Netlify static site
                                    (fetches only the files a view needs)
```

The browser never downloads the database. Because the data changes only once a
day, every query result is precomputed in CI into small static JSON. Opening the
site fetches ~1 KB (`meta.json`); the heaviest drill-down is a few hundred KB.
The DB is a CI-only build artifact used to generate the JSON — it is not deployed.

| Piece | Role |
|---|---|
| `app/sync_supabase.py` | Pulls the LeadSmart feed from Supabase REST, filters to LeadSmart's live view (`enabled AND group_label != 'Legal'`), enriches with us-cities.csv, writes `leadsmart.db` |
| `app/precompute.py` | Turns `leadsmart.db` into the static JSON API under `netlify-build/api/` (aggregates, per-niche lists, per-state shards, bundles, indexes) |
| `app/us-cities.csv` | Authoritative city → population / county / density / lat/lng |
| `netlify-build/index.html` | The whole UI in one file |
| `netlify-build/data.js` | Fetch layer — maps each `/api/*` call to the precomputed JSON and recomputes row-level views client-side |
| `netlify-build/api/` | The generated static JSON API (build artifact; git-ignored, rebuilt each run) |
| `.github/workflows/refresh.yml` | Re-syncs, precomputes, and redeploys daily at 14:00 UTC |

## Local development

```bash
# Build a fresh local DB, then the static JSON API from it
cd app
python sync_supabase.py
python precompute.py            # writes ../netlify-build/api/

# Serve the static site
cd ../netlify-build
python -m http.server 8000
# → open http://localhost:8000
```

## Automated daily refresh

The `Daily data refresh` workflow runs every day at **14:00 UTC** (≈ 9 AM EST,
1 hour after LeadSmart's 8 AM CST data update). It:

1. Runs `python app/sync_supabase.py` to pull the latest rows into `leadsmart.db`.
2. Runs `python app/precompute.py` to generate the static JSON API.
3. Bundles the JSON API + static assets into `deploy.zip` (no DB).
4. Posts that zip to the Netlify Deploy API, replacing the live site.

You can also trigger it manually from the **Actions** tab → `Daily data refresh`
→ `Run workflow`.

### One-time setup

For the workflow to run, the repository needs one secret:

| Secret name | Value |
|---|---|
| `NETLIFY_TOKEN` | Your Netlify Personal Access Token (the one starting `nfp_…`) |

Go to **repo Settings → Secrets and variables → Actions → New repository secret**,
name it `NETLIFY_TOKEN`, paste the token, save.

The site ID is already wired into the workflow:

```
NETLIFY_SITE_ID: 021639a8-b4f0-46e6-8017-403569a56e1f
```

## Manual deploy

If you ever need to deploy without waiting for the cron:

```bash
cd app && python sync_supabase.py && python precompute.py
cd ../netlify-build
python -c "import zipfile,os
files=['index.html','data.js','netlify.toml','favicon.svg','robots.txt','sitemap.xml']
with zipfile.ZipFile('../deploy.zip','w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
  [z.write(f) for f in files]
  [z.write(os.path.join(r,f)) for r,_,fs in os.walk('api') for f in fs]"
curl -X POST "https://api.netlify.com/api/v1/sites/021639a8-b4f0-46e6-8017-403569a56e1f/deploys" \
  -H "Authorization: Bearer YOUR_NETLIFY_TOKEN" \
  -H "Content-Type: application/zip" \
  --data-binary "@../deploy.zip"
```

## Data attribution

- Coverage feed: **LeadSmart** (https://affiliate-bid-coverage.leadsmartinc.com) — public Supabase anon endpoint
- City / county / population: **SimpleMaps US Cities** (CC BY 4.0)
