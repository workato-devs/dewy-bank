import * as fs from 'fs';
import * as path from 'path';
import {
  SEED_TXNS,
  SHARED_PAYLOAD,
  FICTIONAL_CUSTOMERS,
  SEED_ACCOUNTS,
} from '../lambda/shared/seed';
import { MEMO_MAX_LENGTH, parseMemo } from '../lambda/shared/memo';

const memoList = fs.readFileSync(
  path.join(__dirname, '..', '..', 'docs', 'memo-list.md'),
  'utf8',
);

test('the seeded payload is the one in docs/memo-list.md §2a (its only source)', () => {
  const quoted = [...memoList.matchAll(/^> `([^`]+)`$/gm)].map((m) => m[1]);
  expect(quoted).toHaveLength(1);
  expect(SHARED_PAYLOAD).toBe(quoted[0]);
});

test('every seeded memo fits the memo cap', () => {
  for (const t of SEED_TXNS) expect(parseMemo(t.memo).ok).toBe(true);
  expect([...SHARED_PAYLOAD].length).toBeLessThanOrEqual(MEMO_MAX_LENGTH);
});

test('P2b: the seed includes one incoming payment on checking with the shared memo', () => {
  const rows = SEED_TXNS.filter((t) => t.memo === SHARED_PAYLOAD);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ acct: 'checking', type: 'credit', amountCents: 50, daysAgo: 1 });
});

test('C-P4: fictional customers match the spec (names, emails, balances)', () => {
  const byId = Object.fromEntries(FICTIONAL_CUSTOMERS.map((c) => [c.customerId, c]));
  expect(Object.keys(byId).sort()).toEqual(['fictional-jane', 'fictional-mei', 'fictional-omar']);
  expect(byId['fictional-jane'].accounts.map((a) => a.balanceCents)).toEqual([58_20, 1_240_00, -412_75]);
  expect(byId['fictional-omar'].accounts.map((a) => a.suffix)).toEqual(['checking', 'savings']);
  expect(byId['fictional-mei'].accounts.map((a) => a.suffix)).toEqual(['checking', 'credit']);
  for (const c of FICTIONAL_CUSTOMERS) {
    expect(c.email.endsWith('@example.com')).toBe(true);
    // Same names and types as the sign-up seed, so support tools look like customer tools.
    for (const a of c.accounts) {
      const seed = SEED_ACCOUNTS.find((s) => s.suffix === a.suffix)!;
      expect(a).toMatchObject({ name: seed.name, type: seed.type });
    }
  }
});

test('parseMemo: optional, string-only, refuses (never truncates) past the cap', () => {
  expect(parseMemo(undefined)).toEqual({ ok: true, memo: undefined });
  expect(parseMemo(null)).toEqual({ ok: true, memo: undefined });
  expect(parseMemo('  as sent <b>  ')).toEqual({ ok: true, memo: '  as sent <b>  ' });
  expect(parseMemo(42).ok).toBe(false);
  expect(parseMemo('x'.repeat(MEMO_MAX_LENGTH)).ok).toBe(true);
  expect(parseMemo('x'.repeat(MEMO_MAX_LENGTH + 1)).ok).toBe(false);
  expect(parseMemo('🙂'.repeat(MEMO_MAX_LENGTH)).ok).toBe(true); // code points, not UTF-16 units
});
