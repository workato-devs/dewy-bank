"""Check Station C's invariants (docs/station-c/REQUIREMENTS.md §4) against Station A. Read-only.

Run from anywhere: python3 scripts/build/check_station_c.py
"""
import copy, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
A = os.path.join(ROOT, 'dewy-bank-station-a')
C = os.path.join(ROOT, 'dewy-bank-station-c')
SHARED = os.path.join(C, 'shared')
C1 = os.path.join(C, 'c1_flaw_shared_namespace_prompt_acl')
C2 = os.path.join(C, 'c2_fix_namespace_per_role')
CUSTOMER_TOOLS = ['list_my_accounts', 'review_my_recent_activity', 'move_between_my_accounts', 'pay_someone']
SUPPORT_TOOLS = ['look_up_customer_accounts', 'issue_goodwill_credit']
CUSTOMER_CONN = 'Workspace Connections/dewy_bank_customer_api.connection.json'
SUPPORT_CONN = 'Workspace Connections/dewy_bank_support_api.connection.json'
failed = []


def load(*p):
    with open(os.path.join(*p)) as f:
        return json.load(f)


def walk(steps):
    for s in steps:
        yield s
        yield from walk(s.get('block', []))


def check(ok, msg):
    print(('PASS ' if ok else 'FAIL ') + msg)
    if not ok:
        failed.append(msg)


def without_labels(recipe):
    """Drop what only participants see (recipe description, step comments)."""
    r = copy.deepcopy(recipe)
    r.pop('description', None)
    for s in walk(r['code']['block']):
        s.pop('comment', None)
    return r


def block(path, tag):
    text = open(os.path.join(ROOT, 'docs', path)).read()
    return text.split(f'<!-- {tag} -->')[1].strip('\n')


# 1. The customer tools are Station A's, step for step (II and III held good).
for name, src in [('list_my_accounts', 'shared'), ('review_my_recent_activity', 'a2_fix_recipe_owns_the_write'),
                  ('move_between_my_accounts', 'a2_fix_recipe_owns_the_write'), ('pay_someone', 'a2_fix_recipe_owns_the_write')]:
    check(without_labels(load(A, src, name + '.recipe.json')) == without_labels(load(SHARED, name + '.recipe.json')),
          f'{name} is a copy of Station A ({src}/)')

# 2. Every tool lives once, in shared/, so C1 and C2 use the same tools byte for byte.
for folder in (C1, C2):
    check(not [f for f in os.listdir(folder) if f.endswith('.recipe.json')], f'{os.path.basename(folder)[:2]}: no recipes of its own')

# 3. The namespaces: which Genie holds which skills (the Factor IV variable).
genies = {
    'C1': (load(C1, 'dewy_bank_assistant_c1_flaw.agentic_genie.json'), CUSTOMER_TOOLS + SUPPORT_TOOLS),
    'C2 customer': (load(C2, 'dewy_bank_assistant_c2_fix.agentic_genie.json'), CUSTOMER_TOOLS),
    'C2 support': (load(C2, 'dewy_bank_support_assistant_c2_fix.agentic_genie.json'), SUPPORT_TOOLS),
}
for label, (g, tools) in genies.items():
    refs = [r['id'] for r in g['references'].values()]
    check([r['name'] for r in refs] == tools and all(r['zip_name'] == f"shared/{r['name']}.agentic_skill.json" for r in refs),
          f'{label} Genie holds exactly {", ".join(tools)}')

# 4. The instructions: C1 = customer text + support duties + access rule; C2 carries no access rule.
customer_text = block('station-a/genie-instructions.md', 'instructions')
duties = block('station-c/genie-instructions.md', 'c1-support-duties')
rule = block('station-c/genie-instructions.md', 'c1-access-rule')
support_text = block('station-c/genie-instructions.md', 'support')
expected = {'C1': ' '.join([customer_text, duties, rule]), 'C2 customer': customer_text, 'C2 support': support_text}
for label, (g, _) in genies.items():
    check(g['instructions'] == g['raw_instructions'] == expected[label] + '\n', f'{label} instructions built as specified')
for label in ('C2 customer', 'C2 support'):
    text = genies[label][0]['instructions'].lower()
    check(rule.lower() not in text and 'passphrase' not in text and 'only use' not in text, f'{label}: no access rule in the instructions')
check(customer_text in genies['C1'][0]['instructions'], 'C1 keeps the customer text unchanged (same as every station)')
a_genie = load(A, 'a2_fix_recipe_owns_the_write', 'dewy_bank_assistant_a2_fix.agentic_genie.json')
for k in ['ai_provider', 'ai_model', 'matrix', 'mcp_servers', 'guardrail']:
    check(all(g[k] == a_genie[k] for g, _ in genies.values()), f'Genie {k} identical in every Station C Genie and Station A')

# 5. Scope comes from credentials: each tool uses only its own connection; nothing reaches the Admin API.
for name, conn in [(n, CUSTOMER_CONN) for n in CUSTOMER_TOOLS] + [(n, SUPPORT_CONN) for n in SUPPORT_TOOLS]:
    r = load(SHARED, name + '.recipe.json')
    apps = [c for c in r['config'] if c.get('account_id')]
    text = json.dumps(r)
    check(len(apps) == 1 and apps[0]['account_id'].get('zip_name') == conn and '/admin/' not in text and 'customer_id' not in text,
          f'{name}: only {conn.split("/")[1]}, no Admin API or customer_id')

# 6. The interface is held good (III) for the support tools too: no backend IDs at the boundary.
for name in SUPPORT_TOOLS:
    i = load(SHARED, name + '.recipe.json')['code']['input']
    boundary = i['parameters_schema_json'] + i['result_schema_json'] + i['description']
    check(not any(k in boundary for k in ['accountId', 'account_id', 'customerId', '/support/']), f'{name}: no backend IDs or routes at the tool boundary')

# 7. Skill files match their recipes.
for name in CUSTOMER_TOOLS + SUPPORT_TOOLS:
    s, r = load(SHARED, name + '.agentic_skill.json'), load(SHARED, name + '.recipe.json')
    check(s['name'] == r['name'] == name and s['trigger_description'] == r['code']['input']['description'], f'{name}: skill file matches its recipe')

print('\nALL PASS' if not failed else f'\n{len(failed)} FAILED')
sys.exit(1 if failed else 0)
