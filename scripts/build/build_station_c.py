"""Generate dewy-bank-station-c/ (the synced Station C folder) from dewy-bank-station-a/.

Run from anywhere: python3 scripts/build/build_station_c.py
It deletes and rewrites dewy-bank-station-c/, so edit this script, not the generated JSON.

Every tool lives in shared/ and is identical in C1 and C2:
- the three customer tools, copied from Station A (shared list_my_accounts + A2's
  read and write paths), relabeled because Factors II and III are held good here;
- the two support-agent tools, built here on the Dewy Bank Support API connector
  (workspace-connections/), which calls the Support API contract
  (docs/backend-requirements.md, C-P3).
Only the Genies differ (Factor IV): which skills each holds, and its instructions.
"""
import copy, json, os, re, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
A = os.path.join(ROOT, 'dewy-bank-station-a')
C = os.path.join(ROOT, 'dewy-bank-station-c')
SHARED, C1, C2 = 'shared', 'c1_flaw_shared_namespace_prompt_acl', 'c2_fix_namespace_per_role'
SUPPORT_CONN = {'custom': True, 'zip_name': 'Workspace Connections/dewy_bank_support_api.connection.json',
                'name': 'Dewy Bank Support API', 'folder': 'Workspace Connections'}
# The Support API custom connector (workspace-connections/dewy_bank_support_api.custom_adapter.*), as recipes reference it.
SUPPORT_GEN = 'dewy_bank_support_api_connector_2100009826_1792543221'
CREDIT_LIMIT = 100  # D5


def load(p):
    with open(os.path.join(A, p)) as f:
        return json.load(f)


def save(rel, obj):
    p = os.path.join(C, rel)
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


PARAM = lambda n: dp('workato_skill', 'trigger', ['parameters', n])


def walk(steps):
    for s in steps:
        yield s
        yield from walk(s.get('block', []))


def find(recipe, alias):
    for s in walk(recipe['code']['block']):
        if s.get('as') == alias:
            return s
    raise KeyError(alias)


def fld(name, label, typ='string', hint=None, eis=False, optional=True):
    if eis:
        f = {'control_type': 'number' if typ == 'number' else 'text', 'label': label, 'type': typ, 'name': name,
             'optional': True, 'extends_schema': False}
        if typ == 'number':
            f['parse_output'] = 'float_conversion'
        return f
    f = {'name': name, 'label': label, 'type': typ, 'optional': optional,
         'control_type': 'number' if typ == 'number' else 'text'}
    if hint:
        f['hint'] = hint
    return f


def arr(name, label, props, eis=False):
    if eis:
        return {'label': label, 'type': 'array', 'name': name, 'of': 'object', 'optional': True,
                'extends_schema': False, 'properties': props}
    return {'name': name, 'label': label, 'type': 'array', 'of': 'object', 'optional': True,
            'control_type': 'array', 'properties': props}


def obj(name, label, props):
    return {'name': name, 'label': label, 'type': 'object', 'optional': True, 'extends_schema': False,
            'properties': props}


def set_result(step, fields_eis, values, visible):
    """Rewrite a workflow_return_result step's result mapping + schemas."""
    step['input'] = {'result': values}
    sch = [{'extends_schema': False, 'label': 'Response', 'name': 'result', 'type': 'object',
            'properties': fields_eis}]
    step['extended_input_schema'] = copy.deepcopy(sch)
    step['extended_output_schema'] = copy.deepcopy(sch)
    step['visible_config_fields'] = ['result'] + ['result.' + v for v in visible]


def set_trigger(recipe, description, params, results):
    i = recipe['code']['input']
    i['description'] = description
    i['parameters_schema_json'] = json.dumps(params, separators=(',', ':'), ensure_ascii=False)
    i['result_schema_json'] = json.dumps(results, separators=(',', ':'), ensure_ascii=False)
    out = []
    for p in params:
        f = {'control_type': p['control_type'], 'label': p['label'], 'type': p['type'], 'name': p['name'],
             'optional': p['optional'], 'extends_schema': False}
        if p['type'] == 'number':
            f['parse_output'] = 'float_conversion'
        if 'hint' in p:
            f['hint'] = p['hint']
        out.append(f)
    recipe['code']['extended_output_schema'] = [{'extends_schema': False, 'label': 'Parameters',
                                                  'name': 'parameters', 'type': 'object', 'properties': out}]


