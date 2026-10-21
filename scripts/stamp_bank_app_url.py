"""Stamp a workshop's bank app URL into the Dewy Bank connectors (Customer API and Support API).

Run once per workshop deployment, before participants clone:
    python3 scripts/stamp_bank_app_url.py https://<distribution>.cloudfront.net

The connectors discover everything else from <bank app URL>/config.json (the
Cognito region and app client ID, the customer API URL, the Support API URL),
so participants enter only their own Dewy Bank email and password, and at
Station C one support code. Changing a connector's code also needs its
.custom_adapter.json to change, or the push fails with "Package doesn't contain
any assets", so this bumps each version note too.
"""
import datetime, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
CONN = os.path.join(HERE, '..', 'workspace-connections')
CONNECTORS = ['dewy_bank_customer_api', 'dewy_bank_support_api']
LINE = re.compile(r"(bank_app_url = ')[^']*(' # stamped before the workshop by scripts/stamp_bank_app_url\.py)")

if len(sys.argv) != 2 or not re.match(r'^https://[^/\s]+(/[^\s]*)?$', sys.argv[1]):
    sys.exit('usage: python3 scripts/stamp_bank_app_url.py https://<bank app host>')
url = sys.argv[1].rstrip('/')

# Check every connector before writing any, so a failure never leaves them half-stamped.
for name in CONNECTORS:
    rb = os.path.join(CONN, name + '.custom_adapter.rb')
    if len(LINE.findall(open(rb).read())) != 1:
        sys.exit(f'{rb}: expected exactly one stamped bank_app_url line')

for name in CONNECTORS:
    rb = os.path.join(CONN, name + '.custom_adapter.rb')
    meta_path = os.path.join(CONN, name + '.custom_adapter.json')
    code = open(rb).read()
    open(rb, 'w').write(LINE.sub(lambda m: m.group(1) + url + m.group(2), code))
    meta = json.load(open(meta_path))
    meta['note'] = f'Stamped for {url} ({datetime.date.today().isoformat()})'
    with open(meta_path, 'w') as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)
        f.write('\n')

print(f'Stamped {url} into both connectors. Push Workspace Connections next: wk push --folder "Workspace Connections"')
