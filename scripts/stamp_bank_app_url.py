"""Stamp a workshop's bank app URL into the Dewy Bank connectors (Customer API and Support API).

Run once per workshop deployment, before participants clone:
    python3 scripts/stamp_bank_app_url.py https://<distribution>.cloudfront.net

The Customer API connector exposes bank_app_url as a connection field; the stamped default
is written here. The connector discovers region, userPoolClientId, and customerApiUrl from
config.json at runtime — no AWS values live in the connector code. The Support API connector
has bank_app_url and support_api_url stamped inline. Changing either connector's code also
needs its .custom_adapter.json to change, or the push fails with "Package doesn't contain
any assets", so this bumps each version note too.
"""
import datetime, json, os, re, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONN = os.path.join(HERE, '..', 'workspace-connections')

# Customer API: stamp the default value in the bank_app_url connection field
CUSTOMER_LINE = re.compile(
    r"(default: ')[^']*(' \}, # stamped before the workshop by scripts/stamp_bank_app_url\.py)"
)
# Support API: stamp the bank_app_url variable in the acquire lambda
SUPPORT_LINE = re.compile(
    r"(bank_app_url = ')[^']*(' # stamped before the workshop by scripts/stamp_bank_app_url\.py)"
)
SUPPORT_LINES = {
    'support_api_url': re.compile(
        r"(support_api_url = ')[^']*('\s*# stamped before the workshop by scripts/stamp_bank_app_url\.py)"
    ),
}

if len(sys.argv) != 2 or not re.match(r'^https://[^/\s]+(/[^\s]*)?$', sys.argv[1]):
    sys.exit('usage: python3 scripts/stamp_bank_app_url.py https://<bank app host>')
url = sys.argv[1].rstrip('/')

# Fetch config.json to validate the URL and to get supportApiUrl for the support connector
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
rb_customer = os.path.join(CONN, 'dewy_bank_customer_api.custom_adapter.rb')
rb_support  = os.path.join(CONN, 'dewy_bank_support_api.custom_adapter.rb')

if len(CUSTOMER_LINE.findall(open(rb_customer).read())) != 1:
    sys.exit(f'{rb_customer}: expected exactly one stampable bank_app_url default line')
if len(SUPPORT_LINE.findall(open(rb_support).read())) != 1:
    sys.exit(f'{rb_support}: expected exactly one stampable bank_app_url line')
if len(SUPPORT_LINES['support_api_url'].findall(open(rb_support).read())) != 1:
    sys.exit(f'{rb_support}: expected exactly one stampable support_api_url line')

# Stamp customer API: only the connection field default
code = open(rb_customer).read()
code = CUSTOMER_LINE.sub(lambda m: m.group(1) + url + m.group(2), code)
open(rb_customer, 'w').write(code)
meta_path = os.path.join(CONN, 'dewy_bank_customer_api.custom_adapter.json')
meta = json.load(open(meta_path))
meta['note'] = f'Stamped for {url} ({datetime.date.today().isoformat()})'
with open(meta_path, 'w') as f:
    json.dump(meta, f, indent=2, ensure_ascii=False)
    f.write('\n')

# Stamp support API: bank_app_url variable and support_api_url variable
code = open(rb_support).read()
code = SUPPORT_LINE.sub(lambda m: m.group(1) + url + m.group(2), code)
code = SUPPORT_LINES['support_api_url'].sub(
    lambda m: m.group(1) + config['supportApiUrl'] + m.group(2), code)
open(rb_support, 'w').write(code)
meta_path = os.path.join(CONN, 'dewy_bank_support_api.custom_adapter.json')
meta = json.load(open(meta_path))
meta['note'] = f'Stamped for {url} ({datetime.date.today().isoformat()})'
with open(meta_path, 'w') as f:
    json.dump(meta, f, indent=2, ensure_ascii=False)
    f.write('\n')

print(
    f'Stamped {url} into both connectors.\n'
    f'  Customer API: bank_app_url default set to {url}; reads AWS config from config.json at runtime.\n'
    f'  Support API:  bank_app_url and support_api_url stamped inline.\n'
    f'Push Workspace Connections next: wk push --folder "Workspace Connections"'
)
