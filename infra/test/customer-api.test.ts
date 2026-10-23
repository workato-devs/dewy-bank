import { bankTables, TABLE_ENV, FakeDdb } from "./fake-ddb";

let db: FakeDdb;
const lambdaSend = jest.fn(async (_cmd: any) => ({}));

jest.mock("@aws-sdk/lib-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/lib-dynamodb");
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: () => ({ send: (cmd: any) => db.send(cmd) }),
    },
  };
});
jest.mock("@aws-sdk/client-lambda", () => {
  const actual = jest.requireActual("@aws-sdk/client-lambda");
  return { ...actual, LambdaClient: jest.fn(() => ({ send: lambdaSend })) };
});

Object.assign(process.env, TABLE_ENV, {
  PROVISIONING_FN: "dewybank-test-provisioning",
});
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handler } = require("../lambda/customer-api-handler");

const ALICE = "sub-alice";
const BOB = "sub-bob";
const aliceChecking = `acct-${ALICE}-checking`;
const aliceSavings = `acct-${ALICE}-savings`;
const bobChecking = `acct-${BOB}-checking`;

beforeEach(() => {
  db = bankTables();
  db.put("Customers", { customerId: ALICE, email: "alice@example.org" });
  db.put("Customers", { customerId: BOB, email: "bob@example.org" });
  db.put("Accounts", {
    accountId: aliceChecking,
    customerId: ALICE,
    type: "checking",
    name: "Everyday Checking",
    currency: "USD",
    balanceCents: 100_00,
  });
  db.put("Accounts", {
    accountId: aliceSavings,
    customerId: ALICE,
    type: "savings",
    name: "High-Yield Savings",
    currency: "USD",
    balanceCents: 500_00,
  });
  db.put("Accounts", {
    accountId: bobChecking,
    customerId: BOB,
    type: "checking",
    name: "Everyday Checking",
    currency: "USD",
    balanceCents: 20_00,
  });
  lambdaSend.mockClear();
});

function call(
  method: string,
  path: string,
  body?: unknown,
  claims: Record<string, unknown> = { sub: ALICE, email: "alice@example.org" },
) {
  return handler({
    requestContext: { http: { method, path }, authorizer: { jwt: { claims } } },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r: any) => ({ status: r.statusCode, body: JSON.parse(r.body) }));
}

const balance = (id: string) =>
  db.get("Accounts", { accountId: id })!.balanceCents;
const rowsFor = (id: string) =>
  db.all("Transactions").filter((t) => t.accountId === id);

describe("POST /transfers", () => {
  test("moves money between the caller’s accounts and records both legs", async () => {
    const r = await call("POST", "/transfers", {
      from: aliceChecking,
      to: aliceSavings,
      amount: 10,
      memo: "Rainy day fund",
    });
    expect(r).toEqual({
      status: 200,
      body: {
        message: "Transfer complete",
        from: aliceChecking,
        to: aliceSavings,
        amount: 10,
      },
    });
    expect(balance(aliceChecking)).toBe(90_00);
    expect(balance(aliceSavings)).toBe(510_00);
    expect(rowsFor(aliceChecking)).toEqual([
      expect.objectContaining({
        type: "debit",
        amountCents: 10_00,
        memo: "Rainy day fund",
        channel: "customer-transfer",
      }),
    ]);
    expect(rowsFor(aliceSavings)).toEqual([
      expect.objectContaining({
        type: "credit",
        amountCents: 10_00,
        memo: "Rainy day fund",
        channel: "customer-transfer",
      }),
    ]);
  });

  test("the memo is optional", async () => {
    expect(
      (
        await call("POST", "/transfers", {
          from: aliceChecking,
          to: aliceSavings,
          amount: 5,
        })
      ).status,
    ).toBe(200);
    expect(rowsFor(aliceChecking)[0].memo).toBeUndefined();
  });

  test("a transfer to the same account records both rows and keeps the balance", async () => {
    expect(
      (
        await call("POST", "/transfers", {
          from: aliceChecking,
          to: aliceChecking,
          amount: 25,
        })
      ).status,
    ).toBe(200);
    expect(balance(aliceChecking)).toBe(100_00);
    expect(
      rowsFor(aliceChecking)
        .map((t) => t.type)
        .sort(),
    ).toEqual(["credit", "debit"]);
  });

  test("a request with a missing field gets 400", async () => {
    expect(
      (await call("POST", "/transfers", { from: aliceChecking, amount: 1 }))
        .status,
    ).toBe(400);
  });
});

