"""Stamp a workshop's bank app URL into the Dewy Bank connectors (Customer API and Support API).

Run once per workshop deployment, before participants clone:
    python3 scripts/stamp_bank_app_url.py https://<distribution>.cloudfront.net

The connectors no longer fetch config.json at runtime: all values (Cognito region,
app client ID, customer/support API URLs) are stamped in alongside bank_app_url
so participants enter only their own Dewy Bank email and password, and at
Station C one support code. Changing a connector's code also needs its
.custom_adapter.json to change, or the push fails with "Package doesn't contain
any assets", so this bumps each version note too.
"""
import datetime, json, os, re, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONN = os.path.join(HERE, '..', 'workspace-connections')
CONNECTORS = ['dewy_bank_customer_api', 'dewy_bank_support_api']
LINE = re.compile(r"(bank_app_url = ')[^']*(' # stamped before the workshop by scripts/stamp_bank_app_url\.py)")

CUSTOMER_LINES = {
    'cognito_region':       re.compile(r"(cognito_region = ')[^']*('\s*# stamped before the workshop by scripts/stamp_bank_app_url\.py)"),
    'user_pool_client_id':  re.compile(r"(user_pool_client_id = ')[^']*('\s*# stamped before the workshop by scripts/stamp_bank_app_url\.py)"),
    'customer_api_url':     re.compile(r"(customer_api_url = ')[^']*('\s*# stamped before the workshop by scripts/stamp_bank_app_url\.py)"),
}
SUPPORT_LINES = {
    'support_api_url': re.compile(r"(support_api_url = ')[^']*('\s*# stamped before the workshop by scripts/stamp_bank_app_url\.py)"),
}

if len(sys.argv) != 2 or not re.match(r'^https://[^/\s]+(/[^\s]*)?$', sys.argv[1]):
    sys.exit('usage: python3 scripts/stamp_bank_app_url.py https://<bank app host>')
url = sys.argv[1].rstrip('/')

# Fetch config.json to get the deployment-specific values
config_url = f'{url}/config.json'
try:
    with urllib.request.urlopen(config_url, timeout=10) as resp:
        config = json.loads(resp.read().decode())
except Exception as e:
    sys.exit(f'Could not fetch {config_url}: {e}')

required = ['region', 'userPoolClientId', 'customerApiUrl', 'supportApiUrl']
missing = [k for k in required if not config.get(k)]
if missing:
    sys.exit(f'config.json is missing required keys: {missing}')

# Check every connector before writing any, so a failure never leaves them half-stamped.
for name in CONNECTORS:
    rb = os.path.join(CONN, name + '.custom_adapter.rb')
    if len(LINE.findall(open(rb).read())) != 1:
        sys.exit(f'{rb}: expected exactly one stamped bank_app_url line')

for name in CONNECTORS:
    rb = os.path.join(CONN, name + '.custom_adapter.rb')
    meta_path = os.path.join(CONN, name + '.custom_adapter.json')
    code = open(rb).read()
    code = LINE.sub(lambda m: m.group(1) + url + m.group(2), code)
    if name == 'dewy_bank_customer_api':
        code = CUSTOMER_LINES['cognito_region'].sub(
            lambda m: m.group(1) + config['region'] + m.group(2), code)
        code = CUSTOMER_LINES['user_pool_client_id'].sub(
            lambda m: m.group(1) + config['userPoolClientId'] + m.group(2), code)
        code = CUSTOMER_LINES['customer_api_url'].sub(
            lambda m: m.group(1) + config['customerApiUrl'] + m.group(2), code)
    elif name == 'dewy_bank_support_api':
        code = SUPPORT_LINES['support_api_url'].sub(
            lambda m: m.group(1) + config['supportApiUrl'] + m.group(2), code)
    open(rb, 'w').write(code)
    meta = json.load(open(meta_path))
    meta['note'] = f'Stamped for {url} ({datetime.date.today().isoformat()})'
    with open(meta_path, 'w') as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)
        f.write('\n')

print(f'Stamped {url} into both connectors. Push Workspace Connections next: wk push --folder "Workspace Connections"')
