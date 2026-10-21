"""Check Station B's invariants (REQUIREMENTS.md §4) against Station A. Read-only.

Run from anywhere: python3 scripts/build/check_invariants.py
"""
import copy, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
A = os.path.join(ROOT, 'dewy-bank-station-a')
B = os.path.join(ROOT, 'dewy-bank-station-b')
B1 = os.path.join(B, 'b1_flaw_wrapped_api_leaky_response')
B2 = os.path.join(B, 'b2_fix_intent_interface')
TOOLS = ['list_my_accounts', 'review_my_recent_activity', 'move_between_my_accounts']
failed = []


def load(*p):
    with open(os.path.join(*p)) as f:
        return json.load(f)


def walk(steps):
    for s in steps:
        yield s
        yield from walk(s.get('block', []))


def step(recipe, alias):
    return next(s for s in walk(recipe['code']['block']) if s.get('as') == alias)


def check(ok, msg):
    print(('PASS ' if ok else 'FAIL ') + msg)
    if not ok:
        failed.append(msg)


def without_labels(recipe):
    """Drop what only participants see (recipe description, step comments, connection name)."""
    r = copy.deepcopy(recipe)
    r.pop('description', None)
    for c in r['config']:
        if c.get('account_id'):
            c['account_id'].pop('name', None)
    for s in walk(r['code']['block']):
        s.pop('comment', None)
    return r


# 1. B2 is Station A's intent-shaped tools, step for step.
for name, src in [('list_my_accounts', 'shared'), ('review_my_recent_activity', 'a2_fix_recipe_owns_the_write'),
                  ('move_between_my_accounts', 'a2_fix_recipe_owns_the_write'), ('pay_someone', 'a2_fix_recipe_owns_the_write')]:
    check(without_labels(load(A, src, name + '.recipe.json')) == without_labels(load(B2, name + '.recipe.json')),
          f'B2 {name} is a copy of Station A ({src}/)')

# 1b. pay_someone isn't part of Station B's contrast (P5: shared attack surface): it's A2's in both variants,
#     byte for byte apart from labels, and it requires the customer's confirmation in both.
check(without_labels(load(B1, 'pay_someone.recipe.json')) == without_labels(load(B2, 'pay_someone.recipe.json')),
      'pay_someone identical in B1 and B2')
check(all(load(f, 'pay_someone.recipe.json')['code']['input']['requires_user_confirmation'] == 'true' for f in (B1, B2)),
      'pay_someone requires confirmation in B1 and B2')
for folder in (B1, B2):
    s, r = load(folder, 'pay_someone.agentic_skill.json'), load(folder, 'pay_someone.recipe.json')
    check(s['name'] == r['name'] == 'pay_someone' and s['trigger_description'] == r['code']['input']['description'],
          f'{os.path.basename(folder)[:2]} pay_someone: skill file matches its recipe')

# 2. The A2 rules are identical in B1 and B2. Only the steps that shape output may differ: the return steps,
#    and the activity list that B1 keeps as raw rows and B2 keeps in customer terms.
OUTPUT_SHAPING = {'declare_my_activity', 'add_to_my_activity'}


def rule_block(folder, recipe, top_alias):
    top = step(load(folder, recipe + '.recipe.json'), top_alias)
    return [{k: v for k, v in s.items() if k != 'block'} for s in walk([top])
            if s.get('name') != 'workflow_return_result' and s.get('as') not in OUTPUT_SHAPING]
check(rule_block(B1, 'move_between_my_accounts', 'if_different_accounts') == rule_block(B2, 'move_between_my_accounts', 'if_different_accounts'),
      'write rules (1-4, transfer, catch) identical in B1 and B2')
check(rule_block(B1, 'review_my_recent_activity', 'if_account_named') == rule_block(B2, 'review_my_recent_activity', 'if_account_named'),
      'read rules (one named account, at most 20 entries, read, catch) identical in B1 and B2')

# 3. Scope (Factor IV) comes from the credential: every customer tool calls only the customer API connector,
#    as the participant. Nothing reaches the Admin API or the retired customer_id stand-in.
for folder in (B1, B2):
    for name in TOOLS:
        r = load(folder, name + '.recipe.json')
        apps = [c for c in r['config'] if c.get('account_id')]
        text = json.dumps(r)
        check(len(apps) == 1 and apps[0]['account_id'].get('zip_name') == 'Workspace Connections/dewy_bank_customer_api.connection.json'
              and '"provider": "rest"' not in text and 'customer_id' not in text and '/admin/' not in text,
              f'{os.path.basename(folder)[:2]} {name}: customer API connector only, no Admin API or customer_id')

# 4. Everything else the model sees is identical.
g1 = load(B1, 'dewy_bank_assistant_b1_flaw.agentic_genie.json')
g2 = load(B2, 'dewy_bank_assistant_b2_fix.agentic_genie.json')
ga = load(A, 'a2_fix_recipe_owns_the_write', 'dewy_bank_assistant_a2_fix.agentic_genie.json')
for k in ['instructions', 'raw_instructions', 'ai_provider', 'ai_model', 'matrix', 'mcp_servers', 'guardrail']:
    check(g1[k] == g2[k] == ga[k], f'Genie {k} identical in B1, B2 and Station A')
check([r['id']['name'] for r in g1['references'].values()] == [r['id']['name'] for r in g2['references'].values()],
      'Genies list the same skills in the same order')
for name in TOOLS:
    i1, i2 = load(B1, name + '.recipe.json')['code']['input'], load(B2, name + '.recipe.json')['code']['input']
    check(i1['requires_user_confirmation'] == i2['requires_user_confirmation'], f'{name}: requires_user_confirmation identical')
    for folder in (B1, B2):
        s, r = load(folder, name + '.agentic_skill.json'), load(folder, name + '.recipe.json')
        check(s['name'] == r['name'] == name and s['trigger_description'] == r['code']['input']['description'],
              f'{os.path.basename(folder)[:2]} {name}: skill file matches its recipe')
shared = lambda f: [p for p in json.loads(load(f, 'move_between_my_accounts.recipe.json')['code']['input']['parameters_schema_json'])
                    if p['name'] in ('amount', 'note')]
check(shared(B1) == shared(B2), 'move_between_my_accounts: amount and note parameters identical')

# 5. The Factor III difference is really there.
for name in TOOLS:
    i1, i2 = load(B1, name + '.recipe.json')['code']['input'], load(B2, name + '.recipe.json')['code']['input']
    boundary2 = i2['parameters_schema_json'] + i2['result_schema_json']
    check(not any(k in boundary2 for k in ['accountId', 'customerId', 'txnId', 'account_id']), f'B2 {name}: no backend IDs at the tool boundary')
    check('customer API' in i1['description'] and 'customer API' not in i2['description'], f'B1 {name}: description names the backend (and B2\'s does not)')

print('\nALL PASS' if not failed else f'\n{len(failed)} FAILED')
sys.exit(1 if failed else 0)
