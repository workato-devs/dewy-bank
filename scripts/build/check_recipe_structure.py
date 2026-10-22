"""Check every station recipe for structure Workato rejects at activation. Read-only.
Run from anywhere: python3 scripts/build/check_recipe_structure.py

wk lint doesn't catch these; each one has broken activation before:
- an `else` must be the last step inside its `if`, and a `catch` the last step inside its `try`
  (an `else` anywhere else is an "unexpected line");
- a foreach needs `repeat_mode` and a top-level `source`, and the source must be a plain datapill: the
  platform rejects a formula there ("Source does not support formula-mode"). Its body reaches the item
  through the source step (`current_item`), never `provider: "foreach"`;
- every connector step carries its action's output fields (recipe_shapes.ACTION_OUTPUTS), or nothing
  downstream can read its output ("Unknown data field"); and ACTION_OUTPUTS matches the connectors' code;
- every datapill's `line` must be an alias that exists in the recipe.
"""
import glob, json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from recipe_shapes import ACTION_OUTPUTS, CONNECTOR_PROVIDER, plain_source

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
failed = []


def walk(step, parent=None):
    yield step, parent
    for child in step.get('block', []):
        yield from walk(child, step)


def check(ok, msg):
    if not ok:
        failed.append(msg)
        print('FAIL', msg)


files = sorted(glob.glob(os.path.join(ROOT, 'dewy-bank-station-*', '**', '*.recipe.json'), recursive=True))
for path in files:
    rel = os.path.relpath(path, ROOT)
    recipe = json.load(open(path))
    steps = list(walk(recipe['code']))
    aliases = {'trigger'} | {s['as'] for s, _ in steps if s.get('as')}
    text = json.dumps(recipe)

    for s, parent in steps:
        kw = s['keyword']
        if kw in ('else', 'catch'):
            owner = 'if' if kw == 'else' else 'try'
            check(parent is not None and parent['keyword'] == owner and parent['block'][-1] is s,
                  f"{rel}: {kw} {s.get('as') or s.get('uuid')} must be the last step inside its {owner}")
            # Naming convention: else_<x> answers if_<x>. A valid-looking else inside the wrong if silently
            # attaches its refusal to the wrong rule.
            alias = s.get('as') or ''
            if kw == 'else' and alias.startswith('else_') and parent is not None:
                check(parent.get('as') == 'if_' + alias[len('else_'):],
                      f"{rel}: {alias} is inside {parent.get('as')}, not if_{alias[len('else_'):]}")
        if kw == 'foreach':
            name = s.get('as')
            declared = {f['name'] for f in s.get('extended_output_schema') or []}
            check(s.get('repeat_mode') in ('simple', 'batch'), f'{rel}: foreach {name} has no repeat_mode')
            check(s.get('source') and s.get('source') == s.get('input', {}).get('source'),
                  f'{rel}: foreach {name} needs a top-level source matching input.source')
            body = json.dumps(s.get('block', []))
            used = set(re.findall(r'provider\\": \\"foreach\\", \\"line\\": \\"' + re.escape(name) +
                                  r'\\", \\"path\\": \[\\"([A-Za-z_]+)', body))
            check(plain_source(s), f'{rel}: foreach {name} has a formula source; loop over a plain datapill')
            check(not used, f'{rel}: foreach {name} reads its item via provider "foreach" {sorted(used)}; '
                            'use the source step with current_item (Workato\'s exported form)')
        if CONNECTOR_PROVIDER.match(s.get('provider') or ''):
            check(s.get('extended_output_schema') == ACTION_OUTPUTS.get(s.get('name')),
                  f"{rel}: connector step {s.get('as')} ({s.get('name')}) lacks its output fields; "
                  'run its recipe through recipe_shapes.add_output_schemas')

    lines = set(re.findall(r'\\"line\\": ?\\"([A-Za-z0-9_]+)\\"', text))
    check(lines <= aliases, f'{rel}: datapills point at missing steps {sorted(lines - aliases)}')

# ACTION_OUTPUTS must name the fields each connector action's output_fields declares.
def names(fields):
    return sorted(f['name'] + (':' + ','.join(names(f['properties'])) if f.get('properties') else '') for f in fields)


for rb in sorted(glob.glob(os.path.join(ROOT, 'workspace-connections', '*.custom_adapter.rb'))):
    code = open(rb).read()
    defs = {m.group(1): re.findall(r"name: '(\w+)'", m.group(2))
            for m in re.finditer(r"^    (\w+): \{\n      fields: lambda.*?\n(.*?)\n      end", code, re.S | re.M)}
    for m in re.finditer(r"^    (\w+): \{\n      title:.*?output_fields: lambda[^\n]*\n(.*?)\n      end", code, re.S | re.M):
        action, body = m.group(1), m.group(2)
        fields = []
        for f in re.finditer(r"\{ name: '(\w+)'((?:[^{}]|\{[^{}]*\})*)\}", body):
            ref = re.search(r"object_definitions\['(\w+)'\]", f.group(2))
            props = defs[ref.group(1)] if ref else re.findall(r"name: '(\w+)'", f.group(2))
            fields.append(f.group(1) + (':' + ','.join(sorted(props)) if props else ''))
        check(sorted(fields) == names(ACTION_OUTPUTS.get(action, [])),
              f'{os.path.basename(rb)}: {action} output_fields {sorted(fields)} != ACTION_OUTPUTS {names(ACTION_OUTPUTS.get(action, []))}')

print(f'\nchecked {len(files)} recipes:', 'ALL PASS' if not failed else f'{len(failed)} FAILED')
sys.exit(1 if failed else 0)
