"""Push a full Workato deployment for one workshop participant.

This script is for WORKSHOP PARTICIPANTS only.

Provide the bank app CloudFront URL.  The script stamps the connector files
with the bank URL and public API endpoints (fetched from the app's
``config.json``), then runs the full Workato deployment.

The support API key can be supplied via ``--support-api-key`` or the
``DEWY_SUPPORT_API_KEY`` environment variable.  If neither is provided, the
script falls back to the key already stamped in the connector file (if a
facilitator pre-stamped it with AWS credentials) or to an AWS SSM lookup.

Requirements:
  - wk CLI installed and on your PATH
  - A wk auth profile linked to your Workato workspace
    (``wk auth login -p <profile>``)

Usage:
    python3 scripts/deploy_workato.py --bank-url <bank-url> --profile <wk-profile> [--dry-run]
    python3 scripts/deploy_workato.py --bank-url <bank-url> --support-api-key <key> --profile <wk-profile>

Steps performed (in order):
  1. Stamp bank URL and public API endpoints into the connector files.
  1a. Clear .wk/ state cache so wk treats every file as new on the next push.
  1b. Run `wk link` to reconnect the local project to the workspace and recreate
      any missing server folder structure (needed after deleting all assets).
  2. Push Workspace Connections so the connector is live with a fresh provider ID.
  2a. Ensure both connections exist in the workspace (creates shell connections via the
      REST API if wk push skipped them because they were already in its local hash cache).
  2b. Prompt the user to authenticate both connections in the Workato UI.
  3. Discover the new provider IDs via ``wk connectors list``.
  4. Rewrite provider IDs in station-a JSON files in-place.
  5. Rebuild station-b (reads GEN dynamically from station-a, gets new ID automatically).
  6. Rebuild station-c (customer tools pick up new ID from station-a; support ID fixed next).
  7. Fix station-c support connector IDs (SUPPORT_GEN is hardcoded in build_station_c.py).
  8. Push all three station folders (--skip-hooks to bypass recipe-lint).
  9. Start all skill recipes via the Workato REST API so genies can invoke them.
 10. Restore the working tree (git checkout).
 11. Run setup_mcp_servers.py and generate MCP chat config.
 12. Print next-steps instructions.
"""
import argparse, json, os, re, shutil, subprocess, sys, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))
STATION_A = os.path.join(ROOT, 'dewy-bank-station-a')
STATION_B = os.path.join(ROOT, 'dewy-bank-station-b')
STATION_C = os.path.join(ROOT, 'dewy-bank-station-c')
CUSTOMER_CONN_TITLE = 'Dewy Bank Customer API'
SUPPORT_CONN_TITLE  = 'Dewy Bank Support API'
CHAT_CONFIG_PATH = os.path.join(ROOT, 'mcp_conf.json')

# ---------------------------------------------------------------------------
# wk CLI helper (same pattern as setup_chat_clients.py)
# ---------------------------------------------------------------------------

