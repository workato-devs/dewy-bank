"""Stamp a workshop's bank app URL and support API key into the Dewy Bank connectors.

Run once per workshop deployment, before participants clone:
    python3 scripts/stamp_bank_app_url.py https://<distribution>.cloudfront.net

The Customer API connector exposes bank_app_url and customer_api_url as stamped
connection fields; both defaults are written here. No AWS values are discovered at
runtime from config.json — only Cognito region and userPoolClientId are fetched from
config.json at auth time. The Support API connector has bank_app_url stamped as an
inline acquire variable (for a NOT_STAMPED guard), and support_api_url and
support_api_key both stamped as connection field defaults.

Support API key resolution order (first match wins):
  1. ``--support-api-key <value>`` CLI argument
  2. ``DEWY_SUPPORT_API_KEY`` environment variable
  3. Key already stamped in the .rb file — skip fetch (re-running as a participant)
  4. AWS SSM parameter /dewybank/demo01/support-api-key (requires AWS credentials;
     uses the 'admin-role' profile unless AWS_ACCESS_KEY_ID is set, region us-west-2)

Participants do not need to enter anything for either connector —
all values are pre-stamped by the facilitator.
Changing either connector's code also needs its .custom_adapter.json to change, or
the push fails with "Package doesn't contain any assets", so this bumps each version
note too.
"""
import argparse, datetime, ipaddress, json, os, re, socket, subprocess, sys, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))

def fetch_ssm_parameter(name, aws_profile='admin-role', region='us-west-2'):
    cmd = ['aws', 'ssm', 'get-parameter',
           '--name', name,
           '--with-decryption',
           '--query', 'Parameter.Value',
           '--output', 'text',
           '--region', region]
    if not os.environ.get('AWS_ACCESS_KEY_ID'):
        cmd += ['--profile', aws_profile]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f'Failed to fetch SSM parameter {name}: {result.stderr.strip()}')
    return result.stdout.strip()
CONN = os.path.join(HERE, '..', 'workspace-connections')

# Customer API: stamp the default value in the bank_app_url connection field
CUSTOMER_LINE = re.compile(
    r"(default: ')[^']*(' \}, # stamped before the workshop by scripts/stamp_bank_app_url\.py)"
)
# Customer API: stamp the default value in the customer_api_url connection field
CUSTOMER_API_URL_LINE = re.compile(
    r"(default: ')[^']*(' \}, # customer_api_url stamped before the workshop by scripts/stamp_bank_app_url\.py)"
)
# Support API: stamp the bank_app_url variable in the acquire lambda
SUPPORT_LINE = re.compile(
    r"(bank_app_url = ')[^']*(' # stamped before the workshop by scripts/stamp_bank_app_url\.py)"
)
# Support API: stamp the default value in the support_api_url connection field
SUPPORT_API_URL_LINE = re.compile(
    r"(default: ')[^']*(' \}, # support_api_url stamped before the workshop by scripts/stamp_bank_app_url\.py)"
)
SUPPORT_KEY_LINE = re.compile(
    r"(default: ')[^']*(' \}, # stamped before the workshop by scripts/stamp_bank_app_url\.py)"
)

ap = argparse.ArgumentParser(
    description='Stamp a workshop bank app URL and support API key into the Dewy Bank connectors.',
    formatter_class=argparse.RawDescriptionHelpFormatter,
    epilog=(
        'The support API key is resolved in this order:\n'
        '  1. --support-api-key argument\n'
        '  2. DEWY_SUPPORT_API_KEY environment variable\n'
        '  3. Key already stamped in the connector file (skip fetch)\n'
        '  4. AWS SSM parameter /dewybank/demo01/support-api-key (requires AWS credentials)\n'
    ),
)
ap.add_argument('url', metavar='URL',
                help='Bank app CloudFront URL, e.g. https://<dist>.cloudfront.net')
ap.add_argument('--support-api-key', metavar='KEY',
                help='Support API key (overrides DEWY_SUPPORT_API_KEY env var and SSM lookup)')
args = ap.parse_args()

if not re.match(r'^https://[^/\s]+(/[^\s]*)?$', args.url):
    ap.error('URL must start with https:// and contain no spaces')
if args.support_api_key is not None and not args.support_api_key.strip():
    ap.error('--support-api-key must not be empty')

url = args.url.rstrip('/')

# Validate URL scheme and hostname to prevent SSRF
_parsed = urllib.parse.urlparse(url)
if _parsed.scheme != 'https':
    sys.exit('Only https:// URLs are allowed.')