describe("POST /payments", () => {
  test("pays another customer into their checking, with emails as counterparties", async () => {
    const r = await call("POST", "/payments", {
      from: aliceChecking,
      to_email: "bob@example.org",
      amount: 12.5,
      memo: "Dinner",
    });
    expect(r).toEqual({
      status: 200,
      body: {
        message: "Payment sent",
        from: aliceChecking,
        to_email: "bob@example.org",
        amount: 12.5,
      },
    });
    expect(balance(aliceChecking)).toBe(87_50);
    expect(balance(bobChecking)).toBe(32_50);
    expect(rowsFor(aliceChecking)).toEqual([
      expect.objectContaining({
        type: "debit",
        counterparty: "bob@example.org",
        memo: "Dinner",
        channel: "customer-payment",
      }),
    ]);
    expect(rowsFor(bobChecking)).toEqual([
      expect.objectContaining({
        type: "credit",
        counterparty: "alice@example.org",
        memo: "Dinner",
        channel: "customer-payment",
      }),
    ]);
  });

  test("finds the recipient whatever case the email is typed in", async () => {
    expect(
      (
        await call("POST", "/payments", {
          from: aliceChecking,
          to_email: "Bob@Example.org",
          amount: 1,
        })
      ).status,
    ).toBe(200);
    expect(balance(bobChecking)).toBe(21_00);
  });

  test("an unknown recipient gets 404", async () => {
    expect(
      (
        await call("POST", "/payments", {
          from: aliceChecking,
          to_email: "nobody@example.org",
          amount: 1,
        })
      ).status,
    ).toBe(404);
  });
});

describe("reading activity", () => {
  test("GET /accounts/{id}/transactions returns memo and channel, newest first", async () => {
    await call("POST", "/transfers", {
      from: aliceChecking,
      to: aliceSavings,
      amount: 1,
      memo: "first",
    });
    await new Promise((r) => setTimeout(r, 5));
    await call("POST", "/payments", {
      from: aliceChecking,
      to_email: "bob@example.org",
      amount: 2,
      memo: "second",
    });
    const r = await call("GET", `/accounts/${aliceChecking}/transactions`);
    expect(r.status).toBe(200);
    expect(r.body.transactions.map((t: any) => [t.memo, t.channel])).toEqual([
      ["second", "customer-payment"],
      ["first", "customer-transfer"],
    ]);
  });
});

describe("GET /payees", () => {
  test("returns an empty list when no payees are saved", async () => {
    const r = await call("GET", "/payees");
    expect(r).toEqual({ status: 200, body: { payees: [] } });
  });

  test("returns saved payees newest first", async () => {
    db.put("Payees", {
      customerId: ALICE,
      email: "bob@example.org",
      addedAt: "2026-01-01T00:00:00.000Z",
    });
    db.put("Payees", {
      customerId: ALICE,
      email: "carol@example.org",
      addedAt: "2026-06-01T00:00:00.000Z",
    });
    const r = await call("GET", "/payees");
    expect(r.status).toBe(200);
    expect(r.body.payees.map((p: any) => p.email)).toEqual([
      "carol@example.org",
      "bob@example.org",
    ]);
  });
});

