"""Shapes that Workato needs at design time, shared by the station builders and checks.

Inside a foreach loop, Workato's own exports reach the current item through the
step that produced the list, with a current_item marker:
    {"line": "get_my_accounts", "path": ["accounts", {"path_element_type": "current_item"}, "name"]}
and the loop carries no schema of its own: the fields come from that step's output
(the connector's output_fields). A `provider: "foreach"` pill is resolved against the
loop step instead, and at activation Workato reported its fields missing ("Name").
`to_source_current_item` rewrites loops into the exported form.

That form needs a plain datapill as the loop's source. A loop whose source is a
formula (e.g. `.first(n)`) keeps `provider: "foreach"` pills and declares its item
fields itself; the field lists below mirror the connectors' object_definitions in
workspace-connections/, which are what the API returns.
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


def repoint_items(node, old_line, provider, line):
    """For a step copied into another recipe: point its current-item pills at that recipe's list step."""
    def swap(match):
        pill = json.loads(match.group(1))
        if pill.get('line') != old_line or {'path_element_type': 'current_item'} not in pill.get('path', []):
            return match.group(0)
        return "_dp('" + json.dumps({**pill, 'provider': provider, 'line': line}) + "')"
    return _rewrite_strings(node, lambda s: PILL.sub(swap, s))


def to_source_current_item(recipe):
    """Rewrite each plain-source loop's `provider: foreach` pills into Workato's exported form."""
    for loop in [s for s in walk(recipe['code']) if s.get('keyword') == 'foreach']:
        src = plain_source(loop)
        if not src:
            continue

        def swap(match, alias=loop['as'], src=src):
            pill = json.loads(match.group(1))
            if pill.get('provider') != 'foreach' or pill.get('line') != alias:
                return match.group(0)
            new = {'pill_type': 'output', 'provider': src['provider'], 'line': src['line'],
                   'path': src['path'] + [{'path_element_type': 'current_item'}] + pill['path']}
            return "_dp('" + json.dumps(new) + "')"

        loop['block'] = _rewrite_strings(loop['block'], lambda s: PILL.sub(swap, s))
        loop.pop('extended_output_schema', None)
    return recipe
