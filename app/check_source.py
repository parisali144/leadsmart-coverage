"""
check_source.py — has LeadSmart's feed changed since the live site was built?

Compares the source fingerprint (newest last_updated | row count | live
verticals) against the `source_fingerprint` stored in the live site's
/api/meta.json. Prints the result and, under GitHub Actions, writes
`changed=true|false` to $GITHUB_OUTPUT so the workflow can skip the
sync/deploy when nothing changed.

Run:
  python check_source.py
"""
import json, os, time
from urllib.request import Request, urlopen

from sync_supabase import fetch_all, is_live, source_fingerprint

LIVE_META = 'https://leadsmart-coverage.netlify.app/api/meta.json'


def live_fingerprint():
    try:
        req = Request(f'{LIVE_META}?t={int(time.time())}',
                      headers={'Cache-Control': 'no-cache'})
        with urlopen(req, timeout=30) as r:
            return json.load(r).get('source_fingerprint') or ''
    except Exception as e:
        print(f'  ! could not read live meta.json ({e}); treating as changed')
        return ''


def main():
    verticals = [v for v in fetch_all('verticals', columns='id,group_label,enabled')
                 if is_live(v)]
    ids = [v['id'] for v in verticals]
    source = source_fingerprint(ids, 'vertical_id=in.(%s)' % ','.join(ids))
    live = live_fingerprint()
    changed = source != live
    print(f'source: {source}\nlive:   {live or "(none)"}\nchanged: {changed}')
    out = os.environ.get('GITHUB_OUTPUT')
    if out:
        with open(out, 'a') as f:
            f.write(f'changed={str(changed).lower()}\n')


if __name__ == '__main__':
    main()
