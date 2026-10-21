"""Set up chat between the bank app and a participant's own Genies, then print the
one blob the participant pastes into the bank app's settings (P8).

Run once per participant, after pushing the project into their workspace:
    python3 scripts/setup_chat_clients.py -p <wk profile>

Safe to rerun. Each step finds what already exists before creating anything,
and a chat client's key can only be read when it's issued, so a rerun issues
new keys (the old ones stop working) and prints a fresh blob.

What it does, in the order the Headless API requires (verified 2026-10-20):
  1. find or create the participant's Workato Identity user, active, with no
     invitation email; its ID is what the bank app's proxy sends as X-IDP-User-Id;
  2. find or create the "Dewy Bank chat" user group and put the user in it;
  3. for each customer-facing Genie: assign the group, then (re)start the Genie
     (a Genie started before the assignment refuses chat until it's restarted);
  4. for each customer-facing Genie: find or create its API-key chat client,
     attach it, and issue a key.

Only the six customer-facing Genies get a client. C2's support Genie never does:
the bank app is the customer's app, and in C2 the support role is unreachable
from it. That's the fix.
"""
import argparse, json, subprocess, sys, urllib.error, urllib.parse, urllib.request

STATIONS = {  # station key in the bank app -> Genie name, as pushed
    'A1': 'Dewy Bank Assistant · A1 flaw',
    'A2': 'Dewy Bank Assistant · A2 fix',
    'B1': 'Dewy Bank Assistant · B1 flaw',
    'B2': 'Dewy Bank Assistant · B2 fix',
    'C1': 'Dewy Bank Assistant · C1 flaw',
    'C2': 'Dewy Bank Assistant · C2 fix',
}
GROUP_NAME = 'Dewy Bank chat'
CLIENT_NAME = 'Dewy Bank app · {station}'


def wk(profile, *args):
    """Run a wk command with --json and return its parsed output (or its text, for commands that print none)."""
    out = subprocess.run(['wk', *args, '-p', profile, '--json', '--no-input'], capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"wk {' '.join(args)} failed: {(out.stderr or out.stdout).strip()}")
    try:
        return json.loads(out.stdout) if out.stdout.strip() else None
    except json.JSONDecodeError:
        return out.stdout.strip()


def wk_items(profile, *args):
    """The items of a wk list (one page holds everything a workshop workspace has)."""
    d = wk(profile, *args)
    if d.get('has_next'):
        sys.exit(f"wk {' '.join(args)} has more than one page; this script expects a workshop workspace")
    return d.get('items', [])


class DeveloperAPI:
    """Workato's Developer API, for the Identity (IAM) calls that wk doesn't wrap."""

    def __init__(self, profile):
        self.base = wk(profile, 'auth', 'status')['base_url'].rstrip('/') + '/api'
        token = subprocess.run(['wk', 'auth', 'token', '-p', profile], capture_output=True, text=True)
        if token.returncode != 0 or not token.stdout.strip():
            sys.exit(f'could not read the API token for profile {profile}')
        self.token = token.stdout.strip()

    def call(self, method, path, body=None):
        req = urllib.request.Request(self.base + path, method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={'Authorization': f'Bearer {self.token}', 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req) as res:
                text = res.read().decode()
                return json.loads(text) if text else {}
        except urllib.error.HTTPError as e:
            sys.exit(f'{method} {path} failed: {e.code} {e.read().decode()[:300]}')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('-p', '--profile', required=True, help='wk profile for the participant\'s workspace')
    ap.add_argument('--email', help='Identity user email (default: the workspace owner\'s email)')
    ap.add_argument('--name', help='Identity user name (default: the workspace owner\'s name)')
    args = ap.parse_args()
    api = DeveloperAPI(args.profile)
    me = api.call('GET', '/users/me')
    email, name = args.email or me['email'], args.name or me['name']

    # 1. The Identity user (active, no invitation email).
    found = [u for u in api.call('GET', '/iam/users?query=' + urllib.parse.quote(email)).get('data', [])
             if u.get('email', '').lower() == email.lower()]
    if found:
        user_id = found[0]['id']
        print(f'Identity user: {email} ({found[0].get("status")})', file=sys.stderr)
    else:
        user_id = api.call('POST', '/iam/users', {'users': [{'email': email, 'name': name, 'state': 'active',
                                                             'send_invitation': False}]})['data'][0]['id']
        print(f'Identity user: {email} (created, active, no invitation sent)', file=sys.stderr)

    # 2. The chat group, with the user in it. (add_users, not users/:id/add_to_group, which doesn't add.)
    groups = [g for g in api.call('GET', '/iam/user_groups').get('data', []) if g.get('name') == GROUP_NAME]
    group_id = groups[0]['id'] if groups else api.call('POST', '/iam/user_groups', {'user_group': {'name': GROUP_NAME}})['data']['id']
    api.call('POST', f'/iam/user_groups/{group_id}/add_users', {'user_ids': [user_id]})
    print(f'User group: {GROUP_NAME} ({group_id})', file=sys.stderr)

    genies = {g['name']: g for g in wk_items(args.profile, 'agentic', 'genies', 'list')}
    missing = [n for n in STATIONS.values() if n not in genies]
    if missing:
        sys.exit('These Genies are missing; push the project first: ' + ', '.join(missing))
    clients = {c['client_name']: c for c in wk_items(args.profile, 'agentic', 'clients', 'list')}

    blob = {'version': 1, 'idp_user_id': user_id, 'stations': {}}
    for station, genie_name in STATIONS.items():
        genie = genies[genie_name]
        # 3. Assign the group, then (re)start the Genie so it picks the group up.
        wk(args.profile, 'agentic', 'genies', 'assign-user-groups', genie['id'], group_id)
        if genie.get('state') in ('started', 'active'):
            wk(args.profile, 'agentic', 'genies', 'stop', genie['id'])
        wk(args.profile, 'agentic', 'genies', 'start', genie['id'])
        # 4. The chat client and a fresh key (a key is only readable when it's issued).
        client_name = CLIENT_NAME.format(station=station)
        client = clients.get(client_name)
        if client:
            if genie['id'] not in (client.get('genie_ids') or []):
                wk(args.profile, 'agentic', 'clients', 'attach', genie['id'], client['client_id'])
            issued = wk(args.profile, 'agentic', 'clients', 'regenerate', client['client_id'])
        else:
            issued = wk(args.profile, 'agentic', 'clients', 'create', '--name', client_name, '--type', 'api_key')
            wk(args.profile, 'agentic', 'clients', 'attach', genie['id'], issued['client_id'])
        blob['genie_api_host'] = issued.get('base_host') or (client or {}).get('base_host') or blob.get('genie_api_host')
        blob['stations'][station] = {'genie_id': genie['id'], 'api_key': issued['api_key']}
        print(f'{station}: {genie_name} started, chat client "{client_name}" ready', file=sys.stderr)

    print('\nPaste this into the bank app (Settings > Chat). It contains your chat keys: '
          'keep it private, and run this script again if you lose it.\n', file=sys.stderr)
    print(json.dumps(blob, indent=2))


if __name__ == '__main__':
    main()
