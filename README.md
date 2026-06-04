# LeadSmart Coverage Intelligence

Live tool: **https://leadsmart-coverage.netlify.app**

A fully-static market-research tool that wraps LeadSmart's live affiliate
coverage feed. Type a city or pick a niche → see every covered ZIP, payouts,
populations, ZIP-level drill-downs, opportunity bundles, and more.

## Architecture

```
LeadSmart Supabase backend  ── daily pull ─→  SQLite (leadsmart.db)
(affiliate-bid-coverage)                         │
                                                 ▼
                                       Netlify static site
                                       (sql.js in-browser)
```

| Piece | Role |
|---|---|
| `app/sync_supabase.py` | Pulls 320k+ rows from Supabase REST, enriches with us-cities.csv, writes `leadsmart.db` |
| `app/us-cities.csv` | Authoritative city → population / county / density / lat/lng |
| `netlify-build/index.html` | The whole UI in one file |
| `netlify-build/data.js` | sql.js shim — runs all queries client-side against the bundled DB |
| `netlify-build/leadsmart.db` | The DB (built by sync, served as a static asset, cached 1y immutable) |
| `.github/workflows/refresh.yml` | Re-syncs and redeploys daily at 14:00 UTC |

## Local development

```bash
# Build a fresh local DB
cd app
python sync_supabase.py

# Serve the static site
cd ../netlify-build
cp ../app/leadsmart.db .
python -m http.server 8000
# → open http://localhost:8000
```

## Automated daily refresh

The `Daily data refresh` workflow runs every day at **14:00 UTC** (≈ 9 AM EST,
1 hour after LeadSmart's 8 AM CST data update). It:

1. Runs `python app/sync_supabase.py` to pull the latest 320k+ rows.
2. Bundles the new DB with the static assets into `deploy.zip`.
3. Posts that zip to the Netlify Deploy API, replacing the live site.

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
cd app && python sync_supabase.py
cd ../netlify-build && cp ../app/leadsmart.db .
python -c "import zipfile,os
with zipfile.ZipFile('../deploy.zip','w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
  [z.write(f) for f in ['index.html','data.js','leadsmart.db','netlify.toml','favicon.svg']]"
curl -X POST "https://api.netlify.com/api/v1/sites/021639a8-b4f0-46e6-8017-403569a56e1f/deploys" \
  -H "Authorization: Bearer YOUR_NETLIFY_TOKEN" \
  -H "Content-Type: application/zip" \
  --data-binary "@../deploy.zip"
```

## Data attribution

- Coverage feed: **LeadSmart** (https://affiliate-bid-coverage.leadsmartinc.com) — public Supabase anon endpoint
- City / county / population: **SimpleMaps US Cities** (CC BY 4.0)
