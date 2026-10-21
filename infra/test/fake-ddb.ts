/**
 * A small in-memory stand-in for the DynamoDB DocumentClient, for handler tests.
 * It understands only the commands and expressions the Lambdas use; anything
 * else throws, so a test fails loudly instead of passing on a silent no-op.
 */

type Item = Record<string, any>;
type TableDef = { pk: string; sk?: string; indexes?: Record<string, string> };

export class FakeDdb {
  tables: Record<string, { def: TableDef; items: Map<string, Item> }> = {};
  calls: { name: string; input: any }[] = [];

  define(name: string, def: TableDef) {
    this.tables[name] = { def, items: new Map() };
  }

  private table(name: string) {
    const t = this.tables[name];
    if (!t) throw new Error(`FakeDdb: unknown table ${name}`);
    return t;
  }

  private key(def: TableDef, item: Item) {
    return def.sk ? `${item[def.pk]}|${item[def.sk]}` : String(item[def.pk]);
  }

  put(table: string, item: Item) {
    const t = this.table(table);
    t.items.set(this.key(t.def, item), structuredClone(item));
  }

  get(table: string, key: Item): Item | undefined {
    const t = this.table(table);
    return t.items.get(this.key(t.def, key));
  }

  all(table: string): Item[] {
    return [...this.table(table).items.values()];
  }

  send = async (cmd: any): Promise<any> => {
    const name = cmd.constructor.name as string;
    const input = cmd.input;
    this.calls.push({ name, input });
    switch (name) {
      case 'GetCommand':
        return { Item: structuredClone(this.get(input.TableName, input.Key)) };
      case 'PutCommand':
        this.checkPutCondition(input);
        this.put(input.TableName, input.Item);
        return {};
      case 'DeleteCommand':
        this.delete(input.TableName, input.Key);
        return {};
      case 'QueryCommand':
        return { Items: this.query(input) };
      case 'ScanCommand':
        return { Items: this.all(input.TableName).map((i) => structuredClone(i)) };
      case 'UpdateCommand':
        return { Attributes: structuredClone(this.update(input)) };
      case 'TransactWriteCommand':
        return this.transact(input);
      case 'BatchWriteCommand':
        for (const [tableName, reqs] of Object.entries(input.RequestItems as Record<string, any[]>)) {
          for (const r of reqs) {
            if (r.PutRequest) this.put(tableName, r.PutRequest.Item);
            else if (r.DeleteRequest) this.delete(tableName, r.DeleteRequest.Key);
            else throw new Error('FakeDdb: unsupported batch request');
          }
        }
        return { UnprocessedItems: {} };
      default:
        throw new Error(`FakeDdb: unsupported command ${name}`);
    }
  };

  private delete(table: string, key: Item) {
    const t = this.table(table);
    t.items.delete(this.key(t.def, key));
  }

  private checkPutCondition(input: any) {
    const cond: string | undefined = input.ConditionExpression;
    if (!cond) return;
    const m = cond.match(/^attribute_not_exists\((\w+)\)$/);
    if (!m) throw new Error(`FakeDdb: unsupported condition ${cond}`);
    const t = this.table(input.TableName);
    if (t.items.has(this.key(t.def, input.Item))) throw conditionalFailed();
  }

  private query(input: any): Item[] {
    const t = this.table(input.TableName);
    const m = String(input.KeyConditionExpression).match(/^(\w+) = (:\w+)$/);
    if (!m) throw new Error(`FakeDdb: unsupported key condition ${input.KeyConditionExpression}`);
    const [, attr, ph] = m;
    const value = input.ExpressionAttributeValues[ph];
    if (input.IndexName && t.def.indexes?.[input.IndexName] !== attr) {
      throw new Error(`FakeDdb: index ${input.IndexName} isn't keyed on ${attr}`);
    }
    let items = [...t.items.values()].filter((i) => i[attr] === value);
    if (t.def.sk) {
      items.sort((a, b) => String(a[t.def.sk!]).localeCompare(String(b[t.def.sk!])));
      if (input.ScanIndexForward === false) items.reverse();
    }
    if (input.Limit) items = items.slice(0, input.Limit);
    return items.map((i) => structuredClone(i));
  }