def renumber(recipe):
    """Number steps in order; uuid = alias-kebab + number (or keep the uuid prefix for alias-less steps)."""
    old_to_new = {}
    for n, s in enumerate(walk(recipe['code']['block']), start=1):
        s['number'] = n
        prefix = s['as'].replace('_', '-') if s.get('as') else re.sub(r'-\d{3}$', '', s['uuid'])
        new = f'{prefix}-{n:03d}'
        old_to_new[s['uuid']] = new
        s['uuid'] = new
    text = json.dumps(recipe, ensure_ascii=False)
    for old, new in old_to_new.items():
        text = text.replace(f'"{old}:', f'"{new}:').replace(f'\\n{old}:', f'\\n{new}:')
    return json.loads(text)


def skill_file(recipe, folder, fname):
    name = recipe['name']
    return {'name': name, 'trigger_description': recipe['code']['input']['description'],
            'references': {'recipe_id': {'type': 'recipe', 'id': {
                'zip_name': f'{folder}/{fname}.recipe.json', 'name': name, 'folder': folder}}}}


# --- step builders --------------------------------------------------------------

def step_uuid(alias):
    return alias.replace('_', '-') + '-000'


def if_step(alias, operand, conditions, comment, block):
    return {'keyword': 'if', 'as': alias, 'input': {'operand': operand, 'type': 'compound', 'conditions': conditions},
            'block': block, 'comment': comment, 'uuid': step_uuid(alias), 'skip': False, 'number': 0}


def else_step(alias, block):
    return {'keyword': 'else', 'as': alias, 'input': {}, 'block': block, 'uuid': step_uuid(alias), 'skip': False, 'number': 0}


def foreach(alias, source, comment, block):
    return {'keyword': 'foreach', 'as': alias, 'input': {'source': source}, 'block': block, 'comment': comment,
            'uuid': step_uuid(alias), 'skip': False, 'number': 0}


def try_catch(try_uuid, body, catch_alias, catch_block):
    catch = {'keyword': 'catch', 'as': catch_alias, 'input': {'max_retry_count': '0', 'retry_interval': '2'},
             'block': catch_block, 'uuid': step_uuid(catch_alias), 'skip': False, 'number': 0}
    return {'keyword': 'try', 'input': {}, 'block': body + [catch], 'uuid': try_uuid, 'skip': False, 'number': 0}


def cond(operand, lhs, uuid, rhs=None):
    c = {'operand': operand, 'lhs': lhs, 'uuid': uuid}
    if rhs is not None:
        c['rhs'] = rhs
    return c


def result_step(alias, fields_eis, values, visible, comment):
    s = {'provider': 'workato_skill', 'name': 'workflow_return_result', 'as': alias, 'keyword': 'action',
         'comment': comment, 'uuid': step_uuid(alias), 'skip': False, 'number': 0}
    set_result(s, fields_eis, values, visible)
    return s


def connector_step(alias, action, inp, comment):
    """A step that calls one of the Dewy Bank Support API connector's actions (plain route calls, no checks)."""
    return {'provider': SUPPORT_GEN, 'name': action, 'as': alias, 'keyword': 'action', 'input': inp,
            'comment': comment, 'uuid': step_uuid(alias), 'skip': False, 'number': 0}


def new_recipe(name, description, config):
    return {'name': name, 'description': description, 'version': 1, 'private': True, 'concurrency': 1,
            'code': {'provider': 'workato_skill', 'name': 'start_workflow', 'as': 'trigger', 'keyword': 'trigger',
                     'input': {'requires_user_confirmation': 'false'},
                     'extended_output_schema': [], 'block': [],
                     'visible_config_fields': ['requires_user_confirmation', 'description', 'parameters_schema_json',
                                               'result_schema_json'],
                     'uuid': 'trigger-000', 'skip': False, 'number': 0},
            'config': config}


def relabel_held_good(recipe):
    """Comments copied from Station A: Factors II and III are held good at Station C."""
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


# --- customer tools: copied from Station A ------------------------------------