if not _parsed.hostname:
    sys.exit('Could not parse hostname from URL.')
try:
    _resolved_ip = socket.gethostbyname(_parsed.hostname)
    _ip = ipaddress.ip_address(_resolved_ip)
    if _ip.is_private or _ip.is_loopback or _ip.is_link_local or _ip.is_reserved:
        sys.exit(f'Hostname {_parsed.hostname} resolves to a private/reserved IP ({_resolved_ip}). Aborting.')
except socket.gaierror:
    sys.exit(f'Could not resolve hostname: {_parsed.hostname}')

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

# Resolve the support API key (priority: arg > env var > already stamped > SSM).
_key_m = re.search(
    r"default: '([^']*)' \}, # stamped before the workshop by scripts/stamp_bank_app_url\.py",
    open(rb_support).read(),
)
_current_key = _key_m.group(1) if _key_m else 'NOT_STAMPED'
if args.support_api_key:
    support_api_key = args.support_api_key
    print('Support API key provided via --support-api-key argument.')
elif os.environ.get('DEWY_SUPPORT_API_KEY'):
    support_api_key = os.environ['DEWY_SUPPORT_API_KEY']
    print('Support API key provided via DEWY_SUPPORT_API_KEY environment variable.')
elif 'NOT_STAMPED' not in _current_key and _current_key:
    support_api_key = _current_key
    print('Support API key already stamped — skipping SSM fetch.')
else:
    support_api_key = fetch_ssm_parameter('/dewybank/demo01/support-api-key')

if len(CUSTOMER_LINE.findall(open(rb_customer).read())) != 1:
    sys.exit(f'{rb_customer}: expected exactly one stampable bank_app_url default line')
if len(CUSTOMER_API_URL_LINE.findall(open(rb_customer).read())) != 1:
    sys.exit(f'{rb_customer}: expected exactly one stampable customer_api_url default line')
if len(SUPPORT_LINE.findall(open(rb_support).read())) != 1:
    sys.exit(f'{rb_support}: expected exactly one stampable bank_app_url line')
if len(SUPPORT_API_URL_LINE.findall(open(rb_support).read())) != 1:
    sys.exit(f'{rb_support}: expected exactly one stampable support_api_url line')
if len(SUPPORT_KEY_LINE.findall(open(rb_support).read())) != 1:
    sys.exit(f'{rb_support}: expected exactly one stampable support_api_key default line')

# Stamp customer API: only the connection field default
code = open(rb_customer).read()
code = CUSTOMER_LINE.sub(lambda m: m.group(1) + url + m.group(2), code)
code = CUSTOMER_API_URL_LINE.sub(lambda m: m.group(1) + config['customerApiUrl'] + m.group(2), code)
open(rb_customer, 'w').write(code)
meta_path = os.path.join(CONN, 'dewy_bank_customer_api.custom_adapter.json')
try:
    meta = json.load(open(meta_path))
except ValueError as e:
    sys.exit(f'Could not parse {meta_path}: {e}')
meta['note'] = f'Stamped for {url} ({datetime.date.today().isoformat()})'
with open(meta_path, 'w') as f:
    json.dump(meta, f, indent=2, ensure_ascii=False)
    f.write('\n')

# Stamp support API: bank_app_url variable and support_api_url connection field
code = open(rb_support).read()
code = SUPPORT_LINE.sub(lambda m: m.group(1) + url + m.group(2), code)
code = SUPPORT_API_URL_LINE.sub(
    lambda m: m.group(1) + config['supportApiUrl'] + m.group(2), code)
code = SUPPORT_KEY_LINE.sub(lambda m: m.group(1) + support_api_key + m.group(2), code)
open(rb_support, 'w').write(code)
meta_path = os.path.join(CONN, 'dewy_bank_support_api.custom_adapter.json')
try:
    meta = json.load(open(meta_path))
except ValueError as e:
    sys.exit(f'Could not parse {meta_path}: {e}')
meta['note'] = f'Stamped for {url} ({datetime.date.today().isoformat()})'
with open(meta_path, 'w') as f:
    json.dump(meta, f, indent=2, ensure_ascii=False)
    f.write('\n')

print(
    f'Stamped {url} into both connectors.\n'
    f'  Customer API: bank_app_url default set to {url}; customer_api_url default set to {config["customerApiUrl"]}.\n'
    f'  Support API:  bank_app_url stamped inline; support_api_url default set to {config["supportApiUrl"]}; support_api_key stamped.\n'
    f'Push Workspace Connections next: wk push --folder "Workspace Connections"'
)
