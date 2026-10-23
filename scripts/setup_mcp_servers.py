"""Generate MCP chat config for the Dewy Bank workshop.

Reads mcp_servers.env from the project root (one URL per station:
  A1=https://...
  A2=https://...  etc.)
and writes mcp_conf.json to the project root for pasting into the bank app.

No required arguments.  Safe to rerun.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))

ENV_FILE = os.path.join(ROOT, 'mcp_servers.env')
OUT_FILE = os.path.join(ROOT, 'mcp_conf.json')
STATIONS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']


def _read_env_file(path):
    """Parse a KEY=VALUE file, ignoring blank lines and comments.  Returns dict."""
    result = {}
    if not os.path.exists(path):
        return result
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, _, val = line.partition('=')
            key = key.strip().upper()
            val = val.strip()
            if val:
                result[key] = val
    return result


def _prompt_for_missing(missing):
    """Print a human-readable prompt listing the missing stations."""
    if len(missing) == len(STATIONS):
        label = 'all stations'
    else:
        label = ', '.join(missing)
    print(f'\nMCP server URLs are missing for: {label}', file=sys.stderr)
    print(f'\nPlease add/update mcp_servers.env in the project root with one URL per line:',
          file=sys.stderr)
    for st in STATIONS:
        print(f'  {st}=https://...', file=sys.stderr)
    print(f'\nPress Enter when the file is saved...', end='', flush=True, file=sys.stderr)
    try:
        input()
    except EOFError:
        sys.exit(
            'Running non-interactively and mcp_servers.env is incomplete.\n'
            'Populate it with all 6 station URLs and rerun.'
        )


def main():
    # Loop until all 6 stations are present in the env file.
    while True:
        urls = _read_env_file(ENV_FILE)
        missing = [st for st in STATIONS if st not in urls]
        if not missing:
            break
        _prompt_for_missing(missing)

    # Build the JSON blob.
    config = {st: urls[st] for st in STATIONS}

    # Print for copy-paste (the user should keep this private).
    print(
        '\nPaste this into the bank app chat widget (\u2699 Config button) \u2014 '
        'keep it private, it contains your MCP tokens:'
    )
    print(json.dumps(config, indent=2))

    # Persist to mcp_conf.json.
    with open(OUT_FILE, 'w') as f:
        json.dump(config, f, indent=2)
        f.write('\n')
    print(f'\n(also saved to {OUT_FILE})', file=sys.stderr)


if __name__ == '__main__':
    main()
