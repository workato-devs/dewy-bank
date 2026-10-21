# Dewy Bank — Infrastructure (`infra/`)

AWS CDK (TypeScript) infrastructure for the Dewy Bank security-education
workshop. What the stations need from it is specified in
[`../docs/backend-requirements.md`](../docs/backend-requirements.md) (the P- and
C-P items referenced in code comments); the original plan is kept in
[`../docs/history/dewy-bank-plan.md`](../docs/history/dewy-bank-plan.md), which
older comments cite as "decision 6.x" / "plan §x".

- **Account / region:** yours. The stacks deploy to whatever your AWS profile
  resolves to (`--profile <your-profile>`, or the `AWS_*` environment); nothing
  is pinned to one account. Commands below use `<your-profile>`.
- **CDK:** via `npx cdk` (no global install). **Node:** 24 or newer.
- **Stack name:** `DewyBank-<workshopId>` (default `workshopId` = `dev`).

## What the stack models

| Area | Resource(s) |
|---|---|
| Data | 5 DynamoDB tables `dewybank-<workshopId>-{Customers,Accounts,Transactions,Statements,GenieClients}`, `PAY_PER_REQUEST`, removal policy `DESTROY` (demo). Customers has an `email-index` GSI (C-P1); Accounts has `owner-index`. Isolation is **per-workshop via name prefix**. |
| Auth | Cognito user pool + **SPA app client (no secret)** + Cognito group **`facilitators`**. |
| Customer API | HTTP API with a Cognito JWT authorizer. `customer-api-handler`: accounts, activity, `/transfers`, `/payments` (P5), and the facilitator `/admin/*` routes, including `/admin/reseed` (P10). `chat-handler`: `/me/genie-clients`, `/chat`, `/chat/events` (P8). |
| Support API | HTTP API, no Cognito, a static support-agent key in `x-api-key` (C-P3), minted at deploy into SSM by `support-api-key-gen`. `support-api-handler`: `/support/whoami`, `/support/customers/accounts`, `/support/adjustments`, reaching only the fictional customers. Replaces the old full-access Admin API (P7). |
| Seed and reset | `cognito-post-confirmation` seeds each new customer; `provisioning` resets participants and the fictional customers (P10). Both use `lambda/shared/seed.ts`. A custom resource runs `provisioning` `setup` at deploy, so the fictional customers (C-P4) exist from the start. |
| Web | S3 + CloudFront: the bank app (`index.html`, with the chat panel) and the facilitator console (`admin.html`). `config.js` for the app and `config.json` for the Workato connectors (P9), generated at deploy. |
| SES | **Sandbox** verified sender identities for approved senders. No production-access request. |
| Lifecycle | **EventBridge rule** (hourly) → `lifecycle` Lambda (still a stub). |

The APIs make no business decisions (Seven Factors, Factor II): they keep who
the caller is and which accounts they can reach, and check that requests are
well-formed. Limits and refusals belong to the Workato recipes.

## Layout

```
infra/
├── bin/dewybank.ts            # app entry — reads -c workshopId / -c approvedSenders, pins account/region
├── lib/dewybank-stack.ts      # the workshop stack
├── lib/github-oidc-stack.ts   # the GitHub Actions deploy role (deployed once)
├── lambda/
│   ├── customer-api-handler/index.ts
│   ├── support-api-handler/index.ts
│   ├── support-api-key-gen/index.ts
│   ├── chat-handler/index.ts
│   ├── cognito-post-confirmation/index.ts
│   ├── provisioning/index.ts
│   ├── lifecycle/index.ts
│   └── shared/                # seed data and the memo rule, shared by the Lambdas
├── web/                       # the bank app and the facilitator console
├── test/                      # jest: stack synth assertions + handler tests (in-memory DynamoDB)
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
| `githubOwnerRepo` | The repo CI deploys from (`DewyBank-GithubOidc` only). | `workato-devs/dewy-bank` |
| `githubSubjectPrefix` | The repo's OIDC `sub` prefix: `sub_claim_prefix` from `gh api repos/<owner>/<repo>/actions/oidc/customization/sub`. Needed when the repo uses immutable subjects. | `repo:<githubOwnerRepo>` |
| `oidcProviderArn` | The account's existing GitHub OIDC provider. | the standard ARN in the deploying account |
| `extraTrustedSubjects` | Comma-separated `sub` values to trust besides `main`; replaces the default. | `<githubSubjectPrefix>:environment:production` |

## Commands

Install deps (first time):

```bash
cd infra
npm install
```

**Synthesize (validate; no AWS calls that mutate):**

```bash
npx cdk synth -c workshopId=demo01
# with approved SES senders:
npx cdk synth -c workshopId=demo01 -c approvedSenders=ops@example.com,alerts@example.com
```

Synth needs no AWS credentials; with `--profile <your-profile>` it resolves
your account and region into the templates.

**Run the model tests:**

```bash
npm test
```

**Deploy** (CI deploys on push to `main`; this is the manual path):

```bash
# One-time per account/region:
npx cdk bootstrap --profile <your-profile>
# Deploy a workshop:
npx cdk deploy DewyBank-demo01 -c workshopId=demo01 --profile <your-profile>
```

**Make someone a facilitator** (once per person, after they sign up in the bank
app). The facilitator console (`admin.html`: Reset, support activity, transfers
with a note) only opens for members of the `facilitators` group:

```bash
aws cognito-idp admin-add-user-to-group --profile <your-profile> \
  --user-pool-id <UserPoolId output> --username <their email> --group-name facilitators
```

They sign out and back in to pick up the group.

**CI deploy role** (once per account, only if you deploy from GitHub Actions):

```bash
npx cdk deploy DewyBank-GithubOidc --profile <your-profile> \
  -c githubOwnerRepo=<owner>/<repo> \
  -c githubSubjectPrefix="$(gh api repos/<owner>/<repo>/actions/oidc/customization/sub --jq .sub_claim_prefix)"
```

Leave out `githubSubjectPrefix` if the command prints nothing (the repo uses
the classic `repo:<owner>/<repo>` subjects).

**Tear down a workshop:**

```bash
npx cdk destroy DewyBank-demo01 -c workshopId=demo01 --profile <your-profile>
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