  private update(input: any): Item {
    const t = this.table(input.TableName);
    const existing = this.get(input.TableName, input.Key);
    const cond: string | undefined = input.ConditionExpression;
    if (cond) {
      if (!/^attribute_exists\(\w+\)$/.test(cond)) throw new Error(`FakeDdb: unsupported condition ${cond}`);
      if (!existing) throw conditionalFailed();
    }
    const item: Item = existing ? { ...existing } : { ...input.Key };
    const v = input.ExpressionAttributeValues ?? {};
    const m = String(input.UpdateExpression).match(/^SET (\w+) = (.+)$/);
    if (!m) throw new Error(`FakeDdb: unsupported update ${input.UpdateExpression}`);
    const [, attr, expr] = m;
    let r: RegExpMatchArray | null;
    if ((r = expr.match(/^(\w+) ([+-]) (:\w+)$/)) && r[1] === attr) {
      if (item[attr] === undefined) throw new Error(`FakeDdb: ${attr} missing for arithmetic`);
      item[attr] = r[2] === '+' ? item[attr] + v[r[3]] : item[attr] - v[r[3]];
    } else if ((r = expr.match(/^if_not_exists\((\w+), (:\w+)\) \+ (:\w+)$/))) {
      item[attr] = (item[r[1]] ?? v[r[2]]) + v[r[3]];
    } else if ((r = expr.match(/^(:\w+)$/))) {
      item[attr] = v[r[1]];
    } else {
      throw new Error(`FakeDdb: unsupported update expression ${expr}`);
    }
    t.items.set(this.key(t.def, item), item);
    return item;
  }

  private transact(input: any) {
    const keys = new Set<string>();
    for (const op of input.TransactItems) {
      const o = op.Update ?? op.Put;
      const t = this.table(o.TableName);
      const k = `${o.TableName}#${this.key(t.def, op.Update ? o.Key : o.Item)}`;
      // Real DynamoDB rejects a transaction that touches one item twice.
      if (keys.has(k)) throw Object.assign(new Error('Transaction request cannot include multiple operations on one item'), { name: 'ValidationException' });
      keys.add(k);
    }
    const snapshot = Object.fromEntries(Object.entries(this.tables).map(([n, t]) => [n, new Map(t.items)]));
    try {
      for (const op of input.TransactItems) {
        if (op.Update) this.update(op.Update);
        else if (op.Put) this.put(op.Put.TableName, op.Put.Item);
        else throw new Error('FakeDdb: unsupported transact op');
      }
    } catch (err) {
      for (const [n, items] of Object.entries(snapshot)) this.tables[n].items = items;
      throw err;
    }
    return {};
  }
}

function conditionalFailed() {
  return Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
}

/** The Dewy Bank tables, as the stack defines them. */
export function bankTables(): FakeDdb {
  const db = new FakeDdb();
  db.define('Customers', { pk: 'customerId', indexes: { 'email-index': 'email' } });
  db.define('Accounts', { pk: 'accountId', indexes: { 'owner-index': 'customerId' } });
  db.define('Transactions', { pk: 'accountId', sk: 'txnId' });
  db.define('Statements', { pk: 'accountId', sk: 'statementId' });
  db.define('GenieClients', { pk: 'customerId' });
  return db;
}

export const TABLE_ENV = {
  CUSTOMERS_TABLE: 'Customers',
  ACCOUNTS_TABLE: 'Accounts',
  TRANSACTIONS_TABLE: 'Transactions',
  STATEMENTS_TABLE: 'Statements',
  GENIE_CLIENTS_TABLE: 'GenieClients',
};