customer = {
    'list_my_accounts': load('shared/list_my_accounts.recipe.json'),
    'review_my_recent_activity': load('a2_fix_recipe_owns_the_write/review_my_recent_activity.recipe.json'),
    'move_between_my_accounts': load('a2_fix_recipe_owns_the_write/move_between_my_accounts.recipe.json'),
}
for r in customer.values():
    relabel_held_good(r)
customer['list_my_accounts']['description'] = "Station C, shared by C1 and C2. Customer tool, identical to Station A's: the signed-in customer's accounts by name. Calls the customer API as the participant (the Dewy Bank Customer API connector)."
customer['review_my_recent_activity']['description'] = "Station C, shared by C1 and C2. Customer tool, identical to Station A2's: one named account's recent activity, at most 20 entries, in customer terms (II and III held good). Memos pass through unchanged: they are the shared injection channel."
customer['move_between_my_accounts']['description'] = "Station C, shared by C1 and C2. Customer tool, identical to Station A2's: a move between two of the customer's accounts, behind the four write rules (II held good). Account names in, a plain-language outcome out (III held good)."

# --- support-agent tools: built against the Support API contract (C-P3) -------------

CONFIG_SKILL = {'keyword': 'application', 'provider': 'workato_skill', 'skip_validation': False, 'account_id': None}
CONFIG_SUPPORT = {'keyword': 'application', 'provider': SUPPORT_GEN, 'skip_validation': False, 'account_id': SUPPORT_CONN}
CONFIG_VAR = {'keyword': 'application', 'provider': 'workato_variable', 'skip_validation': False, 'account_id': None}
SCOPE_NOTE = "The support-agent key reaches only the support routes and the fictional customers (Factor IV: scope comes from the credential)."


def lookup_step(comment):
    return connector_step('get_customer_accounts', 'look_up_customer_accounts', {'email': param('customer_email')}, comment)


# look_up_customer_accounts
r = new_recipe('look_up_customer_accounts',
               "Station C, shared by C1 and C2. Support-agent tool: a customer's accounts by name, looked up by email. Calls the Support API with the support-agent key, which reaches only the fictional customers.",
               [CONFIG_SKILL, CONFIG_SUPPORT])
LOOKUP_RESULT = [('status', 'Status', 'completed or failed'), ('message', 'Message', 'Plain-language outcome to relay to the support agent'),
                 ('customer', 'Customer', "The customer's email")]
ACCT_OUT = [('name', 'Name', 'string'), ('currency', 'Currency', 'string'), ('balance', 'Balance', 'number')]
set_trigger(r,
    "Look up a Dewy Bank customer's accounts by their email, for a support agent helping that customer. Use this when "
    "the support agent asks about a customer's accounts or balances, or before issuing a goodwill credit when you need "
    "the exact account names. Returns a status (completed or failed), a plain-language message, the customer's email, "
    "and their accounts: name, currency and current balance.",
    [{'name': 'customer_email', 'label': 'Customer email', 'type': 'string', 'optional': False, 'control_type': 'text',
      'hint': "The customer's email address"}],
    [fld(n, l, hint=h) for n, l, h in LOOKUP_RESULT] + [arr('accounts', 'Accounts', [fld(n, l, t) for n, l, t in ACCT_OUT])])
LOOKUP_EIS = [fld(n, l, eis=True) for n, l, _ in LOOKUP_RESULT] + [arr('accounts', 'Accounts', [fld(n, l, t, eis=True) for n, l, t in ACCT_OUT], eis=True)]
src = ['accounts']
r['code']['block'] = [
    try_catch('try-lookup-000', [
        lookup_step('Look up the customer by email. ' + SCOPE_NOTE),
        result_step('return_customer_accounts', LOOKUP_EIS, {
            'status': 'completed',
            'message': '=' + dp(SUPPORT_GEN, 'get_customer_accounts', src) + '.length.to_s + " accounts for " + ' + PARAM('customer_email') + '.to_s + "."',
            'customer': param('customer_email'),
            'accounts': {'____source': pill(SUPPORT_GEN, 'get_customer_accounts', src),
                         **{n: pill(SUPPORT_GEN, 'get_customer_accounts', src + [{'path_element_type': 'current_item'}, n]) for n, _, _ in ACCT_OUT}}},
            ['status', 'message', 'customer', 'accounts', 'accounts.____source'] + ['accounts.' + n for n, _, _ in ACCT_OUT],
            'Interface held good (Factor III): accounts by name; accountId stays inside the recipe.'),
    ], 'catch_lookup_error', [
        result_step('return_failed', LOOKUP_EIS, {
            'status': 'failed',
            'message': 'The bank could not look up that customer: ' + pill('catch', 'catch_lookup_error', ['message']),
            'customer': param('customer_email')}, ['status', 'message', 'customer'],
            'For example, a customer the support-agent key can\'t reach (404). Return a typed result instead of failing the job.'),
    ]),
]
support = {'look_up_customer_accounts': renumber(r)}

