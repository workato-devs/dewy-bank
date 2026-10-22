# Dewy Bank — Facilitator Setup

This guide is for whoever owns the AWS account and is running the workshop for others. Participants use [`README.md`](../README.md) instead.

---

## 1. Deploy the bank to AWS

The bank is an AWS CDK (TypeScript) stack. Deploy it to your own sandbox account; use a `workshopId` to namespace the stack (default `dev`).

```bash
cd infra
npm install

# One-time per account/region:
npx cdk bootstrap --profile <your-profile>

# Deploy:
npx cdk deploy DewyBank-<workshopId> -c workshopId=<workshopId> --profile <your-profile>
```

The `SpaUrl` output from CloudFormation is the bank app URL. The three fictional customers (Jane, Omar and Mei) are seeded automatically at deploy time.

Full infrastructure details — stack layout, context variables, Lambda handlers, DynamoDB tables, test commands — are in [`infra/README.md`](../infra/README.md).

---

## 2. Stamp the bank URL into the connectors

Participants never type deployment details manually. After deploying, stamp the `SpaUrl` into the connector files so they connect automatically:

```bash
python3 scripts/stamp_bank_app_url.py <SpaUrl>
```

This writes the bank app URL and the API Gateway URLs (fetched from the app's `config.json`) into `workspace-connections/dewy_bank_customer_api.custom_adapter.rb` and the Support API connector. Share the stamped repo (e.g. as a workshop branch or fork) with participants. An unstamped connector refuses to connect and tells the participant to ask their facilitator.

The script also accepts `--support-api-key <key>` to pre-stamp the Station C support code; otherwise participants supply it at deploy time via `DEWY_SUPPORT_API_KEY` or `--support-api-key`.

---

## 3. Get the support code for Station C

The support code is the Support API key. It's safe to hand out to participants because it only reaches the support routes and the three fictional customers:

```bash
aws ssm get-parameter --with-decryption --query Parameter.Value --output text \
  --profile <your-profile> \
  --name "$(aws cloudformation describe-stacks \
    --stack-name DewyBank-<workshopId> \
    --profile <your-profile> \
    --query "Stacks[0].Outputs[?OutputKey=='SupportApiKeyParamName'].OutputValue" \
    --output text)"
```

Participants pass it as `DEWY_SUPPORT_API_KEY` (in `.env` or the environment) or with `--support-api-key` when running `scripts/deploy_workato.py`.

---

## 4. Add yourself (and other facilitators) to the facilitators group

Sign up in the bank app, then add your email to the `facilitators` Cognito group:

```bash
aws cognito-idp admin-add-user-to-group \
  --profile <your-profile> \
  --user-pool-id <UserPoolId output> \
  --username <your email> \
  --group-name facilitators
```

Sign out and back in to pick up the group. The facilitator console is at `<SpaUrl>/admin.html`. It shows a live leaderboard, the fictional customers' support activity, transfers with a note, and **Reset** — which restores the whole workshop or one participant between stations.

See [`infra/README.md`](../infra/README.md#commands) for the full command reference, including how to deploy the GitHub Actions OIDC role and tear down a workshop.

---

## 5. Deploying the infra CI/CD role (GitHub Actions)

If you deploy from GitHub Actions rather than locally, deploy the OIDC trust role once per account:

```bash
npx cdk deploy DewyBank-GithubOidc --profile <your-profile> \
  -c githubOwnerRepo=<owner>/<repo> \
  -c githubSubjectPrefix="$(gh api repos/<owner>/<repo>/actions/oidc/customization/sub --jq .sub_claim_prefix)"
```

Leave out `githubSubjectPrefix` if that `gh` command returns nothing (the repo uses standard subjects). The deploy workflow is `.github/workflows/deploy.yml`.

---

## 6. Manual S3 sync note

When syncing `infra/web/` to S3 outside of a CDK deploy (for example, pushing a web-only hotfix), always exclude the CDK-generated config files:

```bash
aws s3 sync infra/web/ s3://<bucket>/ --exclude "config.*"
```

Without `--exclude "config.*"` the sync will delete or overwrite `config.js` and `config.json`, which CDK generates at deploy time with the correct API URLs and Cognito settings. Overwriting them breaks the bank app for all participants.

---

## 7. Tearing down a workshop

```bash
npx cdk destroy DewyBank-<workshopId> -c workshopId=<workshopId> --profile <your-profile>
```

Each `workshopId` is an independent CloudFormation stack with its own prefixed DynamoDB tables, so workshops can be created and torn down independently without affecting each other.
