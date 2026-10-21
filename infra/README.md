# Dewy Bank — Infrastructure (`infra/`)

AWS CDK (TypeScript) infrastructure for the Dewy Bank security-education
workshop. See `../docs/dewy-bank-plan.md` for the authoritative plan (decisions
locked in §6–8). **This directory is Phase 0 — foundations only.** API Gateway
routes and the SPA are Phase 1+.

- **Account / region:** `<your-account-id>` / `us-west-2`
- **AWS profile:** `<your-profile>`
- **CDK:** via `npx cdk` (no global install). **Node:** 24.
- **Stack name:** `DewyBank-<workshopId>` (default `workshopId` = `dev`).

## What Phase 0 models

| Area | Resource(s) |
|---|---|
| Data | 4 DynamoDB tables `dewybank-<workshopId>-{Customers,Accounts,Transactions,Statements}`, `PAY_PER_REQUEST`, removal policy `DESTROY` (demo). Isolation is **per-workshop via name prefix** (decision 6.2). |
| Auth | Cognito user pool + **SPA app client (no secret)** + Cognito group **`facilitators`** (admin group, decisions 6.2/6.5). |
| Trigger | **Post-confirmation Lambda** (stub) wired to the user pool — Phase 1 will seed the starter account. |
| SES | **Sandbox** verified sender identities for approved senders (decision 6.5). No production-access request. Facilitator-email → verified-identity wiring is a documented TODO (Phase 1/4). |
| IAM | `facilitators` group IAM role may **invoke the provisioning Lambda**; least-privilege per Lambda (each handler is granted only the table access it needs). |
| Compute | 5 Lambda **stubs**: `customer-api-handler`, `admin-api-handler` (hosts insecure + secure routes), `cognito-post-confirmation`, `provisioning` (facilitator setup/teardown/reseed), `lifecycle` (expiry). |
| Lifecycle | **EventBridge rule** (hourly) → lifecycle Lambda: auto-teardown of TTL'd workshops + SES warnings (decision 6.5). |

**Not in Phase 0:** API Gateway routes, SPA, S3/CloudFront, any business logic.
Handlers are skeletons returning `501`/the event, with `TODO`s marking the
phase that fills them in.

## Layout

```
infra/
├── bin/dewybank.ts            # app entry — reads -c workshopId / -c approvedSenders, pins account/region
├── lib/dewybank-stack.ts      # the Phase 0 stack
├── lambda/
│   ├── customer-api-handler/index.ts
│   ├── admin-api-handler/index.ts
│   ├── cognito-post-confirmation/index.ts
│   ├── provisioning/index.ts
│   └── lifecycle/index.ts
├── test/infra.test.ts         # jest synth assertions
├── cdk.json                   # app = tsc + tsx bin/dewybank.ts
└── README.md
```

TS Lambda handlers are bundled by `NodejsFunction` (esbuild) at synth time — no
Docker required.

## Context variables

| Context var | Meaning | Default |
|---|---|---|
| `workshopId` | Per-workshop prefix; sets table names and stack name. | `dev` |
| `approvedSenders` | Comma-separated SES sandbox sender emails to register as verified identities. | *(none)* |

## Commands

Install deps (first time):

```bash
cd infra
npm install
```

**Synthesize (validate — Phase 0 exit criterion, no AWS calls that mutate):**

```bash
npx cdk synth -c workshopId=demo01 --profile <your-profile>
# with approved SES senders:
npx cdk synth -c workshopId=demo01 -c approvedSenders=ops@example.com,alerts@example.com --profile <your-profile>
```

**Run the model tests:**

```bash
npm test
```

**Deploy (GATED — a later, separate step; do NOT run as part of Phase 0):**

```bash
# One-time per account/region:
npx cdk bootstrap aws://<your-account-id>/us-west-2 --profile <your-profile>
# Deploy a workshop:
npx cdk deploy -c workshopId=demo01 --profile <your-profile>
```

**Tear down a workshop:**

```bash
npx cdk destroy -c workshopId=demo01 --profile <your-profile>
```

> Each distinct `workshopId` is a separate CloudFormation stack
> (`DewyBank-<workshopId>`) with its own prefixed tables, so workshops are
> created and torn down independently.

## Notes / caveats

- **SES verification is out-of-band.** CDK registers the email identity; the
  address owner must still complete SES's verification before mail can be sent
  as/to it. Sandbox mode means mail is only deliverable to verified identities.
- **`DESTROY` removal policy** is deliberate for the demo — tables are wiped on
  stack delete. Do not reuse this stack for anything you want to keep.
- Deployment requires the environment to be **bootstrapped** once per
  account/region (`cdk bootstrap`).