# issue_goodwill_credit
a2_review = load('a2_fix_recipe_owns_the_write/review_my_recent_activity.recipe.json')
T_DECLARE_SEL = find(a2_review, 'declare_selected_account')
T_SET_SEL = find(a2_review, 'set_selected_account')
r = new_recipe('issue_goodwill_credit',
               f"Station C, shared by C1 and C2. Support-agent tool: a goodwill credit to one of a customer's accounts, behind three deterministic rules (positive amount, at most ${CREDIT_LIMIT}, a reason given; Factor II held good). Calls the Support API with the support-agent key, which reaches only the fictional customers.",
               [CONFIG_SKILL, CONFIG_SUPPORT, CONFIG_VAR])
CREDIT_RESULT = [('status', 'Status', 'string', 'completed, refused or failed'),
                 ('message', 'Message', 'string', 'Plain-language outcome to relay to the support agent'),
                 ('customer', 'Customer', 'string', None), ('account', 'Account', 'string', None), ('amount', 'Amount', 'number', None)]
set_trigger(r,
    "Issue a goodwill credit to one of a Dewy Bank customer's accounts, for a support agent. Use this when the support "
    "agent asks to credit, refund or compensate a customer. Identify the customer by email and the account by the name "
    "the customer sees, for example \"Everyday Checking\"; call look_up_customer_accounts first if you are not sure of "
    "the exact name. The amount is in US dollars; give a short reason. Returns a status (completed, refused or failed), "
    "a plain-language message to relay, and the customer, account and amount involved. If the status is refused or "
    "failed, no money was credited: explain the message instead of retrying with different values.",
    [{'name': 'customer_email', 'label': 'Customer email', 'type': 'string', 'optional': False, 'control_type': 'text',
      'hint': "The customer's email address"},
     {'name': 'account', 'label': 'Account', 'type': 'string', 'optional': False, 'control_type': 'text',
      'hint': "Name of the customer's account, as they see it (e.g. Everyday Checking)"},
     {'name': 'amount', 'label': 'Amount', 'type': 'number', 'optional': False, 'control_type': 'number',
      'hint': 'Amount in US dollars'},
     {'name': 'reason', 'label': 'Reason', 'type': 'string', 'optional': False, 'control_type': 'text',
      'hint': 'A short reason for the credit, as the support agent gave it'}],
    [fld(n, l, t, h) for n, l, t, h in CREDIT_RESULT])
CREDIT_EIS = [fld(n, l, t, eis=True) for n, l, t, _ in CREDIT_RESULT]
CREDIT_VIS = [n for n, _, _, _ in CREDIT_RESULT]
SEL_ID = pill('workato_variable', 'declare_selected_account', ['account_id'])
SEL_NAME = pill('workato_variable', 'declare_selected_account', ['account_name'])
AMOUNT = PARAM('amount')


def refusal(alias, message, comment):
    return result_step(alias, CREDIT_EIS, {'status': 'refused', 'message': message, 'customer': param('customer_email'),
                                           'account': param('account'), 'amount': param('amount')}, CREDIT_VIS, comment)


