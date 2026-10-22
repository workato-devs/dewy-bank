"""Push a full Workato deployment for one workshop participant.

This script is for WORKSHOP PARTICIPANTS only.

Before running this script, a facilitator must have run
``scripts/stamp_bank_app_url.py`` to embed the bank app URL and API
endpoints into the connector files.  If that step was skipped you will
see an error below.

Requirements:
  - wk CLI installed and on your PATH
  - A wk auth profile linked to your Workato workspace
    (``wk auth login -p <profile>``)

Usage:
    python3 scripts/deploy_workato.py --profile <wk-profile> [--dry-run]

Steps performed (in order):
  1. Pre-flight: verify connector files have been stamped by the facilitator.
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

# Sentinel written into connector default: fields before stamping.
# stamp_bank_app_url.py replaces these with real URLs/keys.
_UNSTAMPED_SENTINEL = 'NOT_STAMPED'

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

def check_stamped():
    """Return True if every connector .rb file has been stamped.

    Checks that no ``default:`` field still holds the sentinel value
    ``NOT_STAMPED``.  If any are found, prints an actionable error and
    returns False.
    """
    rb_files = [
        os.path.join(ROOT, 'workspace-connections', 'dewy_bank_customer_api.custom_adapter.rb'),
        os.path.join(ROOT, 'workspace-connections', 'dewy_bank_support_api.custom_adapter.rb'),
    ]
    unstamped = []
    for path in rb_files:
        if not os.path.exists(path):
            continue
        if _UNSTAMPED_SENTINEL in open(path).read():
            unstamped.append(os.path.relpath(path, ROOT))
    if unstamped:
        print(
            'ERROR: Connectors have not been stamped. '
            'Ask your facilitator to run stamp_bank_app_url.py first.\n'
            f'  Unstamped files: {", ".join(unstamped)}',
            file=sys.stderr,
        )
        return False
    return True


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
            '  python3 scripts/deploy_workato.py -p MyProfile --dry-run\n'
            '  python3 scripts/deploy_workato.py -p MyProfile\n'
            '\n'
            'Note: connector stamping is a facilitator task. Run\n'
            '  python3 scripts/stamp_bank_app_url.py <bank-url>\n'
            'before distributing the repo to participants.'
        ),
    )
    ap.add_argument('-p', '--profile', required=True, help='wk auth profile name')
    ap.add_argument('--dry-run', action='store_true',
                    help='print what would happen without making any changes')
    args = ap.parse_args()
    profile  = args.profile
    dry_run  = args.dry_run

    # ------------------------------------------------------------------
    # Pre-flight checks
    # ------------------------------------------------------------------
    print('Pre-flight checks...', file=sys.stderr)

    # 1. Verify connectors have been stamped by the facilitator
    if not check_stamped():
        sys.exit(1)
    print('  connectors: stamped', file=sys.stderr)

    # 2. Profile / workspace reachable
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
            '1. Push Workspace Connections: wk push --folder "Workspace Connections" -p ' + profile,
            '2. Discover new connector provider IDs: wk connectors list -p ' + profile,
            '3. Rewrite provider IDs in station-a JSON files in-place',
            '4. Rebuild station-b: python3 scripts/build/build_station_b.py',
            '5. Rebuild station-c: python3 scripts/build/build_station_c.py',
            '6. Fix station-c support connector IDs in-place',
            '7. Push station folders: wk push --skip-hooks -p ' + profile + ' (A, B, C)',
            '8. Restore working tree: git checkout -- dewy-bank-station-a/ dewy-bank-station-b/ dewy-bank-station-c/',
            '9. Run setup_chat_clients.py -p ' + profile + ' and save JSON to ' + CHAT_CONFIG_PATH,
            '10. Print next-steps instructions',
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
    # Step 1 — push Workspace Connections
    # ------------------------------------------------------------------
    print('\nStep 1: pushing Workspace Connections...', file=sys.stderr)
    # No --skip-hooks here; workspace-connections contains connector files, not recipes.
    wk(profile, 'push', '--folder', 'Workspace Connections')
    print('  done', file=sys.stderr)

    # ------------------------------------------------------------------
    # Step 2 — discover new provider IDs
    # ------------------------------------------------------------------
    print('\nStep 2: discovering new connector provider IDs...', file=sys.stderr)
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
    # Steps 3-8 wrapped in try/finally so the working tree is ALWAYS restored,
    # even if a push or build step fails mid-way.
    # ------------------------------------------------------------------
    try:
        # Step 3 — remap station-a in-place
        print('\nStep 3: remapping station-a provider IDs...', file=sys.stderr)
        n = remap_ids_in_folder(STATION_A, old_gen, new_gen)
        print(f'  {n} file(s) updated', file=sys.stderr)

        # Step 4 — rebuild station-b
        # build_station_b.py reads GEN dynamically from station-a, so it picks
        # up the new customer ID automatically.
        print('\nStep 4: rebuilding station-b...', file=sys.stderr)
        run_build_script('build_station_b.py')
        print('  done', file=sys.stderr)

        # Step 5 — rebuild station-c
        # Customer tools inherit the new customer ID from station-a.
        # SUPPORT_GEN is still the old hardcoded value at this point — fixed in step 6.
        print('\nStep 5: rebuilding station-c...', file=sys.stderr)
        run_build_script('build_station_c.py')
        print('  done', file=sys.stderr)

        # Step 6 — fix station-c support connector IDs
        print('\nStep 6: remapping station-c support connector IDs...', file=sys.stderr)
        n = remap_ids_in_folder(STATION_C, old_support_gen, new_support_gen)
        print(f'  {n} file(s) updated', file=sys.stderr)

        # Step 7 — push all three station folders
        # --skip-hooks bypasses the pre-push recipe-lint hook, which requires the
        # recipe-skills checkout (not present in a participant workspace).
        # Note: wk push may report some files as "deleted" for connector adapter
        # files tracked in .wk state from a prior pull; per AGENTS.md rule 6,
        # the server assets remain — this is expected behavior.
        for server_path in ('Dewy Bank Station A', 'Dewy Bank Station B', 'Dewy Bank Station C'):
            print(f'\nStep 7: pushing {server_path}...', file=sys.stderr)
            wk(profile, 'push', '--folder', server_path, '--skip-hooks')
            print('  done', file=sys.stderr)

    finally:
        # Step 8 — restore the working tree regardless of success or failure
        print('\nStep 8: restoring working tree...', file=sys.stderr)
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
    # Step 9 — run setup_chat_clients.py
    # ------------------------------------------------------------------
    print('\nStep 9: running setup_chat_clients.py...', file=sys.stderr)
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
    # Step 10 — next-steps instructions
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
