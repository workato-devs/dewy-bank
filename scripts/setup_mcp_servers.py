"""Set up each station's MCP servers in a participant's workspace, then print the
blob the participant fills in and pastes into the bank app's settings.

Run once per participant, after pushing the project and starting the recipes:
    python3 scripts/setup_mcp_servers.py -p <wk profile>

Safe to rerun: it finds each server by name, changes only what differs from
docs/station-*/mcp-servers.md, and never renews a token. With --dry-run it only
says what it would change.

What it does:
  1. read each station's mcp-servers.md: every server's name, bank app key,
     tools (<subfolder>/<skill> inside the station folder) and description;
  2. find each station's folder and each tool's skill in the workspace;
  3. find or create each server in its station's folder, and update its
     description if it differs;
  4. make each server's tools exactly the table's: add the missing ones, remove
     the rest. Tools are added through the Developer API, because wk's
     `--recipe` sends the recipe ID where the API wants the skill's handle
     ("invalid asset(s): workato_skill ID", 2026-10-22);
  5. check that each tool's description is its skill's trigger_description
     (Workato copies it when the tool is added; the recipe description, which
     names the variant, must never reach the model).

Servers use hashed_token auth, the only token type the API accepts besides
workato_idp (2026-10-22), and Workato never returns a hashed token. So the blob
holds a placeholder per station: the participant copies each server's URL, with
its token, from the server's page in Workato.
"""
import argparse, glob, json, os, re, subprocess, sys, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')
TOOL = re.compile(r'`([\w-]+)/(\w+)`')
DESCRIPTION = re.compile(r'<!-- description ([^>]+?) -->\n(.*?)\n<!-- /description -->', re.S)


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
    """Every item of a wk list, page by page when the list pages (skills list 20 at a time)."""
    d = wk(profile, *args)
    if isinstance(d, list):
        return d
    items, page = d.get('items', []), d.get('page') or 1
    while d.get('has_next'):
        page += 1
        d = wk(profile, *args, '--page', str(page))
        items += d.get('items', [])
    return items


class DeveloperAPI:
    """Workato's Developer API, for the tool assignment that wk gets wrong."""

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


def read_servers():
    """Every server in docs/station-*/mcp-servers.md, in station order."""
    servers = []
    for path in sorted(glob.glob(os.path.join(ROOT, 'docs', 'station-*', 'mcp-servers.md'))):
        station = path.split(os.sep)[-2][-1]
        text = open(path).read()
        descriptions = {}
        for names, body in DESCRIPTION.findall(text):
            for name in names.split():
                descriptions[name.replace('_', ' ')] = body.strip()
        for line in text.splitlines():
            m = re.match(r'\| `(Station[^`]+)` \| *(\w*) *\| (.+) \|$', line)
            if not m:
                continue
            name, key, tools = m.groups()
            if name not in descriptions:
                sys.exit(f'{path}: no description for {name}')
            servers.append({'name': name, 'key': key, 'station': station, 'tools': TOOL.findall(tools),
                            'description': descriptions[name]})
    if not servers:
        sys.exit('no servers found in docs/station-*/mcp-servers.md')
    return servers


def find_folder(profile, name, parent=None):
    """The ID of the folder called `name`, searched breadth-first from `parent` (the workspace root by default)."""
    queue, found = [parent], []
    while queue:
        p = queue.pop(0)
        for f in wk_items(profile, 'folders', 'list', *(['--parent', str(p)] if p else [])):
            if f['name'] == name:
                found.append(f['id'])
            queue.append(f['id'])
    if len(found) != 1:
        sys.exit(f'expected one folder named "{name}", found {len(found)}; push the project first')
    return found[0]