set_sel = copy.deepcopy(T_SET_SEL)
set_sel['comment'] = "Remember the customer's account."
declare_sel = copy.deepcopy(T_DECLARE_SEL)
declare_sel['comment'] = 'The account the support agent named, resolved among the customer\'s accounts. The model never supplies an account ID; the recipe looks it up.'
NAME_MATCH = ('=' + dp('foreach', 'for_each_account', ['name']) + '.to_s.strip.downcase == ' + PARAM('account') + '.to_s.strip.downcase')
r['code']['block'] = [
    try_catch('try-credit-000', [
        lookup_step("Look up the customer's accounts so the account name can be resolved to an ID inside the recipe (Factor III held good). " + SCOPE_NOTE),
        declare_sel,
        foreach('for_each_account', pill(SUPPORT_GEN, 'get_customer_accounts', ['accounts']),
                "Resolve the account name among the customer's accounts.", [
            if_step('if_account_match', 'and', [cond('is_true', NAME_MATCH, 'account-name-matches')],
                    'Find the account by the name the support agent used.', [set_sel]),
        ]),
        if_step('if_account_found', 'and', [cond('present', SEL_ID, 'account-found', '')],
                'The name must resolve to one of the customer\'s accounts before anything else happens.', [
            if_step('if_amount_positive', 'and', [cond('is_true', '=' + AMOUNT + '.to_f > 0', 'amount-positive')],
                    'Write path held good (Factor II): each credit rule is a deterministic step that does not depend on the model or the prompt. Credit rule 1: the amount must be positive.', [
                if_step('if_within_credit_limit', 'and', [cond('is_true', f'=' + AMOUNT + f'.to_f <= {CREDIT_LIMIT}', 'amount-within-credit-limit')],
                        f'Credit rule 2 (Factor II held good): at most ${CREDIT_LIMIT} per goodwill credit.', [
                    if_step('if_reason_given', 'and', [cond('present', param('reason'), 'reason-given', '')],
                            'Credit rule 3 (Factor II held good): a reason must be given.', [
                        connector_step('post_adjustment', 'adjust_balance', {
                            'email': param('customer_email'), 'account_id': SEL_ID,
                            'amount': '=' + AMOUNT + '.to_f', 'reason': param('reason'),
                        }, 'All three rules passed: the recipe, not the model, decided this credit is allowed. ' + SCOPE_NOTE),
                        result_step('return_completed', CREDIT_EIS, {
                            'status': 'completed',
                            'message': '="Credited " + ' + dp(SUPPORT_GEN, 'post_adjustment', ['amount']) + '.to_f.to_currency + " to " + '
                                       + dp('workato_variable', 'declare_selected_account', ['account_name']) + ' + " for " + '
                                       + PARAM('customer_email') + '.to_s + ". New balance: " + '
                                       + dp(SUPPORT_GEN, 'post_adjustment', ['balance']) + '.to_f.to_currency + "."',
                            'customer': param('customer_email'), 'account': SEL_NAME,
                            'amount': pill(SUPPORT_GEN, 'post_adjustment', ['amount'])}, CREDIT_VIS,
                            'A domain outcome, not the raw API body (Factor III held good).'),
                        else_step('else_reason_given', [refusal('refuse_no_reason',
                            'Nothing was credited: give a short reason for the goodwill credit.', 'Credit rule 3 failed.')]),
                    ]),
                    else_step('else_within_credit_limit', [refusal('refuse_over_credit_limit',
                        f'Nothing was credited: goodwill credits are limited to ${CREDIT_LIMIT} each.', 'Credit rule 2 failed.')]),
                ]),
                else_step('else_amount_positive', [refusal('refuse_amount_not_positive',
                    'Nothing was credited: the amount must be more than $0.', 'Credit rule 1 failed.')]),
            ]),
            else_step('else_account_found', [refusal('refuse_account_not_found',
                '="Nothing was credited: \'" + ' + PARAM('account') + '.to_s + "\' doesn\'t match one of " + '
                + PARAM('customer_email') + '.to_s + "\'s accounts. Use look_up_customer_accounts to get the exact names."',
                'A plain-language refusal, not an error (Factor III held good).')]),
        ]),
    ], 'catch_credit_error', [
        result_step('return_failed', CREDIT_EIS, {
            'status': 'failed',
            'message': 'The bank did not complete this credit: ' + pill('catch', 'catch_credit_error', ['message']),
            'customer': param('customer_email'), 'account': param('account'), 'amount': param('amount')}, CREDIT_VIS,
            "For example, a customer the support-agent key can't reach (404). Return a typed result instead of failing the job."),
    ]),
]
support['issue_goodwill_credit'] = renumber(r)

