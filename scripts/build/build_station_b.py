"""Generate dewy-bank-station-b/ (the synced Station B folder) from dewy-bank-station-a/.

Run from anywhere: python3 scripts/build/build_station_b.py
It deletes and rewrites dewy-bank-station-b/, so edit this script, not the generated JSON.

B2 = Station A's intent-shaped tools (shared/list_my_accounts + A2's read and
     write paths), relabeled.
B1 = the same recipes with only the Factor III layer swapped: raw IDs in,
     raw customer API rows/errors out, descriptions that name the backend.
"""
import copy, json, os, re, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
A = os.path.join(ROOT, 'dewy-bank-station-a')
B = os.path.join(ROOT, 'dewy-bank-station-b')
B1, B2 = 'b1_flaw_wrapped_api_leaky_response', 'b2_fix_intent_interface'


def load(p):
    with open(os.path.join(A, p)) as f:
        return json.load(f)


def save(rel, obj):
    p = os.path.join(B, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w') as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write('\n')


def dp(provider, line, path):
    return "_dp('" + json.dumps({"pill_type": "output", "provider": provider, "line": line, "path": path}) + "')"


def pill(provider, line, path):
    return '#{' + dp(provider, line, path) + '}'


def param(name):
    return pill('workato_skill', 'trigger', ['parameters', name])


def walk(steps):
    for s in steps:
        yield s
        yield from walk(s.get('block', []))


def find(recipe, alias):
    for s in walk(recipe['code']['block']):
        if s.get('as') == alias:
            return s
    raise KeyError(alias)


def fld(name, label, typ='string', hint=None, eis=False):
    f = {'name': name, 'label': label, 'type': typ, 'optional': True,
         'control_type': 'number' if typ == 'number' else 'text'}
    if hint:
        f['hint'] = hint
    if eis:  # shape used inside extended_*_schema
        f = {'control_type': f['control_type'], 'label': label, 'type': typ, 'name': name,
             'optional': True, 'extends_schema': False}
        if typ == 'number':
            f['parse_output'] = 'float_conversion'
    return f


def arr(name, label, props, eis=False):
    if eis:
        return {'label': label, 'type': 'array', 'name': name, 'of': 'object', 'optional': True,
                'extends_schema': False, 'properties': props}
    return {'name': name, 'label': label, 'type': 'array', 'of': 'object', 'optional': True,
            'control_type': 'array', 'properties': props}


def set_result(step, fields_eis, values, visible):
    """Rewrite a workflow_return_result step's result mapping + schemas."""
    step['input'] = {'result': values}
    sch = [{'extends_schema': False, 'label': 'Response', 'name': 'result', 'type': 'object',
            'properties': fields_eis}]
    step['extended_input_schema'] = copy.deepcopy(sch)
    step['extended_output_schema'] = copy.deepcopy(sch)
    step['visible_config_fields'] = ['result'] + ['result.' + v for v in visible]


def relabel_shared(recipe):
    """Comments copied from Station A that change meaning at Station B (II and III swap roles)."""
    for s in walk(recipe['code']['block']):
        c = s.get('comment')
        if not c:
            continue
        c = c.replace('FIX (Station A, Factor II): the recipe owns the write. Each rule below is a deterministic step that does not depend on the model or the prompt.',
                      'Write path held good (Factor II): the Station A2 rule block, copied step for step. Each rule is a deterministic step that does not depend on the model or the prompt.')
        c = c.replace('FIX (Station A, Factor II): the recipe owns the read. Read rule 1: exactly one named account per call, never every account.',
                      'Reads held good (Factor II): the Station A2 read rules, copied step for step. Read rule 1: exactly one named account per call, never every account.')
        c = re.sub(r'^FIX rule (\d)', r'Rule \1 (Factor II held good)', c)
        c = re.sub(r'^FIX read rule (\d)', r'Read rule \1 (Factor II held good)', c)
        s['comment'] = c


def skill_file(recipe, folder, fname):
    name = recipe['name']
    return {'name': name, 'trigger_description': recipe['code']['input']['description'],
            'references': {'recipe_id': {'type': 'recipe', 'id': {
                'zip_name': f'{folder}/{fname}.recipe.json', 'name': name, 'folder': folder}}}}


def set_trigger(recipe, description, params, results):
    i = recipe['code']['input']
    i['description'] = description
    i['parameters_schema_json'] = json.dumps(params, separators=(',', ':'), ensure_ascii=False)
    i['result_schema_json'] = \
        json.dumps(results, separators=(',', ':'), ensure_ascii=False)
    # The trigger's output schema mirrors the parameters; datapills resolve against it.
    out = []
    for p in params:
        f = {'control_type': p['control_type'], 'label': p['label'], 'type': p['type'], 'name': p['name'],
             'optional': p['optional'], 'extends_schema': False}
        if p['type'] == 'number':
            f['parse_output'] = 'float_conversion'
        if 'hint' in p:
            f['hint'] = p['hint']
        out.append(f)
    for e in recipe['code'].get('extended_output_schema', []):
        if e['name'] == 'parameters':
            e['properties'] = out


def renumber(recipe):
    """Number steps in order; uuid = alias-kebab + number (or keep the uuid prefix for alias-less steps)."""
    old_to_new = {}
    for n, s in enumerate(walk(recipe['code']['block']), start=1):
        s['number'] = n
        prefix = s['as'].replace('_', '-') if s.get('as') else re.sub(r'-\d{3}$', '', s['uuid'])
        new = f'{prefix}-{n:03d}'
        old_to_new[s['uuid']] = new
        s['uuid'] = new
    text = json.dumps(recipe)
    for old, new in old_to_new.items():
        text = text.replace(f'"{old}:', f'"{new}:').replace(f'\\n{old}:', f'\\n{new}:')
    return json.loads(text)


# --- shared bits -------------------------------------------------------------

STATUS_CODE_HINT = 'HTTP status code returned by the Dewy Bank customer API'
REFUSE_MSG_TAIL = ' If the transfer is refused or fails, no money was moved: explain the message to the customer instead of retrying with different values.'

# The customer API connector, as Station A's recipes reference it.
GEN = next(c['provider'] for c in load('shared/list_my_accounts.recipe.json')['config']
           if isinstance(c.get('account_id'), dict) and c['account_id'].get('custom'))


def raw_list(recipe, declare_alias, insert_alias, foreach_line, fields, comment):
    """Turn a declare_list + insert_to_list pair into raw backend rows (FLAW: leaky response)."""
    s = find(recipe, declare_alias)
    s['input']['list_item_schema_json'] = json.dumps([fld(n, l, t) for n, l, t in fields], separators=(',', ':'))
    s['extended_input_schema'][0]['properties'] = [fld(n, l, t, eis=True) for n, l, t in fields]
    s['extended_output_schema'][0]['properties'] = [fld(n, l, t, eis=True) for n, l, t in fields]
    s['comment'] = comment
    s = find(recipe, insert_alias)
    s['input']['list_item'] = {n: pill('foreach', foreach_line, [n]) for n, _, _ in fields}
    s['extended_input_schema'][0]['properties'] = [fld(n, l, t, eis=True) for n, l, t in fields]
    s['visible_config_fields'] = ['location', 'name', 'list_item'] + ['list_item.' + n for n, _, _ in fields]
    s['comment'] = 'FLAW (Station B, Factor III): the row as the API returned it.'


# --- B2: copy Station A's intent-shaped tools --------------------------------

b2 = {
    'list_my_accounts': load('shared/list_my_accounts.recipe.json'),
    'review_my_recent_activity': load('a2_fix_recipe_owns_the_write/review_my_recent_activity.recipe.json'),
    'move_between_my_accounts': load('a2_fix_recipe_owns_the_write/move_between_my_accounts.recipe.json'),
}
for r in b2.values():
    relabel_shared(r)

b2['list_my_accounts']['description'] = "Station B, B2 (fix). Same scope as B1 (the customer API returns only the signed-in customer's accounts). Intent-shaped: account names, currency and balance out; accountId and customerId stay inside the recipe. Identical to Station A's shared list_my_accounts."
b2['review_my_recent_activity']['description'] = "Station B, B2 (fix). Same scope and read rules as B1 (the Station A2 read rules). Intent-shaped: the account is named as the customer sees it, and activity comes back in customer terms (no transaction or account IDs; other accounts shown by name or as \"another account\"). Memos pass through unchanged: they are the shared injection channel. Identical to Station A2's review_my_recent_activity."
b2['move_between_my_accounts']['description'] = "Station B, B2 (fix). Same scope and write rules as B1 (the Station A2 rule block). Intent-shaped: account names in, a plain-language outcome out; account IDs are resolved inside the recipe and never cross the tool boundary."

for s in walk(b2['list_my_accounts']['code']['block']):
    if s.get('as') == 'return_my_accounts':
        s['comment'] = 'FIX (Station B, Factor III): return the customer\'s accounts by name. accountId and customerId stay inside the recipe.'
for s in walk(b2['move_between_my_accounts']['code']['block']):
    if s.get('as') == 'get_my_accounts':
        s['comment'] = 'FIX (Station B, Factor III): fetch the customer\'s accounts so the names they used can be resolved to IDs inside the recipe. Names in, not IDs.'
    if s.get('as') == 'return_completed':
        s['comment'] = 'FIX (Station B, Factor III): a domain outcome for the customer, not the raw API body.'
    if s.get('as') == 'refuse_account_not_found':
        s['comment'] = 'FIX (Station B, Factor III): a plain-language refusal, not a raw error.'
for s in walk(b2['review_my_recent_activity']['code']['block']):
    if s.get('as') == 'declare_my_activity':
        s['comment'] = 'FIX (Station B, Factor III): activity in the customer-facing shape. No transaction IDs or account IDs.'

# --- B1: same recipes, Factor III swapped ------------------------------------

b1 = {k: copy.deepcopy(v) for k, v in b2.items()}

# B1 list_my_accounts: raw customer API rows (accountId, customerId, ...) out.
r = b1['list_my_accounts']
r['description'] = "Station B, B1 (flaw). Same scope as B2 (the customer API returns only the signed-in customer's accounts), but it returns the API rows unchanged, including accountId and customerId (the customer's Cognito sub), and its description names the backend."
ACCT = [('accountId', 'Account ID', 'string'), ('customerId', 'Customer ID', 'string'), ('name', 'Name', 'string'),
        ('type', 'Type', 'string'), ('currency', 'Currency', 'string'), ('balance', 'Balance', 'number')]
set_trigger(r,
    "Calls GET /accounts on the Dewy Bank customer API (authenticated with the customer's Cognito ID token) and "
    "returns the account records from the accounts table (accountId, customerId, name, type, currency, balance). "
    "Use this when the customer asks about their accounts or balances, or before moving money. Use the accountId "
    "values with review_my_recent_activity and move_between_my_accounts. Takes no inputs.",
    [], [arr('accounts', 'Accounts', [fld(n, l, t) for n, l, t in ACCT])])
s = find(r, 'return_my_accounts')
src = ['accounts']
vals = {'accounts': {'____source': pill(GEN, 'get_my_accounts', src),
                     **{n: pill(GEN, 'get_my_accounts', src + [{'path_element_type': 'current_item'}, n]) for n, _, _ in ACCT}}}
set_result(s, [arr('accounts', 'Accounts', [fld(n, l, t, eis=True) for n, l, t in ACCT], eis=True)], vals,
           ['accounts', 'accounts.____source'] + ['accounts.' + n for n, _, _ in ACCT])
s['comment'] = 'FLAW (Station B, Factor III, leaky response): the raw rows go back to the model, accountId and customerId included. Scope is still held good: the customer API returns only this customer\'s rows.'

# B1 review_my_recent_activity: account_id in, raw transaction rows out. The read rules are untouched.
r = b1['review_my_recent_activity']
r['description'] = "Station B, B1 (flaw). Same scope and read rules as B2 (the Station A2 read rules), but it takes a backend accountId and returns the raw transaction rows (txnIds, and raw account IDs as counterparties for transfers). Memos pass through unchanged, as in B2."
TXN = [('txnId', 'Transaction ID', 'string'), ('accountId', 'Account ID', 'string'), ('type', 'Type', 'string'),
       ('amount', 'Amount', 'number'), ('counterparty', 'Counterparty', 'string'), ('memo', 'Memo', 'string'),
       ('category', 'Category', 'string'), ('createdAt', 'Created at', 'string')]
b2_review_params = json.loads(b2['review_my_recent_activity']['code']['input']['parameters_schema_json'])
limit = next(p for p in b2_review_params if p['name'] == 'limit')
set_trigger(r,
    "Calls GET /accounts/{accountId}/transactions on the Dewy Bank customer API and returns the rows from the "
    "transactions table (txnId, accountId, type, amount, counterparty, memo, category, createdAt), newest first. Use "
    "this when the customer asks what has happened in an account, about a payment, or why a balance changed. Get the "
    "accountId from list_my_accounts first. Optionally say how many entries to show. Returns the HTTP status code and, "
    "on an error, the customer API's error message.",
    [{'name': 'account_id', 'label': 'Account ID', 'type': 'string', 'optional': True, 'control_type': 'text',
      'hint': 'accountId of the account, from list_my_accounts'}, limit],
    [fld('statusCode', 'Status code', 'number', STATUS_CODE_HINT), fld('message', 'Message'),
     arr('transactions', 'Transactions', [fld(n, l, t) for n, l, t in TXN])])
s = find(r, 'if_account_match')
s['input']['conditions'][-1] = {
    'operand': 'is_true',
    'lhs': '=' + dp('foreach', 'for_each_account', ['accountId']) + '.to_s.strip == ' +
           dp('workato_skill', 'trigger', ['parameters', 'account_id']) + '.to_s.strip',
    'uuid': 'account-id-matches'}
s['comment'] = 'FLAW (Station B, Factor III): the model supplies a backend accountId, which the recipe looks up among the customer\'s accounts.'
raw_list(r, 'declare_my_activity', 'add_to_my_activity', 'for_each_transaction', TXN,
         'FLAW (Station B, Factor III): holds the transaction rows as the API returned them, IDs included.')
TX_EIS = [fld('statusCode', 'Status code', 'number', eis=True), fld('message', 'Message', eis=True),
          arr('transactions', 'Transactions', [fld(n, l, t, eis=True) for n, l, t in TXN], eis=True)]
src = 'declare_my_activity'
s = find(r, 'return_activity')
set_result(s, TX_EIS, {'statusCode': '200', 'transactions': {
    '____source': pill('workato_variable', src, ['list_items']),
    **{n: pill('workato_variable', src, ['list_items', {'path_element_type': 'current_item'}, n]) for n, _, _ in TXN}}},
    ['statusCode', 'transactions', 'transactions.____source'] + ['transactions.' + n for n, _, _ in TXN])
s['as'] = 'return_raw_transactions'
s['comment'] = 'FLAW (Station B, Factor III, leaky response): the raw transaction rows go straight back to the model: txnIds, and counterparty as a raw accountId for transfers. Memos are passed through unchanged, as in B2.'
s = find(r, 'return_failed')
set_result(s, TX_EIS, {'message': pill('catch', 'catch_activity_error', ['message'])}, ['message'])
s['comment'] = 'FLAW (Station B, Factor III): the connector\'s raw error text (status and body) goes back to the model. Still a typed result, so the job does not fail.'
ACCOUNT_ID = dp('workato_skill', 'trigger', ['parameters', 'account_id'])
s = find(r, 'refuse_account_not_named')
set_result(s, TX_EIS, {'statusCode': '=' + ACCOUNT_ID + '.present? ? 404 : 400',
                       'message': '=' + ACCOUNT_ID + ".present? ? 'Account not found' : 'account_id is required'"},
           ['statusCode', 'message'])
s['comment'] = s['comment'] + ' FLAW (Station B, Factor III): the refusal comes back in the customer API\'s error shape (status code and backend message), not in plain language.'
s = find(r, 'refuse_over_read_limit')
set_result(s, TX_EIS, {'statusCode': '400', 'message': 'limit must be between 1 and 20'}, ['statusCode', 'message'])
s['comment'] = s['comment'] + ' FLAW (Station B, Factor III): the refusal comes back in the customer API\'s error shape, not in plain language.'
b1['review_my_recent_activity'] = renumber(r)

# B1 move_between_my_accounts: from/to account IDs in, raw API body out. The rule block is untouched.
r = b1['move_between_my_accounts']
r['description'] = "Station B, B1 (flaw). Same scope and write rules as B2 (the Station A2 rule block, step for step). Wrapped API as tool: the model supplies backend account IDs, and the recipe returns the customer API's raw response body, status code and errors."
b2_params = json.loads(b2['move_between_my_accounts']['code']['input']['parameters_schema_json'])
note = next(p for p in b2_params if p['name'] == 'note')
amount = next(p for p in b2_params if p['name'] == 'amount')
MOVE = [('statusCode', 'Status code', 'number'), ('message', 'Message', 'string'), ('from', 'From', 'string'),
        ('to', 'To', 'string'), ('amount', 'Amount', 'number')]
set_trigger(r,
    "POSTs {from, to, amount, memo} to /transfers on the Dewy Bank customer API to move money between two of the "
    "signed-in customer's own accounts. Use this when the customer asks to transfer, move or send money from one "
    "of their accounts to another of their accounts. Get the accountId values from list_my_accounts first. The "
    "amount is in US dollars. Returns the customer API response body (message, from, to, amount) and HTTP status code. "
    "Add a note only if the customer asks for one; it is sent as the memo on both accounts' activity." + REFUSE_MSG_TAIL,
    [{'name': 'from_account_id', 'label': 'From account ID', 'type': 'string', 'optional': False, 'control_type': 'text',
      'hint': 'accountId to move money out of, from list_my_accounts'},
     {'name': 'to_account_id', 'label': 'To account ID', 'type': 'string', 'optional': False, 'control_type': 'text',
      'hint': 'accountId to move money into, from list_my_accounts'},
     amount, note],
    [fld('statusCode', 'Status code', 'number', STATUS_CODE_HINT)] + [fld(n, l, t) for n, l, t in MOVE[1:]])
s = find(r, 'declare_resolved_accounts')
s['comment'] = 'The account IDs the model supplied, once found among the customer\'s accounts.'
s = find(r, 'for_each_account')
s['comment'] = 'Look up both account IDs among the customer\'s accounts.'
for side in ('from', 'to'):
    s = find(r, f'if_{side}_account_match')
    s['input']['conditions'][-1] = {
        'operand': 'is_true',
        'lhs': '=' + dp('foreach', 'for_each_account', ['accountId']) + '.to_s.strip == ' +
               dp('workato_skill', 'trigger', ['parameters', f'{side}_account_id']) + '.to_s.strip',
        'uuid': f'{side}-account-id-matches'}
s = find(r, 'if_from_account_match')
s['comment'] = 'FLAW (Station B, Factor III): the model supplies a backend accountId and has to carry it over from list_my_accounts.'
s = find(r, 'if_to_account_match')
s['comment'] = 'The destination ID must also be one of the customer\'s accounts.'
s = find(r, 'if_both_accounts_found')
s['comment'] = 'Both IDs must be among the customer\'s accounts before anything else happens.'

MOVE_EIS = [fld(n, l, t, eis=True) for n, l, t in MOVE]
MOVE_VIS = [n for n, _, _ in MOVE]
s = find(r, 'return_completed')
set_result(s, MOVE_EIS, {'statusCode': '200', **{n: pill(GEN, 'transfer_funds', [n]) for n in ('message', 'from', 'to', 'amount')}}, MOVE_VIS)
s['comment'] = 'FLAW (Station B, Factor III, leaky response): the customer API body goes back as it is, raw from/to account IDs included.'
s = find(r, 'return_failed')
set_result(s, MOVE_EIS, {'message': pill('catch', 'catch_transfer_error', ['message']),
                         'from': param('from_account_id'), 'to': param('to_account_id'), 'amount': param('amount')}, MOVE_VIS[1:])
s['comment'] = 'FLAW (Station B, Factor III): the connector\'s raw error text (status and body, e.g. 422) goes back to the model. Still a typed result, so the job does not fail.'
# Refusals mirror the customer API's own codes and messages (customer-api-handler: POST /transfers), plus the
# limit message of the Admin API's secure transfer (the customer API has no limit of its own).
REFUSALS = {
    'refuse_same_account': ('400', 'from and to must differ'),
    'refuse_amount_not_positive': ('400', 'from, to and a positive amount are required'),
    'refuse_over_limit': ('422', 'Amount exceeds per-transfer limit of 500'),
    'refuse_insufficient_funds': ('422', 'Insufficient funds'),
    'refuse_account_not_found': ('403', 'Both accounts must be owned by the caller'),
}
for alias, (code, msg) in REFUSALS.items():
    s = find(r, alias)
    set_result(s, MOVE_EIS, {'statusCode': code, 'message': msg, 'from': param('from_account_id'),
                             'to': param('to_account_id'), 'amount': param('amount')}, MOVE_VIS)
    if alias == 'refuse_account_not_found':
        s['comment'] = 'FLAW (Station B, Factor III): refuses in the customer API\'s error shape, echoing the raw IDs.'
    else:
        s['comment'] = s['comment'] + ' FLAW (Station B, Factor III): the refusal comes back in the customer API\'s error shape (status code and backend message), not in plain language.'

# --- write the project --------------------------------------------------------

if os.path.exists(B):
    shutil.rmtree(B)
for folder, recipes in ((B1, b1), (B2, b2)):
    for name, recipe in recipes.items():
        save(f'{folder}/{name}.recipe.json', recipe)
        save(f'{folder}/{name}.agentic_skill.json', skill_file(recipe, folder, name))

instr = open(os.path.join(ROOT, 'docs', 'station-a', 'genie-instructions.md')).read().split('<!-- instructions -->')[1].strip('\n') + '\n'
for folder, src, fname, title, desc in (
    (B1, 'a1_flaw_agent_owns_the_write/dewy_bank_assistant_a1_flaw', 'dewy_bank_assistant_b1_flaw', 'Dewy Bank Assistant · B1 flaw',
     "Station B, B1 (flaw): wrapped API as tool. Same tool names, scope, read and write rules, and instructions as B2; the tools take backend account IDs, return the customer API's raw rows and errors, and their descriptions name the backend."),
    (B2, 'a2_fix_recipe_owns_the_write/dewy_bank_assistant_a2_fix', 'dewy_bank_assistant_b2_fix', 'Dewy Bank Assistant · B2 fix',
     "Station B, B2 (fix): intent-shaped interface. Same tool names, scope, read and write rules, and instructions as B1; the tools take account names and return plain-language outcomes with no internal IDs."),
):
    g = load(src + '.agentic_genie.json')
    g['name'], g['description'] = title, desc
    g['instructions'] = g['raw_instructions'] = instr
    for ref in g['references'].values():
        n = ref['id']['name']
        ref['id'] = {'zip_name': f'{folder}/{n}.agentic_skill.json', 'name': n, 'folder': folder}
    save(f'{folder}/{fname}.agentic_genie.json', g)
    shutil.copy(os.path.join(A, src + '.agentic_genie.png'), os.path.join(B, folder, fname + '.agentic_genie.png'))

# No connections/ folder and no project properties: recipes inherit Station A's reference to the shared
# "Workspace Connections/dewy_bank_customer_api.connection.json", and identity comes from that connection.
save('project.json', {'description': 'Dewy Bank workshop, Station B: Factor III (Intent-Based Communication). Two Genies with the same tool names, scope and rules; only the tool interface differs. B1 = wrapped API with raw IDs in and raw rows out, B2 = intent-shaped tools.',
                      'color': 'brown', 'icon': ''})
print('ok')