def skill_file(station, subfolder, name):
    path = os.path.join(ROOT, f'dewy-bank-station-{station}', subfolder, f'{name}.agentic_skill.json')
    with open(path) as f:
        return json.load(f)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('-p', '--profile', required=True, help='wk profile for the participant\'s workspace')
    ap.add_argument('--dry-run', action='store_true', help='say what would change, change nothing')
    args = ap.parse_args()
    would = 'would be ' if args.dry_run else ''
    api = DeveloperAPI(args.profile)
    servers = read_servers()

    # 2. Station folders, their subfolders, and every skill by (folder ID, name).
    folders = {}
    for station in sorted({s['station'] for s in servers}):
        top = find_folder(args.profile, f'Dewy Bank Station {station.upper()}')
        folders[station] = (top, {f['name']: f['id'] for f in wk_items(args.profile, 'folders', 'list', '--parent', str(top))})
    skills = {(s['folder_id'], s['name']): s['id'] for s in wk_items(args.profile, 'agentic', 'skills', 'list')}
    recipe_of = {}  # skill handle -> its recipe ID (an MCP tool's flow_id)

    existing = {s['name']: s for s in wk_items(args.profile, 'mcp', 'servers', 'list')}
    blob = {'version': 2, 'stations': {}}
    for server in servers:
        top, subfolders = folders[server['station']]
        wanted = {}
        for sub, name in server['tools']:
            handle = skills.get((subfolders.get(sub), name))
            if not handle:
                sys.exit(f"{server['name']}: no skill {sub}/{name} in Dewy Bank Station {server['station'].upper()}; push the project first")
            if handle not in recipe_of:
                recipe_of[handle] = wk(args.profile, 'agentic', 'skills', 'get', handle)['provider_id']
            wanted[recipe_of[handle]] = (handle, sub, name)

        # 3. The server, in its station's folder, with its description.
        current = existing.get(server['name'])
        if not current:
            print(f"{server['name']}: {would}created, with {len(wanted)} tools", file=sys.stderr)
            if args.dry_run:
                continue
            current = wk(args.profile, 'mcp', 'servers', 'create', '--name', server['name'], '--folder-id', str(top),
                         '--description', server['description'])
        elif current.get('description', '') != server['description'] or current.get('folder_id') != top:
            what = ' and '.join(w for w, differs in (('description', current.get('description', '') != server['description']),
                                                      ('folder', current.get('folder_id') != top)) if differs)
            print(f"{server['name']}: {what} {would}updated", file=sys.stderr)
            if not args.dry_run:
                wk(args.profile, 'mcp', 'servers', 'update', current['id'], '--description', server['description'],
                   '--folder-id', str(top))

        # 4. Exactly the table's tools.
        tools = wk_items(args.profile, 'mcp', 'servers', 'tools', 'list', current['id'])
        for t in tools:
            if t['flow_id'] not in wanted:
                print(f"{server['name']}: {t['name']} (recipe {t['flow_id']}) {would}removed", file=sys.stderr)
                if not args.dry_run:
                    wk(args.profile, 'mcp', 'servers', 'tools', 'remove', current['id'], '--tool', str(t['id']))
        missing = [h for r, (h, _, _) in wanted.items() if r not in {t['flow_id'] for t in tools}]
        if missing:
            print(f"{server['name']}: {len(missing)} tool(s) {would}added", file=sys.stderr)
        if missing and not args.dry_run:
            api.call('POST', f"/mcp/mcp_servers/{current['id']}/assign_tools",
                     {'tools': [{'trigger_application': 'workato_skill', 'id': h} for h in missing]})

        if args.dry_run:
            continue
        # 5. What the model sees: the table's tools, each described by its skill's trigger_description.
        tools = {t['flow_id']: t for t in wk_items(args.profile, 'mcp', 'servers', 'tools', 'list', current['id'])}
        problems = []
        for recipe, (_, sub, name) in wanted.items():
            t = tools.get(recipe)
            if not t:
                problems.append(f'{sub}/{name} is missing')
            elif t['description'] != skill_file(server['station'], sub, name)['trigger_description']:
                problems.append(f"{name}'s description isn't its skill's trigger_description")
        if len(tools) != len(wanted):
            problems.append(f'{len(tools)} tools, expected {len(wanted)}')
        if problems:
            sys.exit(f"{server['name']}: " + '; '.join(problems))
        print(f"{server['name']}: {len(tools)} tools, as specified", file=sys.stderr)

        if server['key']:
            blob['stations'][server['key']] = {'server': server['name'],
                                               'mcp_url': f"<paste {server['name']}'s URL, with its token>"}

    if args.dry_run:
        return
    print('\nIn Workato, open each server named below, copy its URL with its token from the server\'s page, '
          'and paste it over the placeholder. Then paste the blob into the bank app (Settings > Chat). '
          'The URLs are your credentials: keep the blob private.\n', file=sys.stderr)
    print(json.dumps(blob, indent=2))


if __name__ == '__main__':
    main()