# --- write the project --------------------------------------------------------

if os.path.exists(C):
    shutil.rmtree(C)
for name, recipe in {**customer, **support}.items():
    save(f'{SHARED}/{name}.recipe.json', recipe)
    save(f'{SHARED}/{name}.agentic_skill.json', skill_file(recipe, SHARED, name))


def block(path, tag):
    text = open(os.path.join(ROOT, 'docs', path)).read()
    return text.split(f'<!-- {tag} -->')[1].strip('\n')


CUSTOMER_TEXT = block('station-a/genie-instructions.md', 'instructions')
C1_TEXT = ' '.join([CUSTOMER_TEXT, block('station-c/genie-instructions.md', 'c1-support-duties'),
                    block('station-c/genie-instructions.md', 'c1-access-rule')])
SUPPORT_TEXT = block('station-c/genie-instructions.md', 'support')
# The support Genie gets its own Dewy (in a cap), so the two C2 roles are easy to tell apart in Agent Studio.
LOGOS = {'dewy_bank_support_assistant_c2_fix': os.path.join(HERE, 'templates', 'logos', 'dewy-support-agent.png')}
CUSTOMER_TOOLS = ['list_my_accounts', 'review_my_recent_activity', 'move_between_my_accounts']
SUPPORT_TOOLS = ['look_up_customer_accounts', 'issue_goodwill_credit']
for folder, src, fname, title, desc, text, tools in (
    (C1, 'a1_flaw_agent_owns_the_write/dewy_bank_assistant_a1_flaw', 'dewy_bank_assistant_c1_flaw', 'Dewy Bank Assistant · C1 flaw',
     "Station C, C1 (flaw): one Genie for the customer and the support agent. It holds the customer tools and the support-agent tools, and with them both credentials (the participant's token and the support-agent key). Only a passphrase in its instructions is meant to keep customers away from the support tools (prompt-as-ACL).",
     C1_TEXT, CUSTOMER_TOOLS + SUPPORT_TOOLS),
    (C2, 'a2_fix_recipe_owns_the_write/dewy_bank_assistant_a2_fix', 'dewy_bank_assistant_c2_fix', 'Dewy Bank Assistant · C2 fix',
     "Station C, C2 (fix): the customer's Genie. Only the customer tools, and with them only the participant's own credential. No access rules in its instructions: the support tools don't exist in this Genie.",
     CUSTOMER_TEXT, CUSTOMER_TOOLS),
    (C2, 'a2_fix_recipe_owns_the_write/dewy_bank_assistant_a2_fix', 'dewy_bank_support_assistant_c2_fix', 'Dewy Bank Support · C2 fix',
     "Station C, C2 (fix): the support agent's Genie. Only the support-agent tools, and with them only the support-agent key. No access rules in its instructions.",
     SUPPORT_TEXT, SUPPORT_TOOLS),
):
    g = load(src + '.agentic_genie.json')
    g['name'], g['description'] = title, desc
    g['instructions'] = g['raw_instructions'] = text + '\n'
    g['references'] = {f'ref_{i}': {'type': 'agentic_skill', 'id': {
        'zip_name': f'{SHARED}/{n}.agentic_skill.json', 'name': n, 'folder': SHARED}} for i, n in enumerate(tools)}
    logo = LOGOS.get(fname)
    if logo:
        g['logo_file_name'] = os.path.basename(logo)
    save(f'{folder}/{fname}.agentic_genie.json', g)
    shutil.copy(logo or os.path.join(A, src + '.agentic_genie.png'), os.path.join(C, folder, fname + '.agentic_genie.png'))

save('project.json', {'description': 'Dewy Bank workshop, Station C: Factor IV (Bounded Access). The same five tools in both variants; only the Genies differ. C1 = one Genie with customer and support-agent tools, guarded by a passphrase in its instructions; C2 = a customer Genie and a support Genie, each holding only its own tools and credential.',
                      'color': 'brown', 'icon': ''})
print('ok')
