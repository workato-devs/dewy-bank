"""Shapes that Workato needs at design time, shared by the station builders and checks.

Inside a foreach loop, the body reads the current item from the loop step itself:
    {"provider": "foreach", "line": "for_each_account", "path": ["name"]}
A pill through the step that produced the list, with a current_item marker
    {"line": "get_my_accounts", "path": ["accounts", {"path_element_type": "current_item"}, "name"]}
is the list-mapping form (`____source`): in a loop it reads the list's first item on
every pass (job traces, 2026-10-22: every insert wrote the newest transaction, and every
pass fetched the first account). `to_loop_item` rewrites loops into the loop form.

The loop's source must be a plain datapill: the platform rejects a formula there
("Source does not support formula-mode"). A loop's item fields come from its source
step's output (the connector's output_fields); the field lists below mirror the
connectors' object_definitions in workspace-connections/, which are what the API returns.

Every connector step carries its action's output fields (`extended_output_schema`).
An import doesn't derive them from the custom connector's output_fields, so a step
without them has no outputs at activation ("Unknown data field 'Accounts'", observed
2026-10-21). ACTION_OUTPUTS mirrors each action's output_fields;
`add_output_schemas` writes them onto the steps.
"""
import json
import re

# (name, label, type) per item, as each connector action returns its list.
ACCOUNT = [('accountId', 'Account ID', 'string'), ('customerId', 'Customer ID', 'string'), ('name', 'Name', 'string'),
           ('type', 'Type', 'string'), ('currency', 'Currency', 'string'), ('balance', 'Balance', 'number')]
TRANSACTION = [('txnId', 'Transaction ID', 'string'), ('accountId', 'Account ID', 'string'), ('type', 'Type', 'string'),
               ('amount', 'Amount', 'number'), ('counterparty', 'Counterparty', 'string'), ('memo', 'Memo', 'string'),
               ('channel', 'Channel', 'string'), ('category', 'Category', 'string'), ('createdAt', 'Created at', 'string')]
SUPPORT_ACCOUNT = [('accountId', 'Account ID', 'string'), ('name', 'Name', 'string'), ('type', 'Type', 'string'),
                   ('currency', 'Currency', 'string'), ('balance', 'Balance', 'number')]

# Which item fields a loop gets, by the (step alias, list) its source reads.
LOOP_ITEMS = {
    ('get_my_accounts', 'accounts'): ACCOUNT,
    ('get_account_activity', 'transactions'): TRANSACTION,
    ('get_customer_accounts', 'accounts'): SUPPORT_ACCOUNT,
}


def item_schema(fields):
    out = []
    for name, label, typ in fields:
        f = {'control_type': 'number' if typ == 'number' else 'text', 'label': label, 'type': typ, 'name': name,
             'optional': True, 'extends_schema': False}
        if typ == 'number':
            f['parse_output'] = 'float_conversion'
        out.append(f)
    return out


def _list(name, label, fields):
    return {'name': name, 'label': label, 'type': 'array', 'of': 'object', 'optional': True,
            'properties': item_schema(fields)}


def _object(name, label, fields):
    return {'name': name, 'label': label, 'type': 'object', 'optional': True, 'properties': item_schema(fields)}


# Each connector action's output_fields, by action name (the names are unique across both connectors).
ACTION_OUTPUTS = {
    'list_accounts': [_list('accounts', 'Accounts', ACCOUNT)],
    'list_account_transactions': [_list('transactions', 'Transactions', TRANSACTION)],
    'create_transfer': item_schema([('message', 'Message', 'string'), ('from', 'From', 'string'),
                                    ('to', 'To', 'string'), ('amount', 'Amount', 'number')]),
    'create_payment': item_schema([('message', 'Message', 'string'), ('from', 'From', 'string'),
                                   ('to_email', 'To email', 'string'), ('amount', 'Amount', 'number')]),
    'look_up_customer_accounts': [_object('customer', 'Customer', [('email', 'Email', 'string')]),
                                  _list('accounts', 'Accounts', SUPPORT_ACCOUNT)],
    'adjust_balance': item_schema([('message', 'Message', 'string'), ('account_id', 'Account ID', 'string'),
                                   ('amount', 'Amount', 'number'), ('balance', 'Balance', 'number')]),
}
CONNECTOR_PROVIDER = re.compile(r'^dewy_bank_(customer|support)_api_connector_')


def add_output_schemas(recipe):
    """Give every connector step its action's output fields."""
    for step in walk(recipe['code']):
        if CONNECTOR_PROVIDER.match(step.get('provider') or ''):
            step['extended_output_schema'] = ACTION_OUTPUTS[step['name']]
    return recipe


PLAIN_PILL = re.compile(r"^#\{_dp\('(\{.*\})'\)\}$", re.S)
PILL = re.compile(r"_dp\('(\{.*?\})'\)", re.S)


def plain_source(step):
    """The loop's source pill as a dict, or None when the source is a formula."""
    m = PLAIN_PILL.match(step['input']['source'])
    return json.loads(m.group(1)) if m else None


def complete_foreach(step, fields):
    """Give a foreach step the full shape: repeat mode and top-level source; an item schema only
    when its source is a formula (a plain source's fields come from the source step itself)."""
    step['repeat_mode'] = step.get('repeat_mode') or 'simple'
    step['source'] = step['input']['source']
    if plain_source(step):
        step.pop('extended_output_schema', None)
    else:
        step['extended_output_schema'] = item_schema(fields)
    return step


def walk(step):
    yield step
    for child in step.get('block', []):
        yield from walk(child)


def _rewrite_strings(node, fn):
    if isinstance(node, dict):
        return {k: _rewrite_strings(v, fn) for k, v in node.items()}
    if isinstance(node, list):
        return [_rewrite_strings(v, fn) for v in node]
    return fn(node) if isinstance(node, str) else node


CURRENT_ITEM = {'path_element_type': 'current_item'}


def reads_source_item(pill, src):
    """Whether a pill reads the current item of the loop source `src` through its source step."""
    n = len(src['path'])
    return (pill.get('provider') == src['provider'] and pill.get('line') == src['line']
            and pill.get('path', [])[:n + 1] == src['path'] + [CURRENT_ITEM])


def to_loop_item(recipe):
    """Rewrite each plain-source loop's body to read its item from the loop step (`provider: foreach`)."""
    for loop in [s for s in walk(recipe['code']) if s.get('keyword') == 'foreach']:
        src = plain_source(loop)
        if not src:
            continue

        def swap(match, alias=loop['as'], src=src):
            pill = json.loads(match.group(1))
            if not reads_source_item(pill, src):
                return match.group(0)
            new = {'pill_type': 'output', 'provider': 'foreach', 'line': alias, 'path': pill['path'][len(src['path']) + 1:]}
            return "_dp('" + json.dumps(new) + "')"

        loop['block'] = _rewrite_strings(loop['block'], lambda s: PILL.sub(swap, s))
        loop.pop('extended_output_schema', None)
    return recipe
