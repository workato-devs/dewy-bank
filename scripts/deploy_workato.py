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
  2. Push Workspace Connections so the connector is live with a fresh provider ID.
  3. Discover the new provider IDs via ``wk connectors list``.
  4. Rewrite provider IDs in station-a JSON files in-place.
  5. Rebuild station-b (reads GEN dynamically from station-a, gets new ID automatically).
  6. Rebuild station-c (customer tools pick up new ID from station-a; support ID fixed next).
  7. Fix station-c support connector IDs (SUPPORT_GEN is hardcoded in build_station_c.py).
  8. Push all three station folders (--skip-hooks to bypass recipe-lint).
  9. Restore the working tree (git checkout).
 10. Run setup_chat_clients.py and save the JSON blob.
 11. Print next-steps instructions.
"""
import argparse, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))
STATION_A = os.path.join(ROOT, 'dewy-bank-station-a')
STATION_B = os.path.join(ROOT, 'dewy-bank-station-b')
STATION_C = os.path.join(ROOT, 'dewy-bank-station-c')
CUSTOMER_CONN_TITLE = 'Dewy Bank Customer API'
SUPPORT_CONN_TITLE  = 'Dewy Bank Support API'
CHAT_CONFIG_PATH = os.path.join(ROOT, '.agents', 'tasks', 'chat-config.json')

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
            '2. Push Workspace Connections: wk push --folder "Workspace Connections" -p ' + profile,
            '3. Discover new connector provider IDs: wk connectors list -p ' + profile,
            '4. Rewrite provider IDs in station-a JSON files in-place',
            '5. Rebuild station-b: python3 scripts/build/build_station_b.py',
            '6. Rebuild station-c: python3 scripts/build/build_station_c.py',
            '7. Fix station-c support connector IDs in-place',
            '8. Push station folders: wk push --skip-hooks -p ' + profile + ' (A, B, C)',
            '9. Restore working tree: git checkout -- dewy-bank-station-a/ dewy-bank-station-b/ dewy-bank-station-c/',
            '10. Run setup_chat_clients.py -p ' + profile + ' and save JSON to ' + CHAT_CONFIG_PATH,
            '11. Print next-steps instructions',
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
    # Step 2 — push Workspace Connections
    # ------------------------------------------------------------------
    print('\nStep 2: pushing Workspace Connections...', file=sys.stderr)
    # No --skip-hooks here; workspace-connections contains connector files, not recipes.
    wk(profile, 'push', '--folder', 'Workspace Connections')
    print('  done', file=sys.stderr)

    # ------------------------------------------------------------------
    # Step 3 — discover new provider IDs
    # ------------------------------------------------------------------
    print('\nStep 3: discovering new connector provider IDs...', file=sys.stderr)
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
    print(f'  customer API new ID : {new_gen}', file=sys.stderr)
    print(f'  support  API new ID : {new_support_gen}', file=sys.stderr)

    # Idempotency check: if both IDs already match, the remap is a no-op but we
    # still push (wk push is idempotent; unchanged files are skipped).
    if old_gen == new_gen and old_support_gen == new_support_gen:
        print('  provider IDs already match the target workspace — remap will be a no-op',
              file=sys.stderr)

    # ------------------------------------------------------------------
    # Steps 4-9 wrapped in try/finally so the working tree is ALWAYS restored,
    # even if a push or build step fails mid-way.
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

        # Step 8 — push all three station folders
        # --skip-hooks bypasses the pre-push recipe-lint hook, which requires the
        # recipe-skills checkout (not present in a participant workspace).
        # Note: wk push may report some files as "deleted" for connector adapter
        # files tracked in .wk state from a prior pull; per AGENTS.md rule 6,
        # the server assets remain — this is expected behavior.
        for server_path in ('Dewy Bank Station A', 'Dewy Bank Station B', 'Dewy Bank Station C'):
            print(f'\nStep 8: pushing {server_path}...', file=sys.stderr)
            wk(profile, 'push', '--folder', server_path, '--skip-hooks')
            print('  done', file=sys.stderr)

    finally:
        # Step 9 — restore the working tree regardless of success or failure
        print('\nStep 9: restoring working tree...', file=sys.stderr)
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
    # Step 10 — run setup_chat_clients.py
    # ------------------------------------------------------------------
    print('\nStep 10: running setup_chat_clients.py...', file=sys.stderr)
    # stdout=subprocess.PIPE captures the JSON blob while stderr streams live to
    # the terminal so the user sees progress during this multi-API-call step.
    result = subprocess.run(
        [sys.executable, os.path.join(HERE, 'setup_chat_clients.py'), '-p', profile],
        stdout=subprocess.PIPE, text=True, cwd=ROOT,
    )
    if result.returncode != 0:
        sys.exit('setup_chat_clients.py failed (see output above)')

    # Save the JSON blob (stdout) to the agents tasks directory
    chat_json = result.stdout.strip()
    if chat_json:
        os.makedirs(os.path.dirname(CHAT_CONFIG_PATH), exist_ok=True)
        with open(CHAT_CONFIG_PATH, 'w') as f:
            f.write(chat_json)
            f.write('\n')
        print(f'  chat config saved to {CHAT_CONFIG_PATH}', file=sys.stderr)
        print(chat_json)  # stdout: the deliverable for the caller
    else:
        print('  WARNING: setup_chat_clients.py produced no JSON blob', file=sys.stderr)

    # ------------------------------------------------------------------
    # Step 11 — next-steps instructions
    # ------------------------------------------------------------------
    base_url = status.get('base_url', 'https://app.workato.com').rstrip('/')
    print(f'''
─────────────────────────────────────────────────────────────────
Deployment complete. Two manual steps remain:
1. Connect the Workato connections in the UI:
   {base_url}/app/connections
   • "Dewy Bank Customer API" — enter your Dewy Bank email and password
   • "Dewy Bank Support API"  — enter the support code (Station C only)
2. Start recipes for each station you want to use:
   {base_url}/recipes
3. In the bank app, open "Ask Dewy → Set up chat" and paste the JSON
   that was printed above (also saved to {CHAT_CONFIG_PATH}).
─────────────────────────────────────────────────────────────────''', file=sys.stderr)


if __name__ == '__main__':
    main()