describe("POST /payees", () => {
  test("adds a payee and returns 201", async () => {
    const r = await call("POST", "/payees", { email: "bob@example.org" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ email: "bob@example.org" });
    expect(db.all("Payees")).toEqual([
      expect.objectContaining({ customerId: ALICE, email: "bob@example.org" }),
    ]);
  });

  test("re-adding an existing payee returns 200 (idempotent)", async () => {
    db.put("Payees", {
      customerId: ALICE,
      email: "bob@example.org",
      addedAt: "2026-01-01T00:00:00.000Z",
    });
    const r = await call("POST", "/payees", { email: "bob@example.org" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ email: "bob@example.org" });
  });

  test("returns 404 if the email is not a Dewy Bank customer", async () => {
    const r = await call("POST", "/payees", { email: "nobody@example.org" });
    expect(r.status).toBe(404);
  });

  test("returns 400 for a malformed email", async () => {
    const r = await call("POST", "/payees", { email: "not-an-email" });
    expect(r.status).toBe(400);
  });
});

describe("DELETE /payees/{email}", () => {
  test("removes a payee and returns 204 with an empty body", async () => {
    db.put("Payees", {
      customerId: ALICE,
      email: "bob@example.org",
      addedAt: "2026-01-01T00:00:00.000Z",
    });
    const raw = await handler({
      requestContext: {
        http: { method: "DELETE", path: "/payees/bob%40example.org" },
        authorizer: {
          jwt: { claims: { sub: ALICE, email: "alice@example.org" } },
        },
      },
      body: undefined,
    });
    expect(raw.statusCode).toBe(204);
    expect(raw.body).toBe("");
    expect(db.all("Payees")).toHaveLength(0);
  });

  test("returns 404 if the email is not one of the caller's payees", async () => {
    const raw = await handler({
      requestContext: {
        http: { method: "DELETE", path: "/payees/nobody%40example.org" },
        authorizer: {
          jwt: { claims: { sub: ALICE, email: "alice@example.org" } },
        },
      },
      body: undefined,
    });
    expect(raw.statusCode).toBe(404);
  });
});

describe("facilitator routes", () => {
  const facilitator = {
    sub: "sub-fac",
    email: "fac@example.org",
    "cognito:groups": ["facilitators"],
  };

  test("GET /admin/accounts marks the fictional customers’ accounts", async () => {
    db.put("Customers", {
      customerId: "fictional-jane",
      email: "jane@example.com",
      fictional: true,
    });
    db.put("Accounts", {
      accountId: "acct-fictional-jane-checking",
      customerId: "fictional-jane",
      type: "checking",
      name: "Everyday Checking",
      balanceCents: 58_20,
      fictional: true,
    });
    const r = await call("GET", "/admin/accounts", undefined, facilitator);
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(
      r.body.accounts.map((a: any) => [a.accountId, a]),
    );
    expect(byId["acct-fictional-jane-checking"]).toMatchObject({
      email: "jane@example.com",
      fictional: true,
    });
    expect(byId[aliceChecking]).toMatchObject({
      email: "alice@example.org",
      fictional: false,
    });
  });

  test("POST /admin/transfer records the memo", async () => {
    const r = await call(
      "POST",
      "/admin/transfer",
      { from: bobChecking, to: aliceChecking, amount: 3, memo: "Thanks!" },
      facilitator,
    );
    expect(r.status).toBe(200);
    expect(rowsFor(aliceChecking)).toEqual([
      expect.objectContaining({
        memo: "Thanks!",
        channel: "admin-console-transfer",
      }),
    ]);
  });

  test("POST /admin/reseed starts the reset in the provisioning Lambda", async () => {
    const workshop = await call("POST", "/admin/reseed", {}, facilitator);
    expect(workshop).toEqual({
      status: 202,
      body: { message: "Reset started", scope: "workshop" },
    });
    const one = await call(
      "POST",
      "/admin/reseed",
      { email: "bob@example.org" },
      facilitator,
    );
    expect(one.body.scope).toBe("bob@example.org");
    const payloads = lambdaSend.mock.calls.map(([cmd]) => ({
      fn: cmd.input.FunctionName,
      type: cmd.input.InvocationType,
      payload: JSON.parse(Buffer.from(cmd.input.Payload).toString()),
    }));
    expect(payloads).toEqual([
      {
        fn: "dewybank-test-provisioning",
        type: "Event",
        payload: { action: "reseed" },
      },
      {
        fn: "dewybank-test-provisioning",
        type: "Event",
        payload: { action: "reseed", email: "bob@example.org" },
      },
    ]);
  });
});