def wk(profile, *args):
    """Run a wk command with --json --no-input and return parsed output."""
    out = subprocess.run(
        ['wk', *args, '-p', profile, '--json', '--no-input'],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        sys.exit(f"wk {' '.join(args)} failed: {(out.stderr or out.stdout).strip()}")
    try:
        return json.loads(out.stdout) if out.stdout.strip() else None
    except json.JSONDecodeError:
        return out.stdout.strip()


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

def _load_dotenv_value(*keys):
    """Return the first value found for any of *keys* in ROOT/.env, or None."""
    env_path = os.path.join(ROOT, '.env')
    if not os.path.exists(env_path):
        return None
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, _, v = line.partition('=')
            if k.strip() in keys:
                return v.strip().strip('"\'')
    return None


def _workato_api_base(base_url):
    """Return the REST API base URL for a given Workato app base URL.

    Regular US:  https://app.workato.com        ->  https://www.workato.com/api
    Trial/other: https://app.trial.workato.com  ->  https://app.trial.workato.com/api
    """
    base = base_url.rstrip('/')
    if base == 'https://app.workato.com':
        return 'https://www.workato.com/api'
    return base + '/api'


def _fetch_connection_statuses(api_base, api_token):
    """Return {connection_name: authorization_status} for all workspace connections.

    A name present in the dict means the connection exists (status may be None
    if unauthenticated).  A name absent from the dict means it doesn't exist at all.

    Calls GET /api/connections with a Bearer token.  Exits on HTTP or network errors.
    """
    url = f'{api_base}/connections'
    req = urllib.request.Request(url, headers={
        'Authorization': f'Bearer {api_token}',
        'Content-Type': 'application/json',
    })
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode()
        sys.exit(
            f'Workato API error {exc.code} fetching connections: {body}\n'
            'Check that WORKATO_API_TOKEN in .env is valid.'
        )
    except urllib.error.URLError as exc:
        sys.exit(f'Workato API network error: {exc.reason}')
    items = data.get('result', data) if isinstance(data, dict) else data
    return {c['name']: c.get('authorization_status') for c in items}


def _read_wk_folder_id(server_path_name):
    """Return the folder_id for the named [[sync]] entry from .wk/wk.toml, or None.

    wk link / wk push writes workspace-specific folder_id values into wk.toml.
    This reads the value for the given server_path so we can target the right
    Workato folder when creating connections via the REST API.
    """
    toml_path = os.path.join(ROOT, '.wk', 'wk.toml')
    if not os.path.exists(toml_path):
        return None
    current_block = {}
    in_sync = False
    with open(toml_path) as f:
        for line in f:
            line = line.strip()
            if line == '[[sync]]':
                if in_sync and current_block.get('server_path') == server_path_name:
                    return current_block.get('folder_id')
                current_block = {}
                in_sync = True
            elif in_sync and '=' in line and not line.startswith('#'):
                k, _, v = line.partition('=')
                k = k.strip()
                v = v.strip().strip("'\"")
                if k == 'folder_id':
                    try:
                        current_block[k] = int(v)
                    except ValueError:
                        pass
                elif k == 'server_path':
                    current_block[k] = v
    # Check the last [[sync]] block
    if in_sync and current_block.get('server_path') == server_path_name:
        return current_block.get('folder_id')
    return None


def _create_shell_connection(api_base, api_token, name, provider, folder_id):
    """Create a new unauthenticated (shell) connection via the Workato REST API.

    A shell connection exists in the workspace and can be found by recipes, but
    requires the user to authenticate it in the Workato UI before it can be used.
    """
    url = f'{api_base}/connections'
    payload = json.dumps({
        'name': name,
        'provider': provider,
        'folder_id': folder_id,
        'shell_connection': True,
    }).encode()
    req = urllib.request.Request(url, data=payload, method='POST', headers={
        'Authorization': f'Bearer {api_token}',
        'Content-Type': 'application/json',
    })
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode()
        sys.exit(f'Workato API error {exc.code} creating connection "{name}": {body}')
    except urllib.error.URLError as exc:
        sys.exit(f'Workato API network error creating connection "{name}": {exc.reason}')


def extract_old_gen():
    """Extract the customer API provider ID from station-a's list_my_accounts recipe."""
    recipe_path = os.path.join(STATION_A, 'shared', 'list_my_accounts.recipe.json')
    try:
        with open(recipe_path) as f:
            data = json.load(f)
    except FileNotFoundError:
        sys.exit(f'expected recipe not found: {recipe_path}')
    for entry in data.get('config', []):
        acct = entry.get('account_id')
        if isinstance(acct, dict) and acct.get('custom'):
            return entry['provider']
    sys.exit(f'could not find customer API provider ID in {recipe_path}')


def extract_old_support_gen():
    """Extract the support API provider ID from build_station_c.py's SUPPORT_GEN constant."""
    build_path = os.path.join(HERE, 'build', 'build_station_c.py')
    try:
        text = open(build_path).read()
    except FileNotFoundError:
        sys.exit(f'expected build script not found: {build_path}')
    m = re.search(r"SUPPORT_GEN\s*=\s*'([^']+)'", text)
    if not m:
        sys.exit(f'could not find SUPPORT_GEN in {build_path}')
    return m.group(1)


def remap_ids_in_folder(folder, old_id, new_id):
    """Replace old_id with new_id in all .recipe.json and .agentic_skill.json files.
    Only modifies files that actually contain old_id. No JSON round-trip —
    avoids key reordering and keeps diffs minimal.
    """
    count = 0
    for dirpath, _dirs, files in os.walk(folder):
        for fname in files:
            if not (fname.endswith('.recipe.json') or fname.endswith('.agentic_skill.json')):
                continue
            fpath = os.path.join(dirpath, fname)
            text = open(fpath).read()
            if old_id not in text:
                continue
            open(fpath, 'w').write(text.replace(old_id, new_id))
            count += 1
    return count


def run_build_script(script_name):
    """Run a build script from scripts/build/ as a subprocess."""
    result = subprocess.run(
        [sys.executable, os.path.join(HERE, 'build', script_name)],
        check=False, cwd=ROOT,
    )
    if result.returncode != 0:
        sys.exit(f'{script_name} failed (exit {result.returncode})')


def strip_wk_toml(repo_root):
    """Remove workspace-specific fields from .wk/wk.toml, leaving only neutral config.

    wk link and wk push write profile, email, workspace_id, folder_id and
    project_id into wk.toml.  After all server assets are deleted those IDs
    point at non-existent resources; wk push then fails to resolve folder paths.
    Stripping them before wk link lets wk create a fresh project from scratch.
    Called again at the end of the deploy so the committed file stays neutral.
    """
    toml_path = os.path.join(repo_root, '.wk', 'wk.toml')
    content = open(toml_path).read()
    # Remove lines that wk writes after link/push (workspace-specific)
    for key in ('profile', 'email', 'workspace_id', 'folder_id', 'project_id'):
        content = re.sub(rf'^{key}\s*=.*\n', '', content, flags=re.MULTILINE)
    open(toml_path, 'w').write(content)
    print('  stripped workspace-specific fields from .wk/wk.toml', file=sys.stderr)


def _clear_wk_state():
    """Delete .wk/ state subdirectories for every [[sync]] entry in wk.toml.

    Clearing the state forces wk to treat every tracked file as new on the
    next push, so it creates missing server folders from scratch instead of
    consulting a stale hash cache and silently skipping unchanged files.
    Preserves .wk/wk.toml and .wk/.gitignore.
    """
    wk_dir   = os.path.join(ROOT, '.wk')
    toml_path = os.path.join(wk_dir, 'wk.toml')
    local_paths: list = []
    if os.path.exists(toml_path):
        with open(toml_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith('local_path') and '=' in line:
                    _, _, v = line.partition('=')
                    local_paths.append(v.strip().strip("'\""))
    for lp in local_paths:
        state_dir = os.path.join(wk_dir, lp)
        if os.path.isdir(state_dir):
            shutil.rmtree(state_dir)
            print(f'  cleared .wk/{lp}/', file=sys.stderr)


def _collect_skill_recipe_names():
    """Scan station folders for .agentic_skill.json files and return a set of recipe names.

    Each .agentic_skill.json contains a ``references.recipe_id.id.name`` field that
    gives the recipe name used when the skill is pushed to Workato.  We collect all
    such names so we can start the matching server-side recipes after pushing.
    """
    names: set = set()
    for station_dir in (STATION_A, STATION_B, STATION_C):
        for dirpath, _dirs, files in os.walk(station_dir):
            for fname in files:
                if not fname.endswith('.agentic_skill.json'):
                    continue
                fpath = os.path.join(dirpath, fname)
                try:
                    with open(fpath) as f:
                        data = json.load(f)
                    # Top-level "name" is the recipe/skill name as deployed to Workato
                    recipe_name = data.get('name')
                    if recipe_name:
                        names.add(recipe_name)
                except (json.JSONDecodeError, KeyError, OSError):
                    pass
    return names


def _start_skill_recipes(api_base, api_token, skill_recipe_names):
    """List all workspace recipes via the REST API and start any that are skills.

    ``skill_recipe_names`` is the set returned by ``_collect_skill_recipe_names()``.
    Errors per recipe are logged as warnings so one failure does not abort the deploy.

    Returns ``(started_count, error_count)``.
    """
    url = f'{api_base}/recipes?per_page=100'
    req = urllib.request.Request(url, headers={
        'Authorization': f'Bearer {api_token}',
        'Content-Type': 'application/json',
    })
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode()
        print(
            f'  WARNING: Workato API error {exc.code} listing recipes: {body[:200]}',
            file=sys.stderr,
        )
        return 0, 1
    except urllib.error.URLError as exc:
        print(f'  WARNING: Workato API network error listing recipes: {exc.reason}', file=sys.stderr)
        return 0, 1

    # The Workato REST API returns {"items": [...], "count": N, "page": 1, "per_page": 100}.
    # Older API versions used "result"; fall back for compatibility.
    items = (data.get('items') or data.get('result') or data) if isinstance(data, dict) else data

    started = 0
    errors = 0
    for recipe in items:
        if not isinstance(recipe, dict):
            continue
        if recipe.get('name') not in skill_recipe_names:
            continue
        recipe_id   = recipe.get('id')
        recipe_name = recipe.get('name')
        if recipe.get('running'):
            started += 1
            continue
        start_req = urllib.request.Request(
            f'{api_base}/recipes/{recipe_id}/start',
            method='PUT',
            headers={
                'Authorization': f'Bearer {api_token}',
                'Content-Type': 'application/json',
            },
        )
        try:
            with urllib.request.urlopen(start_req) as resp:
                resp.read()
            started += 1
        except urllib.error.HTTPError as exc:
            body = exc.read().decode()
            print(
                f'  WARNING: could not start skill "{recipe_name}" (id={recipe_id}):'
                f' {exc.code} {body[:200]}',
                file=sys.stderr,
            )
            errors += 1
        except urllib.error.URLError as exc:
            print(
                f'  WARNING: network error starting skill "{recipe_name}" (id={recipe_id}):'
                f' {exc.reason}',
                file=sys.stderr,
            )
            errors += 1

    return started, errors


def _push_summary(result):
    """Return 'N created, M updated, K unchanged' from a wk push --json result.

    wk push --json returns {"import_results": [{"file_path": "...", "action": "..."}, ...], ...}.
    This tallies the action field across all entries so the caller can print a
    human-readable count instead of just 'done'.
    """
    if not isinstance(result, dict):
        return 'done'
    items = result.get('import_results', [])
    if not items:
        return 'done'
    counts: dict = {}
    for item in items:
        if isinstance(item, dict):
            action = item.get('action', 'unknown')
            counts[action] = counts.get(action, 0) + 1
    # Print in a consistent, readable order; skip zero-count actions.
    order = ['created', 'updated', 'deleted', 'unchanged', 'failed', 'unknown']
    parts = [f'{counts[k]} {k}' for k in order if counts.get(k)]
    for k, v in counts.items():
        if k not in order:
            parts.append(f'{v} {k}')
    return ', '.join(parts) if parts else 'done'


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        description='Deploy Workato assets for a workshop participant.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            'Examples:\n'
            '  python3 scripts/deploy_workato.py --bank-url https://<dist>.cloudfront.net -p MyProfile --dry-run\n'
            '  python3 scripts/deploy_workato.py --bank-url https://<dist>.cloudfront.net -p MyProfile\n'
            '\n'
            'The bank URL can also be set in .env as BANK_APP_URL or SPA_URL.\n'
            '\n'
            'The support API key can be supplied via --support-api-key or DEWY_SUPPORT_API_KEY.\n'
            'Without either, the script falls back to the key already stamped in the connector\n'
            'file (if a facilitator pre-stamped it) or to an AWS SSM lookup.\n'
        ),
    )
    ap.add_argument('--bank-url',
                    help='Bank app CloudFront URL (or set BANK_APP_URL / SPA_URL in .env)')
    ap.add_argument('--support-api-key', metavar='KEY',
                    help='Support API key (forwarded to stamp_bank_app_url.py; '
                         'overrides DEWY_SUPPORT_API_KEY env var and SSM lookup)')
    ap.add_argument('-p', '--profile', required=True, help='wk auth profile name')
    ap.add_argument('--dry-run', action='store_true',
                    help='print what would happen without making any changes')
    args = ap.parse_args()
    profile  = args.profile
    dry_run  = args.dry_run

    bank_url = args.bank_url
    if not bank_url:
        bank_url = (os.environ.get('BANK_APP_URL')
                    or os.environ.get('SPA_URL')
                    or _load_dotenv_value('BANK_APP_URL', 'SPA_URL'))
    if not bank_url:
        ap.error('--bank-url is required (or set BANK_APP_URL or SPA_URL in .env)')

    # ------------------------------------------------------------------
    # Pre-flight checks
    # ------------------------------------------------------------------
    print('Pre-flight checks...', file=sys.stderr)

    # Profile / workspace reachable
    status = wk(profile, 'auth', 'status')
    if not status or not status.get('connected'):
        sys.exit(f'wk profile "{profile}" is not connected. Run: wk auth login -p {profile}')
    print(f'  workspace : {status["workspace"]} ({status["region"]})', file=sys.stderr)

    # ------------------------------------------------------------------
    # Dry-run: print plan and exit
    # ------------------------------------------------------------------
    if dry_run:
        print('\nDRY RUN — no changes will be made.\n', file=sys.stderr)
        steps = [
            '1. Stamp connector files: python3 scripts/stamp_bank_app_url.py ' + bank_url
            + (' --support-api-key <key>' if args.support_api_key else ''),
            'wk link: wk link --profile ' + profile + ' --no-input (reconnect workspace, recreate server folder structure)',
            '2. Push Workspace Connections: wk push --skip-hooks -p ' + profile + ' (all sync entries; state cache cleared and workspace relinked before this)',
            '2a. Ensure connections exist (POST /api/connections if missing) via WORKATO_API_TOKEN',
            '2b. Verify connections authenticated via Workato REST API (WORKATO_API_TOKEN)',
            '3. Discover new connector provider IDs: wk connectors list -p ' + profile,
            '4. Rewrite provider IDs in station-a JSON files in-place',
            '5. Rebuild station-b: python3 scripts/build/build_station_b.py',
            '6. Rebuild station-c: python3 scripts/build/build_station_c.py',
            '7. Fix station-c support connector IDs in-place',
            '8. Push station folders (remapped IDs): wk push --skip-hooks -p ' + profile,
            '9. Start skill recipes: PUT /api/recipes/<id>/start for each skill (WORKATO_API_TOKEN)',
            '10. Restore working tree: git checkout -- dewy-bank-station-a/ dewy-bank-station-b/ dewy-bank-station-c/',
            '11. Run setup_mcp_servers.py (generates mcp_conf.json)',
            '12. Print next-steps instructions',
        ]
        for s in steps:
            print(f'  {s}', file=sys.stderr)
        print('', file=sys.stderr)
        sys.exit(0)

    # ------------------------------------------------------------------
    # Step 0 — extract old IDs before any file changes
    # ------------------------------------------------------------------
    old_gen         = extract_old_gen()
    old_support_gen = extract_old_support_gen()
    print(f'  customer API old ID : {old_gen}', file=sys.stderr)
    print(f'  support  API old ID : {old_support_gen}', file=sys.stderr)

    # ------------------------------------------------------------------
    # Clear .wk/ state cache before any push
    # Clears hash-cache directories so wk treats every file as new and
    # creates missing server folders from scratch on the next push, instead
    # of consulting a stale cache and failing with "folder not found".
    # ------------------------------------------------------------------
    print('\nClearing .wk/ state cache...', file=sys.stderr)
    _clear_wk_state()
    strip_wk_toml(ROOT)

    # ------------------------------------------------------------------
    # Step 1 — stamp connector files
    # ------------------------------------------------------------------
    print('\nStep 1: stamping connector files...', file=sys.stderr)
    stamp_cmd = [sys.executable, os.path.join(HERE, 'stamp_bank_app_url.py'), bank_url]
    if args.support_api_key:
        stamp_cmd += ['--support-api-key', args.support_api_key]
    result = subprocess.run(stamp_cmd, check=False, cwd=ROOT)
    if result.returncode != 0:
        sys.exit('stamp_bank_app_url.py failed (see output above)')
    print('  done', file=sys.stderr)

    # ------------------------------------------------------------------
    # wk link — reconnect local project to workspace before the first push.
    #
    # When all Workato assets have been deleted the server folder structure
    # ("Workspace Connections", "Dewy Bank Station A", …) no longer exists,
    # and the folder_id / project_id values in .wk/wk.toml point at IDs that
    # are gone.  wk push resolves folders by those IDs first; it only falls
    # back to auto-creating a folder when there is no ID in wk.toml.  Running
    # wk link refreshes the workspace binding and (re)creates the server folder
    # structure so the subsequent push succeeds.
    # ------------------------------------------------------------------
    print('\nLinking workspace (recreating server folder structure)...', file=sys.stderr)
    link_result = subprocess.run(
        ['wk', 'link', '--profile', profile, '--no-input'],
        capture_output=True, text=True, cwd=ROOT,
    )
    if link_result.returncode != 0:
        sys.exit(f'wk link failed: {(link_result.stderr or link_result.stdout).strip()}')
    print('  done', file=sys.stderr)

    # ------------------------------------------------------------------
    # Step 2 — push Workspace Connections (and all other sync entries)
    # .wk/ state was cleared above and wk link has recreated the server
    # folder structure, so wk push can resolve all folders cleanly.
    # All sync entries are pushed in wk.toml order (Workspace Connections
    # first) without --folder or --force.  The station folders are pushed
    # here with the original provider IDs; step 8 re-pushes them after the
    # IDs have been remapped in steps 4–7.
    # ------------------------------------------------------------------
    print('\nStep 2: pushing Workspace Connections...', file=sys.stderr)
    result = wk(profile, 'push', '--skip-hooks')
    print(f'  {_push_summary(result)}', file=sys.stderr)

    # Discover connector IDs right after push — needed both for step 2a (creating
    # connections via the REST API) and for step 3 (remapping provider IDs).
    # Results are reported in the Step 3 block below.
    connectors = {c['title']: c['name'] for c in wk(profile, 'connectors', 'list')}
    new_gen         = connectors.get(CUSTOMER_CONN_TITLE)
    new_support_gen = connectors.get(SUPPORT_CONN_TITLE)
    if not new_gen:
        sys.exit(
            f'connector "{CUSTOMER_CONN_TITLE}" not found after push. '
            'Check that workspace-connections pushed cleanly.'
        )
    if not new_support_gen:
        sys.exit(
            f'connector "{SUPPORT_CONN_TITLE}" not found after push. '
            'Check that workspace-connections pushed cleanly and that '
            'the Support API connector is present in workspace-connections/.'
        )

    # ------------------------------------------------------------------
    # Step 2a — ensure connections exist
    #
    # wk push tracks file hashes in .wk/<folder>/*.meta.json.  If connections
    # were manually deleted from the Workato workspace, the hashes still match
    # and wk reports the files as "unchanged" — it never re-creates the
    # connection objects.  This step fills that gap by creating each missing
    # connection as a shell (unauthenticated) connection via the REST API.
    # Step 2b then prompts the user to authenticate them.
    # ------------------------------------------------------------------
    api_token = (os.environ.get('WORKATO_API_TOKEN')
                 or _load_dotenv_value('WORKATO_API_TOKEN'))
    app_base_url = status.get('base_url', 'https://app.workato.com').rstrip('/')
    api_base     = _workato_api_base(app_base_url)

    if not api_token:
        print(
            '\n  WARNING: WORKATO_API_TOKEN not set in .env — '
            'skipping connection creation and auth check.\n'
            f'  Create "{CUSTOMER_CONN_TITLE}" and "{SUPPORT_CONN_TITLE}" '
            f'connections manually at {app_base_url}/connections before continuing.',
            file=sys.stderr,
        )
        conn_statuses = {}
    else:
        print('\nStep 2a: ensuring connections exist...', file=sys.stderr)
        conn_statuses = _fetch_connection_statuses(api_base, api_token)

        folder_id = _read_wk_folder_id('Workspace Connections')
        if folder_id is None:
            sys.exit(
                'Cannot determine folder_id for "Workspace Connections" from .wk/wk.toml.\n'
                'Run `wk link -p <profile>` first to populate workspace IDs, then re-run.'
            )

        created = []
        for conn_name, provider_id in (
            (CUSTOMER_CONN_TITLE, new_gen),
            (SUPPORT_CONN_TITLE,  new_support_gen),
        ):
            if conn_name not in conn_statuses:
                print(f'  creating shell connection: {conn_name!r}', file=sys.stderr)
                _create_shell_connection(api_base, api_token, conn_name, provider_id, folder_id)
                created.append(conn_name)
            else:
                print(f'  {conn_name!r}: already exists', file=sys.stderr)

        if created:
            # Re-fetch so conn_statuses reflects the newly created connections.
            conn_statuses = _fetch_connection_statuses(api_base, api_token)
        print('  done', file=sys.stderr)

    # ------------------------------------------------------------------
    # Step 2b — verify connections are authenticated
    # ------------------------------------------------------------------
    if api_token:
        customer_status  = conn_statuses.get(CUSTOMER_CONN_TITLE)
        support_status   = conn_statuses.get(SUPPORT_CONN_TITLE)
        both_ok          = (customer_status == 'success' and support_status == 'success')

        if both_ok:
            print('\nStep 2b: connections already authenticated ✓', file=sys.stderr)
        else:
            lines = ['\nStep 2b: connections need authentication']
            lines.append(f'  Go to: {app_base_url}/connections')
            lines.append('  Authenticate:')
            if customer_status != 'success':
                lines.append(
                    f'    • {CUSTOMER_CONN_TITLE} — use your bank app URL + email + password'
                    f' (current status: {customer_status!r})'
                )
            if support_status != 'success':
                lines.append(
                    f'    • {SUPPORT_CONN_TITLE} — key is pre-stamped, just click Connect'
                    f' (current status: {support_status!r})'
                )
            lines.append('  Press Enter when both connections show status: Connected...')
            print('\n'.join(lines), file=sys.stderr)

            try:
                input()
            except EOFError:
                # Non-interactive environment: can't prompt — treat as unrecoverable.
                sys.exit(
                    'Running non-interactively; cannot wait for connections to be authenticated.\n'
                    f'Authenticate both connections at {app_base_url}/connections and re-run.'
                )

            # Re-check after user input
            conn_statuses   = _fetch_connection_statuses(api_base, api_token)
            customer_status = conn_statuses.get(CUSTOMER_CONN_TITLE)
            support_status  = conn_statuses.get(SUPPORT_CONN_TITLE)

            if customer_status != 'success' or support_status != 'success':
                errors = []
                if customer_status != 'success':
                    errors.append(
                        f'  • {CUSTOMER_CONN_TITLE}: status={customer_status!r}'
                    )
                if support_status != 'success':
                    errors.append(
                        f'  • {SUPPORT_CONN_TITLE}: status={support_status!r}'
                    )
                sys.exit(
                    'Connections still not authenticated after re-check:\n'
                    + '\n'.join(errors)
                    + f'\nRe-run the script after authenticating both connections at {app_base_url}/connections'
                )
            print('  connections: authenticated ✓', file=sys.stderr)

    # ------------------------------------------------------------------
    # Step 3 — report discovered provider IDs (fetched after step 2 above)
    # ------------------------------------------------------------------
    print('\nStep 3: discovering new connector provider IDs...', file=sys.stderr)
    print(f'  customer API new ID : {new_gen}', file=sys.stderr)
    print(f'  support  API new ID : {new_support_gen}', file=sys.stderr)

    # Idempotency check: if both IDs already match, the remap is a no-op but we
    # still push (wk push is idempotent; unchanged files are skipped).
    if old_gen == new_gen and old_support_gen == new_support_gen:
        print('  provider IDs already match the target workspace — remap will be a no-op',
              file=sys.stderr)

    # Collect skill recipe names now, before any file modifications, so the scan
    # always reads committed content regardless of what the try block rewrites.
    skill_recipe_names = _collect_skill_recipe_names()

    # ------------------------------------------------------------------
    # Steps 4-9 in try / step 10 in finally so the working tree is ALWAYS
    # restored, even if a push, build, or skill-start step fails mid-way.
    # ------------------------------------------------------------------
    try:
        # Step 4 — remap station-a in-place
        print('\nStep 4: remapping station-a provider IDs...', file=sys.stderr)
        n = remap_ids_in_folder(STATION_A, old_gen, new_gen)
        print(f'  {n} file(s) updated', file=sys.stderr)

        # Step 5 — rebuild station-b
        # build_station_b.py reads GEN dynamically from station-a, so it picks
        # up the new customer ID automatically.
        print('\nStep 5: rebuilding station-b...', file=sys.stderr)
        run_build_script('build_station_b.py')
        print('  done', file=sys.stderr)

        # Step 6 — rebuild station-c
        # Customer tools inherit the new customer ID from station-a.
        # SUPPORT_GEN is still the old hardcoded value at this point — fixed in step 7.
        print('\nStep 6: rebuilding station-c...', file=sys.stderr)
        run_build_script('build_station_c.py')
        print('  done', file=sys.stderr)

        # Step 7 — fix station-c support connector IDs
        print('\nStep 7: remapping station-c support connector IDs...', file=sys.stderr)
        n = remap_ids_in_folder(STATION_C, old_support_gen, new_support_gen)
        print(f'  {n} file(s) updated', file=sys.stderr)

        # Step 8 — push all sync entries so remapped station files reach the server
        # .wk/ state reflects the step-2 push, so only files whose content
        # changed (i.e. the remapped provider-ID references) are uploaded again.
        # Workspace Connections files are unchanged and will be skipped.
        # --skip-hooks bypasses the pre-push recipe-lint hook, which requires the
        # recipe-skills checkout (not present in a participant workspace).
        # Note: wk push may report some files as "deleted" for connector adapter
        # files tracked in .wk state from a prior pull; per AGENTS.md rule 6,
        # the server assets remain — this is expected behavior.
        print('\nStep 8: pushing station folders (remapped provider IDs)...', file=sys.stderr)
        result = wk(profile, 'push', '--skip-hooks')
        print(f'  {_push_summary(result)}', file=sys.stderr)

        # Step 9 — start skill recipes
        # Skills must be running before genies can invoke them.  We start them
        # here, before setup_chat_clients.py starts the genies, so the genies
        # find their backing recipes live from the first conversation.
        print('\nStep 9: starting skill recipes...', file=sys.stderr)
        if not api_token:
            print(
                '  WARNING: WORKATO_API_TOKEN not set — skipping skill start.\n'
                '  Start skill recipes manually before running setup_chat_clients.py.',
                file=sys.stderr,
            )
        else:
            started_count, error_count = _start_skill_recipes(api_base, api_token, skill_recipe_names)
            msg = f'{started_count} skill(s) started'
            if error_count:
                msg += f', {error_count} error(s) (see warnings above)'
            print(f'  {msg}', file=sys.stderr)

    finally:
        # Step 10 — restore the working tree regardless of success or failure
        print('\nStep 10: restoring working tree...', file=sys.stderr)
        try:
            subprocess.run(
                ['git', 'checkout', '--',
                 'dewy-bank-station-a/', 'dewy-bank-station-b/', 'dewy-bank-station-c/'],
                check=True, cwd=ROOT,
            )
            print('  working tree restored', file=sys.stderr)
        except subprocess.CalledProcessError as e:
            # Don't hard-exit: the push already succeeded. Warn so the user can restore manually.
            print(
                f'  WARNING: git checkout failed ({e}). Restore manually:\n'
                '    git checkout -- dewy-bank-station-a/ dewy-bank-station-b/ dewy-bank-station-c/',
                file=sys.stderr,
            )

    # ------------------------------------------------------------------
    # Step 11 — run setup_mcp_servers.py (Zayne's script: creates/updates Workato MCP servers)
    # ------------------------------------------------------------------
    print('\nStep 11: setting up MCP servers in Workato...', file=sys.stderr)
    result = subprocess.run(
        [sys.executable, os.path.join(HERE, 'setup_mcp_servers.py'), '-p', args.profile],
        check=False, cwd=ROOT,
    )
    if result.returncode != 0:
        sys.exit('setup_mcp_servers.py failed (see output above)')

    # ------------------------------------------------------------------
    # Step 12 — next-steps instructions
    # ------------------------------------------------------------------
    base_url = status.get('base_url', 'https://app.workato.com').rstrip('/')
    print(f'''
─────────────────────────────────────────────────────────────────
Deployment complete.

One manual step remains:
  Open the bank app chat widget, click the \u2699 Config button, and paste
  the JSON that was printed above (also saved to {CHAT_CONFIG_PATH}).
─────────────────────────────────────────────────────────────────''', file=sys.stderr)

    # Strip workspace-specific fields written by wk push/link so the committed
    # wk.toml stays workspace-neutral (AGENTS.md rule 7).
    strip_wk_toml(ROOT)


if __name__ == '__main__':
    main()
